import AppKit
import Foundation

/// A navigation handoff never assigns an account or submits a prompt.
enum SessionHandoff {
    static func modoreURL(threadID: String) -> URL? {
        guard let id = UUID(uuidString: threadID) else { return nil }
        return URL(string: "modore://work/session/codex/\(id.uuidString.lowercased())")
    }

    @MainActor
    static func openInModore(threadID: String, completion: @escaping (Bool) -> Void) {
        guard let url = modoreURL(threadID: threadID) else { completion(false); return }
        let candidates = [FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Applications/Modore.app"),
                          URL(fileURLWithPath: "/Applications/Modore.app")]
        if let app = candidates.first(where: { Bundle(url: $0)?.bundleIdentifier == "me.heznpc.modore" }) {
            NSWorkspace.shared.open([url], withApplicationAt: app, configuration: .init()) { running, error in
                DispatchQueue.main.async { completion(running != nil && error == nil) }
            }
        } else { completion(NSWorkspace.shared.open(url)) }
    }

    static func matches(_ conversation: RequestAccountConversation, query: String) -> Bool {
        let query = query.trimmingCharacters(in: .whitespacesAndNewlines)
        return query.isEmpty || conversation.displayTitle.localizedCaseInsensitiveContains(query)
            || conversation.threadId.localizedCaseInsensitiveContains(query)
    }
}
