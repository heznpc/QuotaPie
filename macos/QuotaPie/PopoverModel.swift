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
    var statusClient: StatusClient?
    let claudeDesktopConnection = ClaudeDesktopConnectionModel()
    @Published var automaticWorkLoadedPolicyIDs: [String]?

    @Published var payload: StatusPayload?
    @Published private(set) var showingStartupCache = false
    @Published private(set) var detailsLoaded = false
    @Published var detailsLoading = false
    @Published var detailsError: String?
    @Published var collectionRequestError: String?
    private(set) var quotaRevision = 0
    private(set) var poolPreferencesRevision = 0
    private(set) var savingsPreferencesRevision = 0
    private(set) var compactionPreferencesRevision = 0
    private var compactionProjectionAtMs: Double?
    @Published var lastError: String? {
        didSet {
            guard lastError != nil else { return }
            // A failed local quota read cannot keep a verified plan badge alive.
            // Bump the quota revision so an in-flight detail response cannot
            // restore that badge while the quota transport remains unavailable.
            quotaRevision += 1
            if var current = payload {
                for index in current.accounts.indices { current.accounts[index].plan = nil }
                payload = current
            }
        }
    }
    @Published var statusFailure: StatusFailure?
    @Published var notificationSaving = false
    @Published var notificationSaveMessage: String?
    private(set) var notificationPreferencesRevision = 0
    @Published var savingsSaving = false
    @Published var savingsMessage: String?
    @Published var poolSaving = false
    @Published var poolSaveMessage: String?
    @Published var compactionSaving = false
    @Published var compactionSaveMessage: String?
    @Published private(set) var autoResumeSaving = false
    private var autoResumeSavedAtMs: Double = 0

    func beginAutoResumeSave() { autoResumeSaving = true }

    func finishAutoResumeSave(_ value: AutoResumePayload?, nowMs: Double = Date().timeIntervalSince1970 * 1000) {
        if let value { payload?.autoResume = value }
        autoResumeSavedAtMs = nowMs
        autoResumeSaving = false
    }

    var statusFailureText: String {
        statusFailure?.detailText ?? Strings.t("popover.disconnected")
    }
    @Published var lastSuccessAt: Date?
    @Published var notificationsAllowed: Bool?
    @Published var resumeActivities: [String: ResumeTaskActivity] = [:]
    @Published var recentWorkActivities: [String: ResumeTaskActivity] = [:]
    @Published var openingAccount = false
    @Published var accountOpenError: String?
    @Published var requestAccountTarget: AccountState?
    @Published var requestAccountCatalog: RequestAccountCatalog?
    @Published var requestAccountCatalogError: String?
    @Published var creditSaving = false
    @Published var connectionRestoring = false
    @Published var connectionRecoveryMessage: String?
    @Published var connectionRecoveryBackup: URL?
    @Published var selectedAccountID: String?
    // Inspection is independent of the account followed by the menu bar meter.
    // Activating a different host must not replace an account the user is reading.
    @Published private(set) var inspectedAccountID: String?
    @Published var detailSection: DetailSection?
    @Published var popoverDetailHeight: CGFloat = 600

    func showDetails(_ section: DetailSection, taskID: String? = nil) {
        focusedResumeTaskID = taskID
        // Keep existing task links useful after moving work out of Activity.
        detailSection = taskID == nil ? section : .work
    }

    func showOverview() {
        detailSection = nil
        focusedResumeTaskID = nil
    }

    func showAccount(_ account: AccountState) {
        guard enabledAccounts.contains(where: { $0.id == account.id }) else { return }
        selectAccount(account)
        inspectedAccountID = account.id
        showOverview()
    }

    func showAccountList() {
        inspectedAccountID = nil
        showOverview()
    }

    func chooseRequestAccount(_ account: AccountState) {
        guard account.provider == "codex", account.enabled, canActOnTasks else { return }
        requestAccountTarget = account
    }

    func followRequestAccountSelection(_ accountID: String) {
        guard let account = enabledAccounts.first(where: { $0.provider == "codex" && $0.account == accountID }) else { return }
        // An observed active request still controls menuAccount. The idle meter
        // follows this preference without changing the account being inspected.
        selectAccount(account)
    }

    var isShowingAccountList: Bool { detailSection == nil && inspectedAccountID == nil }
    var enabledAccounts: [AccountState] { payload?.accounts.filter(\.enabled) ?? [] }

    var displayedAccount: AccountState? {
        guard let inspectedAccountID else { return selectedAccount }
        // A removed account must never silently become a different account.
        return enabledAccounts.first { $0.id == inspectedAccountID }
    }

    var detailBackTitle: String {
        Strings.t(inspectedAccountID == nil ? "navigation.accounts" : "navigation.overview")
    }

    @Published private(set) var detailLocationID = UUID()
    @Published var focusedResumeTaskID: String? {
        didSet { detailLocationID = UUID() }
    }

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

    func beginPoolSave() { poolSaving = true; poolPreferencesRevision += 1 }
    func finishPoolSave(_ value: AccountPoolPayload?) {
        if let value { payload?.accountPool = value }
        poolSaving = false
        poolPreferencesRevision += 1
    }

    func beginSavingsSave() { savingsSaving = true; savingsPreferencesRevision += 1 }
    func finishSavingsSave(_ value: TaskSavingsPolicy?) {
        if let value { payload?.compaction?.savings?.policy = value }
        savingsSaving = false
        savingsPreferencesRevision += 1
    }

    func beginCompactionSave() { compactionSaving = true; compactionPreferencesRevision += 1 }
    func finishCompactionSave(_ value: CompactionPolicy?) {
        if let value { payload?.compaction?.policy = value }
        compactionSaving = false
        compactionPreferencesRevision += 1
    }

    func applyCachedQuota(_ status: StatusPayload) {
        guard payload == nil, status.actionToken == nil else { return }
        payload = status
        showingStartupCache = true
    }

    /// Quota polls never erase detail data or preferences, and out-of-order
    /// responses cannot put an older reading or action token back on screen.
    func applyQuota(_ status: StatusPayload, savingsRevision: Int? = nil, compactionRevision: Int? = nil) {
        guard showingStartupCache || (status.nowMs ?? 0) >= (payload?.nowMs ?? 0) else { return }
        if var current = payload {
            current.nowMs = status.nowMs
            current.headline = status.headline
            current.accounts = status.accounts.map { account in
                account.preservingDetails(from: current.accounts.first { $0.id == account.id })
            }
            current.routing = status.routing
            current.actionToken = status.actionToken
            if let collection = status.collection, collection.supersedes(current.collection) {
                current.collection = collection
            }
            current.resumeTasks = status.resumeTasks
            if let autoResume = status.autoResume, !autoResumeSaving,
               autoResumeSavedAtMs == 0 || (status.nowMs ?? 0) > autoResumeSavedAtMs {
                current.autoResume = autoResume
            }
            if var compaction = status.compaction, acceptsCompaction(compaction, projectedAt: status.nowMs) {
                if compactionSaving || (compactionRevision != nil && compactionRevision != compactionPreferencesRevision) {
                    compaction.policy = current.compaction?.policy
                }
                if savingsSaving || (savingsRevision != nil && savingsRevision != savingsPreferencesRevision) {
                    if compaction.savings == nil { compaction.savings = current.compaction?.savings }
                    compaction.savings?.policy = current.compaction?.savings?.policy
                }
                current.compaction = compaction
                compactionProjectionAtMs = max(status.nowMs ?? compaction.checkedAtMs, compaction.checkedAtMs)
            }
            payload = current
        } else {
            payload = status
            if let compaction = status.compaction {
                compactionProjectionAtMs = max(status.nowMs ?? compaction.checkedAtMs, compaction.checkedAtMs)
            }
        }
        let activeTaskIDs = Set(status.resumeTasks.filter(\.isActive).map(\.id))
        resumeActivities = resumeActivities.filter { activeTaskIDs.contains($0.key) }
        showingStartupCache = false
        quotaRevision += 1
    }

    func applyCollectionRefresh(_ collection: CollectionRefreshState) {
        guard collection.supersedes(payload?.collection) else { return }
        payload?.collection = collection
    }

    private func acceptsCompaction(_ incoming: CompactionPayload, projectedAt: Double?) -> Bool {
        guard let current = payload?.compaction else { return true }
        if incoming.checkedAtMs != current.checkedAtMs { return incoming.checkedAtMs > current.checkedAtMs }
        // The same observation can become stale later without changing its
        // checkedAtMs. Track that projection independently of quota-only polls.
        return max(projectedAt ?? incoming.checkedAtMs, incoming.checkedAtMs)
            > (compactionProjectionAtMs ?? max(payload?.nowMs ?? current.checkedAtMs, current.checkedAtMs))
    }

    var measurementDate: Date? {
        guard selectedAccount?.hasUnavailableQuotaAccess != true else { return nil }
        guard let ms = selectedAccount?.overviewWindow?.observedAtMs ?? selectedAccount?.collection.lastSuccessAtMs,
              ms > 0, ms.isFinite else { return nil }
        return Date(timeIntervalSince1970: ms / 1_000)
    }

    var displayedMeasurementDate: Date? {
        guard displayedAccount?.hasUnavailableQuotaAccess != true else { return nil }
        guard let ms = displayedAccount?.overviewWindow?.observedAtMs ?? displayedAccount?.collection.lastSuccessAtMs,
              ms > 0, ms.isFinite else { return nil }
        return Date(timeIntervalSince1970: ms / 1_000)
    }

    func applyStatus(_ status: StatusPayload, notificationRevision: Int,
                     quotaRevision requestedQuotaRevision: Int? = nil, poolRevision: Int? = nil,
                     savingsRevision: Int? = nil, compactionRevision: Int? = nil) {
        var next = status
        // Keep other live status fields fresh while excluding preference
        // snapshots requested before or during the most recent save.
        if notificationSaving || notificationRevision != notificationPreferencesRevision {
            next.notificationPreferences = payload?.notificationPreferences
        }
        // A poll begun before the mutation completed must not undo its reply.
        // Both timestamps come from this Mac, independent of provider clocks.
        if autoResumeSaving || (autoResumeSavedAtMs > 0 && (status.nowMs ?? 0) <= autoResumeSavedAtMs) {
            next.autoResume = payload?.autoResume
        }
        if poolSaving || (poolRevision != nil && poolRevision != poolPreferencesRevision) {
            next.accountPool = payload?.accountPool
        }
        if compactionSaving || (compactionRevision != nil && compactionRevision != compactionPreferencesRevision) {
            if next.compaction == nil { next.compaction = payload?.compaction }
            next.compaction?.policy = payload?.compaction?.policy
        }
        if savingsSaving || (savingsRevision != nil && savingsRevision != savingsPreferencesRevision) {
            if next.compaction == nil { next.compaction = payload?.compaction }
            if next.compaction?.savings == nil { next.compaction?.savings = payload?.compaction?.savings }
            next.compaction?.savings?.policy = payload?.compaction?.savings?.policy
        }
        if !showingStartupCache, let current = payload,
           (status.nowMs ?? 0) < (current.nowMs ?? 0) || (requestedQuotaRevision != nil && requestedQuotaRevision != quotaRevision) {
            next.nowMs = current.nowMs
            next.headline = current.headline
            next.accounts = current.accounts.map { account in
                account.preservingDetails(from: status.accounts.first { $0.id == account.id })
            }
            next.routing = current.routing
            next.actionToken = current.actionToken
            next.collection = current.collection
            next.resumeTasks = current.resumeTasks
            if current.autoResume != nil { next.autoResume = current.autoResume }
        }
        if let incoming = next.compaction, acceptsCompaction(incoming, projectedAt: status.nowMs) {
            compactionProjectionAtMs = max(status.nowMs ?? incoming.checkedAtMs, incoming.checkedAtMs)
        } else { next.compaction = payload?.compaction }
        if next.collection?.supersedes(payload?.collection) != true {
            next.collection = payload?.collection
        }
        if lastError != nil, requestedQuotaRevision != nil {
            for index in next.accounts.indices { next.accounts[index].plan = nil }
        }
        payload = next
        showingStartupCache = false
        detailsLoaded = true
        detailsError = nil
    }

    var selectedAccount: AccountState? {
        let accounts = enabledAccounts
        return accounts.first { $0.id == selectedAccountID }
            ?? accounts.first { $0.provider == "codex" && $0.account == "default" }
            ?? accounts.first
    }

    /// This is the latest observed route, not a claim about the focused chat.
    var latestRoutedAccount: AccountState? {
        guard let request = payload?.accountPool?.recent.first else { return nil }
        return payload?.accounts.first { $0.provider == "codex" && $0.account == request.account }
    }

    var latestRoutedHeadline: Headline? { latestRoutedAccount.map(Headline.init(account:)) }

    private var followsAccountFocus = true

    func selectAccount(_ account: AccountState) {
        followsAccountFocus = false
        selectedAccountID = account.id
        accountOpenError = nil
    }

    var selectedHeadline: Headline? {
        selectedAccount.map(Headline.init(account:)) ?? payload?.headline
    }

    func followCodexFocus(_ identity: CodexProcessIdentity, profiles: [CodexDesktopProfile]) {
        guard let accountID = identity.collectionAccountID(in: profiles) else { return }
        followsAccountFocus = true
        selectedAccountID = accountID
    }

    /// Quota urgency is not evidence of which desktop account the user is using.
    /// When another app is frontmost, a single running Codex profile is unambiguous.
    func selectInitialCodexAccount(frontmost: CodexProcessIdentity?, running: [CodexProcessIdentity],
                                   profiles: [CodexDesktopProfile]) {
        followsAccountFocus = true
        reconcileRunningCodexAccounts(frontmost: frontmost, running: running, profiles: profiles)
    }

    /// Preserve an explicit inspection of an offline account. Automatic selection
    /// follows the remaining running account when the previously focused app exits.
    func reconcileRunningCodexAccounts(frontmost: CodexProcessIdentity?, running: [CodexProcessIdentity],
                                       profiles: [CodexDesktopProfile]) {
        guard followsAccountFocus else { return }
        if let accountID = frontmost?.collectionAccountID(in: profiles) {
            selectedAccountID = accountID
        } else {
            let accounts = Set(running.compactMap { $0.collectionAccountID(in: profiles) })
            if accounts.count == 1 { selectedAccountID = accounts.first }
            else if let selectedAccountID, !accounts.contains(selectedAccountID) { self.selectedAccountID = nil }
        }
    }

    var activeTasks: [ResumeTask] {
        (payload?.resumeTasks.filter(\.isActive) ?? []).sorted {
            if $0.isReady != $1.isReady { return $0.isReady }
            if $0.isApproved != $1.isApproved { return $0.isApproved }
            return $0.registeredAtMs > $1.registeredAtMs
        }
    }

    var taskOverviewSummary: String {
        let tasks = activeTasks
        return Strings.t("overview.taskCounts", String(tasks.filter(\.isReady).count),
                         String(tasks.filter(\.isApproved).count), String(tasks.filter(\.isWaiting).count))
    }

    var canActOnTasks: Bool { !showingStartupCache && lastError == nil && !(payload?.actionToken?.isEmpty ?? true) }

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

    var displayedRecovery: ObservedRecovery? {
        recentRecoveries.first { $0.accountID == displayedAccount?.id }
    }
}

