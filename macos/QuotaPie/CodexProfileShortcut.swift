import AppKit
import Foundation

/// A Dock entry owns a fixed profile, rather than relying on one launch's argv.
/// The vendor bundle is never copied or modified. This small launcher always
/// opens the latest installed vendor app with both isolation paths.
enum CodexProfileShortcut {
    struct Descriptor: Codable, Equatable {
        let profile: CodexDesktopProfile
        let targetApp: String
    }
    static let prefix = "local.quotapie.profile-launcher."
    static var directory: URL {
        FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Applications/QuotaPie Profiles")
    }
    static func url(for profile: CodexDesktopProfile, root: URL = directory) -> URL {
        root.appendingPathComponent(profile.id + ".app")
    }

    static func install(_ profile: CodexDesktopProfile, target: URL,
                        root: URL = directory, source: URL = Bundle.main.bundleURL) throws -> URL {
        try CodexDesktopProfile.validate([profile])
        guard profile.id.range(of: "^[a-zA-Z0-9-]{1,80}$", options: .regularExpression) != nil,
              let binary = Bundle(url: source)?.executableURL else { throw ProfileError.paths }
        let fm = FileManager.default
        let descriptor = Descriptor(profile: profile, targetApp: target.path)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let encoded = try encoder.encode(descriptor).base64EncodedString()
        let attributes = try fm.attributesOfItem(atPath: binary.path)
        let version = "\(attributes[.systemFileNumber] ?? 0):\(attributes[.modificationDate] ?? ""): \(attributes[.size] ?? 0)"
        let destination = url(for: profile, root: root)
        let installedInfo = (try? Data(contentsOf: destination.appendingPathComponent("Contents/Info.plist")))
            .flatMap { try? PropertyListSerialization.propertyList(from: $0, options: [], format: nil) as? [String: Any] }
        // Bundle caches metadata by path; read the file so an atomic replacement
        // does not make every subsequent monitor tick rebuild this launcher.
        if let info = installedInfo,
           info["QuotaPieProfile"] as? String == encoded,
           info["QuotaPieLauncherSource"] as? String == version { return destination }
        if fm.fileExists(atPath: destination.path),
           installedInfo?["CFBundleIdentifier"] as? String != prefix + profile.id { throw ProfileError.paths }
        try fm.createDirectory(at: root, withIntermediateDirectories: true)
        let staging = root.appendingPathComponent("." + UUID().uuidString + ".app")
        defer { try? fm.removeItem(at: staging) }
        let contents = staging.appendingPathComponent("Contents")
        let macos = contents.appendingPathComponent("MacOS")
        let resources = contents.appendingPathComponent("Resources")
        try fm.createDirectory(at: macos, withIntermediateDirectories: true)
        try fm.createDirectory(at: resources, withIntermediateDirectories: true)
        try fm.copyItem(at: binary, to: macos.appendingPathComponent("ProfileLauncher"))
        for language in ["en", "ko"] {
            let localization = source.appendingPathComponent("Contents/Resources/\(language).lproj")
            if fm.fileExists(atPath: localization.path) {
                try fm.copyItem(at: localization, to: resources.appendingPathComponent("\(language).lproj"))
            }
        }
        var info: [String: Any] = [
            "CFBundleIdentifier": prefix + profile.id, "CFBundleExecutable": "ProfileLauncher",
            "CFBundleName": "Codex · " + profile.name, "CFBundleDisplayName": "Codex · " + profile.name,
            "CFBundlePackageType": "APPL", "LSMinimumSystemVersion": "13.0", "LSUIElement": true,
            "QuotaPieProfileLauncherVersion": 1, "QuotaPieProfile": encoded, "QuotaPieLauncherSource": version,
        ]
        if let iconName = Bundle(url: target)?.object(forInfoDictionaryKey: "CFBundleIconFile") as? String {
            let icon = target.appendingPathComponent("Contents/Resources/" + (iconName.hasSuffix(".icns") ? iconName : iconName + ".icns"))
            if fm.fileExists(atPath: icon.path) {
                try fm.copyItem(at: icon, to: resources.appendingPathComponent("Profile.icns"))
                info["CFBundleIconFile"] = "Profile.icns"
            }
        }
        try PropertyListSerialization.data(fromPropertyList: info, format: .xml, options: 0)
            .write(to: contents.appendingPathComponent("Info.plist"), options: .atomic)
        let signing = Process()
        signing.executableURL = URL(fileURLWithPath: "/usr/bin/codesign")
        signing.arguments = ["--force", "--sign", "-", "--timestamp=none", staging.path]
        signing.standardOutput = FileHandle.nullDevice; signing.standardError = FileHandle.nullDevice
        try signing.run(); signing.waitUntilExit()
        guard signing.terminationStatus == 0 else { throw ProfileError.launch }
        if fm.fileExists(atPath: destination.path) {
            _ = try fm.replaceItemAt(destination, withItemAt: staging)
        } else { try fm.moveItem(at: staging, to: destination) }
        return destination
    }

    /// Runs before the menu-bar instance lock. A profile shortcut is a transient
    /// launch request; it must never replace or terminate the user's meter.
    static func runIfNeeded() -> Bool {
        guard Bundle.main.bundleIdentifier?.hasPrefix(prefix) == true else { return false }
        guard Bundle.main.object(forInfoDictionaryKey: "QuotaPieProfileLauncherVersion") as? Int == 1,
              let value = Bundle.main.object(forInfoDictionaryKey: "QuotaPieProfile") as? String,
              let data = Data(base64Encoded: value),
              let descriptor = try? JSONDecoder().decode(Descriptor.self, from: data),
              Bundle.main.bundleIdentifier == prefix + descriptor.profile.id,
              (try? CodexDesktopProfile.validate([descriptor.profile])) != nil else { return true }
        let target = URL(fileURLWithPath: descriptor.targetApp)
        let targetID = Bundle(url: target)?.bundleIdentifier ?? ""
        var allowed = targetID == "com.openai.codex"
#if DEBUG
        allowed = allowed || targetID.hasPrefix("local.quotapie.profile-fixture.")
#endif
        guard allowed else { return true }
        if targetID == "com.openai.codex" {
            guard let defaults = UserDefaults(suiteName: "local.quotapie.menubar"),
                  let saved = defaults.data(forKey: "local.quotapie.codex-desktop-profiles.v1"),
                  let profiles = try? JSONDecoder().decode([CodexDesktopProfile].self, from: saved),
                  profiles.contains(where: { $0.id == descriptor.profile.id
                      && CodexDesktopProfile.canonical($0.codexHome) == CodexDesktopProfile.canonical(descriptor.profile.codexHome)
                      && CodexDesktopProfile.canonical($0.appData) == CodexDesktopProfile.canonical(descriptor.profile.appData) }) else { return true }
        }
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        let launcher = CodexProfileLauncher()
        var resultCode: Int32?
        launcher.open(descriptor.profile, appURL: target) { result in
            if case .success = result { resultCode = 0 } else { resultCode = 1 }
            if app.isRunning {
                app.stop(nil)
                app.postEvent(NSEvent.otherEvent(with: .applicationDefined, location: .zero,
                    modifierFlags: [], timestamp: 0, windowNumber: 0, context: nil,
                    subtype: 0, data1: 0, data2: 0)!, atStart: false)
            }
        }
        // Focusing an existing B completes synchronously. Starting a run loop
        // after that callback would leave an idle launcher alive forever.
        if resultCode == nil { app.run() }
        withExtendedLifetime(launcher) {}
        exit(resultCode ?? 1)
    }
}
