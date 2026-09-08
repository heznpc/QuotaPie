import Foundation

public struct AwakeEvent: Codable {
    public let version: Int
    public let provider: String
    public let working: Bool
    public let pid: Int32
    public let updatedAt: Double
    public let expiresAt: Double

    public func isWorking(now: Double, processAlive: Bool) -> Bool {
        version == 1 && ["codex", "claude"].contains(provider) && working && pid > 1 && processAlive
            && updatedAt <= now + 5 && now - updatedAt <= 1800
            && expiresAt > now && expiresAt <= updatedAt + 1800
    }
}

public struct PowerHeartbeat: Codable {
    public let version: Int
    public let pid: Int32
    public let updatedAt: Double
    public let requested: Bool
    public init(pid: Int32, updatedAt: Double, requested: Bool) {
        version = 1; self.pid = pid; self.updatedAt = updatedAt; self.requested = requested
    }
    public func isFresh(now: Double, processAlive: Bool) -> Bool {
        version == 1 && pid > 1 && processAlive && updatedAt <= now + 5 && now - updatedAt < 30
    }
}

public enum PowerGate {
    public static func permitsWork(batteryPercent: Int?, onBattery: Bool, thermalSerious: Bool) -> Bool {
        !thermalSerious && (!onBattery || (batteryPercent.map { $0 > 20 } ?? false))
    }
}
