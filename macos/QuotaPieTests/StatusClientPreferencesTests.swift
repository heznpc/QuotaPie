import Foundation
import XCTest
@testable import QuotaPie

final class StatusClientPreferencesTests: XCTestCase {
    func testNativeControlsSendTheServerPreferenceContract() throws {
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
                requests.append({'path':self.path, 'token':self.headers.get('x-quotapie-action-token'), 'body':body})
                pathlib.Path(sys.argv[1]).write_text(json.dumps(requests))
                payload = json.dumps({'notificationPreferences':{'enabled':True,'topics':{'rapidConsumption':False},'desktopEnabled':True,'resetCollectionEnabled':True,'usageSpeed':False,'paceForecasts':False}}).encode()
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
        let portText = String(data: output.fileHandleForReading.availableData, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines)
        let port = try XCTUnwrap(portText.flatMap(Int.init))
        let client = try StatusClient(environment: ["QUOTAPIE_API_URL": "http://127.0.0.1:\(port)"])
        for key in ["usageSpeed", "paceForecasts", "rapidConsumption"] {
            let received = expectation(description: key)
            client.configureNotifications(key: key, enabled: true, actionToken: "fixture-token") { result in
                if case .failure(let error) = result { XCTFail(error.localizedDescription) }
                received.fulfill()
            }
            wait(for: [received], timeout: 5)
        }
        let requests = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: capture)) as? [[String: Any]])
        XCTAssertEqual(requests.count, 3)
        XCTAssertEqual(requests[0]["body"] as? [String: Bool], ["usageSpeed": true])
        XCTAssertEqual(requests[1]["body"] as? [String: Bool], ["paceForecasts": true])
        let topics = try XCTUnwrap(requests[2]["body"] as? [String: [String: Bool]])
        XCTAssertEqual(topics, ["topics": ["rapidConsumption": true]])
        for request in requests {
            XCTAssertEqual(request["path"] as? String, "/api/notifications/preferences")
            XCTAssertEqual(request["token"] as? String, "fixture-token")
        }
    }
}
