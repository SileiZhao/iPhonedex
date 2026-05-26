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
        XCTAssertEqual(snapshot.recentLogs.first?.text, "Need approval")
    }
}
