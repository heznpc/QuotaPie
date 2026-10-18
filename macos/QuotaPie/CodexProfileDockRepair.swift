import CoreFoundation
import Darwin
import Foundation

/// Repairs only duplicate pins for the selected vendor bundle. This does not
/// identify, launch, terminate or change either running profile application.
final class CodexProfileDockRepair {
    enum Failure: Error, Equatable {
        case preferencesUnavailable, invalidSnapshot, snapshotChanged
        case backupFailed, writeFailed, verificationFailed, dockRestartFailed
        case cancelled
    }

    struct IO {
        var bundleIdentifier: (URL) -> String?
        var readPins: () throws -> [Any]?
        var backup: ([Any]) throws -> Void
        var writePins: ([Any]) throws -> Void
        var restartDock: () throws -> Void

        static var live: Self {
            let domain = "com.apple.dock" as CFString
            let key = "persistent-apps" as CFString
            return Self(bundleIdentifier: { Bundle(url: $0)?.bundleIdentifier }, readPins: {
                guard CFPreferencesSynchronize(domain, kCFPreferencesCurrentUser, kCFPreferencesAnyHost) else {
                    throw Failure.preferencesUnavailable
                }
                guard let value = CFPreferencesCopyValue(key, domain, kCFPreferencesCurrentUser, kCFPreferencesAnyHost) else { return nil }
                guard let pins = value as? [Any] else { throw Failure.invalidSnapshot }
                return pins
            }, backup: { try saveBackup($0) }, writePins: { pins in
                CFPreferencesSetValue(key, pins as CFArray, domain, kCFPreferencesCurrentUser, kCFPreferencesAnyHost)
                guard CFPreferencesSynchronize(domain, kCFPreferencesCurrentUser, kCFPreferencesAnyHost) else {
                    throw Failure.writeFailed
                }
            }, restartDock: {
                let process = Process()
                process.executableURL = URL(fileURLWithPath: "/bin/launchctl")
                process.arguments = ["kickstart", "-k", "gui/\(getuid())/com.apple.Dock.agent"]
                process.standardOutput = FileHandle.nullDevice
                process.standardError = FileHandle.nullDevice
                do { try process.run() } catch { throw Failure.dockRestartFailed }
                process.waitUntilExit()
                guard process.terminationStatus == 0 else { throw Failure.dockRestartFailed }
            })
        }
    }

    private static let lock = NSLock()
    private static let vendorID = "com.openai.codex"

    /// Call from a background queue. Zero means no change was needed. The
    /// before-write snapshot check is deliberately narrow: CFPreferences has
    /// no cross-process atomic CAS, so a post-write check is also required.
    @discardableResult
    static func repair(profiles: [CodexDesktopProfile], appURL: URL,
                       shouldProceed: () -> Bool = { true }, io: IO = .live) throws -> Int {
        guard shouldProceed() else { throw Failure.cancelled }
        guard profiles.contains(where: { $0.id == "primary" }),
              profiles.contains(where: { !$0.id.isEmpty && $0.id != "primary" }),
              appURL.isFileURL else { return 0 }
        lock.lock(); defer { lock.unlock() }
        guard shouldProceed() else { throw Failure.cancelled }
        let vendorURL = appURL.standardizedFileURL.resolvingSymlinksInPath()
        guard io.bundleIdentifier(vendorURL) == vendorID else { return 0 }
        guard let pins = try io.readPins() else { return 0 }
        let original = try immutablePins(pins)
        let proposed = deduplicatedPins(original, vendorURL: vendorURL)
        let removed = original.count - proposed.count
        guard removed > 0 else { return 0 }

        // Retain the exact original key before any mutation. If the user moves
        // a pin during backup, leave their new layout intact and retry later.
        guard shouldProceed() else { throw Failure.cancelled }
        do { try io.backup(original) } catch { throw Failure.backupFailed }
        guard let current = try io.readPins(), equal(current, original),
              io.bundleIdentifier(vendorURL) == vendorID else { throw Failure.snapshotChanged }
        guard shouldProceed() else { throw Failure.cancelled }
        try io.writePins(proposed)
        guard let persisted = try io.readPins(), equal(persisted, proposed) else {
            // Never roll back over an intervening Dock/user edit. The original
            // snapshot remains available in the private backup directory.
            throw Failure.verificationFailed
        }
        // A lifecycle cancellation after persistence must not restart Dock or
        // roll back over subsequent user changes to its layout.
        guard shouldProceed() else { throw Failure.cancelled }
        try io.restartDock()
        return removed
    }

    /// Preserve the first matching tile byte-for-byte as a property list value;
    /// every unrelated app, launcher and unknown tile keeps its order and data.
    static func deduplicatedPins(_ pins: [Any], vendorURL: URL) -> [Any] {
        guard vendorURL.isFileURL else { return pins }
        let vendorPath = vendorURL.standardizedFileURL.resolvingSymlinksInPath().path
        var found = false
        return pins.filter { raw in
            guard let tile = raw as? [String: Any], tile["tile-type"] as? String == "file-tile",
                  let data = tile["tile-data"] as? [String: Any], data["bundle-identifier"] as? String == vendorID,
                  let file = data["file-data"] as? [String: Any], file["_CFURLStringType"] as? Int == 15,
                  let text = file["_CFURLString"] as? String, let url = URL(string: text), url.isFileURL,
                  (url.host == nil || url.host == "" || url.host?.lowercased() == "localhost"),
                  url.query == nil, url.fragment == nil,
                  url.standardizedFileURL.resolvingSymlinksInPath().path == vendorPath else { return true }
            if found { return false }
            found = true
            return true
        }
    }

    private static func equal(_ left: [Any], _ right: [Any]) -> Bool {
        NSArray(array: left).isEqual(to: right)
    }

    private static func immutablePins(_ pins: [Any]) throws -> [Any] {
        do {
            let bytes = try PropertyListSerialization.data(fromPropertyList: pins, format: .binary, options: 0)
            guard let value = try PropertyListSerialization.propertyList(from: bytes, options: [], format: nil) as? [Any] else {
                throw Failure.invalidSnapshot
            }
            return value
        } catch { throw Failure.invalidSnapshot }
    }

    private static func saveBackup(_ pins: [Any]) throws {
        let manager = FileManager.default
        let directory = manager.homeDirectoryForCurrentUser.appendingPathComponent(".local/share/quotapie/dock-backups", isDirectory: true)
        try manager.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let attributes = try manager.attributesOfItem(atPath: directory.path)
        guard attributes[.type] as? FileAttributeType == .typeDirectory else { throw Failure.backupFailed }
        try manager.setAttributes([.posixPermissions: 0o700], ofItemAtPath: directory.path)
        let data = try PropertyListSerialization.data(fromPropertyList: ["persistent-apps": pins], format: .binary, options: 0)
        let file = directory.appendingPathComponent("codex-dock-\(UUID().uuidString).plist")
        let fd = Darwin.open(file.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, mode_t(0o600))
        guard fd >= 0 else { throw Failure.backupFailed }
        let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
        defer { try? handle.close() }
        try handle.write(contentsOf: data)
        try handle.synchronize()
    }
}
