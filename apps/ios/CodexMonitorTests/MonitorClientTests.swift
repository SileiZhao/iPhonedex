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
}
