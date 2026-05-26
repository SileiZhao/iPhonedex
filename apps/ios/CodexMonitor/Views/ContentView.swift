import SwiftUI

@MainActor
final class MonitorViewModel: ObservableObject {
    @Published var baseURLText = "https://monitor.example.com"
    @Published var token = ""
    @Published var connected = false
    @Published var snapshots: [ThreadSnapshot] = []
    @Published var errorMessage: String?

    func refresh() async {
        guard let url = URL(string: baseURLText), !token.isEmpty else {
            connected = false
            errorMessage = "请填写服务器地址和 mobile token"
            return
        }

        do {
            snapshots = try await MonitorClient(baseURL: url, token: token).fetchThreads()
            connected = true
            errorMessage = nil
        } catch {
            connected = false
            errorMessage = error.localizedDescription
        }
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
                    Button("刷新状态") {
                        Task { await viewModel.refresh() }
                    }
                    Text(viewModel.connected ? "实时连接" : "连接断开")
                        .foregroundStyle(viewModel.connected ? .green : .red)
                }

                if let errorMessage = viewModel.errorMessage {
                    Section("错误") {
                        Text(errorMessage).foregroundStyle(.red)
                    }
                }

                Section("Codex 任务") {
                    ForEach(viewModel.snapshots) { snapshot in
                        VStack(alignment: .leading, spacing: 8) {
                            HStack {
                                Text(snapshot.title).font(.headline)
                                Spacer()
                                StatusBadge(status: snapshot.status)
                            }
                            Text(snapshot.hostId).font(.caption).foregroundStyle(.secondary)
                            ForEach(snapshot.recentLogs.prefix(8)) { log in
                                Text("[\(log.stream)] \(log.text)")
                                    .font(.system(.caption, design: .monospaced))
                                    .lineLimit(3)
                            }
                        }
                        .padding(.vertical, 6)
                    }
                }
            }
            .navigationTitle("Codex Monitor")
        }
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
