import Foundation
import XCTest
@testable import QuotaPie

final class ClaudeDesktopConnectionTests: XCTestCase {
    private func account(category: String?, desktop: Bool = true, withHistoricalWindow: Bool = false) throws -> AccountState {
        var collection: [String: Any] = ["health": category == nil ? "recent-success" : "attempted-then-failed",
            "activeSource": desktop ? "claude-desktop" : "claude-oauth", "lastSuccessAtMs": 900]
        if let category { collection["errorCategory"] = category }
        var object: [String: Any] = ["provider": "claude", "account": "fixture", "accountLabel": "Fixture", "enabled": true,
            "collection": collection, "bottleneckBucket": "five_hour", "updatedAtMs": 900,
            "windows": withHistoricalWindow ? [["provider": "claude", "account": "fixture", "bucket": "five_hour", "label": "5h",
                "windowSeconds": 18000, "freshness": "fresh", "observedAtMs": 900, "remainingPercent": 98]] : []]
        if desktop { object["connection"] = "claude-desktop" }
        return try JSONDecoder().decode(AccountState.self, from: JSONSerialization.data(withJSONObject: object))
    }

    func testDesktopWithoutNumbersNeverBorrowsHistoricalQuotaOrCodeLoginInstructions() throws {
        let value = try account(category: "no-windows", withHistoricalWindow: true)
        XCTAssertTrue(value.isClaudeDesktop)
        XCTAssertEqual(value.collectionStatusText, Strings.t("claudeDesktop.state.noQuota"))
        XCTAssertEqual(value.collectionExplanation, Strings.t("claudeDesktop.detail.noQuota"))
        XCTAssertEqual(MenuBarAccountStatus.title(for: value), value.collectionStatusText)
        XCTAssertTrue(AccountListPresentation(account: value).visibleWindows.isEmpty)
        XCTAssertNil(value.overviewWindow)
        XCTAssertEqual(value.collection.sourceLabel, Strings.t("source.claudeDesktop"))
        XCTAssertEqual(value.windows.count, 1, "The display projection does not delete persisted history")
    }

    func testDesktopAndCodeFailuresUseDifferentExplanations() throws {
        for category in ["access-denied", "auth-expired", "claude-desktop-unavailable", "claude-desktop-keychain", "account-mismatch", "rate-limited", "network"] {
            let desktop = try account(category: category)
            XCTAssertEqual(desktop.collectionExplanation, ClaudeDesktopCollectionText.detail(category: category))
            XCTAssertFalse(try XCTUnwrap(desktop.collectionExplanation).contains("claude auth login"))
            XCTAssertTrue(desktop.hasUnavailableQuotaAccess)
        }
        let code = try account(category: "access-denied", desktop: false)
        XCTAssertEqual(code.collectionExplanation, Strings.t("collection.access-denied.detail"))
        XCTAssertNotEqual(code.collectionExplanation, try account(category: "access-denied").collectionExplanation)
        let healthy = try account(category: nil, withHistoricalWindow: true)
        XCTAssertFalse(healthy.hasUnavailableQuotaAccess)
        XCTAssertNil(healthy.collectionExplanation)
        XCTAssertEqual(healthy.overviewWindow?.remainingPercent, 98)
    }

    func testKeychainApprovalIsDistinctFromServerQuotaPermission() throws {
        let keychain = try account(category: "claude-desktop-keychain")
        let denied = try account(category: "access-denied")
        XCTAssertEqual(keychain.collectionStatusText, Strings.t("claudeDesktop.state.keychain"))
        XCTAssertEqual(keychain.collectionExplanation, Strings.t("claudeDesktop.detail.keychain"))
        XCTAssertNotEqual(keychain.collectionStatusText, denied.collectionStatusText)
        XCTAssertNotEqual(keychain.collectionExplanation, denied.collectionExplanation)
        XCTAssertEqual(ClaudeDesktopConnectionError(category: "claude-desktop-keychain").errorDescription,
                       Strings.t("claudeDesktop.detail.keychain"))
    }

