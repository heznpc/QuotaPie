import SwiftUI

struct AccountConnectionsView: View {
    @ObservedObject var status: PopoverModel
    let actions: PopoverActions

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            VStack(alignment: .leading, spacing: 6) {
                Text(Strings.t("accounts.title")).font(.title2.weight(.semibold))
                Text(Strings.t("accounts.description")).font(.callout).foregroundStyle(.secondary)
            }
            VStack(alignment: .leading, spacing: 12) {
                Text(Strings.t("accounts.connected")).font(.headline)
                if status.connectedAccounts.isEmpty {
                    Text(Strings.t("accounts.empty")).font(.callout).foregroundStyle(.secondary)
                }
                ForEach(status.connectedAccounts) { account in
                    HStack(spacing: 12) {
                        Image(systemName: "person.crop.circle").font(.title2).foregroundStyle(.secondary)
                        VStack(alignment: .leading, spacing: 3) {
                            Text("\(account.providerTitle) · \(account.accountLabel)").fontWeight(.medium)
                            Text(status.lastError != nil ? status.statusFailureText :
                                    account.collection.isHealthy ? Strings.t("accounts.ready") : account.collection.actionText)
                                .font(.caption).foregroundStyle(status.lastError == nil && account.collection.isHealthy ? Color.secondary : Color.orange)
                        }
                        Spacer(minLength: 8)
                        Button(Strings.t("accounts.show")) {
                            status.selectAccount(account)
                            status.showOverview()
                        }
                    }
                }
            }
            Divider()
            CodexProfilesView(status: status, actions: actions)
            Divider()
            DisclosureGroup(Strings.t("accounts.claudeGuide")) {
                VStack(alignment: .leading, spacing: 10) {
                    Text(Strings.t("accounts.claudeHint"))
                        .font(.callout).foregroundStyle(.secondary)
                    Button(Strings.t("accounts.copyClaudeLogin")) { actions.copyCommand("claude auth login") }
                    Text(Strings.t("accounts.claudeCollection"))
                        .font(.callout).foregroundStyle(.secondary)
                    Button(Strings.t("action.openSettings"), action: actions.openConfig)
                }.padding(.top, 8)
            }
        }
        .buttonStyle(.bordered).controlSize(.small)
    }
}
