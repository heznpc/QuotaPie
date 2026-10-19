import SwiftUI

struct DetailsView: View {
    @ObservedObject var model: PopoverModel
    @Binding var section: DetailSection
    let actions: PopoverActions
    let back: () -> Void
    @State private var compactionExpanded = false

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Button(action: back) {
                    Label(model.detailBackTitle, systemImage: "chevron.left")
                }.buttonStyle(.plain).accessibilityIdentifier("navigation.detailBack")
                Spacer()
                Button(action: actions.openSettings) { Image(systemName: "gearshape") }
                    .buttonStyle(.borderless)
                    .accessibilityLabel(Strings.t("detail.settings"))
                    .accessibilityIdentifier("details.openSettings")
                if section == .quota, model.inspectedAccountID != nil, let account = model.displayedAccount {
                    Text("\(account.providerTitle) · \(account.accountLabel)")
                        .font(.caption).foregroundStyle(.secondary).lineLimit(1)
                }
            }.padding(.horizontal, 16).padding(.top, 14)
            Picker("", selection: $section) {
                ForEach(DetailSection.allCases.filter { $0 != .settings && $0 != .usage }) { section in
                    Text(section.title).tag(section)
                }
            }
            .pickerStyle(.segmented).labelsHidden().padding(16)
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    if let error = model.lastError {
                        CalloutView(text: model.statusFailureText, detail: error, tone: .warning)
                    }
                    if let error = model.detailsError {
                        Text(error).font(.caption).foregroundStyle(.orange)
                    }
                    if section != .quota && section != .usage && section != .settings && !model.detailsLoaded {
                        if model.detailsLoading { ProgressView() }
                        Text(model.detailsError ?? Strings.t("details.loading")).foregroundStyle(.secondary)
                    } else { detailContent }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(16)
            }
            .clipped()
            .id(section)
            .id(model.detailLocationID)
            Divider()
            HStack {
                Button(action: {
                    if section == .usage { actions.openUsageReport() }
                    else { actions.refresh() }
                }) {
                    Label(Strings.t("action.refresh"), systemImage: "arrow.clockwise")
                }
                Spacer()
                if let last = model.displayedMeasurementDate {
                    Text(DisplayFormat.age(since: last)).font(.caption).foregroundStyle(.secondary)
                }
            }
            .buttonStyle(.borderless).padding(.horizontal, 20).padding(.vertical, 12)
        }
        .onChange(of: section) {
            if $0 == .usage { actions.openUsageReport() }
            if $0 == .settings { actions.openSettings() }
        }

    }

    @ViewBuilder private var detailContent: some View {
        switch section {
        case .quota:
            if let payload = model.payload, !payload.accounts.isEmpty {
                ForEach(orderedAccounts) { account in
                    AccountSection(
                        account: account,
                        recovery: payload.resetTracking?.accounts.first { $0.provider == account.provider && $0.account == account.account },
                        transportUnavailable: model.lastError != nil,
                        onOpenConfig: actions.openConfig,
                        onCopyCommand: actions.copyCommand
                    )
                    Divider()
                }
            } else {
                Text(Strings.t("popover.noAccountsDetail")).foregroundStyle(.secondary)
                Button(Strings.t("action.openSettings"), action: actions.openSettings)
            }
        case .work:
            if model.focusedResumeTaskID != nil { pausedWork }
            AutoResumeSection(model: model)
            Divider()
            AutomaticWorkView(model: model)
            Divider()
            if let goals = model.payload?.hostGoals, !goals.items.isEmpty {
                HostGoalsSection(payload: goals, isLoading: false,
                                 transportUnavailable: model.lastError != nil,
                                 tasks: model.activeTasks, onReview: { model.showDetails(.work, taskID: $0) })
                Divider()
            }
            if model.focusedResumeTaskID == nil { pausedWork }
            if let jobs = model.payload?.jobs, !jobs.isEmpty {
                let current = jobs.filter { !["succeeded", "cancelled"].contains($0.state) }
                let finished = jobs.filter { ["succeeded", "cancelled"].contains($0.state) }
                if !current.isEmpty { ManagedJobsSection(jobs: current) }
                if !finished.isEmpty {
                    DisclosureGroup(Strings.t("settings.organized.finishedJobs", String(finished.count))) {
                        ManagedJobsSection(jobs: finished).padding(.top, 8)
                    }
                }
                Divider()
            }
            RecentWorkSection(items: model.payload?.recentWork ?? [],
                              supportsRecentWork: model.payload?.supportsRecentWork ?? true,
                              state: model.payload?.recentWorkState ?? "loading",
                              canOpen: model.canActOnTasks,
                              activities: model.recentWorkActivities,
                              onOpen: actions.openRecentWork)
        case .activity:
            if let savings = model.payload?.compaction?.savings {
                VStack(alignment: .leading, spacing: 10) {
                    if !savings.active.isEmpty {
                        TaskSavingsHistory(payload: TaskSavingsPayload(policy: savings.policy, insights: nil, active: savings.active, recent: []),
                            busy: model.savingsSaving, undo: { actions.configureSavings(nil, $0, nil) })
                    } else {
                        Text(Strings.t("savings.title")).font(.headline)
                        if let latest = savings.latest {
                            Text(latest.summary).font(.callout)
                            Text(Strings.t("savings.phase." + latest.phase))
                                .font(.caption).foregroundStyle(latest.phase == "failed" || latest.phase == "unverified" ? Color.orange : Color.secondary)
                        } else { Text(Strings.t("savings.waiting")).foregroundStyle(.secondary) }
                    }
                    if let message = model.savingsMessage {
                        Text(message).font(.callout)
                            .foregroundStyle(message == Strings.t("savings.error") || message == Strings.t("savings.pending") ? Color.orange : Color.secondary)
                    }
                    if !savings.recent.isEmpty || !(savings.insights ?? []).isEmpty {
                        DisclosureGroup(Strings.t("settings.organized.activityHistory")) {
                            TaskSavingsHistory(payload: TaskSavingsPayload(policy: savings.policy, insights: savings.insights, active: [], recent: savings.recent),
                                busy: model.savingsSaving, undo: { actions.configureSavings(nil, $0, nil) }).padding(.top, 8)
                        }
                    }
                }
                Divider()
            }
            if !model.recentRecoveries.isEmpty {
                RecentRecoveriesView(recoveries: Array(model.recentRecoveries.prefix(1)))
                if model.recentRecoveries.count > 1 {
                    DisclosureGroup(Strings.t("settings.organized.historyCount", String(model.recentRecoveries.count - 1))) {
                        RecentRecoveriesView(recoveries: Array(model.recentRecoveries.dropFirst())).padding(.top, 8)
                    }
                }
                Divider()
            }
            if let compaction = model.payload?.compaction, compaction.generations > 0 {
                VStack(alignment: .leading, spacing: 10) {
                    Text(Strings.t("compaction.title")).font(.headline)
                    if compaction.reachable < compaction.generations {
                        Text(Strings.t("compaction.partial")).font(.callout).foregroundStyle(.orange)
                    }
                    ForEach(compaction.active.isEmpty ? Array(compaction.recent.prefix(1)) : compaction.active) { record in
                        CompactionSummary(record: record, openHistory: { compactionExpanded = true })
                        if let error = record.errorCode {
                            Text(Strings.t("compaction.evidence", error)).font(.caption).foregroundStyle(.orange)
                        }
                    }
                    if compaction.latest == nil { Text(Strings.t("compaction.empty")).foregroundStyle(.secondary) }
                    DisclosureGroup(Strings.t("settings.organized.historyCount", String(compaction.recent.count)), isExpanded: $compactionExpanded) {
                        CompactionHistory(payload: compaction).padding(.top, 8)
                    }
                }
                Divider()
            }
            Text(Strings.t("popover.recentChanges")).font(.headline)
            if let events = model.payload?.events, !events.isEmpty {
                RecentChanges(events: events)
            } else {
                Text(Strings.t("detail.noChanges")).foregroundStyle(.secondary)
            }
            Button(Strings.t("action.openDashboard"), action: actions.openDashboard)
                .buttonStyle(.link)
        case .usage:
            Button(action: actions.openUsageReport) {
                Label(Strings.t("usage.window.open"), systemImage: "chart.bar.xaxis")
            }.buttonStyle(.borderedProminent)
            Text(Strings.t("usage.window.description")).foregroundStyle(.secondary)
        case .resets:
            ResetSignalHistory(feed: model.payload?.resetSignals)
        case .settings:
            Button(action: actions.openSettings) {
                Label(Strings.t("settings.organized.open"), systemImage: "gearshape")
            }.buttonStyle(.borderedProminent)
            Text(Strings.t("settings.organized.description")).foregroundStyle(.secondary)
        }
    }

    @ViewBuilder private var pausedWork: some View {
        if let id = model.focusedResumeTaskID {
            VStack(alignment: .leading, spacing: 8) {
                Text(Strings.t("resume.linkedTask")).font(.headline)
                if let task = model.activeTasks.first(where: { $0.id == id }) {
                    PausedWorkSection(tasks: [task], hasActionToken: model.canActOnTasks,
                        activities: model.resumeActivities, onResume: actions.resumeTask,
                        onRetry: actions.retryTask, onDismiss: actions.dismissTask)
                } else {
                    Text(Strings.t("resume.linkedUnavailable")).foregroundStyle(.secondary)
                }
                Button(Strings.t("resume.showAll")) { model.focusedResumeTaskID = nil }
                    .buttonStyle(.link)
            }
        } else if !model.activeTasks.isEmpty {
            PausedWorkSection(tasks: model.activeTasks, hasActionToken: model.canActOnTasks,
                              activities: model.resumeActivities, onResume: actions.resumeTask,
                              onRetry: actions.retryTask, onDismiss: actions.dismissTask)
        } else {
            Text(Strings.t("detail.noPausedTasks")).foregroundStyle(.secondary)
        }
        Divider()
    }

    private var orderedAccounts: [AccountState] {
        let accounts = model.payload?.accounts ?? []
        if let inspectedID = model.inspectedAccountID {
            return accounts.filter { $0.id == inspectedID }
        }
        return accounts
    }


}

private struct ManagedJobsSection: View {
    let jobs: [ManagedJobSummary]

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text(Strings.t("jobs.title")).font(.headline)
            ForEach(jobs) { job in
                VStack(alignment: .leading, spacing: 5) {
                    HStack(alignment: .firstTextBaseline) {
                        Text(job.label).fontWeight(.medium)
                        Spacer(minLength: 12)
                        Text(job.stateTitle).font(.callout)
                    }
                    Text("\(job.providerTitle) · \(job.account) · \(job.progressTitle)")
                        .font(.callout).monospacedDigit().foregroundStyle(.secondary)
                    Text(job.policyTitle).font(.caption).foregroundStyle(.secondary)
                    if let reason = job.reasonTitle {
                        Text(reason).font(.callout).foregroundStyle(.secondary)
                    }
                }
                .fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}
