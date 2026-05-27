import SwiftUI
#if canImport(UIKit)
import UIKit
#endif

@MainActor
final class MonitorViewModel: ObservableObject {
    @Published var baseURLText = ConfigurationStore.defaultServerURL
    @Published var token = ""
    @Published var connected = false
    @Published var connecting = false
    @Published var snapshots: [ThreadSnapshot] = []
    @Published var errorMessage: String?
    @Published var noticeMessage: String?
    @Published var lastUpdatedText = "尚未同步"
    @Published var selectedFilter: ThreadFilter = .all
    @Published var showingSettings = false

    private let store = ConfigurationStore()
    private let notifier = MonitorNotificationService()
    private var socket: URLSessionWebSocketTask?
    private var receiveTask: Task<Void, Never>?
    private var notificationObservers: [NSObjectProtocol] = []
    private var remoteDeviceToken: String?
    private var notifiedSnapshotKeys = Set<String>()

    var summary: DashboardSummary {
        DashboardSummary(snapshots: snapshots)
    }

    var visibleSnapshots: [ThreadSnapshot] {
        ThreadSnapshot.prioritizedForDashboard(selectedFilter.apply(to: snapshots))
    }

    var primarySnapshot: ThreadSnapshot? {
        ThreadSnapshot.prioritizedForDashboard(snapshots).first
    }

    var connectionTitle: String {
        if connecting { return connected ? "重连中" : "正在同步" }
        return connected ? "实时连接" : "连接断开"
    }

    var connectionDetail: String {
        let trimmedURL = baseURLText.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmedURL.isEmpty ? "未配置服务器" : trimmedURL
    }

