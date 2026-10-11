import Foundation
import Darwin

/// Restore enabled secondary profiles once per boot. A normal quit after a
/// successful restore must stay quit, including if QuotaPie itself restarts.
struct CodexProfileLoginRecovery {
    private(set) var boot: String
    private(set) var pending: Set<String>
    private let newBoot: Bool
    init(boot: String, savedBoot: String?, savedPending: [String], profiles: [CodexDesktopProfile]) {
        self.boot = boot
        newBoot = savedBoot != nil && savedBoot != boot
        let eligible = Set(profiles.filter { $0.id != "primary" && $0.restoreOnLogin != false }.map(\.id))
        pending = savedBoot == boot ? Set(savedPending).intersection(eligible) : eligible
    }
    func duplicatePrimaryPIDs(instances: [CodexProfileUpdateRecovery.Instance], profiles: [CodexDesktopProfile],
                              withinBootRestoration: Bool) -> [pid_t] {
        guard newBoot, withinBootRestoration,
              profiles.contains(where: { $0.id != "primary" && $0.restoreOnLogin != false }),
              let primary = profiles.first(where: { $0.id == "primary" }) else { return [] }
        let restored = instances.filter { $0.identity.matches(primary) }.sorted {
            $0.launchedAt == $1.launchedAt ? $0.pid < $1.pid : $0.launchedAt < $1.launchedAt
        }
        // Only during this boot's restore window. Keep the first real primary;
        // normal launches and ambiguous identities outside login stay untouched.
        return restored.dropFirst().map(\.pid)
    }
    mutating func reconcile(instances: [CodexProfileUpdateRecovery.Instance], profiles: [CodexDesktopProfile]) -> [CodexDesktopProfile] {
        pending = pending.filter { id in profiles.contains { $0.id == id && $0.restoreOnLogin != false } }
        for profile in profiles where instances.contains(where: { $0.identity.matches(profile) }) {
            pending.remove(profile.id)
        }
        return profiles.filter { pending.contains($0.id) }
    }
    static func bootID() -> String {
        var time = timeval(), size = MemoryLayout<timeval>.size
        guard sysctlbyname("kern.boottime", &time, &size, nil, 0) == 0 else { return "unavailable" }
        return "\(time.tv_sec):\(time.tv_usec)"
    }
}
