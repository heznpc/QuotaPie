import Foundation
import Combine

struct RequestAccountCatalog: Decodable {
    var conversations: [RequestAccountConversation]
    let accounts: [RequestAccountOption]

    func label(for account: String?) -> String {
        accounts.first { $0.account == account }?.label ?? Strings.t("requestAccount.unknownAccount")
    }
}

struct RequestAccountConversation: Decodable, Identifiable {
    let threadId: String
    let title: String
    let sourceAccount: String?
    let currentAccount: String?
    var targetAccount: String?
    let active: Bool
    var id: String { threadId }
    var displayTitle: String { title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? Strings.t("requestAccount.untitled") : title }
}

struct RequestAccountOption: Decodable, Identifiable {
    let account: String
    let label: String
    let available: Bool
    let reason: String?
    var id: String { account }
}

struct RequestAccountAssignment: Decodable {
    let threadId: String
    let account: String
    let label: String
}

struct RequestAccountError: LocalizedError {
    let code: String
    let reason: String?

    init(code: String, reason: String? = nil) { self.code = code; self.reason = reason }

    init(data: Data, status: Int) {
        struct Failure: Decodable { let error: String?; let code: String?; let reason: String? }
        let failure = try? JSONDecoder().decode(Failure.self, from: data)
        code = failure?.error ?? failure?.code ?? (status == 401 || status == 403 ? "forbidden" : "request_account_update_failed")
        reason = failure?.reason
    }

    var errorDescription: String? {
        switch code {
        case "forbidden": return Strings.t("client.missingActionToken")
        case "request_account_unknown_thread": return Strings.t("requestAccount.error.unknownThread")
        case "request_account_observer_unavailable": return Strings.t("requestAccount.error.observerUnavailable")
        case "request_account_invalid_request": return Strings.t("requestAccount.error.invalidRequest")
        default:
            if code.hasPrefix("pool_manual_") || code == "target_unavailable" {
                return Self.unavailableReason(reason ?? code)
            }
            return Strings.t("requestAccount.error.failed")
        }
    }

    static func unavailableReason(_ reason: String?) -> String {
        guard let reason else { return Strings.t("requestAccount.error.unavailable") }
        if reason.contains("quota") || reason.contains("exhaust") || reason.contains("reserve") {
            return Strings.t("requestAccount.error.quota")
        }
        if reason.contains("model") { return Strings.t("requestAccount.error.model") }
        if reason.contains("identity") || reason.contains("auth") || reason.contains("credential") {
            return Strings.t("requestAccount.error.identity")
        }
        if reason.contains("upgrade") || reason.contains("runtime") || reason.contains("relay") {
            return Strings.t("requestAccount.error.observerUnavailable")
        }
        return Strings.t("requestAccount.error.unavailable")
    }
}

typealias RequestAccountCatalogCompletion = (Result<RequestAccountCatalog, Error>) -> Void
typealias RequestAccountAssignmentCompletion = (Result<RequestAccountAssignment, Error>) -> Void

/// A saved preference describes future requests. It never rewrites an observed
/// current account or changes which account the user is inspecting.
final class RequestAccountSelectionModel: ObservableObject {
    let account: String
    let label: String
    @Published private(set) var catalog: RequestAccountCatalog?
    @Published private(set) var loading = false
    @Published private(set) var applyingThreadID: String?
    @Published private(set) var error: String?
    @Published private(set) var appliedThreadID: String?

    init(account: String, label: String) { self.account = account; self.label = label }

    var target: RequestAccountOption? { catalog?.accounts.first { $0.account == account } }
    var canApply: Bool { !loading && applyingThreadID == nil && target?.available == true }

    func load(using load: (@escaping RequestAccountCatalogCompletion) -> Void) {
        guard !loading, applyingThreadID == nil else { return }
        loading = true
        error = nil
        appliedThreadID = nil
        load { [weak self] result in
            guard let self else { return }
            self.loading = false
            switch result {
            case .success(let catalog): self.catalog = catalog
            case .failure(let error):
                self.catalog = nil
                self.error = error.localizedDescription
            }
        }
    }

    func apply(threadID: String, using apply: (String, String, @escaping RequestAccountAssignmentCompletion) -> Void) {
        guard canApply, catalog?.conversations.contains(where: { $0.threadId == threadID }) == true else { return }
        applyingThreadID = threadID
        error = nil
        appliedThreadID = nil
        apply(threadID, account) { [weak self] result in
            guard let self else { return }
            self.applyingThreadID = nil
            switch result {
            case .success(let assignment):
                guard assignment.threadId == threadID, assignment.account == self.account else {
                    self.error = StatusClientError.invalidResponse.localizedDescription
                    return
                }
                if let index = self.catalog?.conversations.firstIndex(where: { $0.threadId == threadID }) {
                    self.catalog?.conversations[index].targetAccount = assignment.account
                }
                self.appliedThreadID = threadID
            case .failure(let error): self.error = error.localizedDescription
            }
        }
    }
}
