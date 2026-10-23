import Foundation
import XCTest
@testable import QuotaPie

final class RequestAccountSelectionTests: XCTestCase {
    private let thread = "11111111-1111-4111-8111-111111111111"

    func testNewConversationChoiceNeedsNoExistingConversationAndWaitsForAcknowledgment() {
        let model = RequestAccountSelectionModel(account: "B", label: "Second account")
        let empty = RequestAccountCatalog(conversations: [], accounts: catalog().accounts)
        model.load { $0(.success(empty)) }
        var completion: RequestAccountCatalogCompletion?
        model.setNewConversations(true) { account, reply in
            XCTAssertEqual(account, "B")
            completion = reply
        }
        XCTAssertTrue(model.savingNewConversations)
        XCTAssertNil(model.catalog?.newConversationAccount)
        var saved = empty
        saved.newConversationAccount = "B"
        completion?(.success(saved))
        XCTAssertEqual(model.catalog?.newConversationAccount, "B")
        model.setNewConversations(false) { account, reply in
            XCTAssertNil(account)
            reply(.failure(StatusClientError.missingActionToken))
        }
        XCTAssertEqual(model.catalog?.newConversationAccount, "B")
        XCTAssertNotNil(model.error)
    }

    func testSuccessfulSelectionChangesOnlyFutureTargetAfterServerAcknowledgesIt() throws {
        let model = RequestAccountSelectionModel(account: "B", label: "Second account")
        model.load { $0(.success(self.catalog())) }
        var completion: RequestAccountAssignmentCompletion?
        model.apply(threadID: thread) { thread, account, reply in
            XCTAssertEqual(thread, self.thread)
            XCTAssertEqual(account, "B")
            completion = reply
        }
        XCTAssertFalse(model.canApply)
        XCTAssertEqual(model.applyingThreadID, thread)
        XCTAssertNil(model.catalog?.conversations.first?.targetAccount)
        completion?(.success(.init(threadId: thread, account: "B", label: "Second account")))
        let conversation = try XCTUnwrap(model.catalog?.conversations.first)
        XCTAssertEqual(conversation.currentAccount, "A")
        XCTAssertEqual(conversation.sourceAccount, "A")
        XCTAssertEqual(conversation.targetAccount, "B")
        XCTAssertTrue(conversation.active)
        XCTAssertEqual(model.appliedThreadID, thread)
        XCTAssertNil(model.error)
    }

    func testUnavailableAccountCannotBeAppliedAndFailureDoesNotInventSuccess() {
        let model = RequestAccountSelectionModel(account: "B", label: "Second account")
        model.load { $0(.success(self.catalog(available: false))) }
        model.apply(threadID: thread) { _, _, _ in XCTFail("Unavailable target must not be submitted") }
        XCTAssertFalse(model.canApply)
        model.load { $0(.success(self.catalog())) }
        model.apply(threadID: thread) { _, _, reply in
            reply(.failure(RequestAccountError(code: "pool_manual_target_model_unavailable")))
        }
        XCTAssertNil(model.catalog?.conversations.first?.targetAccount)
        XCTAssertNil(model.appliedThreadID)
        XCTAssertEqual(model.error, Strings.t("requestAccount.error.model"))
    }

    func testUnexpectedAssignmentAndRefreshFailureCannotLeaveAnActionableStaleCatalog() {
        let model = RequestAccountSelectionModel(account: "B", label: "Second account")
        model.load { $0(.success(self.catalog())) }
        model.apply(threadID: thread) { _, _, reply in
            reply(.success(.init(threadId: self.thread, account: "A", label: "First account")))
        }
        XCTAssertNil(model.appliedThreadID)
        XCTAssertNil(model.catalog?.conversations.first?.targetAccount)
        XCTAssertEqual(model.error, StatusClientError.invalidResponse.localizedDescription)
        model.load { $0(.failure(RequestAccountError(code: "request_account_observer_unavailable"))) }
        XCTAssertNil(model.catalog)
        XCTAssertFalse(model.canApply)
    }

    func testUnknownAccountsAndServerFailuresHaveExplicitPresentation() throws {
        XCTAssertEqual(catalog().label(for: nil), Strings.t("requestAccount.unknownAccount"))
        XCTAssertEqual(catalog().label(for: "B"), "Second account")
        for (code, key) in [
            ("pool_manual_target_quota_exhausted", "quota"),
            ("pool_manual_model_not_allowed", "model"),
            ("pool_manual_identity_mismatch", "identity"),
            ("request_account_observer_unavailable", "observerUnavailable"),
            ("request_account_unknown_thread", "unknownThread")
        ] {
            let data = try JSONSerialization.data(withJSONObject: ["error": code])
            XCTAssertEqual(RequestAccountError(data: data, status: 409).errorDescription,
                           Strings.t("requestAccount.error." + key))
        }
    }

    func testAccountRoutingDoesNotLeakAcrossProvidersWithTheSameProfileID() {
        let catalog = RequestAccountCatalog(conversations: [], accounts: [.init(account: "default", label: "Codex", available: false, reason: "pool_manual_quota_exhausted")])
        XCTAssertNotNil(catalog.option(provider: "codex", account: "default"))
        XCTAssertNil(catalog.option(provider: "claude", account: "default"))
    }

    func testCreditConsentCannotHideExpiredAuthentication() {
        let option = RequestAccountOption(account: "B", label: "Second", available: false,
            reason: "pool_manual_authentication_unavailable", creditAllowed: true)
        XCTAssertEqual(option.statusText, Strings.t("requestAccount.error.identity"))
    }

    func testFocusedConversationRequiresUniqueExactTitle() {
        let original = catalog()
        XCTAssertEqual(FocusedConversation.match(title: "Active conversation", catalog: original)?.threadId, thread)
        XCTAssertNil(FocusedConversation.match(title: "Active", catalog: original))
        XCTAssertNil(FocusedConversation.match(title: nil, catalog: original))
        let ambiguous = RequestAccountCatalog(conversations: original.conversations + original.conversations, accounts: original.accounts)
        XCTAssertNil(FocusedConversation.match(title: "Active conversation", catalog: ambiguous))
    }

    private func catalog(available: Bool = true) -> RequestAccountCatalog {
        .init(conversations: [.init(threadId: thread, title: "Active conversation", sourceAccount: "A",
                                    currentAccount: "A", targetAccount: nil, active: true)],
              accounts: [.init(account: "A", label: "First account", available: true, reason: nil),
                         .init(account: "B", label: "Second account", available: available,
                               reason: available ? nil : "pool_manual_target_quota_exhausted")])
    }
}
