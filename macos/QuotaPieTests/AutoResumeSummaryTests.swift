import XCTest
@testable import QuotaPie

final class AutoResumeSummaryTests: XCTestCase {
    private func account(_ id: String = "plus", enabled: Bool = true, scanned: Double? = 100_000,
                         error: String? = nil) -> AutoResumeAccount {
        AutoResumeAccount(account: id, label: id, enabled: enabled, enabledAtMs: 10_000,
                          lastScanAtMs: scanned, lastError: error)
    }
    private func incident(_ account: String = "plus", state: String = "waiting", reason: String? = "quota-recovery-unconfirmed") -> AutoResumeIncident {
        AutoResumeIncident(id: "event", account: account, threadId: "thread", projectLabel: "Project",
                           state: state, reason: reason, detectedAtMs: 80_000, policyId: "policy")
    }
    func testEnabledWithoutAnIncidentDoesNotClaimResumptionOrAskAgain() {
        let value = AutoResumeSummaryPresentation(account: account(), incidents: [], current: true, nowMs: 110_000)
        XCTAssertEqual(value.title, Strings.t("autoResume.summary.monitoring"))
        XCTAssertEqual(value.detail, Strings.t("autoResume.summary.empty"))
        XCTAssertFalse(value.attention)
    }
    func testDisabledAccountOffersAChoiceWithoutUsingAnotherAccountsIncident() {
        let value = AutoResumeSummaryPresentation(account: account(enabled: false), incidents: [incident("other")], current: true, nowMs: 110_000)
        XCTAssertEqual(value.title, Strings.t("autoResume.summary.disabled"))
        XCTAssertEqual(value.detail, Strings.t("autoResume.summary.ask"))
    }
    func testMissingOrFailedScanDoesNotClaimTheAbsenceOfBlockedConversations() {
        for a in [account(scanned: 1), account(error: "scan-unavailable"), account(scanned: 200_000)] {
            let value = AutoResumeSummaryPresentation(account: a, incidents: [], current: true, nowMs: 110_000)
            XCTAssertTrue(value.attention)
            XCTAssertNotEqual(value.detail, Strings.t("autoResume.summary.empty"))
        }
        let value = AutoResumeSummaryPresentation(account: account(), incidents: [incident()], current: false, nowMs: 110_000)
        XCTAssertEqual(value.title, Strings.t("autoResume.summary.unverified"))
    }
    func testQueuedInputIsNotAnActuallyRunningOrCompletedTurn() {
        let pending = incident(state: "queued", reason: "host-queue-awaiting-turn")
        let value = AutoResumeSummaryPresentation(account: account(), incidents: [pending], current: true, nowMs: 110_000)
        XCTAssertEqual(value.title, Strings.t("autoResume.state.queued"))
        XCTAssertTrue(value.detail.contains(Strings.t("autoResume.reason.queued")))
        XCTAssertNotEqual(value.title, Strings.t("autoResume.state.resumed"))
    }
    func testTurningOffDoesNotHideAlreadyAcceptedWork() {
        let value = AutoResumeSummaryPresentation(account: account(enabled: false), incidents: [incident(state: "running", reason: nil)], current: true, nowMs: 110_000)
        XCTAssertEqual(value.title, Strings.t("autoResume.state.running"))
    }
    func testConfirmedCompletionRemainsVisibleWhileWatchingForTheNextInterruption() {
        let value = AutoResumeSummaryPresentation(account: account(), incidents: [incident(state: "resumed", reason: nil)], current: true, nowMs: 110_000)
        XCTAssertEqual(value.title, Strings.t("autoResume.summary.lastResumed"))
        XCTAssertTrue(value.detail.contains("Project"))
    }
}
