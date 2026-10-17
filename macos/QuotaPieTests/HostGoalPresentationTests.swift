import Foundation
import XCTest
@testable import QuotaPie

final class HostGoalPresentationTests: XCTestCase {
    private let taskID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
    private let now: Double = 1_800_000_000_000

    func testUnlinkedGoalsDifferFromAnOlderService() throws {
        XCTAssertNil(try payload([:]).hostGoals)
        XCTAssertEqual(try payload(["hostGoals": ["items": []]]).hostGoals?.items.count, 0)
    }

    func testHostCompletionDoesNotChangeLocalResumeState() throws {
        let goal = try item(["hostStatus": "complete", "resumeState": "waiting"])
        XCTAssertEqual(goal.hostStatusTitle, Strings.t("goals.host.complete"))
        XCTAssertEqual(goal.resumeStatusTitle(at: now, transportUnavailable: false), Strings.t("goals.resume.waiting"))
    }

    func testExpiredOrDisconnectedGoalNeverAdvertisesReadiness() throws {
        let goal = try item()
        for (time, unavailable) in [(now + 60_000, false), (now, true)] {
            XCTAssertEqual(goal.displayReadState(at: time, transportUnavailable: unavailable), "stale")
            XCTAssertEqual(goal.resumeStatusTitle(at: time, transportUnavailable: unavailable), Strings.t("goals.resume.unknown"))
            XCTAssertFalse(goal.canReview([try task()], at: time, transportUnavailable: unavailable))
            XCTAssertEqual(goal.visibleObjective(at: time, transportUnavailable: unavailable), "Verify the change")
        }
    }

    func testMissingFreshnessCannotBecomeReady() throws {
        for changes: [String: Any] in [["expiresAtMs": NSNull()], ["observedAtMs": NSNull()], ["observedAtMs": now + 1]] {
            let goal = try item(changes)
            XCTAssertEqual(goal.displayReadState(at: now, transportUnavailable: false), "stale")
            XCTAssertFalse(goal.canReview([try task()], at: now, transportUnavailable: false))
        }
    }

    func testAccountChangeHidesPreviouslyObservedGoalEvenOffline() throws {
        let goal = try item(["readState": "account_changed"])
        XCTAssertNil(goal.visibleObjective(at: now, transportUnavailable: false))
        XCTAssertNil(goal.visibleObjective(at: now, transportUnavailable: true))
        XCTAssertFalse(goal.canReview([try task()], at: now, transportUnavailable: false))
    }

    func testNoGoalAndUnsupportedDoNotHideTheLinkedLocalWork() throws {
        for state in ["no_goal", "unsupported"] {
            let goal = try item(["readState": state])
            XCTAssertEqual(goal.displayReadState(at: now, transportUnavailable: false), state)
            XCTAssertEqual(goal.resumeStatusTitle(at: now, transportUnavailable: false), Strings.t("goals.resume.reviewInWork"))
            XCTAssertTrue(goal.canReview([try task()], at: now, transportUnavailable: false))
            XCTAssertNil(goal.visibleObjective(at: now, transportUnavailable: false))
            for resumeState in ["waiting", "approved", "resumed", "dismissed"] {
                let local = try item(["readState": state, "resumeState": resumeState])
                XCTAssertEqual(local.resumeStatusTitle(at: now, transportUnavailable: false), Strings.t("goals.resume." + resumeState))
            }
        }
    }

    func testErrorAndUnknownDoNotPretendToBeReady() throws {
        for state in ["error", "future-state"] {
            let goal = try item(["readState": state])
            XCTAssertEqual(goal.displayReadState(at: now, transportUnavailable: false), state == "future-state" ? "unknown" : state)
            XCTAssertEqual(goal.resumeStatusTitle(at: now, transportUnavailable: false), Strings.t("goals.resume.unknown"))
            XCTAssertFalse(goal.canReview([try task()], at: now, transportUnavailable: false))
        }
        XCTAssertEqual(try item(["hostStatus": "future-status"]).displayReadState(at: now, transportUnavailable: false), "unknown")
    }

    func testReviewOnlyLinksTheSameRegisteredAccountAndSession() throws {
        let goal = try item()
        XCTAssertTrue(goal.canReview([try task()], at: now, transportUnavailable: false))
        XCTAssertFalse(goal.canReview([try task(account: "other")], at: now, transportUnavailable: false))
        XCTAssertFalse(goal.canReview([], at: now, transportUnavailable: false))
        XCTAssertFalse(try item(["resumeState": "resumed"]).canReview([try task()], at: now, transportUnavailable: false))
        XCTAssertFalse(try item(["taskId": "../session"]).canReview([try task()], at: now, transportUnavailable: false))
    }

    private func item(_ changes: [String: Any] = [:]) throws -> HostGoalLinkSummary {
        let base: [String: Any] = [
            "id": taskID, "taskId": taskID, "provider": "codex", "account": "default", "accountLabel": "Main",
            "projectLabel": "QuotaPie", "readState": "ready", "objective": "Verify the change", "hostStatus": "active",
            "observedAtMs": now - 1_000, "expiresAtMs": now + 60_000, "resumeState": "ready",
        ]
        return try JSONDecoder().decode(HostGoalLinkSummary.self, from: JSONSerialization.data(withJSONObject: base.merging(changes) { _, new in new }))
    }

    private func task(account: String = "default") throws -> ResumeTask {
        try JSONDecoder().decode(ResumeTask.self, from: JSONSerialization.data(withJSONObject: [
            "id": taskID, "provider": "codex", "account": account, "accountLabel": "Main", "projectLabel": "QuotaPie",
            "state": "ready", "registeredAtMs": now - 1_000,
        ] as [String: Any]))
    }

    private func payload(_ value: [String: Any]) throws -> StatusPayload {
        try JSONDecoder().decode(StatusPayload.self, from: JSONSerialization.data(withJSONObject: value))
    }
}
