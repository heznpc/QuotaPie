import Foundation
import Combine
import XCTest
@testable import QuotaPie

final class UsageReportTests: XCTestCase {
    func testLastThursdayAndPreviousWindowUseLocalCalendar() throws {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = try XCTUnwrap(TimeZone(identifier: "Asia/Seoul"))
        let now = try XCTUnwrap(ISO8601DateFormatter().date(from: "2026-10-19T09:00:00Z"))
        let range = try XCTUnwrap(UsageDateRange.sinceThursday.interval(now: now, calendar: calendar))
        XCTAssertEqual(ISO8601DateFormatter().string(from: range.start), "2026-10-14T15:00:00Z")
        XCTAssertEqual(range.end, now)
        let thursday = try XCTUnwrap(ISO8601DateFormatter().date(from: "2026-10-22T09:00:00Z"))
        XCTAssertEqual(UsageDateRange.sinceThursday.interval(now: thursday, calendar: calendar)?.start, range.start,
                       "Last Thursday on a Thursday refers to the prior week, not an empty same-day window")
    }

    func testFlattenedBucketsKeepSubsetsSeparateAndDecodeMissingOptionalEvidence() throws {
        let bucket = try JSONDecoder().decode(UsageBucket.self, from: Data("""
        {"id":"session","label":"Work","inputTokens":100,"cachedInputTokens":80,"cacheCreationTokens":5,
         "outputTokens":20,"reasoningTokens":10,"totalTokens":120,"requests":1,"subagentTokens":120,
         "isSubagent":true,"previousTotalTokens":50,"resetKind":"external_relief"}
        """.utf8))
        XCTAssertEqual(bucket.totals.totalTokens, 120)
        XCTAssertEqual(bucket.totals.cachedInputTokens, 80)
        XCTAssertEqual(bucket.totals.reasoningTokens, 10)
        XCTAssertEqual(bucket.totals.subagentTokens, 120)
        XCTAssertEqual(bucket.previousTotalTokens, 50)
        XCTAssertEqual(bucket.resetKind, "external_relief")
        XCTAssertNil(bucket.sessionId)
    }

    func testMissingCapabilityDoesNotStartPolling() throws {
        let client = try StatusClient(environment: ["QUOTAPIE_API_URL": "http://127.0.0.1:1"])
        let store = UsageReportStore()
        store.load(client: client, actionToken: nil)
        XCTAssertFalse(store.loading)
        XCTAssertNil(store.report)
        XCTAssertNotNil(store.error)
    }

    func testLoadingPollPreservesExactRangeAndUsesAuthenticatedReadOnlyRequest() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let capture = directory.appendingPathComponent("requests.json")
        let server = Process()
        server.executableURL = URL(fileURLWithPath: "/usr/bin/python3")
        server.arguments = ["-u", "-c", """
        import http.server, json, pathlib, sys, urllib.parse
        requests = []
        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
                requests.append({'method':'GET','query':q,'token':self.headers.get('x-quotapie-action-token')})
                pathlib.Path(sys.argv[1]).write_text(json.dumps(requests))
                z = dict(inputTokens=0,cachedInputTokens=0,cacheCreationTokens=0,outputTokens=0,reasoningTokens=0,totalTokens=0,requests=0,subagentTokens=0)
                report = dict(generatedAtMs=1,fromMs=float(q['fromMs'][0]),toMs=float(q['toMs'][0]),timeZone=q['timeZone'][0],total=z,previous=z,days=[],models=[],sessions=[],resetPeriods=[],coverage=dict(filesScanned=0,filesPending=0,filesSkipped=0,malformedLines=0,unknownModelTokens=0,notes=[]),activity=dict(compactions=0,retries=0,failedRequests=0,attributedRequestTokens=0,unattributedRequestTokens=0))
                payload = json.dumps({'state':'loading' if len(requests)==1 else 'ready','report':None if len(requests)==1 else report}).encode()
                self.send_response(200)
                self.send_header('Content-Length',str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
            def log_message(self, *args): pass
        server=http.server.HTTPServer(('127.0.0.1',0),Handler)
        print(server.server_port,flush=True)
        server.serve_forever()
        """, capture.path]
        let output = Pipe()
        server.standardOutput = output
        server.standardError = FileHandle.nullDevice
        try server.run()
        defer { if server.isRunning { server.terminate(); server.waitUntilExit() } }
        let port = try XCTUnwrap(String(data: output.fileHandleForReading.availableData, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines))
        let client = try StatusClient(environment: ["QUOTAPIE_API_URL": "http://127.0.0.1:\(port)"])
        let store = UsageReportStore()
        let ready = expectation(description: "same report scan completed")
        let observation = store.$report.compactMap { $0 }.prefix(1).sink { _ in ready.fulfill() }
        defer { observation.cancel(); store.stop() }
        store.load(client: client, actionToken: "read-fixture-capability")
        wait(for: [ready], timeout: 8)
        let requests = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: capture)) as? [[String: Any]])
        XCTAssertEqual(requests.count, 2)
        let first = try XCTUnwrap(requests.first?["query"] as? [String: [String]])
        let second = try XCTUnwrap(requests.last?["query"] as? [String: [String]])
        XCTAssertEqual(first["fromMs"], second["fromMs"])
        XCTAssertEqual(first["toMs"], second["toMs"], "Changing the end on each poll would endlessly miss the report cache")
        XCTAssertEqual(first["timeZone"], [TimeZone.current.identifier])
        XCTAssertTrue(requests.allSatisfy { ($0["method"] as? String) == "GET" && ($0["token"] as? String) == "read-fixture-capability" })
        XCTAssertFalse(store.loading)
    }
}
