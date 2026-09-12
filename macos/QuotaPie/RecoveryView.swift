import Foundation
import SwiftUI

struct ResetTracking: Decodable {
    let lookbackMs: Double
    let accounts: [AccountRecovery]
}

struct AccountRecovery: Decodable {
    let provider: String
    let account: String
    let windows: [WindowRecovery]
}

struct WindowRecovery: Decodable, Identifiable {
    let bucket: String
    let label: String
    let state: String
    let reason: String?
    let comparedAfterMs: Double?
    let comparedByMs: Double?
    let recovery: RecoveryEvidence?
    var id: String { bucket }

    func statusText(transportUnavailable: Bool) -> String {
        let key = transportUnavailable ? "unavailable" : state
        switch key {
        case "recovery-observed", "no-recovery-observed", "unavailable": return Strings.t("recovery.state." + key)
        default: return Strings.t("recovery.state.unavailable")
        }
    }
}

struct RecoveryEvidence: Decodable {
    let eventId: Int?
    let observedAfterMs: Double?
    let observedByMs: Double
    let remainingBefore: Double?
    let remainingAfter: Double?
    let previousResetsAtMs: Double?
    let nextResetsAtMs: Double?
    let reason: String
    let candidates: [RecoveryCandidate]

    var isObservedIncrease: Bool {
        guard let remainingBefore, let remainingAfter, remainingAfter > remainingBefore else { return false }
        return ["no-public-match", "reset-credit-decreased", "scheduled", "time-proximity-only"].contains(reason)
    }

    var remainingText: String {
        func percent(_ value: Double?) -> String {
            value.map { String(format: $0.rounded() == $0 ? "%.0f%%" : "%.1f%%", $0) } ?? "—"
        }
        return Strings.t("recovery.remaining", percent(remainingBefore), percent(remainingAfter))
    }

    var reasonText: String {
        let known = ["no-public-match", "insufficient-evidence", "source-changed", "window-changed",
                     "observation-gap", "reset-credit-decreased", "scheduled", "time-proximity-only"]
        return Strings.t("recovery.reason." + (known.contains(reason) ? reason : "insufficient-evidence"))
    }
}

struct ObservedRecovery: Identifiable {
    let accountID: String
    let accountTitle: String
    let bucket: String
    let label: String
    let evidence: RecoveryEvidence
    var id: String { "\(accountID)/\(bucket)" }
}

/// Kept above activity history even when newer routine events arrive.
struct RecentRecoveriesView: View {
    let recoveries: [ObservedRecovery]

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(Strings.t("recovery.recent")).font(.headline)
            ForEach(recoveries) { recovery in
                VStack(alignment: .leading, spacing: 5) {
                    HStack(alignment: .firstTextBaseline) {
                        Text("\(recovery.accountTitle) · \(recovery.label)").fontWeight(.medium)
                        Spacer()
                        Text("\(DisplayFormat.day(recovery.evidence.observedByMs)) \(DisplayFormat.clock(recovery.evidence.observedByMs))")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    Text(recovery.evidence.remainingText).font(.title3.monospacedDigit())
                    Text(recovery.evidence.reasonText).font(.caption).foregroundStyle(.secondary)
                }
            }
        }
    }
}

struct RecoveryCandidate: Decodable, Identifiable {
    let signalId: String
    let author: String
    let sourceUrl: String
    let publishedAtMs: Double
    let observedVia: String
    var id: String { signalId }
    var safeSourceURL: URL? {
        guard let url = URL(string: sourceUrl), url.scheme == "https", url.host == "x.com",
              url.user == nil, url.password == nil, url.port == nil,
              !signalId.isEmpty, signalId.allSatisfy({ $0.isNumber }),
              url.path == "/\(author)/status/\(signalId)",
              ["thsottiaux", "reach_vb", "dkundel", "openaidevs", "openai"].contains(author.lowercased())
        else { return nil }
        return url
    }
}

struct AccountRecoveryView: View {
    let account: AccountRecovery
    let transportUnavailable: Bool

    var body: some View {
        DisclosureGroup(Strings.t("recovery.section")) {
            VStack(alignment: .leading, spacing: 8) {
                if account.windows.isEmpty {
                    Text(Strings.t("recovery.state.unavailable"))
                }
                ForEach(account.windows) { window in
                    VStack(alignment: .leading, spacing: 3) {
                        Text("\(window.label) · \(window.statusText(transportUnavailable: transportUnavailable))")
                            .fontWeight(.medium)
                        if let evidence = window.recovery {
                            Text(Strings.t("recovery.interval", stamp(evidence.observedAfterMs), stamp(evidence.observedByMs)))
                            Text(Strings.t("recovery.remaining", percent(evidence.remainingBefore), percent(evidence.remainingAfter)))
                            Text(Strings.t("recovery.resetDates", stamp(evidence.previousResetsAtMs), stamp(evidence.nextResetsAtMs)))
                            Text(evidence.reasonText).foregroundStyle(.secondary)
                            ForEach(evidence.candidates) { candidate in
                                if let url = candidate.safeSourceURL {
                                    Link(Strings.t("recovery.candidate", stamp(candidate.publishedAtMs)), destination: url)
                                }
                                Text(Strings.t(candidate.observedVia == "x-api" ? "signal.coverage.direct" : "signal.coverage.relay"))
                                    .foregroundStyle(.secondary)
                            }
                        } else if window.state == "no-recovery-observed" && !transportUnavailable {
                            Text(Strings.t("recovery.comparison", stamp(window.comparedAfterMs), stamp(window.comparedByMs)))
                                .foregroundStyle(.secondary)
                        }
                    }
                }
                Text(Strings.t("recovery.disclaimer")).foregroundStyle(.secondary)
            }
            .font(.caption)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.top, 4)
        }
        .font(.caption)
    }

    private func stamp(_ ms: Double?) -> String {
        guard let ms else { return "—" }
        return Date(timeIntervalSince1970: ms / 1000).formatted(date: .abbreviated, time: .shortened)
    }
    private func percent(_ value: Double?) -> String {
        value.map { String(format: "%.1f%%", $0) } ?? "—"
    }
}
