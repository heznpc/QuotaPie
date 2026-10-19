import AppKit
import Darwin
import Foundation

struct CodexDesktopProfile: Codable, Identifiable, Equatable {
    let id: String
    var name: String
    let codexHome: String
    let appData: String
    var collectionAccount: String? = nil
    var dockIcon: CodexDockIcon? = nil
    var restoreOnLogin: Bool? = nil
    var credentialOnly: Bool? = nil

    static func canonical(_ path: String) -> String {
        var ancestor = URL(fileURLWithPath: (path as NSString).expandingTildeInPath).standardizedFileURL
        var suffix: [String] = []
        while !FileManager.default.fileExists(atPath: ancestor.path) && ancestor.path != "/" {
            suffix.insert(ancestor.lastPathComponent, at: 0)
            ancestor.deleteLastPathComponent()
        }
        return suffix.reduce(ancestor.resolvingSymlinksInPath()) { $0.appendingPathComponent($1) }.path
    }

    static var primary: Self {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        return Self(id: "primary", name: Strings.t("profiles.primary"),
                    codexHome: home + "/.codex", appData: home + "/Library/Application Support/Codex")
    }

    var environment: [String: String] {
        ["CODEX_HOME": Self.canonical(codexHome), "CODEX_ELECTRON_USER_DATA_PATH": Self.canonical(appData)]
    }
    var arguments: [String] { ["--user-data-dir=" + Self.canonical(appData)] }

    /// Match the collector binding, never a display name or the array order.
    static func forAccount(_ accountID: String, in profiles: [Self]) -> Self? {
        let matches = profiles.filter { profile in
            guard let account = profile.collectionAccount, !account.isEmpty else { return false }
            return accountID == "codex/" + account
        }
        return matches.count == 1 ? matches[0] : nil
    }

    static func validate(_ profiles: [Self]) throws {
        var paths: [String] = []
        guard Set(profiles.map(\.id)).count == profiles.count else { throw ProfileError.paths }
        for profile in profiles {
            guard !profile.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw ProfileError.name }
            for raw in [profile.codexHome, profile.appData] {
                guard raw.hasPrefix("/") || raw.hasPrefix("~/") else { throw ProfileError.paths }
                let path = canonical(raw)
                guard path != "/", path != FileManager.default.homeDirectoryForCurrentUser.path,
                      !paths.contains(where: { path == $0 || path.hasPrefix($0 + "/") || $0.hasPrefix(path + "/") }) else {
                    throw ProfileError.paths
                }
                paths.append(path)
            }
        }
    }
}

/// The backend publishes this only after preserving and verifying the original
/// session IDs and history. An in-progress record never changes launch routing.
struct CodexSessionConsolidation: Decodable, Equatable {
    struct Root: Codable, Equatable { let codexHome: String; let appData: String }
    let version: Int
    let state: String
    let primary: Root
    let sources: [Root]
    let completedAtMs: Double?

