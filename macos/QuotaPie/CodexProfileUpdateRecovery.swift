import AppKit
import Foundation
import OSLog

/// Recovery is armed only by replacement of the installed executable, never by
/// a normal quit. Keep the primary process as the anchor when an updater starts
/// a second, unconfigured copy of the same application.
struct CodexProfileUpdateRecovery {
    struct Instance {
        let pid: pid_t
        let identity: CodexProcessIdentity
        let launchedAt: Date
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

final class CodexProfileUpdateMonitor {
    private var recovery = CodexProfileUpdateRecovery()
    private var timer: Timer?
    private var opening: Set<String> = []
    private var retryAfter: [String: Date] = [:]
    private let launcher = CodexProfileLauncher()
    private let logger = Logger(subsystem: "local.quotapie.menubar", category: "ProfileUpdateRecovery")
    private let profiles: () -> [CodexDesktopProfile]
    private let appURL: () -> URL?

    init(profiles: @escaping () -> [CodexDesktopProfile], appURL: @escaping () -> URL? = CodexProfileLauncher.appURL) {
        self.profiles = profiles; self.appURL = appURL
    }
    func start() {
        guard timer == nil else { return }
        poll()
        timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in self?.poll() }
        if let timer { RunLoop.main.add(timer, forMode: .common) }
    }
    func stop() { timer?.invalidate(); timer = nil }
    deinit { timer?.invalidate() }

    private func poll() {
        guard let url = appURL(), let executable = Bundle(url: url)?.executableURL,
              let attributes = try? FileManager.default.attributesOfItem(atPath: executable.path),
              let inode = attributes[.systemFileNumber] as? NSNumber,
              let modified = attributes[.modificationDate] as? Date,
              let size = attributes[.size] as? NSNumber else { return }
        let apps = NSWorkspace.shared.runningApplications.filter {
            $0.executableURL?.standardizedFileURL == executable.standardizedFileURL
        }
        let instances = apps.compactMap { app -> CodexProfileUpdateRecovery.Instance? in
            // Codex explicitly sets Electron userData from the environment;
            // retained argv alone cannot prove isolation after a relaunch.
            guard let identity = CodexProcessIdentity.read(pid: app.processIdentifier, environmentOnly: true), let date = app.launchDate else { return nil }
            return .init(pid: app.processIdentifier, identity: identity, launchedAt: date)
        }
        let now = Date()
        let actions = recovery.observe(stamp: "\(inode):\(modified.timeIntervalSince1970):\(size)",
                                       instances: instances, profiles: profiles(), now: now)
        // Graceful quit only; never force-kill an unknown or existing primary.
        for pid in actions.stopDuplicate {
            if let app = apps.first(where: { $0.processIdentifier == pid }), app.terminate() {
                logger.notice("Closing an unconfigured duplicate after executable replacement")
            }
        }
        guard actions.stopDuplicate.isEmpty else { return }
        for profile in actions.reopen where !opening.contains(profile.id) && (retryAfter[profile.id] ?? .distantPast) <= now {
            opening.insert(profile.id)
            launcher.open(profile, appURL: url) { [weak self] result in
                guard let self else { return }
                self.opening.remove(profile.id)
                self.retryAfter[profile.id] = Date().addingTimeInterval(10)
                if case .failure = result { self.logger.error("Profile restoration after update failed; will retry") }
                else { self.logger.notice("Restored isolated profile after executable replacement") }
            }
        }
    }
}
