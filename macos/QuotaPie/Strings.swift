import Foundation

/// Resolves every sentence shown by the native app from its standard bundle
/// localization resources.
///
/// The normal path deliberately delegates language selection to `Bundle`, so
/// macOS system and per-app language preferences are respected. The environment
/// override remains available for deterministic fixture and screenshot runs.
enum Strings {
    enum Language: String, CaseIterable {
        case english = "en"
        case korean = "ko"
    }

    private struct Selection {
        let language: Language
        let bundle: Bundle
    }

    /// SwiftPM uses its generated resource bundle for `swift run` and tests.
    /// The assembled `.app` copies the same localizations into `Bundle.main`,
    /// which is the standard location macOS uses for per-app language choices.
    static let packagedResourceBundle = Bundle.module

    private static let standardResourceBundle: Bundle = {
        if Bundle.main.url(
            forResource: "Localizable",
            withExtension: "strings",
            subdirectory: nil,
            localization: Language.english.rawValue
        ) != nil {
            return .main
        }
        return packagedResourceBundle
    }()

    private static let selection: Selection = {
        let bundle = standardResourceBundle

        if let forced = ProcessInfo.processInfo.environment["QUOTAPIE_LOCALE"],
           let language = resolvedLanguage(for: forced),
           let localizedBundle = localizedBundle(for: language, in: bundle) {
            return Selection(language: language, bundle: localizedBundle)
        }

        let language = bundle.preferredLocalizations
            .lazy
            .compactMap(resolvedLanguage(for:))
            .first ?? .english
        return Selection(language: language, bundle: bundle)
    }()

    static var language: Language {
        selection.language
    }

    static func localeIdentifier() -> String {
        language == .korean ? "ko_KR" : "en_US"
    }

    /// Array-based formatting keeps semantic messages received from the local
    /// service on the same localization path as the app's own UI strings.
    static func format(_ key: String, arguments: [CVarArg]) -> String {
        let template = selection.bundle.localizedString(
            forKey: key,
            value: key,
            table: "Localizable"
        )
        guard !arguments.isEmpty else { return template }
        return String(
            format: template,
            locale: Locale(identifier: localeIdentifier()),
            arguments: arguments
        )
    }

    /// A missing key returns the key itself: visible in a screenshot rather
    /// than silently falling back to an unrelated language or an empty label.
    static func t(_ key: String, _ arguments: CVarArg...) -> String {
        format(key, arguments: arguments)
    }

    private static func resolvedLanguage(for identifier: String) -> Language? {
        let code = identifier
            .lowercased()
            .split(whereSeparator: { $0 == "-" || $0 == "_" || $0 == "." })
            .first
            .map(String.init)
        return code.flatMap(Language.init(rawValue:))
    }

    private static func localizedBundle(for language: Language, in bundle: Bundle) -> Bundle? {
        guard let path = bundle.path(forResource: language.rawValue, ofType: "lproj") else {
            return nil
        }
        return Bundle(path: path)
    }
}
