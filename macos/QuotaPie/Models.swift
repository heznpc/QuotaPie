import Foundation

struct StatusPayload: Decodable {
    let nowMs: Double?
    let headline: Headline?
    let accounts: [AccountState]
    let events: [QuotaEvent]

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        nowMs = try values.decodeIfPresent(Double.self, forKey: .nowMs)
        headline = try values.decodeIfPresent(Headline.self, forKey: .headline)
        accounts = try values.decodeIfPresent([AccountState].self, forKey: .accounts) ?? []
        events = try values.decodeIfPresent([QuotaEvent].self, forKey: .events) ?? []
    }

    private enum CodingKeys: String, CodingKey { case nowMs, headline, accounts, events }
}

/// The conclusion for the menu bar. The service decides which one wins; the
/// app only draws it.
struct Headline: Decodable {
    let kind: String
    let provider: String?
    let account: String?
    let accountLabel: String?
    let bucket: String?
    let windowKind: String?
    let windowLabel: String?
    let remainingPercent: Double?
    let exhaustsAtMs: Double?
    let errorCategory: String?
    /// The backend's own rendering, kept as a fallback for anything this app
    /// has no localisation for. Prefer building the sentence from the fields
    /// above so the app follows the viewer's language, not the daemon's.
    let title: String
    let detail: String?

    /// The conclusion, said in the viewer's language.
    var localizedTitle: String {
        switch kind {
        case "pace-risk":
            guard let windowKind, let name = Self.windowName(windowKind) else { return title }
            return Strings.t("headline.atRisk", name)
        case "degraded": return Strings.t("headline.degraded")
        case "setup": return Strings.t("headline.setup")
        case "normal":
            guard let remainingPercent else { return title }
            return Strings.t("window.remaining", String(Int(remainingPercent.rounded())))
        default: return title
        }
    }

    /// The supporting line, also said in the viewer's language. Falling back to
    /// the backend's `detail` here is what left a Korean title sitting above an
    /// English sentence.
    var localizedDetail: String? {
        guard let provider else { return detail }
        let providerName = provider == "codex" ? "Codex" : provider == "claude" ? "Claude" : provider
        var parts = [providerName]
        if let accountLabel { parts.append(accountLabel) }
        switch kind {
        case "pace-risk", "normal":
            if let windowLabel { parts.append(windowLabel) }
            if kind == "pace-risk", let exhaustsAtMs {
                parts.append(Strings.t("headline.runsDryOn", DisplayFormat.day(exhaustsAtMs)))
            }
        case "degraded", "setup":
            parts.append(Strings.t("collection.\(errorCategory ?? "never-attempted")"))
        default:
            return detail
        }
        return parts.joined(separator: " · ")
    }

    static func windowName(_ kind: String) -> String? {
        switch kind {
        case "five-hour", "weekly", "monthly": return Strings.t("window.\(kind)")
        default: return nil
        }
    }
}

struct AccountState: Decodable, Identifiable {
    let provider: String
    let account: String
    let accountLabel: String
    let enabled: Bool
    let collection: CollectionState
    let windows: [QuotaWindow]
    let bottleneckBucket: String?
    let updatedAtMs: Double?

    var id: String { "\(provider)/\(account)" }
    var providerTitle: String { provider == "codex" ? "Codex" : provider == "claude" ? "Claude" : provider }
}

struct CollectionState: Decodable {
    let health: String
    let activeSource: String?
    let lastSuccessAtMs: Double?
    let errorCategory: String?
    let errorDetail: String?

    var isHealthy: Bool { health == "recent-success" }

    /// Phrased as something the user can act on. The raw provider error is kept
    /// as supporting detail only.
    var actionText: String {
        Strings.t("collection.\(errorCategory ?? health)")
    }

    /// A concrete recovery command is offered only when a login is what is missing.
    var recoveryCommand: String? {
        (errorCategory == "auth-required" || errorCategory == "auth-expired") ? "claude auth login" : nil
    }

    var sourceLabel: String {
        switch activeSource {
        case "claude-oauth", "codex-appserver": return Strings.t("source.official")
        case "claude-statusline": return Strings.t("source.statusline")
        default: return activeSource ?? "—"
        }
    }
}

