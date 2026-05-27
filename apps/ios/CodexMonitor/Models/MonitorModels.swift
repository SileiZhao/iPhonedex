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
    let status: ThreadStatus
    let currentTurnId: String?
    let lastEventAt: String
    let pendingApproval: PendingApproval?
    let steps: [StepSnapshot]
    let recentLogs: [LogLine]

    var id: String { threadId }
    var statusLabel: String { status.statusLabel }

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
}
