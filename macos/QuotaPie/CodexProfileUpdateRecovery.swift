import AppKit
import Foundation
import OSLog

/// Recovery is armed only by replacement of the installed executable, never by
/// a normal quit. Keep the primary process as the anchor when an updater starts
/// a second, unconfigured copy of the same application.
struct CodexProfileUpdateRecovery {
    struct Instance: Codable {
        let pid: pid_t
        let identity: CodexProcessIdentity
        let launchedAt: Date
        var intendedAppData: String? = nil
    }
    struct Actions {
        var reopen: [CodexDesktopProfile] = []
        var stopDuplicate: [pid_t] = []
    }
    private var stamp: String?
    private var previous: [Instance] = []
    private var pending: [String: CodexDesktopProfile] = [:]
    private var originalPIDs: [String: Set<pid_t>] = [:]
    private var recent: [String: (profile: CodexDesktopProfile, pids: Set<pid_t>, seenAt: Date)] = [:]
    private var primaryAnchors: Set<pid_t> = []
    private var changedAt: Date?

    mutating func observe(stamp next: String, instances: [Instance], profiles: [CodexDesktopProfile],
                          now: Date) -> Actions {
        var actions = Actions()
        let primary = profiles.first { $0.id == "primary" } ?? .primary
        if let stamp, stamp != next {
            for profile in profiles where profile.id != "primary" {
                if let observed = recent[profile.id], observed.profile == profile,
                   now.timeIntervalSince(observed.seenAt) < 30 {
                    pending[profile.id] = profile
                    originalPIDs[profile.id] = observed.pids
                }
            }
            primaryAnchors.formUnion(previous.filter { $0.identity.matches(primary) }.map(\.pid))
            if let observed = recent[primary.id], now.timeIntervalSince(observed.seenAt) < 30 {
                primaryAnchors.formUnion(observed.pids)
            }
            changedAt = now
        }
        stamp = next
        previous = instances
        for profile in profiles {
            let pids = Set(instances.filter { $0.identity.matches(profile) }.map(\.pid))
            if !pids.isEmpty { recent[profile.id] = (profile, pids, now) }
        }
        guard let changedAt, now.timeIntervalSince(changedAt) >= 2 else { return actions }
        guard now.timeIntervalSince(changedAt) < 600 else {
            pending.removeAll(); originalPIDs.removeAll(); primaryAnchors.removeAll(); self.changedAt = nil
            return actions
        }
        // Never relaunch a profile the user unregistered during the update.
        pending = pending.filter { id, profile in profiles.contains { $0.id == id && $0 == profile } }
        originalPIDs = originalPIDs.filter { id, _ in profiles.contains { $0.id == id } }
        // A new verified PID ends restoration. A later manual quit must stay quit.
        pending = pending.filter { id, profile in
            !instances.contains { $0.identity.matches(profile) && !(originalPIDs[id] ?? []).contains($0.pid) }
        }
        for profile in pending.values {
            if !instances.contains(where: { $0.identity.matches(profile) }) { actions.reopen.append(profile) }
        }
        for profile in actions.reopen {
            actions.stopDuplicate += instances.filter {
                $0.launchedAt >= changedAt.addingTimeInterval(-2)
                    && ($0.identity.appData == CodexDesktopProfile.canonical(profile.appData)
                        || $0.identity.codexHome == CodexDesktopProfile.canonical(profile.codexHome))
                    && !$0.identity.matches(profile)
            }.map(\.pid)
        }
        // If the primary was also restarted, adopt its sole replacement. Two
        // unidentified default instances are ambiguous; never choose one to kill.
        if !primaryAnchors.isEmpty && !instances.contains(where: { primaryAnchors.contains($0.pid) }) {
            let replacements = instances.filter { $0.identity.matches(primary) }
            if replacements.count == 1 { primaryAnchors.insert(replacements[0].pid) }
        }
        let anchoredPrimary = instances.contains { primaryAnchors.contains($0.pid) && $0.identity.matches(primary) }
        if anchoredPrimary && !originalPIDs.isEmpty {
            actions.stopDuplicate += instances.filter {
                !primaryAnchors.contains($0.pid) && $0.identity.matches(primary)
                    && $0.launchedAt >= changedAt.addingTimeInterval(-2) && $0.launchedAt.timeIntervalSince(changedAt) < 30
            }.map(\.pid)
        }
        actions.stopDuplicate = Array(Set(actions.stopDuplicate))
        return actions
    }
}

/// Updaters can add Dock pins after replacing the bundle. Debounce replacement
/// writes and recheck for a bounded period, including after QuotaPie restarts.
struct CodexProfileDockRepairWindow {
    private var stamp: String?
    private var nextCheck: Date = .distantFuture
    private var deadline: Date = .distantPast
    private var finished = false

