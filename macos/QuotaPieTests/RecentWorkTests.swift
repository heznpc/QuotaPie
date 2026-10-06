import Foundation
import XCTest
@testable import QuotaPie

final class RecentWorkTests: XCTestCase {
    func testOlderServiceDecodesWithoutClaimingRecentWorkSupport() throws {
        let legacy = try decode([:])
        XCTAssertTrue(legacy.recentWork.isEmpty)
        XCTAssertFalse(legacy.supportsRecentWork)
        XCTAssertEqual(legacy.recentWorkState, "ready")
        let current = try decode(["recentWork": []])
        XCTAssertTrue(current.supportsRecentWork)
        XCTAssertTrue(current.recentWork.isEmpty)
    }

    func testMetadataAndCollectionStateDecodeWithoutConversationContent() throws {
        let status = try decode(["recentWork": [item], "recentWorkState": "loading"])
        XCTAssertEqual(status.recentWorkState, "loading")
        XCTAssertEqual(status.recentWork.first?.providerTitle, "Codex")
        XCTAssertEqual(status.recentWork.first?.accountTitle, "Personal")
        XCTAssertEqual(status.recentWork.first?.tokenCount, 0)
        XCTAssertEqual(status.recentWork.first?.projectLabel, "QuotaPie")
    }

    func testMalformedIdentifiersProvidersAndNegativeUsageAreRejected() throws {
        for changes: [String: Any] in [["id": "../session"], ["id": String(repeating: "G", count: 64)],
                                     ["provider": "unsupported"], ["tokenCount": -1], ["lastActiveAtMs": 0]] {
            let invalid = item.merging(changes) { _, new in new }
            XCTAssertThrowsError(try decode(["recentWork": [invalid]]))
        }
    }

    func testInvalidOpenIdentifierFailsBeforeSendingAnyRequest() throws {
        let client = try StatusClient(environment: ["QUOTAPIE_API_URL": "http://127.0.0.1:1"])
        var receivedError = false
        client.openRecentWork(id: "../private", actionToken: "test-token") { result in
            if case .failure(StatusClientError.invalidTaskID) = result { receivedError = true }
        }
        XCTAssertTrue(receivedError)
    }

    private var item: [String: Any] {
        ["id": String(repeating: "a", count: 64), "provider": "codex", "account": "default",
         "accountLabel": "Personal", "projectLabel": "QuotaPie", "tokenCount": 0,
         "lastActiveAtMs": 1_800_000_000_000]
    }

    private func decode(_ value: [String: Any]) throws -> StatusPayload {
        try JSONDecoder().decode(StatusPayload.self, from: JSONSerialization.data(withJSONObject: value))
    }
}
