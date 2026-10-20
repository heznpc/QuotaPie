import SwiftUI

/// A selected conversation is explicit; global activity is never its fallback.
struct SessionAccountView: View {
    @ObservedObject var model: PopoverModel

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack {
                Text(Strings.t("sessionAccount.title")).font(.caption).foregroundStyle(.secondary)
                Spacer()
                Menu {
                    Button(Strings.t("sessionAccount.follow")) { model.inspectedConversationID = nil }
                    ForEach(model.requestAccountCatalog?.conversations ?? []) { conversation in
                        Button(conversation.displayTitle) { model.inspectedConversationID = conversation.threadId }
                    }
                } label: {
                    Text(Strings.t("sessionAccount.choose"))
                        .font(.caption)
                }
                .menuStyle(.borderlessButton)
                .fixedSize()
                .accessibilityIdentifier("sessionAccount.choose")
                .help(Strings.t("sessionAccount.unmatched"))
            }
            if let conversation = model.displayedConversation {
                Text(conversation.displayTitle).font(.caption).lineLimit(1)
                Text(model.conversationAccountText)
                    .font(.system(size: 12, weight: .semibold))
                    .textSelection(.enabled)
                    .accessibilityIdentifier("sessionAccount.account")
                if let next = conversation.targetAccount, next != conversation.currentAccount {
                    Text(Strings.t("requestAccount.next", model.requestAccountCatalog?.label(for: next) ?? next))
                        .font(.caption2).foregroundStyle(.secondary)
                }
            }
        }
        .padding(.horizontal, 16).padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityIdentifier("sessionAccount")
    }
}