    var hasConfiguration: Bool {
        !baseURLText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty &&
            !token.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    init() {
        do {
            let configuration = try store.load()
            baseURLText = configuration.serverURL
            token = configuration.mobileToken
        } catch {
            errorMessage = error.localizedDescription
        }
        observeRemoteNotificationRegistration()
    }

    deinit {
        for observer in notificationObservers {
            NotificationCenter.default.removeObserver(observer)
        }
    }

    func saveConfiguration() {
        do {
            baseURLText = ConfigurationStore.normalizedServerURL(baseURLText)
            try store.save(MonitorConfiguration(serverURL: baseURLText, mobileToken: token))
            errorMessage = nil
            noticeMessage = "配置已保存"
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func startMonitoring() async {
        saveConfiguration()
        let refreshed = await refresh()
        if refreshed {
            await requestRemotePushRegistration()
            connectLive()
        }
    }

    func reconnectMonitoring() async {
        stopMonitoring()
        await startMonitoring()
    }

    func stopMonitoring() {
        receiveTask?.cancel()
        receiveTask = nil
        socket?.cancel(with: .normalClosure, reason: nil)
        socket = nil
        connected = false
    }

    func clearConfiguration() {
        stopMonitoring()
        do {
            try store.clear()
            baseURLText = ConfigurationStore.defaultServerURL
            token = ""
            snapshots = []
            selectedFilter = .all
            lastUpdatedText = "尚未同步"
            errorMessage = nil
            noticeMessage = "本地配置已清除"
            remoteDeviceToken = nil
        } catch {
            errorMessage = Self.userFacingMessage(for: error)
        }
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
            let fetchedSnapshots = try await client.fetchThreads()
            snapshots = fetchedSnapshots
            connected = true
            connecting = false
            lastUpdatedText = Self.relativeTimestamp()
            errorMessage = nil
            noticeMessage = nil
            notifyAttentionIfNeeded(from: fetchedSnapshots)
            return true
        } catch {
            connected = false
            connecting = false
            errorMessage = Self.userFacingMessage(for: error)
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
                errorMessage = "WebSocket 已断开，正在尝试重新连接。"
                noticeMessage = nil
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

    private func observeRemoteNotificationRegistration() {
        let tokenObserver = NotificationCenter.default.addObserver(
            forName: .codexMonitorDeviceTokenReceived,
            object: nil,
            queue: .main
        ) { [weak self] notification in
            guard let token = notification.object as? String else { return }
            Task { @MainActor in
                await self?.registerRemoteDeviceToken(token)
            }
        }

        let failureObserver = NotificationCenter.default.addObserver(
            forName: .codexMonitorDeviceTokenRegistrationFailed,
            object: nil,
            queue: .main
        ) { [weak self] notification in
            let detail = notification.object as? String
            Task { @MainActor in
                self?.noticeMessage = detail.map {
                    "后台推送注册失败：\($0)"
                } ?? "后台推送注册失败"
            }
        }

        notificationObservers = [tokenObserver, failureObserver]
    }

    private func requestRemotePushRegistration() async {
        let granted = await notifier.requestRemoteNotificationRegistration()
        if !granted {
            noticeMessage = "通知权限未开启，只能在 App 前台显示提醒。"
            return
        }

        if let remoteDeviceToken {
            await registerRemoteDeviceToken(remoteDeviceToken)
        }
    }

    private func registerRemoteDeviceToken(_ deviceToken: String) async {
        remoteDeviceToken = deviceToken
        guard let client = makeClient() else { return }
        do {
            try await client.registerDeviceToken(
                deviceToken,
                environment: DevicePushEnvironment.current
            )
            if noticeMessage?.hasPrefix("后台推送") == true {
                noticeMessage = "后台推送已启用"
            }
        } catch {
            noticeMessage = "后台推送 token 上传失败：\(Self.userFacingMessage(for: error))"
        }
    }

    private func validationMessage() -> String {
        let trimmedURL = baseURLText.trimmingCharacters(in: .whitespacesAndNewlines)
        let scheme = URL(string: trimmedURL)?.scheme?.lowercased()
        if ConfigurationStore.isPublicHTTPURL(trimmedURL) {
            return "公网服务器必须使用 HTTPS 域名，例如 https://www.topomotion.com/codex-monitor"
        }
        if scheme != "http" && scheme != "https" {
            return "服务器地址必须以 http:// 或 https:// 开头"
        }
        if token.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return "请填写 mobile token"
        }
        return "请检查服务器地址和 mobile token"
    }

    private static func userFacingMessage(for error: Error) -> String {
        if let clientError = error as? MonitorClientError {
            return clientError.localizedDescription
        }

        if let urlError = error as? URLError {
            switch urlError.code {
            case .userAuthenticationRequired:
                return "Mobile Token 无效，请检查连接设置。"
            case .cannotFindHost, .cannotConnectToHost, .timedOut:
                return "Server 不可达，请检查地址、端口和公网/Nginx 配置。"
            case .notConnectedToInternet, .networkConnectionLost:
                return "网络连接不可用，请检查 Wi-Fi、蜂窝网络或本地网络权限。"
            case .appTransportSecurityRequiresSecureConnection:
                return "连接被系统安全策略拦截，请检查 HTTPS 或本地网络配置。"
            default:
                return urlError.localizedDescription
            }
        }

        return error.localizedDescription
    }

    private func notifyAttentionIfNeeded(from snapshots: [ThreadSnapshot]) {
        for snapshot in snapshots where snapshot.status == .waitingForApproval || snapshot.status == .failed {
            let key = "\(snapshot.threadId)-\(snapshot.status.rawValue)-\(snapshot.lastEventAt)"
            guard !notifiedSnapshotKeys.contains(key) else { continue }
            notifiedSnapshotKeys.insert(key)

            Task {
                await notifier.notifyAttention(snapshot: snapshot)
            }
        }
    }

    private static func relativeTimestamp() -> String {
        Date.now.formatted(date: .omitted, time: .standard)
    }
}

struct ContentView: View {
    @StateObject private var viewModel = MonitorViewModel()

    var body: some View {
        NavigationStack {
            ZStack {
                CodexTheme.background.ignoresSafeArea()
                VStack(spacing: 0) {
                    CodexTopBar(viewModel: viewModel)
                        .padding(.horizontal, 18)
                        .padding(.top, 12)

                    if let errorMessage = viewModel.errorMessage {
                        ErrorBanner(message: errorMessage)
                            .padding(.horizontal, 18)
                            .padding(.top, 12)
                    }

                    if let noticeMessage = viewModel.noticeMessage {
                        NoticeBanner(message: noticeMessage)
                            .padding(.horizontal, 18)
                            .padding(.top, 12)
                    }

                    ScrollView {
                        VStack(alignment: .leading, spacing: 18) {
                            DashboardPanel(viewModel: viewModel)
                            FilterStrip(selection: $viewModel.selectedFilter)

                            if viewModel.visibleSnapshots.isEmpty {
                                EmptyDashboardView(hasSnapshots: !viewModel.snapshots.isEmpty)
                                    .frame(maxWidth: .infinity)
                                    .padding(.top, 28)
                            } else {
                                LazyVStack(spacing: 12) {
                                    ForEach(viewModel.visibleSnapshots) { snapshot in
                                        NavigationLink {
                                            LiveThreadDetailView(
                                                viewModel: viewModel,
                                                threadId: snapshot.threadId,
                                                fallback: snapshot
                                            )
                                        } label: {
                                            ThreadCard(snapshot: snapshot)
                                        }
                                        .buttonStyle(.plain)
                                    }
                                }
                            }
                        }
                        .padding(.horizontal, 18)
                        .padding(.top, 18)
                        .padding(.bottom, 96)
                    }
                    .scrollIndicators(.hidden)
                    .refreshable {
                        await viewModel.refresh()
                    }
                }

                VStack {
                    Spacer()
                    BottomControlBar(viewModel: viewModel)
                        .padding(.horizontal, 18)
                        .padding(.bottom, 12)
                }
            }
            .toolbar(.hidden, for: .navigationBar)
            .fullScreenCover(isPresented: $viewModel.showingSettings) {
                SettingsView(viewModel: viewModel)
            }
            .task {
                if viewModel.token.isEmpty {
                    viewModel.showingSettings = true
                } else {
                    await viewModel.startMonitoring()
                }
            }
        }
    }
}

private struct LiveThreadDetailView: View {
    @ObservedObject var viewModel: MonitorViewModel
    let threadId: String
    let fallback: ThreadSnapshot

    var body: some View {
        ThreadDetailView(
            viewModel: viewModel,
            snapshot: ThreadSnapshot.find(threadId, in: viewModel.snapshots) ?? fallback
        )
    }
}

private struct CodexTopBar: View {
    @ObservedObject var viewModel: MonitorViewModel

    var body: some View {
        HStack(spacing: 12) {
            CodexMark()

            VStack(alignment: .leading, spacing: 2) {
                Text("Codex")
                    .font(.system(size: 24, weight: .semibold, design: .rounded))
                    .foregroundStyle(CodexTheme.primaryText)
                Text(viewModel.connectionDetail)
                    .font(.system(size: 12, weight: .medium, design: .monospaced))
                    .foregroundStyle(CodexTheme.secondaryText)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .accessibilityLabel("当前服务器 \(viewModel.connectionDetail)")
                Text("最后同步 \(viewModel.lastUpdatedText)")
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(CodexTheme.tertiaryText)
                    .lineLimit(1)
            }

            Spacer(minLength: 8)

            ConnectionChip(
                title: viewModel.connectionTitle,
                connected: viewModel.connected,
                connecting: viewModel.connecting
            )

            IconButton(symbol: "arrow.clockwise", label: "手动刷新", disabled: viewModel.connecting) {
                Task { await viewModel.refresh() }
            }

            IconButton(symbol: "gearshape.fill", label: "设置") {
                viewModel.showingSettings = true
            }
        }
        .accessibilityElement(children: .contain)
    }
}

private struct CodexMark: View {
    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(CodexTheme.surface)
                .overlay(
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .stroke(CodexTheme.border, lineWidth: 1)
                )
            Image(systemName: "command")
                .font(.system(size: 20, weight: .semibold))
                .foregroundStyle(CodexTheme.accent)
        }
        .frame(width: 44, height: 44)
    }
}

private struct ConnectionChip: View {
    let title: String
    let connected: Bool
    let connecting: Bool

