import AppKit
import SwiftUI

/// AppDelegate retains one settings window independently of the transient popover.
final class SettingsWindowController: NSWindowController {
    private static let selectionKey = "settings.lastCategory"
    private let selection: SettingsSelection
    private let persistsSelection: Bool

    init(model: PopoverModel, actions: PopoverActions, initialCategory: SettingsCategory? = nil) {
        let preview = AppVerification.current != nil || ProcessInfo.processInfo.environment["QUOTAPIE_DEBUG_AUTO_OPEN"] == "1"
        let category = initialCategory ?? (preview ? nil : UserDefaults.standard.string(forKey: Self.selectionKey).flatMap(SettingsCategory.init(rawValue:))) ?? .general
        selection = SettingsSelection(category: category)
        persistsSelection = !preview
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 820, height: 640),
                              styleMask: [.titled, .closable], backing: .buffered, defer: false)
        super.init(window: window)
        window.identifier = NSUserInterfaceItemIdentifier("quotapie.settings")
        window.title = category.title
        window.isReleasedWhenClosed = false
        window.standardWindowButton(.miniaturizeButton)?.isEnabled = false
        window.standardWindowButton(.zoomButton)?.isEnabled = false
        if !preview { window.setFrameAutosaveName("QuotaPieSettings") }
        window.contentViewController = NSHostingController(rootView: SettingsPanelView(model: model, actions: actions, selection: selection))
        window.setContentSize(NSSize(width: 820, height: 640))
        selection.onChange = { [weak self] category in
            self?.window?.title = category.title
            if self?.persistsSelection == true {
                UserDefaults.standard.set(category.rawValue, forKey: Self.selectionKey)
            }
        }
        window.center()
    }

    required init?(coder: NSCoder) { nil }

    func present(category: SettingsCategory? = nil) {
        if let category { selection.category = category }
        showWindow(nil)
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }
}
