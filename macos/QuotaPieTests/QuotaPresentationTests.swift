import AppKit
import XCTest
@testable import QuotaPie

final class QuotaPresentationTests: XCTestCase {
    func testAccountBadgeFollowsNicknameAndKeepsStableIdentityColour() {
        let original = AccountBadge(accountID: "codex/default", name: "want@example.invalid")
        let renamed = AccountBadge(accountID: "codex/default", name: "  완두콩즈 ")
        let other = AccountBadge(accountID: "codex/second", name: "heznpc@example.invalid")
        XCTAssertEqual(original.initial, "W")
        XCTAssertEqual(renamed.initial, "완")
        XCTAssertEqual(original.color, renamed.color)
        XCTAssertNotEqual(original.color, other.color)
        XCTAssertEqual(AccountBadge(accountID: "unknown", name: " ").initial, "?")
    }

    func testBadgeKeepsColourWhileQuotaUsesSystemMenuContrast() throws {
        let badge = AccountBadge(accountID: "codex/default", name: "Main")
        let renamed = AccountBadge(accountID: badge.accountID, name: "Long account nickname")
        let normal = MenuBarQuotaIndicator.image(label: "Codex", remainingPercent: 100)
        let low = MenuBarQuotaIndicator.image(label: "Codex", remainingPercent: 1)
        XCTAssertTrue(normal.isTemplate)
        XCTAssertFalse(low.isTemplate)
        XCTAssertEqual(normal.size, low.size)
        XCTAssertNil(AccountBadgeImageView(frame: NSRect(x: 0, y: 0, width: 18, height: 18)).hitTest(NSPoint(x: 9, y: 9)))
        XCTAssertFalse(badge.image().isTemplate)
        XCTAssertEqual(badge.image().size, NSSize(width: AccountBadge.menuSize, height: AccountBadge.menuSize))
        XCTAssertEqual(badge.image().size, renamed.image().size)
        XCTAssertEqual(MenuBarQuotaIndicator.image(label: "Codex", remainingPercent: 100, leadingSpace: 23).size.width, normal.size.width + 23)
        XCTAssertNotNil(badge.image().tiffRepresentation)
    }

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
