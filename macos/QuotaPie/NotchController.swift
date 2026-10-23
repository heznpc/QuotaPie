import AppKit
import OSLog
import SwiftUI

final class NotchViewState: ObservableObject {
    @Published var snapshot: NotchSnapshot?
    @Published var placement: NotchLayout?
    @Published var event: String?
}

private final class NotchPanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

/// One retained, nonactivating surface. The popover model owns account/quota
/// attribution; this controller owns only placement and transient presentation.
final class NotchController {
    static let preferenceKey = "appearance.notch.enabled"
    private let state = NotchViewState()
    private let panel: NSPanel
    private let defaults: UserDefaults
    private var observers: [NSObjectProtocol] = []
    private var clearEvent: DispatchWorkItem?
    private var visibleForHost = false
    private var needsLayout = true
    private var lastFrame: CGRect?
    private var enabled: Bool
    private var layoutScheduled = false
    private var isLayingOut = false
    private let logger = Logger(subsystem: "local.quotapie.menubar", category: "Notch")
    private var lastDiagnostic = ""
    private var visibilityReason = "inactive"

    init(defaults: UserDefaults = .standard, open: @escaping () -> Void) {
        self.defaults = defaults
        enabled = defaults.object(forKey: Self.preferenceKey) as? Bool ?? true
        panel = NotchPanel(contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.identifier = NSUserInterfaceItemIdentifier("quotapie.notch")
        panel.title = "QuotaPie"
        panel.isFloatingPanel = true
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.hidesOnDeactivate = false
        panel.level = .statusBar
        panel.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle]
        let hosting = NSHostingController(rootView: NotchView(state: state, open: open))
        hosting.sizingOptions = []
        panel.contentViewController = hosting
        for name in [NSApplication.didChangeScreenParametersNotification, UserDefaults.didChangeNotification] {
            observers.append(NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                guard let self else { return }
                if name == UserDefaults.didChangeNotification {
                    let next = self.defaults.object(forKey: Self.preferenceKey) as? Bool ?? true
                    guard next != self.enabled else { return }
                    self.enabled = next
                }
                // AppKit may post defaults/screen notifications while SwiftUI is
                // measuring text. Re-entering NSHostingView layout here crashes.
                self.scheduleLayout()
            })
        }
    }

    func update(_ snapshot: NotchSnapshot, visible: Bool) {
        let event = snapshot.event(after: state.snapshot)
        if state.snapshot != snapshot { state.snapshot = snapshot }
        if visible != visibleForHost { visibleForHost = visible; needsLayout = true }
        if let event, visible {
            clearEvent?.cancel()
            state.event = event
            let work = DispatchWorkItem { [weak self] in self?.state.event = nil }
            clearEvent = work
            DispatchQueue.main.asyncAfter(deadline: .now() + 3, execute: work)
        }
        layout()
        let diagnostic = "provider=\(snapshot.provider) accountVerified=\(snapshot.accountID != nil) quotaAvailable=\(snapshot.remaining != nil) hostFocused=\(visible) panelVisible=\(panel.isVisible) reason=\(visibilityReason)"
        if diagnostic != lastDiagnostic {
            lastDiagnostic = diagnostic
            logger.info("\(diagnostic, privacy: .public)")
        }
    }

    func stop() {
        clearEvent?.cancel()
        observers.forEach(NotificationCenter.default.removeObserver)
        observers.removeAll()
        panel.orderOut(nil)
    }

    private func scheduleLayout() {
        needsLayout = true
        guard !layoutScheduled else { return }
        layoutScheduled = true
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.layoutScheduled = false
            self.layout()
        }
    }

    private func layout() {
        guard !isLayingOut else { scheduleLayout(); return }
        isLayingOut = true
        defer { isLayingOut = false }
        guard enabled, visibleForHost, state.snapshot != nil else {
            hide(reason: enabled ? "inactive" : "disabled")
            return
        }
        let placement = NSScreen.screens.compactMap { screen -> (NSScreen, NotchLayout)? in
            guard let placement = NotchPlacement.layout(screen: screen.frame, safeTop: screen.safeAreaInsets.top,
                left: screen.auxiliaryTopLeftArea, right: screen.auxiliaryTopRightArea) else { return nil }
            return (screen, placement)
        }.first
        guard let (screen, placement) = placement else { hide(reason: "no-notch"); return }
        // Called by the existing focus refresh, including while suppressed, so
        // toggling or quitting another island restores this one without a restart.
        guard let entries = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else {
            hide(reason: "windows-unavailable")
            return
        }
        let primaryTop = NSScreen.screens.first?.frame.maxY ?? screen.frame.maxY
        let windows = entries.compactMap { NotchWindow(info: $0, primaryTop: primaryTop) }
        if windows.contains(where: { $0.occupiesNotch(placement, screen: screen.frame, ownPID: ProcessInfo.processInfo.processIdentifier) }) {
            hide(reason: "other-notch-panel")
            return
        }
        if let pid = NSWorkspace.shared.frontmostApplication?.processIdentifier,
           let window = windows.first(where: { $0.ownerPID == pid && $0.layer == 0 }),
           window.frame.insetBy(dx: -1, dy: -1).contains(screen.frame) {
            hide(reason: "fullscreen")
            return
        }
        if state.placement != placement { state.placement = placement }
        let frame = placement.frame
        if needsLayout || lastFrame != frame {
            panel.setFrame(frame, display: true)
            lastFrame = frame
            needsLayout = false
        }
        visibilityReason = "visible"
        if !panel.isVisible { panel.orderFrontRegardless() }
    }

    private func hide(reason: String) {
        visibilityReason = reason
        if panel.isVisible { panel.orderOut(nil) }
        clearEvent?.cancel()
        if state.event != nil { state.event = nil }
        lastFrame = nil
    }
}