    static var markerURL: URL {
        FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/QuotaPie/session-consolidation.json")
    }
    static func protectedData(at url: URL) -> Data? {
        let descriptor = Darwin.open(url.path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK)
        guard descriptor >= 0 else { return nil }
        defer { Darwin.close(descriptor) }
        var before = stat()
        guard fstat(descriptor, &before) == 0, before.st_mode & S_IFMT == S_IFREG,
              before.st_uid == getuid(), before.st_mode & 0o022 == 0,
              before.st_size > 0, before.st_size <= 64 * 1024 else { return nil }
        var bytes = [UInt8](repeating: 0, count: Int(before.st_size)), offset = 0
        let total = bytes.withUnsafeMutableBytes { buffer -> Int in
            while offset < buffer.count {
                let count = Darwin.read(descriptor, buffer.baseAddress!.advanced(by: offset), buffer.count - offset)
                if count <= 0 { return -1 }
                offset += count
            }
            return offset
        }
        var after = stat()
        guard total == bytes.count, fstat(descriptor, &after) == 0,
              before.st_size == after.st_size, before.st_mtimespec.tv_sec == after.st_mtimespec.tv_sec,
              before.st_mtimespec.tv_nsec == after.st_mtimespec.tv_nsec else { return nil }
        return Data(bytes)
    }
    static func read(at url: URL = markerURL, primary expected: CodexDesktopProfile = .primary,
                     now: Date = Date()) -> Self? {
        guard let data = protectedData(at: url), let value = try? JSONDecoder().decode(Self.self, from: data), value.version == 1,
              ["complete", "waiting-for-source-exit"].contains(value.state), value.sources.count <= 128,
              value.primary.codexHome == CodexDesktopProfile.canonical(expected.codexHome),
              value.primary.appData == CodexDesktopProfile.canonical(expected.appData) else { return nil }
        var seen = Set<String>()
        for source in value.sources {
            guard source.codexHome.hasPrefix("/"), source.appData.hasPrefix("/"),
                  source.codexHome == CodexDesktopProfile.canonical(source.codexHome),
                  source.appData == CodexDesktopProfile.canonical(source.appData),
                  source.codexHome != value.primary.codexHome, source.appData != value.primary.appData,
                  source.codexHome != source.appData,
                  seen.insert(source.codexHome + "\n" + source.appData).inserted else { return nil }
        }
        if value.state == "complete" {
            guard let completed = value.completedAtMs, completed.isFinite, completed > 0,
                  completed <= now.timeIntervalSince1970 * 1000 else { return nil }
        }
        return value
    }
    func contains(_ profile: CodexDesktopProfile) -> Bool {
        sources.contains { $0.codexHome == CodexDesktopProfile.canonical(profile.codexHome) &&
            $0.appData == CodexDesktopProfile.canonical(profile.appData) }
    }
    func completed(_ profile: CodexDesktopProfile) -> Bool { state == "complete" && contains(profile) }
}

