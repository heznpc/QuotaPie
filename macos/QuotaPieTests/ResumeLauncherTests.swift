import Foundation
import XCTest
@testable import QuotaPie

final class ResumeLauncherTests: XCTestCase {
    private var root: URL!
    private var cwd: URL!
    private var executable: URL!
    private var launcher: ResumeLauncher!

    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory
            .appendingPathComponent("quotapie-launcher-tests-\(UUID().uuidString)", isDirectory: true)
        cwd = root.appendingPathComponent("project", isDirectory: true)
        executable = root.appendingPathComponent("codex")
        try FileManager.default.createDirectory(at: cwd, withIntermediateDirectories: true)
        XCTAssertTrue(FileManager.default.createFile(
            atPath: executable.path,
            contents: Data("#!/bin/sh\nexit 0\n".utf8),
            attributes: [.posixPermissions: NSNumber(value: 0o700)]
        ))
        launcher = ResumeLauncher(
            fileManager: .default,
            launchersDirectory: root.appendingPathComponent("launchers", isDirectory: true)
        )
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
    }

    func testAcceptsOnlyExactCodexPlan() throws {
        let plan = validCodexPlan()
        let validated = try launcher.validate(plan, expectedProvider: "codex")
        XCTAssertEqual(validated.arguments, plan.arguments)
        XCTAssertEqual(validated.environment, plan.environment)

        XCTAssertThrowsError(try launcher.validate(plan, expectedProvider: "claude"))
        XCTAssertThrowsError(try launcher.validate(
            ResumePlan(
                executable: executable.path,
                arguments: plan.arguments + ["continue this prompt"],
                environment: plan.environment,
                workingDirectory: cwd.path
            ),
            expectedProvider: "codex"
        ))
        XCTAssertThrowsError(try launcher.validate(
            ResumePlan(
                executable: executable.path,
                arguments: plan.arguments,
                environment: [:],
                workingDirectory: cwd.path
            ),
            expectedProvider: "codex"
        ))
        XCTAssertThrowsError(try launcher.validate(
            ResumePlan(
                executable: executable.path,
                arguments: ["--continue"],
                environment: plan.environment,
                workingDirectory: cwd.path
            ),
            expectedProvider: "codex"
        ))
    }

    func testShellQuoteKeepsEveryArgumentLiteral() {
        XCTAssertEqual(ResumeLauncher.shellQuote("plain"), "'plain'")
        XCTAssertEqual(ResumeLauncher.shellQuote("a b'c;$()"), "'a b'\"'\"'c;$()'")
    }

    func testClaudeLauncherPreservesDefaultAndCustomProfilesWithoutInheritedCredentials() throws {
        let claude = root.appendingPathComponent("claude")
        let output = root.appendingPathComponent("claude-env.txt")
        let source = """
        #!/bin/zsh
        printf '%s\\n' "${CLAUDE_CONFIG_DIR-unset}" "${CLAUDE_SECURESTORAGE_CONFIG_DIR-unset}" \\
          "${CLAUDE_CODE_OAUTH_TOKEN-unset}" "${ANTHROPIC_API_KEY-unset}" \\
          "${ANTHROPIC_AUTH_TOKEN-unset}" "${ANTHROPIC_BASE_URL-unset}" "$@" > \(ResumeLauncher.shellQuote(output.path))
        """ + "\n"
        XCTAssertTrue(FileManager.default.createFile(atPath: claude.path, contents: Data(source.utf8),
            attributes: [.posixPermissions: NSNumber(value: 0o700)]))
        let sessionID = "11111111-1111-4111-8111-111111111111"
        let customProfile = root.appendingPathComponent("profile").path
        for environment in [[:], ["CLAUDE_CONFIG_DIR": customProfile]] {
            let plan = ResumePlan(executable: claude.path, arguments: ["--resume", sessionID],
                environment: environment, workingDirectory: cwd.path)
            let files = try launcher.makeLauncher(for: launcher.validate(plan, expectedProvider: "claude"))
            let process = Process()
            process.executableURL = URL(fileURLWithPath: "/bin/zsh")
            process.arguments = [files.launcherURL.path]
            var inherited = ProcessInfo.processInfo.environment
            for key in ["CLAUDE_CONFIG_DIR", "CLAUDE_SECURESTORAGE_CONFIG_DIR", "CLAUDE_CODE_OAUTH_TOKEN",
                        "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"] {
                inherited[key] = "unrelated-profile-override"
            }
            process.environment = inherited
            try process.run()
            process.waitUntilExit()
            XCTAssertEqual(process.terminationStatus, 0)
            let lines = try String(contentsOf: output, encoding: .utf8).split(separator: "\n").map(String.init)
            XCTAssertEqual(lines, [environment["CLAUDE_CONFIG_DIR"] ?? "unset",
                "unset", "unset", "unset", "unset", "unset", "--resume", sessionID])
        }
        XCTAssertThrowsError(try launcher.validate(
            ResumePlan(executable: claude.path, arguments: ["--resume", sessionID],
                environment: ["ANTHROPIC_API_KEY": "/unrelated"], workingDirectory: cwd.path),
            expectedProvider: "claude"
        ))
    }

    func testOneShotLauncherRunsExactArgumentVectorAndWritesReceipt() throws {
        let output = root.appendingPathComponent("argv.txt")
        let source = """
        #!/bin/zsh
        printf '%s\\n' "$CODEX_HOME" "$@" > \(ResumeLauncher.shellQuote(output.path))
        """ + "\n"
        try Data(source.utf8).write(to: executable)
        try FileManager.default.setAttributes(
            [.posixPermissions: NSNumber(value: 0o700)],
            ofItemAtPath: executable.path
        )

        let files = try launcher.makeLauncher(
            for: launcher.validate(validCodexPlan(), expectedProvider: "codex")
        )
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/zsh")
        process.arguments = [files.launcherURL.path]
        try process.run()
        process.waitUntilExit()

        XCTAssertEqual(process.terminationStatus, 0)
        XCTAssertFalse(FileManager.default.fileExists(atPath: files.launcherURL.path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: files.receiptURL.path))
        let lines = try String(contentsOf: output, encoding: .utf8).split(separator: "\n").map(String.init)
        XCTAssertEqual(lines, [
            root.appendingPathComponent("profile").path,
            "resume",
            "-C",
            cwd.path,
            "11111111-1111-4111-8111-111111111111",
        ])
    }

    func testInitRemovesOnlyStaleUUIDLauncherFiles() throws {
        let directory = root.appendingPathComponent("stale-launchers", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let stale = directory.appendingPathComponent("\(UUID().uuidString).command")
        let fresh = directory.appendingPathComponent("\(UUID().uuidString).receipt")
        let unrelated = directory.appendingPathComponent("keep.command")
        for url in [stale, fresh, unrelated] {
            XCTAssertTrue(FileManager.default.createFile(atPath: url.path, contents: Data()))
        }
        try FileManager.default.setAttributes(
            [.modificationDate: Date().addingTimeInterval(-11 * 60)],
            ofItemAtPath: stale.path
        )
        _ = ResumeLauncher(fileManager: .default, launchersDirectory: directory)
        XCTAssertFalse(FileManager.default.fileExists(atPath: stale.path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: fresh.path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: unrelated.path))
    }

    private func validCodexPlan() -> ResumePlan {
        ResumePlan(
            executable: executable.path,
            arguments: [
                "resume",
                "-C",
                cwd.path,
                "11111111-1111-4111-8111-111111111111",
            ],
            environment: ["CODEX_HOME": root.appendingPathComponent("profile").path],
            workingDirectory: cwd.path
        )
    }
}
