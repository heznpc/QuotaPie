import AppKit
import SwiftUI
import UserNotifications
import OSLog

@main
struct QuotaPieApp {
    static func main() {
        let app = NSApplication.shared
        let delegate = AppDelegate()
        app.setActivationPolicy(.accessory)
        app.delegate = delegate
        app.run()
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate, NSPopoverDelegate {
    private var statusItem: NSStatusItem!
    private let popover = NSPopover()
    private let popoverModel = PopoverModel()
    private var detailsWindow: DetailsWindowController?
    private let resumeLauncher = ResumeLauncher()
    private let userNotificationCenter = UNUserNotificationCenter.current()
    private var client: StatusClient?
    private var notificationPresenter: NotificationPresenter?
    private var refreshTimer: Timer?
    private var isFetching = false
    private var failureIndex = 0
    private let retrySeconds: [TimeInterval] = [2, 5, 15, 30]
    private let statusLogger = Logger(subsystem: "local.quotapie.menubar", category: "StatusSync")
#if DEBUG
    private var debugWindow: NSWindow?
#endif

    func applicationWillFinishLaunching(_ notification: Notification) {
        do {
            let client = try StatusClient()
            self.client = client
            let presenter = NotificationPresenter(
                client: client,
                scheduler: UserNotificationScheduler(center: userNotificationCenter),
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
#if DEBUG
        // A fixture preview is a development window, never a second live meter.
        statusItem.isVisible = ProcessInfo.processInfo.environment["QUOTAPIE_DEBUG_AUTO_OPEN"] != "1"
#endif

        popover.behavior = .transient
        popover.animates = false
        popover.delegate = self

#if DEBUG
        if ProcessInfo.processInfo.environment["QUOTAPIE_DEBUG_AUTO_OPEN"] != "1" {
            AwakeController.shared.start()
        }
#else
        AwakeController.shared.start()
#endif
        installPopoverContent()
        installKeyboardShortcuts()
        render()
        refresh()

        if popoverModel.focusedResumeTaskID != nil { detailsWindow?.show(.activity) }

#if DEBUG
        if ProcessInfo.processInfo.environment["QUOTAPIE_DEBUG_AUTO_OPEN"] == "1" {
            DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in
                self?.showDebugWindow()
            }
        }
#endif
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        showPopover()
        return true
    }

    func application(_ application: NSApplication, open urls: [URL]) {
        guard let route = urls.compactMap({ QuotaPieRoute(url: $0) }).first else { return }
        if case .resume(let id) = route {
            popoverModel.focusedResumeTaskID = id
            popover.performClose(nil)
            detailsWindow?.show(.activity)
            refresh()
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        refreshTimer?.invalidate()
        AwakeController.shared.stop()
    }

    @objc private func togglePopover() {
        if popover.isShown {
            popover.performClose(nil)
            return
        }
        showPopover()
    }

    /// Notification clicks only open the UI. They never reuse the status-item
    /// toggle, because clicking a banner while the popover is visible must not
    /// close it again.
    private func showPopover() {
        guard let button = statusItem.button else { return }
        if !popover.isShown {
            popover.show(relativeTo: button.bounds, of: button, preferredEdge: .maxY)
        }
        // Read again immediately so the values are not already ageing by the
        // time the popover finishes opening.
        refresh()
        NSApp.activate(ignoringOtherApps: true)
    }

    private var popoverActions: PopoverActions {
        PopoverActions(
            refresh: { [weak self] in self?.refresh() },
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
            configureCompaction: { [weak self] model in self?.configureCompaction(model) },
            configureSavings: { [weak self] enabled, thread in self?.configureSavings(enabled, thread) },
            configureNotifications: { [weak self] key, enabled in self?.configureNotifications(key, enabled: enabled) }
        )
    }

    private func installPopoverContent() {
        let actions = popoverActions
        detailsWindow = DetailsWindowController(model: popoverModel, actions: actions)
        let view = PopoverView(model: popoverModel, actions: actions, openDetails: { [weak self] section in
            self?.popover.performClose(nil)
            self?.detailsWindow?.show(section)
        })
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
        appMenu.addItem(withTitle: Strings.t("action.refresh"), action: #selector(refresh), keyEquivalent: "r")
        appMenu.addItem(withTitle: Strings.t("action.copy"), action: #selector(copyStatus), keyEquivalent: "c")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: Strings.t("action.quit"), action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        for item in appMenu.items where item.action != nil && item.action != #selector(NSApplication.terminate(_:)) {
            item.target = self
        }
        appMenuItem.submenu = appMenu
        mainMenu.addItem(appMenuItem)

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
        refreshTimer?.invalidate()
        refreshTimer = Timer.scheduledTimer(withTimeInterval: seconds, repeats: false) { [weak self] _ in
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

    private func configureSavings(_ enabled: Bool?, _ thread: String?) {
        guard !popoverModel.savingsSaving, let client, let token = currentActionToken else { return }
        popoverModel.savingsSaving = true
        popoverModel.savingsMessage = nil
        client.configureSavings(enabled: enabled, bypassThread: thread, actionToken: token) { [weak self] result in
            DispatchQueue.main.async {
                guard let self else { return }
                self.popoverModel.savingsSaving = false
                switch result {
                case .success: self.popoverModel.savingsMessage = Strings.t("savings.saved")
                case .failure: self.popoverModel.savingsMessage = Strings.t("savings.error")
                }
                self.refresh()
            }
        }
    }

    private func configureCompaction(_ model: String) {
        guard !popoverModel.compactionSaving, let client, let token = currentActionToken else { return }
        popoverModel.compactionSaving = true
        popoverModel.compactionSaveMessage = nil
        client.configureCompaction(model: model, actionToken: token) { [weak self] result in
            DispatchQueue.main.async {
                guard let self else { return }
                self.popoverModel.compactionSaving = false
                switch result {
                case .success(let response):
                    self.popoverModel.compactionSaveMessage = Strings.t(response.policy?.model == model
                        ? "compaction.settings.saved" : "compaction.settings.error")
                case .failure:
                    self.popoverModel.compactionSaveMessage = Strings.t("compaction.settings.error")
                }
                self.refresh()
            }
        }
    }

    @objc private func refresh() {
        guard !isFetching, let client else { return }
        isFetching = true
        let notificationRevision = popoverModel.notificationPreferencesRevision
        client.fetch { [weak self] result in
            DispatchQueue.main.async {
                guard let self else { return }
                self.isFetching = false
                switch result {
                case .success(let payload):
                    if self.popoverModel.statusFailure != nil {
                        self.statusLogger.notice("Status connection recovered")
                    }
                    self.popoverModel.applyStatus(payload, notificationRevision: notificationRevision)
                    let activeTaskIDs = Set(payload.resumeTasks.filter(\.isActive).map(\.id))
                    self.popoverModel.resumeActivities = self.popoverModel.resumeActivities.filter {
                        activeTaskIDs.contains($0.key)
                    }
                    self.popoverModel.lastSuccessAt = Date()
                    self.popoverModel.lastError = nil
                    self.popoverModel.statusFailure = nil
                    self.failureIndex = 0
                    if let actionToken = payload.actionToken, !actionToken.isEmpty {
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
                    self.scheduleRefresh(after: payload.compaction?.active.isEmpty == false || self.popover.isShown ? 2 : 10)
                case .failure(let error):
                    let failure = StatusFailure(error)
                    if self.popoverModel.statusFailure != failure {
                        self.statusLogger.error("Status fetch failed: kind=\(failure.rawValue, privacy: .public) code=\((error as NSError).code)")
                    }
                    self.popoverModel.statusFailure = failure
                    self.popoverModel.lastError = error.localizedDescription
                    let delay = self.retrySeconds[min(self.failureIndex, self.retrySeconds.count - 1)]
                    self.failureIndex = min(self.failureIndex + 1, self.retrySeconds.count - 1)
                    self.scheduleRefresh(after: delay)
                }
                self.render()
            }
        }
    }

    /// Show measured quota as a horizontal bar. Recovery actions and collection errors
    /// keep their text labels; cached quota must not look like a fresh reading.
    private func render() {
        guard let button = statusItem.button else { return }
        let headline = popoverModel.payload?.headline
        let readyTasks = popoverModel.lastError == nil
            ? (popoverModel.payload?.resumeTasks.filter(\.isReady) ?? [])
            : []
        if readyTasks.isEmpty, popoverModel.lastError == nil,
           let headline, ["normal", "pace-risk"].contains(headline.kind),
           let provider = headline.provider,
           let remaining = headline.remainingPercent, remaining.isFinite {
            let providerName = provider == "codex" ? "Codex" : provider == "claude" ? "Claude" : provider
            let windowName = headline.windowKind.flatMap(Headline.windowName) ?? headline.windowLabel ?? ""
            let label = [providerName, windowName].filter { !$0.isEmpty }.joined(separator: " ")
            button.attributedTitle = NSAttributedString(string: "")
            button.image = MenuBarQuotaIndicator.image(label: label, remainingPercent: remaining)
            button.imagePosition = .imageOnly
            button.imageScaling = .scaleNone
            button.setAccessibilityLabel(headline.localizedTitle)
            button.toolTip = [headline.localizedTitle, headline.localizedDetail].compactMap { $0 }.joined(separator: "\n")
            return
        }
        button.image = nil
        button.imagePosition = .noImage
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
        } else if popoverModel.lastError != nil {
            title = headline?.cachedTitle(reason: popoverModel.statusFailure?.shortText)
                ?? popoverModel.statusFailure?.shortText ?? Strings.t("headline.disconnected")
            color = .systemOrange
            toolTip = popoverModel.lastError ?? Strings.t("status.tooltip")
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
        button.setAccessibilityLabel(title)
        button.toolTip = toolTip
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
    /// start receipt. A failure stays approved so the user can inspect Terminal
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
                    self.refresh()
                case .failure(let error):
                    self.popoverModel.resumeActivities[task.id] = .failed(error.localizedDescription)
                }
            }
        }
    }

    private var currentActionToken: String? {
        guard popoverModel.lastError == nil else { return nil }
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
                lines.append("  \(account.collection.actionText)")
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
