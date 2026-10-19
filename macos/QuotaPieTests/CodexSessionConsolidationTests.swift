import Darwin
import Foundation
import XCTest
@testable import QuotaPie

final class CodexSessionConsolidationTests: XCTestCase {
    private func fixture() throws -> (URL, CodexDesktopProfile, CodexDesktopProfile) {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("quota-consolidation-ui-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let root = directory.resolvingSymlinksInPath()
        let primary = CodexDesktopProfile(id: "primary", name: "Primary", codexHome: root.appendingPathComponent("primary-home").path,
                                          appData: root.appendingPathComponent("primary-app").path)
        let source = CodexDesktopProfile(id: "second", name: "Second", codexHome: root.appendingPathComponent("source-home").path,
                                         appData: root.appendingPathComponent("source-app").path, collectionAccount: "second")
        return (root, primary, source)
    }
    private func write(_ url: URL, primary: CodexDesktopProfile, source: CodexDesktopProfile,
                       state: String = "complete", changes: [String: Any] = [:]) throws {
        var value: [String: Any] = ["version": 1, "state": state,
            "primary": ["codexHome": primary.codexHome, "appData": primary.appData],
            "sources": [["codexHome": source.codexHome, "appData": source.appData]],
            "completedAtMs": 1000, "report": ["extraBackendFields": true]]
        changes.forEach { value[$0.key] = $0.value }
        try JSONSerialization.data(withJSONObject: value).write(to: url, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    }
    func testCompletionRoutesWorkToPrimaryButNeverReopensTheMigratedLoginHome() throws {
        let (root, primary, source) = try fixture(); defer { try? FileManager.default.removeItem(at: root) }
        let marker = root.appendingPathComponent("marker.json")
        try write(marker, primary: primary, source: source)
        let complete = try XCTUnwrap(CodexSessionConsolidation.read(at: marker, primary: primary))
        XCTAssertEqual(try source.launchProfile(intent: .work, consolidation: complete, primary: primary), primary)
        XCTAssertThrowsError(try source.launchProfile(intent: .accountLogin, consolidation: complete, primary: primary))
        let launcher = CodexProfileLauncher(consolidation: { complete }, history: CodexSessionConsolidationHistory())
        let refused = expectation(description: "migrated login blocked before consulting an app or launching")
        launcher.open(source, appURL: root.appendingPathComponent("nonexistent.app"), intent: .accountLogin) { result in
            if case .failure(let error) = result { XCTAssertEqual(error as? ProfileError, .consolidated) }
            else { XCTFail("A migrated source must not be reopened") }
            refused.fulfill()
        }
        wait(for: [refused], timeout: 1)
        let unknown = CodexDesktopProfile(id: "other", name: "Other", codexHome: root.appendingPathComponent("other-home").path,
                                         appData: root.appendingPathComponent("other-app").path)
        XCTAssertEqual(try unknown.launchProfile(intent: .work, consolidation: complete, primary: primary), unknown)
    }
    func testPendingKeepsExistingHostRoutingButSuspendsRestorationUntilTheExactSourceIsComplete() throws {
        let (root, primary, source) = try fixture(); defer { try? FileManager.default.removeItem(at: root) }
        let marker = root.appendingPathComponent("marker.json")
        try write(marker, primary: primary, source: source, state: "waiting-for-source-exit", changes: ["completedAtMs": NSNull()])
        var snapshot = try XCTUnwrap(CodexSessionConsolidation.read(at: marker, primary: primary))
        XCTAssertEqual(try source.launchProfile(intent: .work, consolidation: snapshot, primary: primary), source)
        XCTAssertEqual(try source.launchProfile(intent: .accountLogin, consolidation: snapshot, primary: primary), source)
        let suite = "quota-consolidation-model-" + UUID().uuidString
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        defaults.set(try JSONEncoder().encode([primary, source]), forKey: "local.quotapie.codex-desktop-profiles.v1")
        let model = CodexProfilesModel(defaults: defaults, consolidation: { snapshot }, history: CodexSessionConsolidationHistory())
        XCTAssertEqual(model.automaticRestorationProfiles, [primary])
        XCTAssertFalse(model.allowsAccountLogin(source))
        try write(marker, primary: primary, source: source)
        snapshot = try XCTUnwrap(CodexSessionConsolidation.read(at: marker, primary: primary))
        XCTAssertEqual(model.automaticRestorationProfiles, [primary])
        XCTAssertFalse(model.allowsAccountLogin(source))
        model.setRestoreOnLogin(true, for: source)
        XCTAssertEqual(model.profiles, [primary, source], "Do not rewrite or remove the old registration or its restore preference")
        XCTAssertEqual(model.profiles[1].collectionAccount, "second")
    }
    func testNewCredentialsOnlyProfilesNeverAutoRestoreAndWorkOpensPrimary() throws {
        let (root, primary, _) = try fixture(); defer { try? FileManager.default.removeItem(at: root) }
        let suite = "quota-credential-only-" + UUID().uuidString
        let defaults = UserDefaults(suiteName: suite)!; defer { defaults.removePersistentDomain(forName: suite) }
        defaults.set(try JSONEncoder().encode([primary]), forKey: "local.quotapie.codex-desktop-profiles.v1")
        let model = CodexProfilesModel(defaults: defaults, consolidation: { nil }, history: CodexSessionConsolidationHistory())
        model.add(name: "New quota account", home: nil, data: nil)
        let fresh = try XCTUnwrap(model.profiles.last)
        XCTAssertEqual(fresh.credentialOnly, true); XCTAssertEqual(fresh.restoreOnLogin, false)
        XCTAssertEqual(model.automaticRestorationProfiles, [primary])
        XCTAssertEqual(try fresh.launchProfile(intent: .work, consolidation: nil, primary: primary), primary)
        XCTAssertEqual(try fresh.launchProfile(intent: .accountLogin, consolidation: nil, primary: primary), fresh)
        model.add(name: "Imported history", home: root.appendingPathComponent("imported-home").path, data: root.appendingPathComponent("imported-app").path)
        let imported = try XCTUnwrap(model.profiles.last)
        XCTAssertEqual(imported.credentialOnly, false); XCTAssertEqual(imported.restoreOnLogin, false)
        XCTAssertEqual(try imported.launchProfile(intent: .work, consolidation: nil, primary: primary), imported)
    }
    func testInvalidOrUntrustedMarkersCannotChangeWorkRouting() throws {
        let (root, primary, source) = try fixture(); defer { try? FileManager.default.removeItem(at: root) }
        let marker = root.appendingPathComponent("marker.json")
        for changes: [String: Any] in [["version": 2], ["state": "copying"], ["completedAtMs": NSNull()],
            ["completedAtMs": Date().addingTimeInterval(60).timeIntervalSince1970 * 1000],
            ["primary": ["codexHome": "/tmp/foreign", "appData": primary.appData]],
            ["sources": [["codexHome": source.codexHome, "appData": source.appData], ["codexHome": source.codexHome, "appData": source.appData]]]] {
            try write(marker, primary: primary, source: source, changes: changes)
            XCTAssertNil(CodexSessionConsolidation.read(at: marker, primary: primary))
        }
        try write(marker, primary: primary, source: source)
        try FileManager.default.setAttributes([.posixPermissions: 0o666], ofItemAtPath: marker.path)
        XCTAssertNil(CodexSessionConsolidation.read(at: marker, primary: primary))
        try write(marker, primary: primary, source: source)
        let alias = root.appendingPathComponent("alias.json")
        try FileManager.default.createSymbolicLink(at: alias, withDestinationURL: marker)
        XCTAssertNil(CodexSessionConsolidation.read(at: alias, primary: primary))
        try Data(repeating: 32, count: 65 * 1024).write(to: marker)
        XCTAssertNil(CodexSessionConsolidation.read(at: marker, primary: primary))
        XCTAssertNil(CodexSessionConsolidation.read(at: root, primary: primary))
    }
    func testLosingVerifiedCompletionNeverRestoresOrReopensTheRetiredRoot() throws {
        let (root, primary, source) = try fixture(); defer { try? FileManager.default.removeItem(at: root) }
        let marker = root.appendingPathComponent("marker.json")
        try write(marker, primary: primary, source: source)
        var snapshot = CodexSessionConsolidation.read(at: marker, primary: primary)
        let complete = try XCTUnwrap(snapshot), history = CodexSessionConsolidationHistory()
        let suite = "quota-consolidation-sticky-" + UUID().uuidString
        let defaults = UserDefaults(suiteName: suite)!; defer { defaults.removePersistentDomain(forName: suite) }
        defaults.set(try JSONEncoder().encode([primary, source]), forKey: "local.quotapie.codex-desktop-profiles.v1")
        let model = CodexProfilesModel(defaults: defaults, consolidation: { snapshot }, history: history)
        XCTAssertEqual(model.automaticRestorationProfiles, [primary])
        snapshot = nil
        XCTAssertEqual(model.automaticRestorationProfiles, [primary])
        XCTAssertTrue(model.requiresConsolidationVerification(source))
        XCTAssertFalse(model.allowsAccountLogin(source))
        XCTAssertFalse(model.requiresConsolidationVerification(primary))
        let launcher = CodexProfileLauncher(consolidation: { snapshot }, history: history)
        for intent: CodexProfileLaunchIntent in [.work, .accountLogin] {
            let blocked = expectation(description: "missing completion record blocks retired source")
            launcher.open(source, appURL: root.appendingPathComponent("nonexistent.app"), intent: intent) { result in
                if case .failure(let error) = result { XCTAssertEqual(error as? ProfileError, .consolidationUnavailable) }
                else { XCTFail("Missing proof must not reopen the old root") }
                blocked.fulfill()
            }
            wait(for: [blocked], timeout: 1)
        }
        snapshot = complete; model.refreshConsolidation()
        XCTAssertFalse(model.requiresConsolidationVerification(source))
        XCTAssertEqual(try source.launchProfile(intent: .work, consolidation: snapshot, primary: primary), primary)
    }
    func testWaitingSurvivesRebootAndOnlyActivatesTheExistingExactSource() throws {
        let (root, primary, source) = try fixture(); defer { try? FileManager.default.removeItem(at: root) }
        let other = CodexDesktopProfile(id: "other", name: "Other", codexHome: root.appendingPathComponent("other-home").path,
            appData: root.appendingPathComponent("other-app").path)
        let statusFile = root.appendingPathComponent("status.json")
        func writeStatus(_ state: String) throws {
            let value: [String: Any] = ["version": 1, "state": state, "updatedAtMs": 1000,
                "primary": ["codexHome": primary.codexHome, "appData": primary.appData],
                "source": ["codexHome": source.codexHome, "appData": source.appData]]
            try JSONSerialization.data(withJSONObject: value).write(to: statusFile, options: .atomic)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: statusFile.path)
        }
        try writeStatus("waiting-for-source-exit")
        let suite = "quota-consolidation-reboot-" + UUID().uuidString
        let defaults = UserDefaults(suiteName: suite)!; defer { defaults.removePersistentDomain(forName: suite) }
        defaults.set(try JSONEncoder().encode([primary, source, other]), forKey: "local.quotapie.codex-desktop-profiles.v1")
        let activity = { CodexSessionConsolidationActivity.read(at: statusFile, primary: primary) }
        let history = CodexSessionConsolidationHistory()
        // Both the initial menu process and a new process after reboot honor the
        // on-disk pending request before the collector has resumed migration.
        for _ in 0..<2 {
            let model = CodexProfilesModel(defaults: defaults, consolidation: { nil }, activity: activity, history: history)
            XCTAssertEqual(model.automaticRestorationProfiles, [primary, other])
            XCTAssertTrue(model.isConsolidationPending(source)); XCTAssertFalse(model.allowsAccountLogin(source))
            XCTAssertFalse(model.isConsolidationPending(primary)); XCTAssertTrue(model.allowsAccountLogin(other))
            XCTAssertEqual(model.profiles, [primary, source, other], "Keep registration and restore preference intact")
        }
        let app = root.appendingPathComponent("Fixture.app"), contents = app.appendingPathComponent("Contents")
        let executable = contents.appendingPathComponent("MacOS/Fixture")
        try FileManager.default.createDirectory(at: executable.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data("#!/bin/sh\nexit 1\n".utf8).write(to: executable)
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: executable.path)
        try PropertyListSerialization.data(fromPropertyList: ["CFBundleIdentifier": "local.quotapie.no-launch-test", "CFBundleExecutable": "Fixture"],
            format: .xml, options: 0).write(to: contents.appendingPathComponent("Info.plist"))
        let bundleExecutable = try XCTUnwrap(Bundle(url: app)?.executableURL)
        var activations = 0, existing = true
        let launcher = CodexProfileLauncher(readIdentity: { _ in .init(codexHome: source.codexHome, appData: source.appData) },
            consolidation: { nil }, activity: activity, history: history, runningApplications: {
                existing ? [.init(processIdentifier: 42, executableURL: bundleExecutable, activate: { activations += 1; return true })] : []
            })
        func open(_ profile: CodexDesktopProfile, intent: CodexProfileLaunchIntent = .work, expected: ProfileError?) {
            let finished = expectation(description: "consolidation launch gate")
            launcher.open(profile, appURL: app, intent: intent) { result in
                switch result {
                case .success: XCTAssertNil(expected)
                case .failure(let error): XCTAssertEqual(error as? ProfileError, expected)
                }
                finished.fulfill()
            }
            wait(for: [finished], timeout: 1)
        }
        open(source, expected: nil); XCTAssertEqual(activations, 1)
        open(source, intent: .accountLogin, expected: .consolidationPending)
        let overlaps = [
            CodexDesktopProfile(id: "same-home", name: "Re-registered", codexHome: source.codexHome, appData: root.appendingPathComponent("new-app").path),
            CodexDesktopProfile(id: "same-app", name: "Re-registered", codexHome: root.appendingPathComponent("new-home").path, appData: source.appData),
            CodexDesktopProfile(id: "nested", name: "Re-registered", codexHome: source.codexHome + "/child", appData: root.appendingPathComponent("nested-app").path),
        ]
        for profile in overlaps {
            XCTAssertTrue(try XCTUnwrap(activity()).blocks(profile))
            open(profile, expected: .consolidationPending)
        }
        XCTAssertEqual(activations, 1, "Overlapping registrations must not activate a different identity")
        existing = false // Natural exit or reboot, not a QuotaPie termination.
        for _ in 0..<2 { open(source, expected: .consolidationPending) }
        XCTAssertFalse(FileManager.default.fileExists(atPath: source.codexHome))
        XCTAssertFalse(FileManager.default.fileExists(atPath: source.appData))
        try writeStatus("running"); existing = true
        open(source, expected: .consolidationRunning)
        open(source, intent: .accountLogin, expected: .consolidationRunning)
        XCTAssertEqual(activations, 1, "Running migration must not activate the old source")
        let model = CodexProfilesModel(defaults: defaults, consolidation: { nil }, activity: activity, history: history)
        XCTAssertEqual(model.automaticRestorationProfiles, [primary, other])
        XCTAssertTrue(model.isConsolidationRunning(source)); XCTAssertFalse(model.isConsolidationRunning(primary))
        try writeStatus("blocked")
        XCTAssertEqual(model.automaticRestorationProfiles, [primary, other])
        XCTAssertFalse(model.allowsAccountLogin(source)); XCTAssertTrue(model.requiresConsolidationVerification(source))
        open(source, expected: .consolidationUnavailable)
        XCTAssertEqual(activations, 1, "Blocked after a partial commit must not revive the source")
    }
    func testRetiredSourceStaysBlockedAfterRestartAndCompletionMarkerLoss() throws {
        let (root, primary, source) = try fixture(); defer { try? FileManager.default.removeItem(at: root) }
        let marker = root.appendingPathComponent("marker.json")
        try write(marker, primary: primary, source: source)
        let complete = try XCTUnwrap(CodexSessionConsolidation.read(at: marker, primary: primary))
        let suite = "quota-consolidation-retirement-" + UUID().uuidString
        let defaults = UserDefaults(suiteName: suite)!; defer { defaults.removePersistentDomain(forName: suite) }
        CodexSessionConsolidationHistory(defaults: defaults, primary: primary).observe(complete)
        defaults.set(try JSONEncoder().encode([primary, source]), forKey: "local.quotapie.codex-desktop-profiles.v1")
        for corrupt in [false, true] {
            if corrupt { try Data("unreadable completion".utf8).write(to: marker) }
            else { try FileManager.default.removeItem(at: marker) }
            let history = CodexSessionConsolidationHistory(defaults: UserDefaults(suiteName: suite), primary: primary)
            let reader = { CodexSessionConsolidation.read(at: marker, primary: primary) }
            let model = CodexProfilesModel(defaults: defaults, consolidation: reader, activity: { nil }, history: history)
            XCTAssertTrue(history.contains(source)); XCTAssertEqual(model.automaticRestorationProfiles, [primary])
            XCTAssertTrue(model.requiresConsolidationVerification(source)); XCTAssertFalse(model.allowsAccountLogin(source))
            let launcher = CodexProfileLauncher(consolidation: reader, activity: { nil }, history: history)
            for intent: CodexProfileLaunchIntent in [.work, .accountLogin] {
                let blocked = expectation(description: "restart cannot revive retired session root")
                launcher.open(source, appURL: root.appendingPathComponent("nonexistent.app"), intent: intent) { result in
                    if case .failure(let error) = result { XCTAssertEqual(error as? ProfileError, .consolidationUnavailable) }
                    else { XCTFail("A retired root must remain blocked across restarts") }
                    blocked.fulfill()
                }
                wait(for: [blocked], timeout: 1)
            }
        }
    }
    func testUnreadableRetirementRecordHoldsSeparateLaunchesButKeepsPrimaryAvailable() throws {
        let (root, primary, source) = try fixture(); defer { try? FileManager.default.removeItem(at: root) }
        let suite = "quota-consolidation-retirement-invalid-" + UUID().uuidString
        let defaults = UserDefaults(suiteName: suite)!; defer { defaults.removePersistentDomain(forName: suite) }
        defaults.set(Data("not a retirement record".utf8), forKey: "local.quotapie.session-consolidation-retirements.v1")
        let history = CodexSessionConsolidationHistory(defaults: defaults, primary: primary)
        XCTAssertTrue(history.requiresVerification(source)); XCTAssertFalse(history.requiresVerification(primary))
        let launcher = CodexProfileLauncher(consolidation: { nil }, activity: { nil }, history: history)
        let blocked = expectation(description: "invalid history does not authorize an old root")
        launcher.open(source, appURL: root.appendingPathComponent("nonexistent.app")) { result in
            if case .failure(let error) = result { XCTAssertEqual(error as? ProfileError, .consolidationUnavailable) }
            else { XCTFail("An unreadable retirement record cannot authorize a source launch") }
            blocked.fulfill()
        }
        wait(for: [blocked], timeout: 1)
    }
    func testRetiredStoreCannotBeReopenedByRegisteringANewAppDataOrHome() throws {
        let (root, primary, source) = try fixture(); defer { try? FileManager.default.removeItem(at: root) }
        let marker = root.appendingPathComponent("marker.json")
        try write(marker, primary: primary, source: source)
        let complete = try XCTUnwrap(CodexSessionConsolidation.read(at: marker, primary: primary))
        let suite = "quota-consolidation-retirement-rebind-" + UUID().uuidString
        let defaults = UserDefaults(suiteName: suite)!; defer { defaults.removePersistentDomain(forName: suite) }
        CodexSessionConsolidationHistory(defaults: defaults, primary: primary).observe(complete)
        let history = CodexSessionConsolidationHistory(defaults: defaults, primary: primary)
        let launcher = CodexProfileLauncher(consolidation: { complete }, activity: { nil }, history: history)
        let variants = [
            CodexDesktopProfile(id: "same-home", name: "Re-registered", codexHome: source.codexHome, appData: root.appendingPathComponent("new-app").path),
            CodexDesktopProfile(id: "same-app", name: "Re-registered", codexHome: root.appendingPathComponent("new-home").path, appData: source.appData),
            CodexDesktopProfile(id: "swapped", name: "Re-registered", codexHome: source.appData, appData: source.codexHome),
        ]
        for variant in variants {
            XCTAssertFalse(complete.completed(variant)); XCTAssertFalse(history.contains(variant))
            XCTAssertTrue(history.requiresVerification(variant))
            defaults.set(try JSONEncoder().encode([primary, variant]), forKey: "local.quotapie.codex-desktop-profiles.v1")
            let model = CodexProfilesModel(defaults: defaults, consolidation: { complete }, activity: { nil }, history: history)
            XCTAssertEqual(model.automaticRestorationProfiles, [primary]); XCTAssertFalse(model.allowsAccountLogin(variant))
            for intent: CodexProfileLaunchIntent in [.work, .accountLogin] {
                let blocked = expectation(description: "partial retirement path match blocks reopened store")
                launcher.open(variant, appURL: root.appendingPathComponent("nonexistent.app"), intent: intent) { result in
                    if case .failure(let error) = result { XCTAssertEqual(error as? ProfileError, .consolidationUnavailable) }
                    else { XCTFail("Changing one path must not revive a retired store") }
                    blocked.fulfill()
                }
                wait(for: [blocked], timeout: 1)
            }
        }
        XCTAssertFalse(history.requiresVerification(primary)); XCTAssertFalse(history.requiresVerification(source))
        XCTAssertEqual(try source.launchProfile(intent: .work, consolidation: complete, primary: primary), primary)
    }
    func testCollectorRetirementBeforeMarkerPublicationSurvivesMenuRestart() throws {
        let (root, primary, source) = try fixture(); defer { try? FileManager.default.removeItem(at: root) }
        let file = root.appendingPathComponent("session-consolidation-retirements.json")
        let suite = "quota-consolidation-collector-retirement-" + UUID().uuidString
        let defaults = UserDefaults(suiteName: suite)!; defer { defaults.removePersistentDomain(forName: suite) }
        let history = CodexSessionConsolidationHistory(defaults: defaults, primary: primary, retirementsURL: file)
        XCTAssertFalse(history.contains(source))
        let value: [String: Any] = ["version": 1, "sources": [["codexHome": source.codexHome, "appData": source.appData]]]
        try JSONSerialization.data(withJSONObject: value).write(to: file)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
        XCTAssertTrue(history.contains(source), "Read the collector's denial even before a completion marker exists")
        let restarted = CodexSessionConsolidationHistory(defaults: UserDefaults(suiteName: suite), primary: primary, retirementsURL: file)
        XCTAssertTrue(restarted.contains(source)); XCTAssertFalse(restarted.requiresVerification(primary))
        let launcher = CodexProfileLauncher(consolidation: { nil }, activity: { nil }, history: restarted)
        let denied = expectation(description: "collector retired source never launches without verified routing")
        launcher.open(source, appURL: root.appendingPathComponent("missing.app")) { result in
            if case .failure(let error) = result { XCTAssertEqual(error as? ProfileError, .consolidationUnavailable) }
            else { XCTFail("Retirement alone must never authorize a launch") }
            denied.fulfill()
        }
        wait(for: [denied], timeout: 1)
        try FileManager.default.removeItem(at: file)
        let afterLoss = CodexSessionConsolidationHistory(defaults: UserDefaults(suiteName: suite), primary: primary, retirementsURL: file)
        XCTAssertTrue(afterLoss.contains(source), "Persist the independently observed denial across file loss and restart")
        XCTAssertFalse(afterLoss.requiresVerification(primary))
    }
    func testInvalidCollectorRetirementNeverAuthorizesSeparateStoreLaunches() throws {
        let (root, primary, source) = try fixture(); defer { try? FileManager.default.removeItem(at: root) }
        let file = root.appendingPathComponent("retirements.json")
        let good: [String: Any] = ["version": 1, "sources": [["codexHome": source.codexHome, "appData": source.appData]]]
        let badValues: [[String: Any]] = [
            ["version": 2, "sources": []],
            ["version": 1, "sources": [["codexHome": "relative", "appData": source.appData]]],
            ["version": 1, "sources": [["codexHome": source.codexHome + "/../source-home", "appData": source.appData]]],
            ["version": 1, "sources": [["codexHome": source.codexHome, "appData": source.codexHome]]],
            ["version": 1, "sources": [["codexHome": primary.codexHome, "appData": source.appData]]],
            ["version": 1, "sources": [["codexHome": "/" + String(repeating: "x", count: 4097), "appData": source.appData]]],
        ]
        for value in badValues {
            try JSONSerialization.data(withJSONObject: value).write(to: file)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
            let history = CodexSessionConsolidationHistory(primary: primary, retirementsURL: file)
            XCTAssertTrue(history.requiresVerification(source)); XCTAssertFalse(history.requiresVerification(primary))
        }
        try JSONSerialization.data(withJSONObject: good).write(to: file)
        try FileManager.default.setAttributes([.posixPermissions: 0o666], ofItemAtPath: file.path)
        XCTAssertTrue(CodexSessionConsolidationHistory(primary: primary, retirementsURL: file).requiresVerification(source))
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
        let alias = root.appendingPathComponent("alias.json")
        try FileManager.default.createSymbolicLink(at: alias, withDestinationURL: file)
        XCTAssertTrue(CodexSessionConsolidationHistory(primary: primary, retirementsURL: alias).requiresVerification(source))
        try Data(repeating: 32, count: 65 * 1024).write(to: file)
        XCTAssertTrue(CodexSessionConsolidationHistory(primary: primary, retirementsURL: file).requiresVerification(source))
    }
    func testConsolidationRequestUsesExactAuthenticatedSourceContract() throws {
        let (root, _, source) = try fixture(); defer { try? FileManager.default.removeItem(at: root) }
        let capture = root.appendingPathComponent("request.json"), server = Process(), output = Pipe()
        server.executableURL = URL(fileURLWithPath: "/usr/bin/python3")
        server.arguments = ["-u", "-c", """
        import http.server,json,pathlib,sys
        class Handler(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                body=json.loads(self.rfile.read(int(self.headers['content-length'])))
                pathlib.Path(sys.argv[1]).write_text(json.dumps({'path':self.path,'token':self.headers.get('x-quotapie-action-token'),'body':body}))
                payload=b'{"state":"waiting-for-source-exit","reason":"source-active"}'
                self.send_response(202);self.send_header('Content-Length',str(len(payload)));self.end_headers();self.wfile.write(payload)
            def log_message(self,*args):pass
        server=http.server.HTTPServer(('127.0.0.1',0),Handler)
        print(server.server_port,flush=True);server.serve_forever()
        """, capture.path]
        server.standardOutput = output; server.standardError = FileHandle.nullDevice
        try server.run(); defer { if server.isRunning { server.terminate(); server.waitUntilExit() } }
        let port = try XCTUnwrap(String(data: output.fileHandleForReading.availableData, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines))
        let client = try StatusClient(environment: ["QUOTAPIE_API_URL": "http://127.0.0.1:\(port)"])
        let replied = expectation(description: "consolidation queued")
        client.consolidateSessions(source, actionToken: "fixture-token") { result in
            do { XCTAssertEqual(try result.get().state, "waiting-for-source-exit") } catch { XCTFail(String(describing: error)) }
            replied.fulfill()
        }
        wait(for: [replied], timeout: 5)
        let request = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: capture)) as? [String: Any])
        XCTAssertEqual(request["path"] as? String, "/api/session-consolidation"); XCTAssertEqual(request["token"] as? String, "fixture-token")
        XCTAssertEqual(request["body"] as? [String: [String: String]], ["source": ["codexHome": source.codexHome, "appData": source.appData]])
    }
}
