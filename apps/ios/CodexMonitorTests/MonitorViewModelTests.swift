import XCTest
@testable import CodexMonitor

final class MonitorViewModelTests: XCTestCase {
    func testRefreshCancellationErrorsAreNotUserFacingFailures() {
        XCTAssertTrue(MonitorViewModel.isCancellation(URLError(.cancelled)))
        XCTAssertTrue(MonitorViewModel.isCancellation(CancellationError()))
    }

    func testOtherNetworkErrorsStillRemainUserFacingFailures() {
        XCTAssertFalse(MonitorViewModel.isCancellation(URLError(.timedOut)))
    }
}
