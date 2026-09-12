import Foundation
import XCTest
@testable import QuotaPie

final class RecoveryTests: XCTestCase {
    func testSavedRecoverySurvivesRefreshAndRestartWithoutRecentEventOrLiveCollection() throws {
        // A subsequent usage sample and ordinary events must not erase a refill.
        let payload = try recoveryPayload()
        let model = PopoverModel()
        model.payload = payload
        XCTAssertTrue(payload.events.isEmpty)
        XCTAssertEqual(model.selectedRecovery?.evidence.remainingBefore, 10)
        XCTAssertEqual(model.selectedRecovery?.evidence.remainingAfter, 100)
        XCTAssertEqual(model.selectedRecovery?.label, Strings.t("window.weekly"))
        model.lastError = "offline"
        model.payload = try recoveryPayload(state: "unavailable")
        XCTAssertEqual(model.selectedRecovery?.evidence.eventId, 1230)
        let restarted = PopoverModel()
        restarted.payload = try recoveryPayload(state: "unavailable")
        XCTAssertEqual(restarted.selectedRecovery?.evidence.eventId, 1230)

        model.selectedAccountID = "claude/work"
        XCTAssertNil(model.selectedRecovery)
        XCTAssertEqual(model.recentRecoveries.count, 1)
        model.selectedAccountID = "codex/default"
        XCTAssertNotNil(model.selectedRecovery)

        // The server removes evidence after its 24-hour overview lookback.
        model.payload = try JSONDecoder().decode(StatusPayload.self, from: Data("{}".utf8))
        XCTAssertNil(model.selectedRecovery)
    }

    func testUncertainAccountOrWindowChangesAreNotShownAsConfirmedRecovery() throws {
        for reason in ["source-changed", "window-changed", "observation-gap", "insufficient-evidence", "unknown"] {
            let model = PopoverModel()
            model.payload = try recoveryPayload(reason: reason)
            XCTAssertNil(model.selectedRecovery, reason)
        }
    }

    private func recoveryPayload(state: String = "recovery-observed", reason: String = "no-public-match") throws -> StatusPayload {
        let json = """
        {"events":[],"accounts":[
          {"provider":"codex","account":"default","accountLabel":"Main","enabled":true,
           "collection":{"health":"recent-success"},"windows":[
             {"provider":"codex","account":"default","bucket":"weekly","label":"Codex weekly",
              "windowSeconds":604800,"freshness":"fresh","observedAtMs":300,"remainingPercent":90}]},
          {"provider":"claude","account":"work","accountLabel":"Work","enabled":true,
           "collection":{"health":"recent-success"},"windows":[]}],
         "resetTracking":{"lookbackMs":86400000,"accounts":[
           {"provider":"codex","account":"default","windows":[
             {"bucket":"weekly","label":"Codex weekly","state":"\(state)",
              "recovery":{"eventId":1230,"observedAfterMs":100,"observedByMs":200,
                "remainingBefore":10,"remainingAfter":100,"reason":"\(reason)","candidates":[]}}]}]}}
        """
        return try JSONDecoder().decode(StatusPayload.self, from: Data(json.utf8))
    }

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
