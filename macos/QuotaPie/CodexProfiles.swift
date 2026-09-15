import AppKit
import Darwin
import Foundation

struct CodexDesktopProfile: Codable, Identifiable, Equatable {
    let id: String
    var name: String
    let codexHome: String
    let appData: String
    var collectionAccount: String? = nil

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

enum ProfileError: LocalizedError {
    case paths, name, appMissing, identity, launch, storage
    var errorDescription: String? {
        Strings.t("profiles.error." + String(describing: self))
    }
}

/// Reads argv and only two environment fields. Never exposes credentials or the
/// rest of the environment. The executable is verified through NSRunningApplication.
struct CodexProcessIdentity {
    let codexHome: String
    let appData: String

    static func parse(_ bytes: [UInt8], primary: CodexDesktopProfile = .primary) -> Self? {
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
        for (index, arg) in args.enumerated() {
            if arg.hasPrefix("--user-data-dir=") { data = String(arg.dropFirst(16)) }
            if arg == "--user-data-dir", index + 1 < args.count { data = args[index + 1] }
        }
        return Self(codexHome: CodexDesktopProfile.canonical(home?.isEmpty == false ? home! : primary.codexHome),
                    appData: CodexDesktopProfile.canonical(data?.isEmpty == false ? data! : primary.appData))
    }

    static func read(pid: pid_t) -> Self? {
        var mib: [Int32] = [CTL_KERN, KERN_PROCARGS2, pid]
        var size = 0
        guard sysctl(&mib, 3, nil, &size, nil, 0) == 0, size > 0, size < 4 * 1024 * 1024 else { return nil }
        var bytes = [UInt8](repeating: 0, count: size)
        guard sysctl(&mib, 3, &bytes, &size, nil, 0) == 0 else { return nil }
        return parse(Array(bytes.prefix(size)))
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

final class CodexProfileLauncher {
    static func appURL() -> URL? {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        return ["/Applications/ChatGPT.app", "/Applications/Codex.app", home + "/Applications/ChatGPT.app", home + "/Applications/Codex.app"]
            .map { URL(fileURLWithPath: $0) }.first { Bundle(url: $0)?.bundleIdentifier == "com.openai.codex" }
    }

    func open(_ profile: CodexDesktopProfile, appURL: URL? = nil, completion: @escaping (Result<Void, Error>) -> Void) {
        guard let url = appURL ?? Self.appURL(), let executable = Bundle(url: url)?.executableURL else {
            completion(.failure(ProfileError.appMissing)); return
        }
        let applications = NSWorkspace.shared.runningApplications.filter { $0.executableURL?.resolvingSymlinksInPath() == executable.resolvingSymlinksInPath() }
        for application in applications {
            guard let identity = CodexProcessIdentity.read(pid: application.processIdentifier) else {
                completion(.failure(ProfileError.identity)); return
            }
            if identity.matches(profile) {
                completion(application.activate(options: [.activateAllWindows, .activateIgnoringOtherApps]) ? .success(()) : .failure(ProfileError.launch))
                return
            }
            if identity.overlaps(profile) { completion(.failure(ProfileError.paths)); return }
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
        configuration.arguments = profile.arguments
        configuration.environment = profile.environment
        NSWorkspace.shared.openApplication(at: url, configuration: configuration) { application, error in
            DispatchQueue.main.async {
                guard error == nil, let application else { completion(.failure(error ?? ProfileError.launch)); return }
                DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
                    self.verify(application, profile: profile, attempts: 20, completion: completion)
                }
            }
        }
    }

    private func verify(_ app: NSRunningApplication, profile: CodexDesktopProfile, attempts: Int,
                        completion: @escaping (Result<Void, Error>) -> Void) {
        guard !app.isTerminated else { completion(.failure(ProfileError.launch)); return }
        if CodexProcessIdentity.read(pid: app.processIdentifier)?.matches(profile) == true {
            completion(.success(())); return
        }
        guard attempts > 0 else { completion(.failure(ProfileError.identity)); return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) {
            self.verify(app, profile: profile, attempts: attempts - 1, completion: completion)
        }
    }
}

final class CodexProfilesModel: ObservableObject {
    static let shared = CodexProfilesModel()
    @Published private(set) var profiles: [CodexDesktopProfile] = []
    @Published var busy = false
    @Published var message: String?
    private let defaults: UserDefaults
    private let launcher = CodexProfileLauncher()
    private let key = "local.quotapie.codex-desktop-profiles.v1"

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
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
            codexHome: home ?? root.appendingPathComponent("home").path, appData: data ?? root.appendingPathComponent("app-data").path)
        save(profiles + [profile])
    }
    func remove(_ profile: CodexDesktopProfile) {
        // Remove only the launch registration. Never delete files or stop apps.
        save(profiles.filter { $0.id != profile.id })
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
            let client = try StatusClient()
            connectionClient = client
            client.connectProfile(profile, actionToken: token) { [weak self] result in
                DispatchQueue.main.async {
                    guard let self else { return }
                    self.busy = false
                    switch result {
                    case .success(let account):
                        let next = self.profiles.map { item -> CodexDesktopProfile in
                            var updated = item
                            if item.id == profile.id { updated.collectionAccount = account }
                            return updated
                        }
                        self.save(next)
                        self.message = Strings.t("profiles.connected")
                    case .failure(let error): self.message = (error as? ProfileConnectionError)?.localizedDescription ?? Strings.t("profiles.connectFailed")
                    }
                    self.connectionClient = nil
                }
            }
        } catch { busy = false; message = Strings.t("profiles.connectFailed") }
    }
    func open(_ profile: CodexDesktopProfile) {
        guard !busy else { return }; busy = true; message = nil
        launcher.open(profile) { [weak self] result in
            self?.busy = false
            switch result {
            case .success: self?.message = Strings.t("profiles.opened", profile.name)
            case .failure(let error): self?.message = error.localizedDescription
            }
        }
    }
}
