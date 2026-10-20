import SwiftUI

struct RequestAccountSelectionView: View {
    @Environment(\.dismiss) private var dismiss
    @StateObject private var selection: RequestAccountSelectionModel
    @State private var search = ""
    let actions: PopoverActions

    init(account: AccountState, actions: PopoverActions) {
        _selection = StateObject(wrappedValue: RequestAccountSelectionModel(account: account.account, label: account.accountLabel))
        self.actions = actions
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .firstTextBaseline) {
                Text(Strings.t("requestAccount.title", selection.label)).font(.headline)
                Spacer()
                Button(Strings.t("requestAccount.close")) { dismiss() }
                    .keyboardShortcut(.cancelAction).disabled(selection.applyingThreadID != nil)
            }
            Text(Strings.t("requestAccount.explanation")).font(.callout).foregroundStyle(.secondary)
            if selection.loading {
                HStack { ProgressView().controlSize(.small); Text(Strings.t("requestAccount.loading")) }.font(.callout)
            }
            if let error = selection.error {
                Label(error, systemImage: "exclamationmark.circle").font(.callout).foregroundStyle(.orange)
            }
            if let catalog = selection.catalog {
                if selection.target?.available != true {
                    Label(RequestAccountError.unavailableReason(selection.target?.reason), systemImage: "exclamationmark.circle")
                        .font(.callout).foregroundStyle(.orange)
                }
                TextField(Strings.t("requestAccount.search"), text: $search)
                    .textFieldStyle(.roundedBorder)
                    .accessibilityIdentifier("requestAccount.search")
                if catalog.conversations.isEmpty {
                    Text(Strings.t("requestAccount.empty")).font(.callout).foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, minHeight: 100, alignment: .leading)
                } else {
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 0) {
                            ForEach(catalog.conversations.filter { search.isEmpty ||
                                $0.displayTitle.localizedCaseInsensitiveContains(search) ||
                                $0.threadId.localizedCaseInsensitiveContains(search) }) { conversation in
                                conversationRow(conversation, catalog: catalog)
                                if conversation.id != catalog.conversations.last?.id { Divider().padding(.vertical, 12) }
                            }
                        }
                    }.frame(maxHeight: 340)
                }
            }
            if selection.appliedThreadID != nil {
                Label(Strings.t("requestAccount.applied", selection.label), systemImage: "checkmark.circle")
                    .font(.callout).foregroundStyle(.green)
                    .accessibilityIdentifier("requestAccount.applied")
            }
            Divider()
            HStack {
                Button(Strings.t("action.refresh")) { selection.load(using: actions.loadRequestAccounts) }
                    .disabled(selection.loading || selection.applyingThreadID != nil)
                Spacer()
                Text(Strings.t("requestAccount.noFallback")).font(.caption).foregroundStyle(.secondary)
            }
        }
        .padding(20).frame(width: 440)
        .interactiveDismissDisabled(selection.applyingThreadID != nil)
        .onAppear { selection.load(using: actions.loadRequestAccounts) }
        .accessibilityIdentifier("requestAccount.sheet")
    }

    private func conversationRow(_ conversation: RequestAccountConversation, catalog: RequestAccountCatalog) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack(alignment: .firstTextBaseline) {
                Text(conversation.displayTitle).font(.system(size: 13, weight: .medium)).lineLimit(2)
                    .help(conversation.displayTitle)
                Spacer(minLength: 4)
                if conversation.active { Text(Strings.t("requestAccount.active")).font(.caption).foregroundStyle(.secondary) }
            }
            Text(Strings.t(conversation.active ? "requestAccount.current" : "requestAccount.last", catalog.label(for: conversation.currentAccount)))
                .font(.caption).foregroundStyle(.secondary)
            HStack {
                if let next = conversation.targetAccount {
                    Text(Strings.t("requestAccount.next", catalog.label(for: next))).font(.caption).foregroundStyle(.secondary)
                }
                Spacer(minLength: 6)
                if selection.applyingThreadID == conversation.id { ProgressView().controlSize(.small) }
                Button(Strings.t(conversation.targetAccount == selection.account ? "requestAccount.selected" : "requestAccount.apply")) {
                    selection.apply(threadID: conversation.id, using: actions.useRequestAccount)
                }
                .buttonStyle(.borderedProminent)
                .disabled(!selection.canApply || conversation.targetAccount == selection.account)
                .accessibilityIdentifier("requestAccount.apply." + conversation.id)
            }
        }.frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 2)
    }
}

struct RequestAccountButton: View {
    let enabled: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Label(Strings.t("requestAccount.use"), systemImage: "arrow.triangle.branch")
        }
        .buttonStyle(.bordered).disabled(!enabled)
        .help(Strings.t("requestAccount.useHelp"))
    }
}
