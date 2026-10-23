import XCTest
@testable import QuotaPie

final class FocusedConversationTests: XCTestCase {
    func testDocumentIdentityIsParsedWithoutGuessingFromArbitraryText() {
        let id = "10000000-0000-4000-8000-000000000099"
        XCTAssertEqual(FocusedConversation.threadID(from: "codex://threads/\(id)?view=review"), id)
        XCTAssertEqual(FocusedConversation.threadID(from: "https://chatgpt.com/codex/threads/\(id)"), id)
        XCTAssertNil(FocusedConversation.threadID(from: "Selected thread \(id)"))
        XCTAssertNil(FocusedConversation.threadID(from: "codex://threads/not-a-thread"))
        XCTAssertNil(FocusedConversation.threadID(from: "codex://accounts/\(id)"))
    }

    func testOnlyUniqueWindowMatchOrExplicitChoiceSelectsConversation() {
        let first = RequestAccountConversation(threadId: "a", title: "Fix QuotaPie update failure",
            sourceAccount: "source", currentAccount: "actual", targetAccount: "future", active: false)
        let other = RequestAccountConversation(threadId: "b", title: "Background task",
            sourceAccount: "other", currentAccount: "other", targetAccount: nil, active: true)
        let model = PopoverModel()
        model.requestAccountCatalog = .init(conversations: [first, other], accounts: [])
        model.focusedConversationTitle = "Fix QuotaPie update failure — Codex"
        XCTAssertEqual(model.displayedConversation?.threadId, "a")
        XCTAssertEqual(model.displayedConversation?.currentAccount, "actual")
        // A saved next-account choice is not proof of the current request.
        XCTAssertNotEqual(model.displayedConversation?.currentAccount, "future")
        XCTAssertEqual(model.conversationAccountText, Strings.t("sessionAccount.last", Strings.t("requestAccount.unknownAccount")))
        model.focusedConversationTitle = "Unknown window"
        XCTAssertNil(model.displayedConversation)
        model.inspectedConversationID = "a"
        XCTAssertEqual(model.displayedConversation?.threadId, "a")
        model.requestAccountCatalog = nil
        XCTAssertNil(model.displayedConversation)
    }

    func testStaleOrFailedRefreshRetainsHistoryWithoutClaimingLiveProcessing() {
        let model = PopoverModel()
        model.inspectedConversationID = "a"
        model.requestAccountCatalog = .init(conversations: [.init(threadId: "a", title: "Work",
            sourceAccount: "source", currentAccount: "actual", targetAccount: "future", active: true)],
            accounts: [.init(account: "actual", label: "Actual", available: true, reason: nil)])
        XCTAssertEqual(model.conversationAccountText, Strings.t("sessionAccount.last", "Actual"))
        model.requestAccountCatalogError = "Temporary network failure"
        XCTAssertEqual(model.conversationAccountText, Strings.t("sessionAccount.last", "Actual"))
        model.requestAccountCatalog?.conversations = [.init(threadId: "a", title: "Work",
            sourceAccount: "source", currentAccount: nil, targetAccount: "future", active: false)]
        XCTAssertEqual(model.conversationAccountText, Strings.t("sessionAccount.unverified"))
    }

    func testDuplicateTitlesNeverPickAnArbitraryAccount() {
        let a = RequestAccountConversation(threadId: "a", title: "Same", sourceAccount: "a",
            currentAccount: "a", targetAccount: nil, active: true)
        let b = RequestAccountConversation(threadId: "b", title: "Same", sourceAccount: "b",
            currentAccount: "b", targetAccount: nil, active: false)
        XCTAssertNil(FocusedConversation.match(title: "Same", catalog: .init(conversations: [a, b], accounts: [])))
    }
}
