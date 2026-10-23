import SwiftUI
import AppKit

struct CodexProfilesView: View {
    @ObservedObject var status: PopoverModel
    let actions: PopoverActions
    @ObservedObject private var profiles = CodexProfilesModel.shared
    @State private var name = ""
    @State private var home: String?
    @State private var data: String?

    private var candidates: [CodexDesktopProfile] {
        profiles.discovered.filter { $0.account(in: status.payload?.accounts ?? [])?.hasConnected != true }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(Strings.t("accounts.discoveredTitle")).font(.headline)
            Text(Strings.t("accounts.discoveredHint")).font(.callout).foregroundStyle(.secondary)
            ForEach(candidates) { profile in
                let running = profiles.runningProfileIDs.contains(profile.id)
                let account = profile.account(in: status.payload?.accounts ?? [])
                HStack(spacing: 12) {
                    Image(systemName: "desktopcomputer").font(.title2).foregroundStyle(.secondary)
                    VStack(alignment: .leading, spacing: 3) {
                        Text(profile.name).fontWeight(.medium)
                        Text(account?.collection.actionText ?? Strings.t(running ? "accounts.running" : "accounts.openAndLogin"))
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    Spacer(minLength: 8)
                    if running {
                        Button(Strings.t("profiles.connect")) {
                            profiles.connect(profile, token: status.payload?.actionToken, completion: actions.refresh)
                        }.disabled(!status.canActOnTasks)
                    } else {
                        Button(Strings.t("accounts.open")) {
                            profiles.open(profile) { refreshDiscovery() }
                        }
                    }
                }
            }
            Button {
                let label = Strings.t("accounts.newName", String(profiles.profiles.count + 1))
                if let profile = profiles.add(name: label, home: nil, data: nil) {
                    refreshDiscovery()
                    profiles.open(profile) { refreshDiscovery() }
                }
            } label: {
                Label(Strings.t("accounts.newCodex"), systemImage: "plus")
            }
            if profiles.busy { ProgressView().controlSize(.small) }
            if let message = profiles.message {
                Text(message).font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
            }
            DisclosureGroup(Strings.t("accounts.advanced")) {
                VStack(alignment: .leading, spacing: 10) {
                    Text(Strings.t("accounts.manualHint")).font(.caption).foregroundStyle(.secondary)
                    TextField(Strings.t("profiles.name"), text: $name)
                    Button(Strings.t("profiles.chooseHome")) { choose { home = $0 } }
                    if let home { Text(home).font(.caption).textSelection(.enabled) }
                    Button(Strings.t("profiles.chooseData")) { choose { data = $0 } }
                    if let data { Text(data).font(.caption).textSelection(.enabled) }
                    Button(Strings.t("profiles.register")) {
                        if profiles.add(name: name, home: home, data: data) != nil {
                            name = ""; home = nil; data = nil
                            refreshDiscovery()
                        }
                    }.disabled(name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || home == nil || data == nil)
                    ForEach(profiles.profiles) { profile in
                        DisclosureGroup(profile.name) {
                            Text("CODEX_HOME: " + profile.codexHome).textSelection(.enabled)
                            Text(Strings.t("profiles.appData") + ": " + profile.appData).textSelection(.enabled)
                            Button(Strings.t("profiles.open")) { profiles.open(profile) { refreshDiscovery() } }
                            if profile.id != "primary" {
                                Button(Strings.t("profiles.remove")) { profiles.remove(profile); refreshDiscovery() }
                            }
                        }.font(.caption)
                    }
                    Text(Strings.t("profiles.scope")).font(.caption).foregroundStyle(.secondary)
                }.padding(.top, 10)
            }
        }
        .disabled(profiles.busy)
        .onAppear { refreshDiscovery() }
    }

    private func refreshDiscovery() {
        guard AppVerification.current == nil else { return }
        profiles.refreshDiscovery(accounts: status.payload?.accounts ?? [])
    }

    private func choose(_ selected: (String) -> Void) {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true; panel.canChooseFiles = false
        panel.allowsMultipleSelection = false; panel.showsHiddenFiles = true
        if panel.runModal() == .OK, let url = panel.url { selected(url.path) }
    }
}
