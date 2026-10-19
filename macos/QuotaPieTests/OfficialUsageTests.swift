import Foundation
import Combine
import XCTest
@testable import QuotaPie

final class OfficialUsageTests: XCTestCase {
    private final class Server {
        let directory: URL
        let capture: URL
        let process = Process()
        let client: StatusClient

        init(delay: Double = 0) throws {
            directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            capture = directory.appendingPathComponent("requests.json")
            process.executableURL = URL(fileURLWithPath: "/usr/bin/python3")
            process.arguments = ["-u", "-c", """
            import http.server,json,pathlib,sys,time,urllib.parse
            requests=[]
            class Handler(http.server.BaseHTTPRequestHandler):
                def do_GET(self):
                    q=urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
                    requests.append(dict(path=urllib.parse.urlparse(self.path).path,query=q,token=self.headers.get('x-quotapie-action-token'),method=self.command))
                    pathlib.Path(sys.argv[1]).write_text(json.dumps(requests))
                    time.sleep(float(sys.argv[2]))
                    dims=dict(features=[dict(key='user',value=54.3)],models=[],surfaces=[],triggers=[])
                    account=dict(account='main',label='Main',status='ready',error=None,units='percent',dataFreshnessMs=None,days=[dict(date=q['endDate'][0],total=54.3,**dims)],total=54.3,periodsAsOfMs=None,periodsComplete=False,periodsApproximate=True,**dims)
                    payload=json.dumps(dict(generatedAtMs=time.time()*1000,startDate=q['startDate'][0],endDate=q['endDate'][0],accounts=[account])).encode()
                    try:
                        self.send_response(200);self.send_header('Content-Length',str(len(payload)));self.end_headers();self.wfile.write(payload)
                    except (BrokenPipeError,ConnectionResetError): pass
                def log_message(self,*args): pass
            server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Handler)
            print(server.server_port,flush=True)
            server.serve_forever()
            """, capture.path, String(delay)]
            let output = Pipe()
            process.standardOutput = output
            process.standardError = FileHandle.nullDevice
            try process.run()
            let port = try XCTUnwrap(String(data: output.fileHandleForReading.availableData, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines))
            client = try StatusClient(environment: ["QUOTAPIE_API_URL": "http://127.0.0.1:\(port)"])
        }