/// Keep a launch denylist across restarts, separate from the authority to route
/// sessions. Retired sources never reopen when the completion marker is lost.
final class CodexSessionConsolidationHistory {
    // Profile shortcuts have their own bundle ID, so standard defaults would
    // silently miss the menu app's retirement records.
    static let shared = CodexSessionConsolidationHistory(defaults: UserDefaults(suiteName: "local.quotapie.menubar"),
        retirementsURL: CodexSessionConsolidation.markerURL.deletingLastPathComponent().appendingPathComponent("session-consolidation-retirements.json"))
    private struct Record: Codable { let version: Int; let sources: [CodexSessionConsolidation.Root] }
    private let defaults: UserDefaults?
    private let primary: CodexDesktopProfile
    private let key = "local.quotapie.session-consolidation-retirements.v1"
    private let lock = NSLock()
    private var completed: [CodexSessionConsolidation.Root] = []
    private var recordUnverified = false
    private let retirementsURL: URL?
    private var retirementFileSeen = false
    init(defaults: UserDefaults? = nil, primary: CodexDesktopProfile = .primary, retirementsURL: URL? = nil) {
        self.defaults = defaults; self.primary = primary
        self.retirementsURL = retirementsURL
        defer { refreshRetirements() }
        guard let saved = defaults?.object(forKey: key) else { return }
        guard let data = saved as? Data, data.count <= 64 * 1024,
              let record = try? JSONDecoder().decode(Record.self, from: data), record.version == 1,
              record.sources.count <= 128 else { recordUnverified = true; return }
        var seen = Set<String>()
        for source in record.sources {
            guard source.codexHome.hasPrefix("/"), source.appData.hasPrefix("/"),
                  source.codexHome == CodexDesktopProfile.canonical(source.codexHome),
                  source.appData == CodexDesktopProfile.canonical(source.appData), source.codexHome != source.appData,
                  source.codexHome != CodexDesktopProfile.canonical(primary.codexHome),
                  source.appData != CodexDesktopProfile.canonical(primary.appData),
                  seen.insert(source.codexHome + "\n" + source.appData).inserted else { recordUnverified = true; return }
        }
        completed = record.sources
    }
    func observe(_ snapshot: CodexSessionConsolidation?) {
        refreshRetirements()
        guard let snapshot, snapshot.state == "complete" else { return }
        lock.lock(); defer { lock.unlock() }
        let before = completed
        for source in snapshot.sources where !completed.contains(source) { completed.append(source) }
        // Never replace an unreadable denylist with a possibly partial snapshot.
        if let defaults, !recordUnverified, completed != before {
            guard completed.count <= 128, let data = try? JSONEncoder().encode(Record(version: 1, sources: completed)),
                  data.count <= 64 * 1024 else { recordUnverified = true; return }
            defaults.set(data, forKey: key)
            if !defaults.synchronize() { recordUnverified = true }
        }
    }
    func contains(_ profile: CodexDesktopProfile) -> Bool {
        refreshRetirements()
        lock.lock(); defer { lock.unlock() }
        return completed.contains { $0.codexHome == CodexDesktopProfile.canonical(profile.codexHome) &&
            $0.appData == CodexDesktopProfile.canonical(profile.appData) }
    }
    func requiresVerification(_ profile: CodexDesktopProfile) -> Bool {
        refreshRetirements()
        lock.lock(); defer { lock.unlock() }
        let home = CodexDesktopProfile.canonical(profile.codexHome), data = CodexDesktopProfile.canonical(profile.appData)
        if recordUnverified && (home != CodexDesktopProfile.canonical(primary.codexHome) ||
            data != CodexDesktopProfile.canonical(primary.appData)) { return true }
        // A new appData directory must not reopen a retired CODEX_HOME (or vice
        // versa). Only the original exact pair can use verified primary routing.
        let exact = completed.contains { $0.codexHome == home && $0.appData == data }
        return !exact && completed.contains { retired in
            [retired.codexHome, retired.appData].contains(home) || [retired.codexHome, retired.appData].contains(data)
        }
    }
    private func refreshRetirements() {
        guard let url = retirementsURL else { return }
        lock.lock(); defer { lock.unlock() }
        var info = stat()
        if lstat(url.path, &info) != 0 {
            if errno != ENOENT || retirementFileSeen { recordUnverified = true }
            return
        }
        retirementFileSeen = true
        guard url.deletingLastPathComponent().standardizedFileURL.path ==
                url.deletingLastPathComponent().resolvingSymlinksInPath().path,
              let data = CodexSessionConsolidation.protectedData(at: url),
              let record = try? JSONDecoder().decode(Record.self, from: data), record.version == 1,
              record.sources.count <= 128 else { recordUnverified = true; return }
        var paths = Set<String>()
        for source in record.sources {
            guard [source.codexHome, source.appData].allSatisfy({ path in
                path.hasPrefix("/") && path.utf8.count <= 4096 && path == CodexDesktopProfile.canonical(path) && paths.insert(path).inserted
            }), !CodexProcessIdentity(codexHome: source.codexHome, appData: source.appData).overlaps(primary) else {
                recordUnverified = true; return
            }
        }
        let before = completed
        for source in record.sources where !completed.contains(source) { completed.append(source) }
        if !recordUnverified, completed != before, let defaults {
            guard completed.count <= 128, let data = try? JSONEncoder().encode(Record(version: 1, sources: completed)),
                  data.count <= 64 * 1024 else { recordUnverified = true; return }
            defaults.set(data, forKey: key)
            if !defaults.synchronize() { recordUnverified = true }
        }
    }
}

/// A requested migration must not revive a source after it exits or after reboot.
/// Waiting permits activation of the existing exact host; running permits neither.
struct CodexSessionConsolidationActivity: Decodable, Equatable {
    let version: Int
    let state: String
    let source: CodexSessionConsolidation.Root
    let primary: CodexSessionConsolidation.Root
    let updatedAtMs: Double
    static var statusURL: URL {
        CodexSessionConsolidation.markerURL.deletingLastPathComponent().appendingPathComponent("session-consolidation-status.json")
    }
    static func read(at url: URL = statusURL, primary expected: CodexDesktopProfile = .primary,
                     now: Date = Date()) -> Self? {
        guard let data = CodexSessionConsolidation.protectedData(at: url),
              let value = try? JSONDecoder().decode(Self.self, from: data), value.version == 1,
              ["running", "waiting-for-source-exit", "blocked"].contains(value.state), value.updatedAtMs.isFinite, value.updatedAtMs > 0,
              value.updatedAtMs <= now.timeIntervalSince1970 * 1000,
              value.primary.codexHome == CodexDesktopProfile.canonical(expected.codexHome),
              value.primary.appData == CodexDesktopProfile.canonical(expected.appData),
              value.source.codexHome.hasPrefix("/"), value.source.appData.hasPrefix("/"),
              value.source.codexHome == CodexDesktopProfile.canonical(value.source.codexHome),
              value.source.appData == CodexDesktopProfile.canonical(value.source.appData),
              !CodexProcessIdentity(codexHome: value.source.codexHome, appData: value.source.appData).overlaps(expected) else { return nil }
        return value
    }
    func blocks(_ profile: CodexDesktopProfile) -> Bool {
        CodexProcessIdentity(codexHome: source.codexHome, appData: source.appData).overlaps(profile)
    }
    func matches(_ profile: CodexDesktopProfile) -> Bool {
        source.codexHome == CodexDesktopProfile.canonical(profile.codexHome) &&
            source.appData == CodexDesktopProfile.canonical(profile.appData)
    }
}

