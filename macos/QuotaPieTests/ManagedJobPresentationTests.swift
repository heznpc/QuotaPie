import Foundation
import XCTest
@testable import QuotaPie

final class ManagedJobPresentationTests: XCTestCase {
    func testOlderStatusPayloadsDoNotInventExecutionJobs() throws {
        for source in ["{}", "{\"jobs\":null}", "{\"jobs\":[]}"] {
            let payload = try JSONDecoder().decode(StatusPayload.self, from: Data(source.utf8))
            XCTAssertTrue(payload.jobs.isEmpty)
        }
    }

    func testPublicJobSummaryDecodesWithoutPrivateExecutionMaterial() throws {
        let payload = try JSONDecoder().decode(StatusPayload.self, from: Data(#"""
        {"jobs":[{"id":"job-1","key":"verify","label":"Verification",
          "provider":"codex","account":"work","state":"running",
          "completedSteps":1,"totalSteps":3,"attemptCount":2,"reason":null,
          "updatedAtMs":1000,"policy":{"mode":"auto"}}]}
        """#.utf8))
        let job = try XCTUnwrap(payload.jobs.first)
        XCTAssertEqual(job.label, "Verification")
        XCTAssertEqual(job.providerTitle, "Codex")
        XCTAssertEqual(job.account, "work")
        XCTAssertEqual(job.progressTitle, Strings.t("jobs.progress", "1", "3"))
        XCTAssertEqual(job.stateTitle, Strings.t("jobs.state.running"))
        XCTAssertEqual(job.policyTitle, Strings.t("jobs.policy.auto"))
        XCTAssertNil(job.reasonTitle)
    }

    func testFutureStatesAndReasonsStayUnconfirmedWithoutLeakingMachineCodes() throws {
        let job = try summary(state: "future-state", mode: "future-policy", reason: "internal-error-code")
        XCTAssertEqual(job.stateTitle, Strings.t("jobs.unknown"))
        XCTAssertEqual(job.policyTitle, Strings.t("jobs.unknown"))
        XCTAssertEqual(job.reasonTitle, Strings.t("jobs.reason.unknown"))
        XCTAssertFalse(job.reasonTitle?.contains("internal-error-code") ?? true)
    }

    func testWaitingAndUncertainResultsHaveDifferentExplanations() throws {
        let waiting = try summary(state: "waiting", reason: "quota-collection-wait")
        let quota = try summary(state: "waiting", reason: "quota-wait")
        let uncertain = try summary(state: "review", reason: "execution-uncertain")
        XCTAssertEqual(waiting.reasonTitle, Strings.t("jobs.reason.collection"))
        XCTAssertEqual(quota.reasonTitle, Strings.t("jobs.reason.quota"))
        XCTAssertEqual(uncertain.reasonTitle, Strings.t("jobs.reason.uncertain"))
        XCTAssertNotEqual(waiting.reasonTitle, quota.reasonTitle)
        XCTAssertNotEqual(uncertain.stateTitle, Strings.t("jobs.state.succeeded"))
        XCTAssertEqual(waiting.policyTitle, Strings.t("jobs.policy.manual"))
    }

    func testJobNotificationsRenderInNativeLocale() throws {
        let title = try JSONDecoder().decode(LocalizedMessagePayload.self, from: Data(#"""
        {"key":"alert.jobs.title","params":{"label":"Verification"}}
        """#.utf8))
        XCTAssertEqual(title.rendered(fallback: "backend fallback"), Strings.t("alert.jobs.title", "Verification"))
        for state in ["ready", "succeeded", "failed", "review"] {
            let key = "alert.jobs.\(state).message"
            let data = try JSONSerialization.data(withJSONObject: ["key": key, "params": [:]] as [String: Any])
            let message = try JSONDecoder().decode(LocalizedMessagePayload.self, from: data)
            XCTAssertEqual(message.rendered(fallback: "backend fallback"), Strings.t(key))
            XCTAssertNotEqual(message.rendered(fallback: "backend fallback"), key)
        }
    }

    func testExpiredLeaseDoesNotClaimFailureOrSuccessfulCompletion() throws {
        let job = try summary(state: "review", reason: "lease-expired")
        XCTAssertEqual(job.stateTitle, Strings.t("jobs.state.review"))
        XCTAssertEqual(job.reasonTitle, Strings.t("jobs.reason.uncertain"))
        let policy = try summary(state: "review", reason: "policy-expired")
        XCTAssertEqual(policy.reasonTitle, Strings.t("jobs.reason.expired"))
        let attempts = try summary(state: "review", reason: "attempts-exhausted")
        XCTAssertEqual(attempts.reasonTitle, Strings.t("jobs.reason.attempts"))
    }

    private func summary(state: String, mode: String = "manual", reason: String? = nil) throws -> ManagedJobSummary {
        var fields: [String: Any] = [
            "id": "job-1", "label": "Verification", "provider": "claude", "account": "default",
            "state": state, "completedSteps": 0, "totalSteps": 2, "policy": ["mode": mode],
        ]
        if let reason { fields["reason"] = reason }
        return try JSONDecoder().decode(ManagedJobSummary.self, from: JSONSerialization.data(withJSONObject: fields))
    }
}
