import Foundation

struct RoutingActivity: Decodable {
    let checkedAtMs: Double
    let freshness: String
    let active: [RequestRoute]
    let recent: [RequestRoute]
    var activityUncertain: Bool? = nil

    func isCurrent(at now: Date = Date()) -> Bool {
        let age = now.timeIntervalSince1970 * 1000 - checkedAtMs
        return freshness == "fresh" && checkedAtMs.isFinite && age >= -5_000 && age <= 30_000
    }
}

struct RequestRoute: Decodable, Identifiable {
    let requestId: String
    let threadId: String?
    let turnId: String?
    let kind: String
    let model: String?
    let phase: String
    let status: Int
    let startedAtMs: Double?
    let observedAtMs: Double
    let finishedAtMs: Double?
    let sourceAccount: String?
    let account: String?
    let attribution: String
    let reason: String?
    let switched: Bool?
    let active: Bool
    var upstreamResponseObserved: Bool? = nil
    var id: String { requestId }
    var hasKnownAccount: Bool { account != nil && ["pool-selection", "relay-source"].contains(attribution) }
    var hasVerifiedAccount: Bool { hasKnownAccount && upstreamResponseObserved == true }

    func accountLabel(in accounts: [AccountState]) -> String {
        guard hasKnownAccount,
              let match = accounts.first(where: { $0.provider == "codex" && $0.account == account }) else {
            return Strings.t("routing.unknownAccount")
        }
        return match.accountLabel
    }

    func routeLabel(in accounts: [AccountState]) -> String {
        let target = accountLabel(in: accounts)
        guard switched == true, let source = accounts.first(where: {
            $0.provider == "codex" && $0.account == sourceAccount
        }) else { return target }
        return source.accountLabel + " → " + target
    }

    var detailText: String {
        let phaseText = Strings.t(phase == "unverified" ? "routing.activityUnconfirmed" :
                                    upstreamResponseObserved != true ? (active ? "routing.awaitingResponse" : "routing.responseUnconfirmed") :
                                    active ? "routing.running" : phase == "completed" ? "routing.completed" : "routing.ended")
        return [kind == "compaction" ? Strings.t("routing.compaction") : nil,
                model.map { Strings.t("routing.requestedModel", CompactionRecord.shortModel($0)) }, phaseText].compactMap { $0 }.joined(separator: " · ")
    }
}

extension PopoverModel {
    var currentRoutes: [RequestRoute] {
        guard !showingStartupCache, lastError == nil, let routing = payload?.routing,
              routing.isCurrent() else { return [] }
        return routing.active
    }

    var activeRoutingAccounts: [AccountState] {
        let ids = Set(currentRoutes.filter(\.hasVerifiedAccount).compactMap(\.account))
        return enabledAccounts.filter { $0.provider == "codex" && ids.contains($0.account) }
    }

    var activeRoutingAccountIDs: Set<String> { Set(currentRoutes.filter(\.hasVerifiedAccount).compactMap(\.account)) }

    /// A menu badge follows observed request traffic, never the app's login alone.
    /// Unknown or concurrent routes cannot silently become one chosen account.
    var menuAccount: AccountState? {
        guard payload?.routing?.activityUncertain != true else { return nil }
        guard !currentRoutes.isEmpty else { return selectedAccount }
        guard currentRoutes.allSatisfy(\.hasVerifiedAccount), activeRoutingAccountIDs.count == 1,
              activeRoutingAccounts.count == 1 else { return nil }
        return activeRoutingAccounts.first
    }

    var concurrentRoutingTitle: String? {
        if payload?.routing?.activityUncertain == true { return Strings.t("routing.menu.unknown") }
        guard !currentRoutes.isEmpty, menuAccount == nil else { return nil }
        if currentRoutes.contains(where: { !$0.hasVerifiedAccount }) || activeRoutingAccountIDs.count != activeRoutingAccounts.count {
            return Strings.t("routing.menu.unknown")
        }
        return Strings.t("routing.menu.multiple", String(activeRoutingAccountIDs.count))
    }

    var routingTooltip: String? {
        if payload?.routing?.activityUncertain == true { return Strings.t("routing.unavailable") }
        guard !currentRoutes.isEmpty else { return nil }
        return Strings.t("routing.active") + "\n" + Set(currentRoutes.map { $0.routeLabel(in: enabledAccounts) }).sorted().joined(separator: "\n")
    }
}
