import Foundation
import XCTest
@testable import QuotaPie

final class WakeRecoveryTests: XCTestCase {
    private func status(_ observations: [Int], nowMs: Int = 3000, fresh: Bool = true) throws -> StatusPayload {
        let accounts: [[String: Any]] = observations.enumerated().map { index, observed in
            ["provider":index == 2 ? "claude" : "codex","account":"account-\(index)","accountLabel":"Fixture","enabled":true,
             "collection":["health":fresh ? "recent-success" : "stale-success"],
             "windows":[["provider":index == 2 ? "claude" : "codex","account":"account-\(index)","bucket":"weekly","label":"Weekly",
                         "freshness":fresh ? "fresh" : "stale","observedAtMs":observed,"remainingPercent":50]]]
        }
        return try JSONDecoder().decode(StatusPayload.self,from:JSONSerialization.data(withJSONObject:["nowMs":nowMs,"accounts":accounts]))
    }

    func testBurstEndsOnlyAfterBothAccountsHaveFreshPostTriggerMeasurements() throws {
        var polling = QuotaRecoveryPolling()
        polling.begin(payload:try status([1000,1000]),atMs:2000,uptime:10)
        XCTAssertEqual(polling.delay(normal:10,uptime:10.1),0.15)
        XCTAssertFalse(polling.observe(try status([1000,1000],nowMs:9000),uptime:10.2),"HTTP/cache clock advances are not measurement")
        XCTAssertFalse(polling.observe(try status([2500,1000]),uptime:10.3),"The other account still needs a reading")
        XCTAssertFalse(polling.observe(try status([2500,2500],fresh:false),uptime:10.4),"Stale snapshots do not complete recovery")
        XCTAssertTrue(polling.observe(try status([2500,2500]),uptime:10.5))
        XCTAssertFalse(polling.isActive(uptime:10.6))
        XCTAssertEqual(polling.delay(normal:10,uptime:10.6),10)
        XCTAssertFalse(polling.observe(try status([2600,2600]),uptime:10.7),"Log completion once")
    }

    func testUnavailableClaudeDoesNotDelayRecoveryOfBothCollectableAccounts() throws {
        var before = try status([1000,1000,100])
        before.accounts[2].collection.health = "attempted-then-failed"
        before.accounts[2].collection.errorCategory = "auth-required"
        before.accounts[2].windows[0].freshness = "stale"
        var polling = QuotaRecoveryPolling()
        polling.begin(payload:before,atMs:2000,uptime:10)
        var after = try status([2500,2500,100])
        after.accounts[2] = before.accounts[2]
        XCTAssertTrue(polling.observe(after,uptime:10.5))
        XCTAssertEqual(after.accounts[2].collection.errorCategory,"auth-required","Do not clear the unavailable account's error")
        XCTAssertFalse(polling.isActive(uptime:10.6))
    }

    func testClaudeCodeUnavailableAndAccessDeniedDoNotHoldCodexRecoveryPolling() throws {
        for category in ["claude-code-unavailable", "access-denied"] {
            let before = try status([1000,1000,100])
            var polling = QuotaRecoveryPolling()
            polling.begin(payload: before, atMs: 2000, uptime: 10)
            var after = try status([2500,2500,100])
            after.accounts[2].collection.health = "attempted-then-failed"
            after.accounts[2].collection.errorCategory = category
            after.accounts[2].windows = []
            XCTAssertTrue(polling.observe(after, uptime: 10.5), "Unavailable Claude collection cannot delay fresh Codex accounts")
            XCTAssertFalse(polling.isActive(uptime: 10.6))
            XCTAssertEqual(after.accounts[2].collection.errorCategory, category)
        }
    }

    func testFailedCollectionHasBoundedFastPollingAndNoCacheOnlyCompletion() throws {
        var polling = QuotaRecoveryPolling()
        polling.begin(payload:nil,atMs:2000,uptime:10)
        XCTAssertFalse(polling.observe(try status([1000,1000]),uptime:10.1))
        XCTAssertEqual(polling.delay(normal:10,uptime:13),0.3)
        XCTAssertFalse(polling.isActive(uptime:18))
        XCTAssertEqual(polling.delay(normal:10,uptime:18),10)
        polling.begin(payload:try status([1000,1000]),atMs:3000,uptime:20)
        XCTAssertTrue(polling.isActive(uptime:20.1),"A later network recovery can start another attempt")
    }

    func testDesktopConnectionWithoutNumbersOrWithChangedIdentityDoesNotHoldCodexRecovery() throws {
        for category in ["no-windows", "account-mismatch", "claude-desktop-unavailable", "auth-expired", "network"] {
            var before = try status([1000,1000,100])
            before.accounts[2].connection = "claude-desktop"
            var polling = QuotaRecoveryPolling()
            polling.begin(payload: before, atMs: 2000, uptime: 10)
            var after = try status([2500,2500,100])
            after.accounts[2].connection = "claude-desktop"
            after.accounts[2].collection.health = "attempted-then-failed"
            after.accounts[2].collection.errorCategory = category
            after.accounts[2].windows = []
            XCTAssertTrue(polling.observe(after, uptime: 10.5), category)
            XCTAssertEqual(after.accounts[2].collection.errorCategory, category)
        }
    }

