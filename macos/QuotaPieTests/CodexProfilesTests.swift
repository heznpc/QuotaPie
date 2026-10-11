import XCTest
import AppKit
@testable import QuotaPie

final class CodexProfilesTests: XCTestCase {
    func testFailedIsolationVerificationRetiresOnlyTheNewAttempt() throws {
        guard let path = ProcessInfo.processInfo.environment["QUOTAPIE_TEST_PROFILE_APP"] else { throw XCTSkip("Fixture required") }
        let target = URL(fileURLWithPath: path)
        let fixtureID = try XCTUnwrap(Bundle(url: target)?.bundleIdentifier)
        guard fixtureID.hasPrefix("local.quotapie.profile-fixture.") else { throw ProfileError.appMissing }
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("quota-failed-restore-" + UUID().uuidString)
        let profiles = ["primary", "second"].map { CodexDesktopProfile(id: $0, name: $0,
            codexHome: root.appendingPathComponent($0 + "-home").path, appData: root.appendingPathComponent($0 + "-data").path) }
        func instances() -> [NSRunningApplication] { NSWorkspace.shared.runningApplications.filter { $0.bundleIdentifier == fixtureID } }
        func settle(_ seconds: Double) {
            let done = expectation(description: "settle failed attempt")
            DispatchQueue.main.asyncAfter(deadline: .now() + seconds) { done.fulfill() }
            wait(for: [done], timeout: seconds + 5)
        }
        defer { instances().forEach { $0.terminate() }; settle(2); try? FileManager.default.removeItem(at: root) }
        let launcher = CodexProfileLauncher()
        let primaryReady = expectation(description: "primary open")
        launcher.open(profiles[0], appURL: target) { result in
            if case .failure(let error) = result { XCTFail(error.localizedDescription) }
            primaryReady.fulfill()
        }
        wait(for: [primaryReady], timeout: 15)
        let primary = try XCTUnwrap(instances().first)
        // Simulate a vendor app returning the primary identity for a B launch.
        let misconfigured = CodexProfileLauncher(readIdentity: { _ in
            .init(codexHome: profiles[0].codexHome, appData: profiles[0].appData)
        })
        for _ in 0..<2 {
            let failed = expectation(description: "misconfigured launch rejected")
            misconfigured.open(profiles[1], appURL: target) { result in
                if case .success = result { XCTFail("Unverified profile was reported as launched") }
                failed.fulfill()
            }
            wait(for: [failed], timeout: 15); settle(2)
            XCTAssertFalse(primary.isTerminated)
            XCTAssertEqual(instances().map(\.processIdentifier), [primary.processIdentifier])
        }
    }

