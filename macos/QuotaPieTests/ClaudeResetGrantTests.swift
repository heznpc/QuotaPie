import Foundation
import XCTest
@testable import QuotaPie

final class ClaudeResetGrantTests: XCTestCase {
    func testServerDecisionsAndExpirySurviveCacheRoundTrip() throws {
        let evidence = #"{"source":"claude-usage.cedar_ember","state":"reported","eligible":true,"grants":[{"id":"launch-team","resets_left":1,"resets_total":1,"ends_at":"2026-10-22T16:00:00Z","usable_now":false,"claimable":true}]}"#
        let data = try JSONSerialization.data(withJSONObject: ["claudeResetGrantJSON": evidence])
        let metadata = try JSONDecoder().decode(QuotaWindowMetadata.self, from: data)
        let restored = try JSONDecoder().decode(QuotaWindowMetadata.self, from: JSONEncoder().encode(metadata))
        let grant = try XCTUnwrap(restored.claudeResetGrant?.grants?.first)
        XCTAssertEqual(grant.resets_left, 1)
        XCTAssertEqual(grant.usable_now, false)
        XCTAssertEqual(grant.claimable, true)
        XCTAssertEqual(grant.ends_at, "2026-10-22T16:00:00Z")
    }

    func testAbsentOrMalformedEvidenceDoesNotInventZeroTickets() throws {
        for value: [String: Any] in [[:], ["claudeResetGrantJSON": "bad-json"]] {
            let metadata = try JSONDecoder().decode(QuotaWindowMetadata.self, from: JSONSerialization.data(withJSONObject: value))
            XCTAssertNil(metadata.claudeResetGrant)
        }
    }
}
