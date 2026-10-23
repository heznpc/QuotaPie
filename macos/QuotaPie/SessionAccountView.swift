import SwiftUI
import AppKit

/// A selected conversation is explicit; global activity is never its fallback.
struct SessionAccountView: View {
    @ObservedObject var model: PopoverModel
    var selectAccount: (AccountState) -> Void
    var chooseConversation: () -> Void
    @State private var inspectFailed = false

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack {
                Text(Strings.t(model.inspectedConversationID == nil ? "sessionAccount.title" : "sessionAccount.inspected")).font(.caption).foregroundStyle(.secondary)
                Spacer()
                Button(action: chooseConversation) {
                    Text(Strings.t(model.displayedConversation == nil ? "sessionAccount.choose" : "sessionAccount.other"))
                        .font(.caption)
                }
                .buttonStyle(.borderless)
                .fixedSize()
                .accessibilityIdentifier("sessionAccount.choose")
                .help(Strings.t("sessionAccount.unmatched"))
            }
            if let conversation = model.displayedConversation {
                Text(conversation.displayTitle).font(.system(size: 13, weight: .semibold)).lineLimit(2)
                HStack(spacing: 8) {
                    accountChooser
                    Spacer(minLength: 0)
                    if model.requestAccountCatalogError == nil, model.lastError == nil,
                       let account = conversation.currentAccount,
                       let remaining = model.requestAccountCatalog?.option(provider: "codex", account: account)?.remaining {
                        Text(Strings.t("requestAccount.remaining", String(Int(remaining))))
                            .font(.caption).foregroundStyle(.secondary).fixedSize()
                    }
                }
                if let next = conversation.targetAccount, next != conversation.currentAccount {
                    Label(Strings.t("requestAccount.next", model.requestAccountCatalog?.label(for: next) ?? next), systemImage: "checkmark.circle")
                        .font(.caption2).foregroundStyle(.secondary)
                } else if let preferred = conversation.preferredAccount, preferred != conversation.currentAccount {
                    Text(Strings.t("requestAccount.preferred", model.requestAccountCatalog?.label(for: preferred) ?? preferred))
                        .font(.caption2).foregroundStyle(.secondary)
                }
                Text(Strings.t("sessionAccount.scope"))
                    .font(.caption2).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                if !otherRequestAccounts.isEmpty {
                    Label(Strings.t("sessionAccount.otherRequests", otherRequestAccounts.joined(separator: ", ")), systemImage: "arrow.triangle.branch")
                        .font(.caption2).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                }
                if SessionHandoff.modoreURL(threadID: conversation.threadId) != nil {
                    Button(Strings.t("sessionAccount.modore")) {
                        SessionHandoff.openInModore(threadID: conversation.threadId) { inspectFailed = !$0 }
                    }
                        .buttonStyle(.borderless)
                        .font(.caption)
                        .accessibilityIdentifier("sessionAccount.modore")
                }
            } else {
                Text(Strings.t(model.inspectedConversationID == nil ? "sessionAccount.chooseHelp" : "sessionAccount.notFound"))
                    .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            if let message = model.requestAccountResult {
                Text(message).font(.caption).fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("sessionAccount.result")
            }
            if inspectFailed { Text(Strings.t("resume.modoreUnavailable")).font(.caption).foregroundStyle(.orange) }
        }
        .padding(.horizontal, 16).padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityIdentifier("sessionAccount")
    }

    private var otherRequestAccounts: [String] {
        guard let conversation = model.displayedConversation, model.lastError == nil,
              let routing = model.payload?.routing, routing.isCurrent() else { return [] }
        let cutoff = Date().timeIntervalSince1970 * 1_000 - 15 * 60_000
        let ids = Set((routing.active + routing.recent).filter {
            $0.hasVerifiedAccount && $0.observedAtMs >= cutoff && $0.threadId != nil &&
            $0.threadId != conversation.threadId && $0.account != conversation.currentAccount
        }.compactMap(\.account))
        return model.enabledAccounts.filter { $0.provider == "codex" && ids.contains($0.account) }.map(\.accountLabel)
    }


    @ViewBuilder private var accountChooser: some View {
        let accounts = model.enabledAccounts.filter { $0.provider == "codex" }
        if accounts.contains(where: { model.requestAccountAction(for: $0).isActionable }) {
            Menu {
                ForEach(accounts) { account in
                    let state = model.requestAccountAction(for: account)
                    let remaining = model.requestAccountCatalog?.option(provider: "codex", account: account.account)?.remaining
                    if state.isActionable {
                        Button { selectAccount(account) } label: {
                            Text(account.accountLabel + (remaining.map { " · \(Int($0))%" } ?? ""))
                        }
                    } else {
                        Text(account.accountLabel + " · " + state.text)
                    }
                }
            } label: {
                Text(model.conversationAccountText).font(.system(size: 12, weight: .semibold)).lineLimit(1)
            }
            .menuStyle(.borderlessButton)
            .accessibilityIdentifier("sessionAccount.account")
        } else {
            Text(model.conversationAccountText).font(.system(size: 12, weight: .semibold)).lineLimit(1)
            if model.requestAccountApplying { ProgressView().controlSize(.small) }
        }
    }

}
