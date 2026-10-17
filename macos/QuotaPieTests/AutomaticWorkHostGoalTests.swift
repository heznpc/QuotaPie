import Foundation
import XCTest
@testable import QuotaPie

final class AutomaticWorkHostGoalTests: XCTestCase {
    private let now: Double = 1_900_000_000_000

    func testConversationChoicesDistinguishSameProjectAndUUIDPrefix() throws {
        let one = AutomaticWorkTarget(nativeSessionId: "00000000-0000-4000-8000-000000000001", title: "Time", cwd: "/fixture/Time", model: nil, lastActiveAtMs: now - 300_000)
        let two = AutomaticWorkTarget(nativeSessionId: "00000000-0000-4000-8000-000000000002", title: "Time", cwd: "/fixture/Time", model: nil, lastActiveAtMs: now - 300_000)
        let date = Date(timeIntervalSince1970: now / 1_000)
        XCTAssertNotEqual(one.selectionTitle(at: date), two.selectionTitle(at: date))
        XCTAssertTrue(one.selectionTitle(at: date).contains(Strings.t("time.minutesAgo", "5")))
        XCTAssertTrue(one.selectionTitle(at: date).hasSuffix("…00000001"))
        let legacy = try JSONDecoder().decode(AutomaticWorkTarget.self, from: Data(#"{"nativeSessionId":"00000000-0000-4000-8000-000000000001","title":"Time","cwd":"/fixture/Time"}"#.utf8))
        XCTAssertEqual(legacy.selectionTitle(at: date), "Time · …00000001")
    }

    private func observation(_ state: String = "ready", status: String = "active", expires: Double? = nil) -> AutomaticWorkHostGoal {
        AutomaticWorkHostGoal(readState: state, objective: "Finish the existing goal", hostStatus: status,
                              observedAtMs: now - 1_000, expiresAtMs: expires ?? now + 60_000)
    }

    func testExpiredOrUnavailableObservationCannotBeUsedAsNewWorkObjective() {
        let current = observation()
        XCTAssertTrue(current.canUseObjective(at: now, transportUnavailable: false))
        XCTAssertFalse(current.canUseObjective(at: now, transportUnavailable: true))
        let expired = observation(expires: now)
        XCTAssertEqual(expired.displayReadState(at: now, transportUnavailable: false), "stale")
        XCTAssertFalse(expired.canUseObjective(at: now, transportUnavailable: false))
        XCTAssertEqual(expired.visibleObjective(at: now, transportUnavailable: false), current.objective,
                       "An old observation remains distinguishable from a fresh goal")
        let changed = observation("account_changed")
        XCTAssertNil(changed.visibleObjective(at: now, transportUnavailable: false))
        XCTAssertEqual(changed.displayReadState(at: now, transportUnavailable: true), "account_changed")
        XCTAssertFalse(changed.canUseObjective(at: now, transportUnavailable: false))
    }

    func testNoGoalUnsupportedAndMalformedFreshnessRemainDistinct() {
        for state in ["no_goal", "unsupported", "error"] {
            let goal = observation(state)
            XCTAssertEqual(goal.displayReadState(at: now, transportUnavailable: false), state)
            XCTAssertFalse(goal.canUseObjective(at: now, transportUnavailable: false))
        }
        let future = AutomaticWorkHostGoal(readState: "ready", objective: "Goal", hostStatus: "active",
                                           observedAtMs: now + 1, expiresAtMs: now + 60_000)
        XCTAssertEqual(future.displayReadState(at: now, transportUnavailable: false), "stale")
        XCTAssertEqual(observation(status: "invented").displayReadState(at: now, transportUnavailable: false), "unknown")
    }

    func testHostCompleteDoesNotBecomeRunnerCompletionOrEditableAuthority() throws {
        var input = AutomaticWorkPolicy.draft(provider: "codex", account: "personal", buckets: ["five_hour"]).input
        input["hostGoal"] = ["readState": "ready", "objective": "Observed host objective", "hostStatus": "complete",
                             "observedAtMs": now - 1_000, "expiresAtMs": now + 60_000]
        input["state"] = ["spentByBucket": [:], "turns": 0, "totalDurationSeconds": 0, "status": "waiting"] as [String: Any]
        let policy = try JSONDecoder().decode(AutomaticWorkPolicy.self, from: JSONSerialization.data(withJSONObject: input))
        XCTAssertEqual(policy.hostGoal?.hostStatus, "complete")
        XCTAssertEqual(policy.state?.status, "waiting")
        XCTAssertEqual(policy.objective, "")
        XCTAssertNil(policy.registrationInput["hostGoal"])
        XCTAssertNil(policy.registrationInput["state"])
        XCTAssertEqual(AutomaticWorkReason.text("host-goal-complete"), Strings.t("automatic.goal.reason.complete"))
        XCTAssertEqual(AutomaticWorkReason.text("host-goal-objective-changed"), Strings.t("automatic.goal.reason.changed"))
    }

    func testClientUsesSelectedSessionAndExplicitRevisionBoundLinkIntent() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let capture = directory.appendingPathComponent("requests.json")
        let server = Process()
        server.executableURL = URL(fileURLWithPath: "/usr/bin/python3")
        server.arguments = ["-u", "-c", """
        import http.server, json, pathlib, sys
        requests = []
        goal = {'readState':'ready','objective':'Host goal','hostStatus':'active','observedAtMs':1900000000000,'expiresAtMs':1900000060000}
        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self): self.respond(None)
            def do_POST(self): self.respond(json.loads(self.rfile.read(int(self.headers['content-length']))))
            def respond(self, body):
                requests.append({'method':self.command,'path':self.path,'token':self.headers.get('x-quotapie-action-token'),'body':body})
                pathlib.Path(sys.argv[1]).write_text(json.dumps(requests))
                result = {'policy':body['policy']} if body and body.get('action') == 'save' else {'hostGoal':None if body and body.get('action') == 'unlink' else goal}
                payload = json.dumps(result).encode()
                self.send_response(200)
                self.send_header('Content-Type','application/json')
                self.send_header('Content-Length',str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
            def log_message(self, *args): pass
        server = http.server.HTTPServer(('127.0.0.1',0),Handler)
        print(server.server_port, flush=True)
        server.serve_forever()
        """, capture.path]
        let output = Pipe()
        server.standardOutput = output
        server.standardError = FileHandle.nullDevice
        try server.run()
        defer { if server.isRunning { server.terminate(); server.waitUntilExit() } }
        let port = try XCTUnwrap(String(data: output.fileHandleForReading.availableData, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines))
        let client = try StatusClient(environment: ["QUOTAPIE_API_URL": "http://127.0.0.1:\(port)"])
        let session = "00000000-0000-4000-8000-000000000001"
        let preview = expectation(description: "preview")
        client.automaticWorkHostGoal(provider: "codex", account: "personal", session: session, actionToken: "fixture-token") { result in
            switch result {
            case .success(let response): XCTAssertEqual(response.hostGoal?.objective, "Host goal")
            case .failure(let error): XCTFail(error.localizedDescription)
            }
            preview.fulfill()
        }
        wait(for: [preview], timeout: 5)
        for action in ["link", "refresh", "unlink"] {
            let received = expectation(description: action)
            client.updateAutomaticWorkHostGoal(id: "policy-id", revision: 7, action: action,
                                               reviewedObjective: action == "link" ? "The goal the user reviewed" : nil,
                                               actionToken: "fixture-token") { result in
                switch result {
                case .success(let response): XCTAssertEqual(response.hostGoal == nil, action == "unlink")
                case .failure(let error): XCTFail(error.localizedDescription)
                }
                received.fulfill()
            }
            wait(for: [received], timeout: 5)
        }
        var policy = AutomaticWorkPolicy.draft(provider: "codex", account: "personal", buckets: ["five_hour"])
        policy.nativeSessionId = session
        policy.revision = 7
        policy.hostGoal = observation()
        let intents: [Bool?] = [nil, true, false]
        for intent in intents {
            let saved = expectation(description: "save")
            client.saveAutomaticWork(policy, hostGoalLinked: intent,
                                     reviewedObjective: intent == true ? "The goal the user reviewed" : nil,
                                     actionToken: "fixture-token") { result in
                if case .failure(let error) = result { XCTFail(error.localizedDescription) }
                saved.fulfill()
            }
            wait(for: [saved], timeout: 5)
        }
        let requests = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: capture)) as? [[String: Any]])
        XCTAssertEqual(requests.count, 7)
        let url = try XCTUnwrap(URLComponents(string: "http://localhost" + (requests[0]["path"] as? String ?? "")))
        let query = Dictionary(uniqueKeysWithValues: (url.queryItems ?? []).map { ($0.name, $0.value ?? "") })
        XCTAssertEqual(url.path, "/api/work/host-goal")
        XCTAssertEqual(query, ["provider": "codex", "account": "personal", "session": session])
        XCTAssertEqual(requests[0]["method"] as? String, "GET")
        for (index, action) in ["link", "refresh", "unlink"].enumerated() {
            let request = requests[index + 1]
            let body = try XCTUnwrap(request["body"] as? [String: Any])
            XCTAssertEqual(request["method"] as? String, "POST")
            XCTAssertEqual(request["path"] as? String, "/api/work/host-goal")
            XCTAssertEqual(body["id"] as? String, "policy-id")
            XCTAssertEqual(body["expectedRevision"] as? Int, 7)
            XCTAssertEqual(body["action"] as? String, action)
            XCTAssertEqual(body["reviewedObjective"] as? String, action == "link" ? "The goal the user reviewed" : nil)
            XCTAssertNil(body["session"], "Existing links use the server's saved session identity")
        }
        let savedBodies = try requests.suffix(3).map { try XCTUnwrap($0["body"] as? [String: Any]) }
        XCTAssertNil(savedBodies[0]["hostGoalLinked"], "Ordinary edits must preserve the existing goal baseline")
        XCTAssertEqual(savedBodies[1]["hostGoalLinked"] as? Bool, true)
        XCTAssertEqual(savedBodies[2]["hostGoalLinked"] as? Bool, false)
        XCTAssertNil(savedBodies[0]["reviewedObjective"])
        XCTAssertEqual(savedBodies[1]["reviewedObjective"] as? String, "The goal the user reviewed",
                       "The explicit review must survive a newer observation before save")
        XCTAssertNil(savedBodies[2]["reviewedObjective"])
        for body in savedBodies {
            let sentPolicy = try XCTUnwrap(body["policy"] as? [String: Any])
            XCTAssertNil(sentPolicy["hostGoal"])
            XCTAssertEqual(body["expectedRevision"] as? Int, 7)
        }
        for request in requests { XCTAssertEqual(request["token"] as? String, "fixture-token") }
    }
}
