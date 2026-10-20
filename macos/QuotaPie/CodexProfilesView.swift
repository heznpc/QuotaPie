import SwiftUI
import AppKit

struct CodexProfilesView: View {
    @ObservedObject var status: PopoverModel
    let actions: PopoverActions
    @ObservedObject private var profiles = CodexProfilesModel.shared
    @State private var adding = false
    @State private var name = ""
    @State private var home: String?
    @State private var data: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(Strings.t("profiles.title")).font(.headline)
            Text(Strings.t("profiles.description")).font(.callout).foregroundStyle(.secondary)
            if let consolidation = profiles.consolidation {
                Text(Strings.t(consolidation.state == "complete" ? "profiles.consolidationComplete" : "profiles.consolidationPending"))
                    .font(.callout).foregroundStyle(consolidation.state == "complete" ? Color.secondary : Color.orange)
                    .accessibilityIdentifier("codex-session-consolidation-status")
            }
            if profiles.consolidationStatus?.state == "waiting-for-source-exit", profiles.consolidation?.state != "waiting-for-source-exit" {
                Text(Strings.t("profiles.consolidationPending")).font(.callout).foregroundStyle(.orange)
            }
            if ["blocked", "failed"].contains(profiles.consolidationStatus?.state ?? "") {
                Text(Strings.t("profiles.consolidationFailed")).font(.callout).foregroundStyle(.orange)
            }
            ForEach(profiles.profiles) { profile in
                let appAction = CodexAccountAction(profile: profile, consolidation: profiles.consolidation,
                    requiresVerification: profiles.requiresConsolidationVerification(profile))
                VStack(alignment: .leading, spacing: 5) {
                    HStack {
                        Text(profile.name).fontWeight(.medium)
                        Spacer()
                        Button(appAction.title) { profiles.open(profile) }
                            .help(appAction.help)
                            .disabled(!appAction.isEnabled ||
                                (profiles.isConsolidationRunning(profile) && profile.credentialOnly != true))
                        if profile.id != "primary" {
                            Button(Strings.t("profiles.accountLogin")) { profiles.open(profile, intent: .accountLogin) }
                                .disabled(!profiles.allowsAccountLogin(profile))
                        }
                        Button(Strings.t("profiles.connect")) {
                            profiles.connect(profile, token: status.payload?.actionToken)
                        }.disabled(!status.canActOnTasks)
                        if profile.id != "primary" {
                            Button(Strings.t("profiles.remove")) { profiles.remove(profile) }
                        }
                    }
                    if profile.id != "primary" && !profiles.isKnownConsolidated(profile) {
                        Button(Strings.t("profiles.consolidate")) {
                            profiles.requestConsolidation(profile, token: status.payload?.actionToken)
                        }.disabled(!status.canActOnTasks || profiles.isConsolidationRunning(profile) || profiles.requiresConsolidationVerification(profile))
                        .accessibilityIdentifier("consolidate-codex-sessions-" + profile.id)
                    }
                    if let account = profile.collectionAccount {
                        if let observed = status.payload?.accounts.first(where: { $0.provider == "codex" && $0.account == account }) {
                            Text(observed.collection.isHealthy ? Strings.t("profiles.collecting") : observed.collection.actionText)
                                .font(.caption).foregroundStyle(observed.collection.isHealthy ? Color.secondary : Color.orange)
                        } else {
                            Text(Strings.t("profiles.awaiting")).font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    if let account = profile.collectionAccount {
                        let tasks = status.activeTasks.filter { $0.provider == "codex" && $0.account == account }
                        if !tasks.isEmpty {
                            PausedWorkSection(tasks: tasks, hasActionToken: status.canActOnTasks,
                                activities: status.resumeActivities, onResume: actions.resumeTask,
                                onRetry: actions.retryTask, onDismiss: actions.dismissTask)
                        }
                    }
                    if profiles.allowsAutomaticRestoration(profile) {
                        CodexDockIconPicker(profile: profile, actionToken: status.payload?.actionToken, profiles: profiles)
                    }
                    if profile.id != "primary" && profiles.allowsAutomaticRestoration(profile) {
                        Toggle(Strings.t("profiles.restoreOnLogin"), isOn: Binding(
                            get: { profile.restoreOnLogin != false },
                            set: { profiles.setRestoreOnLogin($0, for: profile) }))
                    }
                    if profiles.requiresConsolidationVerification(profile) {
                        Text(Strings.t("profiles.error.consolidationUnavailable")).font(.caption).foregroundStyle(.orange)
                    } else if profiles.isConsolidationRunning(profile) {
                        Text(Strings.t("profiles.error.consolidationRunning")).font(.caption).foregroundStyle(.orange)
                    } else if profiles.isConsolidationPending(profile) {
                        Text(Strings.t("profiles.error.consolidationPending")).font(.caption).foregroundStyle(.orange)
                    } else if profiles.consolidation?.completed(profile) == true {
                        Text(Strings.t("profiles.consolidatedAccount")).font(.caption).foregroundStyle(.secondary)
                    } else if profile.credentialOnly == true {
                        Text(Strings.t("profiles.loginOnly")).font(.caption).foregroundStyle(.secondary)
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
        .onAppear { profiles.refreshConsolidation() }
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