    func testStartupCacheKeepsDesktopIdentityAndUnavailableStateWithoutHistoricalNumbers() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let cache = QuotaSnapshotCache(endpoint: "http://127.0.0.1:1", url: directory.appendingPathComponent("quota.json"))
        for category in ["no-windows", "auth-expired", "access-denied", "account-mismatch", "claude-desktop-unavailable", "claude-desktop-keychain", "network"] {
            var payload = try JSONDecoder().decode(StatusPayload.self, from: Data(#"{"nowMs":1000}"#.utf8))
            payload.accounts = [try account(category: category, withHistoricalWindow: true)]
            try cache.save(payload)
            let restored = try XCTUnwrap(cache.load()?.accounts.first)
            XCTAssertTrue(restored.isClaudeDesktop)
            XCTAssertEqual(restored.collection.errorCategory, category)
            XCTAssertEqual(restored.collectionStatusText, payload.accounts[0].collectionStatusText)
            XCTAssertTrue(restored.windows.isEmpty)
            XCTAssertNil(restored.bottleneckBucket)
            XCTAssertNil(restored.updatedAtMs)
            let model = PopoverModel()
            var cached = payload
            cached.accounts = [restored]
            model.applyCachedQuota(cached)
            XCTAssertFalse(model.canActOnTasks)
            XCTAssertNil(model.measurementDate)
        }
    }

    func testConnectionRequiresAnExplicitRequestAndCurrentLocalCapability() throws {
        let model = PopoverModel()
        XCTAssertFalse(model.claudeDesktopConnection.busy)
        XCTAssertNil(model.claudeDesktopConnection.message)
        model.statusClient = try StatusClient(environment: ["QUOTAPIE_API_URL": "http://127.0.0.1:1"])
        model.claudeDesktopConnection.connect(model: model)
        XCTAssertFalse(model.claudeDesktopConnection.busy, "Opening settings or missing a current action capability must not invoke the helper")
    }

    func testInteractiveConnectionBudgetIncludesThePendingBackgroundRead() {
        XCTAssertGreaterThan(ClaudeDesktopConnectionModel.operationTimeout, 45 + 120,
                             "A pending background read plus the OS approval window must fit the explicit connection request")
        XCTAssertEqual(ClaudeDesktopConnectionModel.operationTimeout, 180)
    }

    func testConnectPOSTUsesOnlyLocalActionTokenAndDecodesSanitizedFailureCategory() throws {
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
                requests.append({'path':self.path,'token':self.headers.get('x-quotapie-action-token'),'body':body})
                pathlib.Path(sys.argv[1]).write_text(json.dumps(requests))
                account = {'provider':'claude','account':'desktop-fixture','accountLabel':'Fixture','enabled':True,
                    'connection':'claude-desktop','collection':{'health':'attempted-then-failed','errorCategory':'no-windows'},'windows':[]}
                status, payload = 200, {'account':account,'connected':True,'quotaAvailable':False}
                if len(requests) == 2: status, payload = 409, {'error':'secret-provider-body','category':'auth-expired'}
                if len(requests) == 3: del account['connection']
                data = json.dumps(payload).encode()
                self.send_response(status)
                self.send_header('Content-Length',str(len(data)))
                self.end_headers()
                self.wfile.write(data)
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
        client.connectClaudeDesktop(actionToken: "") { result in
            if case .success = result { XCTFail("A missing capability must not send a request") }
        }
        for index in 1...3 {
            let received = expectation(description: "connect-\(index)")
            client.connectClaudeDesktop(actionToken: "fixture-capability") { result in
                switch (index, result) {
                case (1, .success(let reply)):
                    XCTAssertTrue(reply.connected)
                    XCTAssertFalse(reply.quotaAvailable)
                    XCTAssertEqual(reply.account.collectionStatusText, Strings.t("claudeDesktop.state.noQuota"))
                case (2, .failure(let error)):
                    XCTAssertEqual(error.localizedDescription, Strings.t("claudeDesktop.detail.sessionExpired"))
                    XCTAssertFalse(error.localizedDescription.contains("secret-provider-body"))
                case (3, .failure(let error)):
                    XCTAssertTrue(error is StatusClientError)
                default: XCTFail("Unexpected response for request \(index)")
                }
                received.fulfill()
            }
            wait(for: [received], timeout: 5)
        }
        let requests = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: capture)) as? [[String: Any]])
        XCTAssertEqual(requests.count, 3)
        for request in requests {
            XCTAssertEqual(request["path"] as? String, "/api/claude/desktop/connect")
            XCTAssertEqual(request["token"] as? String, "fixture-capability")
            XCTAssertEqual((request["body"] as? [String: String])?.count, 0)
        }
    }
}
