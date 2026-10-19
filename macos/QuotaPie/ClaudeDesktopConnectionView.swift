import SwiftUI

struct ClaudeDesktopConnectionReply: Decodable {
    let account: AccountState
    let connected: Bool
    let quotaAvailable: Bool
}

enum ClaudeDesktopCollectionText {
    private static func key(_ category: String) -> String {
        switch category {
        case "recent-success": return "connected"
        case "no-windows": return "noQuota"
        case "claude-desktop-keychain": return "keychain"
        case "claude-desktop-unavailable", "never-attempted", "not-configured": return "unavailable"
        case "account-mismatch": return "accountChanged"
        case "auth-required", "auth-expired": return "sessionExpired"
        case "access-denied": return "accessDenied"
        case "rate-limited": return "rateLimited"
        case "network": return "network"
        case "stale-success": return "stale"
        default: return "failed"
        }
    }

    static func title(category: String) -> String { Strings.t("claudeDesktop.state." + key(category)) }
    static func detail(category: String) -> String { Strings.t("claudeDesktop.detail." + key(category)) }
}

struct ClaudeDesktopConnectionError: LocalizedError {
    let category: String
    var errorDescription: String? { ClaudeDesktopCollectionText.detail(category: category) }
}

/// Owned by the app model so switching settings categories cannot start a
/// second interactive Keychain request while the first one is still pending.
final class ClaudeDesktopConnectionModel: ObservableObject {
    // The service may finish a 45-second background read before starting the
    // 120-second interactive helper. Keep a response margin for both stages.
    static let operationTimeout: TimeInterval = 180
    @Published private(set) var busy = false
    @Published private(set) var message: String?
    private var client: StatusClient?

    func connect(model: PopoverModel) {
        guard !busy, model.canActOnTasks, let service = model.statusClient,
              let token = model.payload?.actionToken else { return }
        busy = true
        message = nil
        do {
            // Only this explicit action permits an OS access prompt. It has
            // its own transport and cannot change the ordinary polling budget.
            let connection = try StatusClient(environment: ["QUOTAPIE_API_URL": service.baseURL.absoluteString], operationTimeout: Self.operationTimeout)
            client = connection
            connection.connectClaudeDesktop(actionToken: token) { [weak self, weak model] result in
                DispatchQueue.main.async {
                    guard let self else { return }
                    self.busy = false
                    self.client = nil
                    switch result {
                    case .success:
                        // This is the result of the explicit connection action;
                        // current plan verification belongs to the live account row.
                        self.message = Strings.t("claudeDesktop.state.connected")
                        service.fetchQuota { [weak model] refreshed in
                            DispatchQueue.main.async {
                                if case .success(let payload) = refreshed { model?.applyQuota(payload) }
                            }
                        }
                    case .failure(let error):
                        self.message = (error as? ClaudeDesktopConnectionError)?.errorDescription
                            ?? Strings.t("claudeDesktop.detail.failed")
                    }
                }
            }
        } catch {
            busy = false
            client = nil
            message = Strings.t("claudeDesktop.detail.failed")
        }
    }
}

struct ClaudeDesktopConnectionView: View {
    @ObservedObject var model: PopoverModel
    @ObservedObject private var connection: ClaudeDesktopConnectionModel

    init(model: PopoverModel) {
        self.model = model
        connection = model.claudeDesktopConnection
    }

    private var accounts: [AccountState] { (model.payload?.accounts ?? []).filter(\.isClaudeDesktop) }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(Strings.t("claudeDesktop.title")).font(.headline)
            Text(Strings.t("claudeDesktop.description")).font(.callout).foregroundStyle(.secondary)
            ForEach(accounts) { account in
                VStack(alignment: .leading, spacing: 3) {
                    Text(account.accountLabel).font(.callout.weight(.medium))
                    Text(account.collectionStatusText).font(.caption).foregroundStyle(.secondary)
                }
            }
            HStack(spacing: 10) {
                Button(Strings.t(accounts.isEmpty ? "claudeDesktop.connect" : "claudeDesktop.reconnect")) {
                    connection.connect(model: model)
                }
                .disabled(connection.busy || !model.canActOnTasks || model.statusClient == nil)
                .accessibilityIdentifier("settings.claudeDesktop.connect")
                if connection.busy {
                    ProgressView().controlSize(.small)
                    Text(Strings.t("claudeDesktop.connecting")).font(.caption).foregroundStyle(.secondary)
                }
            }
            Text(Strings.t("claudeDesktop.permission")).font(.caption).foregroundStyle(.secondary)
            if let message = connection.message {
                Text(message).font(.callout).fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("settings.claudeDesktop.result")
            }
            if model.statusClient == nil {
                Text(Strings.t("settings.organized.connectionUnavailable")).font(.caption).foregroundStyle(.secondary)
            }
        }
        .accessibilityIdentifier("settings.claudeDesktop")
    }
}
