import Foundation

enum MonitorClientError: LocalizedError, Equatable {
    case httpStatus(Int)
    case remoteCommandForbidden
    case invalidResponse

    var errorDescription: String? {
        switch self {
        case .httpStatus(let status) where status == 401 || status == 403:
            return "Mobile Token 无效，请检查连接设置。"
        case .httpStatus(let status):
            return "服务器返回异常状态码：\(status)"
        case .remoteCommandForbidden:
            return "服务器拒绝远程指令，请检查远程指令开关、Host 白名单或项目路径白名单。"
        case .invalidResponse:
            return "服务器响应格式异常。"
        }
    }
}

enum DevicePushEnvironment: String, Codable {
    case sandbox
    case production

    static var current: DevicePushEnvironment {
        #if DEBUG
        return .sandbox
        #else
        return .production
        #endif
    }
}

enum ApprovalAction: String, Codable {
    case approve
    case reject
}

final class MonitorClient {
    private let baseURL: URL
    private let token: String
    private let session: URLSession

    init(baseURL: URL, token: String, session: URLSession = .shared) {
        self.baseURL = baseURL
        self.token = token
        self.session = session
    }

    func endpointURL(path: String, webSocket: Bool = false) -> URL {
        let trimmedPath = path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        var basePath = baseURL.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        if !basePath.isEmpty {
            basePath += "/"
        }

        var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)!
        components.path = "/" + basePath + trimmedPath
        if webSocket {
            components.scheme = baseURL.scheme == "https" ? "wss" : "ws"
        }
        return components.url!
    }

    func makeRequest(path: String) -> URLRequest {
        var request = URLRequest(url: endpointURL(path: path))
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.timeoutInterval = 20
        return request
    }

    func makeDeviceRegistrationRequest(
        deviceToken: String,
        environment: DevicePushEnvironment
    ) throws -> URLRequest {
        var request = makeRequest(path: "/api/devices/register")
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(
            DeviceRegistrationPayload(token: deviceToken, environment: environment.rawValue)
        )
        return request
    }

    func makeCommandRequest(hostId: String, threadId: String?, cwd: String?, prompt: String) throws -> URLRequest {
        var request = makeRequest(path: "/api/commands")
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(
            RemoteCommandPayload(hostId: hostId, threadId: threadId, cwd: cwd, prompt: prompt)
        )
        return request
    }

    func makeApprovalActionRequest(
        hostId: String,
        threadId: String,
        cwd: String?,
        approvalId: String,
        action: ApprovalAction,
        commandPreview: String
    ) throws -> URLRequest {
        var request = makeRequest(path: "/api/approvals")
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(
            ApprovalActionPayload(
                hostId: hostId,
                threadId: threadId,
                cwd: cwd,
                approvalId: approvalId,
                action: action.rawValue,
                commandPreview: commandPreview
            )
        )
        return request
    }

    func fetchThreads() async throws -> [ThreadSnapshot] {
        let request = makeRequest(path: "/api/threads")
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw MonitorClientError.invalidResponse
        }
        guard (200..<300).contains(http.statusCode) else {
            throw MonitorClientError.httpStatus(http.statusCode)
        }
        return try JSONDecoder().decode([ThreadSnapshot].self, from: data)
    }

    func makeLiveSocket() -> URLSessionWebSocketTask {
        var request = URLRequest(url: endpointURL(path: "/api/live", webSocket: true))
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        return session.webSocketTask(with: request)
    }

    func registerDeviceToken(_ deviceToken: String, environment: DevicePushEnvironment) async throws {
        let request = try makeDeviceRegistrationRequest(
            deviceToken: deviceToken,
            environment: environment
        )
        let (_, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw MonitorClientError.invalidResponse
        }
        guard (200..<300).contains(http.statusCode) else {
            throw MonitorClientError.httpStatus(http.statusCode)
        }
    }

    func sendCommand(hostId: String, threadId: String?, cwd: String?, prompt: String) async throws {
        let request = try makeCommandRequest(hostId: hostId, threadId: threadId, cwd: cwd, prompt: prompt)
        let (_, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw MonitorClientError.invalidResponse
        }
        guard (200..<300).contains(http.statusCode) else {
            if http.statusCode == 403 {
                throw MonitorClientError.remoteCommandForbidden
            }
            throw MonitorClientError.httpStatus(http.statusCode)
        }
    }

    func sendApprovalAction(
        hostId: String,
        threadId: String,
        cwd: String?,
        approvalId: String,
        action: ApprovalAction,
        commandPreview: String
    ) async throws {
        let request = try makeApprovalActionRequest(
            hostId: hostId,
            threadId: threadId,
            cwd: cwd,
            approvalId: approvalId,
            action: action,
            commandPreview: commandPreview
        )
        let (_, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw MonitorClientError.invalidResponse
        }
        guard (200..<300).contains(http.statusCode) else {
            if http.statusCode == 403 {
                throw MonitorClientError.remoteCommandForbidden
            }
            throw MonitorClientError.httpStatus(http.statusCode)
        }
    }

    func testConnection() async throws {
        _ = try await fetchThreads()
    }
}

private struct DeviceRegistrationPayload: Encodable {
    let token: String
    let environment: String
}

private struct RemoteCommandPayload: Encodable {
    let hostId: String
    let threadId: String?
    let cwd: String?
    let prompt: String
}

private struct ApprovalActionPayload: Encodable {
    let hostId: String
    let threadId: String
    let cwd: String?
    let approvalId: String
    let action: String
    let commandPreview: String
}
