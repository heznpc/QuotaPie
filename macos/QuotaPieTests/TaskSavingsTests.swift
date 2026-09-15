import XCTest
@testable import QuotaPie

final class TaskSavingsTests: XCTestCase {
    func testResponseEvidenceIsSeparateFromRequestedSettings() throws {
        let json = #"{"requestId":"r","threadId":null,"from":"gpt-6-astra","to":"gpt-5.6-luna","requestedEffort":"xhigh","reasoningEffort":"low","responseModel":null,"phase":"response_headers","durationMs":15,"savingsReason":"simple_text_edit","usage":null,"routed":true,"active":true}"#
        let record = try JSONDecoder().decode(TaskSavingsRecord.self, from: Data(json.utf8))
        XCTAssertEqual(record.to, "gpt-5.6-luna")
        XCTAssertNil(record.responseModel)
        XCTAssertNil(record.usage)
        XCTAssertTrue(record.active)
        XCTAssertEqual(record.requestedEffort, "xhigh")
    }
    func testOlderCompactionPayloadKeepsBackwardCompatibility() throws {
        let json = #"{"checkedAtMs":0,"generations":1,"reachable":1,"active":[],"recent":[],"policy":null}"#
        let value = try JSONDecoder().decode(CompactionPayload.self, from: Data(json.utf8))
        XCTAssertNil(value.savings)
    }
}
