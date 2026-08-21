import AppKit
import SwiftUI

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
    private var client: StatusClient?
    private var refreshTimer: Timer?
    private var isFetching = false
    private var failureIndex = 0
    private let retrySeconds: [TimeInterval] = [2, 5, 15, 30]
#if DEBUG
    private var debugWindow: NSWindow?
#endif

    func applicationDidFinishLaunching(_ notification: Notification) {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.button?.toolTip = Strings.t("status.tooltip")
        statusItem.button?.target = self
        statusItem.button?.action = #selector(togglePopover)

        popover.behavior = .transient
        popover.animates = false
        popover.delegate = self

        do {
            client = try StatusClient()
        } catch {
            popoverModel.lastError = error.localizedDescription
        }

        installPopoverContent()
        installKeyboardShortcuts()
        render()
        refresh()

#if DEBUG
        if ProcessInfo.processInfo.environment["QUOTAPIE_DEBUG_AUTO_OPEN"] == "1" {
            DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in
                self?.showDebugWindow()
            }
        }
#endif
    }

    func applicationWillTerminate(_ notification: Notification) {
        refreshTimer?.invalidate()
    }

    @objc private func togglePopover() {
        if popover.isShown {
            popover.performClose(nil)
            return
        }
        guard let button = statusItem.button else { return }
        popover.show(relativeTo: button.bounds, of: button, preferredEdge: .maxY)
        // Read again immediately so the values are not already ageing by the
        // time the popover finishes opening.
        refresh()
        NSApp.activate(ignoringOtherApps: true)
    }

    private func installPopoverContent() {
        let view = PopoverView(
            model: popoverModel,
            onRefresh: { [weak self] in self?.refresh() },
            onCopy: { [weak self] in self?.copyStatus() },
            onOpenDashboard: { [weak self] in self?.openDashboard() },
            onOpenConfig: { [weak self] in self?.openConfig() },
            onCopyCommand: { [weak self] command in self?.copyToPasteboard(command) },
            onQuit: { NSApp.terminate(nil) }
        )
        let controller = NSHostingController(rootView: view)
        // fittingSize is computed before layout and clips the header. Let
        // SwiftUI report its own size and have the popover follow it.
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
        window.title = "QuotaPie UI Debug"
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

    @objc private func refresh() {
        guard !isFetching, let client else { return }
        isFetching = true
        client.fetch { [weak self] result in
            DispatchQueue.main.async {
                guard let self else { return }
                self.isFetching = false
                switch result {
                case .success(let payload):
                    self.popoverModel.payload = payload
                    self.popoverModel.lastSuccessAt = Date()
                    self.popoverModel.lastError = nil
                    self.failureIndex = 0
                    self.scheduleRefresh(after: 30)
                case .failure(let error):
                    self.popoverModel.lastError = error.localizedDescription
                    let delay = self.retrySeconds[min(self.failureIndex, self.retrySeconds.count - 1)]
                    self.failureIndex = min(self.failureIndex + 1, self.retrySeconds.count - 1)
                    self.scheduleRefresh(after: delay)
                }
                self.render()
            }
        }
    }

    /// The title is one conclusion. The service decides which one; this only
    /// gives it a colour.
    ///
    /// While the transport is down, the last value received is not used as the
    /// title. Cached numbers are fine in the popover, labelled as the last good
    /// reading, but the menu bar states what is true now — showing an old
    /// number in the normal colour there is simply a lie.
    private func render() {
        let headline = popoverModel.payload?.headline
        let title: String
        let color: NSColor
        if popoverModel.lastError != nil {
            title = popoverModel.payload == nil ? Strings.t("headline.disconnected") : Strings.t("headline.degraded")
            color = .systemOrange
        } else {
            title = headline?.localizedTitle ?? Strings.t("headline.checking")
            switch headline?.kind {
            case "pace-risk": color = .systemOrange
            case "degraded", "setup": color = .secondaryLabelColor
            default: color = .labelColor
            }
        }
        statusItem.button?.attributedTitle = NSAttributedString(
            string: title,
            attributes: [
                .foregroundColor: color,
                .font: NSFont.monospacedDigitSystemFont(ofSize: 12, weight: .medium),
            ]
        )
        statusItem.button?.toolTip = popoverModel.lastError ?? headline?.localizedDetail ?? Strings.t("status.tooltip")
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
