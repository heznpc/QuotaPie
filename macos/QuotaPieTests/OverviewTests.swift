import Foundation
import XCTest
@testable import QuotaPie

final class OverviewTests: XCTestCase {
    func testInlineDetailNavigationPreservesAccountAndClearsTaskFocusOnReturn() {
        let model = PopoverModel()
        model.selectedAccountID = "codex/work"
        model.showDetails(.activity, taskID: "paused-task")
        XCTAssertEqual(model.detailSection, .work)
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

    func testAccountListIsTheLandingPageWithoutChangingTheMenuMeter() throws {
        let model = PopoverModel()
        let payload = try navigationPayload()
        model.applyStatus(payload, notificationRevision: 0)
        XCTAssertTrue(model.isShowingAccountList)
        XCTAssertEqual(model.enabledAccounts.map(\.id), ["codex/default", "codex/work", "claude/default"])
        XCTAssertEqual(model.selectedAccount?.id, "codex/default")
        model.selectAccount(payload.accounts[1])
        XCTAssertTrue(model.isShowingAccountList, "Menu-meter selection must not navigate the popup")
        XCTAssertEqual(model.selectedHeadline?.remainingPercent, 73)
    }

    func testInspectingAccountSurvivesFocusChangesAndDetailBackNavigation() throws {
        let model = PopoverModel()
        let payload = try navigationPayload()
        model.applyStatus(payload, notificationRevision: 0)
        model.showAccount(payload.accounts[1])
        XCTAssertFalse(model.isShowingAccountList)
        XCTAssertEqual(model.displayedAccount?.id, "codex/work")
        model.showDetails(.quota)
        model.showOverview()
        XCTAssertNil(model.detailSection)
        XCTAssertEqual(model.displayedAccount?.id, "codex/work")
        let profile = CodexDesktopProfile(id: "main", name: "Main", codexHome: "/tmp/navigation-home",
                                         appData: "/tmp/navigation-data", collectionAccount: "default")
        model.followCodexFocus(CodexProcessIdentity(codexHome: profile.codexHome, appData: profile.appData), profiles: [profile])
        XCTAssertEqual(model.selectedAccount?.id, "codex/default")
        XCTAssertEqual(model.displayedAccount?.id, "codex/work", "A background focus event must not replace the account being inspected")
        model.applyStatus(payload, notificationRevision: 0)
        XCTAssertEqual(model.displayedAccount?.id, "codex/work")
        model.showAccountList()
        XCTAssertTrue(model.isShowingAccountList)
        XCTAssertNil(model.inspectedAccountID)
        XCTAssertEqual(model.selectedAccount?.id, "codex/default")
    }

    func testReopeningAccountListClearsTaskFocusButExplicitTaskLinkStillOpensWork() throws {
        let model = PopoverModel()
        let payload = try navigationPayload()
        model.applyStatus(payload, notificationRevision: 0)
        model.showAccount(payload.accounts[1])
        model.showDetails(.activity, taskID: "paused-task")
        XCTAssertEqual(model.detailSection, .work)
        XCTAssertEqual(model.focusedResumeTaskID, "paused-task")
        XCTAssertEqual(model.inspectedAccountID, "codex/work", "Internal work navigation preserves its back destination")
        model.showAccountList()
        XCTAssertTrue(model.isShowingAccountList)
        XCTAssertNil(model.focusedResumeTaskID)
        XCTAssertEqual(model.selectedAccount?.id, "codex/work")
        model.showDetails(.activity, taskID: "paused-task")
        XCTAssertFalse(model.isShowingAccountList)
        XCTAssertEqual(model.detailSection, .work)
        XCTAssertEqual(model.focusedResumeTaskID, "paused-task")
        XCTAssertNil(model.inspectedAccountID, "The external route clears prior inspection before opening the task")
        model.showOverview()
        XCTAssertTrue(model.isShowingAccountList)
        XCTAssertNil(model.focusedResumeTaskID)
    }

    func testRemovedInspectedAccountNeverShowsAnotherAccountsQuota() throws {
        let model = PopoverModel()
        let payload = try navigationPayload()
        model.applyStatus(payload, notificationRevision: 0)
        model.showAccount(payload.accounts[1])
        model.applyStatus(try navigationPayload(includeWork: false), notificationRevision: 0)
        XCTAssertNil(model.displayedAccount, "A removed account must not silently display the default account as its own")
        model.showAccountList()
        XCTAssertTrue(model.isShowingAccountList)
        XCTAssertEqual(model.enabledAccounts.map(\.id), ["codex/default", "claude/default"])
    }

    func testPositiveQuotaCannotConcealExplicitUsageDenial() throws {
        for metadata in [#"{"ordinaryUsageAllowed":false}"#, #"{"spendControlReached":true}"#,
                         #"{"ordinaryUsageAllowed":false,"spendControlReached":false}"#] {
            let value = try JSONDecoder().decode(QuotaWindow.self, from: Data("""
            {"provider":"codex","account":"default","bucket":"codex:primary","label":"5h",
             "remainingPercent":82,"freshness":"fresh","observedAtMs":1000,"metadata":\(metadata)}
            """.utf8))
            XCTAssertEqual(value.remainingPercent, 82)
            XCTAssertTrue(value.isUsageBlocked)
        }
        let legacy = try window("codex:primary", seconds: 18000, remaining: 82)
        XCTAssertFalse(legacy.isUsageBlocked, "Missing permission metadata is not an explicit denial")
    }

    func testUnknownUsagePermissionSurvivesCachingWithoutChangingLegacyReadings() throws {
        let legacy = try window("codex:primary", seconds: 18000, remaining: 82)
        XCTAssertFalse(legacy.isUsagePermissionUnknown)
        for metadata in [#"{"ordinaryUsageAllowed":null}"#, #"{"spendControlReached":null}"#] {
            let value = try JSONDecoder().decode(QuotaWindow.self, from: Data("""
            {"provider":"codex","account":"default","bucket":"codex:primary","label":"5h",
             "remainingPercent":82,"freshness":"fresh","observedAtMs":1000,"metadata":\(metadata)}
            """.utf8))
            XCTAssertTrue(value.isUsagePermissionUnknown)
            XCTAssertFalse(value.isUsageBlocked)
            let cached = try JSONDecoder().decode(QuotaWindow.self, from: JSONEncoder().encode(value))
            XCTAssertTrue(cached.isUsagePermissionUnknown)
            XCTAssertEqual(cached.remainingPercent, 82)
        }
    }

    private func navigationPayload(includeWork: Bool = true) throws -> StatusPayload {
        let work = includeWork ? #"""
          {"provider":"codex","account":"work","accountLabel":"Work","enabled":true,
           "collection":{"health":"recent-success"},"windows":[
           {"provider":"codex","account":"work","bucket":"codex:primary","label":"5h","windowSeconds":18000,
            "freshness":"fresh","observedAtMs":1000,"remainingPercent":73}]},
        """# : ""
        return try JSONDecoder().decode(StatusPayload.self, from: Data("""
        {"accounts":[
          {"provider":"codex","account":"default","accountLabel":"Main","enabled":true,
           "collection":{"health":"recent-success"},"windows":[]},
          \(work)
          {"provider":"claude","account":"default","accountLabel":"Claude Main","enabled":true,
           "collection":{"health":"auth-required"},"windows":[]},
          {"provider":"codex","account":"disabled","accountLabel":"Disabled","enabled":false,
           "collection":{"health":"recent-success"},"windows":[]}]}
        """.utf8))
    }

    func testInterruptedLaunchIsNotCountedAsWaitingForQuota() throws {
        let model = PopoverModel()
        model.payload = try JSONDecoder().decode(StatusPayload.self, from: Data(#"""
        {"resumeTasks":[
          {"id":"ready","provider":"codex","account":"default","accountLabel":"Main",
           "projectLabel":"Ready task","state":"ready","registeredAtMs":1000},
          {"id":"approved","provider":"codex","account":"default","accountLabel":"Main",
           "projectLabel":"Interrupted launch","state":"approved","registeredAtMs":2000},
          {"id":"waiting","provider":"codex","account":"default","accountLabel":"Main",
           "projectLabel":"Blocked task","state":"waiting","registeredAtMs":3000},
          {"id":"dismissed","provider":"codex","account":"default","accountLabel":"Main",
           "projectLabel":"Dismissed task","state":"dismissed","registeredAtMs":4000}]}
        """#.utf8))
        XCTAssertEqual(model.activeTasks.map(\.id), ["ready", "approved", "waiting"])
        XCTAssertEqual(model.taskOverviewSummary, Strings.t("overview.taskCounts", "1", "1", "1"))
        XCTAssertNotEqual(model.taskOverviewSummary, Strings.t("overview.taskCounts", "1", "0", "2"))
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
        XCTAssertEqual(model.selectedHeadline?.remainingPercent, 18)
        model.accountOpenError = "Previous launch failed"
        model.selectAccount(payload.accounts[0])
        XCTAssertFalse(model.openingAccount)
        XCTAssertNil(model.accountOpenError)
        XCTAssertEqual(model.selectedHeadline?.remainingPercent, 18)
        XCTAssertEqual(model.selectedHeadline?.windowLabel, model.selectedAccount?.overviewWindow?.shortLabel)
        model.applyStatus(payload, notificationRevision: 0)
        XCTAssertEqual(model.selectedHeadline?.account, "default")
        let profile = CodexDesktopProfile(id: "work", name: "Work", codexHome: "/tmp/focus-home",
                                         appData: "/tmp/focus-data", collectionAccount: "work")
        let identity = CodexProcessIdentity(codexHome: CodexDesktopProfile.canonical(profile.codexHome),
                                            appData: CodexDesktopProfile.canonical(profile.appData))
        var primary = CodexDesktopProfile.primary
        primary.collectionAccount = "default"
        let mainIdentity = CodexProcessIdentity(codexHome: CodexDesktopProfile.canonical(primary.codexHome),
                                              appData: CodexDesktopProfile.canonical(primary.appData))
        model.selectInitialCodexAccount(frontmost: nil, running: [mainIdentity], profiles: [primary, profile])
        XCTAssertEqual(model.selectedAccount?.id, "codex/default")
        model.selectInitialCodexAccount(frontmost: nil, running: [identity], profiles: [primary, profile])
        XCTAssertEqual(model.selectedAccount?.id, "codex/work")
        model.selectInitialCodexAccount(frontmost: mainIdentity, running: [identity, mainIdentity], profiles: [primary, profile])
        XCTAssertEqual(model.selectedAccount?.id, "codex/default")
        model.selectInitialCodexAccount(frontmost: nil, running: [identity, mainIdentity], profiles: [primary, profile])
        XCTAssertEqual(model.selectedAccount?.id, "codex/default")
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

    func testRemovedAccountSelectionFallsBackToPrimaryInsteadOfAnotherAccountsHeadline() throws {
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
        XCTAssertEqual(model.selectedAccount?.id, "codex/default")
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
        XCTAssertEqual(feed.latestSignal?.sourceStatusKey, "signal.via.public-feed")
    }

    func testOriginalTimeWordingDoesNotTurnPossibilityIntoAnAnnouncement() {
        let possible = signal("possible", target: nil, hint: "Maybe tomorrow")
        let announced = signal("announced", target: nil, hint: "Codex resets tomorrow")
        XCTAssertEqual(possible.summaryKey(nowMs: 2000), "signal.summary.possible")
        XCTAssertEqual(announced.summaryKey(nowMs: 2000), "signal.summary.announced")
        XCTAssertEqual(possible.summaryTimeHint, "Maybe tomorrow")
        XCTAssertEqual(announced.summaryTimeHint, "Codex resets tomorrow")
        XCTAssertEqual(signal("possible", target: 3000, hint: "Maybe tomorrow").summaryKey(nowMs: 2000),
                       "signal.summary.possible")
    }

    func testPublishedDateAndCollectionDateRemainSeparateAndLegacyPayloadsDecode() throws {
        let published: Double = 1_800_000_000_000
        let detected = published + 86_400_000
        let payload = """
        {"id":"1","fingerprint":"post","author":"openai","sourceUrl":"https://x.com/openai/status/1",
         "text":"Maybe tomorrow","publishedAtMs":\(published),"state":"possible","resetKind":"unknown",
         "timeHint":"tomorrow","observedVia":"codexreset","detectedAtMs":\(detected),"contextText":"you owe us a banked reset"}
        """
        let decoder = JSONDecoder()
        let post = try decoder.decode(ResetSignal.self, from: Data(payload.utf8))
        XCTAssertEqual(post.detectedAtMs, detected)
        XCTAssertEqual(post.contextText, "you owe us a banked reset")
        XCTAssertEqual(post.publishedAtMs, published)
        XCTAssertEqual(post.publicationText, "Codex · @openai · " + Strings.t("signal.published", ResetSignal.stamp(published)))
        XCTAssertFalse(post.publicationText.contains(ResetSignal.stamp(detected)))
        let legacy = payload.replacingOccurrences(of: ",\"detectedAtMs\":\(detected),\"contextText\":\"you owe us a banked reset\"", with: "")
        let oldPost = try decoder.decode(ResetSignal.self, from: Data(legacy.utf8))
        XCTAssertNil(oldPost.detectedAtMs)
        XCTAssertNil(oldPost.contextText)
    }

    func testSummaryNamesTheActualRetrievalPath() {
        XCTAssertEqual(signal("possible", target: nil, via: "codexreset").sourceStatusKey, "signal.via.codexreset")
        XCTAssertEqual(signal("possible", target: nil, via: "public-feed").sourceStatusKey, "signal.via.public-feed")
        XCTAssertEqual(signal("possible", target: nil, via: "reset-beacon").sourceStatusKey, "signal.via.public-feed")
        XCTAssertEqual(signal("possible", target: nil, via: "x-api").sourceStatusKey, "signal.via.x-api")
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

    private func signal(_ state: String, target: Double?, published: Double = 1000,
                        hint: String? = nil, via: String = "public-feed") -> ResetSignal {
        ResetSignal(id: "1", fingerprint: "\(published)", author: "openai", sourceUrl: "https://x.com/openai/status/1",
                    text: "Synthetic post", publishedAtMs: published, state: state, resetKind: "unknown",
                    timeHint: hint, scopeHint: nil, observedVia: via, targetAtMs: target)
    }
}

extension OverviewTests {
    func testClosedAutomaticAccountFollowsRemainingAppButManualInspectionSurvives() throws {
        let model = PopoverModel()
        let payload = try JSONDecoder().decode(StatusPayload.self, from: Data("""
        {"events":[],"accounts":[
          {"provider":"codex","account":"default","accountLabel":"Main","enabled":true,"windows":[],"collection":{"health":"never-attempted","sources":[]}},
          {"provider":"codex","account":"second","accountLabel":"Second","enabled":true,"windows":[],"collection":{"health":"never-attempted","sources":[]}}
        ]}
        """.utf8))
        model.applyStatus(payload, notificationRevision: 0)
        let profiles = ["default", "second"].map {
            CodexDesktopProfile(id: $0, name: $0, codexHome: "/tmp/\($0)-home", appData: "/tmp/\($0)-data", collectionAccount: $0)
        }
        let main = CodexProcessIdentity(codexHome: profiles[0].codexHome, appData: profiles[0].appData)
        let second = CodexProcessIdentity(codexHome: profiles[1].codexHome, appData: profiles[1].appData)
        model.selectInitialCodexAccount(frontmost: second, running: [main, second], profiles: profiles)
        XCTAssertEqual(model.selectedAccount?.id, "codex/second")
        model.reconcileRunningCodexAccounts(frontmost: nil, running: [main], profiles: profiles)
        XCTAssertEqual(model.selectedAccount?.id, "codex/default")
        model.selectAccount(payload.accounts[1])
        model.reconcileRunningCodexAccounts(frontmost: nil, running: [main], profiles: profiles)
        model.applyStatus(payload, notificationRevision: 0)
        XCTAssertEqual(model.selectedAccount?.id, "codex/second")
        model.followCodexFocus(main, profiles: profiles)
        XCTAssertEqual(model.selectedAccount?.id, "codex/default")
        model.followCodexFocus(second, profiles: profiles)
        model.reconcileRunningCodexAccounts(frontmost: nil, running: [], profiles: profiles)
        XCTAssertEqual(model.selectedAccount?.id, "codex/default")
    }
    func testClaudeCreditNewsKeepsProviderTypeAndPrimaryLink() throws {
        let raw = """
        {"id":"125","fingerprint":"credit","author":"ClaudeDevs","sourceUrl":"https://x.com/ClaudeDevs/status/125",
         "text":"One-time cloud-session credit","publishedAtMs":1000,"state":"reported","resetKind":"unknown",
         "observedVia":"resetradar","provider":"claude","benefitKind":"credits"}
        """
        let signal = try JSONDecoder().decode(ResetSignal.self, from: Data(raw.utf8))
        XCTAssertNotNil(signal.safeSourceURL)
        XCTAssertEqual(signal.summaryKey(nowMs: 2000), "signal.summary.credits")
        XCTAssertEqual(signal.classificationKey, "signal.summary.credits")
        XCTAssertTrue(signal.publicationText.hasPrefix("Claude · @ClaudeDevs"))
        XCTAssertEqual(signal.sourceStatusKey, "signal.via.resetradar")
    }

    func testSplitBenefitKeepsOriginalLinkAndAnnouncedQuantity() throws {
        let raw = """
        {"id":"125:limits","sourcePostId":"125","fingerprint":"limit","author":"ClaudeDevs",
         "sourceUrl":"https://x.com/ClaudeDevs/status/125","text":"Everyone gets 50% more usage.",
         "publishedAtMs":1000,"state":"reported","resetKind":"unknown","observedVia":"resetradar",
         "provider":"claude","benefitKind":"limits","change":{"percent":50},"benefitText":"SERVER_LANGUAGE_FALLBACK"}
        """
        let signal = try JSONDecoder().decode(ResetSignal.self, from: Data(raw.utf8))
        XCTAssertNotNil(signal.safeSourceURL)
        XCTAssertEqual(signal.summaryKey(nowMs: 2000), "signal.summary.limits")
        XCTAssertEqual(signal.renderedBenefitText, Strings.t("signal.change.prefix") + Strings.t("signal.change.percent", "+50", "1.5"))
        XCTAssertFalse(signal.renderedBenefitText!.contains("SERVER_LANGUAGE_FALLBACK"))
        var forged = signal
        forged.sourcePostId = "999"
        XCTAssertNil(forged.safeSourceURL)
    }

    func testLegacyBankedResetIsShownAsTicketGrant() throws {
        let raw = """
        {"id":"126","fingerprint":"ticket","author":"openai","sourceUrl":"https://x.com/openai/status/126",
         "text":"A banked reset","publishedAtMs":1000,"state":"reported","resetKind":"banked","observedVia":"public-feed"}
        """
        let signal = try JSONDecoder().decode(ResetSignal.self, from: Data(raw.utf8))
        XCTAssertEqual(signal.summaryKey(nowMs: 2000), "signal.summary.resetCredits")
    }

}
