import XCTest
@testable import QuotaPie

final class CodexProfileDockRepairTests: XCTestCase {
    private let vendor = URL(fileURLWithPath: "/Applications/ChatGPT.app")
    private var profiles: [CodexDesktopProfile] {
        [.primary, .init(id: "second", name: "Second", codexHome: "/tmp/dock-home", appData: "/tmp/dock-data")]
    }
    private func pin(_ path: String = "file:///Applications/ChatGPT.app/", id: String = "com.openai.codex", guid: Int = 1) -> [String: Any] {
        ["GUID": guid, "tile-type": "file-tile", "tile-data": ["bundle-identifier": id,
            "file-label": "Keep original label", "file-data": ["_CFURLString": path, "_CFURLStringType": 15]]]
    }
    private func equal(_ left: [Any], _ right: [Any], file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertTrue(NSArray(array: left).isEqual(to: right), file: file, line: line)
    }
    private final class Fixture {
        var pins: [Any]?
        var backups: [[Any]] = []
        var writes: [[Any]] = []
        var restarts = 0
        var reads = 0
        var bundleID: String? = "com.openai.codex"
        var beforeRead: ((Int) -> Void)?
        var failBackup = false
        var ignoreWrite = false
        init(_ pins: [Any]?) { self.pins = pins }
        var io: CodexProfileDockRepair.IO {
            .init(bundleIdentifier: { _ in self.bundleID }, readPins: {
                self.reads += 1; self.beforeRead?(self.reads); return self.pins
            }, backup: {
                if self.failBackup { throw CodexProfileDockRepair.Failure.backupFailed }
                self.backups.append($0)
            }, writePins: {
                self.writes.append($0)
                if !self.ignoreWrite { self.pins = $0 }
            }, restartDock: { self.restarts += 1 })
        }
    }

    func testOnlyDuplicateVendorPinsAreRemovedAndSecondRunIsNoOp() throws {
        let launcher = pin("file:///Users/example/Applications/Codex%20Second.app/", id: "local.quotapie.codex-profile.second", guid: 5)
        let other = pin("file:///Applications/Safari.app/", id: "com.apple.Safari", guid: 6)
        let original: [Any] = [other, pin(guid: 10), launcher, pin(guid: 11), pin(guid: 12)]
        let fixture = Fixture(original)
        XCTAssertEqual(try CodexProfileDockRepair.repair(profiles: profiles, appURL: vendor, io: fixture.io), 2)
        equal(fixture.pins!, [other, pin(guid: 10), launcher])
        equal(fixture.backups[0], original)
        XCTAssertEqual(fixture.restarts, 1)
        XCTAssertEqual(try CodexProfileDockRepair.repair(profiles: profiles, appURL: vendor, io: fixture.io), 0)
        XCTAssertEqual(fixture.writes.count, 1); XCTAssertEqual(fixture.backups.count, 1); XCTAssertEqual(fixture.restarts, 1)
    }

    func testDifferentPathsForeignBundlesAndNonApplicationTilesStayUntouched() throws {
        let original: [Any] = [pin(), pin("file:///Applications/Codex.app/", guid: 2),
            pin("file:///Users/example/Applications/ChatGPT.app/", guid: 3), pin(id: "com.example.foreign", guid: 4),
            ["tile-type": "directory-tile", "tile-data": ["bundle-identifier": "com.openai.codex"]],
            ["tile-type": "spacer-tile"], ["tile-type": "recents-tile"], "unknown"]
        let fixture = Fixture(original)
        XCTAssertEqual(try CodexProfileDockRepair.repair(profiles: profiles, appURL: vendor, io: fixture.io), 0)
        equal(fixture.pins!, original)
        XCTAssertTrue(fixture.backups.isEmpty); XCTAssertTrue(fixture.writes.isEmpty); XCTAssertEqual(fixture.restarts, 0)
    }

    func testCanonicalPercentEscapingAndPathComponentsReferToSameVendor() {
        let original: [Any] = [pin(guid: 1), pin("file:///Applications/%43hatGPT.app", guid: 2),
            pin("file:///Applications/./ChatGPT.app/", guid: 3)]
        equal(CodexProfileDockRepair.deduplicatedPins(original, vendorURL: vendor), [pin(guid: 1)])
    }

    func testRemoteAndAmbiguousURLsAreNeverMergedWithLocalPin() {
        let original: [Any] = [pin(), pin("file://other-host/Applications/ChatGPT.app/", guid: 2),
            pin("https://example.test/Applications/ChatGPT.app", guid: 3),
            pin("file:///Applications/ChatGPT.app/?query=1", guid: 4),
            pin("file:///Applications/ChatGPT.app/#fragment", guid: 5), pin("invalid-path", guid: 6)]
        equal(CodexProfileDockRepair.deduplicatedPins(original, vendorURL: vendor), original)
    }

    func testRequiresRegisteredPrimaryAndSecondaryAndVerifiedVendorBundle() throws {
        for registered in [[], [profiles[0]], [profiles[1]]] {
            let fixture = Fixture([pin(), pin(guid: 2)])
            XCTAssertEqual(try CodexProfileDockRepair.repair(profiles: registered, appURL: vendor, io: fixture.io), 0)
            XCTAssertEqual(fixture.reads, 0); XCTAssertTrue(fixture.writes.isEmpty)
        }
        let fixture = Fixture([pin(), pin(guid: 2)])
        fixture.bundleID = "com.example.foreign"
        XCTAssertEqual(try CodexProfileDockRepair.repair(profiles: profiles, appURL: vendor, io: fixture.io), 0)
        XCTAssertEqual(fixture.reads, 0); XCTAssertTrue(fixture.writes.isEmpty)
    }

