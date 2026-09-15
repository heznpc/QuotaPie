import SwiftUI
import AppKit

struct CodexProfilesView: View {
    @ObservedObject private var profiles = CodexProfilesModel.shared
    @State private var adding = false
    @State private var name = ""
    @State private var home: String?
    @State private var data: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(Strings.t("profiles.title")).font(.headline)
            Text(Strings.t("profiles.description")).font(.callout).foregroundStyle(.secondary)
            ForEach(profiles.profiles) { profile in
                VStack(alignment: .leading, spacing: 5) {
                    HStack {
                        Text(profile.name).fontWeight(.medium)
                        Spacer()
                        Button(Strings.t("profiles.open")) { profiles.open(profile) }
                        if profile.id != "primary" {
                            Button(Strings.t("profiles.remove")) { profiles.remove(profile) }
                        }
                    }
                    DisclosureGroup(Strings.t("profiles.paths")) {
                        Text("CODEX_HOME: " + profile.codexHome).textSelection(.enabled)
                        Text(Strings.t("profiles.appData") + ": " + profile.appData).textSelection(.enabled)
                    }.font(.caption).foregroundStyle(.secondary)
                }
            }
            Button(Strings.t("profiles.add")) { adding = true }
            if let message = profiles.message { Text(message).font(.caption).foregroundStyle(.secondary) }
            Text(Strings.t("profiles.scope")).font(.caption).foregroundStyle(.secondary)
        }
        .disabled(profiles.busy)
        .sheet(isPresented: $adding) {
            VStack(alignment: .leading, spacing: 14) {
                Text(Strings.t("profiles.add")).font(.headline)
                TextField(Strings.t("profiles.name"), text: $name)
                Text(Strings.t("profiles.newHint")).font(.callout).foregroundStyle(.secondary)
                Button(Strings.t("profiles.chooseHome")) { choose { home = $0 } }
                if let home { Text(home).font(.caption).textSelection(.enabled) }
                Button(Strings.t("profiles.chooseData")) { choose { data = $0 } }
                if let data { Text(data).font(.caption).textSelection(.enabled) }
                if let error = profiles.message { Text(error).font(.caption).foregroundStyle(.orange) }
                HStack {
                    Button(Strings.t("profiles.cancel")) { reset() }
                    Spacer()
                    Button(Strings.t("profiles.register")) {
                        profiles.add(name: name, home: home, data: data)
                        if profiles.message == nil { reset() }
                    }.disabled(name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }.padding(24).frame(width: 460)
        }
    }
    private func reset() { adding = false; name = ""; home = nil; data = nil }
    private func choose(_ selected: (String) -> Void) {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true; panel.canChooseFiles = false
        panel.allowsMultipleSelection = false; panel.showsHiddenFiles = true
        if panel.runModal() == .OK, let url = panel.url { selected(url.path) }
    }
}
