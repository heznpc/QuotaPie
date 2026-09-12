import Foundation
import XCTest
@testable import QuotaPie

final class SemanticLocalizationTests: XCTestCase {
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
