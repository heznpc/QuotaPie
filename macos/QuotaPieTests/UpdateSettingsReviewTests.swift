import XCTest
@testable import QuotaPie

final class UpdateSettingsReviewTests: XCTestCase {
    private var defaults: UserDefaults!
    private var suite: String!
    private let first = QuotaPieInstallation(id: "update-1", isUpdate: true)
    private let second = QuotaPieInstallation(id: "update-2", isUpdate: true)

    override func setUp() {
        suite = "QuotaPie.UpdateSettingsReviewTests." + UUID().uuidString
        defaults = UserDefaults(suiteName: suite)!
    }
    override func tearDown() { defaults.removePersistentDomain(forName: suite) }

    func testUpgradeFromOlderAppAsksAndDoesNotAcknowledgeUntilChoice() {
        XCTAssertNotNil(UpdateSettingsReviewPolicy(defaults: defaults).review(for: first))
        XCTAssertNotNil(UpdateSettingsReviewPolicy(defaults: defaults).review(for: first))
        XCTAssertNil(defaults.data(forKey: "updates.settingsReview.v1"))
    }

    func testOneTimeKeepSurvivesRestartButAsksOnNextUpdate() {
        UpdateSettingsReviewPolicy(defaults: defaults).complete(first)
        let restarted = UpdateSettingsReviewPolicy(defaults: defaults)
        XCTAssertNil(restarted.review(for: first))
        XCTAssertNotNil(restarted.review(for: second))
    }

    func testUncheckingAlwaysKeepDuringNewSettingsReviewRestoresFuturePrompts() {
        UpdateSettingsReviewPolicy(defaults: defaults, schema: 1).complete(first, alwaysKeep: true)
        let updated = UpdateSettingsReviewPolicy(defaults: defaults, schema: 2)
        XCTAssertEqual(updated.review(for: second)?.alwaysKeep, true)
        updated.complete(second, alwaysKeep: false)
        let next = updated.review(for: .init(id: "update-3", isUpdate: true))
        XCTAssertNotNil(next)
        XCTAssertEqual(next?.alwaysKeep, false)
        XCTAssertEqual(next?.hasNewSettings, false)
    }

    func testAlwaysKeepSkipsSuccessiveUpdatesWithSameSettings() {
        UpdateSettingsReviewPolicy(defaults: defaults).complete(first, alwaysKeep: true)
        XCTAssertNil(UpdateSettingsReviewPolicy(defaults: defaults).review(for: second))
        XCTAssertNil(UpdateSettingsReviewPolicy(defaults: defaults).review(for: .init(id: "update-3", isUpdate: true)))
    }

    func testNewSettingsOverrideSuppressionAndRemainPendingAcrossRestart() {
        UpdateSettingsReviewPolicy(defaults: defaults, schema: 1).complete(first, alwaysKeep: true)
        let policy = UpdateSettingsReviewPolicy(defaults: defaults, schema: 2)
        XCTAssertEqual(policy.review(for: second)?.hasNewSettings, true)
        XCTAssertEqual(UpdateSettingsReviewPolicy(defaults: defaults, schema: 2).review(for: second)?.hasNewSettings, true)
        policy.complete(second)
        XCTAssertNil(UpdateSettingsReviewPolicy(defaults: defaults, schema: 2).review(for: .init(id: "update-3", isUpdate: true)))
        XCTAssertEqual(UpdateSettingsReviewPolicy(defaults: defaults, schema: 3).review(for: .init(id: "update-4", isUpdate: true))?.hasNewSettings, true)
    }

    func testFreshInstallDoesNotAskAboutNonexistentPriorSettings() {
        let fresh = QuotaPieInstallation(id: "fresh", isUpdate: false)
        let policy = UpdateSettingsReviewPolicy(defaults: defaults)
        XCTAssertNil(policy.review(for: fresh))
        XCTAssertNil(UpdateSettingsReviewPolicy(defaults: defaults).review(for: fresh))
        XCTAssertNotNil(policy.review(for: first))
    }

    func testRollbackDoesNotEraseAcknowledgedNewSettingsOrReaskOldUpdate() {
        UpdateSettingsReviewPolicy(defaults: defaults, schema: 1).complete(first, alwaysKeep: true)
        UpdateSettingsReviewPolicy(defaults: defaults, schema: 2).complete(second)
        XCTAssertNil(UpdateSettingsReviewPolicy(defaults: defaults, schema: 1).review(for: first))
        XCTAssertNil(UpdateSettingsReviewPolicy(defaults: defaults, schema: 2).review(for: second))
    }

    func testDamagedPreferenceAsksInsteadOfSilentlySuppressingReview() {
        defaults.set(Data("invalid".utf8), forKey: "updates.settingsReview.v1")
        XCTAssertNotNil(UpdateSettingsReviewPolicy(defaults: defaults).review(for: first))
    }

    func testInstallReceiptSupportsFinderAndRejectsOldProcessAndDevelopmentBundle() throws {
        let home = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: home) }
        let agent = home.appendingPathComponent("Library/LaunchAgents/local.quotapie.menubar.plist")
        try FileManager.default.createDirectory(at: agent.deletingLastPathComponent(), withIntermediateDirectories: true)
        let bundle = home.appendingPathComponent("Applications/QuotaPie.app").path
        let plist: [String: Any] = ["ProgramArguments": [bundle + "/Contents/MacOS/QuotaPie"],
            "EnvironmentVariables": ["QUOTAPIE_INSTALL_ID": "update-1", "QUOTAPIE_INSTALL_IS_UPDATE": "1"]]
        try PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0).write(to: agent)
        XCTAssertEqual(QuotaPieInstallation.read(environment: [:], bundlePath: bundle, home: home), first)
        XCTAssertEqual(QuotaPieInstallation.read(environment: ["QUOTAPIE_INSTALL_ID": "update-1"], bundlePath: bundle, home: home), first)
        XCTAssertNil(QuotaPieInstallation.read(environment: ["QUOTAPIE_INSTALL_ID": "old"], bundlePath: bundle, home: home))
        XCTAssertNil(QuotaPieInstallation.read(environment: [:], bundlePath: "/tmp/development.app", home: home))
    }
}