    var body: some View {
        HStack(spacing: 7) {
            if connecting {
                ProgressView()
                    .tint(CodexTheme.primaryText)
                    .scaleEffect(0.65)
            } else {
                Circle()
                    .fill(connected ? CodexTheme.success : CodexTheme.warning)
                    .frame(width: 7, height: 7)
            }

            Text(title)
                .font(.system(size: 12, weight: .semibold))
                .lineLimit(1)
        }
        .foregroundStyle(CodexTheme.primaryText)
        .padding(.horizontal, 11)
        .frame(height: 32)
        .background(CodexTheme.surfaceRaised, in: Capsule())
        .overlay(Capsule().stroke(CodexTheme.border, lineWidth: 1))
    }
}

private struct DashboardPanel: View {
    @ObservedObject var viewModel: MonitorViewModel

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack(alignment: .top, spacing: 12) {
                VStack(alignment: .leading, spacing: 8) {
                    Text(heroTitle)
                        .font(.system(size: 34, weight: .semibold, design: .rounded))
                        .foregroundStyle(CodexTheme.primaryText)
                        .lineLimit(2)
                        .minimumScaleFactor(0.82)

                    Text(heroSubtitle)
                        .font(.system(size: 14, weight: .medium))
                        .foregroundStyle(CodexTheme.secondaryText)
                        .lineLimit(2)
                }

                Spacer(minLength: 10)

                Image(systemName: heroSymbol)
                    .font(.system(size: 24, weight: .semibold))
                    .foregroundStyle(heroTint)
                    .frame(width: 46, height: 46)
                    .background(heroTint.opacity(0.13), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            }

            if let command = viewModel.primarySnapshot?.pendingApproval?.commandPreview {
                CommandPreview(text: command)
            }

            HStack(spacing: 10) {
                SummaryPill(title: "全部", value: viewModel.summary.totalCount, tint: CodexTheme.accent)
                SummaryPill(title: "待处理", value: viewModel.summary.actionRequiredCount, tint: CodexTheme.warning)
                SummaryPill(title: "进行中", value: viewModel.summary.activeCount, tint: CodexTheme.success)
                SummaryPill(title: "失败", value: viewModel.summary.failedCount, tint: CodexTheme.danger)
            }
        }
        .padding(18)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(CodexTheme.surface, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .stroke(CodexTheme.border, lineWidth: 1)
        )
    }

    private var heroTitle: String {
        if viewModel.summary.actionRequiredCount > 0 {
            return "等待批准"
        }
        if viewModel.summary.activeCount > 0 {
            return "正在执行"
        }
        if viewModel.summary.failedCount > 0 {
            return "需要检查"
        }
        return viewModel.connected ? "实时待命" : "连接 Mac"
    }

    private var heroSubtitle: String {
        if let snapshot = viewModel.primarySnapshot {
            return "\(snapshot.title) · \(snapshot.hostId)"
        }
        return "最后同步 \(viewModel.lastUpdatedText)"
    }

    private var heroSymbol: String {
        if viewModel.summary.actionRequiredCount > 0 { return "hand.raised.fill" }
        if viewModel.summary.activeCount > 0 { return "bolt.fill" }
        if viewModel.summary.failedCount > 0 { return "exclamationmark.triangle.fill" }
        return viewModel.connected ? "checkmark.seal.fill" : "antenna.radiowaves.left.and.right"
    }

