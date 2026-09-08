import AppKit
import Foundation
import IOKit.pwr_mgt
import IOKit.ps
import PowerCore

final class AwakeController: ObservableObject {
    static let shared = AwakeController()
    @Published var enabled = UserDefaults.standard.bool(forKey: "awake.enabled") {
        didSet { UserDefaults.standard.set(enabled, forKey: "awake.enabled"); refresh() }
    }
    @Published var closedLid = UserDefaults.standard.bool(forKey: "awake.closedLid") {
        didSet { UserDefaults.standard.set(closedLid, forKey: "awake.closedLid"); refresh() }
    }
    @Published private(set) var count = 0
    @Published private(set) var state = "off"
    @Published private(set) var helperState = "not-installed"
    @Published private(set) var busy = false
    @Published var message: String?
    private var timer: Timer?
    private var controllerLock: Int32 = -1
    private var assertion: IOPMAssertionID = 0
    private var hasAssertion = false
    private var lastHeartbeatRequest: Bool?
    private var lastHeartbeatAt: Double = 0
    private var holdStartedAt: TimeInterval?
    private let launchedAt = Date().timeIntervalSince1970
    private let directory = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Library/Application Support/QuotaPie")

    var summary: String {
        if state == "holding" { return Strings.t("awake.holding", String(count)) }
        return Strings.t("awake." + state)
    }
    var lidSummary: String { Strings.t("awake.helper." + helperState) }

