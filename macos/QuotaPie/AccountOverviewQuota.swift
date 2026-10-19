import SwiftUI

struct AccountOverviewQuota: View {
    let account: AccountState
    let current: Bool

    private var presentation: AccountListPresentation { AccountListPresentation(account: account) }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            ForEach(presentation.visibleWindows) { window in
                reading(window)
            }
        }
    }

    private func reading(_ window: QuotaWindow) -> some View {
        let label = window.shortLabel
        let fresh = current && window.freshness == "fresh"
        let percent = window.remainingPercent.flatMap { $0.isFinite ? min(100, max(0, $0)) : nil }
        let text = percent.map { "\(Int($0.rounded()))%" } ?? "—"
        let warning = window.isResetTicketPending || window.isUsageBlocked || window.isUsagePermissionUnknown
        let tone: Color = !fresh ? .secondary : warning ? .orange : window.isLowRemaining ? .red : .primary
        return VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline) {
                Text(label).font(.caption).foregroundStyle(.secondary)
                Spacer(minLength: 8)
                Text(text).font(.system(size: 28, weight: .semibold, design: .rounded).monospacedDigit())
                    .foregroundStyle(tone)
            }
            GeometryReader { geometry in
                ZStack(alignment: .leading) {
                    Capsule().fill(Color.primary.opacity(0.10))
                    if let percent {
                        Capsule().fill(tone.opacity(fresh ? 0.75 : 0.35))
                            .frame(width: geometry.size.width * percent / 100)
                    }
                }
            }.frame(height: 4).accessibilityHidden(true)
            if fresh, let reset = AccountListPresentation.knownResetTime(window.resetsAtMs) {
                Text(Strings.t("detail.overview.resetsAt", reset))
                    .font(.caption2.monospacedDigit()).foregroundStyle(.secondary)
            }
            if window.freshness != "fresh" {
                Text(Strings.t(window.freshness == "reset_due" ? "window.resetDue" : window.freshness == "stale" ? "window.stale" : "window.unknown"))
                    .font(.caption2).foregroundStyle(.orange)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(Strings.t(fresh ? "overview.remaining" : "overview.cachedRemaining", label))
        .accessibilityValue(text)
    }
}

struct AccountOverviewContinuation: View {
    let accountID: String
    let payload: AutoResumePayload?
    let current: Bool
    let openWork: () -> Void

    var body: some View {
        let account = payload?.accounts.first { $0.account == accountID }
        let presentation = AutoResumeSummaryPresentation(account: account, incidents: payload?.incidents ?? [],
                                                        current: current, nowMs: Date().timeIntervalSince1970 * 1_000)
        Button(action: openWork) {
            VStack(alignment: .leading, spacing: 4) {
                HStack {
                    Label(presentation.title, systemImage: presentation.attention ? "exclamationmark.circle" : "play.circle")
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(presentation.attention ? Color.orange : Color.primary)
                    Spacer(minLength: 4)
                    Image(systemName: "chevron.right").font(.caption2).foregroundStyle(.secondary)
                }
                Text(presentation.detail).font(.caption).foregroundStyle(.secondary)
                    .lineLimit(presentation.attention ? nil : 2).fixedSize(horizontal: false, vertical: true)
                if let error = account?.scanErrorText, current, error != presentation.detail {
                    Text(error).font(.caption).foregroundStyle(.orange)
                }
            }.frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("auto-resume-summary-" + accountID)
    }
}
