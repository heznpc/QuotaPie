import Foundation
import XCTest
@testable import QuotaPie

final class AutomaticWorkTests: XCTestCase {
    func testEditingPreservesSharedPolicyAndExcludesRuntimeAuthority() throws {
        var policy = AutomaticWorkPolicy.draft(provider: "claude", account: "personal", buckets: ["five_hour", "seven_day"])
        policy.model = "original-session-model"
        policy.nativeSessionId = "session-1"
        policy.budgetByBucket["five_hour"] = AutomaticWorkBudget(reservePercent: 0, maxUsagePercent: 90, targetUsagePercent: 80)
        policy.activitySchedule = AutomaticWorkSchedule(timeZone: "Asia/Seoul", days: [0,6], start: "22:00", end: "06:00")
        policy.onReset = "continue"
        policy.workDeadline = 1_900_000_000_000
        policy.dispatchOwner = "dots"
        policy.revision = 9
        policy.maxTotalDurationSeconds = 7200
        let input = policy.input
        let encoded = try JSONSerialization.data(withJSONObject: input)
        let reread = try JSONDecoder().decode(AutomaticWorkPolicy.self, from: encoded)
        XCTAssertEqual(reread.budgetByBucket["five_hour"]?.reservePercent, 0)
        XCTAssertEqual(reread.budgetByBucket["five_hour"]?.targetUsagePercent, 80)
        XCTAssertEqual(reread.activitySchedule?.days, [0,6])
        XCTAssertEqual(reread.activitySchedule?.start, "22:00")
        XCTAssertEqual(reread.activitySchedule?.timeZone, "Asia/Seoul")
        XCTAssertEqual(reread.maxTotalDurationSeconds, 7200)
        XCTAssertEqual(reread.workDeadline, policy.workDeadline)
        XCTAssertEqual(reread.dispatchOwner, "dots")
        XCTAssertEqual(reread.onReset, "continue")
        XCTAssertNil(input["revision"])
        XCTAssertNil(input["state"])
        XCTAssertNil(input["accountKey"])
        XCTAssertNil(input["profileKey"])
        XCTAssertNil(input["cwd"])
        XCTAssertNil(input["model"], "The app cannot override the original conversation model")
    }

    func testWorkClientKeepsAuthenticationAndRevisionErrorsDistinct() throws {
        let server = Process()
        server.executableURL = URL(fileURLWithPath: "/usr/bin/python3")
        server.arguments = ["-u", "-c", """
        import http.server, json
        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                code = self.headers.get('x-quotapie-action-token')
                payload = json.dumps({'error': code}).encode()
                self.send_response(409)
                self.send_header('Content-Length', str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
            def log_message(self, *args): pass
        server = http.server.HTTPServer(('127.0.0.1', 0), Handler)
        print(server.server_port, flush=True)
        server.serve_forever()
        """]
        let output = Pipe()
        server.standardOutput = output
        server.standardError = FileHandle.nullDevice
        try server.run()
        defer { if server.isRunning { server.terminate(); server.waitUntilExit() } }
        let port = try XCTUnwrap(String(data: output.fileHandleForReading.availableData, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines))
        let client = try StatusClient(environment: ["QUOTAPIE_API_URL": "http://127.0.0.1:\(port)"])
        for code in ["claude-auth-required", "work-revision-conflict"] {
            let received = expectation(description: code)
            client.automaticWork(actionToken: code) { result in
                switch result {
                case .success: XCTFail("Expected an HTTP error")
                case .failure(let error):
                    guard let workError = error as? AutomaticWorkError else { XCTFail("Lost work error code"); received.fulfill(); return }
                    XCTAssertEqual(workError.code, code)
                    XCTAssertEqual(workError.status, 409)
                    XCTAssertEqual(workError.localizedDescription, Strings.t(code == "work-revision-conflict" ? "automatic.conflict" : "automatic.reason.login"))
                }
                received.fulfill()
            }
            wait(for: [received], timeout: 5)
        }
    }

    func testAdmissionReasonsRemainVisibleAndUnsafeErrorDetailsAreNotDisplayed() throws {
        let admission = try JSONDecoder().decode(AutomaticWorkAdmission.self, from: Data(#"{"ready":false,"reason":"claude-auth-required"}"#.utf8))
        XCTAssertFalse(admission.ready)
        XCTAssertEqual(AutomaticWorkReason.text(admission.reason), Strings.t("automatic.reason.login"))
        XCTAssertEqual(AutomaticWorkReason.text("new-preflight-hold"), Strings.t("automatic.reason.other", "new-preflight-hold"))
        let failure = AutomaticWorkError(data: Data(#"{"error":"sensitive arbitrary server details"}"#.utf8), status: 500)
        XCTAssertEqual(failure.code, "work-action-failed")
    }

    func testNewPolicyUsesExistingAccountReserveIncludingZero() {
        let policy = AutomaticWorkPolicy.draft(provider: "claude", account: "personal", buckets: ["five_hour", "seven_day"], reserveByBucket: ["five_hour": 0, "seven_day": 35])
        XCTAssertEqual(policy.budgetByBucket["five_hour"]?.reservePercent, 0)
        XCTAssertEqual(policy.budgetByBucket["seven_day"]?.reservePercent, 35)
    }

    func testNewPolicyDoesNotActivateOrInventQuotaWindows() {
        let policy = AutomaticWorkPolicy.draft(provider: "claude", account: "personal", buckets: [])
        XCTAssertFalse(policy.enabled)
        XCTAssertTrue(policy.budgetByBucket.isEmpty)
        XCTAssertNil(policy.activitySchedule, "A schedule must not silently disable overnight work")
        XCTAssertNil(policy.revision)
    }
}
