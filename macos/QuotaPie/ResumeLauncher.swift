import AppKit
import Darwin
import Foundation

enum ResumeLauncherError: LocalizedError {
    case executableNotAllowed
    case executableNotFound
    case argumentsNotAllowed
    case environmentNotAllowed
    case workingDirectoryNotAllowed
    case launcherCreationFailed(String)
    case terminalUnavailable
    case terminalOpenFailed(String)
    case launcherStartUnconfirmed

    var errorDescription: String? {
        switch self {
        case .executableNotAllowed: return Strings.t("resume.error.executableNotAllowed")
        case .executableNotFound: return Strings.t("resume.error.executableNotFound")
        case .argumentsNotAllowed: return Strings.t("resume.error.argumentsNotAllowed")
        case .environmentNotAllowed: return Strings.t("resume.error.environmentNotAllowed")
        case .workingDirectoryNotAllowed: return Strings.t("resume.error.workingDirectoryNotAllowed")
        case .launcherCreationFailed(let detail):
            return Strings.t("resume.error.launcherCreationFailed", detail)
        case .terminalUnavailable: return Strings.t("resume.error.terminalUnavailable")
        case .terminalOpenFailed(let detail): return Strings.t("resume.error.terminalOpenFailed", detail)
        case .launcherStartUnconfirmed: return Strings.t("resume.error.launcherStartUnconfirmed")
        }
    }
}

/// Crosses the one imperative AppKit boundary required by this feature:
/// opening a validated one-shot `.command` file in Terminal. The server never
/// supplies shell source, and no prompt or implicit "last session" flag is
/// accepted.
final class ResumeLauncher {
    struct ValidatedPlan {
        let executable: String
        let arguments: [String]
        let environment: [String: String]
        let workingDirectory: String
    }

    struct LauncherFiles {
        let launcherURL: URL
        let receiptURL: URL
        let temporaryURL: URL
    }

    private let fileManager: FileManager
    private let launchersDirectory: URL

    init(fileManager: FileManager = .default, launchersDirectory: URL? = nil) {
        self.fileManager = fileManager
        self.launchersDirectory = launchersDirectory ?? fileManager.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/QuotaPie/ResumeLaunchers", isDirectory: true)
        removeStaleLaunchers()
    }

    func openInTerminal(
        plan: ResumePlan,
        expectedProvider: String,
        completion: @escaping (Result<Void, Error>) -> Void
    ) {
        let files: LauncherFiles
        do {
            files = try makeLauncher(for: validate(plan, expectedProvider: expectedProvider))
        } catch {
            completion(.failure(error))
            return
        }

        let terminalURL = URL(fileURLWithPath: "/System/Applications/Utilities/Terminal.app", isDirectory: true)
        guard fileManager.fileExists(atPath: terminalURL.path) else {
            removeLauncherFiles(files)
            completion(.failure(ResumeLauncherError.terminalUnavailable))
            return
        }

        let configuration = NSWorkspace.OpenConfiguration()
        configuration.activates = true
        NSWorkspace.shared.open(
            [files.launcherURL],
            withApplicationAt: terminalURL,
            configuration: configuration
        ) { _, error in
            if let error {
                self.removeLauncherFiles(files)
                completion(.failure(ResumeLauncherError.terminalOpenFailed(error.localizedDescription)))
            } else {
                self.waitForLauncherStart(files: files, attemptsRemaining: 60, completion: completion)
            }
        }
    }

