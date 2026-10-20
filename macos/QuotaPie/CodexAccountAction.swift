import Foundation

/// Describes the app opened for conversation work, independently of the account
/// whose quota is selected. A shared app does not promise a particular account.
struct CodexAccountAction {
    let launchProfile: CodexDesktopProfile?
    let opensUnifiedApp: Bool
    let title: String
    let help: String

    var isEnabled: Bool { launchProfile != nil }

    init(profile: CodexDesktopProfile?, consolidation: CodexSessionConsolidation?,
         requiresVerification: Bool = false, primary: CodexDesktopProfile = .primary) {
        guard let profile else {
            launchProfile = nil
            opensUnifiedApp = false
            title = Strings.t("profiles.open")
            help = Strings.t("profiles.accountNotLinked")
            return
        }
        guard !requiresVerification,
              let target = try? profile.launchProfile(intent: .work, consolidation: consolidation, primary: primary) else {
            launchProfile = nil
            opensUnifiedApp = false
            title = Strings.t("profiles.open")
            help = Strings.t("profiles.error.consolidationUnavailable")
            return
        }

        launchProfile = target
        opensUnifiedApp = target.environment == primary.environment
        title = opensUnifiedApp
            ? Strings.t("profiles.openUnifiedApp")
            : Strings.t("profiles.openAccount", target.name)
        help = opensUnifiedApp
            ? Strings.t("profiles.openUnifiedAppHelp")
            : Strings.t("profiles.openIsolatedAccountHelp", target.name)
    }
}
