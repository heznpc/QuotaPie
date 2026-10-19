import Foundation
import XCTest
@testable import QuotaPie

final class QuotaTransportRecoveryTests: XCTestCase {
    func testRepeatedTimeoutReplacesOnceAndPersistentOutageRetainsBackoff() {
        var recovery = QuotaTransportRecovery()
        XCTAssertEqual(recovery.failed(URLError(.timedOut)), .init(delay: 2, replaceTransport: false))
        XCTAssertEqual(recovery.failed(URLError(.timedOut)), .init(delay: 0.15, replaceTransport: true))
        XCTAssertEqual(recovery.failed(URLError(.timedOut)), .init(delay: 15, replaceTransport: false))
        for _ in 0..<20 {
            XCTAssertEqual(recovery.failed(URLError(.timedOut)), .init(delay: 30, replaceTransport: false))
        }
        recovery.succeeded()
        XCTAssertEqual(recovery.failed(URLError(.timedOut)), .init(delay: 2, replaceTransport: false))
        XCTAssertEqual(recovery.failed(URLError(.timedOut)), .init(delay: 0.15, replaceTransport: true))
    }

    func testOnlyConsecutiveTransportTimeoutsReplaceAndExternalReplacementCounts() {
        var recovery = QuotaTransportRecovery()
        XCTAssertFalse(recovery.failed(URLError(.timedOut)).replaceTransport)
        XCTAssertFalse(recovery.failed(StatusClientError.httpStatus(503)).replaceTransport)
        XCTAssertFalse(recovery.failed(URLError(.timedOut)).replaceTransport)
        recovery.transportWasReplaced()
        XCTAssertFalse(recovery.failed(URLError(.timedOut)).replaceTransport)
        XCTAssertFalse(recovery.failed(URLError(.timedOut)).replaceTransport)
        recovery.succeeded()
        XCTAssertFalse(recovery.failed(NSError(domain: "provider", code: NSURLErrorTimedOut)).replaceTransport)
        XCTAssertFalse(recovery.failed(NSError(domain: "provider", code: NSURLErrorTimedOut)).replaceTransport)
    }

    func testTransportReplacementPreservesCollectionAndRejectsOldCompletion() throws {
        var gate = CollectionRequestGate()
        gate.request("startup")
        let old = try XCTUnwrap(gate.begin())
        XCTAssertNil(gate.begin())
        gate.transportWasReplaced()
        XCTAssertEqual(gate.pendingReason, "startup")
        let replacement = try XCTUnwrap(gate.begin())
        XCTAssertFalse(gate.finish(old, retry: true))
        XCTAssertNil(gate.begin(), "The old callback cannot release the replacement")
        XCTAssertTrue(gate.finish(replacement, retry: false))
        XCTAssertNil(gate.begin())

        gate.request("manual")
        let manual = try XCTUnwrap(gate.begin())
        gate.request("network")
        gate.transportWasReplaced()
        XCTAssertEqual(gate.pendingReason, "network", "A newer recovery event takes precedence")
        XCTAssertFalse(gate.finish(manual, retry: true))
        let network = try XCTUnwrap(gate.begin())
        XCTAssertTrue(gate.finish(network, retry: true))
        XCTAssertEqual(gate.pendingReason, "network", "A failed POST keeps its collection intent")
    }