    func testDockShortcutRetainsBWithoutAnyLaunchEnvironmentAndDoesNotCreateAnotherA() throws {
        guard let path = ProcessInfo.processInfo.environment["QUOTAPIE_TEST_PROFILE_APP"],
              let source = ProcessInfo.processInfo.environment["QUOTAPIE_TEST_SHORTCUT_SOURCE"] else {
            throw XCTSkip("Dedicated launcher fixture required")
        }
        let target = URL(fileURLWithPath: path)
        let fixtureID = try XCTUnwrap(Bundle(url: target)?.bundleIdentifier)
        guard fixtureID.hasPrefix("local.quotapie.profile-fixture.") else { throw ProfileError.appMissing }
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("quota-shortcut-test-" + UUID().uuidString)
        let a = CodexDesktopProfile(id: "primary", name: "A", codexHome: root.appendingPathComponent("a-home").path,
                                   appData: root.appendingPathComponent("a-data").path)
        let b = CodexDesktopProfile(id: "second", name: "B", codexHome: root.appendingPathComponent("b-home").path,
                                   appData: root.appendingPathComponent("b-data").path)
        func instances() -> [NSRunningApplication] { NSWorkspace.shared.runningApplications.filter { $0.bundleIdentifier == fixtureID } }
        func settle(_ seconds: Double) {
            let done = expectation(description: "settle shortcuts")
            DispatchQueue.main.asyncAfter(deadline: .now() + seconds) { done.fulfill() }
            wait(for: [done], timeout: seconds + 5)
        }
        defer {
            instances().forEach { $0.terminate() }; settle(2)
            try? FileManager.default.removeItem(at: root)
        }
        let launcher = CodexProfileLauncher()
        let launchedA = expectation(description: "open A")
        launcher.open(a, appURL: target) { result in
            if case .failure(let error) = result { XCTFail(error.localizedDescription) }
            launchedA.fulfill()
        }
        wait(for: [launchedA], timeout: 15)
        let shortcut = try CodexProfileShortcut.install(b, target: target, root: root.appendingPathComponent("shortcuts"),
                                                       source: URL(fileURLWithPath: source))
        var renamed = b; renamed.name = "Renamed B"
        _ = try CodexProfileShortcut.install(renamed, target: target, root: root.appendingPathComponent("shortcuts"),
                                            source: URL(fileURLWithPath: source))
        let manifest = shortcut.appendingPathComponent("Contents/Info.plist")
        let before = try FileManager.default.attributesOfItem(atPath: manifest.path)[.systemFileNumber] as? NSNumber
        _ = try CodexProfileShortcut.install(renamed, target: target, root: root.appendingPathComponent("shortcuts"),
                                            source: URL(fileURLWithPath: source))
        XCTAssertEqual(before, try FileManager.default.attributesOfItem(atPath: manifest.path)[.systemFileNumber] as? NSNumber,
                       "An unchanged launcher must not be replaced on every monitor poll")
        for _ in 0..<2 {
            let request = expectation(description: "open fixed B Dock item")
            let configuration = NSWorkspace.OpenConfiguration()
            configuration.createsNewApplicationInstance = true
            // Exactly a Dock/login open: no profile arguments or environment.
            NSWorkspace.shared.openApplication(at: shortcut, configuration: configuration) { _, error in
                if let error { XCTFail(error.localizedDescription) }
                request.fulfill()
            }
            wait(for: [request], timeout: 10); settle(4)
            XCTAssertEqual(instances().filter { CodexProcessIdentity.read(pid: $0.processIdentifier)?.matches(a) == true }.count, 1)
            let secondary = instances().filter { CodexProcessIdentity.read(pid: $0.processIdentifier)?.matches(b) == true }
            XCTAssertEqual(secondary.count, 1)
            let focus = expectation(description: "focus B already running")
            NSWorkspace.shared.openApplication(at: shortcut, configuration: configuration) { _, error in
                if let error { XCTFail(error.localizedDescription) }
                focus.fulfill()
            }
            wait(for: [focus], timeout: 10); settle(2)
            XCTAssertEqual(instances().count, 2)
            XCTAssertFalse(NSWorkspace.shared.runningApplications.contains {
                $0.bundleIdentifier == CodexProfileShortcut.prefix + b.id && $0.bundleURL == shortcut
            }, "A completed focus request must not leave a launcher running")
            XCTAssertTrue(secondary.first?.terminate() == true)
            settle(2)
        }
    }

    func testPersistedLoginRestoreSurvivesMeterRestartWithoutReopeningManuallyQuitB() throws {
        guard let path = ProcessInfo.processInfo.environment["QUOTAPIE_TEST_PROFILE_APP"] else { throw XCTSkip("Fixture required") }
        let target = URL(fileURLWithPath: path)
        let fixtureID = try XCTUnwrap(Bundle(url: target)?.bundleIdentifier)
        guard fixtureID.hasPrefix("local.quotapie.profile-fixture.") else { throw ProfileError.appMissing }
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("quota-login-test-" + UUID().uuidString)
        let profiles = ["primary", "second"].map { CodexDesktopProfile(id: $0, name: $0,
            codexHome: root.appendingPathComponent($0 + "-home").path, appData: root.appendingPathComponent($0 + "-data").path) }
        let suite = "quota-login-test-" + UUID().uuidString
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defaults.set(["boot": "previous-boot", "pending": []], forKey: "local.quotapie.profile-recovery.login.v1")
        func instances() -> [NSRunningApplication] { NSWorkspace.shared.runningApplications.filter { $0.bundleIdentifier == fixtureID } }
        func settle(_ seconds: Double) {
            let done = expectation(description: "settle login")
            DispatchQueue.main.asyncAfter(deadline: .now() + seconds) { done.fulfill() }
            wait(for: [done], timeout: seconds + 5)
        }
        let monitor = CodexProfileUpdateMonitor(profiles: { profiles }, appURL: { target }, defaults: defaults)
        let restarted = CodexProfileUpdateMonitor(profiles: { profiles }, appURL: { target }, defaults: defaults)
        defer {
            monitor.stop(); restarted.stop(); instances().forEach { $0.terminate() }; settle(2)
            defaults.removePersistentDomain(forName: suite); try? FileManager.default.removeItem(at: root)
        }
        monitor.start(); settle(5)
        let b = try XCTUnwrap(instances().first { CodexProcessIdentity.read(pid: $0.processIdentifier)?.matches(profiles[1]) == true })
        monitor.stop(); XCTAssertTrue(b.terminate()); settle(2)
        restarted.start(); settle(4)
        XCTAssertFalse(instances().contains { CodexProcessIdentity.read(pid: $0.processIdentifier)?.matches(profiles[1]) == true })
    }