struct NotchView: View {
    @ObservedObject var state: NotchViewState
    let open: () -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var tint: Color {
        switch state.snapshot?.state {
        case .exhausted: return .red
        case .low: return .orange
        case .available: return Color(red: 0.45, green: 0.87, blue: 0.68)
        default: return .gray
        }
    }

    var body: some View {
        Button(action: open) {
            if let snapshot = state.snapshot, let placement = state.placement {
                HStack(spacing: 0) {
                    HStack(spacing: 6) {
                        Circle().fill(tint).frame(width: 5, height: 5).accessibilityHidden(true)
                        VStack(alignment: .leading, spacing: 0) {
                            Text(snapshot.provider).font(.system(size: 9, weight: .medium)).foregroundStyle(.white.opacity(0.65))
                            Text(snapshot.compactAccountLabel).font(.system(size: 11, weight: .semibold))
                                .lineLimit(1).truncationMode(.tail)
                        }
                    }.padding(.leading, 12).padding(.trailing, 8)
                        .frame(width: placement.wingWidth, alignment: .leading)
                    // Keep all text out of the physical camera cutout.
                    Color.clear.frame(width: placement.notchWidth).accessibilityHidden(true)
                    HStack(spacing: 7) {
                        VStack(alignment: .trailing, spacing: 0) {
                            Text(Strings.t("notch.compactRemaining", snapshot.windowLabel))
                                .font(.system(size: 9, weight: .medium)).foregroundStyle(.white.opacity(0.65)).lineLimit(1)
                            Text(snapshot.remaining.map { "\(Int($0.rounded()))%" } ?? "—")
                                .font(.system(size: 12, weight: .semibold, design: .rounded)).monospacedDigit()
                        }
                        Capsule().fill(.white.opacity(0.2)).overlay(alignment: .bottom) {
                            Capsule().fill(tint).frame(height: 20 * CGFloat((snapshot.remaining ?? 0) / 100))
                                .animation(reduceMotion ? nil : .easeInOut(duration: 0.25), value: snapshot.remaining)
                        }.frame(width: 4, height: 20).accessibilityHidden(true)
                    }.padding(.leading, 8).padding(.trailing, 12)
                        .frame(width: placement.wingWidth, alignment: .trailing)
                }
                .frame(width: placement.frame.width, height: placement.frame.height)
                .foregroundStyle(.white)
                .background(NotchBackground().fill(.black))
                .overlay(NotchBackground().strokeBorder(tint.opacity(state.event == nil ? 0 : 0.8), lineWidth: 1))
                .animation(reduceMotion ? nil : .easeInOut(duration: 0.25), value: state.event)
                .contentShape(NotchBackground())
            }
        }
        .buttonStyle(.plain)
        .help([accessibilityDescription, state.event, Strings.t("notch.open")].compactMap { $0 }.joined(separator: "\n"))
        .accessibilityIdentifier("notch.open")
        .accessibilityLabel(accessibilityDescription)
    }

    private var accessibilityDescription: String {
        [state.snapshot?.provider, state.snapshot?.accountLabel, state.snapshot?.accountDetail, state.snapshot?.detail,
         state.snapshot?.remaining.map { "\(Int($0.rounded()))%" }].compactMap { $0 }.joined(separator: " · ")
    }
}

private struct NotchBackground: InsettableShape {
    var inset: CGFloat = 0
    func inset(by amount: CGFloat) -> NotchBackground { NotchBackground(inset: inset + amount) }

    func path(in rect: CGRect) -> Path {
        let rect = rect.insetBy(dx: inset, dy: inset)
        let radius = min(10, rect.height / 2)
        var path = Path()
        path.move(to: CGPoint(x: rect.minX, y: rect.minY))
        path.addLine(to: CGPoint(x: rect.maxX, y: rect.minY))
        path.addLine(to: CGPoint(x: rect.maxX, y: rect.maxY - radius))
        path.addQuadCurve(to: CGPoint(x: rect.maxX - radius, y: rect.maxY), control: CGPoint(x: rect.maxX, y: rect.maxY))
        path.addLine(to: CGPoint(x: rect.minX + radius, y: rect.maxY))
        path.addQuadCurve(to: CGPoint(x: rect.minX, y: rect.maxY - radius), control: CGPoint(x: rect.minX, y: rect.maxY))
        path.closeSubpath()
        return path
    }
}

struct NotchSettingsView: View {
    @AppStorage(NotchController.preferenceKey) private var enabled = true
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Toggle(Strings.t("notch.settings.title"), isOn: $enabled).toggleStyle(.switch)
                .accessibilityIdentifier("settings.notch.enabled")
            Text(Strings.t("notch.settings.description")).font(.callout).foregroundStyle(.secondary)
        }
    }
}