    func validate(_ plan: ResumePlan, expectedProvider: String) throws -> ValidatedPlan {
        let executableName = URL(fileURLWithPath: plan.executable).lastPathComponent
        let expectedExecutable: String
        switch expectedProvider {
        case "codex": expectedExecutable = "codex"
        case "claude": expectedExecutable = "claude"
        default: throw ResumeLauncherError.executableNotAllowed
        }
        guard executableName == expectedExecutable else {
            throw ResumeLauncherError.executableNotAllowed
        }

        guard NSString(string: plan.workingDirectory).isAbsolutePath,
              !plan.workingDirectory.contains("\0") else {
            throw ResumeLauncherError.workingDirectoryNotAllowed
        }
        var isDirectory: ObjCBool = false
        guard fileManager.fileExists(atPath: plan.workingDirectory, isDirectory: &isDirectory),
              isDirectory.boolValue else {
            throw ResumeLauncherError.workingDirectoryNotAllowed
        }

        let sessionID: String
        if executableName == "codex" {
            guard plan.arguments.count == 4,
                  plan.arguments[0] == "resume",
                  plan.arguments[1] == "-C",
                  plan.arguments[2] == plan.workingDirectory else {
                throw ResumeLauncherError.argumentsNotAllowed
            }
            sessionID = plan.arguments[3]
        } else {
            guard plan.arguments.count == 2,
                  plan.arguments[0] == "--resume" else {
                throw ResumeLauncherError.argumentsNotAllowed
            }
            sessionID = plan.arguments[1]
        }

        guard let uuid = UUID(uuidString: sessionID),
              uuid.uuidString.caseInsensitiveCompare(sessionID) == .orderedSame else {
            throw ResumeLauncherError.argumentsNotAllowed
        }

        let allowedEnvironment = executableName == "codex"
            ? Set(["CODEX_HOME"])
            : Set(["CLAUDE_CONFIG_DIR"])
        guard Set(plan.environment.keys) == allowedEnvironment,
              plan.environment.values.allSatisfy({
                  NSString(string: $0).isAbsolutePath && !$0.contains("\0")
              }) else {
            throw ResumeLauncherError.environmentNotAllowed
        }

        return ValidatedPlan(
            executable: try resolvedExecutable(plan.executable, expectedName: executableName),
            arguments: plan.arguments,
            environment: plan.environment,
            workingDirectory: plan.workingDirectory
        )
    }

