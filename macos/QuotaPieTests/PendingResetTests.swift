import XCTest
@testable import QuotaPie

final class PendingResetTests: XCTestCase {
    private let now = 1_800_000_000_000.0
    private func post(_ id: String, state: String = "announced", age: Double = 1000,
                      group: String = "event", provider: String = "codex", benefit: String = "reset",
                      target: Double? = nil, kind: String = "direct") -> ResetSignal {
        var value = ResetSignal(id: id, fingerprint: id, author: "openai", sourceUrl: "https://x.com/openai/status/1",
            text: "Fixture", publishedAtMs: now - age, state: state, resetKind: kind,
            timeHint: nil, scopeHint: nil, observedVia: "x-api", targetAtMs: target)
        value.groupId = group; value.provider = provider; value.benefitKind = benefit
        return value
    }
    private func pending(_ posts: [ResetSignal]) -> [String] {
        ResetSignalPayload(enabled: true, source: "multiple", state: "ready", lastSuccessMs: now,
            error: nil, signals: posts).pendingResets(nowMs: now).map(\.id)
    }
    func testNewBenefitNewsDoesNotDisplacePendingReset() {
        XCTAssertEqual(pending([post("reset"), post("limits", state: "reported", age: 0, benefit: "limits")]), ["reset"])
    }
    func testFollowupReplacesPromiseAndTerminalPostClosesOnlyItsOwnProviderAndGroup() {
        let original = post("original", age: 3000)
        let update = post("update", state: "updated", age: 2000)
        XCTAssertEqual(pending([original, update]), ["update"])
        for state in ["reported", "withdrawn"] {
            XCTAssertEqual(pending([original, update, post("end", state: state)]), [])
            XCTAssertEqual(pending([original, post("other", state: state, provider: "claude")]), ["original"])
            XCTAssertEqual(pending([original, post("other", state: state, group: "unrelated")]), ["original"])
        }
    }
    func testBothProvidersRemainVisibleAndUntimedNoticesHaveAnExplicitDisplayHorizon() {
        XCTAssertEqual(pending([post("codex"), post("claude", age: 2000, provider: "claude")]), ["codex", "claude"])
        XCTAssertEqual(pending([post("old", age: 48 * 3_600_000 + 1)]), [])
        XCTAssertEqual(pending([post("future", age: -1)]), [])
        XCTAssertEqual(pending([post("scheduled", age: 72 * 3_600_000, target: now + 1000)]), ["scheduled"])
        XCTAssertEqual(pending([post("elapsed", target: now - 24 * 3_600_000 - 1)]), [])
    }
    func testBankedResetAndFutureCompletionCannotDismissPendingImmediateReset() {
        let banked = post("credit", state: "reported", age: 0, kind: "banked")
        XCTAssertEqual(pending([post("reset"), banked, post("future", state: "reported", age: -1)]), ["reset"])
    }
}
