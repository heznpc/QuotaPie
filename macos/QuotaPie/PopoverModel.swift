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
    @Published var lastSuccessAt: Date?
    @Published var notificationsAllowed: Bool?
    @Published var resumeActivities: [String: ResumeTaskActivity] = [:]
    @Published var selectedAccountID: String?

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
