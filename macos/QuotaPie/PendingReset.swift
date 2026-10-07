import Foundation

extension ResetSignalPayload {
    /// Keep unresolved announcements separate from the latest news. Only explicit
    /// source grouping can close a watch; another provider or benefit cannot.
    func pendingResets(nowMs: Double) -> [ResetSignal] {
        guard enabled else { return [] }
        let day = 86_400_000.0
        let resets = signals.filter {
            ($0.benefitKind == nil || $0.benefitKind == "reset") && $0.resetKind != "banked"
                && $0.publishedAtMs <= nowMs
        }
        let groups = Dictionary(grouping: resets) {
            ($0.provider ?? "codex") + ":" + ($0.groupId ?? $0.sourcePostId ?? $0.id)
        }
        return groups.values.compactMap { posts -> ResetSignal? in
            let latest = posts.sorted {
                if $0.publishedAtMs != $1.publishedAtMs { return $0.publishedAtMs > $1.publishedAtMs }
                let terminal = ["reported", "withdrawn"]
                if terminal.contains($0.state) != terminal.contains($1.state) { return terminal.contains($0.state) }
                return $0.fingerprint < $1.fingerprint
            }.first!
            guard ["possible", "announced", "updated"].contains(latest.state) else { return nil }
            // This is a display horizon, never a forecast or proof of execution.
            let deadline = latest.targetAtMs.map { $0 + day } ?? (latest.publishedAtMs + 2 * day)
            return nowMs <= deadline ? latest : nil
        }.sorted {
            if $0.publishedAtMs != $1.publishedAtMs { return $0.publishedAtMs > $1.publishedAtMs }
            return $0.fingerprint < $1.fingerprint
        }
    }
}
