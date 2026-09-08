import XCTest
import PowerCore

final class PowerStateTests: XCTestCase {
    func event(working: Bool = true, pid: Int = 42, updated: Double = 100, expiry: Double = 1900) throws -> AwakeEvent {
        let object: [String: Any] = ["version": 1, "provider": "codex", "working": working,
                                     "pid": pid, "updatedAt": updated, "expiresAt": expiry]
        return try JSONDecoder().decode(AwakeEvent.self, from: JSONSerialization.data(withJSONObject: object))
    }
    func testStoppedDeadExpiredAndFutureEventsCannotHoldPower() throws {
        XCTAssertTrue(try event().isWorking(now: 101, processAlive: true))
        XCTAssertFalse(try event(working: false).isWorking(now: 101, processAlive: true))
        XCTAssertFalse(try event().isWorking(now: 101, processAlive: false))
        XCTAssertFalse(try event().isWorking(now: 1901, processAlive: true))
        XCTAssertFalse(try event(updated: 110).isWorking(now: 100, processAlive: true))
        XCTAssertFalse(try event(expiry: 10000).isWorking(now: 101, processAlive: true))
    }
    func testHelperMustReleaseOnMissingHeartbeatOrDeadApp() {
        let heartbeat = PowerHeartbeat(pid: 42, updatedAt: 100, requested: true)
        XCTAssertTrue(heartbeat.isFresh(now: 129, processAlive: true))
        XCTAssertFalse(heartbeat.isFresh(now: 130, processAlive: true))
        XCTAssertFalse(heartbeat.isFresh(now: 101, processAlive: false))
        XCTAssertFalse(heartbeat.isFresh(now: 90, processAlive: true))
    }
    func testPowerLimitsApplyRegardlessOfWorkingTasks() {
        XCTAssertFalse(PowerGate.permitsWork(batteryPercent: 20, onBattery: true, thermalSerious: false))
        XCTAssertFalse(PowerGate.permitsWork(batteryPercent: nil, onBattery: true, thermalSerious: false))
        XCTAssertFalse(PowerGate.permitsWork(batteryPercent: 100, onBattery: false, thermalSerious: true))
        XCTAssertTrue(PowerGate.permitsWork(batteryPercent: 21, onBattery: true, thermalSerious: false))
        XCTAssertTrue(PowerGate.permitsWork(batteryPercent: nil, onBattery: false, thermalSerious: false))
    }
}
