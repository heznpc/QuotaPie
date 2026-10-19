import SwiftUI

struct AccountListRow: View {
    let account: AccountState
    let showingStartupCache: Bool
    let transportFailure: String?
    let select: () -> Void
    @State private var hovering = false

    private var presentation: AccountListPresentation { AccountListPresentation(account: account) }

    var body: some View {
        Button(action: select) {
            VStack(alignment: .leading, spacing: 9) {
                HStack(spacing: 8) {
                    Image(nsImage: AccountBadge(accountID: account.id, name: account.accountLabel).image(size: 20))
                        .accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(account.accountLabel).font(.system(size: 13, weight: .medium))
                            .foregroundStyle(.primary).lineLimit(1).truncationMode(.middle)
                        HStack(spacing: 6) {
                            Text(account.providerTitle)
                            if presentation.additionalLimitCount > 0 {
                                Text("·")
                                Text(Strings.t("accounts.list.moreLimits", String(presentation.additionalLimitCount)))
                            }
                        }.font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                    }
                    Spacer(minLength: 4)
                    Image(systemName: "chevron.right").font(.system(size: 9, weight: .medium))
                        .foregroundStyle(.tertiary)
                }
                HStack(alignment: .top, spacing: 20) {
                    quotaSummary(presentation.fiveHour, label: Strings.t("window.five-hour"))
                    quotaSummary(presentation.weekly, label: Strings.t("window.weekly"))
                }
                if let warning = warningText {
                    Label(warning, systemImage: "exclamationmark.circle")
                        .font(.caption2).foregroundStyle(.orange)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .padding(.horizontal, 16).padding(.vertical, 12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
            .background(hovering ? Color.primary.opacity(0.04) : Color.clear)
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .accessibilityIdentifier("account.row." + account.id)
        .accessibilityLabel("\(account.providerTitle) · \(account.accountLabel)")
        .accessibilityValue(accessibilityValue)
        .help(Strings.t("accounts.list.open", account.accountLabel))
    }

    private var warningText: String? {
        if let transportFailure { return historicalWarning(transportFailure) }
        if showingStartupCache { return Strings.t("collection.previousReading") }
        if !account.collection.isHealthy { return historicalWarning(account.collection.actionText) }
        if account.windows.contains(where: \.isResetTicketPending) { return Strings.t("accounts.list.resetTicketPending") }
        if account.windows.contains(where: \.isUsageBlocked) { return Strings.t("accounts.list.usageBlocked") }
        if account.windows.contains(where: \.isUsagePermissionUnknown) { return Strings.t("accounts.list.permissionUnknown") }
        if account.windows.contains(where: { $0.freshness == "reset_due" }) { return Strings.t("window.resetDue") }
        if account.windows.contains(where: { $0.freshness == "stale" }) { return Strings.t("window.stale") }
        if account.windows.contains(where: { $0.freshness != "fresh" }) { return Strings.t("window.unknown") }
        return nil
    }

    private func historicalWarning(_ warning: String) -> String {
        let hasReading = [presentation.fiveHour, presentation.weekly].contains { $0?.remainingPercent != nil }
        return hasReading ? "\(warning) · \(Strings.t("accounts.list.previous"))" : warning
    }

    private func isCurrent(_ window: QuotaWindow?) -> Bool {
        window != nil && !showingStartupCache && transportFailure == nil && account.collection.isHealthy && window?.freshness == "fresh"
    }

    private func remainingText(_ window: QuotaWindow?) -> String {
        guard let remaining = window?.remainingPercent, remaining.isFinite else { return "—" }
        return "\(Int(min(100, max(0, remaining)).rounded()))%"
    }

    private func quotaSummary(_ window: QuotaWindow?, label: String) -> some View {
        let current = isCurrent(window)
        let remaining = window?.remainingPercent.flatMap { $0.isFinite ? min(100, max(0, $0)) : nil }
        let tone = current ? (window?.isUsageBlocked == true || window?.isUsagePermissionUnknown == true ? Color.orange :
            window?.isLowRemaining == true ? Color.red : Color.primary) : Color.secondary
        return VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline, spacing: 4) {
                Text(label).font(.caption2).foregroundStyle(.secondary)
                Spacer(minLength: 0)
                Text(remainingText(window)).font(.system(size: 14, weight: .medium).monospacedDigit())
                    .foregroundStyle(tone).fixedSize()
            }
            GeometryReader { geometry in
                ZStack(alignment: .leading) {
                    Capsule().fill(Color.primary.opacity(0.08))
                    if let remaining {
                        Capsule().fill(tone.opacity(current ? 0.65 : 0.28))
                            .frame(width: geometry.size.width * remaining / 100)
                    }
                }
            }.frame(height: 3).accessibilityHidden(true)
            Label(current ? AccountListPresentation.resetTime(window?.resetsAtMs) : "—", systemImage: "arrow.clockwise")
                .font(.caption2.monospacedDigit()).foregroundStyle(.secondary).lineLimit(1)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .help("\(label) · \(DisplayFormat.resetStamp(window?.resetsAtMs))")
    }

    private var accessibilityValue: String {
        var values = [
            "\(Strings.t("overview.remaining", Strings.t("window.five-hour"))) \(remainingText(presentation.fiveHour))",
            "\(Strings.t("overview.remaining", Strings.t("window.weekly"))) \(remainingText(presentation.weekly))"
        ]
        for window in [presentation.fiveHour, presentation.weekly].compactMap({ $0 }) {
            values.append("\(window.shortLabel) · \(DisplayFormat.resetStamp(window.resetsAtMs))")
        }
        if let warning = warningText { values.append(warning) }
        if let measured = account.collection.lastSuccessAtMs, measured.isFinite, measured > 0 {
            values.append(Strings.t("collection.measuredAt", Date(timeIntervalSince1970: measured / 1_000)
                .formatted(date: .abbreviated, time: .shortened)))
        }
        if presentation.additionalLimitCount > 0 {
            values.append(Strings.t("accounts.list.moreLimits", String(presentation.additionalLimitCount)))
        }
        return values.joined(separator: ", ")
    }
}
