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

struct ThreadSnapshot: Codable, Identifiable, Equatable {
    let threadId: String
    let title: String
    let hostId: String
    let status: ThreadStatus
    let currentTurnId: String?
    let lastEventAt: String
    let steps: [StepSnapshot]
    let recentLogs: [LogLine]

    var id: String { threadId }
    var statusLabel: String { status.statusLabel }
}