struct QuotaWindow: Decodable, Identifiable {
    let provider: String
    let account: String
    let bucket: String
    let label: String
    let windowSeconds: Double?
    let freshness: String
    let observedAtMs: Double
    let usedPercent: Double?
    let remainingPercent: Double?
    let resetsAtMs: Double?
    let reservePercent: Double?
    let paceRatio: Double?
    let exhaustsAtMs: Double?
    let minutesBeforeReset: Double?
    let confidence: String?
    let riskLevel: String?

    var id: String { "\(provider)/\(account)/\(bucket)" }
    var isAtRisk: Bool { riskLevel == "at-risk" }
    var isWatch: Bool { riskLevel == "watch" }
    var isExhausted: Bool { (remainingPercent ?? 1) <= 0 }

    var shortLabel: String {
        guard let windowSeconds else { return label }
        if windowSeconds >= 28 * 86_400 { return Strings.t("window.monthly") }
        if windowSeconds >= 7 * 86_400 {
            if bucket.hasPrefix("seven_day_") {
                let suffix = bucket.dropFirst("seven_day_".count)
                let qualifier = suffix
                    .split(separator: "_")
                    .map { $0.prefix(1).uppercased() + $0.dropFirst() }
                    .joined(separator: " ")
                if !qualifier.isEmpty { return qualifier }
            }
            return Strings.t("window.weekly")
        }
        if windowSeconds <= 6 * 3_600 { return Strings.t("window.five-hour") }
        return label
    }

    /// One line of judgement about pace. With no measured burn, no risk is claimed.
    var paceText: String? {
        guard freshness == "fresh" else { return nil }
        if isExhausted { return Strings.t("window.exhausted") }
        if isAtRisk, let exhaustsAtMs {
            return Strings.t("window.runsDry", DisplayFormat.day(exhaustsAtMs))
        }
        if let paceRatio, paceRatio > 1 { return Strings.t("window.paceTight") }
        if paceRatio != nil { return Strings.t("window.paceComfortable") }
        return nil
    }
}

struct QuotaEvent: Decodable {
    let provider: String
    let account: String
    let kind: String
    let severity: String
    let occurredAtMs: Double
    let summary: String
}

enum DisplayFormat {
    static func duration(until timestampMs: Double?, now: Date = Date()) -> String {
        guard let timestampMs else { return Strings.t("window.resetUnknown") }
        return interval(milliseconds: max(0, timestampMs - now.timeIntervalSince1970 * 1_000))
    }

    static func interval(milliseconds: Double) -> String {
        let seconds = max(0, milliseconds / 1_000)
        let totalMinutes = Int((seconds / 60).rounded())
        let days = totalMinutes / 1_440
        let hours = (totalMinutes % 1_440) / 60
        let minutes = totalMinutes % 60
        if days > 0 { return Strings.t("time.days", String(days), String(hours)) }
        if hours > 0 { return Strings.t("time.hours", String(hours), String(minutes)) }
        return Strings.t("time.minutes", String(minutes))
    }

    static func clock(_ timestampMs: Double?) -> String {
        guard let timestampMs else { return "—" }
        return clockFormatter.string(from: Date(timeIntervalSince1970: timestampMs / 1_000))
    }

    /// Today shows the time alone; anything later shows the date with it.
    static func resetStamp(_ timestampMs: Double?, now: Date = Date()) -> String {
        guard let timestampMs else { return Strings.t("window.resetUnknown") }
        let date = Date(timeIntervalSince1970: timestampMs / 1_000)
        let calendar = Calendar.current
        let clock = clockFormatter.string(from: date)
        if calendar.isDate(date, inSameDayAs: now) { return Strings.t("window.resetsAt", clock) }
        return Strings.t("window.resetsAt", "\(dayFormatter.string(from: date)) \(clock)")
    }

    static func day(_ timestampMs: Double) -> String {
        dayFormatter.string(from: Date(timeIntervalSince1970: timestampMs / 1_000))
    }

    static func age(since date: Date, now: Date = Date()) -> String {
        let seconds = max(0, now.timeIntervalSince(date))
        if seconds < 60 { return Strings.t("time.justNow") }
        if seconds < 3_600 { return Strings.t("time.minutesAgo", String(Int(seconds / 60))) }
        return Strings.t("time.hoursAgo", String(Int(seconds / 3_600)))
    }

    private static let clockFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: Strings.localeIdentifier())
        formatter.dateFormat = "HH:mm"
        return formatter
    }()

    private static let dayFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: Strings.localeIdentifier())
        formatter.dateFormat = Strings.t("format.dayMonth")
        return formatter
    }()
}