    func testUpdateMonitorRestoresSecondProfileWithoutStoppingPrimary() throws {
        guard let path = ProcessInfo.processInfo.environment["QUOTAPIE_TEST_PROFILE_APP"] else {
            throw XCTSkip("Dedicated app fixture required")
        }
        let url = URL(fileURLWithPath: path)
        let fixtureID = try XCTUnwrap(Bundle(url: url)?.bundleIdentifier)
        guard fixtureID.hasPrefix("local.quotapie.profile-fixture.") else { throw ProfileError.appMissing }
        let executable = try XCTUnwrap(Bundle(url: url)?.executableURL)
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("quotapie-update-" + UUID().uuidString)
        let profiles = ["primary", "second"].map {
            CodexDesktopProfile(id: $0, name: $0, codexHome: root.appendingPathComponent($0 + "-home").path,
                                appData: root.appendingPathComponent($0 + "-data").path)
        }
        func instances() -> [NSRunningApplication] {
            NSWorkspace.shared.runningApplications.filter { $0.bundleIdentifier == fixtureID }
        }
        func settle(_ seconds: Double) {
            let done = expectation(description: "settle fixture")
            DispatchQueue.main.asyncAfter(deadline: .now() + seconds) { done.fulfill() }
            wait(for: [done], timeout: seconds + 5)
        }
        XCTAssertTrue(instances().isEmpty)
        guard instances().isEmpty else { return }
        let monitor = CodexProfileUpdateMonitor(profiles: { profiles }, appURL: { url })
        defer {
            monitor.stop()
            instances().forEach { $0.terminate() }
            settle(2)
        }
        let launcher = CodexProfileLauncher()
        for profile in profiles {
            let done = expectation(description: "launch profile")
            launcher.open(profile, appURL: url) { result in
                if case .failure(let error) = result { XCTFail(error.localizedDescription) }
                done.fulfill()
            }
            wait(for: [done], timeout: 15)
        }
        let main = try XCTUnwrap(instances().first { CodexProcessIdentity.read(pid: $0.processIdentifier)?.matches(profiles[0]) == true })
        let second = try XCTUnwrap(instances().first { CodexProcessIdentity.read(pid: $0.processIdentifier)?.matches(profiles[1]) == true })
        monitor.start()
        // Simulate replacement on disk, then the updater reopening the second
        // process with primary-profile settings. Only this dedicated fixture is touched.
        try FileManager.default.setAttributes([.modificationDate: Date().addingTimeInterval(10)], ofItemAtPath: executable.path)
        settle(0.5)
        XCTAssertTrue(second.terminate())
        settle(0.3)
        let config = NSWorkspace.OpenConfiguration()
        config.createsNewApplicationInstance = true
        config.environment = profiles[0].environment
        config.arguments = profiles[0].arguments
        let launched = expectation(description: "updater misconfigured launch")
        NSWorkspace.shared.openApplication(at: url, configuration: config) { _, error in
            if let error { XCTFail(error.localizedDescription) }
            launched.fulfill()
        }
        wait(for: [launched], timeout: 15)
        settle(8)
        XCTAssertFalse(main.isTerminated)
        XCTAssertEqual(instances().filter { CodexProcessIdentity.read(pid: $0.processIdentifier)?.matches(profiles[0]) == true }.count, 1)
        XCTAssertEqual(instances().filter { CodexProcessIdentity.read(pid: $0.processIdentifier)?.matches(profiles[1]) == true }.count, 1)
        XCTAssertEqual(instances().count, 2)
    }

