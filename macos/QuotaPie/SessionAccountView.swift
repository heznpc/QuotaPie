import SwiftUI
import AppKit

/// A selected conversation is explicit; global activity is never its fallback.
struct SessionAccountView: View {
    @ObservedObject var model: PopoverModel
    var selectAccount: (AccountState) -> Void
    @State private var choosingConversation = false
    @State private var query = ""
    @State private var inspectFailed = false

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack {
                Text(Strings.t("sessionAccount.title")).font(.caption).foregroundStyle(.secondary)
                Spacer()
                Button { choosingConversation = true } label: {
                    Text(Strings.t(model.displayedConversation == nil ? "sessionAccount.choose" : "sessionAccount.other"))
                        .font(.caption)
                }
                .buttonStyle(.borderless)
                .fixedSize()
                .accessibilityIdentifier("sessionAccount.choose")
                .help(Strings.t("sessionAccount.unmatched"))
                .popover(isPresented: $choosingConversation) { conversationPicker }
            }
            if let conversation = model.displayedConversation {
                Text(conversation.displayTitle).font(.caption).lineLimit(1)
                Menu {
                    ForEach(model.enabledAccounts.filter { $0.provider == "codex" }) { account in
                        let option = model.requestAccountCatalog?.option(provider: account.provider, account: account.account)
                        Button {
                            selectAccount(account)
                        } label: {
                            Text(account.accountLabel + " · " + (option?.remaining.map { "\(Int($0))%" } ?? option?.statusText ?? Strings.t("sessionAccount.unverified")))
                        }
                        .disabled(option?.available != true)
                    }
                } label: {
                    Text(model.conversationAccountText)
                        .font(.system(size: 12, weight: .semibold))
                        .lineLimit(1)
                }
                .menuStyle(.borderlessButton)
                .disabled(model.requestAccountApplying || !model.canActOnTasks)
                .accessibilityIdentifier("sessionAccount.account")
                if let next = conversation.targetAccount, next != conversation.currentAccount {
                    Text(Strings.t("requestAccount.next", model.requestAccountCatalog?.label(for: next) ?? next))
                        .font(.caption2).foregroundStyle(.secondary)
                }
                if SessionHandoff.modoreURL(threadID: conversation.threadId) != nil {
                    Button(Strings.t("sessionAccount.modore")) {
                        SessionHandoff.openInModore(threadID: conversation.threadId) { inspectFailed = !$0 }
                    }
                        .buttonStyle(.borderless)
                        .font(.caption)
                        .accessibilityIdentifier("sessionAccount.modore")
                }
            } else if model.inspectedConversationID != nil {
                Text(Strings.t("sessionAccount.notFound")).font(.caption).foregroundStyle(.secondary)
            }
            if inspectFailed { Text(Strings.t("resume.modoreUnavailable")).font(.caption).foregroundStyle(.orange) }
        }
        .padding(.horizontal, 16).padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityIdentifier("sessionAccount")
    }

    private var conversationPicker: some View {
        VStack(alignment: .leading, spacing: 10) {
            Button(Strings.t("sessionAccount.follow")) {
                model.inspectedConversationID = nil
                choosingConversation = false
            }
            TextField(Strings.t("requestAccount.search"), text: $query)
                .textFieldStyle(.roundedBorder)
                .accessibilityIdentifier("sessionAccount.search")
            let conversations = (model.requestAccountCatalog?.conversations ?? [])
                .filter { SessionHandoff.matches($0, query: query) }
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 4) {
                    if conversations.isEmpty { Text(Strings.t("sessionAccount.noMatches")).foregroundStyle(.secondary) }
                    ForEach(conversations) { conversation in
                        Button {
                            model.inspectedConversationID = conversation.threadId
                            inspectFailed = false
                            choosingConversation = false
                        } label: {
                            VStack(alignment: .leading, spacing: 3) {
                                Text(conversation.displayTitle).lineLimit(2).multilineTextAlignment(.leading)
                                Text(String(conversation.threadId.prefix(8)) + " · " +
                                     (model.requestAccountCatalog?.label(for: conversation.currentAccount) ?? ""))
                                    .font(.caption2).foregroundStyle(.secondary)
                            }.frame(maxWidth: .infinity, alignment: .leading).padding(6)
                        }.buttonStyle(.plain)
                    }
                }
            }.frame(height: 280)
        }.padding(12).frame(width: 340)
    }
}
