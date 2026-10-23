import SwiftUI

struct ConversationNavigationHeader: View {
    let title: String
    let back: () -> Void
    let refresh: () -> Void
    var busy = false

    var body: some View {
        HStack(spacing: 10) {
            Button(action: back) { Image(systemName: "chevron.left").frame(width: 24, height: 28) }
                .accessibilityLabel(Strings.t("navigation.back"))
                .accessibilityIdentifier("conversationPicker.back")
                .keyboardShortcut(.cancelAction)
            Text(title).font(.system(size: 13, weight: .semibold))
            Spacer(minLength: 0)
            Button(action: refresh) { Image(systemName: "arrow.clockwise").frame(width: 24, height: 28) }
                .accessibilityLabel(Strings.t("action.refresh"))
        }
        .buttonStyle(.borderless).disabled(busy)
        .padding(.horizontal, 12).frame(height: 44)
    }
}

struct ConversationPickerView: View {
    @ObservedObject var model: PopoverModel
    let actions: PopoverActions
    let back: () -> Void
    @State private var query = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ConversationNavigationHeader(title: Strings.t("sessionAccount.choose"), back: back,
                                         refresh: { actions.loadRequestAccounts { _ in } })
            Divider()
            VStack(alignment: .leading, spacing: 10) {
                Text(Strings.t("sessionAccount.chooseHelp")).font(.caption).foregroundStyle(.secondary)
                TextField(Strings.t("requestAccount.search"), text: $query)
                    .textFieldStyle(.roundedBorder).accessibilityIdentifier("sessionAccount.search")
                if model.focusedConversation != nil || model.inspectedConversationID != nil {
                    Button(Strings.t("sessionAccount.follow")) {
                        model.inspectedConversationID = nil
                        model.requestAccountResult = nil
                        back()
                    }.buttonStyle(.borderless).font(.caption)
                }
                if let error = model.requestAccountCatalogError {
                    Label(error, systemImage: "exclamationmark.circle").font(.caption).foregroundStyle(.orange)
                }
            }.padding(16)
            ConversationChoiceList(catalog: model.requestAccountCatalog, query: query,
                                   selectedID: model.displayedConversation?.threadId,
                                   loading: model.requestAccountCatalog == nil && model.requestAccountCatalogError == nil) { threadID in
                model.inspectedConversationID = threadID
                model.requestAccountResult = nil
                back()
            }
        }.frame(width: 360)
            .onAppear { actions.loadRequestAccounts { _ in } }
            .accessibilityIdentifier("conversationPicker.page")
    }
}

struct ConversationChoiceList: View {
    let catalog: RequestAccountCatalog?
    let query: String
    let selectedID: String?
    let loading: Bool
    var assignmentAccount: String? = nil
    let choose: (String) -> Void

    private var conversations: [RequestAccountConversation] {
        (catalog?.conversations ?? []).filter { SessionHandoff.matches($0, query: query) }
    }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 4) {
                if loading {
                    HStack { ProgressView().controlSize(.small); Text(Strings.t("requestAccount.loading")) }
                        .font(.caption).padding(8)
                } else if conversations.isEmpty {
                    Text(Strings.t(query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "requestAccount.empty" : "sessionAccount.noMatches"))
                        .font(.callout).foregroundStyle(.secondary).padding(8)
                }
                ForEach(conversations) { conversation in
                    Button { choose(conversation.threadId) } label: {
                        HStack(alignment: .top, spacing: 10) {
                            VStack(alignment: .leading, spacing: 5) {
                                Text(conversation.displayTitle).font(.system(size: 13, weight: .medium))
                                    .lineLimit(2).fixedSize(horizontal: false, vertical: true)
                                HStack(spacing: 6) {
                                    if conversation.active {
                                        Circle().fill(Color.green).frame(width: 5, height: 5)
                                    }
                                    Text(catalog?.label(for: conversation.currentAccount) ?? Strings.t("requestAccount.unknownAccount"))
                                        .lineLimit(1)
                                    if conversation.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                                        Text(String(conversation.threadId.prefix(8)))
                                    }
                                }.font(.caption).foregroundStyle(.secondary)
                                if let assignmentAccount, conversation.effectiveAccount == assignmentAccount {
                                    Label(Strings.t(conversation.currentAccount == assignmentAccount ? "requestAccount.action.inUse" : "requestAccount.action.scheduled"),
                                          systemImage: "checkmark.circle.fill").font(.caption2).foregroundStyle(.secondary)
                                } else if let next = conversation.targetAccount, next != conversation.currentAccount {
                                    Text(Strings.t("requestAccount.next", catalog?.label(for: next) ?? next))
                                        .font(.caption2).foregroundStyle(.secondary)
                                }
                            }.frame(maxWidth: .infinity, alignment: .leading)
                            Image(systemName: selectedID == conversation.threadId ? "checkmark.circle.fill" : "circle")
                                .foregroundStyle(selectedID == conversation.threadId ? Color.accentColor : Color.secondary.opacity(0.4))
                                .padding(.top, 2)
                        }
                        .multilineTextAlignment(.leading).padding(10)
                        .background(selectedID == conversation.threadId ? Color.accentColor.opacity(0.09) : Color.clear,
                                    in: RoundedRectangle(cornerRadius: 8))
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("conversationPicker.row." + conversation.threadId)
                    .accessibilityValue(selectedID == conversation.threadId ? Strings.t("requestAccount.selected") : "")
                    .help(conversation.displayTitle + "\n" + conversation.threadId)
                }
            }.padding(.horizontal, 6).padding(.bottom, 8)
        }.frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
