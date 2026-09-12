import AppKit
import XCTest
@testable import QuotaPie

final class QuotaPresentationTests: XCTestCase {
    func testLowQuotaUsesStrictTwentyPercentBoundaryAndRetainsItsColorInMenuBar() {
        XCTAssertTrue(QuotaPresentation.isLow(19))
        XCTAssertTrue(QuotaPresentation.isLow(0))
        XCTAssertFalse(QuotaPresentation.isLow(20))
        XCTAssertFalse(QuotaPresentation.isLow(nil))
        XCTAssertFalse(QuotaPresentation.isLow(.nan))
        XCTAssertFalse(MenuBarQuotaIndicator.image(label: "Codex", remainingPercent: 19).isTemplate)
        XCTAssertTrue(MenuBarQuotaIndicator.image(label: "Codex", remainingPercent: 20).isTemplate)
    }

    func testTimeoutConnectionAndResponseErrorsHaveDistinctExplanations() {
        XCTAssertEqual(StatusFailure(URLError(.timedOut)), .timeout)
        XCTAssertEqual(StatusFailure(URLError(.cannotConnectToHost)), .connection)
        XCTAssertEqual(StatusFailure(URLError(.networkConnectionLost)), .connection)
        XCTAssertEqual(StatusFailure(StatusClientError.httpStatus(503)), .response)
        XCTAssertEqual(StatusFailure(DecodingError.dataCorrupted(.init(codingPath: [], debugDescription: "synthetic"))), .response)
        XCTAssertNotEqual(StatusFailure.timeout.detailText, StatusFailure.connection.detailText)
    }

    func testKnownRemainingValueIsPreservedAlongsideTheSpecificFailure() throws {
        let headline = try JSONDecoder().decode(Headline.self, from: Data(#"{"kind":"normal","provider":"codex","windowKind":"weekly","remainingPercent":98}"#.utf8))
        let title = headline.cachedTitle(reason: StatusFailure.timeout.shortText)
        XCTAssertTrue(title.contains("98%"))
        XCTAssertTrue(title.contains(StatusFailure.timeout.shortText))
        XCTAssertFalse(title.contains(StatusFailure.connection.shortText))
        let noReading = try JSONDecoder().decode(Headline.self, from: Data(#"{"kind":"setup"}"#.utf8))
        XCTAssertEqual(noReading.cachedTitle(reason: StatusFailure.timeout.shortText), StatusFailure.timeout.shortText)
    }
}