enum CodexProfileLaunchIntent { case work, accountLogin }
enum CodexProfileLaunchRestriction { case none, existingOnly, waiting, running, unverified }

private func consolidationRestriction(_ profile: CodexDesktopProfile, intent: CodexProfileLaunchIntent,
                                      snapshot: CodexSessionConsolidation?, activity: CodexSessionConsolidationActivity?) -> CodexProfileLaunchRestriction {
    if let activity, activity.blocks(profile) {
        if activity.state == "running" { return .running }
        if activity.state == "blocked" { return .unverified }
        return intent == .work && activity.matches(profile) ? .existingOnly : .waiting
    }
    if let snapshot, snapshot.state == "waiting-for-source-exit", snapshot.sources.contains(where: {
        CodexProcessIdentity(codexHome: $0.codexHome, appData: $0.appData).overlaps(profile)
    }) {
        return intent == .work && snapshot.contains(profile) ? .existingOnly : .waiting
    }
    return .none
}

extension CodexDesktopProfile {
    func launchProfile(intent: CodexProfileLaunchIntent, consolidation: CodexSessionConsolidation?,
                       primary: Self = .primary) throws -> Self {
        if intent == .accountLogin {
            guard consolidation?.completed(self) != true else { throw ProfileError.consolidated }
            return self
        }
        return credentialOnly == true || consolidation?.completed(self) == true ? primary : self
    }
}

enum ProfileError: LocalizedError {
    case paths, name, appMissing, identity, launch, storage, consolidated, consolidationUnavailable, consolidationRunning, consolidationPending
    var errorDescription: String? {
        Strings.t("profiles.error." + String(describing: self))
    }
}

/// Reads argv and only two environment fields. Never exposes credentials or the
/// rest of the environment. The executable is verified through NSRunningApplication.
struct CodexProcessIdentity: Codable {
    let codexHome: String
    let appData: String

    static func parse(_ bytes: [UInt8], primary: CodexDesktopProfile = .primary, environmentOnly: Bool = false) -> Self? {
        guard bytes.count > MemoryLayout<Int32>.size else { return nil }
        let argc = bytes.prefix(4).enumerated().reduce(UInt32(0)) { $0 | UInt32($1.element) << ($1.offset * 8) }
        guard argc > 0, argc < 10000 else { return nil }
        var offset = 4
        func next() -> String? {
            guard offset < bytes.count, let end = bytes[offset...].firstIndex(of: 0) else { return nil }
            let text = String(bytes: bytes[offset..<end], encoding: .utf8)
            offset = end + 1
            return text
        }
        guard next() != nil else { return nil } // executable path
        while offset < bytes.count && bytes[offset] == 0 { offset += 1 }
        var args: [String] = []
        for _ in 0..<argc { guard let arg = next() else { return nil }; args.append(arg) }
        var home: String?, data: String?
        while offset < bytes.count {
            guard let item = next() else { break }
            if item.hasPrefix("CODEX_HOME=") { home = String(item.dropFirst(11)) }
            if item.hasPrefix("CODEX_ELECTRON_USER_DATA_PATH=") { data = String(item.dropFirst(30)) }
        }
        for (index, arg) in args.enumerated() where !environmentOnly {
            if arg.hasPrefix("--user-data-dir=") { data = String(arg.dropFirst(16)) }
            if arg == "--user-data-dir", index + 1 < args.count { data = args[index + 1] }
        }
        return Self(codexHome: CodexDesktopProfile.canonical(home?.isEmpty == false ? home! : primary.codexHome),
                    appData: CodexDesktopProfile.canonical(data?.isEmpty == false ? data! : primary.appData))
    }

