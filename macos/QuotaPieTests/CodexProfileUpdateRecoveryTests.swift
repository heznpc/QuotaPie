import XCTest
@testable import QuotaPie

final class CodexProfileUpdateRecoveryTests: XCTestCase {
    let primary = CodexDesktopProfile.primary
    let second = CodexDesktopProfile(id: "second", name: "Second", codexHome: "/tmp/update-second-home", appData: "/tmp/update-second-data")
    let start = Date(timeIntervalSince1970: 1000)
    func instance(_ pid: Int32, _ profile: CodexDesktopProfile, _ date: Date) -> CodexProfileUpdateRecovery.Instance {
        .init(pid: pid, identity: .init(codexHome: CodexDesktopProfile.canonical(profile.codexHome),
                                      appData: CodexDesktopProfile.canonical(profile.appData)), launchedAt: date)
    }
    func testUpdateRestoresLostSecondAndOnlyStopsNewDuplicate() {
        var state = CodexProfileUpdateRecovery()
        let main = instance(10, primary, start), secondary = instance(20, second, start)
        _ = state.observe(stamp: "old", instances: [main, secondary], profiles: [primary, second], now: start)
        let updated = start.addingTimeInterval(10)
        _ = state.observe(stamp: "new", instances: [main], profiles: [primary, second], now: updated)
        let duplicate = instance(30, primary, updated)
        let actions = state.observe(stamp: "new", instances: [main, duplicate], profiles: [primary, second], now: updated.addingTimeInterval(3))
        XCTAssertEqual(actions.reopen, [second])
        XCTAssertEqual(actions.stopDuplicate, [30])
        let restored = instance(40, second, updated)
        XCTAssertTrue(state.observe(stamp: "new", instances: [main, restored], profiles: [primary, second], now: updated.addingTimeInterval(4)).reopen.isEmpty)
        XCTAssertTrue(state.observe(stamp: "new", instances: [main], profiles: [primary, second], now: updated.addingTimeInterval(5)).reopen.isEmpty)
    }
    func testNormalQuitDoesNotReopenAndUnknownPrimaryIsNeverStopped() {
        var state = CodexProfileUpdateRecovery()
        let secondary = instance(20, second, start)
        _ = state.observe(stamp: "old", instances: [secondary], profiles: [primary, second], now: start)
        XCTAssertTrue(state.observe(stamp: "old", instances: [], profiles: [primary, second], now: start.addingTimeInterval(1)).reopen.isEmpty)
        _ = state.observe(stamp: "new", instances: [], profiles: [primary, second], now: start.addingTimeInterval(2))
        let actions = state.observe(stamp: "new", instances: [instance(30, primary, start.addingTimeInterval(2))], profiles: [primary, second], now: start.addingTimeInterval(5))
        XCTAssertEqual(actions.reopen, [second])
        XCTAssertTrue(actions.stopDuplicate.isEmpty)
    }
    func testRemovedProfileAndOldQuitAreNotRestored() {
        var state = CodexProfileUpdateRecovery()
        _ = state.observe(stamp: "old", instances: [instance(20, second, start)], profiles: [primary, second], now: start)
        let later = start.addingTimeInterval(60)
        _ = state.observe(stamp: "new", instances: [], profiles: [primary, second], now: later)
        XCTAssertTrue(state.observe(stamp: "new", instances: [], profiles: [primary, second], now: later.addingTimeInterval(3)).reopen.isEmpty)
        var removed = CodexProfileUpdateRecovery()
        _ = removed.observe(stamp: "old", instances: [instance(20, second, start)], profiles: [primary, second], now: start)
        _ = removed.observe(stamp: "new", instances: [], profiles: [primary, second], now: start.addingTimeInterval(1))
        XCTAssertTrue(removed.observe(stamp: "new", instances: [], profiles: [primary], now: start.addingTimeInterval(4)).reopen.isEmpty)
    }
    func testPartialEnvironmentLossIsRecognizedByIsolatedDataPath() {
        var state = CodexProfileUpdateRecovery()
        _ = state.observe(stamp: "old", instances: [instance(20, second, start)], profiles: [primary, second], now: start)
        let later = start.addingTimeInterval(10)
        _ = state.observe(stamp: "new", instances: [], profiles: [primary, second], now: later)
        let broken = CodexProfileUpdateRecovery.Instance(pid: 30,
            identity: .init(codexHome: primary.codexHome, appData: CodexDesktopProfile.canonical(second.appData)), launchedAt: later)
        let actions = state.observe(stamp: "new", instances: [broken], profiles: [primary, second], now: later.addingTimeInterval(3))
        XCTAssertEqual(actions.reopen, [second]); XCTAssertEqual(actions.stopDuplicate, [30])
    }
    func testPrimaryReplacementCanAnchorButTwoUnknownCopiesStayUntouched() {
        func initial() -> CodexProfileUpdateRecovery {
            var state = CodexProfileUpdateRecovery()
            _ = state.observe(stamp: "old", instances: [instance(10, primary, start), instance(20, second, start)], profiles: [primary, second], now: start)
            _ = state.observe(stamp: "new", instances: [], profiles: [primary, second], now: start.addingTimeInterval(1))
            return state
        }
        var state = initial()
        let newPrimary = instance(30, primary, start.addingTimeInterval(1))
        let duplicate = instance(40, primary, start.addingTimeInterval(4))
        _ = state.observe(stamp: "new", instances: [newPrimary], profiles: [primary, second], now: start.addingTimeInterval(3))
        XCTAssertEqual(state.observe(stamp: "new", instances: [newPrimary, duplicate], profiles: [primary, second], now: start.addingTimeInterval(5)).stopDuplicate, [40])
        var ambiguous = initial()
        XCTAssertTrue(ambiguous.observe(stamp: "new", instances: [newPrimary, duplicate], profiles: [primary, second], now: start.addingTimeInterval(5)).stopDuplicate.isEmpty)
    }
}
