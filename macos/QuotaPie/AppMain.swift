import AppKit
import SwiftUI
import UserNotifications
import OSLog
import Combine
import Network

@main
struct QuotaPieApp {
    static func main() {
        if CodexProfileShortcut.runIfNeeded() { return }
        let instance = SingleInstanceLock()
#if DEBUG
        let fixturePreview = AppVerification.current != nil || ProcessInfo.processInfo.environment["QUOTAPIE_DEBUG_AUTO_OPEN"] == "1"
#else
        let fixturePreview = false
#endif
        do {
            if !fixturePreview {
                guard try instance.acquire() else { return }
            }
        } catch {
            fputs("QuotaPie could not acquire its menu bar instance lock.\n", stderr)
            return
        }
#if DEBUG
        let instanceGuard = fixturePreview ? nil : MenuBarInstanceGuard()
#else
        let instanceGuard: MenuBarInstanceGuard? = MenuBarInstanceGuard()
#endif
        withExtendedLifetime((instance, instanceGuard)) {
            let app = NSApplication.shared
            let delegate = AppDelegate()
            app.setActivationPolicy(.accessory)
            app.delegate = delegate
            instanceGuard?.start()
            app.run()
        }
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate, NSPopoverDelegate {
    private var statusItem: NSStatusItem!
    private let popover = NSPopover()
    private let popoverModel = PopoverModel()
    private var notch: NotchController?
    private let claudeFocusReader = ClaudeFocusReader()
    private var focusGeneration = 0
    private let resumeLauncher = ResumeLauncher()
    private let accountLauncher = CodexProfileLauncher()
    private let userNotificationCenter = UNUserNotificationCenter.current()
    private var client: StatusClient?
    private var usageWindow: UsageWindowController?
    private var settingsWindow: SettingsWindowController?
    private var updateSettingsWindow: UpdateSettingsWindowController?
    private let updateSettingsPolicy = UpdateSettingsReviewPolicy()
    private var notificationPresenter: NotificationPresenter?
    private var notificationTimer: Timer?
    private var refreshTimer: Timer?
    private var conversationFocusTimer: Timer?
    private var lastConversationRefresh = Date.distantPast
    private var selectionSubscription: AnyCancellable?
    private var activationObserver: NSObjectProtocol?
    private var lifecycleObservers: [NSObjectProtocol] = []
    private let profileUpdateMonitor = CodexProfileUpdateMonitor(profiles: { CodexProfilesModel.shared.automaticRestorationProfiles },
        defaults: .standard, installShortcuts: true)
    private let verification = AppVerification.current
    private var isFixturePreview: Bool {
#if DEBUG
        return verification != nil || ProcessInfo.processInfo.environment["QUOTAPIE_DEBUG_AUTO_OPEN"] == "1"
#else
        return false
#endif
    }
    private var usesFastQuota: Bool { !isFixturePreview || verification?.fastQuota == true }
    private var renderedAccountID: String?
    private let menuLogger = Logger(subsystem: "local.quotapie.menubar", category: "MenuBar")
    private let quotaRequests = QuotaRequestGate()
    private var isFetchingDetails = false
    private var lastDetailsFetchAt: Date?
    private var collectionRequests = CollectionRequestGate()
    private var collectionActionToken: String?
    private var recoveryPolling = QuotaRecoveryPolling()
    private var systemWakeMonitor: SystemWakeMonitor?
    private var wakeObserver: NSObjectProtocol?
    private var networkMonitor: NWPathMonitor?
    private var networkWasAvailable: Bool?
    private var quotaCache: QuotaSnapshotCache?
    private var transportRecovery = QuotaTransportRecovery()
    private let statusLogger = Logger(subsystem: "local.quotapie.menubar", category: "StatusSync")
    private var requestCatalogCompletions: [RequestAccountCatalogCompletion] = []
#if DEBUG
    private var debugWindow: NSWindow?
#endif

    func applicationWillFinishLaunching(_ notification: Notification) {
        do {
            let client = try StatusClient(environment: verification.map { ["QUOTAPIE_API_URL": $0.endpoint] }
                                          ?? ProcessInfo.processInfo.environment)
            self.client = client
            popoverModel.statusClient = client
            if isFixturePreview {
                if let verification, verification.fastQuota == true {
                    // The verifier may only read/write its own temporary cache.
                    let reportDirectory = URL(fileURLWithPath: verification.reportPath).deletingLastPathComponent()
                    if let path = verification.quotaCachePath,
                       URL(fileURLWithPath: path).deletingLastPathComponent() == reportDirectory {
                        quotaCache = QuotaSnapshotCache(endpoint: client.baseURL.absoluteString, url: URL(fileURLWithPath: path))
                        if let snapshot = quotaCache?.load() { popoverModel.applyCachedQuota(snapshot) }
                    }
                    collectionRequests.request("startup")
                }
                return
            }
            let cache = QuotaSnapshotCache(endpoint: client.baseURL.absoluteString)
            quotaCache = cache
            if let snapshot = cache.load() { popoverModel.applyCachedQuota(snapshot) }
            collectionRequests.request("startup")
            let presenter = NotificationPresenter(
                client: client,
                scheduler: UserNotificationScheduler(center: userNotificationCenter),
                openAutoResume: { [weak self] in
                    self?.showPopover()
                    self?.popoverModel.showDetails(.work)
                },
                openPopover: { [weak self] in self?.showPopover() }
            )
            notificationPresenter = presenter
            userNotificationCenter.delegate = presenter
        } catch {
            popoverModel.lastError = error.localizedDescription
            popoverModel.statusFailure = StatusFailure(error)
        }
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.button?.toolTip = Strings.t("status.tooltip")
        statusItem.button?.target = self
        statusItem.button?.action = #selector(togglePopover)
        // A fixture preview is a development window, never a second live meter.
        statusItem.isVisible = !isFixturePreview

        popover.behavior = .transient
        popover.animates = false
        popover.delegate = self

        if !isFixturePreview {
            notch = NotchController { [weak self] in
                guard let self else { return }
                if let account = self.popoverModel.menuAccount { self.popoverModel.showAccount(account) }
                else { self.popoverModel.showAccountList() }
                self.showPopover()
            }
            AwakeController.shared.start()
            profileUpdateMonitor.start()
            installCollectionRecoveryObservers()
        }
        installPopoverContent()
        installKeyboardShortcuts()
        selectionSubscription = popoverModel.$selectedAccountID
            .removeDuplicates()
            .receive(on: RunLoop.main)
            .sink { [weak self] _ in self?.render() }
        if verification == nil {
            activationObserver = NSWorkspace.shared.notificationCenter.addObserver(
                forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main
            ) { [weak self] notification in
                guard let app = notification.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication else { return }
                self?.followHostFocus(app)
            }
            lifecycleObservers = [NSWorkspace.didLaunchApplicationNotification, NSWorkspace.didTerminateApplicationNotification].map { name in
                NSWorkspace.shared.notificationCenter.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                    let workspace = NSWorkspace.shared
                    guard let self else { return }
                    self.popoverModel.reconcileRunningCodexAccounts(
                        frontmost: workspace.frontmostApplication.flatMap(self.codexIdentity),
                        running: workspace.runningApplications.compactMap(self.codexIdentity),
                        profiles: CodexProfilesModel.shared.profiles)
                }
            }
            let workspace = NSWorkspace.shared
            let running = workspace.runningApplications.compactMap(codexIdentity)
            popoverModel.selectInitialCodexAccount(
                frontmost: workspace.frontmostApplication.flatMap(codexIdentity),
                running: running, profiles: CodexProfilesModel.shared.profiles
            )
            if let app = workspace.frontmostApplication { followHostFocus(app) }
        } else if let verification {
            verification.selectInitialAccount(in: popoverModel)
        }
        render()
        if verification?.fastQuota == true, popoverModel.showingStartupCache {
            recordVerification(phase: "cache")
        }
        refresh()
        if !isFixturePreview {
            // Switching tabs inside Codex does not activate a new application.
            // Track it independently of quota collection and popover opening.
            conversationFocusTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
                self?.refreshConversationFocus()
            }
            if let conversationFocusTimer { RunLoop.main.add(conversationFocusTimer, forMode: .common) }
            notificationTimer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in
                guard let self, let token = self.currentActionToken else { return }
                self.notificationPresenter?.statusDidRefresh(actionToken: token)
            }
            if let notificationTimer { RunLoop.main.add(notificationTimer, forMode: .common) }
        }
        verification?.armTimeout()

