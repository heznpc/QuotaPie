import AppKit
import OSLog

/// The flock owner also retires older apps which predate the shared lock.
/// Observe launches instead of polling: an old worktree can be opened at any time.
final class MenuBarInstanceGuard {
    private let bundleIdentifier: String
    private let ownerPID = ProcessInfo.processInfo.processIdentifier
    private let workspace: NSWorkspace
    private var launchObserver: NSObjectProtocol?
    private var applicationsObservation: NSKeyValueObservation?
    private let logger = Logger(subsystem: "local.quotapie.menubar", category: "Instance")

    init(bundleIdentifier: String = "local.quotapie.menubar", workspace: NSWorkspace = .shared) {
        self.bundleIdentifier = bundleIdentifier
        self.workspace = workspace
    }

    /// Call only after acquiring SingleInstanceLock, and retain both until exit.
    func start() {
        guard launchObserver == nil else { return }
        // Subscribe before taking the snapshot so launches during startup aren't missed.
        launchObserver = workspace.notificationCenter.addObserver(
            forName: NSWorkspace.didLaunchApplicationNotification, object: nil, queue: .main
        ) { [weak self] notification in
            guard let app = notification.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication else { return }
            self?.retireDuplicate(app)
        }
        // Some legacy bundles are registered before didLaunch is delivered (or
        // never deliver it). KVO also covers this LaunchServices lifecycle path.
        applicationsObservation = workspace.observe(\.runningApplications, options: [.initial, .new]) { [weak self] workspace, _ in
            for app in workspace.runningApplications { self?.retireDuplicate(app) }
        }
    }

    private func retireDuplicate(_ app: NSRunningApplication) {
        guard app.processIdentifier != ownerPID,
              app.bundleIdentifier == bundleIdentifier, !app.isTerminated else { return }
        let pid = app.processIdentifier
        if app.terminate() {
            logger.notice("Requested duplicate menu bar app termination, pid=\(pid)")
        } else {
            logger.error("Duplicate menu bar app rejected termination, pid=\(pid)")
        }
    }

    deinit {
        if let launchObserver { workspace.notificationCenter.removeObserver(launchObserver) }
    }
}
