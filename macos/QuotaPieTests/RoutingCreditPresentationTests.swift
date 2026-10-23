import Foundation
import XCTest
@testable import QuotaPie

final class RoutingCreditPresentationTests: XCTestCase {
    private var now: Double = 0

    override func setUp() {
        super.setUp()
        // XCTest creates every case before slow profile integration tests run.
        // Measure freshness at execution time, not at suite construction.
        now = Date().timeIntervalSince1970 * 1000
    }

    func testCreditsUseAbsoluteDecreaseAndNeverInventAStartingBalance() throws {
        let credits = try credit()
        XCTAssertEqual(credits.menuTitle(at: Date(timeIntervalSince1970: now / 1000)),
                       Strings.t("credits.menu.decrease", CreditUsage.number(12.5)))
        XCTAssertFalse(try credit(coverage: "partial").menuTitle()!.contains("*"))
        XCTAssertFalse(credits.decreaseText.contains("%"))
        XCTAssertTrue(try credit(coverage: "partial").decreaseText.hasSuffix("*"))
        XCTAssertEqual(try credit(decrease: nil, coverage: "unknown").decreaseText, "—")
        XCTAssertNil(try credit(freshness: "stale").menuTitle())
        XCTAssertNil(try credit(at: now - 601_000).menuTitle())
        XCTAssertNil(try credit(exhausted: false).menuTitle())
    }

    func testSpendControlAndAuthenticationFailureCannotBeHiddenByCredits() throws {
        var account = try account("A")
        account.credits = try credit()
        XCTAssertNotNil(account.creditMenuTitle)
        account.collection = CollectionState(health: "attempted-then-failed", activeSource: nil, lastSuccessAtMs: now,
                                             errorCategory: "auth-required", errorDetail: nil)
        XCTAssertNil(account.creditMenuTitle)
        account = try self.account("A", spendingBlocked: true)
        account.credits = try credit()
        XCTAssertNil(account.creditMenuTitle)
        XCTAssertEqual(account.usageRestrictionText, Strings.t("credits.spendControl"))
    }

    func testMenuUsesObservedTargetRatherThanInspectedOrHostAccount() throws {
        let model = PopoverModel()
        model.applyQuota(try payload(accounts: [account("A"), account("B")], routes: [route("B")]))
        model.selectAccount(try account("A"))
        XCTAssertEqual(model.selectedAccount?.account, "A")
        XCTAssertEqual(model.menuAccount?.account, "B")
    }

    func testManualSelectionChangesIdleMeterButPreservesActiveRouteAndInspection() throws {
        let model = PopoverModel()
        let first = try account("A"), second = try account("B")
        model.applyQuota(try payload(accounts: [first, second], routes: [route("A")]))
        model.showAccount(first)
        model.followRequestAccountSelection("B")
        XCTAssertEqual(model.selectedAccount?.account, "B")
        XCTAssertEqual(model.displayedAccount?.account, "A")
        XCTAssertEqual(model.menuAccount?.account, "A")
        var idle = try payload(accounts: [first, second], routes: [])
        idle.nowMs = now + 1
        model.applyQuota(idle)
        XCTAssertEqual(model.menuAccount?.account, "B")
        XCTAssertEqual(model.displayedAccount?.account, "A")
    }

    func testMissingOrDisabledRoutedAccountNeverBecomesOneActiveAccount() throws {
        for accounts in [[try account("A")], [try account("A"), try account("B", enabled: false)]] {
            let model = PopoverModel()
            model.applyQuota(try payload(accounts: accounts, routes: [route("A"), route("B")]))
            XCTAssertNil(model.menuAccount)
            XCTAssertEqual(model.concurrentRoutingTitle, Strings.t("routing.menu.unknown"))
        }
        let model = PopoverModel()
        model.applyQuota(try payload(accounts: [account("A"), account("B")], routes: [route("A"), route("B")]))
        XCTAssertNil(model.menuAccount)
        XCTAssertEqual(model.concurrentRoutingTitle, Strings.t("routing.menu.focusNeeded"))
    }

    func testSelectedTargetWithoutAnUpstreamResponseCannotClaimProcessingAccount() throws {
        let model = PopoverModel()
        var pending = route("B")
        pending.upstreamResponseObserved = false
        model.applyQuota(try payload(accounts: [account("A"), account("B")], routes: [pending]))
        XCTAssertNil(model.menuAccount)
        XCTAssertEqual(model.concurrentRoutingTitle, Strings.t("routing.menu.unknown"))
        XCTAssertTrue(pending.detailText.contains(Strings.t("routing.awaitingResponse")))
    }

    func testLostObserverCannotTurnTwoActiveAccountsIntoOneClaimedAccount() throws {
        let model = PopoverModel()
        var partial = try payload(accounts: [account("A"), account("B")], routes: [route("A")])
        partial.routing?.activityUncertain = true
        model.applyQuota(partial)
        XCTAssertNil(model.menuAccount)
        XCTAssertEqual(model.concurrentRoutingTitle, Strings.t("routing.menu.unknown"))
        let unconfirmed = try JSONDecoder().decode(RequestRoute.self, from: Data("""
        {"requestId":"lost","kind":"response","phase":"unverified","status":200,
        "observedAtMs":1,"account":"A","attribution":"relay-source","active":false,"upstreamResponseObserved":true}
        """.utf8))
        XCTAssertEqual(unconfirmed.detailText, Strings.t("routing.activityUnconfirmed"))
    }

