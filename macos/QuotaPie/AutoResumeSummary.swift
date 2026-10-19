import SwiftUI

/// Recovery notices do not imply that a conversation was registered or resumed.
/// Keep the account's actual continuation state beside the quota reading.
struct AutoResumeSummaryPresentation {
    let title: String
    let detail: String
    let attention: Bool

    init(account: AutoResumeAccount?, incidents: [AutoResumeIncident], current: Bool, nowMs: Double) {
        guard current else {
            title = Strings.t("autoResume.summary.unverified")
            detail = Strings.t("autoResume.summary.unverifiedDetail")
            attention = true
            return
        }
        guard let account else {
            title = Strings.t("autoResume.summary.unverified")
            detail = Strings.t("autoResume.unsupported")
            attention = true
            return
        }
        let history = incidents.filter { incident in
            guard incident.account == account.account else { return false }
            // The detailed history retains the failed attempt. The account
            // summary follows its verified repair instead of showing an old
            // failure above a successfully completed continuation.
            if incident.linkedRepair(in: incidents) != nil { return false }
            return true
        }.sorted { $0.detectedAtMs > $1.detectedAtMs }
        let pending = history.filter { !["resumed", "skipped"].contains($0.state) }
        if let incident = pending.first {
            title = incident.stateTitle
            detail = [incident.projectLabel, incident.quotaAccountText, incident.displayedReason(in: incidents), incident.repairText(in: incidents)].compactMap { $0 }.joined(separator: " · ")
            attention = !["waiting", "queued", "running"].contains(incident.state)
        } else if let error = account.scanErrorText {
            title = Strings.t("autoResume.summary.unverified")
            detail = error
            attention = true
        } else if !account.enabled {
            title = Strings.t("autoResume.summary.disabled")
            detail = Strings.t("autoResume.summary.ask")
            attention = false
        } else if let scanned = account.lastScanAtMs, !scanned.isFinite || scanned > nowMs || nowMs - scanned > 90_000 {
            title = Strings.t("autoResume.summary.delayed")
            detail = Strings.t("autoResume.summary.unverifiedDetail")
            attention = true
        } else if account.lastScanAtMs == nil {
            title = Strings.t("autoResume.scanWaiting")
            detail = Strings.t("autoResume.summary.scope")
            attention = false
        } else if let latest = history.first, latest.state == "resumed" {
            title = Strings.t("autoResume.summary.lastResumed")
            detail = [latest.projectLabel, latest.quotaAccountText, Strings.t("autoResume.summary.monitoring")].compactMap { $0 }.joined(separator: " · ")
            attention = false
        } else {
            title = Strings.t("autoResume.summary.monitoring")
            detail = Strings.t("autoResume.summary.empty")
            attention = false
        }
    }
}

struct AutoResumeSummary: View {
    let accountID: String
    let payload: AutoResumePayload?
    let current: Bool
    let openWork: () -> Void

    private var account: AutoResumeAccount? { payload?.accounts.first { $0.account == accountID } }

    var body: some View {
        let presentation = AutoResumeSummaryPresentation(account: account, incidents: payload?.incidents ?? [],
                                                        current: current, nowMs: Date().timeIntervalSince1970 * 1000)
        Button(action: openWork) {
            VStack(alignment: .leading, spacing: 5) {
                HStack {
                    Label(presentation.title, systemImage: presentation.attention ? "exclamationmark.circle" : "play.circle")
                        .font(.callout.weight(.medium))
                    Spacer(minLength: 4)
                    Image(systemName: "chevron.right").font(.caption2)
                }
                Text(presentation.detail).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                if let account, account.enabled, current {
                    if let error = account.scanErrorText, error != presentation.detail {
                        Text(error).font(.caption).foregroundStyle(.orange)
                    }
                    if let enabledAt = account.enabledAtMs, enabledAt.isFinite {
                        Text(Strings.t("autoResume.summary.since", Date(timeIntervalSince1970: enabledAt / 1000)
                            .formatted(date: .abbreviated, time: .shortened))).font(.caption2).foregroundStyle(.secondary)
                    }
                    if let scanned = account.lastScanAtMs, scanned.isFinite {
                        Text(Strings.t("autoResume.lastScan", DisplayFormat.age(since: Date(timeIntervalSince1970: scanned / 1000))))
                            .font(.caption2).foregroundStyle(.secondary)
                    }
                }
                Text(Strings.t(account?.enabled == false ? "autoResume.summary.configure" : "autoResume.summary.review"))
                    .font(.caption).foregroundStyle(Color.accentColor)
            }.frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("auto-resume-summary-" + accountID)
    }
}
