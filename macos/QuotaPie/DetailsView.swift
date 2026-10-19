import SwiftUI

struct DetailsView: View {
    @ObservedObject var model: PopoverModel
    @Binding var section: DetailSection
    @ObservedObject private var awake = AwakeController.shared
    let actions: PopoverActions
    let back: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Button(action: back) {
                    Label(model.detailBackTitle, systemImage: "chevron.left")
                }.buttonStyle(.plain).accessibilityIdentifier("navigation.detailBack")
                Spacer()
                if section == .quota, model.inspectedAccountID != nil, let account = model.displayedAccount {
                    Text("\(account.providerTitle) · \(account.accountLabel)")
                        .font(.caption).foregroundStyle(.secondary).lineLimit(1)
                }
            }.padding(.horizontal, 16).padding(.top, 14)
            Picker("", selection: $section) {
                ForEach(DetailSection.allCases) { section in
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
                    if section != .quota && section != .usage && !model.detailsLoaded {
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
        .onChange(of: section) { if $0 == .usage { actions.openUsageReport() } }

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
                Button(Strings.t("action.openSettings"), action: actions.openConfig)
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
                ManagedJobsSection(jobs: jobs)
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
                TaskSavingsHistory(payload: savings, busy: model.savingsSaving, undo: { actions.configureSavings(nil, $0, nil) })
                Divider()
            }
            if !model.recentRecoveries.isEmpty {
                RecentRecoveriesView(recoveries: model.recentRecoveries)
                Divider()
            }
            if let compaction = model.payload?.compaction, compaction.generations > 0 {
                CompactionHistory(payload: compaction)
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
            settingsContent
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
        return accounts.filter { $0.id == model.displayedAccount?.id }
            + accounts.filter { $0.id != model.displayedAccount?.id }
    }

    private var settingsContent: some View {
        VStack(alignment: .leading, spacing: 20) {
            AccountNicknamesView(model: model, refresh: actions.refresh)
            Divider()
            VStack(alignment: .leading, spacing: 8) {
                NotificationPreferencesView(model: model, save: actions.configureNotifications)
                Text(Strings.t(model.notificationsAllowed == false ? "notification.disabled" :
                                model.notificationsAllowed == true ? "notification.enabled" : "notification.checking"))
                    .font(.callout).foregroundStyle(.secondary)
                Button(Strings.t("notification.settings"), action: actions.openNotificationSettings)
            }
            Divider()
            CodexProfilesView(status: model, actions: actions)
            Divider()
            DotsConnectionView(model: model)
            Divider()
            AccountPoolSettingsView(model: model, save: actions.configurePool)
            Divider()
            TaskSavingsSettingsView(model: model, save: { actions.configureSavings($0, nil, nil) }, saveTests: { actions.configureSavings(nil, nil, $0) })
            Divider()
            CompactionSettingsView(model: model, save: actions.configureCompaction)
            Divider()
            VStack(alignment: .leading, spacing: 10) {
                Toggle(Strings.t("awake.title"), isOn: $awake.enabled).toggleStyle(.switch)
                Text(awake.summary).font(.callout).foregroundStyle(.secondary)
                if awake.enabled {
                    Toggle(Strings.t("awake.closedLid"), isOn: $awake.closedLid).toggleStyle(.switch)
                    if awake.closedLid || awake.helperState != "not-installed" {
                        Text(awake.lidSummary).font(.caption).foregroundStyle(.secondary)
                    }
                    HStack {
                        Button(Strings.t("awake.connect")) { awake.connectAgents() }
                        if awake.helperState == "not-installed" {
                            Button(Strings.t("awake.install")) { awake.installHelper() }
                        }
                    }.disabled(awake.busy)
                    Text(Strings.t("awake.limits")).font(.caption).foregroundStyle(.secondary)
                }
                if let message = awake.message {
                    Text(message).font(.caption).fixedSize(horizontal: false, vertical: true)
                }
            }
            Divider()
            HStack {
                Button(Strings.t("action.openSettings"), action: actions.openConfig)
                Button(Strings.t("action.copy"), action: actions.copy)
                Spacer()
                Button(Strings.t("action.quit"), action: actions.quit)
            }
        }
        .buttonStyle(.bordered).controlSize(.small)
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
