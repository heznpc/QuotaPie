import Foundation
import IOKit
import IOKit.pwr_mgt

/// Observes early wake without delaying or vetoing sleep. The power callback
/// acknowledges sleep immediately; it never waits for the UI, HTTP, or a lock.
final class SystemWakeMonitor {
    enum Action: Equatable { case allowSleep, willSleep, earlyWake, poweredOn, ignore }
    private var root: io_connect_t = 0
    private var port: IONotificationPortRef?
    private var notifier: io_object_t = 0
    private let queue = DispatchQueue(label: "local.quotapie.power-observer", qos: .userInitiated)
    private let onWake: (String, Double) -> Void
    private let onSleep: () -> Void

    init(onSleep: @escaping () -> Void, onWake: @escaping (String, Double) -> Void) {
        self.onSleep = onSleep
        self.onWake = onWake
    }

    @discardableResult func start() -> Bool {
        guard root == 0 else { return true }
        root = IORegisterForSystemPower(Unmanaged.passUnretained(self).toOpaque(), &port, { context, _, type, argument in
            guard let context else { return }
            Unmanaged<SystemWakeMonitor>.fromOpaque(context).takeUnretainedValue().receive(type, argument)
        }, &notifier)
        guard root != 0, let port else { stop(); return false }
        IONotificationPortSetDispatchQueue(port, queue)
        return true
    }

    func stop() {
        if let port { IONotificationPortSetDispatchQueue(port, nil) }
        queue.sync {}
        if notifier != 0 { IODeregisterForSystemPower(&notifier); notifier = 0 }
        if let port { IONotificationPortDestroy(port); self.port = nil }
        if root != 0 { IOServiceClose(root); root = 0 }
    }

    // IOMessage.h expresses these through function-like C macros, which Swift
    // cannot import. Values are sys_iokit | sub_iokit_common | message.
    static func action(for type: UInt32) -> Action {
        switch type {
        case 0xe0000270: return .allowSleep
        case 0xe0000280: return .willSleep
        case 0xe0000320: return .earlyWake
        case 0xe0000300: return .poweredOn
        default: return .ignore
        }
    }

    private func receive(_ type: UInt32, _ argument: UnsafeMutableRawPointer?) {
        switch Self.action(for: type) {
        case .allowSleep:
            IOAllowPowerChange(root, Int(bitPattern: argument))
        case .willSleep:
            IOAllowPowerChange(root, Int(bitPattern: argument))
            onSleep()
        case .earlyWake, .poweredOn:
            onWake(Self.action(for: type) == .earlyWake ? "iokit-will-power-on" : "iokit-has-powered-on",
                   Date().timeIntervalSince1970 * 1_000)
        case .ignore: break
        }
    }
}
