import SwiftUI

extension ResetSignalPayload {
    var latestSignal: ResetSignal? { signals.max { $0.publishedAtMs < $1.publishedAtMs } }
}

extension ResetSignal {
    /// Describe this post's current meaning; never imply application to an account.
    func summaryKey(nowMs: Double) -> String {
        switch state {
        case "withdrawn": return "signal.summary.withdrawn"
        case "updated": return "signal.summary.updated"
        case "reported": return "signal.summary.reported"
        default:
            if let targetAtMs { return targetAtMs <= nowMs ? "signal.summary.elapsed" : "signal.summary.scheduled" }
            return state == "announced" ? "signal.summary.announced" : "signal.summary.possible"
        }
    }

    var sourceStatusKey: String {
        observedVia == "x-api" ? "signal.summary.direct" : "signal.summary.unverified"
    }
}

struct ResetSignalSummary: View {
    let feed: ResetSignalPayload
    let openHistory: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack {
                Text(Strings.t("overview.resetNews")).font(.system(size: 12, weight: .semibold))
                Spacer()
                Button(Strings.t("overview.history"), action: openHistory)
                    .font(.caption).buttonStyle(.borderless)
            }
            if let signal = feed.latestSignal {
                Text(Strings.t(signal.summaryKey(nowMs: Date().timeIntervalSince1970 * 1000)))
                    .font(.callout).fixedSize(horizontal: false, vertical: true)
                HStack(alignment: .firstTextBaseline) {
                    Text(Strings.t(signal.sourceStatusKey) + " · " + Strings.t("signal.summary.accountUnknown"))
                        .foregroundStyle(.secondary)
                    Spacer(minLength: 4)
                    if let url = signal.safeSourceURL {
                        Link(Strings.t("overview.original"), destination: url)
                    }
                }.font(.caption2)
            } else {
                Text(Strings.t(feed.state == "ready" ? "signal.empty" : "signal.health." + feed.state))
                    .font(.caption).foregroundStyle(.secondary)
            }
            if feed.latestSignal != nil && feed.state != "ready" {
                Text(Strings.t("signal.summary.delayed"))
                    .font(.caption2).foregroundStyle(.secondary)
            }
        }
    }
}

struct ResetSignalHistory: View {
    let feed: ResetSignalPayload?

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            if let feed, feed.enabled {
                VStack(alignment: .leading, spacing: 5) {
                    Text(Strings.t("signal.accountNotice")).font(.callout)
                    Text(Strings.t(feed.source == "x-api" ? "signal.coverage.direct" : "signal.coverage.relay"))
                        .font(.caption).foregroundStyle(.secondary)
                    if let last = feed.lastSuccessMs {
                        Text(Strings.t("signal.checked", DisplayFormat.clock(last))).font(.caption).foregroundStyle(.secondary)
                    }
                    if feed.state != "ready" {
                        Text(Strings.t("signal.health." + feed.state)).font(.caption).foregroundStyle(.orange)
                    }
                }
                if feed.signals.isEmpty { Text(Strings.t("signal.empty")).foregroundStyle(.secondary) }
                ForEach(feed.signals.sorted { $0.publishedAtMs > $1.publishedAtMs }, id: \.fingerprint) { signal in
                    Divider()
                    VStack(alignment: .leading, spacing: 8) {
                        HStack(alignment: .firstTextBaseline) {
                            Text(Strings.t(signal.summaryKey(nowMs: Date().timeIntervalSince1970 * 1000)))
                                .font(.headline)
                            Spacer()
                            if let url = signal.safeSourceURL {
                                Link(Strings.t("signal.source"), destination: url).font(.caption)
                            }
                        }
                        Text(Strings.t(signal.sourceStatusKey) + " · " + Strings.t("signal.summary.accountUnknown"))
                            .font(.caption).foregroundStyle(.secondary)
                        Text(signal.text).font(.body).textSelection(.enabled)
                        Text("@\(signal.author) · \(stamp(signal.publishedAtMs))")
                            .font(.caption).foregroundStyle(.secondary)
                        Text(Strings.t("signal." + signal.state) + " · " + Strings.t("signal.kind." + signal.resetKind))
                            .font(.caption).foregroundStyle(.secondary)
                        if let target = signal.targetAtMs {
                            Text(Strings.t(target < Date().timeIntervalSince1970 * 1000 ? "signal.elapsed" : "signal.feedTime", stamp(target)))
                                .font(.caption).foregroundStyle(.secondary)
                        }
                        if let hint = signal.timeHint, !hint.isEmpty,
                           hint.trimmingCharacters(in: .whitespacesAndNewlines) != signal.text.trimmingCharacters(in: .whitespacesAndNewlines) {
                            Text(hint).font(.caption).foregroundStyle(.secondary)
                        }
                        if let scope = signal.scopeHint, !scope.isEmpty {
                            Text(scope).font(.caption).foregroundStyle(.secondary)
                        }
                    }.frame(maxWidth: .infinity, alignment: .leading)
                }
            } else {
                Text(Strings.t("signal.health.off")).foregroundStyle(.secondary)
            }
        }
    }

    private func stamp(_ ms: Double) -> String {
        Date(timeIntervalSince1970: ms / 1000).formatted(date: .abbreviated, time: .shortened)
    }
}
