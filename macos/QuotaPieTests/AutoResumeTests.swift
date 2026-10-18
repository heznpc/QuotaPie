import Foundation
import XCTest
@testable import QuotaPie

final class AutoResumeTests: XCTestCase {
    private func payload(enabled: Bool = false, nowMs: Double = 100) throws -> StatusPayload {
        let json: [String: Any] = ["nowMs": nowMs, "autoResume": [
            "accounts": [["account": "personal", "label": "Personal", "enabled": enabled]],
            "incidents": ["waiting", "running", "resumed", "skipped", "needs-review", "future-state"].map { state in
                ["id": state, "account": "personal", "threadId": "00000000-0000-4000-8000-000000000001",
                 "projectLabel": "Project", "state": state, "detectedAtMs": 10, "reason": "private arbitrary text"] as [String: Any]
            }
        ]]
        return try JSONDecoder().decode(StatusPayload.self, from: JSONSerialization.data(withJSONObject: json))
    }

    func testOptionalFeatureAndUnknownStatesRemainSafe() throws {
        XCTAssertNil(try JSONDecoder().decode(StatusPayload.self, from: Data("{}".utf8)).autoResume)
        let state = try XCTUnwrap(payload().autoResume)
        XCTAssertFalse(state.accounts[0].enabled)
        XCTAssertNil(state.accounts[0].lastScanAtMs)
        XCTAssertEqual(state.incidents.filter(\.canSkip).map(\.state), ["waiting"])
        XCTAssertEqual(state.incidents[2].stateTitle, Strings.t("autoResume.state.resumed"))
        XCTAssertNotEqual(state.incidents[2].stateTitle, Strings.t("automatic.status.objective-completed"))
        XCTAssertEqual(state.incidents.last?.stateTitle, Strings.t("autoResume.state.unknown"))
        XCTAssertEqual(state.incidents[0].reasonText, Strings.t("autoResume.reason.review"))
        for code in ["account-binding-changed", "arbitrary private error"] {
            let account = AutoResumeAccount(account: "personal", label: "Personal", enabled: true,
                enabledAtMs: nil, lastScanAtMs: nil, lastError: code)
            XCTAssertEqual(account.scanErrorText, Strings.t(code == "account-binding-changed" ? "autoResume.reason.accountChanged" : "autoResume.scanError"))
        }
    }

    func testOlderPollCannotUndoMutationButNewerStatusCan() throws {
        let model = PopoverModel()
        model.payload = try payload()
        model.beginAutoResumeSave()
        model.applyStatus(try payload(enabled: true, nowMs: 101), notificationRevision: 0)
        XCTAssertEqual(model.payload?.autoResume?.accounts[0].enabled, false)
        model.finishAutoResumeSave(try payload(enabled: true).autoResume, nowMs: 110)
        model.applyStatus(try payload(enabled: false, nowMs: 109), notificationRevision: 0)
        XCTAssertEqual(model.payload?.autoResume?.accounts[0].enabled, true)
        model.applyStatus(try payload(enabled: false, nowMs: 111), notificationRevision: 0)
        XCTAssertEqual(model.payload?.autoResume?.accounts[0].enabled, false)
        XCTAssertFalse(model.autoResumeSaving)
    }

    func testAdmissionWaitReasonsDoNotAskForManualReview() {
        for reason in ["reserve-reached", "quota-stale", "quota-unknown", "reset-unconfirmed", "host-goal-stale", "host-goal-unavailable", "ready"] {
            let incident = AutoResumeIncident(id: "fixture", account: "personal", threadId: "thread",
                projectLabel: "Project", state: "waiting", reason: reason, detectedAtMs: 0, policyId: nil)
            if reason == "ready" { XCTAssertNil(incident.reasonText) }
            else {
                XCTAssertEqual(incident.reasonText, Strings.t("autoResume.reason." + (reason.hasPrefix("host-goal-") ? "goal" : "quota")))
            }
        }
    }

    func testHostQueueIsDistinctFromAnActuallyRunningTurn() {
        let incident = AutoResumeIncident(id: "queued", account: "personal", threadId: "thread",
            projectLabel: "Project", state: "queued", reason: "host-queue-awaiting-turn", detectedAtMs: 0, policyId: nil)
        XCTAssertEqual(incident.stateTitle, Strings.t("autoResume.state.queued"))
        XCTAssertNotEqual(incident.stateTitle, Strings.t("autoResume.state.running"))
        XCTAssertEqual(incident.reasonText, Strings.t("autoResume.reason.queued"))
        XCTAssertFalse(incident.canSkip, "Accepted queue input cannot promise atomic cancellation")
    }

