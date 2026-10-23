import AppKit
import Foundation

extension CodexDesktopProfile {
    func account(in accounts: [AccountState]) -> AccountState? {
        let matches = accounts.filter {
            guard $0.provider == "codex", $0.enabled else { return false }
            if let root = $0.profileRoot { return Self.canonical(root) == Self.canonical(codexHome) }
            return collectionAccount != nil && $0.account == collectionAccount
        }
        return matches.count == 1 ? matches[0] : nil
    }

    /// Running apps are candidates, never proof of a logged-in or healthy account.
    static func discover(registered: [Self], previous: [Self], running: [CodexProcessIdentity]) -> [Self] {
        var result = registered
        for identity in running {
            if result.contains(where: { Self.canonical($0.codexHome) == identity.codexHome }) { continue }
            let candidate = previous.first { identity.matches($0) } ?? Self(
                id: UUID().uuidString.lowercased(), name: Strings.t("accounts.discoveredCodex", String(result.count + 1)),
                codexHome: identity.codexHome, appData: identity.appData)
            // Reject overlapping stores rather than offer an unsafe second login.
            do { try Self.validate(result + [candidate]); result.append(candidate) } catch { continue }
        }
        return result
    }
}

extension CodexProfilesModel {
    func refreshDiscovery(accounts: [AccountState], running: [CodexProcessIdentity]? = nil) {
        let identities = running ?? NSWorkspace.shared.runningApplications.compactMap { application in
            guard application.bundleIdentifier == "com.openai.codex", !application.isTerminated else { return nil }
            return CodexProcessIdentity.read(pid: application.processIdentifier)
        }
        // Match by the collector's directory, never a mutable display name.
        let reconciled = profiles.map { profile -> CodexDesktopProfile in
            var next = profile
            if let account = profile.account(in: accounts) { next.collectionAccount = account.account }
            return next
        }
        if reconciled != profiles { save(reconciled) }
        let candidates = CodexDesktopProfile.discover(registered: profiles, previous: discovered, running: identities)
        if candidates != discovered { discovered = candidates }
        let runningIDs = Set(candidates.filter { profile in identities.contains { $0.matches(profile) } }.map(\.id))
        if runningIDs != runningProfileIDs { runningProfileIDs = runningIDs }
    }
}
