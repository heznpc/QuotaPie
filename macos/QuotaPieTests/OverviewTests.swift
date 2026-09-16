import Foundation
import XCTest
@testable import QuotaPie

final class OverviewTests: XCTestCase {
    func testInlineDetailNavigationPreservesAccountAndClearsTaskFocusOnReturn() {
        let model = PopoverModel()
        model.selectedAccountID = "codex/work"
        model.showDetails(.activity, taskID: "paused-task")
        XCTAssertEqual(model.detailSection, .activity)
        XCTAssertEqual(model.focusedResumeTaskID, "paused-task")
        model.showOverview()
        XCTAssertNil(model.detailSection)
        XCTAssertNil(model.focusedResumeTaskID)
        XCTAssertEqual(model.selectedAccountID, "codex/work")
        for section in DetailSection.allCases {
            model.showDetails(section)
            XCTAssertEqual(model.detailSection, section)
            XCTAssertNil(model.focusedResumeTaskID)
        }
    }

    func testMenuBarFollowsManualSelectionAcrossRefreshAndCodexFocusChanges() throws {
        let model = PopoverModel()
        let payload = try JSONDecoder().decode(StatusPayload.self, from: Data(#"""
        {"headline":{"kind":"normal","provider":"codex","account":"work","remainingPercent":100},
         "accounts":[
          {"provider":"codex","account":"default","accountLabel":"Main","enabled":true,
           "collection":{"health":"recent-success"},"windows":[
           {"provider":"codex","account":"default","bucket":"codex:weekly","label":"Weekly","windowSeconds":604800,
            "freshness":"fresh","observedAtMs":1000,"remainingPercent":18}]},
          {"provider":"codex","account":"work","accountLabel":"Work","enabled":true,
           "collection":{"health":"recent-success"},"windows":[
           {"provider":"codex","account":"work","bucket":"codex:primary","label":"5h","windowSeconds":18000,
            "freshness":"fresh","observedAtMs":1000,"remainingPercent":100}]}]}
        """#.utf8))
        model.payload = payload
        XCTAssertEqual(model.selectedHeadline?.remainingPercent, 100)
        model.selectedAccountID = "codex/default"
        XCTAssertEqual(model.selectedHeadline?.remainingPercent, 18)
        XCTAssertEqual(model.selectedHeadline?.windowLabel, model.selectedAccount?.overviewWindow?.shortLabel)
        model.applyStatus(payload, notificationRevision: 0)
        XCTAssertEqual(model.selectedHeadline?.account, "default")
        let profile = CodexDesktopProfile(id: "work", name: "Work", codexHome: "/tmp/focus-home",
                                         appData: "/tmp/focus-data", collectionAccount: "work")
        let identity = CodexProcessIdentity(codexHome: CodexDesktopProfile.canonical(profile.codexHome),
                                            appData: CodexDesktopProfile.canonical(profile.appData))
        model.followCodexFocus(identity, profiles: [profile])
        XCTAssertEqual(model.selectedHeadline?.remainingPercent, 100)
        model.selectedAccountID = "codex/default"
        model.applyStatus(payload, notificationRevision: 0)
        XCTAssertEqual(model.selectedHeadline?.remainingPercent, 18)
        model.followCodexFocus(identity, profiles: [])
        XCTAssertEqual(model.selectedAccountID, "codex/default")
        model.followCodexFocus(identity, profiles: [profile, profile])
        XCTAssertEqual(model.selectedAccountID, "codex/default")
    }

    func testSelectedAccountWithStaleOrMissingQuotaNeverBorrowsAnotherReading() throws {
        let stale = Headline(account: account([try window("codex:primary", seconds: 18000, remaining: 0, freshness: "stale")]))
        XCTAssertEqual(stale.kind, "degraded")
        XCTAssertEqual(stale.remainingPercent, 0)
        let missing = Headline(account: account([]))
        XCTAssertNil(missing.remainingPercent)
        XCTAssertEqual(missing.kind, "degraded")
    }

    func testOverviewUsesShortestGeneralWindowAndDoesNotPromoteSpark() throws {
        let weekly = try window("codex:secondary", seconds: 604800, remaining: 14)
        let short = try window("codex:primary", seconds: 18000, remaining: 70)
        let spark = try window("codex_bengalfox:primary", seconds: 60, remaining: 2)
        XCTAssertEqual(account([weekly, spark, short]).overviewWindow?.bucket, short.bucket)
        XCTAssertEqual(account([weekly, spark]).overviewWindow?.bucket, weekly.bucket)
        XCTAssertNil(account([spark]).overviewWindow)
    }

    func testFreshReadingLeadsAndUnknownDurationDoesNotOutrankKnownWindow() throws {
        let stale = try window("codex:old", seconds: 60, remaining: 1, freshness: "stale")
        let unknown = try window("codex:unknown", seconds: nil, remaining: 2)
        let weekly = try window("codex:weekly", seconds: 604800, remaining: 14)
        XCTAssertEqual(account([stale, unknown, weekly]).overviewWindow?.bucket, weekly.bucket)
    }

    func testRemovedAccountSelectionFallsBackToTheCurrentHeadline() throws {
        let model = PopoverModel()
        model.selectedAccountID = "codex/removed"
        model.payload = try JSONDecoder().decode(StatusPayload.self, from: Data(#"""
        {"headline":{"kind":"normal","provider":"claude","account":"work"},
         "accounts":[
          {"provider":"codex","account":"default","accountLabel":"Main","enabled":true,
           "collection":{"health":"recent-success"},"windows":[]},
          {"provider":"claude","account":"work","accountLabel":"Work","enabled":true,
           "collection":{"health":"recent-success"},"windows":[]}]}
        """#.utf8))
        XCTAssertEqual(model.selectedAccount?.id, "claude/work")
        model.selectedAccountID = "codex/default"
        XCTAssertEqual(model.selectedAccount?.id, "codex/default")
    }

    func testPassedAnnouncementDoesNotBecomeAppliedAndWithdrawalTakesPrecedence() {
        XCTAssertEqual(signal("announced", target: 1000).summaryKey(nowMs: 2000), "signal.summary.elapsed")
        XCTAssertEqual(signal("announced", target: 3000).summaryKey(nowMs: 2000), "signal.summary.scheduled")
        XCTAssertEqual(signal("withdrawn", target: 3000).summaryKey(nowMs: 2000), "signal.summary.withdrawn")
        XCTAssertEqual(signal("reported", target: 1000).summaryKey(nowMs: 2000), "signal.summary.reported")
        XCTAssertEqual(signal("possible", target: nil).summaryKey(nowMs: 2000), "signal.summary.possible")
    }

    func testSummarySelectsTheLatestPostWithoutDiscardingHistoryOrClaimingVerification() {
        let older = signal("announced", target: 3000, published: 1000)
        let correction = signal("withdrawn", target: nil, published: 2000)
        let feed = ResetSignalPayload(enabled: true, source: "reset-beacon", state: "ready",
                                      lastSuccessMs: 3000, error: nil, signals: [correction, older])
        XCTAssertEqual(feed.latestSignal?.state, "withdrawn")
        XCTAssertEqual(feed.signals.count, 2)
        XCTAssertEqual(feed.latestSignal?.sourceStatusKey, "signal.summary.unverified")
    }

    func testMultipleSourcesPreserveCoverageAndSeparateRecentPostsFromResetEvidence() throws {
        let feed = try JSONDecoder().decode(ResetSignalPayload.self, from: Data(#"""
        {"enabled":true,"source":"multiple","state":"ready","coverage":"direct-and-relays","signals":[],
         "sources":[{"id":"codexreset","state":"ready","coverage":"codexreset-monitored-posts",
         "lastAttemptMs":5000,"lastSuccessMs":5000,"latestPublishedAtMs":1000,
         "lastEvidenceMs":2000,"newEvidenceCount":0,"examinedPosts":404,"latestPostAtMs":4000}]}
        """#.utf8))
        XCTAssertEqual(feed.coverageKey, "signal.coverage.direct")
        XCTAssertEqual(feed.sources?.first?.latestPublishedAtMs, 1000)
        XCTAssertEqual(feed.sources?.first?.latestPostAtMs, 4000)
        XCTAssertEqual(feed.sources?.first?.examinedPosts, 404)
        XCTAssertEqual(feed.sources?.first?.newEvidenceCount, 0)
        XCTAssertNil(feed.latestSignal)
    }

    func testDegradedHeadlineKeepsZeroSeparateFromUnknownAndTransportFailure() throws {
        for remaining in [0, 43] {
            let data = Data("{\"kind\":\"degraded\",\"provider\":\"codex\",\"windowKind\":\"five-hour\",\"remainingPercent\":\(remaining)}".utf8)
            let headline = try JSONDecoder().decode(Headline.self, from: data)
            XCTAssertTrue(headline.localizedTitle.contains("\(remaining)%"))
            XCTAssertEqual(headline.localizedTitle, headline.cachedTitle)
            XCTAssertFalse(headline.localizedDetail?.contains(Strings.t("collection.never-attempted")) ?? true)
        }
        let unknown = try JSONDecoder().decode(Headline.self, from: Data("{\"kind\":\"degraded\"}".utf8))
        XCTAssertFalse(unknown.localizedTitle.contains("0%"))
        let fresh = try JSONDecoder().decode(Headline.self, from: Data("{\"kind\":\"normal\",\"provider\":\"codex\",\"remainingPercent\":0}".utf8))
        XCTAssertTrue(fresh.cachedTitle.contains("0%"))
        XCTAssertNotEqual(fresh.localizedTitle, fresh.cachedTitle)
    }

    private func window(_ bucket: String, seconds: Double?, remaining: Double, freshness: String = "fresh") throws -> QuotaWindow {
        var value: [String: Any] = ["provider": "codex", "account": "default", "bucket": bucket,
                                    "label": bucket, "freshness": freshness, "observedAtMs": 1000,
                                    "remainingPercent": remaining]
        if let seconds { value["windowSeconds"] = seconds }
        return try JSONDecoder().decode(QuotaWindow.self, from: JSONSerialization.data(withJSONObject: value))
    }

    private func account(_ windows: [QuotaWindow]) -> AccountState {
        AccountState(provider: "codex", account: "default", accountLabel: "Main", enabled: true,
                     collection: CollectionState(health: "recent-success", activeSource: nil, lastSuccessAtMs: nil,
                                                 errorCategory: nil, errorDetail: nil),
                     windows: windows, bottleneckBucket: nil, updatedAtMs: nil)
    }

    private func signal(_ state: String, target: Double?, published: Double = 1000) -> ResetSignal {
        ResetSignal(id: "1", fingerprint: "\(published)", author: "openai", sourceUrl: "https://x.com/openai/status/1",
                    text: "Synthetic post", publishedAtMs: published, state: state, resetKind: "unknown",
                    timeHint: nil, scopeHint: nil, observedVia: "reset-beacon", targetAtMs: target)
    }
}
