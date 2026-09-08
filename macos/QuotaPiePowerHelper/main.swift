import Foundation
import Darwin
import IOKit.ps
import PowerCore

// This root helper accepts no commands, paths, pmset arguments, or scripts from
// the user. Its only input is a bounded, fresh heartbeat owned by one fixed UID.
let label = "local.quotapie.power"
let marker = "/var/db/\(label).owned"
let statusPath = "/var/run/\(label).json"
func command(_ executable: String, _ arguments: [String]) -> (Int32, String) {
    let process = Process(); let pipe = Pipe()
    process.executableURL = URL(fileURLWithPath: executable)
    process.arguments = arguments; process.standardOutput = pipe; process.standardError = FileHandle.nullDevice
    do { try process.run() } catch { return (-1, "") }
    let data = pipe.fileHandleForReading.readDataToEndOfFile(); process.waitUntilExit()
    return (process.terminationStatus, String(decoding: data, as: UTF8.self))
}
func disabled() -> Bool? {
    let (code, output) = command("/usr/bin/pmset", ["-g"])
    guard code == 0 else { return nil }
    for line in output.split(separator: "\n") {
        let fields = line.split(whereSeparator: { $0.isWhitespace })
        if fields.first == "SleepDisabled", fields.count > 1 { return fields[1] == "1" }
    }
    return nil
}
func writeStatus(_ state: String) {
    let payload: [String: Any] = ["state": state, "updatedAt": Date().timeIntervalSince1970]
    if let data = try? JSONSerialization.data(withJSONObject: payload) {
        try? data.write(to: URL(fileURLWithPath: statusPath), options: .atomic)
        chmod(statusPath, 0o644)
    }
}
func restore() -> Bool {
    guard FileManager.default.fileExists(atPath: marker) else { return true }
    guard command("/usr/bin/pmset", ["-a", "disablesleep", "0"]).0 == 0, disabled() == false else {
        writeStatus("restore-failed"); return false
    }
    try? FileManager.default.removeItem(atPath: marker)
    return true
}
if CommandLine.arguments.dropFirst().first == "--probe" {
    print(disabled().map { $0 ? "disabled" : "allowed" } ?? "unknown"); exit(0)
}
guard geteuid() == 0 else { fputs("Administrator installation is required.\n", stderr); exit(1) }
if CommandLine.arguments.dropFirst().first == "--restore" { exit(restore() ? 0 : 1) }
guard CommandLine.arguments.count == 2, let uid = UInt32(CommandLine.arguments[1]), uid >= 501,
      let user = getpwuid(uid) else { exit(64) }
let home = String(cString: user.pointee.pw_dir)
let heartbeatPath = home + "/Library/Application Support/QuotaPie/awake-heartbeat.json"
func heartbeat() -> PowerHeartbeat? {
    let fd = open(heartbeatPath, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
    guard fd >= 0 else { return nil }; defer { close(fd) }
    var info = stat()
    guard fstat(fd, &info) == 0, info.st_uid == uid, info.st_mode & S_IFMT == S_IFREG,
          info.st_mode & 0o777 == 0o600, info.st_nlink == 1, info.st_size > 0, info.st_size <= 4096 else { return nil }
    var bytes = [UInt8](repeating: 0, count: Int(info.st_size))
    guard read(fd, &bytes, bytes.count) == bytes.count else { return nil }
    return try? JSONDecoder().decode(PowerHeartbeat.self, from: Data(bytes))
}
func alive(_ pid: Int32) -> Bool {
    guard pid > 1 else { return false }
    let (_, owner) = command("/bin/ps", ["-p", String(pid), "-o", "uid="])
    guard owner.trimmingCharacters(in: .whitespacesAndNewlines) == String(uid) else { return false }
    var buffer = [CChar](repeating: 0, count: 4 * Int(MAXPATHLEN))
    guard proc_pidpath(pid, &buffer, UInt32(buffer.count)) > 0 else { return false }
    // A same-user process can only request the two fixed power states; it can
    // never make the helper execute something as root.
    return URL(fileURLWithPath: String(cString: buffer)).lastPathComponent == "QuotaPie"
}
func safePower() -> Bool {
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
// Recover the owned state before accepting new work, including after SIGKILL
// or reboot. Never take ownership of another utility's existing override.
guard restore() else { exit(1) }
var runStart: Double?
var exhausted = false
signal(SIGTERM, SIG_IGN); signal(SIGINT, SIG_IGN)
let term = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
term.setEventHandler { _ = restore(); writeStatus("stopped"); exit(0) }; term.resume()
let interrupt = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
interrupt.setEventHandler { _ = restore(); writeStatus("stopped"); exit(0) }; interrupt.resume()
let timer = DispatchSource.makeTimerSource(queue: .main)
timer.schedule(deadline: .now(), repeating: 2)
timer.setEventHandler {
    let now = Date().timeIntervalSince1970
    let h = heartbeat()
    let request = h.map { $0.requested && $0.isFresh(now: now, processAlive: alive($0.pid)) } ?? false
    if !request { runStart = nil; exhausted = false }
    if request && runStart == nil { runStart = ProcessInfo.processInfo.systemUptime }
    if let start = runStart, ProcessInfo.processInfo.systemUptime - start >= 8 * 3600 { exhausted = true }
    let safe = safePower()
    if !request || !safe || exhausted {
        if restore() { writeStatus(exhausted ? "time-limit" : !safe ? "power-limit" : "ready") }
        return
    }
    if FileManager.default.fileExists(atPath: marker) {
        writeStatus(disabled() == true ? "holding" : "override-lost"); return
    }
    guard disabled() == false else { writeStatus("external-override"); return }
    // Durable ownership precedes mutation so a crash between either operation
    // still restores normal sleep on the next launchd start.
    do { try Data("owned\n".utf8).write(to: URL(fileURLWithPath: marker), options: .atomic); chmod(marker, 0o600) }
    catch { writeStatus("ownership-failed"); return }
    if command("/usr/bin/pmset", ["-a", "disablesleep", "1"]).0 == 0, disabled() == true {
        writeStatus("holding")
    } else { _ = restore(); writeStatus("enable-failed") }
}
timer.resume()
RunLoop.main.run()
