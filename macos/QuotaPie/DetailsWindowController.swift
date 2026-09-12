import AppKit
import SwiftUI

/// The AppKit app owns one reusable window; all content and selection stay in SwiftUI.
final class DetailsWindowController: NSWindowController {
    private let navigation: DetailsModel

    init(model: PopoverModel, actions: PopoverActions) {
        let navigation = DetailsModel()
        self.navigation = navigation
        let controller = NSHostingController(rootView: DetailsView(model: model, navigation: navigation, actions: actions))
        let window = NSWindow(contentViewController: controller)
        window.title = "QuotaPie"
        window.styleMask = [.titled, .closable, .miniaturizable, .resizable]
        window.setContentSize(NSSize(width: 620, height: 560))
        window.minSize = NSSize(width: 560, height: 460)
        window.isReleasedWhenClosed = false
        window.setFrameAutosaveName("QuotaPieDetails")
        super.init(window: window)
    }

    required init?(coder: NSCoder) { nil }

    func show(_ section: DetailSection) {
        navigation.section = section
        showWindow(nil)
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }
}