    private var heroTint: Color {
        if viewModel.summary.actionRequiredCount > 0 { return CodexTheme.warning }
        if viewModel.summary.activeCount > 0 { return CodexTheme.success }
        if viewModel.summary.failedCount > 0 { return CodexTheme.danger }
        return viewModel.connected ? CodexTheme.accent : CodexTheme.secondaryText
    }
}

private struct CommandPreview: View {
    let text: String

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "terminal")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(CodexTheme.warning)
                .frame(width: 24, height: 24)

            Text(text)
                .font(.system(size: 13, weight: .medium, design: .monospaced))
                .foregroundStyle(CodexTheme.primaryText)
                .lineLimit(3)

            Spacer(minLength: 0)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(CodexTheme.warning.opacity(0.10), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .stroke(CodexTheme.warning.opacity(0.28), lineWidth: 1)
        )
    }
}

private struct SummaryPill: View {
    let title: String
    let value: Int
    let tint: Color

    var body: some View {
        VStack(spacing: 4) {
            Text("\(value)")
                .font(.system(size: 18, weight: .semibold, design: .rounded))
                .foregroundStyle(tint)
            Text(title)
                .font(.system(size: 10, weight: .medium))
                .foregroundStyle(CodexTheme.secondaryText)
                .lineLimit(1)
                .minimumScaleFactor(0.8)
        }
        .frame(maxWidth: .infinity, minHeight: 52)
        .background(CodexTheme.surfaceRaised, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .stroke(CodexTheme.border, lineWidth: 1)
        )
        .accessibilityElement(children: .combine)
    }
}

private struct FilterStrip: View {
    @Binding var selection: ThreadFilter

    var body: some View {
        HStack(spacing: 8) {
            ForEach(ThreadFilter.allCases) { filter in
                Button {
                    selection = filter
                } label: {
                    Text(filter.label)
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(selection == filter ? CodexTheme.background : CodexTheme.primaryText)
                        .lineLimit(1)
                        .frame(maxWidth: .infinity)
                        .frame(height: 36)
                        .background(selection == filter ? CodexTheme.primaryText : CodexTheme.surfaceRaised, in: Capsule())
                        .overlay(
                            Capsule()
                                .stroke(selection == filter ? Color.clear : CodexTheme.border, lineWidth: 1)
                        )
                }
                .buttonStyle(.plain)
            }
        }
        .accessibilityElement(children: .contain)
    }
}

private struct ThreadCard: View {
    let snapshot: ThreadSnapshot

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .top, spacing: 12) {
                StatusGlyph(status: snapshot.status)

                VStack(alignment: .leading, spacing: 5) {
                    Text(snapshot.title)
                        .font(.system(size: 17, weight: .semibold))
                        .foregroundStyle(CodexTheme.primaryText)
                        .lineLimit(2)
                    Text(snapshot.hostId)
                        .font(.system(size: 12, weight: .medium, design: .monospaced))
                        .foregroundStyle(CodexTheme.secondaryText)
                        .lineLimit(1)
                }

                Spacer(minLength: 8)
                StatusBadge(status: snapshot.status)
            }

            Text(snapshot.latestActivityText)
                .font(.system(size: 13, weight: .medium, design: .monospaced))
                .foregroundStyle(snapshot.status == .waitingForApproval ? CodexTheme.warning : CodexTheme.secondaryText)
                .lineLimit(3)
                .frame(maxWidth: .infinity, alignment: .leading)

            HStack {
                Label(snapshot.lastEventAt, systemImage: "clock")
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(CodexTheme.tertiaryText)
                    .lineLimit(1)
                    .truncationMode(.tail)
                Spacer()
                Image(systemName: "chevron.right")
                    .font(.system(size: 12, weight: .bold))
                    .foregroundStyle(CodexTheme.tertiaryText)
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(CodexTheme.surface, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .stroke(snapshot.status.tint.opacity(snapshot.status == .waitingForApproval ? 0.45 : 0.18), lineWidth: 1)
        )
    }
}

private struct StatusGlyph: View {
    let status: ThreadStatus

    var body: some View {
        Image(systemName: status.symbol)
            .font(.system(size: 17, weight: .semibold))
            .foregroundStyle(status.tint)
            .frame(width: 38, height: 38)
            .background(status.tint.opacity(0.12), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
    }
}

private struct BottomControlBar: View {
    @ObservedObject var viewModel: MonitorViewModel

    var body: some View {
        HStack(spacing: 12) {
            ControlButton(symbol: "xmark.circle.fill", title: "停止", disabled: !viewModel.connected && !viewModel.connecting) {
                viewModel.stopMonitoring()
            }

            ControlButton(symbol: "arrow.triangle.2.circlepath", title: "重连", disabled: viewModel.connecting || !viewModel.hasConfiguration) {
                Task { await viewModel.reconnectMonitoring() }
            }

            ControlButton(symbol: "trash", title: "清除") {
                viewModel.clearConfiguration()
            }

            Button {
                Task { await viewModel.startMonitoring() }
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: viewModel.connected ? "dot.radiowaves.left.and.right" : "play.fill")
                    Text(viewModel.connected ? "监控中" : "连接并监控")
                        .font(.system(size: 15, weight: .semibold))
                        .lineLimit(1)
                        .minimumScaleFactor(0.82)
                }
                .foregroundStyle(CodexTheme.background)
                .frame(maxWidth: .infinity)
                .frame(height: 52)
                .background(CodexTheme.primaryText, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            }
            .buttonStyle(.plain)
            .disabled(viewModel.connecting || viewModel.connected)
        }
        .padding(10)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .stroke(CodexTheme.border, lineWidth: 1)
        )
    }
}