    mutating func shouldCheck(stamp: String, now: Date) -> Bool {
        if self.stamp != stamp {
            self.stamp = stamp
            nextCheck = now.addingTimeInterval(2)
            deadline = now.addingTimeInterval(120)
            finished = false
        }
        guard !finished, now >= nextCheck else { return false }
        if now >= deadline { finished = true }
        nextCheck = min(now.addingTimeInterval(10), deadline)
        return true
    }
}

final class CodexProfileDockRepairLifetime {
    private let lock = NSLock()
    private var active = true
    var isActive: Bool {
        lock.lock(); defer { lock.unlock() }
        return active
    }
    func cancel() {
        lock.lock(); defer { lock.unlock() }
        active = false
    }
}

final class CodexProfileUpdateMonitor {
    private struct Snapshot: Codable {
        let boot: String
        let stamp: String
        let instances: [CodexProfileUpdateRecovery.Instance]
        let checkedAt: Date
    }
    private var recovery = CodexProfileUpdateRecovery()
    private var timer: Timer?
    private var opening: Set<String> = []
    private var retryAfter: [String: Date] = [:]
    private let launcher = CodexProfileLauncher()
    private let logger = Logger(subsystem: "local.quotapie.menubar", category: "ProfileUpdateRecovery")
    private let profiles: () -> [CodexDesktopProfile]
    private let appURL: () -> URL?
    private let defaults: UserDefaults?
    private let installShortcuts: Bool
    private var loginRecovery: CodexProfileLoginRecovery?
    private var powerObserver: NSObjectProtocol?
    private var shuttingDown = false
    private var lastSaved = Date.distantPast
    private var retryStamp: String?
    private var dockRepairWindow = CodexProfileDockRepairWindow()
    private var dockRepairInFlight = false
    private var dockRepairLifetime = CodexProfileDockRepairLifetime()
    private let dockRepairQueue = DispatchQueue(label: "local.quotapie.profile-dock-repair", qos: .utility)
    private let snapshotKey = "local.quotapie.profile-recovery.snapshot.v1"
    private let loginKey = "local.quotapie.profile-recovery.login.v1"

