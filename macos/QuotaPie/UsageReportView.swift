import SwiftUI

struct UsageReportView: View {
    @ObservedObject var store: UsageReportStore
    let client: StatusClient?
    let actionToken: String?
    let accounts: [AccountState]
    @State private var breakdown = Breakdown.days
    @State private var shownSessions = 20

    private enum Breakdown: String, CaseIterable, Identifiable {
        case days, models, sessions, resets
        var id: String { rawValue }
        var title: String { Strings.t("usage.breakdown." + rawValue) }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text(Strings.t("usage.title")).font(.title3.bold())
            Text(Strings.t(store.resetSelection == nil ? "usage.scope" : "usage.scopeFiltered")).font(.caption).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            controls
            if let error = store.error {
                Text(error).font(.callout).foregroundStyle(.orange)
                Button(Strings.t("action.refresh")) { store.load(client: client, actionToken: actionToken, refresh: true) }
            }
            if store.loading {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text(Strings.t("usage.loading")).font(.caption)
                }
            }
            if let report = store.report {
                summary(report)
                Divider()
                Picker(Strings.t("usage.breakdown"), selection: $breakdown) {
                    ForEach(Breakdown.allCases) { Text($0.title).tag($0) }
                }.pickerStyle(.segmented).labelsHidden()
                buckets(report)
                Divider()
                activity(report)
                Divider()
                coverage(report)
            } else if !store.loading && store.error == nil {
                Text(Strings.t("usage.empty")).foregroundStyle(.secondary)
            }
        }
        .accessibilityIdentifier("usage.report")
        .onAppear { store.load(client: client, actionToken: actionToken) }
        .onDisappear { store.stop() }
        .onChange(of: actionToken) { _ in store.load(client: client, actionToken: actionToken) }
    }

    private var controls: some View {
        VStack(alignment: .leading, spacing: 9) {
            Picker(Strings.t("usage.range"), selection: Binding(get: { store.preset }, set: {
                shownSessions = 20
                store.select($0, client: client, actionToken: actionToken)
            })) {
                ForEach(UsageDateRange.allCases) { Text($0.title).tag($0) }
            }.pickerStyle(.menu)
            if store.preset == .custom, store.resetSelection == nil {
                HStack {
                    DatePicker(Strings.t("usage.from"), selection: $store.customFrom, in: ...Date(), displayedComponents: .date)
                    DatePicker(Strings.t("usage.to"), selection: $store.customTo, in: ...Date(), displayedComponents: .date)
                }.datePickerStyle(.field).font(.caption)
                Button(Strings.t("usage.apply")) { store.applyCustom(client: client, actionToken: actionToken) }.controlSize(.small)
            }
            if !store.resetChoices.isEmpty {
                Menu {
                    ForEach(store.resetChoices) { period in
                        Button(resetTitle(period)) {
                            shownSessions = 20
                            store.selectReset(period, client: client, actionToken: actionToken)
                        }.disabled(period.fromMs == nil || period.toMs == nil)
                    }
                } label: {
                    Label(Strings.t("usage.chooseReset"), systemImage: "clock.arrow.circlepath")
                }.controlSize(.small)
            }
            if let reset = store.resetSelection {
                Text([reset.provider, reset.accountLabel ?? accountTitle(provider: reset.provider, account: reset.account), reset.label,
                      reset.resetKind.map { Strings.t("usage.reset." + $0) }].compactMap { $0 }.joined(separator: " · "))
                    .font(.caption).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                Button(Strings.t("usage.allAccounts")) { store.select(.sinceThursday, client: client, actionToken: actionToken) }
                    .buttonStyle(.link).font(.caption)
            }
        }
    }

    private func summary(_ report: UsageReport) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(interval(report.fromMs, report.toMs, zone: report.timeZone))
                .font(.callout).foregroundStyle(.secondary)
            HStack(alignment: .firstTextBaseline) {
                Text(number(report.total.totalTokens)).font(.system(size: 26, weight: .semibold, design: .rounded)).monospacedDigit()
                Text(Strings.t("usage.tokens")).foregroundStyle(.secondary)
            }.accessibilityElement(children: .combine)
            Text(report.coverage.filesPending > 0 ? Strings.t("usage.comparisonPending")
                : comparison(current: report.total.totalTokens, previous: report.previous.totalTokens))
                .font(.callout).foregroundStyle(.secondary)
            Text(Strings.t("usage.previousInterval", interval(report.fromMs - (report.toMs - report.fromMs), report.fromMs, zone: report.timeZone)))
                .font(.caption).foregroundStyle(.secondary)
            tokenDetails(report.total)
            Text(Strings.t("usage.tokenCaveat"))
                .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            if report.total.totalTokens == 0 {
                Text(Strings.t("usage.empty")).font(.callout).foregroundStyle(.secondary)
            }
        }
    }

    @ViewBuilder private func buckets(_ report: UsageReport) -> some View {
        switch breakdown {
        case .days:
            if report.days.isEmpty { Text(Strings.t("usage.empty")).foregroundStyle(.secondary) }
            ForEach(report.days) { bucket in
                bucketRow(bucket, maximum: report.days.map { $0.totals.totalTokens }.max() ?? 0, compare: false)
            }
        case .models:
            Text(Strings.t("usage.modelHelp")).font(.caption).foregroundStyle(.secondary)
            ForEach(report.models) { bucket in
                bucketRow(bucket, maximum: report.models.map { $0.totals.totalTokens }.max() ?? 0, compare: true)
            }
        case .sessions:
            Text(Strings.t("usage.sessionHelp")).font(.caption).foregroundStyle(.secondary)
            ForEach(Array(report.sessions.prefix(shownSessions))) { bucket in
                bucketRow(bucket, maximum: report.sessions.map { $0.totals.totalTokens }.max() ?? 0, compare: true)
            }
            if report.sessions.count > shownSessions {
                Button(Strings.t("usage.moreSessions", String(report.sessions.count - shownSessions))) { shownSessions += 20 }
                    .buttonStyle(.link)
            }
        case .resets:
            Text(Strings.t("usage.resetHelp")).font(.caption).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            if report.resetPeriods.isEmpty {
                Text(Strings.t("usage.noResets")).foregroundStyle(.secondary)
            }
            ForEach(report.resetPeriods) { bucket in
                VStack(alignment: .leading, spacing: 6) {
                    Text(resetTitle(bucket)).font(.callout).fontWeight(.medium)
                        .fixedSize(horizontal: false, vertical: true)
                    Text(Strings.t("usage.observedTokens", number(bucket.totals.totalTokens))).monospacedDigit()
                    tokenDetails(bucket.totals)
                    if let activity = bucket.activity { activityDetails(activity) }
                    if let resetAt = bucket.resetAtMs, bucket.startClipped == true {
                        Text(Strings.t("usage.clippedReset", dateTime(resetAt, zone: report.timeZone)))
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    Button(Strings.t("usage.inspectReset")) { store.selectReset(bucket, client: client, actionToken: actionToken) }
                        .buttonStyle(.link).font(.caption)
                }.padding(.vertical, 4)
            }
        }
    }

    private func bucketRow(_ bucket: UsageBucket, maximum: Double, compare: Bool) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(alignment: .firstTextBaseline) {
                Text(bucket.label.isEmpty ? Strings.t("usage.unknown") : bucket.label)
                    .fontWeight(.medium).lineLimit(2).help(bucket.label).textSelection(.enabled)
                Spacer(minLength: 8)
                Text(number(bucket.totals.totalTokens)).monospacedDigit().fixedSize()
            }
            if bucket.provider != nil || bucket.account != nil || bucket.isSubagent == true {
                Text([bucket.provider, bucket.accountLabel ?? accountTitle(provider: bucket.provider, account: bucket.account), bucket.isSubagent == true ? Strings.t("usage.subagent") : nil]
                    .compactMap { $0 }.joined(separator: " · "))
                    .font(.caption).foregroundStyle(.secondary)
            }
            GeometryReader { proxy in
                ZStack(alignment: .leading) {
                    Capsule().fill(Color.secondary.opacity(0.12))
                    Capsule().fill(Color.accentColor.opacity(0.7))
                        .frame(width: proxy.size.width * CGFloat(maximum > 0 ? min(1, max(0, bucket.totals.totalTokens / maximum)) : 0))
                }
            }.frame(height: 5).accessibilityHidden(true)
            if compare, store.report?.coverage.filesPending == 0, let previous = bucket.previousTotalTokens {
                Text(comparison(current: bucket.totals.totalTokens, previous: previous)).font(.caption).foregroundStyle(.secondary)
            }
            DisclosureGroup(Strings.t("usage.tokenDetails")) {
                VStack(alignment: .leading, spacing: 5) {
                    tokenDetails(bucket.totals)
                    if let activity = bucket.activity { activityDetails(activity) }
                    if let id = bucket.sessionId {
                        Text(id).font(.caption2.monospaced()).foregroundStyle(.secondary).textSelection(.enabled)
                    }
                }.frame(maxWidth: .infinity, alignment: .leading)
            }.font(.caption)
        }.padding(.vertical, 4)
    }

    private func tokenDetails(_ totals: UsageTotals) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(Strings.t("usage.tokenParts", number(totals.inputTokens), number(totals.outputTokens)))
            Text(Strings.t("usage.cachedParts", number(totals.cachedInputTokens), number(totals.cacheCreationTokens), number(totals.reasoningTokens)))
            Text(Strings.t("usage.requestParts", String(totals.requests), number(totals.subagentTokens)))
        }.font(.caption).monospacedDigit().foregroundStyle(.secondary)
    }

    private func activity(_ report: UsageReport) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            Text(Strings.t("usage.activityTitle")).font(.headline)
            activityDetails(report.activity)
            Text(Strings.t("usage.activityCaveat"))
                .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            Text(Strings.t("usage.requestCoverage", number(report.activity.attributedRequestTokens), number(report.activity.unattributedRequestTokens), String(report.activity.requestsWithoutUsage ?? 0)))
                .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            if let from = report.coverage.relayFirstObservedAtMs, let to = report.coverage.relayLastObservedAtMs {
                Text(Strings.t("usage.relayRange", interval(from, to, zone: report.timeZone)))
                    .font(.caption).foregroundStyle(.secondary)
            } else {
                Text(Strings.t("usage.noRelayRecords")).font(.caption).foregroundStyle(.secondary)
            }
            if let models = report.relayModels, !models.isEmpty {
                DisclosureGroup(Strings.t("usage.relayModels")) {
                    VStack(alignment: .leading, spacing: 10) {
                        Text(Strings.t("usage.relayModelsHelp")).font(.caption).foregroundStyle(.secondary)
                        ForEach(models) { model in
                            bucketRow(model, maximum: models.map { $0.totals.totalTokens }.max() ?? 0, compare: false)
                        }
                    }
                }.font(.callout)
            }
        }
    }

    private func activityDetails(_ activity: UsageActivity) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            if let count = activity.localCompactions {
                Text(Strings.t("usage.localCompactions", String(count)))
            }
            Text(Strings.t("usage.activityCounts", String(activity.compactions), String(activity.retries), String(activity.failedRequests)))
            Text(Strings.t("usage.activityTokens", number(activity.compactionTokens ?? 0), number(activity.retryTokens ?? 0)))
        }.font(.caption).monospacedDigit().foregroundStyle(.secondary)
    }

    private func coverage(_ report: UsageReport) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            Text(Strings.t("usage.coverageTitle")).font(.headline)
            Text(Strings.t("usage.fileCoverage", String(report.coverage.filesScanned), String(report.coverage.filesPending), String(report.coverage.filesSkipped), String(report.coverage.malformedLines)))
                .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            if report.coverage.unknownModelTokens > 0 {
                Text(Strings.t("usage.unknownModel", number(report.coverage.unknownModelTokens)))
                    .font(.caption).foregroundStyle(.orange)
            }
            ForEach(Array(report.coverage.notes.enumerated()), id: \.offset) { _, note in
                Text(coverageNote(note)).font(.caption).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Text(Strings.t("usage.generated", dateTime(report.generatedAtMs, zone: report.timeZone), report.timeZone))
                .font(.caption2).foregroundStyle(.secondary)
        }
    }

    private func coverageNote(_ note: String) -> String {
        let translated = Strings.t("usage.note." + note)
        return translated == "usage.note." + note ? note : translated
    }

    private func number(_ value: Double) -> String {
        value.formatted(.number.precision(.fractionLength(0)).locale(Locale(identifier: Strings.localeIdentifier())))
    }

    private func comparison(current: Double, previous: Double) -> String {
        guard previous > 0 else { return Strings.t("usage.noBaseline", number(previous)) }
        let delta = current - previous
        let sign = delta > 0 ? "+" : ""
        return Strings.t("usage.comparison", number(previous), sign + number(delta), sign + String(format: "%.1f", delta / previous * 100))
    }

    private func interval(_ from: Double, _ to: Double, zone: String) -> String {
        "\(dateTime(from, zone: zone)) – \(dateTime(to, zone: zone))"
    }

    private func dateTime(_ milliseconds: Double, zone: String) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: Strings.localeIdentifier())
        formatter.timeZone = TimeZone(identifier: zone) ?? .current
        formatter.dateFormat = "M/d HH:mm"
        return formatter.string(from: Date(timeIntervalSince1970: milliseconds / 1_000))
    }

    private func resetTitle(_ bucket: UsageBucket) -> String {
        let account = [bucket.provider, bucket.accountLabel ?? accountTitle(provider: bucket.provider, account: bucket.account)].compactMap { $0 }.joined(separator: " · ")
        guard let from = bucket.fromMs, let to = bucket.toMs else { return "\(account) · \(bucket.label)" }
        let kind = bucket.resetKind.map { Strings.t("usage.reset." + $0) }
        return [account, bucket.label, kind, interval(from, to, zone: store.report?.timeZone ?? TimeZone.current.identifier)]
            .compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
    }

    private func accountTitle(provider: String?, account: String?) -> String? {
        guard let account else { return nil }
        return accounts.first { $0.provider == provider && $0.account == account }?.accountLabel ?? account
    }
}