private struct ControlButton: View {
    let symbol: String
    let title: String
    var disabled = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(spacing: 4) {
                Image(systemName: symbol)
                    .font(.system(size: 17, weight: .semibold))
                Text(title)
                    .font(.system(size: 10, weight: .semibold))
                    .lineLimit(1)
                    .minimumScaleFactor(0.75)
            }
            .foregroundStyle(disabled ? CodexTheme.tertiaryText : CodexTheme.primaryText)
            .frame(width: 58, height: 52)
            .background(CodexTheme.surfaceRaised, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        }
        .buttonStyle(.plain)
        .disabled(disabled)
        .accessibilityLabel(title)
    }
}

private struct IconButton: View {
    let symbol: String
    let label: String
    var disabled = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(disabled ? CodexTheme.tertiaryText : CodexTheme.primaryText)
                .frame(width: 34, height: 34)
                .background(CodexTheme.surfaceRaised, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .stroke(CodexTheme.border, lineWidth: 1)
                )
        }
        .buttonStyle(.plain)
        .disabled(disabled)
        .accessibilityLabel(label)
    }
}

private struct EmptyDashboardView: View {
    let hasSnapshots: Bool

    var body: some View {
        VStack(spacing: 12) {
            Image(systemName: "terminal")
                .font(.system(size: 30, weight: .medium))
                .foregroundStyle(CodexTheme.tertiaryText)
                .frame(width: 64, height: 64)
                .background(CodexTheme.surface, in: RoundedRectangle(cornerRadius: 8, style: .continuous))

            Text("暂无匹配任务")
                .font(.system(size: 18, weight: .semibold))
                .foregroundStyle(CodexTheme.primaryText)
            Text(hasSnapshots ? "切换筛选条件可以查看其他任务。" : "连接后，Mac 上的 Codex 状态会显示在这里。")
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(CodexTheme.secondaryText)
                .multilineTextAlignment(.center)
        }
        .padding(.horizontal, 28)
    }
}

private struct ErrorBanner: View {
    let message: String

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(CodexTheme.danger)
            Text(message)
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(CodexTheme.primaryText)
                .lineLimit(2)
            Spacer(minLength: 0)
        }
        .padding(12)
        .background(CodexTheme.danger.opacity(0.10), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .stroke(CodexTheme.danger.opacity(0.28), lineWidth: 1)
        )
    }
}

private struct NoticeBanner: View {
    let message: String

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "checkmark.circle.fill")
                .foregroundStyle(CodexTheme.success)
            Text(message)
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(CodexTheme.primaryText)
                .lineLimit(2)
            Spacer(minLength: 0)
        }
        .padding(12)
        .background(CodexTheme.success.opacity(0.10), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .stroke(CodexTheme.success.opacity(0.24), lineWidth: 1)
        )
    }
}

private struct ThreadDetailView: View {
    @ObservedObject var viewModel: MonitorViewModel
    let snapshot: ThreadSnapshot
    @Environment(\.dismiss) private var dismiss
    @State private var logsExpanded = false

    var body: some View {
        ZStack {
            CodexTheme.background.ignoresSafeArea()

            VStack(spacing: 0) {
                DetailTopBar(title: snapshot.title) {
                    dismiss()
                }
                .padding(.horizontal, 18)
                .padding(.top, 12)

                ScrollView {
                    VStack(alignment: .leading, spacing: 16) {
                        DetailStatusPanel(snapshot: snapshot)

                        if let pendingApproval = snapshot.pendingApproval {
                            ApprovalPanel(pendingApproval: pendingApproval)
                        }

                        DetailSection(title: "执行步骤", symbol: "list.bullet.rectangle") {
                            if snapshot.steps.isEmpty {
                                EmptyLine(text: "暂无步骤")
                            } else {
                                VStack(spacing: 10) {
                                    ForEach(snapshot.steps) { step in
                                        StepRow(step: step)
                                    }
                                }
                            }
                        }

                        DetailSection(title: "最近日志", symbol: "text.alignleft") {
                            if snapshot.recentLogs.isEmpty {
                                EmptyLine(text: "暂无日志")
                            } else {
                                VStack(spacing: 10) {
                                    ForEach(displayedLogs) { log in
                                        LogRow(log: log)
                                    }
                                    if snapshot.recentLogs.count > 3 {
                                        Button {
                                            logsExpanded.toggle()
                                        } label: {
                                            Label(logsExpanded ? "收起日志" : "展开全部", systemImage: logsExpanded ? "chevron.up" : "chevron.down")
                                        }
                                        .buttonStyle(CodexSecondaryButtonStyle())
                                    }
                                }
                            }
                        }

                        DetailSection(title: "操作", symbol: "slider.horizontal.3") {
                            VStack(spacing: 10) {
                                Button {
                                    Task { await viewModel.refresh() }
                                } label: {
                                    Label("刷新", systemImage: "arrow.clockwise")
                                }
                                .buttonStyle(CodexSecondaryButtonStyle())

                                HStack(spacing: 10) {
                                    CopyButton(text: snapshot.copyableLogText, label: "复制日志")
                                        .buttonStyle(CodexSecondaryButtonStyle())
                                        .disabled(snapshot.recentLogs.isEmpty)

                                    CopyButton(text: snapshot.pendingApproval?.commandPreview ?? "", label: "复制命令")
                                        .buttonStyle(CodexSecondaryButtonStyle(tint: CodexTheme.warning))
                                        .disabled(snapshot.pendingApproval == nil)
                                }
                            }
                        }
                    }
                    .padding(.horizontal, 18)
                    .padding(.top, 18)
                    .padding(.bottom, 28)
                }
                .scrollIndicators(.hidden)
            }
        }
        .toolbar(.hidden, for: .navigationBar)
    }