    func testAutoResumePolicyCannotEnterTheOrdinaryEditor() throws {
        let regular = AutomaticWorkPolicy.draft(provider: "codex", account: "personal", buckets: ["codex:primary:300"])
        XCTAssertTrue(regular.isUserEditable)
        var input = regular.input
        input["purpose"] = "quota-resume"
        let automatic = try JSONDecoder().decode(AutomaticWorkPolicy.self, from: JSONSerialization.data(withJSONObject: input))
        XCTAssertEqual(automatic.purpose, "quota-resume")
        XCTAssertFalse(automatic.isUserEditable)
        XCTAssertNil(automatic.registrationInput["purpose"], "Ordinary editor requests cannot create automatic-resume authority")
    }

    func testNativeAccountAndSkipActionsUseAuthenticatedContract() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let capture = directory.appendingPathComponent("requests.json")
        let server = Process()
        server.executableURL = URL(fileURLWithPath: "/usr/bin/python3")
        server.arguments = ["-u", "-c", """
        import http.server, json, pathlib, sys
        requests = []
        class Handler(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers['content-length'])))
                requests.append({'path':self.path,'token':self.headers.get('x-quotapie-action-token'),'origin':self.headers.get('origin'),'body':body})
                pathlib.Path(sys.argv[1]).write_text(json.dumps(requests))
                payload = json.dumps({'autoResume':{'accounts':[],'incidents':[]}}).encode()
                self.send_response(200)
                self.send_header('Content-Type','application/json')
                self.send_header('Content-Length',str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
            def log_message(self, *args): pass
        server = http.server.HTTPServer(('127.0.0.1',0), Handler)
        print(server.server_port, flush=True)
        server.serve_forever()
        """, capture.path]
        let output = Pipe()
        server.standardOutput = output; server.standardError = FileHandle.nullDevice
        try server.run()
        defer { if server.isRunning { server.terminate(); server.waitUntilExit() } }
        let port = try XCTUnwrap(String(data: output.fileHandleForReading.availableData, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines))
        let client = try StatusClient(environment: ["QUOTAPIE_API_URL": "http://127.0.0.1:\(port)"])
        for enabled in [true, false] {
            let completed = expectation(description: "toggle")
            client.setAutoResumeEnabled(account: "personal", enabled: enabled, actionToken: "fixture-token") { result in
                if case .failure(let error) = result { XCTFail(error.localizedDescription) }
                completed.fulfill()
            }
            wait(for: [completed], timeout: 5)
        }
        let skipped = expectation(description: "skip")
        client.skipAutoResume(id: "waiting-id", actionToken: "fixture-token") { result in
            if case .failure(let error) = result { XCTFail(error.localizedDescription) }
            skipped.fulfill()
        }
        wait(for: [skipped], timeout: 5)
        let requests = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: capture)) as? [[String: Any]])
        XCTAssertEqual(requests.count, 3)
        for request in requests {
            XCTAssertEqual(request["path"] as? String, "/api/auto-resume")
            XCTAssertEqual(request["token"] as? String, "fixture-token")
            XCTAssertTrue(request["origin"] is NSNull)
        }
        let bodies = try requests.map { try XCTUnwrap($0["body"] as? [String: Any]) }
        XCTAssertEqual(bodies[0]["action"] as? String, "enabled")
        XCTAssertEqual(bodies[0]["account"] as? String, "personal")
        XCTAssertEqual(bodies[0]["enabled"] as? Bool, true)
        XCTAssertEqual(bodies[1]["enabled"] as? Bool, false)
        XCTAssertEqual(bodies[2] as NSDictionary, ["action": "skip", "id": "waiting-id"] as NSDictionary)
        let rejected = expectation(description: "missing-token")
        client.setAutoResumeEnabled(account: "personal", enabled: true, actionToken: "") { result in
            if case .success = result { XCTFail("An unauthenticated toggle must not be sent") }
            rejected.fulfill()
        }
        wait(for: [rejected], timeout: 1)
    }
}
