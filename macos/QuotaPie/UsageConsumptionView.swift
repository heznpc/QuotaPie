import SwiftUI

/// Quota percentages and local token evidence have separate denominators.
struct UsageConsumptionView: View {
    @ObservedObject var local: UsageReportStore
    @ObservedObject var official: OfficialUsageStore
    let client: StatusClient?
    let actionToken: String?
    let accounts: [AccountState]
    @State private var category = 0
    @State private var onlyQuotaPie = false
    @State private var search = ""
    @State private var shown = 15
    @State private var officialShown = 3

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 6) {
                    Text(t("title")).font(.system(size: 26, weight: .bold))
                    Text(t("subtitle")).foregroundStyle(.secondary)
                }
                Spacer()
                Button { load(refresh: true) } label: { Image(systemName: "arrow.clockwise") }
                    .disabled(local.loading || official.loading)
            }
            officialQuota
            officialConversations
            if local.loading { HStack { ProgressView().controlSize(.small); Text(Strings.t("usage.loading")) } }
            if let error = local.error { Label(error, systemImage: "exclamationmark.circle").foregroundStyle(.orange) }
            if let report = local.report {
                localEvidence(report)
                consumptionList(report)
                DisclosureGroup(t("officialBreakdown")) { officialBreakdown.padding(.top, 10) }
            }
        }
        .accessibilityIdentifier("usage.consumption")
        .onAppear { load() }
        .onDisappear { local.stop(); official.stop() }
        .onChange(of: actionToken) { _ in load() }
    }

    private func load(refresh: Bool = false) {
        if local.preset != .sinceThursday { local.select(.sinceThursday, client: client, actionToken: actionToken) }
        else { local.load(client: client, actionToken: actionToken, refresh: refresh) }
        official.load(client: client, actionToken: actionToken, refresh: refresh)
    }

    private var officialQuota: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(t("officialQuota")).font(.headline)
            ForEach(accounts.filter { $0.provider == "codex" }) { account in
                HStack(alignment: .firstTextBaseline) {
                    Text(account.accountLabel).fontWeight(.medium)
                    Spacer()
                    if let window = account.windows.first(where: { $0.windowSeconds == 604800 || $0.bucket.hasSuffix(":10080") || $0.bucket == "weekly" }), let used = window.usedPercent {
                        Text(String(format: "%.1f%%", used) + " " + t("used")).font(.title3.bold()).monospacedDigit()
                        Text(t("observed") + " " + stamp(window.observedAtMs)).font(.caption).foregroundStyle(.secondary)
                    } else { Text(t("quotaUnknown")).foregroundStyle(.secondary) }
                }
            }
            Text(t("quotaScope")).font(.caption).foregroundStyle(.secondary)
        }.padding(16).background(.background, in: RoundedRectangle(cornerRadius: 12))
    }

    private var officialConversations: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(t("officialConversations")).font(.headline)
            Text(t("threadScope")).font(.caption).foregroundStyle(.secondary)
            if official.loading { ProgressView().controlSize(.small) }
            ForEach(official.report?.accounts ?? []) { account in
                HStack {
                    Text(account.label).fontWeight(.semibold)
                    Spacer()
                    if let asOf = account.threadsAsOfMs { Text(t("asOf") + " " + stamp(asOf)).font(.caption).foregroundStyle(.secondary) }
                    else { Text(Strings.t("usage.dashboard.freshnessUnknown")).font(.caption).foregroundStyle(.secondary) }
                }
                if account.threadsError != nil { Text(t("threadError")).font(.caption).foregroundStyle(.orange) }
                ForEach((account.threads ?? []).sorted { ($0.weeklyLimitPercent ?? -1) > ($1.weeklyLimitPercent ?? -1) }.prefix(officialShown)) { thread in
                    DisclosureGroup {
                        VStack(alignment: .leading, spacing: 7) {
                            Text(t("created") + " " + stamp(thread.createdAtMs)).font(.caption)
                            if thread.ownershipBasis == "profile" { Text(t("profileOwnership")).font(.caption).foregroundStyle(.secondary) }
                            ForEach(Array(thread.groups.enumerated()), id: \.offset) { _, group in
                                HStack {
                                    Text(group.model + " · " + group.reasoningEffort)
                                    Spacer()
                                    Text(group.weeklyLimitPercent.map { String(format: "%.2f%%", $0) } ?? "—").monospacedDigit()
                                }.font(.callout)
                            }
                            Text(t("officialSubagentUnknown")).font(.caption).foregroundStyle(.secondary)
                            Text(thread.threadId).font(.caption.monospaced()).textSelection(.enabled)
                        }.padding(.top, 8)
                    } label: {
                        HStack(alignment: .top) {
                            VStack(alignment: .leading, spacing: 3) {
                                Text(thread.title).lineLimit(2).help(thread.title)
                                Text(t(thread.createdAtMs >= requestedStart ? "bornInRange" : "predatesRange") + " · " + t("descendants") + " " + String(thread.descendantCount))
                                    .font(.caption).foregroundStyle(.secondary)
                            }
                            Spacer()
                            Text(thread.weeklyLimitPercent.map { String(format: "%.2f%%", $0) } ?? t("unavailable"))
                                .font(.headline).monospacedDigit().fixedSize()
                        }
                    }
                    Divider()
                }
                if (account.threads ?? []).count > officialShown { Button(t("more")) { officialShown += 10 } }
                if (account.threads ?? []).isEmpty { Text(t("threadError")).font(.caption).foregroundStyle(.secondary) }
            }
        }.padding(18).background(.background, in: RoundedRectangle(cornerRadius: 12))
    }

    private var requestedStart: Double {
        local.report?.fromMs ?? (UsageDateRange.sinceThursday.interval(now: Date())?.start.timeIntervalSince1970 ?? 0) * 1000
    }

    private func localEvidence(_ report: UsageReport) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text(t("localEvidence")).font(.headline)
                Spacer()
                Text(stamp(report.fromMs) + " – " + stamp(report.toMs)).font(.callout)
            }
            if report.coverage.filesPending > 0 { Text(t("partial")).foregroundStyle(.orange) }
            if report.coverage.filesSkipped > 0 || report.coverage.malformedLines > 0 || (report.coverage.compressedFilesSkipped ?? 0) > 0 {
                Text(Strings.t("usage.consumption.incomplete", String(report.coverage.compressedFilesSkipped ?? 0), String(report.coverage.filesSkipped), String(report.coverage.malformedLines)))
                    .font(.caption).foregroundStyle(.orange)
            }
            DisclosureGroup(t("coverage")) {
                Text(Strings.t("usage.fileCoverage", String(report.coverage.filesScanned), String(report.coverage.filesPending), String(report.coverage.filesSkipped), String(report.coverage.malformedLines))).font(.caption)
                ForEach(Array(report.coverage.notes.enumerated()), id: \.offset) { _, note in
                    Text(Strings.t("usage.note." + note) == "usage.note." + note ? note : Strings.t("usage.note." + note)).font(.caption).foregroundStyle(.secondary)
                }
            }.font(.caption)
            HStack(alignment: .top, spacing: 14) {
                metric(t("totalLocal"), compact(report.total.totalTokens), t("tokensNotQuota"))
                metric(t("subagents"), share(report.total.subagentTokens, report.total.totalTokens), compact(report.total.subagentTokens) + " " + t("tokens"))
                if let qp = report.consumption?.quotapie {
                    metric(t("qpDevelopment"), share(qp.development.totalTokens, report.total.totalTokens), compact(qp.development.totalTokens) + " " + t("tokens"))
                }
            }
            if let qp = report.consumption?.quotapie {
                HStack(alignment: .top) {
                    VStack(alignment: .leading, spacing: 5) {
                        Text(t("qpEvidence")).font(.callout)
                        Text(t("qpRelay") + ": " + String(qp.relay.compactions) + " / " + String(qp.relay.retries))
                            .font(.callout).monospacedDigit()
                        Text(t("relayTokens") + ": " + compact(qp.relay.compactionTokens ?? 0) + " / " + compact(qp.relay.retryTokens ?? 0))
                            .font(.caption).monospacedDigit()
                    }
                    Spacer()
                    Button(t("showQP")) { onlyQuotaPie = true; category = 0; shown = 15 }
                }
                if let candidates = qp.candidates, candidates.totalTokens > 0 {
                    Text(t("candidates") + ": " + compact(candidates.totalTokens) + " " + t("tokens")).font(.caption).foregroundStyle(.secondary)
                }
                Text(t("qpCaveat")).font(.caption).foregroundStyle(.secondary)
            }
            Text(t("localCaveat")).font(.caption).foregroundStyle(.secondary)
        }
    }

    private func metric(_ title: String, _ value: String, _ detail: String) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(title).font(.callout).foregroundStyle(.secondary)
            Text(value).font(.title2.bold()).monospacedDigit()
            Text(detail).font(.caption).foregroundStyle(.secondary)
        }.frame(maxWidth: .infinity, alignment: .leading).padding(14)
            .background(.background, in: RoundedRectangle(cornerRadius: 10))
    }

    private func consumptionList(_ report: UsageReport) -> some View {
        let rows = visibleRows(report)
        return VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text(t("largestWork")).font(.headline)
                Spacer()
                Picker("", selection: $category) {
                    Text(t("conversations")).tag(0)
                    Text(t("models")).tag(1)
                    Text(t("subagents")).tag(2)
                }.pickerStyle(.segmented).frame(width: 300)
            }
            HStack {
                TextField(t("search"), text: $search).textFieldStyle(.roundedBorder)
                if category != 1 { Toggle(t("onlyQP"), isOn: $onlyQuotaPie).toggleStyle(.checkbox) }
            }
            Text(t(category == 2 ? "subagentScope" : "rowScope")).font(.caption).foregroundStyle(.secondary)
            if rows.isEmpty { Text(t("noRows")).foregroundStyle(.secondary) }
            ForEach(Array(rows.prefix(shown))) { row in
                rowView(row, report: report)
                Divider()
            }
            if rows.count > shown { Button(t("more")) { shown += 20 } }
        }.padding(18).background(.background, in: RoundedRectangle(cornerRadius: 12))
    }

    private func visibleRows(_ report: UsageReport) -> [UsageBucket] {
        let rows = category == 1 ? report.models : category == 2 ? (report.consumption?.subagents ?? report.sessions.filter { $0.isSubagent == true }) : (report.consumption?.conversations ?? report.sessions)
        let ids = Set((report.consumption?.quotapie.developmentSessionIds ?? []) + (report.consumption?.quotapie.candidateSessionIds ?? []))
        return rows.filter { row in
            (category == 1 || !onlyQuotaPie || row.quotapieEvidence != nil || row.quotapieCandidateEvidence != nil || ids.contains(row.sessionId ?? "")) &&
            (search.isEmpty || row.label.localizedCaseInsensitiveContains(search) || (row.sessionId?.localizedCaseInsensitiveContains(search) ?? false))
        }.sorted { $0.totals.totalTokens > $1.totals.totalTokens }
    }

    private func quotaPieBadge(_ row: UsageBucket) -> String? {
        if row.quotapieCandidateEvidence == "parent_repository" { return t("parentRepoCandidateBadge") }
        if row.quotapieEvidence != nil { return "QuotaPie" }
        if row.quotapieCandidateEvidence == "inherited_title" { return t("inheritedCandidateBadge") }
        return row.quotapieCandidateEvidence != nil ? t("candidateBadge") : nil
    }

    private func rowView(_ row: UsageBucket, report: UsageReport) -> some View {
        DisclosureGroup { rowDetails(row) } label: { rowLabel(row, report: report) }
    }

    private func rowDetails(_ row: UsageBucket) -> some View {
            VStack(alignment: .leading, spacing: 7) {
                Text(t("tokenParts") + ": " + compact(row.totals.inputTokens) + " / " + compact(row.totals.cachedInputTokens) + " / " + compact(row.totals.outputTokens)).font(.caption)
                if let models = row.models, !models.isEmpty {
                    ForEach(models) { model in
                        HStack { Text(model.label); Spacer(); Text(compact(model.totals.totalTokens) + " · " + share(model.totals.totalTokens, row.totals.totalTokens)) }
                            .font(.callout)
                    }
                }
                if let evidence = row.quotapieEvidence ?? row.quotapieCandidateEvidence { Text(t("evidence." + evidence)).font(.caption).foregroundStyle(.secondary) }
                if let parent = row.parentSessionId { Text(t("parent") + ": " + parent).font(.caption).textSelection(.enabled) }
                if let id = row.sessionId { Text(id).font(.caption.monospaced()).textSelection(.enabled) }
                if let repo = row.repositoryUrl { Text(repo).font(.caption).textSelection(.enabled) }
                Text(t("rowQuotaUnknown")).font(.caption).foregroundStyle(.secondary)
            }.padding(.top, 8)
    }

    private func rowLabel(_ row: UsageBucket, report: UsageReport) -> some View {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(row.label).lineLimit(2).help(row.label)
                    Text([row.accountLabel ?? row.account, row.isSubagent == true ? t("subagent") : nil, quotaPieBadge(row)].compactMap { $0 }.joined(separator: " · "))
                        .font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                VStack(alignment: .trailing, spacing: 3) {
                    Text(share(row.totals.totalTokens, report.total.totalTokens)).fontWeight(.semibold)
                    Text(compact(row.totals.totalTokens) + " " + t("tokens")).font(.caption).foregroundStyle(.secondary)
                }.monospacedDigit().fixedSize()
            }
    }

    private var officialBreakdown: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(t("officialScope")).font(.caption).foregroundStyle(.secondary)
            ForEach(official.report?.accounts ?? []) { account in
                Text(account.label).font(.headline)
                if let report = official.report { Text(report.startDate + " – " + report.endDate + " UTC").font(.caption) }
                if account.status != "ready" { Text(t("officialUnavailable")).foregroundStyle(.secondary) }
                else {
                    officialRows(account.models, title: t("models"))
                    officialRows(account.features, title: t("features"))
                }
            }
        }
    }

    private func officialRows(_ rows: [OfficialUsageRow], title: String) -> some View {
        let total = rows.reduce(0) { $0 + $1.value }
        return VStack(alignment: .leading, spacing: 6) {
            Text(title).font(.callout.bold())
            ForEach(rows.sorted { $0.value > $1.value }.prefix(8)) { row in
                HStack {
                    Text(Strings.t("usage.dashboard.category." + row.key) == "usage.dashboard.category." + row.key ? row.key : Strings.t("usage.dashboard.category." + row.key))
                    Spacer()
                    Text(share(row.value, total)).monospacedDigit()
                }
            }
        }
    }

    private func t(_ key: String) -> String { Strings.t("usage.consumption." + key) }
    private func share(_ value: Double, _ total: Double) -> String { total > 0 ? String(format: "%.1f%%", value / total * 100) : "—" }
    private func compact(_ value: Double) -> String { value.formatted(.number.notation(.compactName).precision(.fractionLength(0...1)).locale(Locale(identifier: Strings.localeIdentifier()))) }
    private func stamp(_ value: Double) -> String { Date(timeIntervalSince1970: value / 1000).formatted(.dateTime.month().day().hour().minute()) }
}
