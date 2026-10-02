import SwiftUI

extension ResetSignalPayload {
    var latestSignal: ResetSignal? { signals.max { $0.publishedAtMs < $1.publishedAtMs } }
}

extension ResetSignal {
    /// Describe this post's current meaning; never imply application to an account.
    func summaryKey(nowMs: Double) -> String {
        if let benefitKind, ["credits", "limits", "student", "discounts", "events"].contains(benefitKind) { return "signal.summary." + benefitKind }
        switch state {
        case "withdrawn": return "signal.summary.withdrawn"
        case "updated": return "signal.summary.updated"
        case "reported": return "signal.summary.reported"
        case "announced":
            if let targetAtMs { return targetAtMs <= nowMs ? "signal.summary.elapsed" : "signal.summary.scheduled" }
            return "signal.summary.announced"
        default: return "signal.summary.possible"
        }
    }

    var classificationKey: String {
        if let benefitKind, ["credits", "limits", "student", "discounts", "events"].contains(benefitKind) { return "signal.summary." + benefitKind }
        return (provider == "claude" ? "signal.claude." : "signal.") + state
    }

    var sourceStatusKey: String {
        switch observedVia {
        case "x-api": return "signal.via.x-api"
        case "codexreset": return "signal.via.codexreset"
        case "claudereset": return "signal.via.claudereset"
        case "resetradar": return "signal.via.resetradar"
        case "public-feed", "reset-beacon": return "signal.via.public-feed"
        default: return "signal.summary.unverified"
        }
    }

    var originalTimeHint: String? {
        guard let value = timeHint?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty else { return nil }
        return value
    }

    var summaryTimeHint: String? {
        originalTimeHint.map { $0.count > 120 ? String($0.prefix(120)) + "…" : $0 }
    }

    var publicationText: String {
        (provider == "claude" ? "Claude · " : "Codex · ") + "@\(author) · " + Strings.t("signal.published", Self.stamp(publishedAtMs))
    }

    static func stamp(_ ms: Double) -> String {
        Date(timeIntervalSince1970: ms / 1000).formatted(date: .abbreviated, time: .shortened)
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
                    Text(signal.publicationText)
                        .foregroundStyle(.secondary)
                    Spacer(minLength: 4)
                    if let url = signal.safeSourceURL {
                        Link(Strings.t("overview.original"), destination: url)
                    }
                }.font(.caption2)
                if let hint = signal.summaryTimeHint {
                    Text(Strings.t("signal.originalTime", hint))
                        .font(.caption).lineLimit(2).help(signal.originalTimeHint ?? hint)
                }
                Text(Strings.t(signal.sourceStatusKey) + " · " + Strings.t("signal.summary.accountUnknown"))
                    .font(.caption2).foregroundStyle(.secondary)
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
        LazyVStack(alignment: .leading, spacing: 20) {
            if let feed, feed.enabled {
                Text(Strings.t("signal.accountNotice")).font(.callout)
                if feed.signals.isEmpty { Text(Strings.t("signal.empty")).foregroundStyle(.secondary) }
                ForEach(feed.signals.sorted { $0.publishedAtMs > $1.publishedAtMs }, id: \.fingerprint) { signal in
                    Divider()
                    signalRow(signal)
                }
                Divider()
                VStack(alignment: .leading, spacing: 5) {
                    Text(Strings.t("signal.collectionDetails")).font(.callout.weight(.semibold))
                    Text(Strings.t(feed.coverageKey))
                        .font(.caption).foregroundStyle(.secondary)
                    if let last = feed.lastSuccessMs {
                        Text(Strings.t("signal.checked", ResetSignal.stamp(last))).font(.caption).foregroundStyle(.secondary)
                    }
                    if feed.state != "ready" {
                        Text(Strings.t("signal.health." + feed.state)).font(.caption).foregroundStyle(.orange)
                    }
                }
                if let sources = feed.sources {
                    ForEach(sources) { source in
                        VStack(alignment: .leading, spacing: 5) {
                            Text(source.title + " · " + Strings.t("signal.sourceState." + source.state)).font(.callout)
                            Text(Strings.t("signal.coverage." + source.coverage)).font(.caption).foregroundStyle(.secondary)
                            if let attempt = source.lastAttemptMs {
                                Text(Strings.t("signal.attempt", ResetSignal.stamp(attempt))).font(.caption).foregroundStyle(.secondary)
                            }
                            if let success = source.lastSuccessMs {
                                Text(Strings.t("signal.sourceSuccess", ResetSignal.stamp(success))).font(.caption).foregroundStyle(.secondary)
                            }
                            if let count = source.examinedPosts {
                                Text(Strings.t("signal.examinedPosts", String(count))).font(.caption).foregroundStyle(.secondary)
                            }
                            if let latest = source.latestPostAtMs {
                                Text(Strings.t("signal.latestPost", ResetSignal.stamp(latest))).font(.caption).foregroundStyle(.secondary)
                            }
                            if let latest = source.latestPublishedAtMs {
                                Text(Strings.t("signal.latestEvidence", ResetSignal.stamp(latest))).font(.caption).foregroundStyle(.secondary)
                            }
                            if let evidence = source.lastEvidenceMs {
                                Text(Strings.t("signal.newEvidence", ResetSignal.stamp(evidence))).font(.caption).foregroundStyle(.secondary)
                            }
                            if source.state == "ready" && source.newEvidenceCount == 0 {
                                Text(Strings.t("signal.noNewEvidence")).font(.caption).foregroundStyle(.secondary)
                            }
                            if let error = source.error {
                                Text(error).font(.caption).foregroundStyle(.orange)
                            }
                        }
                    }
                    Text(Strings.t("signal.coverage.caution")).font(.caption).foregroundStyle(.secondary)
                }
            } else {
                Text(Strings.t("signal.health.off")).foregroundStyle(.secondary)
            }
        }
    }

    private func signalRow(_ signal: ResetSignal) -> some View {
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
            Text(signal.publicationText)
                .font(.caption).foregroundStyle(.secondary)
            if let detected = signal.detectedAtMs {
                Text(Strings.t("signal.detected", ResetSignal.stamp(detected)))
                    .font(.caption).foregroundStyle(.secondary)
            }
            TranslatedPostText(text: signal.text)
            if let context = signal.contextText, !context.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                DisclosureGroup(Strings.t("signal.replyContext")) {
                    Text(context).font(.caption).textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }.font(.caption)
            }
            Text(Strings.t(signal.classificationKey) + " · " + Strings.t("signal.kind." + (["credits", "limits", "student", "discounts", "events"].contains(signal.benefitKind ?? "") ? signal.benefitKind! : signal.resetKind)))
                .font(.caption).foregroundStyle(.secondary)
            if let target = signal.targetAtMs {
                Text(Strings.t(target < Date().timeIntervalSince1970 * 1000 ? "signal.elapsed" : "signal.feedTime", ResetSignal.stamp(target)))
                    .font(.caption).foregroundStyle(.secondary)
            }
            if let hint = signal.originalTimeHint {
                Text(Strings.t("signal.originalTime", hint)).font(.caption).foregroundStyle(.secondary)
            }
            if signal.originalTimeHint != nil && signal.targetAtMs == nil {
                Text(Strings.t("signal.timeUnresolved")).font(.caption).foregroundStyle(.secondary)
            }
            if let scope = signal.scopeHint, !scope.isEmpty {
                Text(scope).font(.caption).foregroundStyle(.secondary)
            }
        }.frame(maxWidth: .infinity, alignment: .leading)
    }
}
