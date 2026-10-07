import AppKit
import SwiftUI

/// Values understood by the desktop app's profile-local config.toml.
enum CodexDockIcon: String, Codable, CaseIterable {
    case appDefault = "app-default", chatGPT = "chatgpt", codex = "codex-system", space = "space-system"
    var nativeValue: String { self == .chatGPT ? Self.appDefault.rawValue : rawValue }
    var title: String {
        switch self { case .appDefault: return Strings.t("profiles.iconDefault"); case .chatGPT: return "ChatGPT"; case .codex: return "Codex"; case .space: return "Space" }
    }
}

struct DockIconReply: Decodable { let icon: CodexDockIcon; let changed: Bool }

/// Electron's default icon comes from the shared bundle, whereas Codex and Space
/// are explicit per-process overrides. Keep that fallback stable for profiles
/// choosing ChatGPT, even when an app update changes the bundled app.icns.
final class CodexDockIconCoordinator {
    static let shared = CodexDockIconCoordinator()
    private var timer: Timer?
    private var lastIcon: Data?
    private var lastResource: Data?

    func start() {
        reconcile()
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: 15, repeats: true) { [weak self] _ in self?.reconcile() }
    }
    func stop() { timer?.invalidate(); timer = nil }

    @discardableResult
    func reconcile() -> Bool {
        guard let app = CodexProfileLauncher.appURL() else { return true }
        guard CodexProfilesModel.shared.profiles.contains(where: { $0.dockIcon == .chatGPT }) else {
            // Only undo our own override; preserve any icon subsequently chosen elsewhere.
            if let lastIcon, lastIcon == NSWorkspace.shared.icon(forFile: app.path).tiffRepresentation {
                guard NSWorkspace.shared.setIcon(nil, forFile: app.path, options: []) else { return false }
                self.lastIcon = nil; lastResource = nil
            }
            return true
        }
        let resource = app.appendingPathComponent("Contents/Resources/icon-chatgpt.png")
        guard let data = try? Data(contentsOf: resource), let image = NSImage(data: data) else { return false }
        let current = NSWorkspace.shared.icon(forFile: app.path).tiffRepresentation
        if current == lastIcon && data == lastResource { return true }
        // Finder custom-icon metadata only: no executable, Info.plist or signed
        // resource is rewritten. Existing accounts and running tasks stay alive.
        guard NSWorkspace.shared.setIcon(image, forFile: app.path, options: []) else { return false }
        lastIcon = NSWorkspace.shared.icon(forFile: app.path).tiffRepresentation
        lastResource = data
        return true
    }
}

struct CodexDockIconPicker: View {
    let profile: CodexDesktopProfile
    let actionToken: String?
    @ObservedObject var profiles: CodexProfilesModel
    @State private var selected: CodexDockIcon?
    @State private var busy = false
    @State private var message: String?
    @State private var client: StatusClient?

    init(profile: CodexDesktopProfile, actionToken: String?, profiles: CodexProfilesModel) {
        self.profile = profile; self.actionToken = actionToken; self.profiles = profiles
        _selected = State(initialValue: profile.dockIcon)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if let selected {
                Picker(Strings.t("profiles.dockIcon"), selection: Binding(get: { selected }, set: { request($0) })) {
                    ForEach(CodexDockIcon.allCases, id: \.self) { icon in Text(icon.title).tag(icon) }
                }.disabled(busy || actionToken == nil)
            } else {
                Text(Strings.t("profiles.dockIcon")).font(.caption)
            }
            if selected == .chatGPT { Text(Strings.t("profiles.iconSharedFallback")).font(.caption).foregroundStyle(.secondary) }
            if let message { Text(message).font(.caption).foregroundStyle(.secondary) }
            if profile.collectionAccount == nil {
                Text(Strings.t("profiles.iconConnectFirst")).font(.caption).foregroundStyle(.secondary)
            }
        }.onAppear { request(nil) }
            .onChange(of: actionToken) { _ in if selected == nil { request(nil) } }
    }
    private func request(_ icon: CodexDockIcon?) {
        guard !busy, let account = profile.collectionAccount, let token = actionToken else { return }
        busy = true
        do {
            let client = try StatusClient(operationTimeout: 25)
            self.client = client
            client.profileDockIcon(account: account, icon: icon, actionToken: token) { result in
                DispatchQueue.main.async {
                    busy = false; self.client = nil
                    switch result {
                    case .success(let reply):
                        selected = icon ?? (reply.icon == .appDefault && profile.dockIcon == .chatGPT ? .chatGPT : reply.icon)
                        if let icon { profiles.rememberDockIcon(icon, for: profile) }
                        let baselineReady = icon == nil || CodexDockIconCoordinator.shared.reconcile()
                        message = !baselineReady ? Strings.t("profiles.iconApplyFailed")
                            : icon == nil ? nil : Strings.t("profiles.iconSaved")
                    case .failure: message = Strings.t("profiles.iconApplyFailed")
                    }
                }
            }
        } catch { busy = false; message = Strings.t("profiles.iconApplyFailed") }
    }
}