    init(profiles: @escaping () -> [CodexDesktopProfile], appURL: @escaping () -> URL? = CodexProfileLauncher.appURL,
         defaults: UserDefaults? = nil, installShortcuts: Bool = false) {
        self.profiles = profiles; self.appURL = appURL
        self.defaults = defaults; self.installShortcuts = installShortcuts
    }
    func start() {
        guard timer == nil else { return }
        shuttingDown = false
        dockRepairLifetime = CodexProfileDockRepairLifetime()
        dockRepairWindow = CodexProfileDockRepairWindow()
        if let defaults {
            let boot = CodexProfileLoginRecovery.bootID()
            let saved = defaults.dictionary(forKey: loginKey)
            loginRecovery = CodexProfileLoginRecovery(boot: boot, savedBoot: saved?["boot"] as? String,
                savedPending: saved?["pending"] as? [String] ?? [], profiles: profiles())
            if let data = defaults.data(forKey: snapshotKey),
               let snapshot = try? JSONDecoder().decode(Snapshot.self, from: data), snapshot.boot == boot {
                _ = recovery.observe(stamp: snapshot.stamp, instances: snapshot.instances,
                                     profiles: profiles(), now: snapshot.checkedAt)
            }
        }
        powerObserver = NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.willPowerOffNotification,
            object: nil, queue: .main) { [weak self] _ in self?.stop() }
        poll()
        timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in self?.poll() }
        if let timer { RunLoop.main.add(timer, forMode: .common) }
    }
    func stop() {
        shuttingDown = true
        dockRepairLifetime.cancel()
        dockRepairInFlight = false
        timer?.invalidate(); timer = nil
        if let powerObserver { NSWorkspace.shared.notificationCenter.removeObserver(powerObserver) }
        powerObserver = nil
    }
    deinit { stop() }

    private func poll() {
        guard !shuttingDown, let url = appURL(), let executable = Bundle(url: url)?.executableURL,
              let stamp = Self.applicationStamp(url) else { return }
        if retryStamp != stamp { retryAfter.removeAll(); retryStamp = stamp }
        let apps = NSWorkspace.shared.runningApplications.filter {
            $0.executableURL?.standardizedFileURL == executable.standardizedFileURL
        }
        let instances = apps.compactMap { app -> CodexProfileUpdateRecovery.Instance? in
            // Codex explicitly sets Electron userData from the environment;
            // retained argv alone cannot prove isolation after a relaunch.
            guard let identity = CodexProcessIdentity.read(pid: app.processIdentifier, environmentOnly: true), let date = app.launchDate else { return nil }
            return .init(pid: app.processIdentifier, identity: identity, launchedAt: date,
                         intendedAppData: CodexProcessIdentity.read(pid: app.processIdentifier, environmentOnly: false)?.appData)
        }
        let now = Date()
        let registered = profiles()
        if installShortcuts, !dockRepairInFlight, dockRepairWindow.shouldCheck(stamp: stamp, now: now) {
            dockRepairInFlight = true
            let lifetime = dockRepairLifetime
            dockRepairQueue.async { [weak self] in
                let result = Result {
                    try CodexProfileDockRepair.repair(profiles: registered, appURL: url,
                                                     shouldProceed: { lifetime.isActive })
                }
                DispatchQueue.main.async {
                    guard let self, self.dockRepairLifetime === lifetime, lifetime.isActive else { return }
                    self.dockRepairInFlight = false
                    switch result {
                    case .success(let count) where count > 0:
                        self.logger.notice("Removed \(count) duplicate vendor Dock pins; running account apps were preserved")
                    case .failure:
                        self.logger.error("Could not reconcile duplicate Dock pins; existing account apps were preserved")
                    default: break
                    }
                }
            }
        }
        var actions = recovery.observe(stamp: stamp, instances: instances, profiles: registered, now: now)
        // Retained argv proves which isolated data folder was requested, even
        // though it cannot prove the app actually used it after env loss.
        for profile in registered where profile.id != "primary" {
            let broken = instances.filter { !$0.identity.matches(profile)
                && $0.intendedAppData == CodexDesktopProfile.canonical(profile.appData) }
            if !broken.isEmpty {
                actions.stopDuplicate += broken.map(\.pid)
                if !actions.reopen.contains(profile) { actions.reopen.append(profile) }
            }
        }
        if var login = loginRecovery {
            actions.stopDuplicate += login.duplicatePrimaryPIDs(instances: instances, profiles: registered,
                withinBootRestoration: ProcessInfo.processInfo.systemUptime < 180)
            for profile in login.reconcile(instances: instances, profiles: registered)
                where !actions.reopen.contains(profile) { actions.reopen.append(profile) }
            loginRecovery = login
            defaults?.set(["boot": login.boot, "pending": login.pending.sorted()], forKey: loginKey)
        }
        actions.stopDuplicate = Array(Set(actions.stopDuplicate))
        if now.timeIntervalSince(lastSaved) >= 5, let defaults {
            if let data = try? JSONEncoder().encode(Snapshot(boot: CodexProfileLoginRecovery.bootID(),
                stamp: stamp, instances: instances, checkedAt: now)) { defaults.set(data, forKey: snapshotKey) }
            lastSaved = now
        }
        if installShortcuts {
            for profile in registered {
                do { _ = try CodexProfileShortcut.install(profile, target: url) }
                catch { logger.error("Could not update the fixed profile launcher") }
            }
        }
        // Graceful quit only; never force-kill an unknown or existing primary.
        for pid in actions.stopDuplicate {
            if let app = apps.first(where: { $0.processIdentifier == pid }), app.terminate() {
                logger.notice("Closing an unconfigured duplicate after executable replacement")
            }
        }
        guard actions.stopDuplicate.isEmpty else { return }
        for profile in actions.reopen where !opening.contains(profile.id) && (retryAfter[profile.id] ?? .distantPast) <= now {
            opening.insert(profile.id)
            launcher.open(profile, appURL: url, activate: false) { [weak self] result in
                guard let self else { return }
                self.opening.remove(profile.id)
                if case .failure(let error) = result, (error as? ProfileError) == .identity {
                    self.retryAfter[profile.id] = .distantFuture
                    self.logger.error("Profile isolation could not be verified; automatic relaunch is suspended")
                } else { self.retryAfter[profile.id] = Date().addingTimeInterval(10) }
                if case .failure = result { self.logger.error("Profile restoration failed") }
                else { self.logger.notice("Restored isolated profile after executable replacement") }
            }
        }
    }

    /// Electron updates can replace app.asar while retaining the native binary.
    /// Watch the bundle metadata and app resources as well as the executable.
    static func applicationStamp(_ app: URL) -> String? {
        guard let executable = Bundle(url: app)?.executableURL else { return nil }
        return [executable, app.appendingPathComponent("Contents/Info.plist"),
                app.appendingPathComponent("Contents/Resources/app.asar")].map { path in
            guard let a = try? FileManager.default.attributesOfItem(atPath: path.path) else { return "missing" }
            return "\(a[.systemFileNumber] ?? 0):\(a[.modificationDate] ?? ""): \(a[.size] ?? 0)"
        }.joined(separator: "|")
    }
}