    func testMissingKeyAndAlreadyUniquePinHaveNoBackupOrRestart() throws {
        for pins: [Any]? in [nil, [], [pin()]] {
            let fixture = Fixture(pins)
            XCTAssertEqual(try CodexProfileDockRepair.repair(profiles: profiles, appURL: vendor, io: fixture.io), 0)
            XCTAssertTrue(fixture.backups.isEmpty); XCTAssertTrue(fixture.writes.isEmpty); XCTAssertEqual(fixture.restarts, 0)
        }
    }

    func testConcurrentPinEditAfterBackupIsPreservedWithoutWrite() {
        let fixture = Fixture([pin(), pin(guid: 2)])
        let changed: [Any] = [pin(), pin(guid: 2), pin("file:///Applications/Safari.app/", id: "com.apple.Safari", guid: 3)]
        fixture.beforeRead = { count in if count == 2 { fixture.pins = changed } }
        XCTAssertThrowsError(try CodexProfileDockRepair.repair(profiles: profiles, appURL: vendor, io: fixture.io)) {
            XCTAssertEqual($0 as? CodexProfileDockRepair.Failure, .snapshotChanged)
        }
        equal(fixture.pins!, changed)
        XCTAssertEqual(fixture.backups.count, 1); XCTAssertTrue(fixture.writes.isEmpty); XCTAssertEqual(fixture.restarts, 0)
    }

    func testBackupFailureAndFailedWriteVerificationNeverRestartDock() {
        let backup = Fixture([pin(), pin(guid: 2)]); backup.failBackup = true
        XCTAssertThrowsError(try CodexProfileDockRepair.repair(profiles: profiles, appURL: vendor, io: backup.io)) {
            XCTAssertEqual($0 as? CodexProfileDockRepair.Failure, .backupFailed)
        }
        XCTAssertTrue(backup.writes.isEmpty); XCTAssertEqual(backup.restarts, 0)
        let write = Fixture([pin(), pin(guid: 2)]); write.ignoreWrite = true
        XCTAssertThrowsError(try CodexProfileDockRepair.repair(profiles: profiles, appURL: vendor, io: write.io)) {
            XCTAssertEqual($0 as? CodexProfileDockRepair.Failure, .verificationFailed)
        }
        XCTAssertEqual(write.writes.count, 1); XCTAssertEqual(write.restarts, 0)
    }

    func testEditAfterWriteIsNotOverwrittenByRollbackOrDockRestart() {
        let fixture = Fixture([pin(), pin(guid: 2)])
        let changed: [Any] = [pin("file:///Applications/Safari.app/", id: "com.apple.Safari", guid: 3)]
        fixture.beforeRead = { count in if count == 3 { fixture.pins = changed } }
        XCTAssertThrowsError(try CodexProfileDockRepair.repair(profiles: profiles, appURL: vendor, io: fixture.io)) {
            XCTAssertEqual($0 as? CodexProfileDockRepair.Failure, .verificationFailed)
        }
        equal(fixture.pins!, changed)
        XCTAssertEqual(fixture.writes.count, 1); XCTAssertEqual(fixture.restarts, 0)
    }

    func testCancellationBeforeStartOrDuringInitialReadHasNoSideEffects() {
        for cancelAtRead in [0, 1] {
            let fixture = Fixture([pin(), pin(guid: 2)])
            var proceed = cancelAtRead != 0
            fixture.beforeRead = { count in if count == cancelAtRead { proceed = false } }
            XCTAssertThrowsError(try CodexProfileDockRepair.repair(profiles: profiles, appURL: vendor,
                shouldProceed: { proceed }, io: fixture.io)) {
                XCTAssertEqual($0 as? CodexProfileDockRepair.Failure, .cancelled)
            }
            XCTAssertEqual(fixture.reads, cancelAtRead)
            XCTAssertTrue(fixture.backups.isEmpty); XCTAssertTrue(fixture.writes.isEmpty)
            XCTAssertEqual(fixture.restarts, 0)
        }
    }

    func testCancellationDuringFinalSnapshotReadPreventsWrite() {
        let original: [Any] = [pin(), pin(guid: 2)]
        let fixture = Fixture(original)
        var proceed = true
        fixture.beforeRead = { count in if count == 2 { proceed = false } }
        XCTAssertThrowsError(try CodexProfileDockRepair.repair(profiles: profiles, appURL: vendor,
            shouldProceed: { proceed }, io: fixture.io)) {
            XCTAssertEqual($0 as? CodexProfileDockRepair.Failure, .cancelled)
        }
        equal(fixture.pins!, original)
        XCTAssertEqual(fixture.backups.count, 1); XCTAssertTrue(fixture.writes.isEmpty)
        XCTAssertEqual(fixture.restarts, 0)
    }

    func testCancellationAfterWritePreservesSavedPinsWithoutRestartOrRollback() {
        let fixture = Fixture([pin(), pin(guid: 2)])
        var proceed = true
        var io = fixture.io
        let write = io.writePins
        io.writePins = { pins in try write(pins); proceed = false }
        XCTAssertThrowsError(try CodexProfileDockRepair.repair(profiles: profiles, appURL: vendor,
            shouldProceed: { proceed }, io: io)) {
            XCTAssertEqual($0 as? CodexProfileDockRepair.Failure, .cancelled)
        }
        equal(fixture.pins!, [pin()])
        XCTAssertEqual(fixture.backups.count, 1); XCTAssertEqual(fixture.writes.count, 1)
        XCTAssertEqual(fixture.restarts, 0)
    }
}
