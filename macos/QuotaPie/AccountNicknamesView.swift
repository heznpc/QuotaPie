import SwiftUI

struct AccountNicknamesView: View {
    @ObservedObject var model: PopoverModel
    let refresh: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(Strings.t("accounts.nicknames.title")).font(.headline)
            Text(Strings.t("accounts.nicknames.hint")).font(.caption).foregroundStyle(.secondary)
            ForEach(model.payload?.accounts ?? []) { account in
                AccountNicknameRow(account: account, token: model.payload?.actionToken, refresh: refresh)
            }
        }
    }
}

private struct AccountNicknameRow: View {
    let account: AccountState
    let token: String?
    let refresh: () -> Void
    @State private var draft: String
    @State private var saved: String
    @State private var saving = false
    @State private var message: String?
    @State private var client: StatusClient?

    init(account: AccountState, token: String?, refresh: @escaping () -> Void) {
        self.account = account; self.token = token; self.refresh = refresh
        _draft = State(initialValue: account.nickname ?? "")
        _saved = State(initialValue: account.nickname ?? "")
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(account.providerTitle + " · " + account.accountLabel).font(.callout)
            HStack {
                TextField(Strings.t("accounts.nicknames.field"), text: $draft)
                    .textFieldStyle(.roundedBorder)
                    .onSubmit { if canSave { save() } }
                Button(Strings.t("accounts.nicknames.save"), action: save).disabled(!canSave)
            }
            if let message { Text(message).font(.caption).foregroundStyle(.secondary) }
        }.disabled(saving || token == nil)
    }
    private var canSave: Bool { !saving && token != nil && draft.count <= 80 && draft.trimmingCharacters(in: .whitespacesAndNewlines) != saved }
    private func save() {
        guard canSave, let token else { return }
        saving = true; message = nil
        let nickname = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        do {
            let connection = try StatusClient()
            client = connection
            connection.saveNickname(provider: account.provider, account: account.account, nickname: nickname, actionToken: token) { result in
                DispatchQueue.main.async {
                    saving = false; client = nil
                    switch result {
                    case .success:
                        saved = nickname; draft = nickname
                        message = Strings.t("accounts.nicknames.saved")
                        refresh()
                    case .failure: message = Strings.t("accounts.nicknames.error")
                    }
                }
            }
        } catch { saving = false; message = Strings.t("accounts.nicknames.error") }
    }
}
