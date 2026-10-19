import Foundation
import XCTest
@testable import QuotaPie

final class AccountListPresentationTests: XCTestCase {
    func testGeneralFiveHourAndWeeklySelectionRemainsStableAcrossInputOrder() throws {
        let short = try window("codex:primary", seconds: 18_000, remaining: 73)
        let weekly = try window("codex:secondary", seconds: 604_800, remaining: 42)
        let model = try window("codex_bengalfox:primary", seconds: 18_000, remaining: 2)
        for windows in [[short, weekly, model], [model, weekly, short], [weekly, short, model]] {
            let presentation = AccountListPresentation(account: try account(windows: windows))
            XCTAssertEqual(presentation.fiveHour?.bucket, short.bucket)
            XCTAssertEqual(presentation.weekly?.bucket, weekly.bucket)
            XCTAssertEqual(presentation.additionalLimitCount, 1)
            XCTAssertEqual(presentation.visibleWindows.map(\.bucket), [short.bucket, weekly.bucket])
        }
    }

    func testMissingLimitNeverBorrowsAWindowFromAnotherDurationOrModel() throws {
        let weekly = try window("codex:secondary", seconds: 604_800, remaining: 42)
        let unknown = try window("codex:unknown", seconds: nil, remaining: 99)
        let model = try window("codex_bengalfox:primary", seconds: 18_000, remaining: 2)
        let presentation = AccountListPresentation(account: try account(windows: [weekly, unknown, model]))
        XCTAssertNil(presentation.fiveHour)
        XCTAssertEqual(presentation.weekly?.remainingPercent, 42)
        XCTAssertEqual(presentation.visibleWindows.map(\.bucket), [weekly.bucket])
        XCTAssertEqual(presentation.additionalLimitCount, 2)
        let modelOnly = AccountListPresentation(account: try account(windows: [model]))
        XCTAssertNil(modelOnly.fiveHour)
        XCTAssertNil(modelOnly.weekly)
        XCTAssertEqual(modelOnly.visibleWindows.map(\.bucket), [model.bucket])
        XCTAssertEqual(modelOnly.additionalLimitCount, 0)
    }

    func testClaudeModelWeeklyQuotaDoesNotReplaceItsGeneralWeeklyLimit() throws {
        let short = try window("five_hour", provider: "claude", seconds: 18_000, remaining: 53)
        let model = try window("seven_day_sonnet", provider: "claude", seconds: 604_800, remaining: 99)
        let presentation = AccountListPresentation(account: try account(provider: "claude", windows: [model, short]))
        XCTAssertEqual(presentation.fiveHour?.remainingPercent, 53)
        XCTAssertNil(presentation.weekly)
        XCTAssertEqual(presentation.additionalLimitCount, 1)
    }

    func testFreshObservationWinsOverNewerStaleValueAndNewestFreshWinsAfterward() throws {
        let fresh = try window("codex:primary", seconds: 18_000, remaining: 73, observed: 1000)
        let stale = try window("codex:old", seconds: 18_000, remaining: 9, freshness: "stale", observed: 3000)
        let newer = try window("codex:new", seconds: 18_000, remaining: 64, observed: 2000)
        XCTAssertEqual(AccountListPresentation(account: try account(windows: [stale, fresh])).fiveHour?.remainingPercent, 73)
        XCTAssertEqual(AccountListPresentation(account: try account(windows: [fresh, stale, newer])).fiveHour?.remainingPercent, 64)
    }

    func testMenuAuthenticationWarningKeepsCachedQuotaOutOfThePrimaryTitle() throws {
        let cached = try window("codex:primary", seconds: 18_000, remaining: 98, freshness: "stale")
        for (health, key) in [("auth-required", "menu.account.loginRequired"), ("auth-expired", "menu.account.loginExpired")] {
            let value = try account(health: health, windows: [cached])
            let title = try XCTUnwrap(MenuBarAccountStatus.title(for: value))
            XCTAssertEqual(title, "Codex · " + Strings.t(key))
            XCTAssertFalse(title.contains("98"))
            XCTAssertEqual(value.windows.first?.remainingPercent, 98, "Historical quota remains available in account details")
        }
    }

    func testUnavailableClaudeCodeAndDeniedQuotaAreNotPresentedAsAppLoginFailures() throws {
        for category in ["claude-code-unavailable", "access-denied"] {
            let value = try account(provider: "claude", health: category, windows: [])
            let title = try XCTUnwrap(MenuBarAccountStatus.title(for: value))
            XCTAssertTrue(title.contains(Strings.t("collection." + category)))
            XCTAssertFalse(title.contains(Strings.t("menu.account.loginRequired")))
            XCTAssertFalse(title.contains(Strings.t("menu.account.refreshNeeded")))
            XCTAssertNotNil(value.collection.accessExplanation)
            XCTAssertNil(value.collection.recoveryCommand, "Unavailable quota access is not an instruction to authenticate again")
            XCTAssertTrue(AccountListPresentation(account: value).visibleWindows.isEmpty)
            XCTAssertNil(value.overviewWindow)
        }
        let expired = try account(provider: "claude", health: "attempted-then-failed", windows: [])
        var collection = expired.collection
        collection.errorCategory = "auth-expired"
        XCTAssertEqual(collection.recoveryCommand, "claude auth login", "An explicitly expired Code connection retains its recovery command")
        collection.errorCategory = "claude-code-unavailable"
        XCTAssertNotNil(collection.accessExplanation, "Error category takes precedence over generic health")
        XCTAssertNil(collection.recoveryCommand)
    }

