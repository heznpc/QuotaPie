import XCTest
@testable import QuotaPie

final class FocusedConversationTests: XCTestCase {
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
        XCTAssertEqual(model.conversationAccountText, Strings.t("sessionAccount.unverified"))
        model.focusedConversationTitle = "Unknown window"
        XCTAssertNil(model.displayedConversation)
        model.inspectedConversationID = "a"
        XCTAssertEqual(model.displayedConversation?.threadId, "a")
        model.requestAccountCatalog = nil
        XCTAssertNil(model.displayedConversation)
    }

    func testDuplicateTitlesNeverPickAnArbitraryAccount() {
        let a = RequestAccountConversation(threadId: "a", title: "Same", sourceAccount: "a",
            currentAccount: "a", targetAccount: nil, active: true)
        let b = RequestAccountConversation(threadId: "b", title: "Same", sourceAccount: "b",
            currentAccount: "b", targetAccount: nil, active: false)
        XCTAssertNil(FocusedConversation.match(title: "Same", catalog: .init(conversations: [a, b], accounts: [])))
    }
}
