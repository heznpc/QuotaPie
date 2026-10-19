import Foundation

/// A short burst after a user-visible recovery event. Receiving another cached
/// HTTP snapshot is not completion: every baseline account needs a new sample.
struct QuotaRecoveryPolling {
    private(set) var startedAtMs: Double?
    private var deadline: TimeInterval = 0
    private var baseline: [String: Double] = [:]
    private var lastWakeUptime: TimeInterval?

    mutating func didSleep() { lastWakeUptime = nil; deadline = 0 }

    mutating func acceptWake(uptime: TimeInterval) -> Bool {
        if let previous = lastWakeUptime, uptime - previous < 10 { return false }
        lastWakeUptime = uptime
        return true
    }

    mutating func begin(payload: StatusPayload?, atMs: Double, uptime: TimeInterval) {
        startedAtMs = atMs
        deadline = uptime + 8
        baseline = Self.observations(payload)
    }

    func isActive(uptime: TimeInterval) -> Bool { uptime < deadline }

    func delay(normal: TimeInterval, uptime: TimeInterval) -> TimeInterval {
        guard isActive(uptime: uptime) else { return normal }
        return min(normal, deadline - uptime > 6 ? 0.15 : 0.3)
    }

    /// Returns true only once, after actual provider observations advance.
    mutating func observe(_ payload: StatusPayload, uptime: TimeInterval) -> Bool {
        guard isActive(uptime: uptime), let startedAtMs else { return false }
        let current = Self.observations(payload, requireFresh: true)
        let unavailable = Set(payload.accounts.filter { !Self.canCollect($0) }.map(\.id))
        let expected = (baseline.isEmpty ? current : baseline).filter { !unavailable.contains($0.key) }
        guard !expected.isEmpty, expected.allSatisfy({ key, previous in
            guard let value = current[key] else { return false }
            return value >= startedAtMs && (baseline.isEmpty || value > previous)
        }) else { return false }
        deadline = 0
        return true
    }

    private static func canCollect(_ account: AccountState) -> Bool {
        let requiresSetup = ["auth-required", "auth-expired", "not-configured", "isolation-unsafe", "claude-code-unavailable", "access-denied"]
        return account.enabled && !account.hasUnavailableQuotaAccess && !requiresSetup.contains(account.collection.errorCategory ?? account.collection.health)
    }

    private static func observations(_ payload: StatusPayload?, requireFresh: Bool = false) -> [String: Double] {
        Dictionary(uniqueKeysWithValues: (payload?.accounts ?? []).filter(Self.canCollect).compactMap { account in
            guard !requireFresh || (account.collection.isHealthy && account.windows.allSatisfy { $0.freshness == "fresh" }) else { return nil }
            guard let observed = account.windows.map(\.observedAtMs).filter({ $0.isFinite && $0 > 0 }).min() else { return nil }
            return (account.id, observed)
        })
    }
}
