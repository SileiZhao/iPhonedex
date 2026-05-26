import Foundation

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

    func fetchThreads() async throws -> [ThreadSnapshot] {
        let request = makeRequest(path: "/api/threads")
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw URLError(.badServerResponse)
        }
        return try JSONDecoder().decode([ThreadSnapshot].self, from: data)
    }

    func makeLiveSocket() -> URLSessionWebSocketTask {
        var request = URLRequest(url: endpointURL(path: "/api/live", webSocket: true))
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        return session.webSocketTask(with: request)
    }

    func testConnection() async throws {
        _ = try await fetchThreads()
    }
}
