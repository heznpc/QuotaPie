import XCTest
import AppKit
@testable import QuotaPie

final class CodexProfilesTests: XCTestCase {
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
        XCTAssertEqual(Bundle(url: appURL)?.bundleIdentifier, "local.quotapie.profile-fixture")
        guard Bundle(url: appURL)?.bundleIdentifier == "local.quotapie.profile-fixture" else { return }
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
            NSWorkspace.shared.runningApplications.filter { $0.bundleIdentifier == "local.quotapie.profile-fixture" }
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
