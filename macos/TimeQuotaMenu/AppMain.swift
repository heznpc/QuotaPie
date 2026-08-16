import AppKit
import Foundation

@main
struct TimeQuotaMenuApp {
    static func main() {
        let app = NSApplication.shared
        let delegate = AppDelegate()
        app.setActivationPolicy(.accessory)
        app.delegate = delegate
        app.run()
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    private var statusItem: NSStatusItem!
    private let menu = NSMenu()
    private var client: StatusClient?
    private var payload: StatusPayload?
    private var lastSuccessAt: Date?
    private var lastError: String?
    private var refreshTimer: Timer?
    private var countdownTimer: Timer?
    private var isFetching = false
    private var failureIndex = 0
    private let retrySeconds: [TimeInterval] = [2, 5, 15, 30]

    func applicationDidFinishLaunching(_ notification: Notification) {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.button?.toolTip = "Codex와 Claude의 실사용 한도"
        statusItem.menu = menu
        menu.delegate = self
        menu.autoenablesItems = false

        do {
            client = try StatusClient()
        } catch {
            lastError = error.localizedDescription
        }

        countdownTimer = Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { [weak self] _ in
            self?.render()
        }
        if let countdownTimer {
            RunLoop.main.add(countdownTimer, forMode: .common)
        }
        render()
        refresh()
    }

    func applicationWillTerminate(_ notification: Notification) {
        refreshTimer?.invalidate()
        countdownTimer?.invalidate()
    }

    func menuWillOpen(_ menu: NSMenu) {
        render()
        refresh()
    }

    private func scheduleRefresh(after seconds: TimeInterval) {
        refreshTimer?.invalidate()
        refreshTimer = Timer.scheduledTimer(withTimeInterval: seconds, repeats: false) { [weak self] _ in
            self?.refresh()
        }
        if let refreshTimer {
            RunLoop.main.add(refreshTimer, forMode: .common)
        }
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
                    self.payload = payload
                    self.lastSuccessAt = Date()
                    self.lastError = nil
                    self.failureIndex = 0
                    self.scheduleRefresh(after: 30)
                case .failure(let error):
                    self.lastError = error.localizedDescription
                    let delay = self.retrySeconds[min(self.failureIndex, self.retrySeconds.count - 1)]
                    self.failureIndex = min(self.failureIndex + 1, self.retrySeconds.count - 1)
                    self.scheduleRefresh(after: delay)
                }
                self.render()
            }
        }
    }

    private func render() {
        renderStatusButton()
        menu.removeAllItems()

        if let lastError {
            let age = lastSuccessAt.map { " · 마지막 성공 \(DisplayFormat.age(since: $0))" } ?? ""
            addDisabled("연결 끊김\(age)", color: .systemOrange)
            let detail = addDisabled(lastError)
            detail.indentationLevel = 1
            menu.addItem(.separator())
        } else if let lastSuccessAt {
            addDisabled("업데이트 \(DisplayFormat.age(since: lastSuccessAt))")
            menu.addItem(.separator())
        }

        guard let payload, !payload.statuses.isEmpty else {
            addDisabled("아직 한도 데이터가 없습니다.")
            addDisabled("Codex 수집 또는 Claude 상태줄을 기다리는 중입니다.")
            addActions()
            return
        }

        let statuses = payload.statuses.sorted { lhs, rhs in
            providerOrder(lhs.provider) < providerOrder(rhs.provider)
        }
        var lastProvider: String?
        for status in statuses {
            if lastProvider != status.provider {
                if lastProvider != nil { menu.addItem(.separator()) }
                addDisabled(status.provider.uppercased(), color: .secondaryLabelColor)
                lastProvider = status.provider
            }
            let account = status.accountLabel ?? status.account ?? "Main"
            let accountItem = addDisabled(account)
            accountItem.indentationLevel = 1
            for window in status.windows {
                let bottleneck = window.bucket == status.bottleneckBucket
                let remaining = window.remainingPercent.map { "\(Int($0.rounded()))%" } ?? "—"
                let duration = DisplayFormat.duration(until: window.resetsAtMs)
                let resetClock = DisplayFormat.clock(window.resetsAtMs)
                let freshness = window.freshness == "fresh" ? "" : " · \(freshnessLabel(window.freshness))"
                let marker = bottleneck ? "●" : "○"
                let item = addDisabled("\(marker) \(window.label)   \(remaining) · \(duration) · \(resetClock)\(freshness)")
                item.indentationLevel = 2
                if let pace = window.paceRatio, pace > 1 {
                    let early = window.minutesBeforeReset.map {
                        " · 안전선보다 \(DisplayFormat.interval(milliseconds: $0 * 60_000)) 빠름"
                    } ?? ""
                    let paceItem = addDisabled("사용 속도 \(String(format: "%.1f", pace))×\(early)", color: pace >= 1.5 ? .systemOrange : .secondaryLabelColor)
                    paceItem.indentationLevel = 3
                }
            }
        }

        let events = payload.events.prefix(3)
        if !events.isEmpty {
            menu.addItem(.separator())
            addDisabled("최근 변화", color: .secondaryLabelColor)
            for event in events {
                let item = addDisabled("\(event.provider)/\(event.account) · \(event.summary) · \(DisplayFormat.age(since: date(event.occurredAtMs)))")
                item.indentationLevel = 1
            }
        }
        addActions()
    }

    private func renderStatusButton() {
        let windows = payload?.statuses.flatMap(\.windows) ?? []
        let providerCodes = [("codex", "C"), ("claude", "A")]
        let parts = providerCodes.compactMap { provider, code -> String? in
            let values = windows
                .filter { $0.provider == provider && $0.freshness == "fresh" }
                .compactMap(\.remainingPercent)
            guard let minimum = values.min() else { return nil }
            return "\(code)\(Int(minimum.rounded()))"
        }
        let title = parts.isEmpty ? "TQ —" : "TQ " + parts.joined(separator: " · ")
        let minimum = windows.filter { $0.freshness == "fresh" }.compactMap(\.remainingPercent).min()
        let color: NSColor = lastError != nil
            ? .systemOrange
            : minimum.map { $0 <= 10 ? .systemRed : ($0 <= 20 ? .systemOrange : .labelColor) } ?? .secondaryLabelColor
        statusItem.button?.attributedTitle = NSAttributedString(
            string: title,
            attributes: [.foregroundColor: color, .font: NSFont.monospacedDigitSystemFont(ofSize: 12, weight: .medium)]
        )
    }

    private func addActions() {
        menu.addItem(.separator())
        addAction("지금 새로고침", selector: #selector(refresh), key: "r")
        addAction("상태를 클립보드에 복사", selector: #selector(copyStatus))
        addAction("상세 웹 화면 열기", selector: #selector(openDashboard))
        addAction("설정 파일 열기", selector: #selector(openConfig))
        menu.addItem(.separator())
        addAction("TimeQuota 종료", selector: #selector(quit), key: "q")
    }

    @discardableResult
    private func addDisabled(_ title: String, color: NSColor? = nil) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        item.isEnabled = false
        if let color {
            item.attributedTitle = NSAttributedString(string: title, attributes: [.foregroundColor: color])
        }
        menu.addItem(item)
        return item
    }

    private func addAction(_ title: String, selector: Selector, key: String = "") {
        let item = NSMenuItem(title: title, action: selector, keyEquivalent: key)
        item.target = self
        item.isEnabled = true
        menu.addItem(item)
    }

    @objc private func copyStatus() {
        let pasteboard = NSPasteboard.general
        pasteboard.clearContents()
        pasteboard.setString(plainStatus(), forType: .string)
    }

    @objc private func openDashboard() {
        guard let url = client?.baseURL else { return }
        NSWorkspace.shared.open(url)
    }

    @objc private func openConfig() {
        let environment = ProcessInfo.processInfo.environment
        let path = NSString(string: environment["TIMEQUOTA_CONFIG"] ?? "~/.config/timequota/config.json").expandingTildeInPath
        NSWorkspace.shared.open(URL(fileURLWithPath: path))
    }

    @objc private func quit() {
        NSApp.terminate(nil)
    }

    private func plainStatus() -> String {
        guard let payload else { return "TimeQuota: 아직 한도 데이터가 없습니다." }
        var lines = ["TimeQuota · \(DisplayFormat.age(since: lastSuccessAt ?? Date()))"]
        for status in payload.statuses {
            lines.append("\(status.provider.uppercased()) · \(status.accountLabel ?? status.account ?? "Main")")
            for window in status.windows {
                let remaining = window.remainingPercent.map { "\(Int($0.rounded()))%" } ?? "—"
                lines.append("  \(window.label): \(remaining) · 리셋까지 \(DisplayFormat.duration(until: window.resetsAtMs))")
            }
        }
        return lines.joined(separator: "\n")
    }

    private func providerOrder(_ provider: String) -> Int {
        switch provider {
        case "codex": return 0
        case "claude": return 1
        default: return 2
        }
    }

    private func freshnessLabel(_ value: String) -> String {
        switch value {
        case "stale": return "오래된 값"
        case "reset_due": return "리셋 확인 중"
        case "unknown": return "확인 필요"
        default: return value
        }
    }

    private func date(_ milliseconds: Double) -> Date {
        Date(timeIntervalSince1970: milliseconds / 1_000)
    }
}