    func testWakeSignalsCoalesceButNextRealSleepCycleIsNotSuppressed() {
        var polling = QuotaRecoveryPolling()
        XCTAssertTrue(polling.acceptWake(uptime:10))
        XCTAssertFalse(polling.acceptWake(uptime:10.2))
        XCTAssertFalse(polling.acceptWake(uptime:12.6))
        polling.didSleep()
        XCTAssertTrue(polling.acceptWake(uptime:13),"A new sleep cycle must not inherit the previous debounce")
    }

    func testPowerMessageClassificationUsesInstalledSDKConstants() throws {
        // This checks public ABI constants, not an actual system wake event.
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at:directory,withIntermediateDirectories:true)
        defer { try? FileManager.default.removeItem(at:directory) }
        let source = directory.appendingPathComponent("messages.c")
        let executable = directory.appendingPathComponent("messages")
        try """
        #include <stdio.h>
        #include <IOKit/IOMessage.h>
        int main(void) { printf("%u %u %u %u", kIOMessageCanSystemSleep, kIOMessageSystemWillSleep, kIOMessageSystemWillPowerOn, kIOMessageSystemHasPoweredOn); }
        """.write(to:source,atomically:true,encoding:.utf8)
        let compiler = Process()
        compiler.executableURL = URL(fileURLWithPath:"/usr/bin/clang")
        compiler.arguments = [source.path,"-o",executable.path]
        try compiler.run(); compiler.waitUntilExit()
        XCTAssertEqual(compiler.terminationStatus,0)
        let process = Process(), output = Pipe()
        process.executableURL = executable; process.standardOutput = output
        try process.run(); process.waitUntilExit()
        let values = try XCTUnwrap(String(data:output.fileHandleForReading.readDataToEndOfFile(),encoding:.utf8))
            .split(separator:" ").compactMap { UInt32($0) }
        XCTAssertEqual(values.map(SystemWakeMonitor.action),[.allowSleep,.willSleep,.earlyWake,.poweredOn])
        XCTAssertEqual(SystemWakeMonitor.action(for:0),.ignore)
    }

    func testReplacingQuotaTransportCancelsOnlyQuotaAndPreservesDetailRead() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at:directory,withIntermediateDirectories:true)
        defer { try? FileManager.default.removeItem(at:directory) }
        let marker = directory.appendingPathComponent("started")
        let server = Process(), output = Pipe()
        server.executableURL = URL(fileURLWithPath:"/usr/bin/python3")
        server.arguments = ["-u","-c","""
        import http.server,json,pathlib,sys,time
        count=0
        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                global count
                if self.path=='/api/status':
                    time.sleep(1.5)
                    value=9000
                else:
                    count+=1
                    value=count*1000
                    if count==1:
                        pathlib.Path(sys.argv[1]).write_text('ready')
                        time.sleep(5)
                data=json.dumps({'nowMs':value,'accounts':[]}).encode()
                try:
                    self.send_response(200)
                    self.send_header('Content-Length',str(len(data)))
                    self.end_headers()
                    self.wfile.write(data)
                except BrokenPipeError: pass
            def log_message(self,*args): pass
        server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Handler)
        print(server.server_port,flush=True)
        server.serve_forever()
        """,marker.path]
        server.standardOutput=output; server.standardError=FileHandle.nullDevice
        try server.run()
        defer { if server.isRunning { server.terminate(); server.waitUntilExit() } }
        let port=try XCTUnwrap(String(data:output.fileHandleForReading.availableData,encoding:.utf8)?.trimmingCharacters(in:.whitespacesAndNewlines))
        let client=try StatusClient(environment:["QUOTAPIE_API_URL":"http://127.0.0.1:\(port)"])
        let old=expectation(description:"old quota cancelled"), detail=expectation(description:"detail preserved"), fresh=expectation(description:"fresh quota")
        client.fetchQuota { result in
            if case .failure(let error)=result { XCTAssertEqual((error as? URLError)?.code,.cancelled) }
            else { XCTFail("Old quota should be cancelled") }
            old.fulfill()
        }
        client.fetch { result in
            switch result {
            case .success(let payload): XCTAssertEqual(payload.nowMs,9000)
            case .failure(let error): XCTFail(error.localizedDescription)
            }
            detail.fulfill()
        }
        let started=XCTNSPredicateExpectation(predicate:NSPredicate { _,_ in FileManager.default.fileExists(atPath:marker.path) },object:nil)
        wait(for:[started],timeout:3)
        let start=Date()
        client.resetQuotaTransport()
        client.fetchQuota { result in
            switch result {
            case .success(let payload): XCTAssertEqual(payload.nowMs,2000)
            case .failure(let error): XCTFail(error.localizedDescription)
            }
            XCTAssertLessThan(Date().timeIntervalSince(start),1.5)
            fresh.fulfill()
        }
        wait(for:[old,fresh,detail],timeout:3)
    }
}