    func testAccountOpeningUsesUniqueCollectorBinding() {
        var main = CodexDesktopProfile.primary
        main.collectionAccount = "default"
        let second = CodexDesktopProfile(id: "second", name: main.name, codexHome: "/tmp/account-home",
                                         appData: "/tmp/account-app", collectionAccount: "second-collector")
        XCTAssertEqual(CodexDesktopProfile.forAccount("codex/default", in: [second, main]), main)
        XCTAssertEqual(CodexDesktopProfile.forAccount("codex/second-collector", in: [main, second]), second)
        XCTAssertNil(CodexDesktopProfile.forAccount("claude/default", in: [main, second]))
        XCTAssertNil(CodexDesktopProfile.forAccount("codex/unknown", in: [main, second]))
        var unlinked = main; unlinked.collectionAccount = nil
        XCTAssertNil(CodexDesktopProfile.forAccount("codex/default", in: [unlinked]))
        var duplicate = second; duplicate.collectionAccount = "default"
        XCTAssertNil(CodexDesktopProfile.forAccount("codex/default", in: [main, duplicate]))
    }

    private func bytes(args: [String], environment: [String]) -> [UInt8] {
        let count = UInt32(args.count)
        var result = (0..<4).map { UInt8((count >> ($0 * 8)) & 255) }
        result += Array("/app/executable".utf8) + [0, 0, 0]
        for item in args + environment { result += Array(item.utf8) + [0] }
        return result
    }
    func testReadsIdentityWithoutRetainingUnrelatedEnvironment() throws {
        let profile = CodexDesktopProfile(id: "test", name: "Test", codexHome: "/tmp/test home", appData: "/tmp/test data")
        let identity = try XCTUnwrap(CodexProcessIdentity.parse(bytes(args: ["app", "--user-data-dir=/tmp/test data"],
            environment: ["CODEX_HOME=/tmp/test home", "CODEX_ELECTRON_USER_DATA_PATH=/tmp/other", "SECRET=do-not-retain"])))
        XCTAssertTrue(identity.matches(profile))
        XCTAssertFalse(identity.matches(.primary))
        XCTAssertEqual(profile.environment["CODEX_HOME"], CodexDesktopProfile.canonical("/tmp/test home"))
        XCTAssertEqual(profile.arguments, ["--user-data-dir=" + CodexDesktopProfile.canonical("/tmp/test data")])
    }
    func testDefaultAndExplicitProfilesMatchInBothOrders() throws {
        let primary = CodexDesktopProfile.primary
        let plain = try XCTUnwrap(CodexProcessIdentity.parse(bytes(args: ["app"], environment: [])))
        XCTAssertTrue(plain.matches(primary))
        let explicit = try XCTUnwrap(CodexProcessIdentity.parse(bytes(args: ["app"] + primary.arguments,
            environment: primary.environment.map { "\($0.key)=\($0.value)" })))
        XCTAssertTrue(explicit.matches(primary))
        XCTAssertNil(CodexProcessIdentity.parse([0, 0, 0, 0]))
    }
    func testRetainedArgumentsDoNotHideLostIsolationEnvironment() throws {
        let profile = CodexDesktopProfile(id: "second", name: "Second", codexHome: "/tmp/second-home", appData: "/tmp/second-data")
        let raw = bytes(args: ["app"] + profile.arguments, environment: ["CODEX_HOME=" + profile.codexHome])
        XCTAssertTrue(try XCTUnwrap(CodexProcessIdentity.parse(raw)).matches(profile))
        let actual = try XCTUnwrap(CodexProcessIdentity.parse(raw, environmentOnly: true))
        XCTAssertFalse(actual.matches(profile))
        XCTAssertEqual(actual.appData, CodexDesktopProfile.canonical(CodexDesktopProfile.primary.appData))
    }
    func testRejectsSharedOrNestedFoldersIncludingAliases() throws {
        let first = CodexDesktopProfile(id: "one", name: "One", codexHome: "/tmp/a", appData: "/tmp/b")
        for path in ["/tmp/a", "/private/tmp/a", "/tmp/a/child", "/tmp"] {
            XCTAssertThrowsError(try CodexDesktopProfile.validate([first,
                CodexDesktopProfile(id: "two", name: "Two", codexHome: path, appData: "/tmp/c")]))
        }
        XCTAssertNoThrow(try CodexDesktopProfile.validate([first]))
    }
    func testRegistrationPersistsAndUnregisterPreservesFolders() throws {
        let suite = "quotapie-profile-test-" + UUID().uuidString
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let model = CodexProfilesModel(defaults: defaults)
        model.add(name: "Work", home: "/tmp/quotapie-test-home", data: "/tmp/quotapie-test-data")
        XCTAssertEqual(model.profiles.count, 2)
        let reloaded = CodexProfilesModel(defaults: defaults)
        XCTAssertEqual(reloaded.profiles, model.profiles)
        reloaded.remove(reloaded.profiles[1])
        XCTAssertEqual(reloaded.profiles.count, 1)
    }

