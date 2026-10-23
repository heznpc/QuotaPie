import AppKit

struct NotchSnapshot: Equatable {
    enum State { case available, low, exhausted, unavailable }
    let provider: String
    let accountID: String?
    let accountLabel: String
    let accountDetail: String?
    let windowLabel: String
    let remaining: Double?
    let state: State
    let detail: String

    var compactAccountLabel: String {
        accountLabel.components(separatedBy: "@").first ?? accountLabel
    }

    init(model: PopoverModel) {
        let account = model.menuAccount
        provider = model.focusedProvider?.title ?? account?.providerTitle ?? "QuotaPie"
        accountID = account?.id
        if let account, account.isClaudeDesktop,
           let organization = account.claudeAccess?.organizationName, !organization.isEmpty {
            accountLabel = [account.nickname ?? organization, account.verifiedPlanTitle].compactMap { $0 }.joined(separator: " · ")
            accountDetail = account.claudeAccess?.email
        } else {
            accountLabel = account?.accountLabel ?? Strings.t("notch.unverified")
            accountDetail = nil
        }
        let window = account?.overviewWindow
        windowLabel = window?.shortLabel ?? ""
        if !model.showingStartupCache, model.lastError == nil,
           account?.collection.isHealthy == true, window?.freshness == "fresh",
           let value = window?.remainingPercent, value.isFinite, (0...100).contains(value),
           window?.isUsagePermissionUnknown != true {
            remaining = value
            state = value <= 0 || window?.isUsageBlocked == true ? .exhausted : value < 20 ? .low : .available
            detail = Strings.t(state == .exhausted ? "notch.exhausted" : "notch.remaining", windowLabel)
        } else {
            remaining = nil
            state = .unavailable
            detail = account == nil ? Strings.t("notch.verifyAccount") : Strings.t("notch.waitingForUsage")
        }
    }

    /// Only meaningful transitions briefly accent the bar. Ordinary polling and quota
    /// ticks update in place, and unknown identity cannot announce an account switch.
    func event(after previous: NotchSnapshot?) -> String? {
        guard let previous, provider == previous.provider else { return nil }
        if let accountID, let oldID = previous.accountID, accountID != oldID {
            return Strings.t("notch.accountChanged")
        }
        guard accountID != nil, accountID == previous.accountID, state != previous.state else { return nil }
        if state == .exhausted { return Strings.t("notch.exhausted") }
        if state == .low, previous.state != .exhausted { return Strings.t("notch.low") }
        if state == .available, previous.state == .exhausted { return Strings.t("notch.recovered") }
        return nil
    }
}

struct NotchLayout: Equatable {
    let frame: CGRect
    let notchWidth: CGFloat
    let wingWidth: CGFloat
}

enum NotchPlacement {
    /// Auxiliary areas identify a physical notch. External/unnotched displays
    /// never receive an invented camera cutout. AppKit screen coordinates may be negative.
    static func layout(screen: CGRect, safeTop: CGFloat, left: CGRect?, right: CGRect?) -> NotchLayout? {
        let wingWidth: CGFloat = 100
        guard safeTop > 0, let left, let right, !left.isEmpty, !right.isEmpty,
              right.minX > left.maxX, left.width >= wingWidth, right.width >= wingWidth else { return nil }
        let height = min(safeTop, left.height, right.height)
        guard height >= 24, height < screen.height else { return nil }
        let notchWidth = right.minX - left.maxX
        let frame = CGRect(x: left.maxX - wingWidth, y: screen.maxY - height,
                           width: notchWidth + wingWidth * 2, height: height)
        guard screen.contains(frame) else { return nil }
        return NotchLayout(frame: frame, notchWidth: notchWidth, wingWidth: wingWidth)
    }
}

/// Window metadata only: no screen recording, app titles or account data needed.
struct NotchWindow {
    let ownerPID: Int32
    let layer: Int
    let frame: CGRect
    let alpha: Double

    init(ownerPID: Int32, layer: Int, frame: CGRect, alpha: Double = 1) {
        self.ownerPID = ownerPID
        self.layer = layer
        self.frame = frame
        self.alpha = alpha
    }

    init?(info: [String: Any], primaryTop: CGFloat) {
        guard let pid = info[kCGWindowOwnerPID as String] as? Int32,
              let layer = info[kCGWindowLayer as String] as? Int,
              let bounds = info[kCGWindowBounds as String] as? NSDictionary,
              let rect = CGRect(dictionaryRepresentation: bounds) else { return nil }
        self.init(ownerPID: pid, layer: layer,
                  frame: CGRect(x: rect.minX, y: primaryTop - rect.maxY, width: rect.width, height: rect.height),
                  alpha: info[kCGWindowAlpha as String] as? Double ?? 1)
    }

    func occupiesNotch(_ layout: NotchLayout, screen: CGRect, ownPID: Int32) -> Bool {
        // Normal app windows and the system's screen-wide menu bar are not
        // competing islands. Match a small elevated panel crossing the camera
        // area, whether collapsed or expanded; do not key this to one app name.
        guard ownerPID != ownPID, layer > 0, alpha > 0, !frame.isEmpty,
              frame.width >= layout.notchWidth, frame.width < screen.width * 0.8,
              frame.height <= max(200, layout.frame.height * 6),
              frame.maxY >= layout.frame.minY - 1, frame.minY < screen.maxY,
              frame.minX <= layout.frame.midX - layout.notchWidth / 4,
              frame.maxX >= layout.frame.midX + layout.notchWidth / 4 else { return false }
        return true
    }
}
