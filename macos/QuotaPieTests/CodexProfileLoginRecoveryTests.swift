import XCTest
@testable import QuotaPie

final class CodexProfileLoginRecoveryTests: XCTestCase {
    let secondary = CodexDesktopProfile(id: "second", name: "Second", codexHome: "/tmp/login-home", appData: "/tmp/login-data")
    func testNewBootRestoresBWhenSystemRestoredTwoCopiesOfA() {
        let primary = CodexDesktopProfile.primary
        var state = CodexProfileLoginRecovery(boot: "new", savedBoot: "old", savedPending: [], profiles: [primary, secondary])
        let duplicateA = CodexProfileUpdateRecovery.Instance(pid: 10,
            identity: .init(codexHome: primary.codexHome, appData: primary.appData), launchedAt: Date())
        XCTAssertEqual(state.reconcile(instances: [duplicateA, duplicateA], profiles: [primary, secondary]), [secondary])
        var extraA = duplicateA; extraA = .init(pid: 11, identity: duplicateA.identity, launchedAt: duplicateA.launchedAt.addingTimeInterval(1))
        XCTAssertEqual(state.duplicatePrimaryPIDs(instances: [extraA, duplicateA], profiles: [primary, secondary], withinBootRestoration: true), [11])
        XCTAssertTrue(state.duplicatePrimaryPIDs(instances: [extraA, duplicateA], profiles: [primary, secondary], withinBootRestoration: false).isEmpty)
        let b = CodexProfileUpdateRecovery.Instance(pid: 20,
            identity: .init(codexHome: secondary.codexHome, appData: secondary.appData), launchedAt: Date())
        XCTAssertTrue(state.reconcile(instances: [duplicateA, b], profiles: [primary, secondary]).isEmpty)
        XCTAssertTrue(state.reconcile(instances: [duplicateA], profiles: [primary, secondary]).isEmpty)
        let restarted = CodexProfileLoginRecovery(boot: "new", savedBoot: state.boot,
            savedPending: Array(state.pending), profiles: [primary, secondary])
        XCTAssertTrue(restarted.pending.isEmpty)
    }
    func testUnregisteredAndOptedOutProfilesStayClosed() {
        var disabled = secondary; disabled.restoreOnLogin = false
        var state = CodexProfileLoginRecovery(boot: "new", savedBoot: "old", savedPending: [], profiles: [disabled])
        XCTAssertTrue(state.pending.isEmpty)
        state = CodexProfileLoginRecovery(boot: "new", savedBoot: "old", savedPending: [], profiles: [secondary])
        XCTAssertTrue(state.reconcile(instances: [], profiles: []).isEmpty)
    }
    func testRestoreInterruptedByMeterRestartRemainsPending() {
        let state = CodexProfileLoginRecovery(boot: "same", savedBoot: "same", savedPending: ["second"], profiles: [secondary])
        XCTAssertEqual(state.pending, ["second"])
    }
    func testResourceOnlyUpdateChangesFingerprint() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("quota-resource-update-" + UUID().uuidString + ".app")
        defer { try? FileManager.default.removeItem(at: root) }
        let contents = root.appendingPathComponent("Contents")
        try FileManager.default.createDirectory(at: contents.appendingPathComponent("MacOS"), withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: contents.appendingPathComponent("Resources"), withIntermediateDirectories: true)
        try PropertyListSerialization.data(fromPropertyList: ["CFBundleIdentifier": "local.quota.fixture", "CFBundleExecutable": "Fixture"],
            format: .xml, options: 0).write(to: contents.appendingPathComponent("Info.plist"))
        try Data("unchanged native executable".utf8).write(to: contents.appendingPathComponent("MacOS/Fixture"))
        let archive = contents.appendingPathComponent("Resources/app.asar")
        try Data("old".utf8).write(to: archive)
        let before = CodexProfileUpdateMonitor.applicationStamp(root)
        try Data("updated resources only".utf8).write(to: archive)
        XCTAssertNotNil(before)
        XCTAssertNotEqual(before, CodexProfileUpdateMonitor.applicationStamp(root))
    }
}