enum DetailSection: String, CaseIterable, Identifiable {
    case quota, work, usage, activity, resets, settings
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
    var openAccount: (AccountState) -> Void = { _ in }
    var configureCompaction: (String) -> Void = { _ in }
    var configureSavings: (Bool?, String?, Bool?) -> Void = { _, _, _ in }
    var configurePool: (Bool?, String?, Int?) -> Void = { _, _, _ in }
    var configureNotifications: (String, Bool) -> Void = { _, _ in }
    var openRecentWork: (RecentWork) -> Void = { _ in }
    var openUsageReport: () -> Void = {}
    var openSettings: () -> Void = {}
    var configureCredits: (String, Bool) -> Void = { _, _ in }
    var restoreOriginalConnection: () -> Void = {}
    var showRecoveryBackup: () -> Void = {}
    var loadRequestAccounts: (@escaping RequestAccountCatalogCompletion) -> Void = {
        $0(.failure(StatusClientError.missingActionToken))
    }
    var useRequestAccount: (String, String, @escaping RequestAccountAssignmentCompletion) -> Void = { _, _, completion in
        completion(.failure(StatusClientError.missingActionToken))
    }
}

extension AccountState {
    /// A separate model allowance must not stand in for the general Codex quota.
    var overviewWindow: QuotaWindow? {
        guard !hasUnavailableQuotaAccess else { return nil }
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
