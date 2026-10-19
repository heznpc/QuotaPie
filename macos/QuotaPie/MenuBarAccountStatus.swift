import Foundation

/// A cached percentage is supporting information when the account needs attention.
/// Keep this decision independent of rendering so the meter and its accessibility
/// label cannot imply that a denied or unverified account is ready to use.
enum MenuBarAccountStatus {
    static func title(for account: AccountState) -> String? {
        let message: String
        if !account.collection.isHealthy {
            switch account.collection.errorCategory ?? account.collection.health {
            case "claude-code-unavailable": return Strings.t("collection.claude-code-unavailable")
            case "access-denied": message = Strings.t("collection.access-denied")
            case "auth-required": message = Strings.t("menu.account.loginRequired")
            case "auth-expired": message = Strings.t("menu.account.loginExpired")
            default: message = Strings.t("menu.account.refreshNeeded")
            }
        } else if account.windows.contains(where: \.isResetTicketPending) {
            message = Strings.t("accounts.list.resetTicketPending")
        } else if account.windows.contains(where: \.isUsageBlocked) {
            message = Strings.t("accounts.list.limitBlocked")
        } else if account.windows.contains(where: \.isUsagePermissionUnknown) {
            message = Strings.t("accounts.list.permissionUnknown")
        } else if account.windows.contains(where: { $0.freshness != "fresh" }) {
            message = Strings.t("menu.account.refreshNeeded")
        } else {
            return nil
        }
        return account.providerTitle + " · " + message
    }
}