    /// Opt-in real NSWorkspace launch check, using only a dedicated test bundle.
    /// It never opens or terminates the user's Codex app.
    func testLaunchBothOrders() throws {
        guard let path = ProcessInfo.processInfo.environment["QUOTAPIE_TEST_PROFILE_APP"] else {
            throw XCTSkip("Dedicated app fixture required")
        }
        let appURL = URL(fileURLWithPath: path)
        let fixtureID = try XCTUnwrap(Bundle(url: appURL)?.bundleIdentifier)
        XCTAssertTrue(fixtureID.hasPrefix("local.quotapie.profile-fixture."))
        guard fixtureID.hasPrefix("local.quotapie.profile-fixture.") else { return }
        // Inspect Mach-O deployment target before Launch Services can show an alert.
        let executable = try XCTUnwrap(Bundle(url: appURL)?.executableURL)
        let inspector = Process()
        inspector.executableURL = URL(fileURLWithPath: "/usr/bin/xcrun")
        inspector.arguments = ["vtool", "-show-build", executable.path]
        let output = Pipe()
        inspector.standardOutput = output
        try inspector.run()
        let metadata = String(decoding: output.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
        inspector.waitUntilExit()
        let targets = metadata.split(separator: "\n").compactMap { line -> String? in
            let fields = line.split(whereSeparator: \.isWhitespace)
            return fields.count == 2 && fields[0] == "minos" ? String(fields[1]) : nil
        }
        guard inspector.terminationStatus == 0, !targets.isEmpty else {
            throw NSError(domain: "FixturePreflight", code: 1)
        }
        let os = ProcessInfo.processInfo.operatingSystemVersion
        let host = "\(os.majorVersion).\(os.minorVersion).\(os.patchVersion)"
        guard targets.allSatisfy({ $0.compare(host, options: .numeric) != .orderedDescending }) else {
            throw NSError(domain: "FixtureRequiresNewerMacOS", code: 2)
        }
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("quotapie-order-" + UUID().uuidString)
        let profiles = ["one", "two"].map {
            CodexDesktopProfile(id: $0, name: $0, codexHome: root.appendingPathComponent($0 + "-home").path,
                                appData: root.appendingPathComponent($0 + "-data").path)
        }
        let launcher = CodexProfileLauncher()
        func instances() -> [NSRunningApplication] {
            NSWorkspace.shared.runningApplications.filter { $0.bundleIdentifier == fixtureID }
        }
        XCTAssertTrue(instances().isEmpty)
        guard instances().isEmpty else { return }
        defer {
            for app in instances() { app.terminate() }
        }
        for order in [profiles, profiles.reversed().map { $0 }] {
            for profile in order {
                let done = expectation(description: "launch " + profile.id)
                var launchError: Error?
                launcher.open(profile, appURL: appURL) { result in
                    if case .failure(let error) = result { launchError = error }
                    done.fulfill()
                }
                wait(for: [done], timeout: 15)
                if let launchError { throw launchError }
            }
            XCTAssertEqual(instances().count, 2)
            for profile in profiles {
                XCTAssertEqual(instances().filter { CodexProcessIdentity.read(pid: $0.processIdentifier)?.matches(profile) == true }.count, 1)
                let ready = URL(fileURLWithPath: profile.codexHome).appendingPathComponent("ready")
                let readyWait = expectation(description: "fixture ready")
                DispatchQueue.main.asyncAfter(deadline: .now() + 1) { readyWait.fulfill() }
                wait(for: [readyWait], timeout: 3)
                XCTAssertTrue(FileManager.default.fileExists(atPath: ready.path))
            }
            let before = Set(instances().map(\.processIdentifier))
            let focused = expectation(description: "focus existing")
            launcher.open(order[0], appURL: appURL) { result in
                if case .failure(let error) = result { XCTFail(error.localizedDescription) }
                focused.fulfill()
            }
            wait(for: [focused], timeout: 10)
            XCTAssertEqual(Set(instances().map(\.processIdentifier)), before)
            let owned = instances()
            owned.forEach { $0.terminate() }
            let stopped = expectation(description: "fixtures stop")
            DispatchQueue.main.asyncAfter(deadline: .now() + 2) { stopped.fulfill() }
            wait(for: [stopped], timeout: 4)
            XCTAssertTrue(owned.allSatisfy(\.isTerminated))
        }
    }
}