    func testStaleOrUnknownTelemetryCannotClaimLiveAccountAndLateDetailCannotUndoRoute() throws {
        let model = PopoverModel()
        var old = try payload(accounts: [account("A"), account("B")], routes: [route("A")])
        model.applyQuota(old)
        let revision = model.quotaRevision
        var newer = try payload(accounts: [account("A"), account("B")], routes: [route("B")])
        newer.nowMs = now + 1
        model.applyQuota(newer)
        old.nowMs = now + 2
        model.applyStatus(old, notificationRevision: 0, quotaRevision: revision)
        XCTAssertEqual(model.menuAccount?.account, "B")
        var stale = newer
        stale.nowMs = now + 3
        stale.routing = RoutingActivity(checkedAtMs: now - 31_000, freshness: "fresh", active: [route("B")], recent: [])
        model.applyQuota(stale)
        XCTAssertTrue(model.currentRoutes.isEmpty)
        var unknown = newer
        unknown.nowMs = now + 4
        unknown.routing = RoutingActivity(checkedAtMs: now, freshness: "fresh", active: [route(nil)], recent: [])
        model.applyQuota(unknown)
        XCTAssertNil(model.menuAccount)
    }

    func testFocusedConversationMeterIgnoresBackgroundRoutesAndInspection() throws {
        let model = PopoverModel()
        model.applyQuota(try payload(accounts: [account("A", remaining: 17), account("B", remaining: 73)],
                                     routes: [route("A"), route("B")]))
        model.requestAccountCatalog = .init(conversations: [
            .init(threadId: "first", title: "Same title", sourceAccount: "A", currentAccount: "A", targetAccount: "B", active: true),
            .init(threadId: "second", title: "Same title", sourceAccount: "A", currentAccount: "B", targetAccount: nil, active: true)
        ], accounts: [])
        model.focusedConversationID = "second"
        model.inspectedConversationID = "first"
        XCTAssertEqual(model.displayedConversation?.threadId, "first")
        XCTAssertEqual(model.menuAccount?.account, "B")
        XCTAssertEqual(model.menuAccount.map(Headline.init(account:))?.remainingPercent, 73)
        XCTAssertNil(model.concurrentRoutingTitle)
        model.focusedConversationID = "first"
        XCTAssertEqual(model.menuAccount?.account, "A")
        XCTAssertEqual(model.menuAccount.map(Headline.init(account:))?.remainingPercent, 17)
        model.focusedConversationID = "not-in-catalog"
        XCTAssertNil(model.menuAccount)
        XCTAssertEqual(model.concurrentRoutingTitle, Strings.t("sessionAccount.unverified"))
    }

    private func route(_ account: String?) -> RequestRoute {
        RequestRoute(requestId: account ?? "unknown", threadId: "thread", turnId: "turn", kind: "response", model: "gpt-6.1-sol",
                     phase: "response_headers", status: 200, startedAtMs: now - 1000, observedAtMs: now, finishedAtMs: nil,
                     sourceAccount: "A", account: account, attribution: account == nil ? "unknown" : "pool-selection",
                     reason: "new", switched: account.map { $0 != "A" }, active: true, upstreamResponseObserved: true)
    }

    private func payload(accounts: [AccountState], routes: [RequestRoute]) throws -> StatusPayload {
        var value = try JSONDecoder().decode(StatusPayload.self, from: Data("{}".utf8))
        value.nowMs = now
        value.accounts = accounts
        value.routing = RoutingActivity(checkedAtMs: now, freshness: "fresh", active: routes, recent: [])
        return value
    }

    private func account(_ id: String, enabled: Bool = true, spendingBlocked: Bool = false, remaining: Double = 0) throws -> AccountState {
        let data: [String: Any] = ["provider":"codex", "account":id, "accountLabel":id, "enabled":enabled,
            "collection":["health":"recent-success"],
            "windows":[["provider":"codex", "account":id, "bucket":"codex:primary:10080", "label":"Weekly",
                "windowSeconds":604800, "freshness":"fresh", "observedAtMs":now, "usedPercent":100 - remaining, "remainingPercent":remaining,
                "metadata":["ordinaryUsageAllowed":remaining > 0, "spendControlReached":spendingBlocked]]]]
        return try JSONDecoder().decode(AccountState.self, from: JSONSerialization.data(withJSONObject: data))
    }

    private func credit(decrease: Double? = 12.5, coverage: String = "complete", freshness: String = "fresh",
                        exhausted: Bool = true, at: Double? = nil) throws -> CreditUsage {
        CreditUsage(unit: "credits", balance: 500, observedAtMs: at ?? now, freshness: freshness,
                    subscriptionExhausted: exhausted, spendingObserved: true,
                    lastHour: .init(fromMs: now - 3_600_000, toMs: now, observedDecrease: decrease,
                                    observedIncrease: 0, coveredMs: 3_600_000, sampleCount: 60, gapCount: 0,
                                    identityBreakCount: 0, coverage: coverage),
                    attribution: "account-balance-only", billingVerified: false)
    }
}
