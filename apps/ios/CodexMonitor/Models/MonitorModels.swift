import Foundation

enum ThreadStatus: String, Codable {
    case idle
    case running
    case waitingForApproval = "waiting_for_approval"
    case failed
    case completed

    var statusLabel: String {
        switch self {
        case .idle:
            return "空闲"
        case .running:
            return "执行中"
        case .waitingForApproval:
            return "等待批准"
        case .failed:
            return "失败"
        case .completed:
            return "已完成"
        }
    }
}

enum ThreadFilter: String, CaseIterable, Identifiable {
    case all
    case active
    case actionRequired
    case failed

    var id: String { rawValue }

    var label: String {
        switch self {
        case .all:
            return "全部"
        case .active:
            return "执行中"
        case .actionRequired:
            return "待处理"
        case .failed:
            return "失败"
        }
    }

    func apply(to snapshots: [ThreadSnapshot]) -> [ThreadSnapshot] {
        let sorted = ThreadSnapshot.sortedByRecentActivity(snapshots)
        switch self {
        case .all:
            return sorted
        case .active:
            return sorted.filter { [.running, .waitingForApproval].contains($0.status) }
        case .actionRequired:
            return sorted.filter { $0.status == .waitingForApproval }
        case .failed:
            return sorted.filter { $0.status == .failed }
        }
    }
}

struct DashboardSummary: Equatable {
    let totalCount: Int
    let actionRequiredCount: Int
    let activeCount: Int
    let failedCount: Int

    init(snapshots: [ThreadSnapshot]) {
        totalCount = snapshots.count
        actionRequiredCount = snapshots.filter { $0.status == .waitingForApproval }.count
        activeCount = snapshots.filter { [.running, .waitingForApproval].contains($0.status) }.count
        failedCount = snapshots.filter { $0.status == .failed }.count
    }
}

struct StepSnapshot: Codable, Identifiable, Equatable {
    let stepId: String
    let label: String
    let status: String

    var id: String { stepId }
}

struct LogLine: Codable, Identifiable, Equatable {
    let stream: String
    let text: String
    let at: String

    var id: String { "\(at)-\(stream)-\(text.hashValue)" }

    var semanticStream: String {
        if stream == "system", text.hasPrefix("[user] ") {
            return "user"
        }
        if stream == "system", text.hasPrefix("[reasoning] ") {
            return "reasoning"
        }
        return stream
    }

    var displayText: String {
        if stream == "system", text.hasPrefix("[user] ") {
            return String(text.dropFirst("[user] ".count))
        }
        if stream == "system", text.hasPrefix("[reasoning] ") {
            return String(text.dropFirst("[reasoning] ".count))
        }
        return text
    }
}

enum TimelineItemKind: Equatable {
    case user
    case assistant
    case reasoning
    case tool
    case terminal
    case approval
    case status
}

struct TimelineItem: Identifiable, Equatable {
    let id: String
    let kind: TimelineItemKind
    let title: String
    let text: String
    let at: String
    let status: String?
}

enum TimelineBlockKind: Equatable {
    case item
    case commandGroup
}

struct TimelineCommandGroup: Identifiable, Equatable {
    let id: String
    let title: String
    let items: [TimelineItem]
    let at: String

    var summary: String {
        "\(items.count) 条记录 · \(firstPreview)"
    }

    private var firstPreview: String {
        items.first?.text
            .split(separator: "\n")
            .first
            .map(String.init) ?? title
    }
}

enum TimelineBlock: Identifiable, Equatable {
    case item(TimelineItem)
    case commandGroup(TimelineCommandGroup)

    var id: String {
        switch self {
        case .item(let item):
            return item.id
        case .commandGroup(let group):
            return group.id
        }
    }

    var kind: TimelineBlockKind {
        switch self {
        case .item:
            return .item
        case .commandGroup:
            return .commandGroup
        }
    }
}

struct PendingApproval: Codable, Equatable {
    let approvalId: String
    let turnId: String
    let commandPreview: String
    let at: String
}

struct ThreadSnapshot: Codable, Identifiable, Equatable {
    let threadId: String
    let title: String
    let hostId: String
    let cwd: String?
    let threadSource: String?
    let status: ThreadStatus
    let currentTurnId: String?
    let lastEventAt: String
    let pendingApproval: PendingApproval?
    let steps: [StepSnapshot]
    let recentLogs: [LogLine]

    var id: String { threadId }
    var statusLabel: String { status.statusLabel }
    var isPrimaryConversation: Bool { threadSource == nil || threadSource == "user" }
    var projectKey: String { Self.normalizedProjectPath(cwd) ?? "uncategorized:\(hostId)" }
    var projectName: String {
        guard let projectPath = Self.normalizedProjectPath(cwd) else { return "未归类会话" }
        return URL(fileURLWithPath: projectPath).lastPathComponent
    }
    var projectPath: String { Self.normalizedProjectPath(cwd) ?? hostId }

    var latestActivityText: String {
        if let pendingApproval {
            return pendingApproval.commandPreview
        }
        if let latestLogText {
            return latestLogText
        }
        return "暂无日志"
    }

    var latestLogText: String? {
        recentLogs.last?.text
    }

    var copyableLogText: String {
        recentLogs
            .map { "[\($0.at)] \($0.stream): \($0.text)" }
            .joined(separator: "\n")
    }

