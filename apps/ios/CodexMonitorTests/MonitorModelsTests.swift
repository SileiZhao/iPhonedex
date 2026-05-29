import XCTest
@testable import CodexMonitor

final class MonitorModelsTests: XCTestCase {
    func testDecodesWaitingForApprovalSnapshot() throws {
        let json = """
        {
          "threadId": "thread-1",
          "title": "Monitor",
          "hostId": "mac-mini",
          "cwd": "/Users/example/Monitor",
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
        XCTAssertEqual(snapshot.cwd, "/Users/example/Monitor")
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

    func testRecognizesCompatibilityPrefixedConversationLogs() throws {
        let user = LogLine(stream: "system", text: "[user] 继续执行", at: "2026-05-26T10:00:00.000Z")
        let reasoning = LogLine(stream: "system", text: "[reasoning] 先检查状态流", at: "2026-05-26T10:00:01.000Z")

        XCTAssertEqual(user.semanticStream, "user")
        XCTAssertEqual(user.displayText, "继续执行")
        XCTAssertEqual(reasoning.semanticStream, "reasoning")
        XCTAssertEqual(reasoning.displayText, "先检查状态流")
    }

    func testMainTimelineKeepsConversationReadable() throws {
        let snapshot = makeSnapshot(
            id: "thread-1",
            status: .completed,
            recentLogs: [
                LogLine(stream: "system", text: "Codex Desktop activity in /repo", at: "2026-05-26T10:00:00.000Z"),
                LogLine(stream: "assistant", text: "已经修复同步。", at: "2026-05-26T10:00:01.000Z"),
                LogLine(stream: "tool", text: "exec_command: pnpm test", at: "2026-05-26T10:00:02.000Z")
            ],
            steps: [
                StepSnapshot(stepId: "step-1", label: "exec_command: pnpm test", status: "completed")
            ]
        )

        XCTAssertEqual(snapshot.timelineItems.map(\.kind), [.assistant, .tool])
        XCTAssertEqual(snapshot.timelineBlocks.map(\.kind), [.item, .commandGroup])
        XCTAssertFalse(snapshot.timelineItems.contains { $0.title == "系统" })
        XCTAssertFalse(snapshot.timelineItems.contains { $0.id.hasPrefix("step-") })
    }

    func testGroupsConsecutiveToolAndTerminalItemsIntoOneCollapsedBlock() throws {
        let snapshot = makeSnapshot(
            id: "thread-1",
            status: .running,
            recentLogs: [
                LogLine(stream: "assistant", text: "我先检查项目。", at: "2026-05-26T10:00:00.000Z"),
                LogLine(stream: "tool", text: "exec_command: rg TODO", at: "2026-05-26T10:00:01.000Z"),
                LogLine(stream: "terminal", text: "TODO found", at: "2026-05-26T10:00:02.000Z"),
                LogLine(stream: "tool", text: "exec_command: pnpm test", at: "2026-05-26T10:00:03.000Z"),
                LogLine(stream: "assistant", text: "测试完成。", at: "2026-05-26T10:00:04.000Z")
            ]
        )

        XCTAssertEqual(snapshot.timelineBlocks.count, 3)
        guard case .commandGroup(let group) = snapshot.timelineBlocks[1] else {
            return XCTFail("Expected consecutive command records to render as one group")
        }
        XCTAssertEqual(group.items.map(\.kind), [.tool, .terminal, .tool])
        XCTAssertEqual(group.title, "工具调用与终端输出")
        XCTAssertEqual(group.summary, "3 条记录 · exec_command: rg TODO")
    }

    func testMergesAdjacentAssistantItemsIntoOneReadableReply() throws {
        let snapshot = makeSnapshot(
            id: "thread-1",
            status: .completed,
            recentLogs: [
                LogLine(stream: "assistant", text: "第一段回复。", at: "2026-05-26T10:00:00.000Z"),
                LogLine(stream: "assistant", text: "第二段回复。", at: "2026-05-26T10:00:01.000Z"),
                LogLine(stream: "user", text: "继续", at: "2026-05-26T10:00:02.000Z")
            ]
        )

        XCTAssertEqual(snapshot.timelineItems.map(\.kind), [.assistant, .user])
        XCTAssertEqual(snapshot.timelineItems.first?.text, "第一段回复。\n\n第二段回复。")
    }

    func testCommandGroupIdStaysStableWhenMoreCommandOutputArrives() throws {
        let initial = makeSnapshot(
            id: "thread-1",
            status: .running,
            recentLogs: [
                LogLine(stream: "tool", text: "exec_command: pnpm test", at: "2026-05-26T10:00:00.000Z"),
                LogLine(stream: "terminal", text: "first output", at: "2026-05-26T10:00:01.000Z")
            ]
        )
        let updated = makeSnapshot(
            id: "thread-1",
            status: .running,
            recentLogs: [
                LogLine(stream: "tool", text: "exec_command: pnpm test", at: "2026-05-26T10:00:00.000Z"),
                LogLine(stream: "terminal", text: "first output", at: "2026-05-26T10:00:01.000Z"),
                LogLine(stream: "terminal", text: "more output", at: "2026-05-26T10:00:02.000Z")
            ]
        )

        XCTAssertEqual(initial.timelineBlocks.first?.id, updated.timelineBlocks.first?.id)
    }

    func testGroupsSnapshotsIntoProjectsByWorkingDirectory() throws {
        let monitorRunning = makeSnapshot(
            id: "monitor-running",
            status: .running,
            lastEventAt: "2026-05-26T10:03:00.000Z",
            cwd: "/Users/example/Codex iPhone Agent"
        )
        let monitorDone = makeSnapshot(
            id: "monitor-done",
            status: .completed,
            lastEventAt: "2026-05-26T10:01:00.000Z",
            cwd: "/Users/example/Codex iPhone Agent/"
        )
        let website = makeSnapshot(
            id: "website",
            status: .waitingForApproval,
            lastEventAt: "2026-05-26T10:02:00.000Z",
            cwd: "/Users/example/topomotion.com"
        )

        let projects = ProjectSnapshot.grouped(from: [monitorDone, website, monitorRunning])

        XCTAssertEqual(projects.map(\.name), ["Codex iPhone Agent", "topomotion.com"])
        XCTAssertEqual(projects.first?.path, "/Users/example/Codex iPhone Agent")
        XCTAssertEqual(projects.first?.snapshots.map(\.threadId), ["monitor-running", "monitor-done"])
        XCTAssertEqual(projects.first?.summary.activeCount, 1)
        XCTAssertEqual(projects.first?.conversationCount, 2)
    }

    func testProjectGroupsExcludeSubagentSnapshots() throws {
        let main = makeSnapshot(
            id: "main-thread",
            status: .running,
            lastEventAt: "2026-05-26T10:03:00.000Z",
            cwd: "/Users/example/Codex iPhone Agent",
            threadSource: "user"
        )
        let subagent = makeSnapshot(
            id: "subagent-thread",
            status: .running,
            lastEventAt: "2026-05-26T10:04:00.000Z",
            cwd: "/Users/example/Codex iPhone Agent",
            threadSource: "subagent"
        )

        let projects = ProjectSnapshot.grouped(from: [subagent, main])

        XCTAssertEqual(projects.count, 1)
        XCTAssertEqual(projects[0].snapshots.map(\.threadId), ["main-thread"])
        XCTAssertEqual(projects[0].conversationCount, 1)
    }

    func testProjectGroupsPreferUserSourceOverLegacyUnknownSnapshots() throws {
        let mainV2 = makeSnapshot(
            id: "codex-v2",
            status: .completed,
            lastEventAt: "2026-05-26T10:05:00.000Z",
            cwd: "/Users/example/Codex iPhone Agent",
            threadSource: "user"
        )
        let main = makeSnapshot(
            id: "codex-v1",
            status: .idle,
            lastEventAt: "2026-05-26T10:04:00.000Z",
            cwd: "/Users/example/Codex iPhone Agent",
            threadSource: "user"
        )
        let legacySubagent = makeSnapshot(
            id: "legacy-subagent",
            status: .running,
            lastEventAt: "2026-05-26T10:06:00.000Z",
            cwd: "/Users/example/Codex iPhone Agent",
            threadSource: nil
        )

        let projects = ProjectSnapshot.grouped(from: [legacySubagent, main, mainV2])

        XCTAssertEqual(projects.count, 1)
        XCTAssertEqual(projects[0].snapshots.map(\.threadId), ["codex-v2", "codex-v1"])
        XCTAssertEqual(projects[0].conversationCount, 2)
    }

    func testProjectFilterDoesNotRevealSubagentsWhenUserSessionsAreInactive() throws {
        let main = makeSnapshot(
            id: "codex-v1",
            status: .completed,
            lastEventAt: "2026-05-26T10:04:00.000Z",
            cwd: "/Users/example/Codex iPhone Agent",
            threadSource: "user"
        )
        let subagent = makeSnapshot(
            id: "subagent-running",
            status: .running,
            lastEventAt: "2026-05-26T10:06:00.000Z",
            cwd: "/Users/example/Codex iPhone Agent",
            threadSource: "subagent"
        )

        let projects = ProjectSnapshot.grouped(from: [subagent, main], filter: .active)

        XCTAssertTrue(projects.isEmpty)
    }

    func testGroupsSnapshotsWithoutWorkingDirectoryIntoUncategorizedProject() throws {
        let snapshot = makeSnapshot(id: "thread-1", status: .failed, cwd: nil)

        let projects = ProjectSnapshot.grouped(from: [snapshot])

        XCTAssertEqual(projects.count, 1)
        XCTAssertEqual(projects[0].name, "未归类会话")
        XCTAssertEqual(projects[0].path, "mac-mini")
        XCTAssertEqual(projects[0].summary.failedCount, 1)
    }

    private func makeSnapshot(
        id: String,
        status: ThreadStatus,
        lastEventAt: String = "2026-05-26T10:00:00.000Z",
        cwd: String? = "/Users/example/Repo",
        threadSource: String? = "user",
        recentLogs: [LogLine] = [],
        steps: [StepSnapshot] = []
    ) -> ThreadSnapshot {
        ThreadSnapshot(
            threadId: id,
            title: id,
            hostId: "mac-mini",
            cwd: cwd,
            threadSource: threadSource,
            status: status,
            currentTurnId: nil,
            lastEventAt: lastEventAt,
            pendingApproval: nil,
            steps: steps,
            recentLogs: recentLogs
        )
    }
}