    private var displayedLogs: [LogLine] {
        logsExpanded ? snapshot.recentLogs : Array(snapshot.recentLogs.suffix(3))
    }
}

private struct DetailTopBar: View {
    let title: String
    let close: () -> Void

    var body: some View {
        HStack(spacing: 12) {
            Button(action: close) {
                Image(systemName: "chevron.left")
                    .font(.system(size: 16, weight: .bold))
                    .foregroundStyle(CodexTheme.primaryText)
                    .frame(width: 38, height: 38)
                    .background(CodexTheme.surfaceRaised, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            }
            .buttonStyle(.plain)

            Text(title)
                .font(.system(size: 18, weight: .semibold))
                .foregroundStyle(CodexTheme.primaryText)
                .lineLimit(1)

            Spacer()
        }
    }
}

private struct DetailStatusPanel: View {
    let snapshot: ThreadSnapshot

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 7) {
                    Text(snapshot.statusLabel)
                        .font(.system(size: 32, weight: .semibold, design: .rounded))
                        .foregroundStyle(snapshot.status.tint)
                    Text(snapshot.hostId)
                        .font(.system(size: 13, weight: .medium, design: .monospaced))
                        .foregroundStyle(CodexTheme.secondaryText)
                }

                Spacer()
                StatusGlyph(status: snapshot.status)
            }

            HStack(spacing: 8) {
                DetailFact(symbol: "clock", text: snapshot.lastEventAt)
                if let turnId = snapshot.currentTurnId {
                    DetailFact(symbol: "arrow.triangle.turn.up.right.diamond", text: turnId)
                }
            }
        }
        .padding(18)
        .background(CodexTheme.surface, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .stroke(snapshot.status.tint.opacity(0.24), lineWidth: 1)
        )
    }
}

private struct DetailFact: View {
    let symbol: String
    let text: String

    var body: some View {
        Label(text, systemImage: symbol)
            .font(.system(size: 11, weight: .medium, design: .monospaced))
            .foregroundStyle(CodexTheme.tertiaryText)
            .lineLimit(1)
            .truncationMode(.middle)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct ApprovalPanel: View {
    let pendingApproval: PendingApproval

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Label("等待批准", systemImage: "hand.raised.fill")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(CodexTheme.warning)
                Spacer()
                Text(pendingApproval.at)
                    .font(.system(size: 11, weight: .medium, design: .monospaced))
                    .foregroundStyle(CodexTheme.tertiaryText)
                    .lineLimit(1)
            }

            Text(pendingApproval.commandPreview)
                .font(.system(size: 15, weight: .medium, design: .monospaced))
                .foregroundStyle(CodexTheme.primaryText)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)

            CopyButton(text: pendingApproval.commandPreview, label: "复制命令")
                .buttonStyle(CodexProminentButtonStyle(tint: CodexTheme.warning, foreground: CodexTheme.onWarning))
        }
        .padding(18)
        .background(CodexTheme.warning.opacity(0.10), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .stroke(CodexTheme.warning.opacity(0.35), lineWidth: 1)
        )
    }
}

private struct DetailSection<Content: View>: View {
    let title: String
    let symbol: String
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label(title, systemImage: symbol)
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(CodexTheme.primaryText)
            content
        }
        .padding(16)
        .background(CodexTheme.surface, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .stroke(CodexTheme.border, lineWidth: 1)
        )
    }
}

private struct StepRow: View {
    let step: StepSnapshot

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: step.symbol)
                .foregroundStyle(step.tint)
                .frame(width: 26, height: 26)
                .background(step.tint.opacity(0.12), in: RoundedRectangle(cornerRadius: 7, style: .continuous))

            Text(step.label)
                .font(.system(size: 14, weight: .medium))
                .foregroundStyle(CodexTheme.primaryText)
                .lineLimit(2)

            Spacer()

            Text(step.status)
                .font(.system(size: 11, weight: .semibold, design: .monospaced))
                .foregroundStyle(CodexTheme.secondaryText)
        }
    }
}

private struct LogRow: View {
    let log: LogLine

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack {
                Text(log.stream.uppercased())
                    .font(.system(size: 11, weight: .bold, design: .monospaced))
                    .foregroundStyle(CodexTheme.accent)
                Spacer()
                Text(log.at)
                    .font(.system(size: 10, weight: .medium, design: .monospaced))
                    .foregroundStyle(CodexTheme.tertiaryText)
            }

