import AppKit
import ApplicationServices

/// Use existing accessibility permission only. Never guess from the most recent
/// request: another conversation may be running in the background.
enum FocusedConversation {
    struct Focus {
        let title: String?
        let threadID: String?
    }

    static var isHostFrontmost: Bool {
        ["com.openai.chat", "com.openai.codex"].contains(NSWorkspace.shared.frontmostApplication?.bundleIdentifier ?? "")
    }

    static func read(catalog: RequestAccountCatalog?) -> Focus? {
        guard isHostFrontmost else { return nil }
        // Clear the previous host's conversation if focus cannot be verified.
        guard AXIsProcessTrusted(), let app = NSWorkspace.shared.frontmostApplication else { return Focus(title: nil, threadID: nil) }
        let element = AXUIElementCreateApplication(app.processIdentifier)
        AXUIElementSetMessagingTimeout(element, 0.05)
        var window: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, kAXFocusedWindowAttribute as CFString, &window) == .success,
              let window, CFGetTypeID(window) == AXUIElementGetTypeID() else { return Focus(title: nil, threadID: nil) }
        func attribute(_ node: AXUIElement, _ name: String) -> AnyObject? {
            var value: CFTypeRef?
            guard AXUIElementCopyAttributeValue(node, name as CFString, &value) == .success else { return nil }
            return value
        }
        let root = window as! AXUIElement
        let title = attribute(root, kAXTitleAttribute) as? String
        if let conversation = match(title: title, catalog: catalog) {
            return Focus(title: title, threadID: conversation.threadId)
        }
        // Electron can keep a generic window title. Its web document URL or
        // selected navigation item identifies the visible conversation instead.
        var queue: [(AXUIElement, Int)] = [(root, 0)]
        var index = 0, candidates = Set<String>()
        let deadline = Date().addingTimeInterval(0.15)
        while index < queue.count, index < 256, Date() < deadline {
            let (node, depth) = queue[index]; index += 1
            let selected = (attribute(node, kAXSelectedAttribute) as? Bool) == true
            if let document = attribute(node, kAXDocumentAttribute) as? String,
               let id = threadID(from: document) { return Focus(title: title, threadID: id) }
            if selected {
                let url = attribute(node, kAXURLAttribute)
                if let id = threadID(from: (url as? URL)?.absoluteString ?? (url as? String)) {
                    candidates.insert(id)
                }
                for name in [kAXTitleAttribute, kAXDescriptionAttribute, kAXValueAttribute] {
                    if let conversation = match(title: attribute(node, name) as? String, catalog: catalog) {
                        candidates.insert(conversation.threadId)
                    }
                }
            }
            if depth < 8, let children = attribute(node, kAXChildrenAttribute) as? [AXUIElement] {
                queue.append(contentsOf: children.prefix(max(0, 256 - queue.count)).map { ($0, depth + 1) })
            }
        }
        return Focus(title: title, threadID: candidates.count == 1 ? candidates.first : nil)
    }

    static func threadID(from value: String?) -> String? {
        guard let value, let url = URL(string: value),
              let scheme = url.scheme, ["codex", "https", "http", "file"].contains(scheme) else { return nil }
        let parts = ([url.host ?? ""] + url.pathComponents).filter { $0 != "/" }
        for (index, part) in parts.enumerated() where ["thread", "threads"].contains(part) && index + 1 < parts.count {
            let id = parts[index + 1]
            if UUID(uuidString: id) != nil { return id.lowercased() }
        }
        return nil
    }

    static func match(threadID: String? = nil, title: String?, catalog: RequestAccountCatalog?) -> RequestAccountConversation? {
        if let threadID { return catalog?.conversations.first { $0.threadId == threadID } }
        guard let title, !title.isEmpty, let catalog else { return nil }
        func normalized(_ value: String) -> String {
            var result = value.trimmingCharacters(in: .whitespacesAndNewlines)
            for suffix in [" — Codex", " - Codex", " — ChatGPT", " - ChatGPT"] where result.hasSuffix(suffix) {
                result = String(result.dropLast(suffix.count))
            }
            return result
        }
        let matches = catalog.conversations.filter { normalized($0.title) == normalized(title) }
        return matches.count == 1 ? matches[0] : nil
    }
}
