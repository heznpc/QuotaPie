import SwiftUI

/// Values understood by the desktop app's profile-local config.toml.
enum CodexDockIcon: String, Codable, CaseIterable {
    case appDefault = "app-default", chatGPT = "chatgpt", codex = "codex-system", space = "space-system"
    // Decode the old ChatGPT preference, but only offer native profile settings.
    static let allCases: [Self] = [.appDefault, .codex, .space]
    var supportedChoice: Self { self == .chatGPT ? .appDefault : self }
    var nativeValue: String { self == .chatGPT ? Self.appDefault.rawValue : rawValue }
    var title: String {
        switch self { case .appDefault: return Strings.t("profiles.iconDefault"); case .chatGPT: return "ChatGPT"; case .codex: return "Codex"; case .space: return "Space" }
    }
}

struct DockIconReply: Decodable { let icon: CodexDockIcon; let changed: Bool }

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
        _selected = State(initialValue: profile.dockIcon?.supportedChoice)
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
            if selected == .appDefault {
                Text(Strings.t("profiles.iconDefaultMayMatch")).font(.caption).foregroundStyle(.secondary)
            }
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
                        selected = (icon ?? reply.icon).supportedChoice
                        if let icon { profiles.rememberDockIcon(icon, for: profile) }
                        message = icon == nil ? nil : Strings.t("profiles.iconSaved")
                    case .failure: message = Strings.t("profiles.iconApplyFailed")
                    }
                }
            }
        } catch { busy = false; message = Strings.t("profiles.iconApplyFailed") }
    }
}
