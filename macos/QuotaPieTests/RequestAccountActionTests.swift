import XCTest
@testable import QuotaPie

final class RequestAccountActionTests: XCTestCase {
    private let available = RequestAccountOption(account: "A", label: "Account A", available: true, reason: nil)

    private func conversation(current: String? = "A", target: String? = nil) -> RequestAccountConversation {
        .init(threadId: "thread", title: "Work", sourceAccount: "A", currentAccount: current, targetAccount: target, active: true)
    }

    func testObservedAndExplicitSameAccountBothRenderAsStatusAndCannotSubmitAgain() {
        for target in [nil, "A"] as [String?] {
            let thread = conversation(target: target)
            let model = RequestAccountSelectionModel(account: "A", label: "Account A")
            model.load { $0(.success(.init(conversations: [thread], accounts: [self.available]))) }
            XCTAssertEqual(model.action(for: thread), .inUse)
            model.apply(threadID: "thread") { _, _, _ in XCTFail("Already using this account must not rewrite its routing policy") }
            XCTAssertNil(model.appliedThreadID)
        }
    }

    func testPendingSwitchIsStatusButCurrentAccountCanCancelIt() {
        let thread = conversation(current: "B", target: "A")
        XCTAssertEqual(RequestAccountActionState.resolve(account: "A", conversation: thread, option: available, canAct: true), .scheduled)
        let current = RequestAccountOption(account: "B", label: "Account B", available: true, reason: nil)
        XCTAssertEqual(RequestAccountActionState.resolve(account: "B", conversation: thread, option: current, canAct: true), .change)
    }

    func testAppliedPreferenceDoesNotMasqueradeAsAPendingSwitchAfterRollover() throws {
        let data = Data(#"{"threadId":"thread","title":"Work","sourceAccount":"A","currentAccount":"B","targetAccount":null,"preferredAccount":"A","active":true}"#.utf8)
        let thread = try JSONDecoder().decode(RequestAccountConversation.self, from: data)
        let current = RequestAccountOption(account: "B", label: "Account B", available: true, reason: nil)
        let spent = RequestAccountOption(account: "A", label: "Account A", available: false, reason: "pool_manual_quota_exhausted")
        XCTAssertEqual(thread.preferredAccount, "A")
        XCTAssertEqual(RequestAccountActionState.resolve(account: "B", conversation: thread, option: current, canAct: true), .inUse)
        XCTAssertEqual(RequestAccountActionState.resolve(account: "A", conversation: thread, option: spent, canAct: true), .unavailable(spent.statusText))
    }

    func testUnknownObservedAccountDoesNotBorrowSourceProfileAsSelection() {
        XCTAssertEqual(RequestAccountActionState.resolve(account: "A", conversation: conversation(current: nil), option: available, canAct: true), .change)
        XCTAssertEqual(RequestAccountActionState.resolve(account: "A", conversation: nil, option: available, canAct: true), .chooseConversation)
    }

    func testUnavailableAndDisconnectedAccountsShowReasonRatherThanDeadAction() {
        let blocked = RequestAccountOption(account: "B", label: "Account B", available: false, reason: "pool_manual_quota_exhausted")
        XCTAssertEqual(RequestAccountActionState.resolve(account: "B", conversation: conversation(), option: blocked, canAct: true), .unavailable(blocked.statusText))
        XCTAssertFalse(RequestAccountActionState.resolve(account: "B", conversation: conversation(), option: available, canAct: false).isActionable)
        XCTAssertFalse(RequestAccountActionState.resolve(account: "B", conversation: conversation(), option: nil, canAct: true).isActionable)
        let unknown = RequestAccountOption(account: "B", label: "Account B", available: false, reason: nil)
        XCTAssertEqual(RequestAccountActionState.resolve(account: "B", conversation: conversation(), option: unknown, canAct: true),
                       .unavailable(RequestAccountError.unavailableReason(nil)))
    }

    func testAllAccountActionsPauseWhileAssignmentIsInFlight() {
        XCTAssertEqual(RequestAccountActionState.resolve(account: "A", conversation: conversation(), option: available, canAct: true, applying: true), .applying)
        XCTAssertEqual(RequestAccountActionState.resolve(account: "B", conversation: conversation(), option: available, canAct: true, applying: true), .applying)
    }
}
