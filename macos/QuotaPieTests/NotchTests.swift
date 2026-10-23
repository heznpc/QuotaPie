import XCTest
@testable import QuotaPie

final class NotchTests: XCTestCase {
    func testPlacementUsesActualNotchAndGlobalScreenCoordinates() {
        let screen = CGRect(x: -1470, y: 100, width: 1470, height: 956)
        let layout = NotchPlacement.layout(screen: screen, safeTop: 32,
            left: CGRect(x: -1470, y: 1024, width: 645.5, height: 32),
            right: CGRect(x: -645.5, y: 1024, width: 645.5, height: 32))
        XCTAssertEqual(layout?.frame, CGRect(x: -924.5, y: 1024, width: 379, height: 32))
        XCTAssertEqual(layout?.notchWidth, 179)
        XCTAssertEqual(layout?.frame.maxY, screen.maxY)
        XCTAssertNil(NotchPlacement.layout(screen: screen, safeTop: 0, left: nil, right: nil))
        XCTAssertNil(NotchPlacement.layout(screen: screen, safeTop: 32, left: .zero, right: .zero))
    }

    func testNotchNeverExtendsIntoContentOrInventsRoomOnNarrowDisplays() throws {
        let layout = try XCTUnwrap(placement())
        XCTAssertGreaterThanOrEqual(layout.frame.minY, screen.maxY - 32)
        XCTAssertEqual(layout.frame.minX + layout.wingWidth, 645.5)
        XCTAssertEqual(layout.frame.maxX - layout.wingWidth, 824.5)
        XCTAssertNil(NotchPlacement.layout(screen: screen, safeTop: 32,
            left: CGRect(x: 550, y: 924, width: 95.5, height: 32),
            right: CGRect(x: 824.5, y: 924, width: 645.5, height: 32)))
    }

    func testOtherNotchPanelSuppressesCollapsedExpandedAndBelowNotchSurfaces() throws {
        let layout = try XCTUnwrap(placement())
        // Real QuotaLimit window geometry captured from WindowServer.
        let collapsed = NotchWindow(ownerPID: 20, layer: 25, frame: CGRect(x: 581, y: 924, width: 307, height: 32))
        let expanded = NotchWindow(ownerPID: 20, layer: 25, frame: CGRect(x: 455, y: 846, width: 559, height: 110))
        let below = NotchWindow(ownerPID: 20, layer: 3, frame: CGRect(x: 583, y: 879, width: 304, height: 44))
        for window in [collapsed, expanded, below] {
            XCTAssertTrue(window.occupiesNotch(layout, screen: screen, ownPID: 10))
        }
        XCTAssertFalse(collapsed.occupiesNotch(layout, screen: screen, ownPID: 20))
    }

    func testMenuBarNormalWindowsOffscreenAndInvisiblePanelsDoNotSuppress() throws {
        let layout = try XCTUnwrap(placement())
        let windows = [
            NotchWindow(ownerPID: 20, layer: 24, frame: CGRect(x: 0, y: 923, width: 1470, height: 33)),
            NotchWindow(ownerPID: 20, layer: 0, frame: screen),
            NotchWindow(ownerPID: 20, layer: 0, frame: layout.frame),
            NotchWindow(ownerPID: 20, layer: 25, frame: CGRect(x: 20, y: 924, width: 307, height: 32)),
            NotchWindow(ownerPID: 20, layer: 25, frame: CGRect(x: 581, y: 500, width: 307, height: 32)),
            NotchWindow(ownerPID: 20, layer: 25, frame: CGRect(x: -889, y: 924, width: 307, height: 32)),
            NotchWindow(ownerPID: 20, layer: 25, frame: CGRect(x: 581, y: 956, width: 307, height: 32)),
            NotchWindow(ownerPID: 20, layer: 25, frame: layout.frame, alpha: 0)
        ]
        XCTAssertFalse(windows.contains { $0.occupiesNotch(layout, screen: screen, ownPID: 10) })
    }

    func testWindowMetadataConvertsQuartzCoordinatesWithoutTitles() throws {
        let window = try XCTUnwrap(NotchWindow(info: [
            kCGWindowOwnerPID as String: Int32(20), kCGWindowLayer as String: 25,
            kCGWindowBounds as String: CGRect(x: 581, y: 0, width: 307, height: 32).dictionaryRepresentation,
            kCGWindowAlpha as String: 1.0
        ], primaryTop: 956))
        XCTAssertEqual(window.frame, CGRect(x: 581, y: 924, width: 307, height: 32))
        XCTAssertTrue(window.occupiesNotch(try XCTUnwrap(placement()), screen: screen, ownPID: 10))
    }

    private var screen: CGRect { CGRect(x: 0, y: 0, width: 1470, height: 956) }
    private func placement() -> NotchLayout? {
        NotchPlacement.layout(screen: screen, safeTop: 32,
            left: CGRect(x: 0, y: 924, width: 645.5, height: 32),
            right: CGRect(x: 824.5, y: 924, width: 645.5, height: 32))
    }

