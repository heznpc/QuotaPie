import Foundation
import XCTest
@testable import QuotaPie

final class SemanticLocalizationTests: XCTestCase {
    func testAccountNotificationsRetainTheConfiguredAccountLabel() {
        for key in ["alert.event.title.account", "alert.event.title.plan", "alert.event.title.window",
                    "alert.event.title.payment", "alert.event.title.creditAdded", "alert.event.title.resetCredits", "alert.event.title.resync", "alert.remaining.title",
                    "alert.stale.title", "alert.rapid.title", "alert.pace.title.measured",
                    "alert.pace.title.projected", "alert.resume.ready.title"] {
            let personal = LocalizedMessagePayload(key: key, params: ["provider": .string("Codex"), "account": .string("개인 검증용")])
                .rendered(fallback: "UNSUPPORTED")
            let work = LocalizedMessagePayload(key: key, params: ["provider": .string("Codex"), "account": .string("업무 검증용")])
                .rendered(fallback: "UNSUPPORTED")
            XCTAssertTrue(personal.contains("개인 검증용"))
            XCTAssertTrue(work.contains("업무 검증용"))
            XCTAssertNotEqual(personal, work)
        }
    }

    func testEverySemanticCatalogKeyHasRendererArguments() throws {
        let bundle = Strings.packagedResourceBundle
        guard let url = bundle.url(
            forResource: "Localizable",
            withExtension: "strings",
            subdirectory: nil,
            localization: "en"
        ) else {
            return XCTFail("Missing English Localizable.strings")
        }
        let data = try Data(contentsOf: url)
        let propertyList = try PropertyListSerialization.propertyList(from: data, format: nil)
        let catalog = try XCTUnwrap(propertyList as? [String: String])
        let params: [String: MessageParameter] = [
            "provider": .string("codex"),
            "account": .string("work"),
            "label": .string("weekly"),
            "percent": .number(5),
            "threshold": .number(10),
            "minutes": .number(60),
            "drop": .number(12),
            "limitId": .string("primary"),
            "lane": .string("main"),
            "fromLabel": .string("5-hour"),
            "toLabel": .string("weekly"),
            "fromPlan": .string("plus"),
            "toPlan": .string("pro"),
        ]
        let semanticKeys = catalog.keys.filter {
            $0.hasPrefix("event.") || $0.hasPrefix("alert.")
        }

        XCTAssertFalse(semanticKeys.isEmpty)
        for key in semanticKeys.sorted() {
            let rendered = LocalizedMessagePayload(key: key, params: params)
                .rendered(fallback: "UNSUPPORTED")
            XCTAssertNotEqual(rendered, "UNSUPPORTED", "Missing native renderer mapping for \(key)")
            XCTAssertNotEqual(rendered, key, "Missing native localization for \(key)")
        }
    }

    func testCreditMessagesShowReportedValuesWithoutConfirmingBilling() {
        for key in ["event.credit_topup", "event.paid_usage"] {
            let rendered = LocalizedMessagePayload(key: key, params: [
                "provider": .string("Codex"), "balanceBefore": .number(0), "balanceAfter": .number(62500)
            ]).rendered(fallback: "STALE_CONFIRMED_BILLING")
            if key == "event.credit_topup" {
                XCTAssertEqual(rendered, Strings.t(key, "Codex", "0", "62500", 62500.formatted(.number)))
            } else {
                XCTAssertEqual(rendered, Strings.t(key, "Codex", "0", "62500"))
            }
            XCTAssertTrue(rendered.contains("0 → 62500"))
            let legacy = LocalizedMessagePayload(key: key, params: ["provider": .string("Codex")])
                .rendered(fallback: "STALE_CONFIRMED_BILLING")
            XCTAssertTrue(legacy.contains("? → ?"))
            XCTAssertFalse(legacy.contains("STALE_CONFIRMED_BILLING"))
        }
    }

    func testResetTicketNotificationsKeepCountsAndDoNotCallTheGrantAQuotaReset() {
        let added = LocalizedMessagePayload(key: "event.banked_reset_added", params: [
            "countBefore": .number(2), "countAfter": .number(3), "countAdded": .number(1)
        ]).rendered(fallback: "UNSUPPORTED")
        XCTAssertEqual(added, Strings.t("event.banked_reset_added", "2", "3", "1"))
        let consumed = LocalizedMessagePayload(key: "event.banked_reset_consumed", params: [
            "countBefore": .number(3), "countAfter": .number(2), "countUsed": .number(1)
        ]).rendered(fallback: "UNSUPPORTED")
        XCTAssertEqual(consumed, Strings.t("event.banked_reset_consumed", "3", "2", "1", ""))
        XCTAssertNotEqual(added, consumed)
        let recovered = LocalizedMessagePayload(key: "event.banked_reset_consumed", params: [
            "countBefore": .number(3), "countAfter": .number(2), "countUsed": .number(1), "quotaRecovered": .bool(true)
        ]).rendered(fallback: "UNSUPPORTED")
        XCTAssertEqual(recovered, consumed + Strings.t("resetTickets.recovered"))
    }

    func testEventRendersFromKindAndDetailsInsteadOfDaemonProse() throws {
        let data = Data(#"""
        {
          "provider": "codex",
          "account": "work",
          "kind": "window_changed",
          "severity": "info",
          "occurredAtMs": 1000,
          "displayText": "wrong daemon locale",
          "details": {
            "limitId": "primary",
            "lane": "main",
            "fromLabel": "5-hour",
            "toLabel": "weekly"
          }
        }
        """#.utf8)

        let event = try JSONDecoder().decode(QuotaEvent.self, from: data)

        XCTAssertEqual(
            event.localizedText,
            Strings.t("event.window_changed", "5-hour", "weekly")
        )
        XCTAssertNotEqual(event.localizedText, event.displayText)
    }

    func testUnknownEventKeepsCompatibilityRendering() throws {
        let data = Data(#"""
        {
          "provider": "codex",
          "account": "work",
          "kind": "future_event",
          "severity": "info",
          "occurredAtMs": 1000,
          "displayText": "A future daemon message",
          "details": {}
        }
        """#.utf8)

        let event = try JSONDecoder().decode(QuotaEvent.self, from: data)
        XCTAssertEqual(event.localizedText, "A future daemon message")
    }
}
