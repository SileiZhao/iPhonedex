import XCTest
@testable import CodexMonitor

final class ConfigurationStoreTests: XCTestCase {
    func testNormalizesPublicHTTPDomainsToHTTPS() {
        XCTAssertEqual(
            ConfigurationStore.normalizedServerURL(" http://www.topomotion.com/codex-monitor "),
            "https://www.topomotion.com/codex-monitor"
        )
    }

    func testKeepsLocalHTTPServersForSmokeTesting() {
        XCTAssertEqual(
            ConfigurationStore.normalizedServerURL("http://192.168.1.69:8787"),
            "http://192.168.1.69:8787"
        )
        XCTAssertFalse(ConfigurationStore.isPublicHTTPURL("http://192.168.1.69:8787"))
    }

    func testDetectsPublicHTTPURLsBeforeATSBlocksThem() {
        XCTAssertTrue(ConfigurationStore.isPublicHTTPURL("http://118.89.145.103:18787"))
        XCTAssertTrue(ConfigurationStore.isPublicHTTPURL("http://www.topomotion.com/codex-monitor"))
    }
}
