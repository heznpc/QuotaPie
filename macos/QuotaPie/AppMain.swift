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
    private var eventMonitor: Any?
    private let retrySeconds: [TimeInterval] = [2, 5, 15, 30]

    func applicationDidFinishLaunching(_ notification: Notification) {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.button?.toolTip = "Codex와 Claude의 실사용 한도"
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
        render()
        refresh()
    }

    func applicationWillTerminate(_ notification: Notification) {
        refreshTimer?.invalidate()
        if let eventMonitor { NSEvent.removeMonitor(eventMonitor) }
    }

    @objc private func togglePopover() {
        if popover.isShown {
            popover.performClose(nil)
            return
        }
        guard let button = statusItem.button else { return }
        popover.show(relativeTo: button.bounds, of: button, preferredEdge: .maxY)
        // 팝오버가 열려 있는 동안에도 값이 늙지 않도록 즉시 한 번 더 읽는다.
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
        // fittingSize는 레이아웃 전에 계산돼 헤더가 잘린다. SwiftUI가 스스로
        // 크기를 알리게 두고 팝오버가 그 값을 따르게 한다.
        controller.sizingOptions = [.preferredContentSize]
        popover.contentViewController = controller
    }

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

    /// 제목은 결론 하나다. 어떤 결론인지는 서비스가 고르고, 여기서는 색만 입힌다.
    ///
    /// 전송이 끊긴 동안에는 마지막으로 받은 값을 제목에 쓰지 않는다. 캐시된 숫자는
    /// 팝오버에서 "마지막 정상값"이라고 밝히고 보여주면 되지만, 메뉴 막대는 지금
    /// 상태를 말하는 자리라 늙은 값을 정상 색으로 띄우면 그대로 거짓말이 된다.
    private func render() {
        let headline = popoverModel.payload?.headline
        let title: String
        let color: NSColor
        if popoverModel.lastError != nil {
            title = popoverModel.payload == nil ? "연결 끊김" : "한도 확인 지연"
            color = .systemOrange
        } else {
            title = headline?.title ?? "확인 중"
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
        statusItem.button?.toolTip = popoverModel.lastError ?? headline?.detail ?? "Codex와 Claude의 실사용 한도"
    }

    private func copyStatus() { copyToPasteboard(plainStatus()) }

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
        guard let payload = popoverModel.payload else { return "QuotaPie: 아직 한도 데이터가 없습니다." }
        var lines: [String] = []
        if let headline = payload.headline {
            lines.append(headline.detail.map { "\(headline.title) — \($0)" } ?? headline.title)
        }
        for account in payload.accounts {
            lines.append("\(account.providerTitle) · \(account.accountLabel)")
            if !account.collection.isHealthy {
                lines.append("  \(account.collection.actionText)")
            }
            for window in account.windows {
                let used = window.usedPercent.map { "\(Int($0.rounded()))% 사용" } ?? "사용량 미확인"
                let remaining = window.remainingPercent.map { "\(Int($0.rounded()))% 남음" } ?? "—"
                lines.append("  \(window.shortLabel): \(used) · \(remaining) · \(DisplayFormat.resetStamp(window.resetsAtMs))")
                if let pace = window.paceText { lines.append("    \(pace)") }
            }
        }
        return lines.joined(separator: "\n")
    }
}
