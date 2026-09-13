import SwiftUI

enum ResumeTaskActivity: Equatable {
    case approving
    case opening
    case updating
    case failed(String)

    var isBusy: Bool {
        switch self {
        case .approving, .opening, .updating: return true
        case .failed: return false
        }
    }
}

final class PopoverModel: ObservableObject {
    @Published var payload: StatusPayload?
    @Published var lastError: String?
    @Published var statusFailure: StatusFailure?
    @Published var notificationSaving = false
    @Published var notificationSaveMessage: String?
    private(set) var notificationPreferencesRevision = 0
    @Published var compactionSaving = false
    @Published var compactionSaveMessage: String?

    var statusFailureText: String {
        statusFailure?.detailText ?? Strings.t("popover.disconnected")
    }
    @Published var lastSuccessAt: Date?
    @Published var notificationsAllowed: Bool?
    @Published var resumeActivities: [String: ResumeTaskActivity] = [:]
    @Published var selectedAccountID: String?

    func beginNotificationSave() {
        notificationPreferencesRevision += 1
        notificationSaving = true
        notificationSaveMessage = nil
    }

    func finishNotificationSave(_ preferences: NotificationPreferences?) {
        notificationPreferencesRevision += 1
        if let preferences { payload?.notificationPreferences = preferences }
        notificationSaving = false
    }

    func applyStatus(_ status: StatusPayload, notificationRevision: Int) {
        var next = status
        // Keep other live status fields fresh while excluding preference
        // snapshots requested before or during the most recent save.
        if notificationSaving || notificationRevision != notificationPreferencesRevision {
            next.notificationPreferences = payload?.notificationPreferences
        }
        payload = next
    }

    var selectedAccount: AccountState? {
        let accounts = payload?.accounts.filter(\.enabled) ?? []
        return accounts.first { $0.id == selectedAccountID }
            ?? accounts.first { $0.provider == payload?.headline?.provider && $0.account == payload?.headline?.account }
            ?? accounts.first
    }

    var activeTasks: [ResumeTask] {
        (payload?.resumeTasks.filter(\.isActive) ?? []).sorted {
            if $0.isReady != $1.isReady { return $0.isReady }
            if $0.isApproved != $1.isApproved { return $0.isApproved }
            return $0.registeredAtMs > $1.registeredAtMs
        }
    }

    var canActOnTasks: Bool { lastError == nil && !(payload?.actionToken?.isEmpty ?? true) }

    /// Use the database-backed recovery lookback, independent of the short
    /// recent-events feed that routine events can push a refill out of.
    var recentRecoveries: [ObservedRecovery] {
        guard let payload, let tracking = payload.resetTracking else { return [] }
        return tracking.accounts.flatMap { tracked -> [ObservedRecovery] in
            guard let account = payload.accounts.first(where: {
                $0.enabled && $0.provider == tracked.provider && $0.account == tracked.account
            }) else { return [] }
            return tracked.windows.compactMap { window in
                guard let evidence = window.recovery, evidence.isObservedIncrease else { return nil }
                let label = account.windows.first { $0.bucket == window.bucket }?.shortLabel ?? window.label
                return ObservedRecovery(accountID: account.id,
                                        accountTitle: "\(account.providerTitle) · \(account.accountLabel)",
                                        bucket: window.bucket, label: label, evidence: evidence)
            }
        }.sorted { $0.evidence.observedByMs > $1.evidence.observedByMs }
    }

    var selectedRecovery: ObservedRecovery? {
        recentRecoveries.first { $0.accountID == selectedAccount?.id }
    }
}

enum DetailSection: String, CaseIterable, Identifiable {
    case quota, activity, resets, settings
    var id: String { rawValue }
    var title: String { Strings.t("detail." + rawValue) }
}

struct PopoverActions {
    let refresh: () -> Void
    let copy: () -> Void
    let openDashboard: () -> Void
    let openConfig: () -> Void
    let openNotificationSettings: () -> Void
    let copyCommand: (String) -> Void
    let resumeTask: (ResumeTask) -> Void
    let retryTask: (ResumeTask) -> Void
    let dismissTask: (ResumeTask) -> Void
    let quit: () -> Void
    var configureCompaction: (String) -> Void = { _ in }
    var configureNotifications: (String, Bool) -> Void = { _, _ in }
}

extension AccountState {
    /// A separate model allowance must not stand in for the general Codex quota.
    var overviewWindow: QuotaWindow? {
        let eligible = provider == "codex" ? windows.filter { $0.bucket.hasPrefix("codex:") } : windows
        return eligible.sorted {
            if ($0.freshness == "fresh") != ($1.freshness == "fresh") { return $0.freshness == "fresh" }
            let left = $0.windowSeconds.flatMap { $0 > 0 ? $0 : nil } ?? .infinity
            let right = $1.windowSeconds.flatMap { $0 > 0 ? $0 : nil } ?? .infinity
            if left != right { return left < right }
            return ($0.remainingPercent ?? 100) < ($1.remainingPercent ?? 100)
        }.first
    }
}
