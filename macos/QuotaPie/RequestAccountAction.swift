import SwiftUI

/// The saved next-request choice wins over observed request history. A source
/// profile alone is not proof that this conversation is using that account.
enum RequestAccountActionState: Equatable {
    case inUse, scheduled, chooseConversation, change, applying
    case unavailable(String)

    static func resolve(account: String, conversation: RequestAccountConversation?,
                        option: RequestAccountOption?, canAct: Bool, applying: Bool = false) -> Self {
        if applying { return .applying }
        if conversation?.effectiveAccount == account {
            return conversation?.currentAccount == account ? .inUse : .scheduled
        }
        guard canAct else { return .unavailable(Strings.t("requestAccount.action.connection")) }
        guard let option else { return .unavailable(Strings.t("requestAccount.action.unverified")) }
        guard option.available else { return .unavailable(option.reason == nil ? RequestAccountError.unavailableReason(nil) : option.statusText) }
        return conversation == nil ? .chooseConversation : .change
    }

    var isActionable: Bool { self == .change || self == .chooseConversation }
    var text: String {
        switch self {
        case .inUse: return Strings.t("requestAccount.action.inUse")
        case .scheduled: return Strings.t("requestAccount.action.scheduled")
        case .chooseConversation: return Strings.t("requestAccount.action.chooseConversation")
        case .change: return Strings.t("requestAccount.action.change")
        case .applying: return Strings.t("requestAccount.action.applying")
        case .unavailable(let reason): return reason
        }
    }
}

struct RequestAccountControl: View {
    let state: RequestAccountActionState
    let action: () -> Void

    var body: some View {
        if state.isActionable {
            Button(state.text, action: action).buttonStyle(.bordered)
        } else if state == .applying {
            HStack(spacing: 5) { ProgressView().controlSize(.small); Text(state.text) }.font(.caption)
        } else {
            Label(state.text, systemImage: state == .inUse || state == .scheduled ? "checkmark.circle.fill" : "info.circle")
                .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
        }
    }
}

extension PopoverModel {
    func requestAccountAction(for account: AccountState) -> RequestAccountActionState {
        .resolve(account: account.account, conversation: displayedConversation,
                 option: requestAccountCatalog?.option(provider: account.provider, account: account.account),
                 canAct: canActOnTasks && requestAccountCatalogError == nil, applying: requestAccountApplying)
    }

    func applyRequestAccount(_ account: AccountState,
                             using apply: (String, String, @escaping RequestAccountAssignmentCompletion) -> Void) {
        guard requestAccountAction(for: account).isActionable else { return }
        guard let conversation = displayedConversation else { chooseRequestAccount(account); return }
        requestAccountApplying = true
        requestAccountResult = nil
        apply(conversation.threadId, account.account) { [weak self] result in
            guard let self else { return }
            self.requestAccountApplying = false
            switch result {
            case .success(let assignment):
                guard assignment.threadId == conversation.threadId, assignment.account == account.account else {
                    self.requestAccountResult = StatusClientError.invalidResponse.localizedDescription
                    return
                }
                if let index = self.requestAccountCatalog?.conversations.firstIndex(where: { $0.threadId == conversation.threadId }) {
                    self.requestAccountCatalog?.conversations[index].targetAccount = assignment.account
                    self.requestAccountCatalog?.conversations[index].preferredAccount = assignment.account
                }
            case .failure(let error): self.requestAccountResult = error.localizedDescription
            }
        }
    }
}