    // The installed desktop app sets both homes from its environment at startup.
    // An updater may preserve argv while dropping the isolation environment.
    static func read(pid: pid_t, environmentOnly: Bool = true) -> Self? {
        var mib: [Int32] = [CTL_KERN, KERN_PROCARGS2, pid]
        var size = 0
        guard sysctl(&mib, 3, nil, &size, nil, 0) == 0, size > 0, size < 4 * 1024 * 1024 else { return nil }
        var bytes = [UInt8](repeating: 0, count: size)
        guard sysctl(&mib, 3, &bytes, &size, nil, 0) == 0 else { return nil }
        return parse(Array(bytes.prefix(size)), environmentOnly: environmentOnly)
    }

    func matches(_ profile: CodexDesktopProfile) -> Bool {
        codexHome == CodexDesktopProfile.canonical(profile.codexHome) && appData == CodexDesktopProfile.canonical(profile.appData)
    }

    func collectionAccountID(in profiles: [CodexDesktopProfile]) -> String? {
        let matches = profiles.filter { self.matches($0) }
        guard matches.count == 1, let account = matches[0].collectionAccount, !account.isEmpty else { return nil }
        return "codex/" + account
    }
    func overlaps(_ profile: CodexDesktopProfile) -> Bool {
        [codexHome, appData].contains { running in
            [profile.codexHome, profile.appData].map(CodexDesktopProfile.canonical).contains {
                running == $0 || running.hasPrefix($0 + "/") || $0.hasPrefix(running + "/")
            }
        }
    }
}

struct CodexProfileRunningApplication {
    let processIdentifier: pid_t
    let executableURL: URL?
    let activate: () -> Bool
}

final class CodexProfileLauncher {
    private let readIdentity: (pid_t) -> CodexProcessIdentity?
    private let consolidation: () -> CodexSessionConsolidation?
    private let consolidationActivity: () -> CodexSessionConsolidationActivity?
    private let consolidationHistory: CodexSessionConsolidationHistory
    private let runningApplications: () -> [CodexProfileRunningApplication]
    init(readIdentity: @escaping (pid_t) -> CodexProcessIdentity? = { CodexProcessIdentity.read(pid: $0) },
         consolidation: @escaping () -> CodexSessionConsolidation? = { CodexSessionConsolidation.read() },
         activity: @escaping () -> CodexSessionConsolidationActivity? = { CodexSessionConsolidationActivity.read() },
         history: CodexSessionConsolidationHistory = .shared,
         runningApplications: @escaping () -> [CodexProfileRunningApplication] = {
             NSWorkspace.shared.runningApplications.map { app in
                 CodexProfileRunningApplication(processIdentifier: app.processIdentifier, executableURL: app.executableURL,
                     activate: { app.activate(options: [.activateAllWindows, .activateIgnoringOtherApps]) })
             }
         }) {
        self.readIdentity = readIdentity; self.consolidation = consolidation; self.consolidationHistory = history
        self.consolidationActivity = activity
        self.runningApplications = runningApplications
    }
    static func appURL() -> URL? {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        return ["/Applications/ChatGPT.app", "/Applications/Codex.app", home + "/Applications/ChatGPT.app", home + "/Applications/Codex.app"]
            .map { URL(fileURLWithPath: $0) }.first { Bundle(url: $0)?.bundleIdentifier == "com.openai.codex" }
    }