    func testClaudeFocusClearsCodexConversationAndMatchesLocalLoginInsteadOfSelection() throws {
        let model = try model(accounts: [account("old", provider: "codex"), account("team")])
        model.selectedAccountID = "codex/old"
        model.focusedConversationID = "old-conversation"
        model.focusedConversationTitle = "Old conversation"
        model.followProvider(.claude)
        XCTAssertNil(model.focusedConversationID)
        XCTAssertNil(model.focusedConversationTitle)
        XCTAssertNil(model.menuAccount)
        model.claudeSessionFingerprint = "session-team"
        XCTAssertEqual(model.menuAccount?.account, "team")
        XCTAssertEqual(NotchSnapshot(model: model).remaining, 75)
        model.claudeSessionFingerprint = "new-login-not-collected-yet"
        XCTAssertNil(model.menuAccount)
        XCTAssertNil(NotchSnapshot(model: model).remaining)
        XCTAssertNotNil(model.concurrentRoutingTitle)
    }

    func testAmbiguousAndDisabledClaudeBindingsNeverBecomeCurrentAccount() throws {
        var duplicate = try account("duplicate")
        duplicate.desktopSessionFingerprint = "session-team"
        let model = try model(accounts: [account("team"), duplicate])
        model.followProvider(.claude)
        model.claudeSessionFingerprint = "session-team"
        XCTAssertNil(model.menuAccount)
        model.payload?.accounts = [try account("team", enabled: false)]
        XCTAssertNil(model.menuAccount)
    }

    func testReturningToCodexDropsClaudeMarkerAndResolvesConversationAgain() throws {
        let model = try model(accounts: [account("team"), account("work", provider: "codex")])
        model.followProvider(.claude)
        model.claudeSessionFingerprint = "session-team"
        model.selectedAccountID = "codex/work"
        model.followProvider(.codex)
        XCTAssertNil(model.claudeSessionFingerprint)
        XCTAssertEqual(model.menuAccount?.id, "codex/work")
        XCTAssertEqual(FocusedProvider(bundleIdentifier: "com.anthropic.claudefordesktop"), .claude)
        XCTAssertNil(FocusedProvider(bundleIdentifier: "com.apple.Terminal"))
    }

    func testStaleCachedOrFailedUsageNeverLooksLikeCurrentQuota() throws {
        let model = try model(accounts: [account("team")])
        model.followProvider(.claude)
        model.claudeSessionFingerprint = "session-team"
        XCTAssertEqual(NotchSnapshot(model: model).remaining, 75)
        model.lastError = "unavailable"
        XCTAssertNil(NotchSnapshot(model: model).remaining)
        model.lastError = nil
        model.payload?.accounts[0].windows[0].freshness = "stale"
        XCTAssertNil(NotchSnapshot(model: model).remaining)
    }

    func testCodexWithoutVerifiedFocusNeverShowsInspectedClaudeQuota() throws {
        let model = try model(accounts: [account("team"), account("work", provider: "codex")])
        model.showAccount(try account("team"))
        model.followProvider(.codex)
        XCTAssertNil(model.menuAccount)
        XCTAssertNil(NotchSnapshot(model: model).remaining)
    }

    func testAccentOnlyAnnouncesRealTransitionsNotEveryRefresh() throws {
        let model = try model(accounts: [account("team")])
        model.followProvider(.claude)
        model.claudeSessionFingerprint = "session-team"
        let original = NotchSnapshot(model: model)
        XCTAssertNil(original.event(after: nil))
        XCTAssertNil(original.event(after: original))
        model.payload?.accounts = [try account("team", remaining: 20)]
        XCTAssertNil(NotchSnapshot(model: model).event(after: original))
        model.payload?.accounts = [try account("team", remaining: 19)]
        let low = NotchSnapshot(model: model)
        XCTAssertEqual(low.event(after: original), Strings.t("notch.low"))
        model.payload?.accounts = [try account("team", remaining: 0)]
        let exhausted = NotchSnapshot(model: model)
        XCTAssertEqual(exhausted.event(after: low), Strings.t("notch.exhausted"))
        XCTAssertEqual(original.event(after: exhausted), Strings.t("notch.recovered"))
        model.payload?.accounts = [try account("other")]
        model.claudeSessionFingerprint = "session-other"
        XCTAssertEqual(NotchSnapshot(model: model).event(after: original), Strings.t("notch.accountChanged"))
    }

    private func model(accounts: [AccountState]) throws -> PopoverModel {
        let model = PopoverModel()
        var payload = try JSONDecoder().decode(StatusPayload.self, from: Data("{}".utf8))
        payload.accounts = accounts
        model.payload = payload
        return model
    }

    private func account(_ id: String, provider: String = "claude", remaining: Double = 75, enabled: Bool = true) throws -> AccountState {
        let data: [String: Any] = ["provider": provider, "account": id, "accountLabel": id, "enabled": enabled,
            "connection": "claude-desktop", "desktopSessionFingerprint": "session-\(id)",
            "collection": ["health": "recent-success"],
            "windows": [["provider": provider, "account": id, "bucket": provider == "codex" ? "codex:primary:300" : "five_hour",
                "label": "5h", "windowSeconds": 18000, "freshness": "fresh", "observedAtMs": Date().timeIntervalSince1970 * 1000,
                "remainingPercent": remaining]]]
        return try JSONDecoder().decode(AccountState.self, from: JSONSerialization.data(withJSONObject: data))
    }
}
