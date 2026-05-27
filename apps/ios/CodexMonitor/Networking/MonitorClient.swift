import Foundation

enum MonitorClientError: LocalizedError, Equatable {
    case httpStatus(Int)
    case invalidResponse

    var errorDescription: String? {
        switch self {
        case .httpStatus(let status) where status == 401 || status == 403:
            return "Mobile Token 无效，请检查连接设置。"
        case .httpStatus(let status):
            return "服务器返回异常状态码：\(status)"
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

    func testConnection() async throws {
        _ = try await fetchThreads()
    }
}

private struct DeviceRegistrationPayload: Encodable {
    let token: String
    let environment: String
}
