import XCTest
@testable import CodexMonitor

final class MonitorModelsTests: XCTestCase {
    func testDecodesWaitingForApprovalSnapshot() throws {
        let json = """
        {
          "threadId": "thread-1",
          "title": "Monitor",
          "hostId": "mac-mini",
          "status": "waiting_for_approval",
          "currentTurnId": "turn-1",
          "lastEventAt": "2026-05-26T10:00:00.000Z",
          "pendingApproval": {
            "approvalId": "approval-1",
            "turnId": "turn-1",
            "commandPreview": "pnpm install",
            "at": "2026-05-26T10:00:00.000Z"
          },
          "steps": [],
          "recentLogs": [
            { "stream": "system", "text": "Need approval", "at": "2026-05-26T10:00:00.000Z" }
          ]
        }
        """.data(using: .utf8)!

        let snapshot = try JSONDecoder().decode(ThreadSnapshot.self, from: json)

        XCTAssertEqual(snapshot.title, "Monitor")
        XCTAssertEqual(snapshot.status, .waitingForApproval)
        XCTAssertEqual(snapshot.statusLabel, "等待批准")
        XCTAssertEqual(snapshot.pendingApproval?.commandPreview, "pnpm install")
        XCTAssertEqual(snapshot.recentLogs.first?.text, "Need approval")
    }

    func testFiltersSnapshotsByStatus() throws {
        let waiting = makeSnapshot(id: "waiting", status: .waitingForApproval)
        let running = makeSnapshot(id: "running", status: .running)
        let failed = makeSnapshot(id: "failed", status: .failed)

        XCTAssertEqual(ThreadFilter.active.label, "执行中")
        XCTAssertEqual(ThreadFilter.actionRequired.apply(to: [waiting, running, failed]).map(\.threadId), ["waiting"])
        XCTAssertEqual(ThreadFilter.active.apply(to: [waiting, running, failed]).map(\.threadId), ["waiting", "running"])
        XCTAssertEqual(ThreadFilter.failed.apply(to: [waiting, running, failed]).map(\.threadId), ["failed"])
        XCTAssertEqual(ThreadFilter.all.apply(to: [waiting, running, failed]).count, 3)
    }

    func testSortsSnapshotsByLastEventDescending() throws {
        let older = makeSnapshot(id: "older", status: .running, lastEventAt: "2026-05-26T10:00:00.000Z")
        let newer = makeSnapshot(id: "newer", status: .running, lastEventAt: "2026-05-26T10:05:00.000Z")

        XCTAssertEqual(ThreadSnapshot.sortedByRecentActivity([older, newer]).map(\.threadId), ["newer", "older"])
    }

    func testBuildsDashboardSummary() throws {
        let summary = DashboardSummary(snapshots: [
            makeSnapshot(id: "waiting", status: .waitingForApproval),
            makeSnapshot(id: "running", status: .running),
            makeSnapshot(id: "failed", status: .failed),
            makeSnapshot(id: "done", status: .completed)
        ])

        XCTAssertEqual(summary.totalCount, 4)
        XCTAssertEqual(summary.actionRequiredCount, 1)
        XCTAssertEqual(summary.activeCount, 2)
        XCTAssertEqual(summary.failedCount, 1)
    }

    func testFindsLatestSnapshotForDetailUpdates() throws {
        let stale = makeSnapshot(id: "thread-1", status: .running, lastEventAt: "2026-05-26T10:00:00.000Z")
        let updated = makeSnapshot(id: "thread-1", status: .waitingForApproval, lastEventAt: "2026-05-26T10:01:00.000Z")
        let other = makeSnapshot(id: "thread-2", status: .completed, lastEventAt: "2026-05-26T10:02:00.000Z")

        XCTAssertEqual(ThreadSnapshot.find("thread-1", in: [other, stale, updated]), updated)
        XCTAssertNil(ThreadSnapshot.find("missing", in: [other, stale, updated]))
    }

    func testPrioritizesActionRequiredSnapshots() throws {
        let completed = makeSnapshot(id: "completed", status: .completed, lastEventAt: "2026-05-26T10:03:00.000Z")
        let running = makeSnapshot(id: "running", status: .running, lastEventAt: "2026-05-26T10:02:00.000Z")
        let waiting = makeSnapshot(id: "waiting", status: .waitingForApproval, lastEventAt: "2026-05-26T10:01:00.000Z")

        XCTAssertEqual(ThreadSnapshot.prioritizedForDashboard([completed, running, waiting]).map(\.threadId), [
            "waiting",
            "running",
            "completed"
        ])
    }

    func testBuildsCopyableLogText() throws {
        let snapshot = makeSnapshot(
            id: "thread-1",
            status: .running,
            recentLogs: [
                LogLine(stream: "stdout", text: "installing", at: "2026-05-26T10:00:00.000Z"),
                LogLine(stream: "stderr", text: "warning", at: "2026-05-26T10:00:01.000Z")
            ]
        )

        XCTAssertEqual(snapshot.latestLogText, "warning")
        XCTAssertEqual(
            snapshot.copyableLogText,
            "[2026-05-26T10:00:00.000Z] stdout: installing\n[2026-05-26T10:00:01.000Z] stderr: warning"
        )
    }

    private func makeSnapshot(
        id: String,
        status: ThreadStatus,
        lastEventAt: String = "2026-05-26T10:00:00.000Z",
        recentLogs: [LogLine] = []
    ) -> ThreadSnapshot {
        ThreadSnapshot(
            threadId: id,
            title: id,
            hostId: "mac-mini",
            status: status,
            currentTurnId: nil,
            lastEventAt: lastEventAt,
            pendingApproval: nil,
            steps: [],
            recentLogs: recentLogs
        )
    }
}