        func requests() throws -> [[String: Any]] {
            guard FileManager.default.fileExists(atPath: capture.path) else { return [] }
            return try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: capture)) as? [[String: Any]])
        }

        deinit {
            if process.isRunning { process.terminate(); process.waitUntilExit() }
            try? FileManager.default.removeItem(at: directory)
        }
    }

    func testOfficialReportCapabilityRangeCacheAndExplicitRefresh() throws {
        let server = try Server()
        let store = OfficialUsageStore()
        defer { store.stop() }
        let first = expectation(description: "official response decoded")
        let observation = store.$report.compactMap { $0 }.prefix(1).sink { report in
            XCTAssertEqual(report.accounts.first?.features.first?.value, 54.3)
            XCTAssertNil(report.accounts.first?.dataFreshnessMs)
            XCTAssertEqual(report.accounts.first?.periodsApproximate, true)
            first.fulfill()
        }
        defer { observation.cancel() }
        store.load(client: server.client, actionToken: "fixture-capability", days: 30)
        wait(for: [first], timeout: 5)
        XCTAssertFalse(store.loading)
        store.load(client: server.client, actionToken: "fixture-capability", days: 30)
        XCTAssertFalse(store.loading, "Fresh same-range report must not blank or refetch on reopening")
        XCTAssertEqual(try server.requests().count, 1)
        let refreshed = expectation(description: "explicit refresh completes")
        let refreshObservation = store.$report.dropFirst().compactMap { $0 }.prefix(1).sink { _ in refreshed.fulfill() }
        defer { refreshObservation.cancel() }
        store.load(client: server.client, actionToken: "fixture-capability", days: 30, refresh: true)
        wait(for: [refreshed], timeout: 5)
        let requests = try server.requests()
        XCTAssertEqual(requests.count, 2)
        XCTAssertTrue(requests.allSatisfy { $0["method"] as? String == "GET" && $0["path"] as? String == "/api/official-usage" && $0["token"] as? String == "fixture-capability" })
        let firstQuery = try XCTUnwrap(requests[0]["query"] as? [String: [String]])
        let secondQuery = try XCTUnwrap(requests[1]["query"] as? [String: [String]])
        XCTAssertEqual(firstQuery["refresh"], ["0"])
        XCTAssertEqual(secondQuery["refresh"], ["1"])
        XCTAssertEqual(firstQuery["analysisTimeZone"], [TimeZone.current.identifier])
        let localFormatter = DateFormatter()
        localFormatter.locale = Locale(identifier: "en_US_POSIX")
        localFormatter.dateFormat = "yyyy-MM-dd"
        let now = Date()
        let distance = (Calendar.current.component(.weekday, from: now) - 5 + 7) % 7
        let thursday = try XCTUnwrap(Calendar.current.date(byAdding: .day, value: -(distance == 0 ? 7 : distance), to: now))
        XCTAssertEqual(firstQuery["analysisDate"], [localFormatter.string(from: thursday)])
        XCTAssertNil(firstQuery["analysisBoundaryMs"], "The client asks for an observed recovery, never invents a midnight reset")
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd"
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        let start = try XCTUnwrap(formatter.date(from: try XCTUnwrap(firstQuery["startDate"]?.first)))
        let end = try XCTUnwrap(formatter.date(from: try XCTUnwrap(firstQuery["endDate"]?.first)))
        XCTAssertEqual(end.timeIntervalSince(start), 29 * 86400)
    }

    func testLosingCapabilityCancelsLateResponseAndClearsVisibleReport() throws {
        let server = try Server(delay: 0.4)
        let store = OfficialUsageStore()
        defer { store.stop() }
        store.load(client: server.client, actionToken: "fixture-capability")
        let started = expectation(description: "request started")
        let timer = Timer.scheduledTimer(withTimeInterval: 0.01, repeats: true) { timer in
            if (try? server.requests().count) == 1 { timer.invalidate(); started.fulfill() }
        }
        defer { timer.invalidate() }
        wait(for: [started], timeout: 2)
        XCTAssertEqual(try server.requests().count, 1)
        store.load(client: server.client, actionToken: nil)
        XCTAssertFalse(store.loading)
        let settled = expectation(description: "late response ignored")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { settled.fulfill() }
        wait(for: [settled], timeout: 2)
        XCTAssertNil(store.report)
        XCTAssertNotNil(store.error)
    }

    func testAnalysisKeepsIndependentBasesAndUnavailableEvidence() throws {
        var payload: [String: Any] = [
            "status": "observed_days", "reason": NSNull(), "boundaryMs": 1792044858922,
            "timezone": "UTC", "currentStartDate": "2026-10-16", "currentEndDate": "2026-10-18",
            "previousStartDate": "2026-10-12", "previousEndDate": "2026-10-14",
            "excludedDates": ["2026-10-15", "2026-10-19"],
            "currentTotal": 100.9775583, "previousTotal": 136.4128484, "changePercent": -25.9765,
            "currentFeatureTotal": 98.729475, "previousFeatureTotal": 134.3413408, "featureChangePercent": -26.5085,
            "models": [["key": "gpt-6-astra", "current": 100.1745, "previous": 129.574, "delta": -29.3995, "changePercent": -22.69]],
            "features": [["key": "subagent", "current": 38.5537, "previous": 49.5569, "delta": -11.0032, "changePercent": -22.20]],
            "speeds": [], "triggers": [], "conversationStatus": "unavailable",
            "conversationReason": "lifetime_no_date_filter", "freshnessConfirmed": false,
            "basis": "separate_model_and_attribution_relative_scales"
        ]
        let observed = try JSONDecoder().decode(OfficialUsageAnalysis.self, from: JSONSerialization.data(withJSONObject: payload))
        XCTAssertEqual(observed.changePercent, -25.9765)
        XCTAssertEqual(observed.featureChangePercent, -26.5085)
        XCTAssertNotEqual(observed.currentTotal, observed.currentFeatureTotal)
        XCTAssertFalse(observed.freshnessConfirmed)
        XCTAssertEqual(observed.conversationStatus, "unavailable")
        XCTAssertEqual(observed.excludedDates, ["2026-10-15", "2026-10-19"])
        payload["status"] = "unavailable"
        payload["reason"] = "recovery_not_observed"
        payload["boundaryMs"] = NSNull()
        payload["changePercent"] = NSNull()
        payload["featureChangePercent"] = NSNull()
        payload["models"] = []
        payload["features"] = []
        let unavailable = try JSONDecoder().decode(OfficialUsageAnalysis.self, from: JSONSerialization.data(withJSONObject: payload))
        XCTAssertNil(unavailable.boundaryMs)
        XCTAssertNil(unavailable.changePercent, "Unavailable evidence must not decode as a zero change")
        XCTAssertEqual(unavailable.reason, "recovery_not_observed")
        XCTAssertTrue(unavailable.models.isEmpty)
    }
}
