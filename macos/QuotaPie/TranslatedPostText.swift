import SwiftUI
import Translation
import NaturalLanguage

/// Translation is presentation only. The source evidence, classification, time
/// hints, and fingerprints always retain the exact original text.
struct TranslatedPostText: View {
    let text: String
    @State private var translated: String?
    @State private var unavailable = false
    @State private var showOriginal = false
    private var target: String { Strings.language.rawValue }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(translated ?? text).font(.body).textSelection(.enabled)
            if translated != nil {
                Text(Strings.t("translation.provider")).font(.caption).foregroundStyle(.secondary)
                DisclosureGroup(Strings.t("translation.original"), isExpanded: $showOriginal) {
                    Text(text).font(.body).textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading).padding(.top, 6)
                }.font(.caption)
            } else if unavailable {
                Text(Strings.t("translation.unavailable")).font(.caption).foregroundStyle(.secondary)
            }
        }
        .task(id: target + "\n" + text) {
            translated = nil
            unavailable = false
            guard let source = PostTranslation.sourceLanguage(text), source != target else { return }
            if #available(macOS 26.0, *) {
                do {
                    let result = try await PostTranslation.shared.translate(text, source: source, target: target)
                    try Task.checkCancellation()
                    translated = result
                    unavailable = result == nil
                } catch is CancellationError { } catch { unavailable = true }
            } else { unavailable = true }
        }
    }
}

actor PostTranslation {
    static let shared = PostTranslation()
    private var cache: [String: String] = [:]

    nonisolated static func sourceLanguage(_ text: String) -> String? {
        let recognizer = NLLanguageRecognizer()
        recognizer.processString(text)
        return recognizer.dominantLanguage?.rawValue
    }

    @available(macOS 26.0, *)
    func translate(_ text: String, source: String, target: String) async throws -> String? {
        let key = source + "\n" + target + "\n" + text
        if let cached = cache[key] { return cached }
        let sourceLanguage = Locale.Language(identifier: source)
        let targetLanguage = Locale.Language(identifier: target)
        // No hidden downloads or external translation API. If the local language
        // pair is unavailable the original stays readable with an explicit label.
        guard await LanguageAvailability().status(from: sourceLanguage, to: targetLanguage) == .installed else { return nil }
        try Task.checkCancellation()
        let session = TranslationSession(installedSource: sourceLanguage, target: targetLanguage)
        let result = try await session.translate(text).targetText
        guard !result.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        if cache.count >= 100 { cache.removeAll(keepingCapacity: true) }
        cache[key] = result
        return result
    }
}