    func start() {
        guard timer == nil else { return }
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        controllerLock = open(directory.appendingPathComponent("awake-app.lock").path,
                              O_WRONLY | O_CREAT | O_NOFOLLOW, 0o600)
        guard controllerLock >= 0, flock(controllerLock, LOCK_EX | LOCK_NB) == 0 else {
            if controllerLock >= 0 { close(controllerLock); controllerLock = -1 }
            state = "anotherInstance"; return
        }
        refresh()
        timer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in self?.refresh() }
    }
    func stop() {
        timer?.invalidate(); timer = nil
        releaseAssertion()
        if controllerLock >= 0 {
            writeHeartbeat(false)
            close(controllerLock); controllerLock = -1
        }
    }
    private func releaseAssertion() {
        if hasAssertion { IOPMAssertionRelease(assertion); hasAssertion = false }
    }
    private func readData(_ url: URL, limit: Int = 4096) -> Data? {
        let fd = open(url.path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
        guard fd >= 0 else { return nil }; defer { close(fd) }
        var info = stat()
        guard fstat(fd, &info) == 0, info.st_uid == getuid(), info.st_mode & S_IFMT == S_IFREG,
              info.st_mode & 0o777 == 0o600, info.st_size > 0, info.st_size <= limit else { return nil }
        var bytes = [UInt8](repeating: 0, count: Int(info.st_size))
        guard read(fd, &bytes, bytes.count) == bytes.count else { return nil }
        return Data(bytes)
    }
    private func activeCount(now: Double) -> Int {
        let events = directory.appendingPathComponent("awake-events")
        guard let files = try? FileManager.default.contentsOfDirectory(at: events, includingPropertiesForKeys: nil),
              files.count <= 2048 else { return 0 }
        return files.filter { url in
            guard url.pathExtension == "json", let data = readData(url),
                  let event = try? JSONDecoder().decode(AwakeEvent.self, from: data),
                  event.updatedAt >= launchedAt else { return false }
            return event.isWorking(now: now, processAlive: event.pid > 1 && kill(event.pid, 0) == 0)
        }.count
    }
    private func safePower() -> Bool {
        let info = IOPSCopyPowerSourcesInfo().takeRetainedValue()
        let onBattery = IOPSGetProvidingPowerSourceType(info).takeUnretainedValue() as String == kIOPSBatteryPowerValue
        let sources = IOPSCopyPowerSourcesList(info).takeRetainedValue() as [CFTypeRef]
        var percent: Int?
        for source in sources {
            if let d = IOPSGetPowerSourceDescription(info, source)?.takeUnretainedValue() as? [String: Any],
               let current = d[kIOPSCurrentCapacityKey] as? Int, let max = d[kIOPSMaxCapacityKey] as? Int, max > 0 {
                percent = current * 100 / max
            }
        }
        let thermal = ProcessInfo.processInfo.thermalState
        return PowerGate.permitsWork(batteryPercent: percent, onBattery: onBattery,
                                     thermalSerious: thermal == .serious || thermal == .critical)
    }
    private func readHelperStatus(now: Double) {
        guard let data = try? Data(contentsOf: URL(fileURLWithPath: "/var/run/local.quotapie.power.json")),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let date = object["updatedAt"] as? Double, date <= now + 5, now - date < 10,
              let value = object["state"] as? String else { helperState = "not-installed"; return }
        let known = ["ready", "holding", "power-limit", "time-limit", "external-override", "restore-failed",
                     "enable-failed", "ownership-failed", "override-lost", "stopped"]
        helperState = known.contains(value) ? value : "not-installed"
    }
    private func writeHeartbeat(_ requested: Bool) {
        let now = Date().timeIntervalSince1970
        if lastHeartbeatRequest == requested && (!requested || now - lastHeartbeatAt < 10) { return }
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            let url = directory.appendingPathComponent("awake-heartbeat.json")
            let data = try JSONEncoder().encode(PowerHeartbeat(pid: getpid(), updatedAt: Date().timeIntervalSince1970,
                                                              requested: requested))
            // Atomic replacement prevents partial JSON; permissions set before
            // rename so the root helper never consumes a broad-permission file.
            let temp = directory.appendingPathComponent(".awake-\(UUID().uuidString).tmp")
            guard FileManager.default.createFile(atPath: temp.path, contents: data,
                                                  attributes: [.posixPermissions: 0o600]) else { return }
            if rename(temp.path, url.path) != 0 { try? FileManager.default.removeItem(at: temp) }
            else { lastHeartbeatRequest = requested; lastHeartbeatAt = now }
        } catch { message = Strings.t("awake.writeFailed") }
    }
    func refresh() {
        guard controllerLock >= 0 else { return }
        let now = Date().timeIntervalSince1970
        count = activeCount(now: now)
        readHelperStatus(now: now)
        let safe = safePower()
        if !enabled || count == 0 { holdStartedAt = nil }
        if enabled && count > 0 && holdStartedAt == nil { holdStartedAt = ProcessInfo.processInfo.systemUptime }
        let expired = holdStartedAt.map { ProcessInfo.processInfo.systemUptime - $0 >= 8 * 3600 } ?? false
        let requested = enabled && count > 0 && safe && !expired
        if requested && !hasAssertion {
            hasAssertion = IOPMAssertionCreateWithName(kIOPMAssertionTypePreventUserIdleSystemSleep as CFString,
                IOPMAssertionLevel(kIOPMAssertionLevelOn), "QuotaPie: coding tasks are working" as CFString,
                &assertion) == kIOReturnSuccess
        } else if !requested { releaseAssertion() }
        state = !enabled ? "off" : expired ? "timeLimit" : !safe ? "powerLimit" : count == 0 ? "waiting" : hasAssertion ? "holding" : "failed"
        writeHeartbeat(requested && closedLid)
    }
    func connectAgents() { runCLI(["awake", "connect"]) }
    func disconnectAgents() { enabled = false; runCLI(["awake", "disconnect"]) }
    private func runCLI(_ arguments: [String]) {
        guard !busy else { return }; busy = true; message = nil
        let executable = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".local/bin/quotapie")
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            let process = Process(); process.executableURL = executable; process.arguments = arguments
            process.standardOutput = FileHandle.nullDevice; process.standardError = FileHandle.nullDevice
            var success = false
            do { try process.run(); process.waitUntilExit(); success = process.terminationStatus == 0 } catch {}
            DispatchQueue.main.async {
                self?.busy = false
                self?.message = Strings.t(success ? (arguments.last == "connect" ? "awake.connected" : "awake.disconnected") : "awake.connectFailed")
            }
        }
    }
    func installHelper(remove: Bool = false) {
        guard !busy else { return }; busy = true; message = nil
        let resources = Bundle.main.resourceURL!
        let script = resources.appendingPathComponent("install_power_helper.sh").path
        let binary = Bundle.main.bundleURL.appendingPathComponent("Contents/Helpers/QuotaPiePowerHelper").path
        func quote(_ text: String) -> String { "'" + text.replacingOccurrences(of: "'", with: "'\"'\"'") + "'" }
        let command = "/bin/bash \(quote(script)) \(remove ? "uninstall" : "install") \(getuid()) \(quote(binary))"
        let literal = command.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"")
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            var error: NSDictionary?
            let result = NSAppleScript(source: "do shell script \"\(literal)\" with administrator privileges")?.executeAndReturnError(&error)
            let success = result != nil && error == nil
            DispatchQueue.main.async {
                self?.busy = false
                if success { self?.closedLid = !remove }
                self?.message = Strings.t(success ? "awake.helperInstalled" : "awake.helperFailed")
                self?.refresh()
            }
        }
    }
}