    func open(_ requestedProfile: CodexDesktopProfile, appURL: URL? = nil, activate: Bool = true,
              intent: CodexProfileLaunchIntent = .work, completion: @escaping (Result<Void, Error>) -> Void) {
        let profile: CodexDesktopProfile
        let restriction: CodexProfileLaunchRestriction
        do {
            let snapshot = consolidation(); consolidationHistory.observe(snapshot)
            if consolidationHistory.requiresVerification(requestedProfile) ||
                consolidationHistory.contains(requestedProfile) && snapshot?.completed(requestedProfile) != true {
                throw ProfileError.consolidationUnavailable
            }
            profile = try requestedProfile.launchProfile(intent: intent, consolidation: snapshot)
            restriction = consolidationRestriction(profile, intent: intent, snapshot: snapshot, activity: consolidationActivity())
            if restriction == .running { throw ProfileError.consolidationRunning }
            if restriction == .waiting { throw ProfileError.consolidationPending }
            if restriction == .unverified { throw ProfileError.consolidationUnavailable }
        }
        catch { completion(.failure(error)); return }
        guard let url = appURL ?? Self.appURL(), let executable = Bundle(url: url)?.executableURL else {
            completion(.failure(ProfileError.appMissing)); return
        }
        let applications = runningApplications().filter { $0.executableURL?.resolvingSymlinksInPath() == executable.resolvingSymlinksInPath() }
        for application in applications {
            guard let identity = readIdentity(application.processIdentifier) else {
                completion(.failure(ProfileError.identity)); return
            }
            if identity.matches(profile) {
                let snapshot = consolidation()
                let latest = consolidationRestriction(profile, intent: intent, snapshot: snapshot, activity: consolidationActivity())
                if latest == .running { completion(.failure(ProfileError.consolidationRunning)); return }
                if latest == .unverified || snapshot?.completed(profile) == true { completion(.failure(ProfileError.consolidationUnavailable)); return }
                if latest == .waiting { completion(.failure(ProfileError.consolidationPending)); return }
                completion(!activate || application.activate() ? .success(()) : .failure(ProfileError.launch))
                return
            }
            if identity.overlaps(profile) { completion(.failure(ProfileError.paths)); return }
        }
        // Re-read after the process inventory: migration can be requested while
        // locating the app. Never recreate a waiting source or touch its files.
        let latest = consolidationRestriction(profile, intent: intent, snapshot: consolidation(), activity: consolidationActivity())
        if restriction != .none || latest != .none {
            completion(.failure(latest == .running ? ProfileError.consolidationRunning :
                latest == .unverified ? ProfileError.consolidationUnavailable : ProfileError.consolidationPending)); return
        }
        do {
            try CodexDesktopProfile.validate([profile])
            for path in [profile.codexHome, profile.appData] {
                try FileManager.default.createDirectory(atPath: CodexDesktopProfile.canonical(path), withIntermediateDirectories: true,
                                                        attributes: [.posixPermissions: 0o700])
            }
            let config = URL(fileURLWithPath: CodexDesktopProfile.canonical(profile.codexHome)).appendingPathComponent("config.toml")
            // Never copy auth or overwrite an existing profile's settings.
            if !FileManager.default.fileExists(atPath: config.path) {
                try Data("cli_auth_credentials_store = \"file\"\n".utf8).write(to: config, options: .withoutOverwriting)
                try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: config.path)
            }
        } catch { completion(.failure(error)); return }
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.createsNewApplicationInstance = true
        configuration.activates = activate
        configuration.arguments = profile.arguments
        configuration.environment = profile.environment
        NSWorkspace.shared.openApplication(at: url, configuration: configuration) { application, error in
            DispatchQueue.main.async {
                guard error == nil, let application else { completion(.failure(error ?? ProfileError.launch)); return }
                let created = !applications.contains { $0.processIdentifier == application.processIdentifier }
                DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
                    self.verify(application, profile: profile, attempts: 20, created: created, completion: completion)
                }
            }
        }
    }

    private func verify(_ app: NSRunningApplication, profile: CodexDesktopProfile, attempts: Int, created: Bool,
                        completion: @escaping (Result<Void, Error>) -> Void) {
        guard !app.isTerminated else { completion(.failure(ProfileError.launch)); return }
        if readIdentity(app.processIdentifier)?.matches(profile) == true {
            completion(.success(())); return
        }
        guard attempts > 0 else {
            // A failed restore must not leave an extra default-account app and
            // then create another one on every retry. Retire only the process
            // created by this attempt, with a positively mismatched identity.
            if created, let actual = readIdentity(app.processIdentifier), !actual.matches(profile) {
                _ = app.terminate()
            }
            completion(.failure(ProfileError.identity)); return
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) {
            self.verify(app, profile: profile, attempts: attempts - 1, created: created, completion: completion)
        }
    }
}