    var timelineItems: [TimelineItem] {
        var items: [TimelineItem] = []

        for log in recentLogs {
            let stream = log.semanticStream
            let kind = TimelineItem.kind(for: stream)
            guard kind != .status else { continue }
            let item = TimelineItem(
                id: log.id,
                kind: kind,
                title: TimelineItem.title(for: stream),
                text: log.displayText,
                at: log.at,
                status: nil
            )
            appendTimelineItem(item, to: &items)
        }

        if let pendingApproval {
            items.append(
                TimelineItem(
                    id: "approval-\(pendingApproval.approvalId)",
                    kind: .approval,
                    title: "等待批准",
                    text: pendingApproval.commandPreview,
                    at: pendingApproval.at,
                    status: "waiting"
                )
            )
        }

        return items
            .filter { !$0.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
            .sorted { lhs, rhs in lhs.at < rhs.at }
    }

    var timelineBlocks: [TimelineBlock] {
        var blocks: [TimelineBlock] = []
        var commandItems: [TimelineItem] = []

        func flushCommandGroup() {
            guard !commandItems.isEmpty else { return }
            let first = commandItems[0]
            blocks.append(
                .commandGroup(
                    TimelineCommandGroup(
                        id: "command-group-\(first.id)",
                        title: "工具调用与终端输出",
                        items: commandItems,
                        at: first.at
                    )
                )
            )
            commandItems = []
        }

        for item in timelineItems {
            if item.isCommandRecord {
                commandItems.append(item)
            } else {
                flushCommandGroup()
                blocks.append(.item(item))
            }
        }
        flushCommandGroup()
        return blocks
    }

    private func appendTimelineItem(_ item: TimelineItem, to items: inout [TimelineItem]) {
        guard item.kind == .assistant, let previous = items.last, previous.kind == .assistant else {
            items.append(item)
            return
        }

        if previous.text == item.text {
            return
        }

        items[items.count - 1] = TimelineItem(
            id: previous.id,
            kind: previous.kind,
            title: previous.title,
            text: "\(previous.text)\n\n\(item.text)",
            at: previous.at,
            status: previous.status
        )
    }

    static func sortedByRecentActivity(_ snapshots: [ThreadSnapshot]) -> [ThreadSnapshot] {
        snapshots.sorted { lhs, rhs in
            lhs.lastEventAt > rhs.lastEventAt
        }
    }

    static func prioritizedForDashboard(_ snapshots: [ThreadSnapshot]) -> [ThreadSnapshot] {
        sortedByRecentActivity(snapshots).sorted { lhs, rhs in
            lhs.dashboardPriority < rhs.dashboardPriority
        }
    }

    static func find(_ threadId: String, in snapshots: [ThreadSnapshot]) -> ThreadSnapshot? {
        snapshots
            .filter { $0.threadId == threadId }
            .max { lhs, rhs in lhs.lastEventAt < rhs.lastEventAt }
    }

    private var dashboardPriority: Int {
        switch status {
        case .waitingForApproval:
            return 0
        case .running:
            return 1
        case .failed:
            return 2
        case .idle:
            return 3
        case .completed:
            return 4
        }
    }

    private static func normalizedProjectPath(_ path: String?) -> String? {
        guard let trimmed = path?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty else {
            return nil
        }
        var normalized = trimmed
        while normalized.count > 1 && normalized.hasSuffix("/") {
            normalized.removeLast()
        }
        return normalized
    }
}

struct ProjectSnapshot: Identifiable, Equatable {
    let id: String
    let name: String
    let path: String
    let snapshots: [ThreadSnapshot]

    var conversationCount: Int { snapshots.count }
    var summary: DashboardSummary { DashboardSummary(snapshots: snapshots) }
    var lastEventAt: String { snapshots.map(\.lastEventAt).max() ?? "" }
    var hostLabel: String {
        let hosts = Array(Set(snapshots.map(\.hostId))).sorted()
        return hosts.joined(separator: ", ")
    }
    var primarySnapshot: ThreadSnapshot? { ThreadSnapshot.prioritizedForDashboard(snapshots).first }

    static func grouped(from snapshots: [ThreadSnapshot], filter: ThreadFilter = .all) -> [ProjectSnapshot] {
        let grouped = Dictionary(grouping: snapshots, by: \.projectKey)
        return grouped.compactMap { key, snapshots -> ProjectSnapshot? in
            let userSnapshots = snapshots.filter { $0.threadSource == "user" }
            let primarySnapshots = userSnapshots.isEmpty
                ? snapshots.filter(\.isPrimaryConversation)
                : userSnapshots
            let visibleSnapshots = filter.apply(to: primarySnapshots)
            guard !visibleSnapshots.isEmpty else { return nil }

            let sortedSnapshots = visibleSnapshots
            let representative = sortedSnapshots.first ?? visibleSnapshots[0]
            return ProjectSnapshot(
                id: key,
                name: representative.projectName,
                path: representative.projectPath,
                snapshots: sortedSnapshots
            )
        }
        .sorted { lhs, rhs in
            if lhs.lastEventAt == rhs.lastEventAt {
                return lhs.name.localizedCaseInsensitiveCompare(rhs.name) == .orderedAscending
            }
            return lhs.lastEventAt > rhs.lastEventAt
        }
    }

    static func find(_ projectId: String, in snapshots: [ThreadSnapshot]) -> ProjectSnapshot? {
        grouped(from: snapshots).first { $0.id == projectId }
    }
}

private extension TimelineItem {
    var isCommandRecord: Bool {
        kind == .tool || kind == .terminal
    }

    static func kind(for stream: String) -> TimelineItemKind {
        switch stream {
        case "user":
            return .user
        case "assistant":
            return .assistant
        case "reasoning":
            return .reasoning
        case "tool":
            return .tool
        case "terminal":
            return .terminal
        default:
            return .status
        }
    }

    static func title(for stream: String) -> String {
        switch stream {
        case "user":
            return "你"
        case "assistant":
            return "Codex"
        case "reasoning":
            return "Thinking"
        case "tool":
            return "工具调用"
        case "terminal":
            return "命令输出"
        default:
            return "系统"
        }
    }
}
