import SwiftUI

struct AccountSection: View {
    let account: AccountState
    let recovery: AccountRecovery?
    let transportUnavailable: Bool
    let onOpenConfig: () -> Void
    let onCopyCommand: (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline) {
                Text("\(account.providerTitle) · \(account.accountLabel)")
                    .font(.system(size: 12, weight: .semibold))
                Spacer()
                if account.collection.isHealthy {
                    Text(statusTrail)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                } else {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .font(.caption2)
                        .foregroundStyle(.orange)
                        .help(account.collection.actionText)
                }
            }
            if account.windows.isEmpty || !account.collection.isHealthy {
                Label(account.windows.isEmpty && account.collection.isHealthy ? Strings.t("popover.noWindows") : account.collection.actionText,
                      systemImage: "exclamationmark.circle")
                    .font(.caption).foregroundStyle(account.collection.isHealthy ? Color.secondary : Color.orange)
                DisclosureGroup(Strings.t("detail.overview.collectionHelp")) {
                    VStack(alignment: .leading, spacing: 8) {
                        if let detail = account.collection.errorDetail {
                            Text(detail).font(.caption2).foregroundStyle(.secondary).textSelection(.enabled)
                        }
                        if let command = account.collection.recoveryCommand {
                            Text(Strings.t("popover.runCommand", command)).font(.caption2).foregroundStyle(.secondary)
                        }
                        HStack(spacing: 8) {
                            if let command = account.collection.recoveryCommand {
                                Button { onCopyCommand(command) } label: {
                                    Label(Strings.t("action.copyCommand"), systemImage: "doc.on.doc")
                                }.help(Strings.t("action.copyCommandHelp"))
                            }
                            Button(action: onOpenConfig) {
                                Label(Strings.t("detail.overview.openConfig"), systemImage: "doc.text")
                            }
                        }.buttonStyle(.bordered).controlSize(.small)
                    }
                    .padding(.top, 6)
                }.font(.caption)
            }
            if !account.collection.isHealthy && !account.windows.isEmpty {
                Text(Strings.t("account.previousReadings")).font(.caption2).foregroundStyle(.secondary)
            }
            ForEach(primaryAndAttentionWindows) { window in quotaRow(window) }
            if !otherWindows.isEmpty {
                DisclosureGroup(Strings.t("detail.overview.otherLimits", String(otherWindows.count))) {
                    VStack(alignment: .leading, spacing: 12) {
                        ForEach(otherWindows) { window in quotaRow(window) }
                    }.padding(.top, 8)
                }.font(.caption)
            }
            if let recovery {
                AccountRecoveryView(account: recovery, transportUnavailable: transportUnavailable)
            }
        }
    }

    private var statusTrail: String {
        let age = account.collection.lastSuccessAtMs
            .map { DisplayFormat.age(since: Date(timeIntervalSince1970: $0 / 1_000)) } ?? "—"
        return "\(account.collection.sourceLabel) · \(age)"
    }

    private var orderedWindows: [QuotaWindow] {
        account.windows.sorted { left, right in
            let leftPrimary = left.bucket.hasPrefix("codex:")
            let rightPrimary = right.bucket.hasPrefix("codex:")
            if leftPrimary != rightPrimary { return leftPrimary }
            return (left.windowSeconds ?? 0) < (right.windowSeconds ?? 0)
        }
    }

    private var primaryAndAttentionWindows: [QuotaWindow] {
        let presentation = AccountListPresentation(account: account)
        let primaryIDs = Set(presentation.visibleWindows.map(\.id))
        return orderedWindows.filter {
            primaryIDs.contains($0.id) || $0.isResetTicketPending || $0.isUsageBlocked || $0.isUsagePermissionUnknown ||
                $0.freshness != "fresh" || $0.isLowRemaining || $0.remainingPercent == nil
        }
    }

    private var otherWindows: [QuotaWindow] {
        let visibleIDs = Set(primaryAndAttentionWindows.map(\.id))
        return orderedWindows.filter { !visibleIDs.contains($0.id) }
    }

    private func quotaRow(_ window: QuotaWindow) -> some View {
        WindowRow(window: window, current: !transportUnavailable && account.collection.isHealthy && window.freshness == "fresh")
    }
}

