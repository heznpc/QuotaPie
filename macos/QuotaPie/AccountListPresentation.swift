import Foundation

/// Show only observed limits. Model-only accounts keep their own limit label;
/// a model allowance never substitutes for a missing general quota.
struct AccountListPresentation {
    let fiveHour: QuotaWindow?
    let weekly: QuotaWindow?
    let visibleWindows: [QuotaWindow]
    let additionalLimitCount: Int

    init(account: AccountState) {
        guard !account.collection.hasUnavailableQuotaAccess else {
            fiveHour = nil
            weekly = nil
            visibleWindows = []
            additionalLimitCount = 0
            return
        }
        let general = account.windows.filter { window in
            switch account.provider {
            case "codex": return window.bucket.hasPrefix("codex:")
            case "claude": return ["five_hour", "seven_day"].contains(window.bucket)
            default: return false
            }
        }
        func reading(seconds: Double) -> QuotaWindow? {
            general.filter { $0.windowSeconds == seconds }.sorted {
                if ($0.freshness == "fresh") != ($1.freshness == "fresh") { return $0.freshness == "fresh" }
                if $0.observedAtMs != $1.observedAtMs { return $0.observedAtMs > $1.observedAtMs }
                return $0.bucket < $1.bucket
            }.first
        }
        fiveHour = reading(seconds: 5 * 3_600)
        weekly = reading(seconds: 7 * 86_400)
        let generalReadings = [fiveHour, weekly].compactMap { $0 }
        if generalReadings.isEmpty {
            let fallback = account.windows.first { $0.bucket == account.bottleneckBucket }
                ?? account.windows.sorted { $0.bucket < $1.bucket }.first
            visibleWindows = fallback.map { [$0] } ?? []
        } else {
            visibleWindows = generalReadings
        }
        let shownIDs = Set(visibleWindows.map(\.id))
        additionalLimitCount = account.windows.filter { !shownIDs.contains($0.id) }.count
    }

    static func resetTime(_ timestampMs: Double?, now: Date = Date()) -> String {
        knownResetTime(timestampMs, now: now) ?? "—"
    }

    static func knownResetTime(_ timestampMs: Double?, now: Date = Date()) -> String? {
        guard let timestampMs, timestampMs.isFinite, timestampMs > 0 else { return nil }
        let date = Date(timeIntervalSince1970: timestampMs / 1_000)
        let clock = DisplayFormat.clock(timestampMs)
        return Calendar.current.isDate(date, inSameDayAs: now) ? clock : "\(DisplayFormat.day(timestampMs)) \(clock)"
    }
}