            Text(log.text)
                .font(.system(size: 12, weight: .medium, design: .monospaced))
                .foregroundStyle(CodexTheme.secondaryText)
                .textSelection(.enabled)
        }
        .padding(12)
        .background(CodexTheme.surfaceRaised, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
    }
}

private struct EmptyLine: View {
    let text: String

    var body: some View {
        Text(text)
            .font(.system(size: 13, weight: .medium))
            .foregroundStyle(CodexTheme.tertiaryText)
            .frame(maxWidth: .infinity, minHeight: 42, alignment: .leading)
    }
}

private struct SettingsView: View {
    @ObservedObject var viewModel: MonitorViewModel
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        ZStack {
            CodexTheme.background.ignoresSafeArea()

            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    HStack(spacing: 12) {
                        CodexMark()
                        VStack(alignment: .leading, spacing: 3) {
                            Text("连接设置")
                                .font(.system(size: 28, weight: .semibold, design: .rounded))
                                .foregroundStyle(CodexTheme.primaryText)
                                .lineLimit(1)
                                .minimumScaleFactor(0.82)
                            Text("配置 iPhone 监控 Codex 的服务器")
                                .font(.system(size: 13, weight: .medium))
                                .foregroundStyle(CodexTheme.secondaryText)
                                .lineLimit(2)
                        }
                        Spacer(minLength: 8)
                        Button {
                            dismiss()
                        } label: {
                            Image(systemName: "xmark")
                                .font(.system(size: 14, weight: .bold))
                                .foregroundStyle(CodexTheme.primaryText)
                                .frame(width: 38, height: 38)
                                .background(CodexTheme.surfaceRaised, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("关闭设置")
                    }

                    VStack(alignment: .leading, spacing: 14) {
                        Text("Server URL")
                            .font(.system(size: 12, weight: .semibold, design: .monospaced))
                            .foregroundStyle(CodexTheme.secondaryText)
                        ServerURLField(text: $viewModel.baseURLText)
                            .codexInputStyle()
                            .accessibilityLabel("Server URL")

                        Text("Mobile Token")
                            .font(.system(size: 12, weight: .semibold, design: .monospaced))
                            .foregroundStyle(CodexTheme.secondaryText)
                        SecureField("mobile token", text: $viewModel.token)
                            .textContentType(.password)
                            .codexInputStyle()
                            .accessibilityLabel("Mobile Token")
                    }
                    .padding(16)
                    .background(CodexTheme.surface, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                    .overlay(
                        RoundedRectangle(cornerRadius: 8, style: .continuous)
                            .stroke(CodexTheme.border, lineWidth: 1)
                    )

                    VStack(spacing: 10) {
                        Button {
                            viewModel.saveConfiguration()
                            Task { await viewModel.startMonitoring() }
                            dismiss()
                        } label: {
                            Label("连接并监控", systemImage: "checkmark.circle.fill")
                        }
                        .buttonStyle(CodexProminentButtonStyle(tint: CodexTheme.primaryText))

                        HStack(spacing: 10) {
                            Button {
                                Task { await viewModel.refresh() }
                            } label: {
                                Label("测试连接", systemImage: "network")
                            }
                            .buttonStyle(CodexSecondaryButtonStyle())
                            .disabled(viewModel.connecting)

                            Button(role: .destructive) {
                                viewModel.stopMonitoring()
                            } label: {
                                Label("停止监控", systemImage: "stop.circle")
                            }
                            .buttonStyle(CodexSecondaryButtonStyle(tint: CodexTheme.danger))
                        }

                        HStack(spacing: 10) {
                            Button {
                                Task { await viewModel.reconnectMonitoring() }
                            } label: {
                                Label("重新连接", systemImage: "arrow.triangle.2.circlepath")
                            }
                            .buttonStyle(CodexSecondaryButtonStyle())
                            .disabled(viewModel.connecting || !viewModel.hasConfiguration)

                            Button(role: .destructive) {
                                viewModel.clearConfiguration()
                            } label: {
                                Label("清除配置", systemImage: "trash")
                            }
                            .buttonStyle(CodexSecondaryButtonStyle(tint: CodexTheme.danger))
                        }
                    }

                    if let errorMessage = viewModel.errorMessage {
                        ErrorBanner(message: errorMessage)
                    }

                    if let noticeMessage = viewModel.noticeMessage {
                        NoticeBanner(message: noticeMessage)
                    }

                    Spacer(minLength: 180)
                }
                .frame(maxWidth: 620, alignment: .center)
                .padding(.horizontal, 20)
                .padding(.top, 20)
                .padding(.bottom, 28)
            }
            .scrollIndicators(.hidden)
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
            .autocorrectionDisabled()
        #else
        TextField("https://monitor.example.com", text: $text)
        #endif
    }
}

private struct CopyButton: View {
    let text: String
    let label: String

    var body: some View {
        Button {
            copy(text)
        } label: {
            Label(label, systemImage: "doc.on.doc.fill")
        }
    }

    private func copy(_ value: String) {
        #if canImport(UIKit)
        UIPasteboard.general.string = value
        #endif
    }
}

private struct StatusBadge: View {
    let status: ThreadStatus

