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

    func testCompletedLocalRepairSupersedesOnlyItsOwnFailedAttemptInSummary() {
        var parent = incident(state: "needs-review", reason: "host-queue-turn-failed")
        parent.localRepairChildIncidentId = "repair"
        parent.localRepairReason = "local-before-send-repair-linked"
        var child = AutoResumeIncident(id: "repair", account: "plus", threadId: "thread", projectLabel: "Project",
            state: "resumed", reason: nil, detectedAtMs: 90_000, policyId: "repair")
        child.localRepairParentIncidentId = parent.id
        child.repairReason = "local-before-send-repair"
        XCTAssertEqual(parent.state, "needs-review", "Keep the original failed attempt in detailed history")
        XCTAssertEqual(parent.displayedReason(in: [parent, child]), Strings.t("autoResume.repair.localFailure"))
        XCTAssertNotNil(parent.repairText(in: [parent, child]))
        XCTAssertNotNil(child.repairText(in: [parent, child]))
        let repaired = AutoResumeSummaryPresentation(account: account(), incidents: [parent, child], current: true, nowMs: 110_000)
        XCTAssertEqual(repaired.title, Strings.t("autoResume.summary.lastResumed"))
        XCTAssertFalse(repaired.attention)
        child.localRepairParentIncidentId = "unrelated"
        let unrelated = AutoResumeSummaryPresentation(account: account(), incidents: [parent, child], current: true, nowMs: 110_000)
        XCTAssertEqual(unrelated.title, Strings.t("autoResume.state.needs-review"))
        XCTAssertTrue(unrelated.attention)
        let missing = AutoResumeSummaryPresentation(account: account(), incidents: [parent], current: true, nowMs: 110_000)
        XCTAssertEqual(missing.title, Strings.t("autoResume.state.needs-review"))
        child.localRepairParentIncidentId = parent.id
        child.repairReason = nil
        XCTAssertNil(parent.linkedRepair(in: [parent, child]))
        child.repairReason = "local-before-send-repair"
        child.localRepairChildIncidentId = parent.id
        XCTAssertNil(parent.linkedRepair(in: [parent, child]), "A cycle is not a verified repair")
        parent.localRepairChildIncidentId = parent.id
        parent.localRepairParentIncidentId = parent.id
        parent.repairReason = "local-before-send-repair"
        XCTAssertNil(parent.linkedRepair(in: [parent]))
    }
    func testTwoRepairsResolveOnlyWithinTheBoundedReciprocalConversationChain() {
        var parent = incident(state: "needs-review", reason: "host-queue-turn-failed")
        parent.localRepairChildIncidentId = "child"; parent.localRepairReason = "local-before-send-repair-linked"
        var child = AutoResumeIncident(id: "child", account: "plus", threadId: "thread", projectLabel: "Project",
            state: "needs-review", reason: "host-queue-turn-failed", detectedAtMs: 90_000, policyId: "child")
        child.localRepairParentIncidentId = parent.id; child.repairReason = "local-before-send-repair"
        child.localRepairChildIncidentId = "grandchild"; child.localRepairReason = "local-before-send-repair-linked"
        var grandchild = AutoResumeIncident(id: "grandchild", account: "plus", threadId: "thread", projectLabel: "Project",
            state: "resumed", reason: nil, detectedAtMs: 95_000, policyId: "grandchild")
        grandchild.localRepairParentIncidentId = child.id; grandchild.repairReason = "local-before-send-repair"
        let history = [parent, child, grandchild]
        XCTAssertEqual(parent.linkedRepair(in: history)?.id, child.id)
        XCTAssertEqual(child.linkedRepair(in: history)?.id, grandchild.id)
        let summary = AutoResumeSummaryPresentation(account: account(), incidents: history, current: true, nowMs: 110_000)
        XCTAssertEqual(summary.title, Strings.t("autoResume.summary.lastResumed")); XCTAssertFalse(summary.attention)
        grandchild.localRepairChildIncidentId = parent.id
        XCTAssertNil(parent.linkedRepair(in: [parent, child, grandchild]))
        grandchild.localRepairChildIncidentId = "missing"
        XCTAssertNil(child.linkedRepair(in: [parent, child, grandchild]))
    }

}