    func testRealTimeoutRecoveryPreservesDetailAndRetriesCancelledCollection() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let marker = directory.appendingPathComponent("collection-started")
        let server = Process(), output = Pipe()
        server.executableURL = URL(fileURLWithPath: "/usr/bin/python3")
        server.arguments = ["-u", "-c", """
        import http.server,json,pathlib,sys,time
        quotas=0
        collections=0
        class Handler(http.server.BaseHTTPRequestHandler):
            def reply(self,payload):
                data=json.dumps(payload).encode()
                try:
                    self.send_response(200)
                    self.send_header('Content-Length',str(len(data)))
                    self.end_headers()
                    self.wfile.write(data)
                except BrokenPipeError: pass
            def do_GET(self):
                global quotas
                if self.path=='/api/quota':
                    quotas+=1
                    value=quotas
                    if value<=2: time.sleep(1)
                    self.reply({'nowMs':value*1000,'accounts':[]})
                else:
                    time.sleep(.15)
                    self.reply({'nowMs':9000,'accounts':[]})
            def do_POST(self):
                global collections
                body=json.loads(self.rfile.read(int(self.headers['content-length'])))
                collections+=1
                if collections==1:
                    pathlib.Path(sys.argv[1]).write_text(body['reason'])
                    time.sleep(1)
                self.reply({'collection':{'refreshing':True}})
            def log_message(self,*args): pass
        server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Handler)
        print(server.server_port,flush=True)
        server.serve_forever()
        """, marker.path]
        server.standardOutput = output
        server.standardError = FileHandle.nullDevice
        try server.run()
        defer { if server.isRunning { server.terminate(); server.waitUntilExit() } }
        let port = try XCTUnwrap(String(data: output.fileHandleForReading.availableData, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines))
        let client = try StatusClient(environment: ["QUOTAPIE_API_URL": "http://127.0.0.1:\(port)"], operationTimeout: 0.3)
        var recovery = QuotaTransportRecovery()
        for index in 0..<2 {
            let timeout = expectation(description: "actual timeout \(index)")
            client.fetchQuota { result in
                switch result {
                case .success: XCTFail("The delayed server must time out")
                case .failure(let error):
                    XCTAssertEqual((error as? URLError)?.code, .timedOut)
                    XCTAssertEqual(recovery.failed(error).replaceTransport, index == 1)
                }
                timeout.fulfill()
            }
            wait(for: [timeout], timeout: 2)
        }

        var gate = CollectionRequestGate()
        gate.request("startup")
        let request = try XCTUnwrap(gate.begin())
        let cancelled = expectation(description: "collection cancellation ignored")
        client.refreshCollection(reason: request.reason, actionToken: "fixture-token") { result in
            if case .failure(let error) = result { XCTAssertEqual((error as? URLError)?.code, .cancelled) }
            else { XCTFail("The old collection POST must be cancelled") }
            XCTAssertFalse(gate.finish(request, retry: true))
            cancelled.fulfill()
        }
        let deadline = Date().addingTimeInterval(0.2)
        while !FileManager.default.fileExists(atPath: marker.path), Date() < deadline { Thread.sleep(forTimeInterval: 0.005) }
        XCTAssertEqual(try String(contentsOf: marker), "startup")
        let detail = expectation(description: "detail remains active")
        client.fetch { result in
            switch result {
            case .success(let payload): XCTAssertEqual(payload.nowMs, 9000)
            case .failure(let error): XCTFail(error.localizedDescription)
            }
            detail.fulfill()
        }
        gate.transportWasReplaced()
        client.resetQuotaTransport()
        let fresh = expectation(description: "replacement quota succeeds")
        client.fetchQuota { result in
            switch result {
            case .success(let payload): XCTAssertEqual(payload.nowMs, 3000); recovery.succeeded()
            case .failure(let error): XCTFail(error.localizedDescription)
            }
            fresh.fulfill()
        }
        wait(for: [cancelled, fresh, detail], timeout: 2)
        XCTAssertEqual(recovery.failures, 0)
        let replacement = try XCTUnwrap(gate.begin())
        XCTAssertEqual(replacement.reason, "startup")
        let collected = expectation(description: "preserved collection acknowledged")
        client.refreshCollection(reason: replacement.reason, actionToken: "fixture-token") { result in
            switch result {
            case .success(let state): XCTAssertTrue(state.refreshing)
            case .failure(let error): XCTFail(error.localizedDescription)
            }
            XCTAssertTrue(gate.finish(replacement, retry: false))
            collected.fulfill()
        }
        wait(for: [collected], timeout: 2)
        XCTAssertNil(gate.begin(), "The preserved event is replayed only once")
    }
}