    func testUnavailableClaudeAccessDoesNotResurrectCachedAllowanceRows() throws {
        let previous = try window("five_hour", provider: "claude", seconds: 18_000, remaining: 98, freshness: "stale")
        for category in ["claude-code-unavailable", "access-denied"] {
            var value = try account(provider: "claude", health: "attempted-then-failed", windows: [previous])
            value.collection.errorCategory = category
            let presentation = AccountListPresentation(account: value)
            XCTAssertNil(presentation.fiveHour)
            XCTAssertNil(presentation.weekly)
            XCTAssertTrue(presentation.visibleWindows.isEmpty)
            XCTAssertEqual(presentation.additionalLimitCount, 0)
            XCTAssertEqual(value.windows.count, 1, "The display projection does not delete historical observations")
        }
    }

    func testMenuWarningDistinguishesHealthyFreshQuotaFromUnusableReadings() throws {
        let fresh = try window("codex:primary", seconds: 18_000, remaining: 82)
        XCTAssertNil(MenuBarAccountStatus.title(for: try account(windows: [fresh])))
        XCTAssertEqual(MenuBarAccountStatus.title(for: try account(health: "stale-success", windows: [fresh])), "Codex · " + Strings.t("menu.account.refreshNeeded"))
        let stale = try window("codex:secondary", seconds: 604_800, remaining: 92, freshness: "stale")
        XCTAssertEqual(MenuBarAccountStatus.title(for: try account(windows: [fresh, stale])), "Codex · " + Strings.t("menu.account.refreshNeeded"))
        let denied = try window("codex:primary", seconds: 18_000, remaining: 82, metadata: ["ordinaryUsageAllowed": false])
        XCTAssertEqual(MenuBarAccountStatus.title(for: try account(windows: [denied])), "Codex · " + Strings.t("accounts.list.limitBlocked"))
        let unknown = try window("codex:primary", seconds: 18_000, remaining: 82, metadata: ["ordinaryUsageAllowed": NSNull()])
        XCTAssertEqual(MenuBarAccountStatus.title(for: try account(windows: [unknown])), "Codex · " + Strings.t("accounts.list.permissionUnknown"))
    }

    func testResetTicketPendingDoesNotClaimRecoveryAndExpires() throws {
        let metadata: [String: Any] = ["ordinaryUsageAllowed": false, "resetTicketPending": true, "resetTicketObservedAtMs": 1000]
        let pending = try window("codex:primary:10080", seconds: 604800, remaining: 0, observed: 44000, metadata: metadata)
        XCTAssertTrue(pending.isUsageBlocked)
        XCTAssertTrue(pending.isResetTicketPending)
        XCTAssertEqual(MenuBarAccountStatus.title(for: try account(windows: [pending])), "Codex · " + Strings.t("accounts.list.resetTicketPending"))
        let expired = try window("codex:primary:10080", seconds: 604800, remaining: 0, observed: 602000, metadata: metadata)
        XCTAssertFalse(expired.isResetTicketPending)
        let recovered = try window("codex:primary:10080", seconds: 604800, remaining: 100, observed: 44000,
            metadata: ["ordinaryUsageAllowed": true, "resetTicketPending": false, "resetTicketObservedAtMs": 1000])
        XCTAssertNil(MenuBarAccountStatus.title(for: try account(windows: [recovered])))
        let payload = try JSONDecoder().decode(LocalizedMessagePayload.self, from: Data(#"{"key":"event.external_relief","params":{"label":"weekly","resetTicketRecovery":true}}"#.utf8))
        XCTAssertEqual(payload.rendered(fallback: "bad"), Strings.t("event.resetTicketRecovery", "weekly"))
    }

    private func window(_ bucket: String, provider: String = "codex", seconds: Double?, remaining: Double,
                        freshness: String = "fresh", observed: Double = 1000, metadata: [String: Any]? = nil) throws -> QuotaWindow {
        var value: [String: Any] = ["provider": provider, "account": "default", "bucket": bucket, "label": bucket,
                                  "freshness": freshness, "observedAtMs": observed, "remainingPercent": remaining]
        if let seconds { value["windowSeconds"] = seconds }
        if let metadata { value["metadata"] = metadata }
        return try JSONDecoder().decode(QuotaWindow.self, from: JSONSerialization.data(withJSONObject: value))
    }

    private func account(provider: String = "codex", health: String = "recent-success", windows: [QuotaWindow]) throws -> AccountState {
        let encoded = try JSONSerialization.jsonObject(with: JSONEncoder().encode(windows))
        let value: [String: Any] = ["provider": provider, "account": "default", "accountLabel": "Main", "enabled": true,
                                  "collection": ["health": health], "windows": encoded]
        return try JSONDecoder().decode(AccountState.self, from: JSONSerialization.data(withJSONObject: value))
    }
}
