import SwiftUI

@MainActor
final class MonitorViewModel: ObservableObject {
    @Published var baseURLText = "https://monitor.example.com"
    @Published var token = ""
    @Published var connected = false
    @Published var connecting = false
    @Published var snapshots: [ThreadSnapshot] = []
    @Published var errorMessage: String?
    @Published var lastUpdatedText = "尚未同步"

    private let store = ConfigurationStore()
    private var socket: URLSessionWebSocketTask?
    private var receiveTask: Task<Void, Never>?

    init() {
        do {
            let configuration = try store.load()
            baseURLText = configuration.serverURL
            token = configuration.mobileToken
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func saveConfiguration() {
        do {
            try store.save(MonitorConfiguration(serverURL: baseURLText, mobileToken: token))
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func startMonitoring() async {
        saveConfiguration()
        let refreshed = await refresh()
        if refreshed {
            connectLive()
        }
    }

    func stopMonitoring() {
        receiveTask?.cancel()
        receiveTask = nil
        socket?.cancel(with: .normalClosure, reason: nil)
        socket = nil
        connected = false
    }

    @discardableResult
    func refresh() async -> Bool {
        guard let client = makeClient() else {
            connected = false
            connecting = false
            errorMessage = validationMessage()
            return false
        }

        connecting = true
        do {
            snapshots = try await client.fetchThreads()
            connected = true
            connecting = false
            lastUpdatedText = Self.relativeTimestamp()
            errorMessage = nil
            return true
        } catch {
            connected = false
            connecting = false
            errorMessage = error.localizedDescription
            return false
        }
    }

    private func connectLive() {
        guard let client = makeClient() else { return }
        receiveTask?.cancel()
        socket?.cancel(with: .normalClosure, reason: nil)

        let liveSocket = client.makeLiveSocket()
        socket = liveSocket
        liveSocket.resume()

        receiveTask = Task { [weak self, liveSocket] in
            await self?.receiveLoop(socket: liveSocket)
        }
    }

    private func receiveLoop(socket: URLSessionWebSocketTask) async {
        while !Task.isCancelled {
            do {
                _ = try await socket.receive()
                _ = await refresh()
            } catch {
                connected = false
                errorMessage = error.localizedDescription
                try? await Task.sleep(for: .seconds(3))
                if !Task.isCancelled {
                    let refreshed = await refresh()
                    if refreshed {
                        connectLive()
                    }
                }
                return
            }
        }
    }

    private func makeClient() -> MonitorClient? {
        let trimmedURL = baseURLText.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedToken = token.trimmingCharacters(in: .whitespacesAndNewlines)
        guard
            let url = URL(string: trimmedURL),
            ["http", "https"].contains(url.scheme?.lowercased()),
            !trimmedToken.isEmpty
        else {
            return nil
        }
        return MonitorClient(baseURL: url, token: trimmedToken)
    }

    private func validationMessage() -> String {
        let trimmedURL = baseURLText.trimmingCharacters(in: .whitespacesAndNewlines)
        let scheme = URL(string: trimmedURL)?.scheme?.lowercased()
        if scheme != "http" && scheme != "https" {
            return "服务器地址必须以 http:// 或 https:// 开头"
        }
        if token.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return "请填写 mobile token"
        }
        return "请检查服务器地址和 mobile token"
    }

    private static func relativeTimestamp() -> String {
        Date.now.formatted(date: .omitted, time: .standard)
    }
}

struct ContentView: View {
    @StateObject private var viewModel = MonitorViewModel()

    var body: some View {
        NavigationStack {
            List {
                Section("连接") {
                    ServerURLField(text: $viewModel.baseURLText)
                    SecureField("mobile token", text: $viewModel.token)
                    HStack {
                        Button("连接并监控") {
                            Task { await viewModel.startMonitoring() }
                        }
                        Button("停止") {
                            viewModel.stopMonitoring()
                        }
                    }
                    Button("刷新状态") {
                        Task { await viewModel.refresh() }
                    }
                    .disabled(viewModel.connecting)
                    Text(viewModel.connected ? "实时连接" : "连接断开")
                        .foregroundStyle(viewModel.connected ? .green : .red)
                    Text("最后同步：\(viewModel.lastUpdatedText)")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                if let errorMessage = viewModel.errorMessage {
                    Section("错误") {
                        Text(errorMessage).foregroundStyle(.red)
                    }
                }

                Section("Codex 任务") {
                    if viewModel.snapshots.isEmpty {
                        ContentUnavailableView("暂无任务", systemImage: "terminal", description: Text("连接后，Mac 上的 Codex 执行状态会显示在这里。"))
                    } else {
                        ForEach(viewModel.snapshots) { snapshot in
                            NavigationLink {
                                ThreadDetailView(snapshot: snapshot)
                            } label: {
                                ThreadRow(snapshot: snapshot)
                            }
                        }
                    }
                }
            }
            .navigationTitle("Codex Monitor")
            .task {
                if !viewModel.token.isEmpty {
                    await viewModel.startMonitoring()
                }
            }
        }
    }
}

private struct ThreadRow: View {
    let snapshot: ThreadSnapshot

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(snapshot.title).font(.headline)
                Spacer()
                StatusBadge(status: snapshot.status)
            }
            Text(snapshot.hostId).font(.caption).foregroundStyle(.secondary)
            if let latest = snapshot.recentLogs.last {
                Text("[\(latest.stream)] \(latest.text)")
                    .font(.system(.caption, design: .monospaced))
                    .lineLimit(2)
            }
        }
        .padding(.vertical, 6)
    }
}

private struct ThreadDetailView: View {
    let snapshot: ThreadSnapshot

    var body: some View {
        List {
            Section("状态") {
                HStack {
                    Text(snapshot.title)
                    Spacer()
                    StatusBadge(status: snapshot.status)
                }
                Text(snapshot.hostId)
                Text("最后事件：\(snapshot.lastEventAt)")
            }

            Section("步骤") {
                if snapshot.steps.isEmpty {
                    Text("暂无步骤")
                } else {
                    ForEach(snapshot.steps) { step in
                        HStack {
                            Text(step.label)
                            Spacer()
                            Text(step.status).foregroundStyle(.secondary)
                        }
                    }
                }
            }

            Section("日志") {
                ForEach(snapshot.recentLogs) { log in
                    VStack(alignment: .leading, spacing: 4) {
                        Text("[\(log.stream)] \(log.at)")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        Text(log.text)
                            .font(.system(.caption, design: .monospaced))
                            .textSelection(.enabled)
                    }
                    .padding(.vertical, 4)
                }
            }
        }
        .navigationTitle(snapshot.title)
    }
}

private struct ServerURLField: View {
    @Binding var text: String

    var body: some View {
        #if os(iOS)
        TextField("https://monitor.example.com", text: $text)
            .textInputAutocapitalization(.never)
            .keyboardType(.URL)
        #else
        TextField("https://monitor.example.com", text: $text)
        #endif
    }
}

private struct StatusBadge: View {
    let status: ThreadStatus

    var body: some View {
        Text(status.statusLabel)
            .font(.caption)
            .bold()
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .foregroundStyle(.white)
            .background(color, in: Capsule())
    }

    private var color: Color {
        switch status {
        case .idle:
            return .secondary
        case .running:
            return .blue
        case .waitingForApproval:
            return .orange
        case .failed:
            return .red
        case .completed:
            return .green
        }
    }
}