    private func resolvedExecutable(_ executable: String, expectedName: String) throws -> String {
        let candidate: String?
        if executable.contains("/") {
            candidate = NSString(string: executable).isAbsolutePath ? executable : nil
        } else {
            var searchPaths = (ProcessInfo.processInfo.environment["PATH"] ?? "")
                .split(separator: ":")
                .map(String.init)
            searchPaths.append(contentsOf: ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"])
            candidate = searchPaths.lazy
                .map { URL(fileURLWithPath: $0, isDirectory: true).appendingPathComponent(expectedName).path }
                .first { fileManager.isExecutableFile(atPath: $0) }
        }

        guard let candidate,
              URL(fileURLWithPath: candidate).lastPathComponent == expectedName,
              fileManager.isExecutableFile(atPath: candidate) else {
            throw ResumeLauncherError.executableNotFound
        }
        return candidate
    }

    func makeLauncher(for plan: ValidatedPlan) throws -> LauncherFiles {
        removeStaleLaunchers()
        let launchersDirectory = self.launchersDirectory
        do {
            try fileManager.createDirectory(
                at: launchersDirectory,
                withIntermediateDirectories: true,
                attributes: [.posixPermissions: NSNumber(value: 0o700)]
            )
            try fileManager.setAttributes(
                [.posixPermissions: NSNumber(value: 0o700)],
                ofItemAtPath: launchersDirectory.path
            )
        } catch {
            throw ResumeLauncherError.launcherCreationFailed(error.localizedDescription)
        }

        let launcherID = UUID().uuidString
        let temporaryURL = launchersDirectory.appendingPathComponent(".\(launcherID).tmp")
        let launcherURL = launchersDirectory.appendingPathComponent("\(launcherID).command")
        let receiptURL = launchersDirectory.appendingPathComponent("\(launcherID).receipt")
        let environment = plan.environment.keys.sorted().map { key in
            Self.shellQuote("\(key)=\(plan.environment[key]!)")
        }
        let command = (["/usr/bin/env"] + environment + [Self.shellQuote(plan.executable)]
            + plan.arguments.map(Self.shellQuote)).joined(separator: " ")
        let source = """
        #!/bin/zsh
        rm -f -- "$0"
        cd -- \(Self.shellQuote(plan.workingDirectory)) || exit 72
        test -x \(Self.shellQuote(plan.executable)) || exit 73
        : > \(Self.shellQuote(temporaryURL.path)) || exit 74
        mv -f -- \(Self.shellQuote(temporaryURL.path)) \(Self.shellQuote(receiptURL.path)) || exit 74
        exec \(command)
        """ + "\n"

        guard let data = source.data(using: .utf8),
              fileManager.createFile(
                  atPath: temporaryURL.path,
                  contents: data,
                  attributes: [.posixPermissions: NSNumber(value: 0o700)]
              ) else {
            throw ResumeLauncherError.launcherCreationFailed(Strings.t("resume.error.cannotWriteLauncher"))
        }

        do {
            try fileManager.setAttributes(
                [.posixPermissions: NSNumber(value: 0o700)],
                ofItemAtPath: temporaryURL.path
            )
            if Darwin.rename(temporaryURL.path, launcherURL.path) != 0 {
                let detail = String(cString: strerror(errno))
                throw ResumeLauncherError.launcherCreationFailed(detail)
            }
        } catch {
            try? fileManager.removeItem(at: temporaryURL)
            if let launcherError = error as? ResumeLauncherError { throw launcherError }
            throw ResumeLauncherError.launcherCreationFailed(error.localizedDescription)
        }
        return LauncherFiles(
            launcherURL: launcherURL,
            receiptURL: receiptURL,
            temporaryURL: temporaryURL
        )
    }

    /// NSWorkspace only confirms that Terminal accepted the open request. An
    /// empty receipt written by the launcher proves that the shell actually
    /// started, changed to the validated directory, and still found the CLI.
    private func waitForLauncherStart(
        files: LauncherFiles,
        attemptsRemaining: Int,
        completion: @escaping (Result<Void, Error>) -> Void
    ) {
        if fileManager.fileExists(atPath: files.receiptURL.path) {
            try? fileManager.removeItem(at: files.receiptURL)
            completion(.success(()))
            return
        }
        guard attemptsRemaining > 0 else {
            removeLauncherFiles(files)
            completion(.failure(ResumeLauncherError.launcherStartUnconfirmed))
            return
        }
        DispatchQueue.global(qos: .userInitiated).asyncAfter(deadline: .now() + 0.25) { [weak self] in
            self?.waitForLauncherStart(
                files: files,
                attemptsRemaining: attemptsRemaining - 1,
                completion: completion
            )
        }
    }

    private func removeLauncherFiles(_ files: LauncherFiles) {
        try? fileManager.removeItem(at: files.launcherURL)
        try? fileManager.removeItem(at: files.receiptURL)
        try? fileManager.removeItem(at: files.temporaryURL)
    }

    /// A crash can happen after the private launcher is written but before its
    /// self-delete runs. Remove only UUID-named files owned by this feature,
    /// and only after a short grace period.
    private func removeStaleLaunchers(now: Date = Date()) {
        guard let urls = try? fileManager.contentsOfDirectory(
            at: launchersDirectory,
            includingPropertiesForKeys: [.contentModificationDateKey, .isRegularFileKey],
            options: []
        ) else { return }
        let cutoff = now.addingTimeInterval(-10 * 60)
        for url in urls {
            guard ["command", "receipt", "tmp"].contains(url.pathExtension) else { continue }
            var stem = url.deletingPathExtension().lastPathComponent
            if stem.hasPrefix(".") { stem.removeFirst() }
            guard UUID(uuidString: stem) != nil,
                  let values = try? url.resourceValues(forKeys: [.contentModificationDateKey, .isRegularFileKey]),
                  values.isRegularFile == true,
                  let modified = values.contentModificationDate,
                  modified < cutoff else { continue }
            try? fileManager.removeItem(at: url)
        }
    }

    /// Single-quote every byte for POSIX shells. Embedded quotes are closed,
    /// emitted as a quoted literal, and reopened.
    static func shellQuote(_ value: String) -> String {
        "'" + value.replacingOccurrences(of: "'", with: "'\"'\"'") + "'"
    }
}
