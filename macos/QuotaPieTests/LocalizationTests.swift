import Foundation
import XCTest
@testable import QuotaPie

final class LocalizationTests: XCTestCase {
    private let supportedLocalizations = Set(Strings.Language.allCases.map(\.rawValue))

    func testPackageAdvertisesEverySupportedLocalization() {
        let advertised = Set(Strings.packagedResourceBundle.localizations)
        XCTAssertTrue(
            supportedLocalizations.isSubset(of: advertised),
            "Missing bundle localizations: \(supportedLocalizations.subtracting(advertised).sorted())"
        )
        XCTAssertEqual(Strings.packagedResourceBundle.developmentLocalization, "en")
    }

    func testEveryEnglishKeyHasKoreanTranslation() throws {
        let english = try catalog(for: "en")
        let korean = try catalog(for: "ko")

        XCTAssertFalse(english.isEmpty)
        XCTAssertEqual(
            Set(english.keys),
            Set(korean.keys),
            "English and Korean catalogs must contain exactly the same keys"
        )

        for key in english.keys.sorted() {
            XCTAssertFalse(english[key, default: ""].isEmpty, "Empty English translation for \(key)")
            XCTAssertFalse(korean[key, default: ""].isEmpty, "Empty Korean translation for \(key)")
        }
    }

    func testFormatPlaceholdersMatchAcrossLocalizations() throws {
        let english = try catalog(for: "en")
        let korean = try catalog(for: "ko")

        for key in english.keys.sorted() {
            XCTAssertEqual(
                placeholders(in: english[key, default: ""]),
                placeholders(in: korean[key, default: ""]),
                "Format placeholders differ for \(key)"
            )
        }
    }

    func testArrayFormatterPreservesExistingVarargsBehavior() {
        let arguments: [CVarArg] = ["Codex", "primary"]
        XCTAssertEqual(
            Strings.format("alert.remaining.title", arguments: arguments),
            Strings.t("alert.remaining.title", "Codex", "primary")
        )
        XCTAssertEqual(Strings.t("localization.missing-key"), "localization.missing-key")
    }

    func testResolvedLanguageUsesItsLocalizedBundle() {
        let expected = Strings.language == .korean ? "새로고침" : "Refresh"
        XCTAssertEqual(Strings.t("action.refresh"), expected)
    }

    private func catalog(for localization: String) throws -> [String: String] {
        let bundle = Strings.packagedResourceBundle
        guard let url = bundle.url(
            forResource: "Localizable",
            withExtension: "strings",
            subdirectory: nil,
            localization: localization
        ) else {
            XCTFail("Missing Localizable.strings for \(localization)")
            return [:]
        }

        let data = try Data(contentsOf: url)
        let propertyList = try PropertyListSerialization.propertyList(from: data, format: nil)
        guard let strings = propertyList as? [String: String] else {
            XCTFail("Invalid Localizable.strings for \(localization)")
            return [:]
        }
        return strings
    }

    private func placeholders(in value: String) -> [String] {
        let pattern = #"(?<!%)%(?!%)(?:\d+\$)?[-+# 0']*(?:\d+|\*)?(?:\.(?:\d+|\*))?(?:hh|h|ll|l|L|z|t|j|q)?[@dDuUxXoOfFeEgGaAcCsSp]"#
        let expression = try! NSRegularExpression(pattern: pattern)
        let range = NSRange(value.startIndex..<value.endIndex, in: value)
        return expression.matches(in: value, range: range).compactMap { match in
            Range(match.range, in: value).map { String(value[$0]) }
        }
    }
}