        if !isFixturePreview, let installation = QuotaPieInstallation.read(),
           let review = updateSettingsPolicy.review(for: installation) {
            updateSettingsWindow = UpdateSettingsWindowController(review: review, model: popoverModel, actions: popoverActions,
                complete: { [weak self] alwaysKeep in
                    self?.updateSettingsPolicy.complete(installation, alwaysKeep: alwaysKeep)
                })
            DispatchQueue.main.async { [weak self] in
                self?.updateSettingsWindow?.present()
                self?.lastDetailsFetchAt = nil
                self?.refreshDetailsIfNeeded()
            }
        }

        if !isFixturePreview, popoverModel.focusedResumeTaskID != nil {
            popoverModel.detailSection = .work
            showPopover()
        }

#if DEBUG
        if ProcessInfo.processInfo.environment["QUOTAPIE_DEBUG_AUTO_OPEN"] == "1" {
            DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in
                self?.showDebugWindow()
            }
        }
#endif
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        popoverModel.showAccountList()
        showPopover()
        return true
    }

    func application(_ application: NSApplication, open urls: [URL]) {
        guard let route = urls.compactMap({ QuotaPieRoute(url: $0) }).first else { return }
        if case .resume(let id) = route {
            // A task link has its own account context, independent of a prior
            // inspection left in the popover.
            popoverModel.showAccountList()
            popoverModel.showDetails(.work, taskID: id)
            showPopover()
        } else if case .session(let id) = route {
            popoverModel.showAccountList()
            popoverModel.inspectedConversationID = id
            showPopover()
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        notch?.stop()
        profileUpdateMonitor.stop()
        networkMonitor?.cancel()
        systemWakeMonitor?.stop()
        quotaRequests.cancel()
        if let wakeObserver { NSWorkspace.shared.notificationCenter.removeObserver(wakeObserver) }
        refreshTimer?.invalidate()
        conversationFocusTimer?.invalidate()
        notificationTimer?.invalidate()
        if let activationObserver { NSWorkspace.shared.notificationCenter.removeObserver(activationObserver) }
        for observer in lifecycleObservers { NSWorkspace.shared.notificationCenter.removeObserver(observer) }
        selectionSubscription?.cancel()
        if !isFixturePreview { AwakeController.shared.stop() }
    }

    private func followHostFocus(_ app: NSRunningApplication) {
        focusGeneration += 1
        guard let provider = FocusedProvider(bundleIdentifier: app.bundleIdentifier) else {
            renderNotch()
            return
        }
        popoverModel.followProvider(provider)
        if provider == .claude {
            popoverModel.claudeSessionFingerprint = nil
            readClaudeFocus(force: true)
        } else if let identity = codexIdentity(app) {
            popoverModel.followCodexFocus(identity, profiles: CodexProfilesModel.shared.profiles)
        }
        refreshConversationFocus()
        render()
    }

    private func readClaudeFocus(force: Bool = false) {
        let generation = focusGeneration
        claudeFocusReader.read(force: force) { [weak self] fingerprint in
            guard let self, self.focusGeneration == generation, self.popoverModel.focusedProvider == .claude else { return }
            if self.popoverModel.claudeSessionFingerprint != fingerprint {
                self.popoverModel.claudeSessionFingerprint = fingerprint
                self.render()
            }
        }
    }

    private func renderNotch() {
        notch?.update(NotchSnapshot(model: popoverModel),
                      visible: FocusedProvider(bundleIdentifier: NSWorkspace.shared.frontmostApplication?.bundleIdentifier) != nil)
    }

    private func refreshConversationFocus() {
        guard !isFixturePreview else { return }
        if FocusedProvider(bundleIdentifier: NSWorkspace.shared.frontmostApplication?.bundleIdentifier) == .claude {
            readClaudeFocus()
        }
        renderNotch()
        if let focus = FocusedConversation.read(catalog: popoverModel.requestAccountCatalog) {
            let changed = popoverModel.focusedConversationTitle != focus.title || popoverModel.focusedConversationID != focus.threadID
            popoverModel.focusedConversationTitle = focus.title
            popoverModel.focusedConversationID = focus.threadID
            if changed { lastConversationRefresh = .distantPast; render() }
        }
        guard FocusedConversation.isHostFrontmost || popover.isShown,
              currentActionToken != nil, Date().timeIntervalSince(lastConversationRefresh) >= 10 else { return }
        lastConversationRefresh = Date()
        loadRequestAccounts { [weak self] _ in self?.render() }
    }

    private func codexIdentity(_ app: NSRunningApplication) -> CodexProcessIdentity? {
        guard app.bundleIdentifier == "com.openai.codex", !app.isTerminated else { return nil }
        return CodexProcessIdentity.read(pid: app.processIdentifier)
    }

    @objc private func togglePopover() {
        if popover.isShown {
            popover.performClose(nil)
            return
        }
        popoverModel.showAccountList()
        showPopover()
    }

    /// Notification clicks only open the UI. They never reuse the status-item
    /// toggle, because clicking a banner while the popover is visible must not
    /// close it again.
    private func showPopover() {
        guard let button = statusItem.button else { return }
        let available = statusItem.button?.window?.screen?.visibleFrame.height ?? NSScreen.main?.visibleFrame.height ?? 800
        popoverModel.popoverDetailHeight = min(600, max(300, available - 80))
        if !popover.isShown {
            refreshConversationFocus()
            popover.show(relativeTo: button.bounds, of: button, preferredEdge: .maxY)
        }
        loadRequestAccounts { [weak self] _ in self?.render() }
        // Read again immediately so the values are not already ageing by the
        // time the popover finishes opening.
        if usesFastQuota, !isFixturePreview { requestFreshCollection(reason: "visible") }
        else { refresh() }
        NSApp.activate(ignoringOtherApps: true)
    }

    private var popoverActions: PopoverActions {
        PopoverActions(
            refresh: { [weak self] in self?.requestFreshCollection(reason: "manual") },
            copy: { [weak self] in self?.copyStatus() },
            openDashboard: { [weak self] in self?.openDashboard() },
            openConfig: { [weak self] in self?.openConfig() },
            openNotificationSettings: {
                if let url = URL(string: "x-apple.systempreferences:com.apple.Notifications-Settings.extension?id=local.quotapie.menubar") {
                    NSWorkspace.shared.open(url)
                }
            },
            copyCommand: { [weak self] command in self?.copyToPasteboard(command) },
            resumeTask: { [weak self] task in self?.resume(task) },
            retryTask: { [weak self] task in self?.retry(task) },
            dismissTask: { [weak self] task in self?.dismiss(task) },
            quit: { NSApp.terminate(nil) },
            openAccount: { [weak self] account in self?.openAccount(account) },
            configureCompaction: { [weak self] model in self?.configureCompaction(model) },
            configureSavings: { [weak self] enabled, thread, tests in self?.configureSavings(enabled, thread, tests) },
            configurePool: { [weak self] enabled, account, reserve in self?.configurePool(enabled, account, reserve) },
            configureNotifications: { [weak self] key, enabled in self?.configureNotifications(key, enabled: enabled) },
            openRecentWork: { [weak self] item in self?.openRecentWork(item) },
            openUsageReport: { [weak self] in self?.openUsageReport() },
            openSettings: { [weak self] in self?.openSettingsWindow() },
            configureCredits: { [weak self] account, allow in self?.configureCredits(account: account, allow: allow) },
            restoreOriginalConnection: { [weak self] in self?.restoreOriginalConnection() },
            showRecoveryBackup: { [weak self] in
                if let url = self?.popoverModel.connectionRecoveryBackup { NSWorkspace.shared.open(url) }
            },
            loadRequestAccounts: { [weak self] completion in self?.loadRequestAccounts(completion: completion) },
            useRequestAccount: { [weak self] thread, account, completion in
                self?.useRequestAccount(threadID: thread, account: account, completion: completion)
            },
            configureNewConversations: { [weak self] account, completion in
                self?.configureNewConversations(account: account, completion: completion)
            }
        )
    }

    private func loadRequestAccounts(completion: @escaping RequestAccountCatalogCompletion) {
        guard let client, let token = currentActionToken else {
            completion(.failure(StatusClientError.missingActionToken)); return
        }
        requestCatalogCompletions.append(completion)
        guard requestCatalogCompletions.count == 1 else { return }
        client.requestAccounts(actionToken: token) { [weak self] result in
            DispatchQueue.main.async {
                guard let self else { return }
                let result = self.currentActionToken == token ? result : .failure(StatusClientError.missingActionToken)
                let completions = self.requestCatalogCompletions
                self.requestCatalogCompletions.removeAll()
                self.applyRequestAccountCatalog(result)
                completions.forEach { $0(result) }
            }
        }
    }

    private func applyRequestAccountCatalog(_ result: Result<RequestAccountCatalog, Error>) {
        switch result {
        case .success(let catalog):
            popoverModel.requestAccountCatalog = catalog
            popoverModel.requestAccountCatalogError = nil
        case .failure(let error):
            // Preserve verified historical attribution across a transient refresh failure.
            popoverModel.requestAccountCatalogError = error.localizedDescription
        }
        render()
    }

    private func configureCredits(account: String, allow: Bool) {
        guard !popoverModel.creditSaving, let client, let token = currentActionToken else { return }
        popoverModel.creditSaving = true
        client.configureCredits(account: account, allow: allow, actionToken: token) { [weak self] result in
            DispatchQueue.main.async {
                guard let self else { return }
                self.popoverModel.creditSaving = false
                self.applyRequestAccountCatalog(result)
                self.render()
            }
        }
    }

    private func configureNewConversations(account: String?, completion: @escaping RequestAccountCatalogCompletion) {
        guard let client, let token = currentActionToken else {
            completion(.failure(StatusClientError.missingActionToken)); return
        }
        client.configureNewConversations(account: account, actionToken: token) { [weak self] result in
            DispatchQueue.main.async {
                self?.applyRequestAccountCatalog(result)
                completion(result)
            }
        }
    }

    private func restoreOriginalConnection() {
        guard !popoverModel.connectionRestoring else { return }
        popoverModel.connectionRestoring = true
        popoverModel.connectionRecoveryMessage = nil
        OriginalConnectionRecovery.restore { [weak self] result in
            guard let self else { return }
            self.popoverModel.connectionRestoring = false
            switch result {
            case .success(let backup):
                self.popoverModel.connectionRecoveryBackup = backup
                self.popoverModel.connectionRecoveryMessage = Strings.t("connectionRecovery.done")
            case .failure(let error):
                self.popoverModel.connectionRecoveryMessage = error.localizedDescription
            }
            self.render()
        }
    }

    private func useRequestAccount(threadID: String, account: String, completion: @escaping RequestAccountAssignmentCompletion) {
        guard let client, let token = currentActionToken else {
            completion(.failure(StatusClientError.missingActionToken)); return
        }
        client.useRequestAccount(threadID: threadID, account: account, actionToken: token) { [weak self] result in
            DispatchQueue.main.async {
                if case .success(let assignment) = result, assignment.threadId == threadID, assignment.account == account {
                    self?.popoverModel.followRequestAccountSelection(assignment.account)
                    self?.render()
                }
                completion(result)
            }
        }
    }

    private func openAccount(_ account: AccountState) {
        guard !popoverModel.openingAccount else { return }
        popoverModel.accountOpenError = nil
        if account.provider == "claude" {
            guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.anthropic.claudefordesktop") else {
                popoverModel.accountOpenError = Strings.t("profiles.error.launch")
                return
            }
            popoverModel.openingAccount = true
            popover.performClose(nil)
            let configuration = NSWorkspace.OpenConfiguration()
            configuration.createsNewApplicationInstance = false
            configuration.activates = true
            NSWorkspace.shared.openApplication(at: url, configuration: configuration) { [weak self] application, error in
                DispatchQueue.main.async {
                    guard let self else { return }
                    self.popoverModel.openingAccount = false
                    if error != nil || application == nil {
                        self.popoverModel.accountOpenError = Strings.t("profiles.error.launch")
                        self.showPopover()
                    }
                }
            }
            return
        }
        guard account.provider == "codex" else { return }
        guard let profile = CodexDesktopProfile.forAccount(account.id, in: CodexProfilesModel.shared.profiles) else {
            popoverModel.accountOpenError = Strings.t("profiles.accountNotLinked")
            return
        }
        popoverModel.openingAccount = true
        // Dismiss before activation so menu dismissal cannot reclaim focus.
        popover.performClose(nil)
        accountLauncher.open(profile) { [weak self] result in
            guard let self else { return }
            self.popoverModel.openingAccount = false
            switch result {
            case .success:
                self.menuLogger.info("Account window activated")
            case .failure(let error):
                self.popoverModel.accountOpenError = error.localizedDescription
                self.menuLogger.error("Account window activation failed")
                self.showPopover()
            }
        }
    }

    @objc private func refreshVisibleSurface() {
        if usageWindow?.window?.isKeyWindow == true { usageWindow?.refreshReport() }
        else {
            if settingsWindow?.window?.isKeyWindow == true || updateSettingsWindow?.window?.isKeyWindow == true { lastDetailsFetchAt = nil }
            requestFreshCollection(reason: "manual")
            refreshDetailsIfNeeded()
        }
    }

    @objc private func openSettingsWindow() {
        popover.performClose(nil)
        if popoverModel.detailSection == .settings { popoverModel.showOverview() }
        if settingsWindow == nil { settingsWindow = SettingsWindowController(model: popoverModel, actions: popoverActions) }
        settingsWindow?.present()
        lastDetailsFetchAt = nil
        refreshDetailsIfNeeded()
    }

    private func openUsageReport() {
        popover.performClose(nil)
        if usageWindow == nil { usageWindow = UsageWindowController(model: popoverModel) }
        usageWindow?.present()
    }

    private func recordVerification(phase: String? = nil) {
        guard let verification else { return }
        if verification.initialSection == "settings" {
            if settingsWindow == nil {
                settingsWindow = SettingsWindowController(model: popoverModel, actions: popoverActions,
                    initialCategory: verification.settingsCategory.flatMap(SettingsCategory.init(rawValue:)) ?? .general)
            }
            verification.record(model: popoverModel, item: statusItem,
                content: settingsWindow?.window?.contentViewController, mountedWindow: settingsWindow?.window, phase: phase)
        } else {
            verification.record(model: popoverModel, item: statusItem, content: popover.contentViewController, phase: phase)
        }
    }

    private func installPopoverContent() {
        let actions = popoverActions
        let view = PopoverView(model: popoverModel, actions: actions)
        let controller = NSHostingController(rootView: view)
        controller.sizingOptions = [.preferredContentSize]
        popover.contentViewController = controller
    }

    /// Command-key shortcuts have to be real key equivalents.
    ///
    /// A local NSEvent monitor never sees them: AppKit routes command combinations
    /// through performKeyEquivalent on the key window and the main menu first, and
    /// drops them when nothing claims them, so they never arrive as a plain keyDown.
    /// An accessory app still owns a main menu even though the menu bar does not
    /// show it, which is where these belong.
    private func installKeyboardShortcuts() {
        let mainMenu = NSMenu()

        let appMenuItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: Strings.t("settings.organized.menu"), action: #selector(openSettingsWindow), keyEquivalent: ",")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: Strings.t("action.refresh"), action: #selector(refreshVisibleSurface), keyEquivalent: "r")
        appMenu.addItem(withTitle: Strings.t("action.copy"), action: #selector(copyStatus), keyEquivalent: "c")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: Strings.t("action.quit"), action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        for item in appMenu.items where item.action != nil && item.action != #selector(NSApplication.terminate(_:)) {
            item.target = self
        }
        appMenuItem.submenu = appMenu
        mainMenu.addItem(appMenuItem)
        let windowMenuItem = NSMenuItem()
        let windowMenu = NSMenu()
        windowMenu.addItem(withTitle: Strings.t("usage.window.close"), action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        windowMenuItem.submenu = windowMenu
        mainMenu.addItem(windowMenuItem)

        NSApp.mainMenu = mainMenu
    }

#if DEBUG
    private func showDebugWindow() {
        guard let controller = popover.contentViewController else { return }
        NSApp.setActivationPolicy(.regular)
        let window = NSWindow(contentViewController: controller)
        window.title = "QuotaPie · UI Preview"
        window.styleMask = [.titled, .closable, .resizable]
        window.setContentSize(NSSize(width: 380, height: 560))
        window.center()
        window.makeKeyAndOrderFront(nil)
        debugWindow = window
        NSApp.activate(ignoringOtherApps: true)
    }
#endif

    private func scheduleRefresh(after seconds: TimeInterval) {
        guard verification == nil || verification?.fastQuota == true else { return }
        refreshTimer?.invalidate()
        let delay = recoveryPolling.delay(normal: seconds, uptime: ProcessInfo.processInfo.systemUptime)
        refreshTimer = Timer.scheduledTimer(withTimeInterval: delay, repeats: false) { [weak self] _ in
            self?.refresh()
        }
        if let refreshTimer { RunLoop.main.add(refreshTimer, forMode: .common) }
    }

    private func configureNotifications(_ key: String, enabled: Bool) {
        guard !popoverModel.notificationSaving, let client, let token = currentActionToken else { return }
        popoverModel.beginNotificationSave()
        client.configureNotifications(key: key, enabled: enabled, actionToken: token) { [weak self] result in
            DispatchQueue.main.async {
                guard let self else { return }
                switch result {
                case .success(let response):
                    self.popoverModel.finishNotificationSave(response.notificationPreferences)
                    self.popoverModel.notificationSaveMessage = Strings.t("notification.preferences.saved")
                case .failure:
                    self.popoverModel.finishNotificationSave(nil)
                    self.popoverModel.notificationSaveMessage = Strings.t("notification.preferences.error")
                }
            }
        }
    }

    private func configurePool(_ enabled: Bool?, _ account: String?, _ reserve: Int?) {
        guard !popoverModel.poolSaving, let client, let token = currentActionToken else { return }
        popoverModel.beginPoolSave()
        popoverModel.poolSaveMessage = nil
        client.configurePool(enabled: enabled, account: account, reservePercent: reserve, actionToken: token) { [weak self] result in
            DispatchQueue.main.async {
                guard let self else { return }
                switch result {
                case .success(let response):
                    self.popoverModel.finishPoolSave(response.pool)
                    self.popoverModel.poolSaveMessage = Strings.t("pool.settings.saved")
                case .failure:
                    self.popoverModel.finishPoolSave(nil)
                    self.popoverModel.poolSaveMessage = Strings.t("pool.settings.error")
                }
                self.lastDetailsFetchAt = nil
                self.refresh()
            }
        }
    }

    private func configureSavings(_ enabled: Bool?, _ thread: String?, _ tests: Bool?) {
        guard !popoverModel.savingsSaving, let client, let token = currentActionToken else { return }
        popoverModel.beginSavingsSave()
        popoverModel.savingsMessage = nil
        client.configureSavings(enabled: enabled, bypassThread: thread, testOnly: tests, actionToken: token) { [weak self] result in
            DispatchQueue.main.async {
                guard let self else { return }
                switch result {
                case .success(let response):
                    self.popoverModel.finishSavingsSave(response.policy)
                    let acknowledged = response.policy.map { policy in
                        policy.applied > 0 && policy.applied == policy.compatible &&
                        (enabled == nil || policy.enabled == enabled) &&
                        (tests == nil || policy.testOnly == tests) &&
                        (thread == nil || policy.bypassThreads?.contains(thread!) == true)
                    } ?? false
                    self.popoverModel.savingsMessage = Strings.t(acknowledged ? "savings.saved" : "savings.pending")
                case .failure:
                    self.popoverModel.finishSavingsSave(nil)
                    self.popoverModel.savingsMessage = Strings.t("savings.error")
                }
                self.lastDetailsFetchAt = nil
                self.refresh()
            }
        }
    }

    private func configureCompaction(_ model: String) {
        guard !popoverModel.compactionSaving, let client, let token = currentActionToken else { return }
        popoverModel.beginCompactionSave()
        popoverModel.compactionSaveMessage = nil
        client.configureCompaction(model: model, actionToken: token) { [weak self] result in
            DispatchQueue.main.async {
                guard let self else { return }
                switch result {
                case .success(let response):
                    self.popoverModel.finishCompactionSave(response.policy)
                    self.popoverModel.compactionSaveMessage = Strings.t(response.policy?.model == model
                        ? "compaction.settings.saved" : "compaction.settings.error")
                case .failure:
                    self.popoverModel.finishCompactionSave(nil)
                    self.popoverModel.compactionSaveMessage = Strings.t("compaction.settings.error")
                }
                self.lastDetailsFetchAt = nil
                self.refresh()
            }
        }
    }

    private func installCollectionRecoveryObservers() {
        wakeObserver = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didWakeNotification, object: nil, queue: .main
        ) { [weak self] _ in self?.handleSystemWake(source: "workspace", atMs: Date().timeIntervalSince1970 * 1_000) }
        let power = SystemWakeMonitor(onSleep: { [weak self] in
            DispatchQueue.main.async { self?.recoveryPolling.didSleep() }
        }, onWake: { [weak self] source, atMs in
            DispatchQueue.main.async { self?.handleSystemWake(source: source, atMs: atMs) }
        })
        systemWakeMonitor = power
        if !power.start() { statusLogger.notice("Early wake observer unavailable; using workspace notifications") }
        let monitor = NWPathMonitor()
        networkMonitor = monitor
        monitor.pathUpdateHandler = { [weak self] path in
            DispatchQueue.main.async {
                guard let self else { return }
                let available = path.status == .satisfied
                let restored = self.networkWasAvailable == false && available
                self.networkWasAvailable = available
                if restored { self.requestFreshCollection(reason: "network") }
            }
        }
        monitor.start(queue: DispatchQueue(label: "local.quotapie.network"))
    }

    private func handleSystemWake(source: String, atMs: Double) {
        let accepted = recoveryPolling.acceptWake(uptime: ProcessInfo.processInfo.systemUptime)
        statusLogger.notice("Quota wake signal accepted=\(accepted) source=\(source, privacy: .public) signalAtMs=\(Int64(atMs)) mainAtMs=\(Int64(Date().timeIntervalSince1970 * 1_000))")
        guard accepted else { return }
        requestFreshCollection(reason: "wake")
    }

    private func requestFreshCollection(reason: String) {
        guard !isFixturePreview else { refresh(); return }
        collectionRequests.request(reason)
        // Opening the popover must not postpone details behind a new burst:
        // the service may intentionally coalesce a recent visible refresh.
        if reason != "visible" {
            recoveryPolling.begin(payload: popoverModel.payload, atMs: Date().timeIntervalSince1970 * 1_000,
                                  uptime: ProcessInfo.processInfo.systemUptime)
        }
        statusLogger.notice("Quota recovery requested reason=\(reason, privacy: .public) atMs=\(Int64(Date().timeIntervalSince1970 * 1_000))")
        // Only local quota requests are replaced. Rich details and host work
        // keep running, and the cancelled generation cannot alter current UI.
        if reason == "wake" || reason == "network" {
            resetQuotaTransport()
        } else { quotaRequests.cancel() }
        if reason != "visible" { lastDetailsFetchAt = nil }
        submitPendingCollectionRequest()
        refresh()
    }

    private func resetQuotaTransport() {
        // The shared session also owns the collection POST. Preserve its reason
        // before cancellation; its late callback must not clear a replacement.
        quotaRequests.cancel()
        collectionRequests.transportWasReplaced()
        transportRecovery.transportWasReplaced()
        client?.resetQuotaTransport()
    }

    private func submitPendingCollectionRequest() {
        guard let client, let token = collectionActionToken,
              let request = collectionRequests.begin() else { return }
        let reason = request.reason
        popoverModel.collectionRequestError = nil
        if recoveryPolling.isActive(uptime: ProcessInfo.processInfo.systemUptime) {
            statusLogger.notice("Quota collection submitted reason=\(reason, privacy: .public) atMs=\(Int64(Date().timeIntervalSince1970 * 1_000))")
        }
        client.refreshCollection(reason: reason, actionToken: token) { [weak self] result in
            DispatchQueue.main.async {
                guard let self else { return }
                let retry: Bool
                if case .failure = result { retry = true } else { retry = false }
                // Preserve a failed collection event, without retrying or
                // resuming any host work. Replaced callbacks are ignored.
                guard self.collectionRequests.finish(request, retry: retry) else { return }
                switch result {
                case .success(let collection):
                    self.popoverModel.applyCollectionRefresh(collection)
                    if self.recoveryPolling.isActive(uptime: ProcessInfo.processInfo.systemUptime) {
                        self.statusLogger.notice("Quota collection acknowledged atMs=\(Int64(Date().timeIntervalSince1970 * 1_000))")
                    }
                    self.render()
                case .failure(let error):
                    if case StatusClientError.httpStatus(let code) = error, (code == 401 || code == 403),
                       self.collectionActionToken == token {
                        self.collectionActionToken = nil
                    }
                    self.popoverModel.collectionRequestError = Strings.t("collection.requestFailed")
                }
                self.scheduleRefresh(after: 2)
            }
        }
    }

    @objc private func refresh() {
        guard let client, let generation = quotaRequests.begin() else { return }
        let requestStarted = ProcessInfo.processInfo.systemUptime
        let notificationRevision = popoverModel.notificationPreferencesRevision
        let savingsRevision = popoverModel.savingsPreferencesRevision
        let compactionRevision = popoverModel.compactionPreferencesRevision
        let receive: (Result<StatusPayload, Error>) -> Void = { [weak self] result in
            let responseReceived = ProcessInfo.processInfo.systemUptime
            DispatchQueue.main.async {
                guard let self, self.quotaRequests.finish(generation) else { return }
                let requestMs = Int((responseReceived - requestStarted) * 1_000)
                let mainQueueMs = Int((ProcessInfo.processInfo.systemUptime - responseReceived) * 1_000)
                var freshRecovery = false
                switch result {
                case .success(let payload):
                    if self.popoverModel.statusFailure != nil {
                        self.statusLogger.notice("Status connection recovered requestMs=\(requestMs) mainQueueMs=\(mainQueueMs)")
                    } else if requestMs >= 1_000 || mainQueueMs >= 1_000 {
                        self.statusLogger.notice("Quota fetch slow requestMs=\(requestMs) mainQueueMs=\(mainQueueMs)")
                    }
                    if !self.usesFastQuota {
                        self.popoverModel.applyStatus(payload, notificationRevision: notificationRevision)
                    } else {
                        self.popoverModel.applyQuota(payload, savingsRevision: savingsRevision,
                                                     compactionRevision: compactionRevision)
                        self.collectionActionToken = payload.actionToken.flatMap { $0.isEmpty ? nil : $0 }
                        freshRecovery = self.recoveryPolling.observe(payload, uptime: ProcessInfo.processInfo.systemUptime)
                        if freshRecovery {
                            let samples = payload.accounts.filter { $0.enabled && $0.collection.isHealthy }.flatMap { $0.windows.map(\.observedAtMs) }
                            self.statusLogger.notice("Quota recovery fresh payload atMs=\(Int64(Date().timeIntervalSince1970 * 1_000)) measuredMinMs=\(Int64(samples.min() ?? 0)) measuredMaxMs=\(Int64(samples.max() ?? 0))")
                        }
                    }
                    self.popoverModel.lastSuccessAt = Date()
                    self.popoverModel.lastError = nil
                    self.popoverModel.statusFailure = nil
                    self.transportRecovery.succeeded()
                    if !self.isFixturePreview, let actionToken = payload.actionToken, !actionToken.isEmpty {
                        self.userNotificationCenter.getNotificationSettings { [weak self] settings in
                            DispatchQueue.main.async {
                                guard let self else { return }
                                let allowed = settings.authorizationStatus == .authorized || settings.authorizationStatus == .provisional
                                self.popoverModel.notificationsAllowed = allowed
                                self.client?.notificationsAuthorized = allowed
                                self.notificationPresenter?.statusDidRefresh(actionToken: actionToken)
                            }
                        }
                    }
                    self.submitPendingCollectionRequest()
                    self.scheduleRefresh(after: payload.collection?.refreshing == true || (self.popover.isShown || self.settingsWindow?.window?.isVisible == true) || self.verification?.fastQuota == true ? 2 : 10)
                case .failure(let error):
                    let diagnostic = StatusFailure.diagnostic(error)
                    let retry = self.transportRecovery.failed(error)
                    self.statusLogger.error("Quota fetch failed: \(diagnostic, privacy: .public) requestMs=\(requestMs) mainQueueMs=\(mainQueueMs) failures=\(self.transportRecovery.failures) replaceTransport=\(retry.replaceTransport)")
                    self.popoverModel.statusFailure = StatusFailure(error)
                    self.popoverModel.lastError = error.localizedDescription
                    if retry.replaceTransport, self.usesFastQuota { self.resetQuotaTransport() }
                    self.scheduleRefresh(after: retry.delay)
                }
                self.render()
                if freshRecovery {
                    self.statusLogger.notice("Quota recovery menu rendered atMs=\(Int64(Date().timeIntervalSince1970 * 1_000))")
                }
                if case .success(let payload) = result {
                    try? self.quotaCache?.save(payload)
                    self.refreshDetailsIfNeeded()
                }
                self.recordVerification()
            }
        }
        if !usesFastQuota { client.fetch(completion: receive) }
        else { quotaRequests.attach(client.fetchQuota(completion: receive), generation: generation) }
    }

    private func refreshDetailsIfNeeded() {
        guard usesFastQuota, !recoveryPolling.isActive(uptime: ProcessInfo.processInfo.systemUptime),
              (popover.isShown || settingsWindow?.window?.isVisible == true || updateSettingsWindow?.window?.isVisible == true || verification?.fastQuota == true), !isFetchingDetails, let client,
              lastDetailsFetchAt.map({ Date().timeIntervalSince($0) >= 10 }) ?? true else { return }
        isFetchingDetails = true
        popoverModel.detailsLoading = true
        lastDetailsFetchAt = Date()
        let notificationRevision = popoverModel.notificationPreferencesRevision
        let quotaRevision = popoverModel.quotaRevision
        let poolRevision = popoverModel.poolPreferencesRevision
        let savingsRevision = popoverModel.savingsPreferencesRevision
        let compactionRevision = popoverModel.compactionPreferencesRevision
        client.fetch { [weak self] result in
            DispatchQueue.main.async {
                guard let self else { return }
                self.isFetchingDetails = false
                self.popoverModel.detailsLoading = false
                switch result {
                case .success(let payload):
                    self.popoverModel.applyStatus(payload, notificationRevision: notificationRevision,
                                                  quotaRevision: quotaRevision, poolRevision: poolRevision,
                                                  savingsRevision: savingsRevision, compactionRevision: compactionRevision)
                    let activeTaskIDs = Set((self.popoverModel.payload?.resumeTasks ?? []).filter(\.isActive).map(\.id))
                    self.popoverModel.resumeActivities = self.popoverModel.resumeActivities.filter { activeTaskIDs.contains($0.key) }
                    self.render()
                case .failure:
                    // Rich history is optional for the meter. A timeout here
                    // cannot erase a successful quota read or change its health.
                    self.popoverModel.detailsError = Strings.t("details.refreshFailed")
                }
                if self.verification?.fastQuota == true {
                    self.recordVerification()
                }
            }
        }
    }

    /// Show measured quota as a horizontal bar. Recovery actions and collection errors
    /// keep their text labels; cached quota must not look like a fresh reading.
    private let accountBadgeView: NSImageView = {
        let view = AccountBadgeImageView()
        view.translatesAutoresizingMaskIntoConstraints = false
        view.imageScaling = .scaleNone
        view.setAccessibilityElement(false)
        return view
    }()

    private func render() {
        guard let button = statusItem.button else { return }
        renderNotch()
        let scopedConversation = popoverModel.focusedConversation
        let selected = popoverModel.menuAccount
        let headline = selected.map(Headline.init(account:))
        let accountAttention = selected.flatMap(MenuBarAccountStatus.title(for:))
        let routingTitle = popoverModel.concurrentRoutingTitle
        let creditTitle = selected?.creditMenuTitle
        let badge = selected.map { AccountBadge(accountID: $0.id, name: $0.accountLabel) }
        let readyTasks = popoverModel.focusedProvider != .claude && scopedConversation == nil && popoverModel.canActOnTasks
            ? (popoverModel.payload?.resumeTasks.filter(\.isReady) ?? [])
            : []
        if readyTasks.isEmpty, !popoverModel.showingStartupCache, popoverModel.lastError == nil,
           accountAttention == nil, routingTitle == nil, creditTitle == nil,
           let headline, ["normal", "pace-risk"].contains(headline.kind),
           let provider = headline.provider,
           let remaining = headline.remainingPercent, remaining.isFinite {
            let providerName = provider == "codex" ? "Codex" : provider == "claude" ? "Claude" : provider
            let windowName = headline.windowKind.flatMap(Headline.windowName) ?? headline.windowLabel ?? ""
            let accountName = selected.map { String($0.accountLabel.prefix(16)) }
            let label = [accountName ?? providerName, windowName].filter { !$0.isEmpty }.joined(separator: " ")
            // The separate badge keeps its colour while macOS tints the quota image.
            if accountBadgeView.superview == nil {
                button.addSubview(accountBadgeView)
                NSLayoutConstraint.activate([
                    accountBadgeView.leadingAnchor.constraint(equalTo: button.leadingAnchor, constant: 6),
                    accountBadgeView.centerYAnchor.constraint(equalTo: button.centerYAnchor),
                    accountBadgeView.widthAnchor.constraint(equalToConstant: AccountBadge.menuSize),
                    accountBadgeView.heightAnchor.constraint(equalToConstant: AccountBadge.menuSize),
                ])
            }
            accountBadgeView.image = badge?.image()
            accountBadgeView.isHidden = badge == nil
            button.attributedTitle = NSAttributedString(string: "")
            button.image = MenuBarQuotaIndicator.image(label: label, remainingPercent: remaining, leadingSpace: badge == nil ? 0 : AccountBadge.menuSize + AccountBadge.menuSpacing)
            button.imagePosition = .imageOnly
            button.imageScaling = .scaleNone
            button.setAccessibilityLabel([headline.accountLabel, headline.localizedTitle].compactMap { $0 }.joined(separator: " · "))
            button.toolTip = [scopedConversation?.displayTitle, selected.map { $0.providerTitle + " · " + $0.accountLabel }, headline.localizedTitle, headline.localizedDetail, popoverModel.routingTooltip].compactMap { $0 }.joined(separator: "\n")
            if renderedAccountID != popoverModel.selectedAccount?.id {
                renderedAccountID = popoverModel.selectedAccount?.id
                let index = popoverModel.payload?.accounts.firstIndex { $0.id == renderedAccountID } ?? -1
                menuLogger.info("Rendered selected account index=\(index) image; matches popover=\(remaining == self.popoverModel.selectedAccount?.overviewWindow?.remainingPercent)")
            }
            return
        }
        accountBadgeView.isHidden = true
        let displayedAccount = readyTasks.first.flatMap { task in
            popoverModel.payload?.accounts.first { $0.provider == task.provider && $0.account == task.account }
        } ?? selected
        let fallbackBadge = displayedAccount.map { AccountBadge(accountID: $0.id, name: $0.accountLabel) }
        button.image = fallbackBadge?.image()
        button.imagePosition = fallbackBadge == nil ? .noImage : .imageLeading
        let title: String
        let color: NSColor
        let toolTip: String
        if let task = readyTasks.first {
            title = Strings.t("resume.readyCount", String(readyTasks.count))
            color = .systemBlue
            toolTip = Strings.t(
                "resume.readyTooltip",
                task.providerTitle,
                task.accountTitle,
                "\(task.projectLabel) \(task.shortReference)"
            )
        } else if popoverModel.showingStartupCache {
            title = headline?.cachedTitle ?? Strings.t("headline.checking")
            color = .secondaryLabelColor
            toolTip = [Strings.t("collection.previousReading"), self.popoverModel.measurementDate.map {
                Strings.t("collection.measuredAt", $0.formatted(date: .abbreviated, time: .shortened))
            }].compactMap { $0 }.joined(separator: "\n")
        } else if popoverModel.lastError != nil {
            title = headline?.cachedTitle(reason: popoverModel.statusFailure?.shortText)
                ?? popoverModel.statusFailure?.shortText ?? Strings.t("headline.disconnected")
            color = .systemOrange
            toolTip = popoverModel.lastError ?? Strings.t("status.tooltip")
        } else if let routingTitle {
            title = routingTitle
            color = .labelColor
            toolTip = scopedConversation.map { $0.displayTitle + "\n" + Strings.t("sessionAccount.unverified") } ?? popoverModel.routingTooltip ?? routingTitle
        } else if let creditTitle, let credits = selected?.credits {
            title = creditTitle
            color = .labelColor
            toolTip = [Strings.t("credits.subscriptionExhausted"), Strings.t("credits.observedDecrease", credits.decreaseText),
                       Strings.t("credits.balance", CreditUsage.amount(credits.balance ?? 0)),
                       Strings.t("credits.scope")].joined(separator: "\n")
        } else if let accountAttention {
            title = accountAttention
            color = .secondaryLabelColor
            toolTip = [selected?.collection.isHealthy == false ? selected?.collectionStatusText : accountAttention,
                       headline?.localizedTitle, popoverModel.measurementDate.map {
                           Strings.t("collection.measuredAt", $0.formatted(date: .abbreviated, time: .shortened))
                       }].compactMap { $0 }.joined(separator: "\n")
        } else {
            title = headline?.localizedTitle ?? Strings.t("headline.checking")
            if headline?.kind == "degraded" || headline?.kind == "setup" { color = .secondaryLabelColor }
            else if QuotaPresentation.isLow(headline?.remainingPercent) { color = .systemRed }
            else { color = .labelColor }
            toolTip = headline?.localizedDetail ?? Strings.t("status.tooltip")
        }
        button.attributedTitle = NSAttributedString(
            string: title,
            attributes: [
                .foregroundColor: color,
                .font: NSFont.monospacedDigitSystemFont(ofSize: 12, weight: .medium),
            ]
        )
        let accountTitle = displayedAccount.map { $0.providerTitle + " · " + $0.accountLabel }
        button.setAccessibilityLabel([accountTitle, title].compactMap { $0 }.joined(separator: " · "))
        button.toolTip = [accountTitle, toolTip, popoverModel.routingTooltip].compactMap { $0 }.joined(separator: "\n")
    }

    private func openRecentWork(_ item: RecentWork) {
        guard popoverModel.recentWorkActivities[item.id]?.isBusy != true else { return }
        guard let actionToken = currentActionToken else {
            popoverModel.recentWorkActivities[item.id] = .failed(Strings.t("client.missingActionToken"))
            return
        }
        guard let client else { return }
        popoverModel.recentWorkActivities[item.id] = .approving
        client.openRecentWork(id: item.id, actionToken: actionToken) { [weak self] result in
            DispatchQueue.main.async {
                guard let self else { return }
                switch result {
                case .failure(let error):
                    self.popoverModel.recentWorkActivities[item.id] = .failed(error.localizedDescription)
                case .success(let response):
                    self.popoverModel.recentWorkActivities[item.id] = .opening
                    self.resumeLauncher.openInTerminal(plan: response.plan, expectedProvider: item.provider) { [weak self] result in
                        DispatchQueue.main.async {
                            switch result {
                            case .success:
                                self?.popoverModel.recentWorkActivities.removeValue(forKey: item.id)
                            case .failure(let error):
                                self?.popoverModel.recentWorkActivities[item.id] = .failed(error.localizedDescription)
                            }
                        }
                    }
                }
            }
        }
    }

    private func resume(_ task: ResumeTask) {
        guard task.isReady,
              popoverModel.resumeActivities[task.id]?.isBusy != true else { return }
        guard let actionToken = currentActionToken else {
            popoverModel.resumeActivities[task.id] = .failed(Strings.t("client.missingActionToken"))
            return
        }
        guard confirmResume(task) else { return }
        guard let client else { return }

        popoverModel.resumeActivities[task.id] = .approving
        client.approveResumeTask(id: task.id, actionToken: actionToken) { [weak self] result in
            DispatchQueue.main.async {
                guard let self else { return }
                switch result {
                case .failure(let error):
                    self.popoverModel.resumeActivities[task.id] = .failed(error.localizedDescription)
                case .success(let approval):
                    guard approval.task.id == task.id,
                          approval.task.provider == task.provider,
                          approval.task.account == task.account,
                          approval.task.projectLabel == task.projectLabel,
                          approval.task.isApproved else {
                        self.popoverModel.resumeActivities[task.id] = .failed(
                            StatusClientError.invalidResponse.localizedDescription
                        )
                        return
                    }
                    self.popoverModel.resumeActivities[task.id] = .opening
                    self.resumeLauncher.openInTerminal(
                        plan: approval.plan,
                        expectedProvider: task.provider
                    ) { [weak self] launchResult in
                        DispatchQueue.main.async {
                            self?.finishLaunch(
                                task: task,
                                actionToken: actionToken,
                                result: launchResult
                            )
                        }
                    }
                }
            }
        }
    }

    /// A launch is recorded as resumed only after the one-shot file writes its
    /// start receipt. This confirms a session launch request, not provider work
    /// or goal completion. A failure stays approved so the user can inspect Terminal
    /// before deliberately resetting it; automatic retry could launch twice.
    private func finishLaunch(
        task: ResumeTask,
        actionToken: String,
        result: Result<Void, Error>
    ) {
        guard let client else { return }
        popoverModel.resumeActivities[task.id] = .updating
        switch result {
        case .success:
            client.transitionResumeTask(
                id: task.id,
                transition: .resumed,
                actionToken: actionToken
            ) { [weak self] transitionResult in
                DispatchQueue.main.async {
                    guard let self else { return }
                    switch transitionResult {
                    case .success:
                        self.popoverModel.resumeActivities.removeValue(forKey: task.id)
                        self.lastDetailsFetchAt = nil
                        self.refresh()
                    case .failure(let error):
                        self.popoverModel.resumeActivities[task.id] = .failed(error.localizedDescription)
                    }
                }
            }
        case .failure(let launchError):
            popoverModel.resumeActivities[task.id] = .failed(launchError.localizedDescription)
            refresh()
        }
    }

    private func retry(_ task: ResumeTask) {
        mutate(task, transition: .retry)
    }

    private func dismiss(_ task: ResumeTask) {
        mutate(task, transition: .dismiss)
    }

    private func mutate(_ task: ResumeTask, transition: ResumeTaskTransition) {
        guard popoverModel.resumeActivities[task.id]?.isBusy != true else { return }
        guard let actionToken = currentActionToken else {
            popoverModel.resumeActivities[task.id] = .failed(Strings.t("client.missingActionToken"))
            return
        }
        guard let client else { return }
        popoverModel.resumeActivities[task.id] = .updating
        client.transitionResumeTask(id: task.id, transition: transition, actionToken: actionToken) { [weak self] result in
            DispatchQueue.main.async {
                guard let self else { return }
                switch result {
                case .success:
                    self.popoverModel.resumeActivities.removeValue(forKey: task.id)
                    self.lastDetailsFetchAt = nil
                    self.refresh()
                case .failure(let error):
                    self.popoverModel.resumeActivities[task.id] = .failed(error.localizedDescription)
                }
            }
        }
    }

    private var currentActionToken: String? {
        guard !popoverModel.showingStartupCache, popoverModel.lastError == nil else { return nil }
        guard let token = popoverModel.payload?.actionToken, !token.isEmpty else { return nil }
        return token
    }

    /// This native confirmation is the product boundary: QuotaPie may prepare
    /// a session, but it never sends the first prompt or spends tokens itself.
    private func confirmResume(_ task: ResumeTask) -> Bool {
        NSApp.activate(ignoringOtherApps: true)
        let alert = NSAlert()
        alert.alertStyle = .informational
        alert.messageText = Strings.t("resume.confirmTitle")
        alert.informativeText = Strings.t(
            "resume.confirmMessage",
            task.providerTitle,
            task.accountTitle,
            task.projectLabel,
            task.shortReference,
            DisplayFormat.clock(task.registeredAtMs)
        )
        alert.addButton(withTitle: Strings.t("resume.confirmOpen"))
        alert.addButton(withTitle: Strings.t("resume.confirmCancel"))
        alert.buttons.first?.keyEquivalent = "\r"
        alert.buttons.last?.keyEquivalent = "\u{1b}"
        return alert.runModal() == .alertFirstButtonReturn
    }

    @objc private func copyStatus() { copyToPasteboard(plainStatus()) }

    private func copyToPasteboard(_ value: String) {
        let pasteboard = NSPasteboard.general
        pasteboard.clearContents()
        pasteboard.setString(value, forType: .string)
    }

    private func openDashboard() {
        guard let url = client?.baseURL else { return }
        NSWorkspace.shared.open(url)
    }

    private func openConfig() {
        let environment = ProcessInfo.processInfo.environment
        let path = NSString(string: environment["QUOTAPIE_CONFIG"] ?? "~/.config/quotapie/config.json")
            .expandingTildeInPath
        NSWorkspace.shared.open(URL(fileURLWithPath: path))
    }

    private func plainStatus() -> String {
        guard let payload = popoverModel.payload else { return Strings.t("status.noData") }
        var lines: [String] = []
        if let headline = payload.headline {
            lines.append(headline.localizedDetail.map { "\(headline.localizedTitle) — \($0)" } ?? headline.localizedTitle)
        }
        for account in payload.accounts {
            lines.append("\(account.providerTitle) · \(account.accountLabel)")
            if !account.collection.isHealthy {
                lines.append("  \(account.collectionStatusText)")
            }
            for window in account.windows {
                let used = window.usedPercent.map { Strings.t("window.used", String(Int($0.rounded()))) } ?? Strings.t("window.usageUnknown")
                let remaining = window.remainingPercent.map { Strings.t("window.remaining", String(Int($0.rounded()))) } ?? "—"
                lines.append("  \(window.shortLabel): \(used) · \(remaining) · \(DisplayFormat.resetStamp(window.resetsAtMs))")
                if let pace = window.paceText { lines.append("    \(pace)") }
            }
        }
        return lines.joined(separator: "\n")
    }
}
