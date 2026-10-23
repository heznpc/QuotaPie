import SwiftUI

/// Account assignment stays in the menu bar's navigation surface.
struct RequestAccountSelectionView: View {
    @StateObject private var selection: RequestAccountSelectionModel
    @State private var search = ""
    @State private var selectedThreadID: String?
    let actions: PopoverActions
    let back: () -> Void
    let didApply: (String) -> Void

    init(account: AccountState, actions: PopoverActions, back: @escaping () -> Void,
         didApply: @escaping (String) -> Void) {
        _selection = StateObject(wrappedValue: RequestAccountSelectionModel(account: account.account, label: account.accountLabel))
        self.actions = actions
        self.back = back
        self.didApply = didApply
    }

    private var selectedConversation: RequestAccountConversation? {
        selection.catalog?.conversations.first { $0.threadId == selectedThreadID }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ConversationNavigationHeader(title: Strings.t("requestAccount.pickerTitle"), back: back,
                                         refresh: { selection.load(using: actions.loadRequestAccounts) },
                                         busy: selection.applyingThreadID != nil)
            Divider()
            VStack(alignment: .leading, spacing: 5) {
                Text(Strings.t("requestAccount.targetAccount")).font(.caption).foregroundStyle(.secondary)
                HStack(alignment: .firstTextBaseline) {
                    Text(selection.label).font(.system(size: 13, weight: .semibold)).lineLimit(2)
                    Spacer(minLength: 8)
                    if let remaining = selection.target?.remaining {
                        Text(Strings.t("requestAccount.remaining", String(Int(remaining))))
                            .font(.caption).foregroundStyle(.secondary).fixedSize()
                    }
                }
                if let error = selection.error {
                    Label(error, systemImage: "exclamationmark.circle").font(.caption).foregroundStyle(.orange)
                } else if !selection.loading, selection.catalog != nil, selection.target?.available != true {
                    Label(RequestAccountError.unavailableReason(selection.target?.reason), systemImage: "exclamationmark.circle")
                        .font(.caption).foregroundStyle(.orange)
                }
            }.padding(16)
            VStack(alignment: .leading, spacing: 6) {
                Toggle(Strings.t("requestAccount.newConversations"), isOn: Binding(
                    get: { selection.catalog?.newConversationAccount == selection.account },
                    set: { selection.setNewConversations($0, using: actions.configureNewConversations) }
                ))
                .toggleStyle(.switch)
                .disabled(selection.catalog == nil || selection.loading || selection.savingNewConversations ||
                          selection.applyingThreadID != nil ||
                          (selection.catalog?.newConversationAccount != selection.account && selection.target?.canAllowCredits != true))
                .accessibilityIdentifier("requestAccount.newConversations")
                Text(Strings.t("requestAccount.newConversations.help"))
                    .font(.caption).foregroundStyle(.secondary)
                if let account = selection.catalog?.newConversationAccount {
                    Text(Strings.t("requestAccount.newConversations.selected", selection.catalog?.label(for: account) ?? account))
                        .font(.caption).foregroundStyle(.secondary)
                }
            }.padding(.horizontal, 16).padding(.bottom, 12)
            Divider()
            TextField(Strings.t("requestAccount.search"), text: $search)
                .textFieldStyle(.roundedBorder).padding(.horizontal, 16).padding(.vertical, 12)
                .accessibilityIdentifier("requestAccount.search")
            ConversationChoiceList(catalog: selection.catalog, query: search, selectedID: selectedThreadID,
                                   loading: selection.loading, assignmentAccount: selection.account) { selectedThreadID = $0 }
                .disabled(selection.applyingThreadID != nil)
            Divider()
            VStack(alignment: .leading, spacing: 8) {
                Text(selectedConversation?.displayTitle ?? Strings.t("requestAccount.selectPrompt"))
                    .font(.system(size: 12, weight: .medium)).lineLimit(2)
                    .foregroundStyle(selectedConversation == nil ? .secondary : .primary)
                if let conversation = selectedConversation {
                    let state = selection.action(for: conversation)
                    if state.isActionable {
                        Button(Strings.t("requestAccount.confirm")) {
                            selection.apply(threadID: conversation.threadId, using: actions.useRequestAccount)
                        }
                        .buttonStyle(.borderedProminent).controlSize(.large)
                        .accessibilityIdentifier("requestAccount.confirm")
                    } else {
                        RequestAccountControl(state: state, action: {})
                            .accessibilityIdentifier("requestAccount.status")
                    }
                }
                if let conversation = selectedConversation, selection.action(for: conversation).isActionable {
                    Text(Strings.t(selection.target?.autoSwitchEnabled == true
                                   ? "requestAccount.applyTimingAutomatic" : "requestAccount.applyTiming"))
                        .font(.caption2).foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }.padding(16)
        }
        .frame(width: 360)
        .onAppear { selection.load(using: actions.loadRequestAccounts) }
        .onChange(of: selection.appliedThreadID) { threadID in
            if let threadID { didApply(threadID) }
        }
        .accessibilityIdentifier("requestAccount.page")
    }
}
