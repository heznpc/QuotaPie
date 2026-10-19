import SwiftUI

/// Account observations keep their own labels and freshness instead of borrowing
/// the menu bar's selected reading.
struct AccountListRow: View {
    let account: AccountState
    let showingStartupCache: Bool
    let transportFailure: String?
    let select: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: select) {
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 10) {
                    Image(nsImage: AccountBadge(accountID: account.id, name: account.accountLabel).image(size: 28))
                        .accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(account.accountLabel).font(.system(size: 13, weight: .semibold))
                            .foregroundStyle(.primary).lineLimit(1).truncationMode(.middle)
                        Text(account.providerTitle).font(.caption).foregroundStyle(.secondary)
                    }
                    Spacer(minLength: 4)
                    Image(systemName: "chevron.right").font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(.tertiary)
                }
                if summaryWindows.isEmpty {
                    Text(Strings.t("popover.noWindows")).font(.caption).foregroundStyle(.secondary)
                } else {
                    HStack(alignment: .top, spacing: 20) {
                        ForEach(summaryWindows) { window in
                            quotaSummary(window).frame(maxWidth: .infinity, alignment: .leading)
                        }
                    }
                }
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    if needsAttention {
                        Image(systemName: "exclamationmark.circle").foregroundStyle(.orange)
                    }
                    Text(statusText)
                        .foregroundStyle(needsAttention ? Color.orange : Color.secondary)
                        .lineLimit(2).fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 0)
                    if account.windows.count > summaryWindows.count {
                        Text(Strings.t("accounts.list.moreLimits", String(account.windows.count - summaryWindows.count)))
                            .foregroundStyle(.secondary).lineLimit(1)
                    }
                }.font(.caption2)
            }
            .padding(.horizontal, 20).padding(.vertical, 14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
            .background(hovering ? Color.primary.opacity(0.04) : Color.clear)
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .accessibilityIdentifier("account.row." + account.id)
        .accessibilityLabel("\(account.providerTitle) · \(account.accountLabel)")
        .accessibilityValue((summaryWindows.map { "\($0.shortLabel) \(remainingText($0))" } + [statusText]).joined(separator: ", "))
        .help(Strings.t("accounts.list.open", account.accountLabel))
    }

    private var summaryWindows: [QuotaWindow] {
        Array(account.windows.sorted {
            let leftGeneral = account.provider == "codex" ? $0.bucket.hasPrefix("codex:") : ["five_hour", "seven_day"].contains($0.bucket)
            let rightGeneral = account.provider == "codex" ? $1.bucket.hasPrefix("codex:") : ["five_hour", "seven_day"].contains($1.bucket)
            if leftGeneral != rightGeneral { return leftGeneral }
            let leftDuration = $0.windowSeconds.flatMap { $0 > 0 ? $0 : nil } ?? .infinity
            let rightDuration = $1.windowSeconds.flatMap { $0 > 0 ? $0 : nil } ?? .infinity
            if leftDuration != rightDuration { return leftDuration < rightDuration }
            return $0.bucket < $1.bucket
        }.prefix(2))
    }

    private var needsAttention: Bool {
        transportFailure != nil || !account.collection.isHealthy || account.windows.contains {
            $0.freshness != "fresh" || $0.isUsageBlocked || $0.isUsagePermissionUnknown
        }
    }

    private var statusText: String {
        if let transportFailure { return transportFailure }
        if showingStartupCache { return Strings.t("collection.previousReading") }
        if !account.collection.isHealthy { return account.collection.actionText }
        if account.windows.contains(where: \.isUsageBlocked) { return Strings.t("accounts.list.usageBlocked") }
        if account.windows.contains(where: \.isUsagePermissionUnknown) { return Strings.t("accounts.list.permissionUnknown") }
        if account.windows.contains(where: { $0.freshness != "fresh" }) { return Strings.t("window.stale") }
        if let measured = account.collection.lastSuccessAtMs ?? summaryWindows.first?.observedAtMs, measured.isFinite, measured > 0 {
            return Strings.t("accounts.list.measured", DisplayFormat.age(since: Date(timeIntervalSince1970: measured / 1_000)))
        }
        return account.collection.actionText
    }

    private func remainingText(_ window: QuotaWindow) -> String {
        guard let remaining = window.remainingPercent, remaining.isFinite else { return "—" }
        return Strings.t("window.remaining", String(Int(min(100, max(0, remaining)).rounded())))
    }

    private func quotaSummary(_ window: QuotaWindow) -> some View {
        let current = !showingStartupCache && transportFailure == nil && account.collection.isHealthy && window.freshness == "fresh"
        let remaining = window.remainingPercent.flatMap { $0.isFinite ? min(100, max(0, $0)) : nil }
        let tone = current ? (window.isUsageBlocked || window.isUsagePermissionUnknown ? Color.orange :
            window.isLowRemaining ? Color.red : Color.primary) : Color.secondary
        return VStack(alignment: .leading, spacing: 5) {
            HStack(alignment: .firstTextBaseline, spacing: 4) {
                Text(window.shortLabel).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                Spacer(minLength: 0)
                Text(remainingText(window)).font(.system(size: 12, weight: .semibold).monospacedDigit())
                    .foregroundStyle(tone).lineLimit(1).fixedSize()
            }
            GeometryReader { geometry in
                ZStack(alignment: .leading) {
                    Capsule().fill(Color.primary.opacity(0.10))
                    Capsule().fill(tone.opacity(current ? 0.75 : 0.35))
                        .frame(width: geometry.size.width * (remaining ?? 0) / 100)
                }
            }.frame(height: 4).accessibilityHidden(true)
            Text(current ? (window.isUsageBlocked ? Strings.t("accounts.list.limitBlocked") :
                window.isUsagePermissionUnknown ? Strings.t("accounts.list.permissionUnknown") : DisplayFormat.resetStamp(window.resetsAtMs))
                : Strings.t("account.previousReadings"))
                .font(.caption2).foregroundStyle(.secondary).lineLimit(1)
        }.help("\(window.shortLabel) · \(DisplayFormat.resetStamp(window.resetsAtMs))")
    }
}
