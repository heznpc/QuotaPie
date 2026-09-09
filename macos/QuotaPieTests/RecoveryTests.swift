import Foundation
import XCTest
@testable import QuotaPie

final class RecoveryTests: XCTestCase {
    func testOldDaemonWithoutRecoveryStillDecodes() throws {
        let payload = try JSONDecoder().decode(StatusPayload.self, from: Data("{}".utf8))
        XCTAssertNil(payload.resetTracking)
    }

    func testWindowStateAndTransportFailureDoNotClaimPublicAttribution() throws {
        let json = """
        {"bucket":"weekly","label":"Weekly","state":"recovery-observed",
        "reason":null,"comparedAfterMs":100,"comparedByMs":200,
        "recovery":{"eventId":1,"observedAfterMs":100,"observedByMs":200,
          "remainingBefore":5,"remainingAfter":100,"previousResetsAtMs":1000,"nextResetsAtMs":2000,
          "reason":"time-proximity-only","candidates":[{"signalId":"123","author":"thsottiaux",
            "sourceUrl":"https://x.com/thsottiaux/status/123","publishedAtMs":500,"observedVia":"public-feed"}]}}
        """
        let window = try JSONDecoder().decode(WindowRecovery.self, from: Data(json.utf8))
        XCTAssertEqual(window.statusText(transportUnavailable: false), Strings.t("recovery.state.recovery-observed"))
        XCTAssertEqual(window.statusText(transportUnavailable: true), Strings.t("recovery.state.unavailable"))
        XCTAssertEqual(window.recovery?.observedByMs, 200)
        XCTAssertEqual(window.recovery?.candidates.first?.publishedAtMs, 500)
        XCTAssertEqual(window.recovery?.reasonText, Strings.t("recovery.reason.time-proximity-only"))
        XCTAssertNotNil(window.recovery?.candidates.first?.safeSourceURL)
        let unknown = json.replacingOccurrences(of: "recovery-observed", with: "future-state")
        XCTAssertEqual(try JSONDecoder().decode(WindowRecovery.self, from: Data(unknown.utf8)).statusText(transportUnavailable: false),
                       Strings.t("recovery.state.unavailable"))
    }

    func testCandidateLinksRejectUnexpectedOriginAndAuthor() {
        for url in ["https://evil.test/thsottiaux/status/123", "https://x.com@evil.test/thsottiaux/status/123",
                    "https://x.com/thsottiaux/status/999", "http://x.com/thsottiaux/status/123"] {
            XCTAssertNil(RecoveryCandidate(signalId: "123", author: "thsottiaux", sourceUrl: url,
                                          publishedAtMs: 1, observedVia: "public-feed").safeSourceURL)
        }
    }
}
