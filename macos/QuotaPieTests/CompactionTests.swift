import Foundation
import XCTest
@testable import QuotaPie

final class CompactionTests: XCTestCase {
    func testHeaderStateIsRunningAndUsesActualModelAndEffort() throws {
        let payload = try decode(active: true, phase: "response_headers")
        let record = try XCTUnwrap(payload.compaction?.latest)
        XCTAssertEqual(record.phaseKey, "compaction.running")
        XCTAssertEqual(record.routeText, "Astra Xhigh → Sol Low")
        XCTAssertEqual(record.elapsed(at: Date(timeIntervalSince1970: 15)), "5.0" + Strings.t("compaction.seconds"))
    }
    func testTerminalDurationStopsAndMissingFieldsRemainBackwardCompatible() throws {
        let record = try XCTUnwrap(decode(active: false, phase: "completed").compaction?.latest)
        XCTAssertEqual(record.phaseKey, "compaction.completed")
        XCTAssertEqual(record.elapsed(at: Date(timeIntervalSince1970: 100)), "4.0" + Strings.t("compaction.seconds"))
        XCTAssertNil(try JSONDecoder().decode(StatusPayload.self, from: Data("{}".utf8)).compaction)
        let lost = try XCTUnwrap(decode(active: false, phase: "unverified").compaction?.latest)
        XCTAssertEqual(lost.phaseKey, "compaction.unverified")
    }
    func testSourceHealthDecodesWithoutConfusingNetworkAndEvidenceTime() throws {
        let raw = #"""
        {"resetSignals":{"enabled":true,"source":"multiple","state":"ready","signals":[],
          "sources":[{"id":"codexreset","state":"ready","coverage":"codexreset-quoted-posts",
          "lastSuccessMs":4000,"latestPublishedAtMs":1000,"lastEvidenceMs":2000,"newEvidenceCount":0}]}}
        """#
        let source = try XCTUnwrap(JSONDecoder().decode(StatusPayload.self, from: Data(raw.utf8)).resetSignals?.sources?.first)
        XCTAssertEqual(source.lastSuccessMs, 4000)
        XCTAssertEqual(source.latestPublishedAtMs, 1000)
        XCTAssertEqual(source.lastEvidenceMs, 2000)
        XCTAssertEqual(source.newEvidenceCount, 0)
    }
    private func decode(active: Bool, phase: String) throws -> StatusPayload {
        let row: [String: Any] = ["requestId":"11111111-1111-4111-8111-111111111111", "from":"gpt-6-astra",
            "to":"gpt-5.6-sol", "requestedEffort":"xhigh", "reasoningEffort":"low", "routed":true,
            "phase":phase, "status":200, "at":"2026-09-12T00:00:00Z", "startedAtMs":10000,
            "elapsedMs":4000, "active":active]
        let payload: [String: Any] = ["compaction":["checkedAtMs":14000, "generations":3,"reachable":2,
            "active":active ? [row] : [], "recent":active ? [] : [row]]]
        return try JSONDecoder().decode(StatusPayload.self, from: JSONSerialization.data(withJSONObject: payload))
    }
}
