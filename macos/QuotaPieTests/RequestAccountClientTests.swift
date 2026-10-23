import Foundation
import XCTest
@testable import QuotaPie

final class RequestAccountClientTests: XCTestCase {
    func testAuthenticatedCatalogAndAssignmentUseTheServerContract() throws {
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
            def respond(self, body, payload, status=200):
                requests.append({'method':self.command,'path':self.path,'token':self.headers.get('x-quotapie-action-token'),'body':body})
                pathlib.Path(sys.argv[1]).write_text(json.dumps(requests))
                data = json.dumps(payload).encode()
                self.send_response(status)
                self.send_header('Content-Type','application/json')
                self.send_header('Content-Length',str(len(data)))
                self.end_headers()
                self.wfile.write(data)
            def do_GET(self):
                self.respond(None, {'conversations':[{'threadId':'11111111-1111-4111-8111-111111111111','title':'Current work','sourceAccount':'A','currentAccount':'A','targetAccount':None,'active':True}],'accounts':[{'account':'B','label':'Second account','available':True}]})
            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers['content-length'])))
                if self.path.endswith('/new-conversations'):
                    self.respond(body, {'conversations':[], 'accounts':[], 'newConversationAccount':body['account']})
                elif body['account'] == 'unavailable':
                    self.respond(body, {'error':'pool_manual_target_quota_exhausted'}, 409)
                else:
                    self.respond(body, dict(body, label='Second account'))
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
        let portText = String(data: output.fileHandleForReading.availableData, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines)
        let port = try XCTUnwrap(portText.flatMap(Int.init))
        let client = try StatusClient(environment: ["QUOTAPIE_API_URL": "http://127.0.0.1:\(port)"])
        let catalogReceived = expectation(description: "catalog")
        client.requestAccounts(actionToken: "fixture-token") { result in
            do {
                let catalog = try result.get()
                XCTAssertEqual(catalog.conversations.first?.title, "Current work")
                XCTAssertEqual(catalog.conversations.first?.currentAccount, "A")
                XCTAssertTrue(catalog.accounts.first?.available == true)
            } catch { XCTFail(error.localizedDescription) }
            catalogReceived.fulfill()
        }
        wait(for: [catalogReceived], timeout: 5)
        let assignmentReceived = expectation(description: "assignment")
        let thread = "11111111-1111-4111-8111-111111111111"
        client.useRequestAccount(threadID: thread, account: "B", actionToken: "fixture-token") { result in
            do {
                let assignment = try result.get()
                XCTAssertEqual(assignment.threadId, thread)
                XCTAssertEqual(assignment.account, "B")
            } catch { XCTFail(error.localizedDescription) }
            assignmentReceived.fulfill()
        }
        wait(for: [assignmentReceived], timeout: 5)
        let failureReceived = expectation(description: "failure")
        client.useRequestAccount(threadID: thread, account: "unavailable", actionToken: "fixture-token") { result in
            switch result {
            case .success: XCTFail("Unavailable account must never succeed")
            case .failure(let error): XCTAssertEqual(error.localizedDescription, Strings.t("requestAccount.error.quota"))
            }
            failureReceived.fulfill()
        }
        wait(for: [failureReceived], timeout: 5)
        for account: String? in ["B", nil] {
            let received = expectation(description: "new chat account")
            client.configureNewConversations(account: account, actionToken: "fixture-token") { result in
                do { XCTAssertEqual(try result.get().newConversationAccount, account) }
                catch { XCTFail(error.localizedDescription) }
                received.fulfill()
            }
            wait(for: [received], timeout: 5)
        }
        let requests = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: capture)) as? [[String: Any]])
        XCTAssertEqual(requests.count, 5)
        XCTAssertEqual(requests[0]["method"] as? String, "GET")
        XCTAssertEqual(requests[1]["method"] as? String, "POST")
        XCTAssertEqual(requests[1]["body"] as? [String: String], ["threadId": thread, "account": "B"])
        for request in requests.prefix(3) {
            XCTAssertEqual(request["path"] as? String, "/api/request-accounts")
            XCTAssertEqual(request["token"] as? String, "fixture-token")
        }
        for request in requests.suffix(2) {
            XCTAssertEqual(request["path"] as? String, "/api/request-accounts/new-conversations")
            XCTAssertEqual(request["token"] as? String, "fixture-token")
            XCTAssertEqual(request["method"] as? String, "POST")
        }
    }
}
