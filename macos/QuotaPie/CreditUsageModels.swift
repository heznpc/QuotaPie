import Foundation

/// Provider balance observations are account-wide. They are not a receipt for
/// a particular request, and credits have no fixed denominator for a percentage.
struct CreditUsage: Codable {
    let unit: String
    let balance: Double?
    let observedAtMs: Double?
    let freshness: String
    let subscriptionExhausted: Bool
    let spendingObserved: Bool
    let lastHour: Interval
    let attribution: String
    let billingVerified: Bool

    struct Interval: Codable {
        let fromMs: Double
        let toMs: Double
        let observedDecrease: Double?
        let observedIncrease: Double?
        let coveredMs: Double
        let sampleCount: Int
        let gapCount: Int
        let identityBreakCount: Int
        let coverage: String
    }

    func isCurrent(at now: Date = Date()) -> Bool {
        guard unit == "credits", freshness == "fresh", let observedAtMs,
              observedAtMs.isFinite, let balance, balance.isFinite, balance >= 0 else { return false }
        let age = now.timeIntervalSince1970 * 1000 - observedAtMs
        return age >= -5_000 && age <= 600_000
    }

    var decrease: Double? {
        guard let value = lastHour.observedDecrease, value.isFinite, value >= 0,
              lastHour.coverage != "unknown" else { return nil }
        return value
    }

    var decreaseText: String {
        guard let decrease else { return "—" }
        return Self.amount(decrease) + (lastHour.coverage == "partial" ? "*" : "")
    }

    func menuTitle(at now: Date = Date()) -> String? {
        guard isCurrent(at: now), subscriptionExhausted else { return nil }
        if let decrease, decrease > 0 {
            return Strings.t("credits.menu.decrease", Self.number(decrease))
        }
        return Strings.t("credits.menu.balance", Self.number(balance!))
    }

    static func amount(_ value: Double) -> String { Strings.t("credits.amount", number(value)) }

    static func number(_ value: Double) -> String {
        guard value.isFinite, value >= 0 else { return "—" }
        let formatter = NumberFormatter()
        formatter.numberStyle = .decimal
        formatter.minimumFractionDigits = 0
        formatter.maximumFractionDigits = value < 10 ? 2 : 1
        return formatter.string(from: NSNumber(value: value)) ?? "—"
    }
}

extension AccountState {
    var creditMenuTitle: String? {
        guard provider == "codex", collection.isHealthy,
              !windows.contains(where: { $0.metadata?.spendControlReached == true || $0.isResetTicketPending || $0.isUsagePermissionUnknown }),
              windows.allSatisfy({ $0.freshness == "fresh" }) else { return nil }
        return credits?.menuTitle()
    }

    /// Spend controls are distinct from an exhausted included allowance.
    var usageRestrictionText: String? {
        if windows.contains(where: { $0.metadata?.spendControlReached == true }) {
            return Strings.t("credits.spendControl")
        }
        if provider == "codex", windows.contains(where: { $0.freshness == "fresh" && $0.isExhausted }) {
            return Strings.t("credits.subscriptionExhausted")
        }
        return windows.contains(where: \.isUsageBlocked) ? Strings.t(provider == "codex" ? "accounts.list.limitBlocked" : "accounts.list.usageBlocked") : nil
    }
}