    var body: some View {
        Text(status.statusLabel)
            .font(.system(size: 11, weight: .bold))
            .foregroundStyle(status.tint)
            .lineLimit(1)
            .padding(.horizontal, 9)
            .frame(height: 26)
            .background(status.tint.opacity(0.12), in: Capsule())
            .overlay(Capsule().stroke(status.tint.opacity(0.24), lineWidth: 1))
            .accessibilityLabel("状态：\(status.statusLabel)")
    }
}

private struct CodexProminentButtonStyle: ButtonStyle {
    var tint: Color
    var foreground: Color = CodexTheme.background

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 15, weight: .semibold))
            .foregroundStyle(foreground)
            .frame(maxWidth: .infinity)
            .frame(height: 48)
            .background(tint, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            .opacity(configuration.isPressed ? 0.82 : 1)
    }
}

private struct CodexSecondaryButtonStyle: ButtonStyle {
    var tint: Color = CodexTheme.primaryText

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 13, weight: .semibold))
            .foregroundStyle(tint)
            .frame(maxWidth: .infinity)
            .frame(height: 44)
            .background(CodexTheme.surfaceRaised, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .stroke(CodexTheme.border, lineWidth: 1)
            )
            .opacity(configuration.isPressed ? 0.78 : 1)
    }
}

private extension View {
    func codexInputStyle() -> some View {
        self
            .font(.system(size: 15, weight: .medium, design: .monospaced))
            .foregroundStyle(CodexTheme.primaryText)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .padding(.horizontal, 14)
            .frame(height: 48)
            .background(CodexTheme.surface, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .stroke(CodexTheme.border, lineWidth: 1)
            )
    }
}

private extension ThreadStatus {
    var symbol: String {
        switch self {
        case .idle:
            return "circle.dotted"
        case .running:
            return "bolt.fill"
        case .waitingForApproval:
            return "hand.raised.fill"
        case .failed:
            return "xmark.octagon.fill"
        case .completed:
            return "checkmark.seal.fill"
        }
    }

    var tint: Color {
        switch self {
        case .idle:
            return CodexTheme.tertiaryText
        case .running:
            return CodexTheme.accent
        case .waitingForApproval:
            return CodexTheme.warning
        case .failed:
            return CodexTheme.danger
        case .completed:
            return CodexTheme.success
        }
    }
}

private extension StepSnapshot {
    var symbol: String {
        switch status {
        case "completed":
            return "checkmark.circle.fill"
        case "failed":
            return "xmark.circle.fill"
        case "running":
            return "arrow.triangle.2.circlepath.circle.fill"
        default:
            return "circle"
        }
    }

    var tint: Color {
        switch status {
        case "completed":
            return CodexTheme.success
        case "failed":
            return CodexTheme.danger
        case "running":
            return CodexTheme.accent
        default:
            return CodexTheme.tertiaryText
        }
    }
}

private enum CodexTheme {
    static var background: Color {
        adaptive(light: (0.965, 0.955, 0.925, 1), dark: (0.045, 0.047, 0.044, 1))
    }

    static var surface: Color {
        adaptive(light: (1.000, 0.992, 0.965, 1), dark: (0.085, 0.087, 0.082, 1))
    }

    static var surfaceRaised: Color {
        adaptive(light: (0.925, 0.912, 0.875, 1), dark: (0.125, 0.126, 0.118, 1))
    }

    static var border: Color {
        adaptive(light: (0.070, 0.066, 0.058, 0.12), dark: (1.000, 1.000, 1.000, 0.09))
    }

    static var primaryText: Color {
        adaptive(light: (0.095, 0.093, 0.084, 1), dark: (0.930, 0.920, 0.880, 1))
    }

    static var secondaryText: Color {
        adaptive(light: (0.370, 0.360, 0.325, 1), dark: (0.640, 0.640, 0.590, 1))
    }

    static var tertiaryText: Color {
        adaptive(light: (0.570, 0.550, 0.500, 1), dark: (0.440, 0.440, 0.400, 1))
    }

    static var accent: Color {
        adaptive(light: (0.050, 0.430, 0.720, 1), dark: (0.380, 0.720, 0.950, 1))
    }

    static var success: Color {
        adaptive(light: (0.100, 0.560, 0.280, 1), dark: (0.420, 0.820, 0.550, 1))
    }

    static var warning: Color {
        adaptive(light: (0.800, 0.420, 0.060, 1), dark: (0.950, 0.670, 0.310, 1))
    }

    static var danger: Color {
        adaptive(light: (0.780, 0.160, 0.130, 1), dark: (0.950, 0.340, 0.320, 1))
    }

    static var onWarning: Color {
        adaptive(light: (0.095, 0.093, 0.084, 1), dark: (0.045, 0.047, 0.044, 1))
    }

    private static func adaptive(
        light: (Double, Double, Double, Double),
        dark: (Double, Double, Double, Double)
    ) -> Color {
        #if canImport(UIKit)
        return Color(UIColor { traits in
            let value = traits.userInterfaceStyle == .dark ? dark : light
            return UIColor(
                red: CGFloat(value.0),
                green: CGFloat(value.1),
                blue: CGFloat(value.2),
                alpha: CGFloat(value.3)
            )
        })
        #else
        return Color(red: light.0, green: light.1, blue: light.2, opacity: light.3)
        #endif
    }
}