private struct WindowRow: View {
    let window: QuotaWindow
    let current: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(spacing: 8) {
                Text(window.shortLabel)
                    .font(.system(size: 12, weight: .medium))
                Spacer()
                Text(remainingText)
                    .font(.system(size: 15, weight: .semibold).monospacedDigit())
                    .foregroundStyle(current ? (window.isLowRemaining ? Color.red : Color.primary) : Color.secondary)
            }
            RemainingBar(window: window, current: current)
            VStack(alignment: .leading, spacing: 1) {
                if let resetText {
                    Text(resetText).font(.caption2.monospacedDigit()).foregroundStyle(.secondary)
                }
                if window.isResetTicketPending || window.isUsageBlocked || window.isUsagePermissionUnknown {
                    Text(Strings.t(window.isResetTicketPending ? "accounts.list.resetTicketPending" : window.isUsageBlocked ? "accounts.list.limitBlocked" : "accounts.list.permissionUnknown"))
                        .font(.caption2).foregroundStyle(.orange)
                }
                if window.freshness != "fresh" {
                    Text(freshnessText).font(.caption2).foregroundStyle(.orange)
                }
                if current && window.isExhausted {
                    Text(Strings.t("window.exhausted")).font(.caption2).foregroundStyle(.red)
                }
                if let pace = window.paceText, !window.isExhausted {
                    DisclosureGroup(Strings.t("detail.overview.usagePace")) {
                        Text(pace).font(.caption2).foregroundStyle(.secondary).padding(.top, 4)
                    }.font(.caption2)
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(window.shortLabel)
        .accessibilityValue(accessibilityValue)
    }

    private var usedText: String {
        window.usedPercent.map { Strings.t("window.used", String(Int($0.rounded()))) } ?? Strings.t("window.usageUnknown")
    }

    private var remainingText: String {
        window.remainingPercent.map { Strings.t("window.remaining", String(Int($0.rounded()))) } ?? "—"
    }

    private var freshnessText: String {
        switch window.freshness {
        case "stale": return Strings.t("window.stale")
        case "reset_due": return Strings.t("window.resetDue")
        default: return Strings.t("window.unknown")
        }
    }

    private var resetText: String? {
        guard current, window.freshness == "fresh",
              let reset = AccountListPresentation.knownResetTime(window.resetsAtMs) else { return nil }
        return Strings.t("detail.overview.resetsAt", reset)
    }

    private var accessibilityValue: String {
        let permission = window.isResetTicketPending ? Strings.t("accounts.list.resetTicketPending") : window.isUsageBlocked ? Strings.t("accounts.list.limitBlocked") :
            window.isUsagePermissionUnknown ? Strings.t("accounts.list.permissionUnknown") : nil
        let pieces = [remainingText, usedText, resetText, window.paceText, permission,
                      window.freshness == "fresh" ? nil : freshnessText]
        return pieces.compactMap { $0 }.joined(separator: ", ")
    }
}

/// The fill shrinks as quota is consumed, matching the remaining percentage
/// above it. The thin mark uses the same remaining-quota scale for the reserve.
private struct RemainingBar: View {
    let window: QuotaWindow
    let current: Bool

    var body: some View {
        GeometryReader { geometry in
            let width = geometry.size.width
            let remaining = min(1, max(0, (window.remainingPercent ?? 0) / 100))
            let reserveLine = window.reservePercent.map { min(1, max(0, $0 / 100)) }
            ZStack(alignment: .leading) {
                RoundedRectangle(cornerRadius: 2).fill(Color.secondary.opacity(0.18))
                RoundedRectangle(cornerRadius: 2)
                    .fill(fillColor)
                    .frame(width: width * remaining)
                if let reserveLine {
                    Rectangle()
                        .fill(Color.secondary.opacity(0.55))
                        .frame(width: 1)
                        .offset(x: width * reserveLine)
                }
            }
        }
        .frame(height: 4)
        .accessibilityHidden(true)
    }

    private var fillColor: Color {
        guard current else { return .secondary }
        if window.isLowRemaining { return Color(nsColor: .systemRed) }
        return Color(nsColor: .systemBlue)
    }
}

struct RecentChanges: View {
    let events: [QuotaEvent]

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            ForEach(events.indices, id: \.self) { index in
                let event = events[index]
                Text("\(event.localizedText) · \(DisplayFormat.age(since: Date(timeIntervalSince1970: event.occurredAtMs / 1_000)))")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
        }
    }
}

struct CalloutView: View {
    enum Tone { case warning, neutral }

    let text: String
    let detail: String?
    let tone: Tone

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(text).font(.system(size: 12, weight: .medium))
                .foregroundStyle(tone == .warning ? Color.orange : Color.primary)
            if let detail {
                Text(detail).font(.caption2).foregroundStyle(.secondary).textSelection(.enabled)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(8)
        .background(RoundedRectangle(cornerRadius: 6).fill(Color.secondary.opacity(0.10)))
    }
}
