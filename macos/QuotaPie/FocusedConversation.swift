import AppKit
import ApplicationServices

/// Use existing accessibility permission only. Never guess from the most recent
/// request: another conversation may be running in the background.
enum FocusedConversation {
    static func title() -> String? {
        guard AXIsProcessTrusted(), let app = NSWorkspace.shared.frontmostApplication,
              ["com.openai.chat", "com.openai.codex"].contains(app.bundleIdentifier ?? "") else { return nil }
        let element = AXUIElementCreateApplication(app.processIdentifier)
        var window: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, kAXFocusedWindowAttribute as CFString, &window) == .success,
              let window, CFGetTypeID(window) == AXUIElementGetTypeID() else { return nil }
        var title: CFTypeRef?
        guard AXUIElementCopyAttributeValue(window as! AXUIElement, kAXTitleAttribute as CFString, &title) == .success else { return nil }
        return title as? String
    }

    static func match(title: String?, catalog: RequestAccountCatalog?) -> RequestAccountConversation? {
        guard let title, !title.isEmpty, let catalog else { return nil }
        let matches = catalog.conversations.filter { $0.title == title }
        return matches.count == 1 ? matches[0] : nil
    }
}
