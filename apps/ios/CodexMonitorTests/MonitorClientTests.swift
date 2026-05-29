import XCTest
@testable import CodexMonitor

final class MonitorClientTests: XCTestCase {
    func testBuildsAuthenticatedRequests() throws {
        let client = MonitorClient(
            baseURL: URL(string: "https://monitor.example.com")!,
            token: "mobile-secret"
        )

        let request = client.makeRequest(path: "/api/threads")

        XCTAssertEqual(request.url?.absoluteString, "https://monitor.example.com/api/threads")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer mobile-secret")
    }

    func testBuildsSecureWebSocketForHttpsServers() throws {
        let client = MonitorClient(
            baseURL: URL(string: "https://monitor.example.com")!,
            token: "mobile-secret"
        )

        let socket = client.makeLiveSocket()

        XCTAssertEqual(socket.originalRequest?.url?.scheme, "wss")
        XCTAssertEqual(socket.originalRequest?.url?.absoluteString, "wss://monitor.example.com/api/live")
        XCTAssertEqual(socket.originalRequest?.value(forHTTPHeaderField: "Authorization"), "Bearer mobile-secret")
    }

    func testPreservesBasePathForReverseProxyDeployments() throws {
        let client = MonitorClient(
            baseURL: URL(string: "https://example.com/codex-monitor")!,
            token: "mobile-secret"
        )

        let request = client.makeRequest(path: "/api/threads")
        let socket = client.makeLiveSocket()

        XCTAssertEqual(request.url?.absoluteString, "https://example.com/codex-monitor/api/threads")
        XCTAssertEqual(socket.originalRequest?.url?.absoluteString, "wss://example.com/codex-monitor/api/live")
    }

    func testBuildsDeviceRegistrationRequest() throws {
        let client = MonitorClient(
            baseURL: URL(string: "https://monitor.example.com")!,
            token: "mobile-secret"
        )

        let request = try client.makeDeviceRegistrationRequest(
            deviceToken: "abc123",
            environment: .sandbox
        )

        XCTAssertEqual(request.url?.absoluteString, "https://monitor.example.com/api/devices/register")
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer mobile-secret")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/json")
        let payload = try XCTUnwrap(
            JSONSerialization.jsonObject(with: request.httpBody ?? Data()) as? [String: String]
        )
        XCTAssertEqual(payload["token"], "abc123")
        XCTAssertEqual(payload["environment"], "sandbox")
    }

    func testBuildsRemoteCommandRequest() throws {
        let client = MonitorClient(
            baseURL: URL(string: "https://monitor.example.com/codex-monitor")!,
            token: "mobile-secret"
        )

        let request = try client.makeCommandRequest(
            hostId: "macbook",
            threadId: "thread-1",
            cwd: "/Users/example/Repo",
            prompt: "继续执行"
        )

        XCTAssertEqual(request.url?.absoluteString, "https://monitor.example.com/codex-monitor/api/commands")
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer mobile-secret")
        let payload = try XCTUnwrap(
            JSONSerialization.jsonObject(with: request.httpBody ?? Data()) as? [String: String]
        )
        XCTAssertEqual(payload["hostId"], "macbook")
        XCTAssertEqual(payload["threadId"], "thread-1")
        XCTAssertEqual(payload["cwd"], "/Users/example/Repo")
        XCTAssertEqual(payload["prompt"], "继续执行")
    }

    func testExplainsRemoteCommandForbiddenSeparatelyFromTokenFailures() throws {
        XCTAssertEqual(
            MonitorClientError.remoteCommandForbidden.localizedDescription,
            "服务器拒绝远程指令，请检查远程指令开关、Host 白名单或项目路径白名单。"
        )
    }

    func testSendCommandMapsForbiddenStatusToRemoteCommandError() async throws {
        CommandStubURLProtocol.handler = { request in
            XCTAssertEqual(request.url?.path, "/api/commands")
            return (
                HTTPURLResponse(
                    url: request.url!,
                    statusCode: 403,
                    httpVersion: nil,
                    headerFields: nil
                )!,
                Data()
            )
        }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [CommandStubURLProtocol.self]
        let session = URLSession(configuration: configuration)
        let client = MonitorClient(
            baseURL: URL(string: "https://monitor.example.com")!,
            token: "mobile-secret",
            session: session
        )

        do {
            try await client.sendCommand(
                hostId: "macbook",
                threadId: "thread-1",
                cwd: "/Users/example/Repo",
                prompt: "继续执行"
            )
            XCTFail("Expected sendCommand to throw")
        } catch let error as MonitorClientError {
            XCTAssertEqual(error, .remoteCommandForbidden)
        }
    }
}

private final class CommandStubURLProtocol: URLProtocol {
    static var handler: ((URLRequest) throws -> (HTTPURLResponse, Data))?

    override class func canInit(with request: URLRequest) -> Bool {
        true
    }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest {
        request
    }

    override func startLoading() {
        guard let handler = Self.handler else {
            client?.urlProtocol(self, didFailWithError: MonitorClientError.invalidResponse)
            return
        }

        do {
            let (response, data) = try handler(request)
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {}
}