final class CodexProfilesModel: ObservableObject {
    static let shared = CodexProfilesModel()
    @Published private(set) var profiles: [CodexDesktopProfile] = []
    @Published var busy = false
    @Published var message: String?
    @Published private(set) var consolidation: CodexSessionConsolidation?
    @Published private(set) var consolidationStatus: SessionConsolidationReply?
    @Published private(set) var consolidationActivity: CodexSessionConsolidationActivity?
    private let consolidationReader: () -> CodexSessionConsolidation?
    private let activityReader: () -> CodexSessionConsolidationActivity?
    private let consolidationHistory: CodexSessionConsolidationHistory
    private let defaults: UserDefaults
    private let launcher: CodexProfileLauncher
    private let key = "local.quotapie.codex-desktop-profiles.v1"

    init(defaults: UserDefaults = .standard,
         consolidation: @escaping () -> CodexSessionConsolidation? = { CodexSessionConsolidation.read() },
         activity: @escaping () -> CodexSessionConsolidationActivity? = { CodexSessionConsolidationActivity.read() },
         history: CodexSessionConsolidationHistory = .shared) {
        self.defaults = defaults; self.consolidationReader = consolidation; self.consolidationHistory = history
        self.activityReader = activity; self.consolidationActivity = activity()
        self.launcher = CodexProfileLauncher(consolidation: consolidation, activity: activity, history: history)
        self.consolidation = consolidation(); history.observe(self.consolidation)
        if let data = defaults.data(forKey: key) {
            do {
                let saved = try JSONDecoder().decode([CodexDesktopProfile].self, from: data)
                try CodexDesktopProfile.validate(saved)
                profiles = saved
            } catch { message = Strings.t("profiles.error.storage") }
        } else { profiles = [.primary] }
    }
    func add(name: String, home: String?, data: String?) {
        let id = UUID().uuidString.lowercased()
        let root = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/QuotaPie/CodexProfiles/" + id)
        let profile = CodexDesktopProfile(id: id, name: name.trimmingCharacters(in: .whitespacesAndNewlines),
            codexHome: home ?? root.appendingPathComponent("home").path, appData: data ?? root.appendingPathComponent("app-data").path,
            restoreOnLogin: false, credentialOnly: home == nil && data == nil)
        save(profiles + [profile])
    }
    func rememberDockIcon(_ icon: CodexDockIcon, for profile: CodexDesktopProfile) {
        guard profiles.first(where: { $0.id == profile.id })?.dockIcon != icon else { return }
        save(profiles.map { item in
            var next = item
            if item.id == profile.id { next.dockIcon = icon }
            return next
        })
    }
    func remove(_ profile: CodexDesktopProfile) {
        // Remove only the launch registration. Never delete files or stop apps.
        save(profiles.filter { $0.id != profile.id })
    }
    func refreshConsolidation() {
        let next = consolidationReader(); consolidationHistory.observe(next)
        if consolidation != next { consolidation = next }
        let activity = activityReader()
        if consolidationActivity != activity { consolidationActivity = activity }
        let statusURL = CodexSessionConsolidationActivity.statusURL
        let status = CodexSessionConsolidation.protectedData(at: statusURL).flatMap { try? JSONDecoder().decode(SessionConsolidationReply.self, from: $0) }
        if consolidationStatus != status { consolidationStatus = status }
    }
    var automaticRestorationProfiles: [CodexDesktopProfile] {
        refreshConsolidation()
        return profiles.filter { allowsAutomaticRestoration($0) }
    }
    func isKnownConsolidated(_ profile: CodexDesktopProfile) -> Bool { consolidationHistory.contains(profile) }
    func requiresConsolidationVerification(_ profile: CodexDesktopProfile) -> Bool {
        consolidationHistory.requiresVerification(profile) ||
            consolidationHistory.contains(profile) && consolidation?.completed(profile) != true ||
            consolidationRestriction(profile, intent: .accountLogin, snapshot: consolidation, activity: consolidationActivity) == .unverified
    }
    func isConsolidationRunning(_ profile: CodexDesktopProfile) -> Bool {
        consolidationActivity?.state == "running" && consolidationActivity?.blocks(profile) == true
    }
    func isConsolidationPending(_ profile: CodexDesktopProfile) -> Bool {
        consolidationRestriction(profile, intent: .accountLogin, snapshot: consolidation, activity: consolidationActivity) == .waiting
    }
    func allowsAccountLogin(_ profile: CodexDesktopProfile) -> Bool {
        !consolidationHistory.contains(profile) && !requiresConsolidationVerification(profile) &&
            !isConsolidationRunning(profile) && !isConsolidationPending(profile)
    }
    func allowsAutomaticRestoration(_ profile: CodexDesktopProfile) -> Bool {
        profile.credentialOnly != true && !consolidationHistory.contains(profile) &&
            !requiresConsolidationVerification(profile) && !isConsolidationRunning(profile) && !isConsolidationPending(profile)
    }
    func setRestoreOnLogin(_ enabled: Bool, for profile: CodexDesktopProfile) {
        refreshConsolidation()
        guard allowsAutomaticRestoration(profile) else { return }
        save(profiles.map { item in
            var next = item
            if item.id == profile.id { next.restoreOnLogin = enabled }
            return next
        })
    }
    private func save(_ next: [CodexDesktopProfile]) {
        do {
            try CodexDesktopProfile.validate(next)
            defaults.set(try JSONEncoder().encode(next), forKey: key)
            profiles = next; message = nil
        } catch { message = error.localizedDescription }
    }
    private var connectionClient: StatusClient?
    func connect(_ profile: CodexDesktopProfile, token: String?) {
        guard !busy, let token, !token.isEmpty else { return }
        busy = true; message = nil
        do {
            // First connection also stages and health-checks a profile relay.
            let client = try StatusClient(operationTimeout: 60)
            connectionClient = client
            client.connectProfile(profile, actionToken: token) { [weak self] result in
                DispatchQueue.main.async {
                    guard let self else { return }
                    self.busy = false
                    switch result {
                    case .success(let connection):
                        let next = self.profiles.map { item -> CodexDesktopProfile in
                            var updated = item
                            if item.id == profile.id { updated.collectionAccount = connection.account }
                            return updated
                        }
                        self.save(next)
                        self.message = Strings.t(connection.relayConnected == true ? "profiles.connectedWithRelay" : "profiles.connected")
                    case .failure(let error): self.message = (error as? ProfileConnectionError)?.localizedDescription ?? Strings.t("profiles.connectFailed")
                    }
                    self.connectionClient = nil
                }
            }
        } catch { busy = false; message = Strings.t("profiles.connectFailed") }
    }
    func requestConsolidation(_ profile: CodexDesktopProfile, token: String?) {
        refreshConsolidation()
        guard !busy, profile.id != "primary", !isKnownConsolidated(profile), !requiresConsolidationVerification(profile), !isConsolidationRunning(profile),
              let token, !token.isEmpty else { return }
        busy = true; message = nil
        do {
            let client = try StatusClient(operationTimeout: 60)
            connectionClient = client
            client.consolidateSessions(profile, actionToken: token) { [weak self] result in
                DispatchQueue.main.async {
                    guard let self else { return }
                    self.busy = false; self.refreshConsolidation()
                    switch result {
                    case .success(let status):
                        self.consolidationStatus = status
                        if self.consolidation?.completed(profile) == true { self.message = Strings.t("profiles.consolidatedAccount") }
                        else if status.state == "waiting-for-source-exit" { self.message = Strings.t("profiles.consolidationPending") }
                        else if ["blocked", "failed"].contains(status.state) { self.message = Strings.t("profiles.consolidationFailed") }
                        else { self.message = Strings.t("profiles.consolidationRequested") }
                    case .failure: self.message = Strings.t("profiles.consolidationFailed")
                    }
                    self.connectionClient = nil
                }
            }
        } catch { busy = false; message = Strings.t("profiles.consolidationFailed") }
    }
    func open(_ profile: CodexDesktopProfile, intent: CodexProfileLaunchIntent = .work) {
        refreshConsolidation()
        guard !busy else { return }
        if requiresConsolidationVerification(profile) { message = Strings.t("profiles.error.consolidationUnavailable"); return }
        busy = true; message = nil
        launcher.open(profile, intent: intent) { [weak self] result in
            self?.busy = false
            switch result {
            case .success:
                self?.message = intent == .accountLogin ? Strings.t("profiles.openedLogin", profile.name)
                    : Strings.t("profiles.openedWork")
            case .failure(let error): self?.message = error.localizedDescription
            }
        }
    }
}
