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
                    Label(Strings.t("navigation.overview"), systemImage: "chevron.left")
                }.buttonStyle(.plain)
                Spacer()
                if let account = model.selectedAccount {
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
                    detailContent
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(16)
            }
            .clipped()
            .id(section)
            .id(model.detailLocationID)
            Divider()
            HStack {
                Button(action: actions.refresh) {
                    Label(Strings.t("action.refresh"), systemImage: "arrow.clockwise")
                }
                Spacer()
                if let last = model.lastSuccessAt {
                    Text(DisplayFormat.age(since: last)).font(.caption).foregroundStyle(.secondary)
                }
            }
            .buttonStyle(.borderless).padding(.horizontal, 20).padding(.vertical, 12)
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
                Button(Strings.t("action.openSettings"), action: actions.openConfig)
            }
        case .activity:
            if let savings = model.payload?.compaction?.savings {
                TaskSavingsHistory(payload: savings, busy: model.savingsSaving, undo: { actions.configureSavings(nil, $0) })
                Divider()
            }
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
                Divider()
            }
            if !model.recentRecoveries.isEmpty {
                RecentRecoveriesView(recoveries: model.recentRecoveries)
                Divider()
            }
            if let jobs = model.payload?.jobs, !jobs.isEmpty {
                ManagedJobsSection(jobs: jobs)
                Divider()
            }
            if let compaction = model.payload?.compaction, compaction.generations > 0 {
                CompactionHistory(payload: compaction)
                Divider()
            }
            if !model.activeTasks.isEmpty && model.focusedResumeTaskID == nil {
                PausedWorkSection(tasks: model.activeTasks, hasActionToken: model.canActOnTasks,
                                  activities: model.resumeActivities, onResume: actions.resumeTask,
                                  onRetry: actions.retryTask, onDismiss: actions.dismissTask)
                Divider()
            } else if model.activeTasks.isEmpty && model.focusedResumeTaskID == nil {
                Text(Strings.t("detail.noPausedTasks")).foregroundStyle(.secondary)
            }
            Text(Strings.t("popover.recentChanges")).font(.headline)
            if let events = model.payload?.events, !events.isEmpty {
                RecentChanges(events: events)
            } else {
                Text(Strings.t("detail.noChanges")).foregroundStyle(.secondary)
            }
            Button(Strings.t("action.openDashboard"), action: actions.openDashboard)
                .buttonStyle(.link)
        case .resets:
            ResetSignalHistory(feed: model.payload?.resetSignals)
        case .settings:
            settingsContent
        }
    }

    private var orderedAccounts: [AccountState] {
        let accounts = model.payload?.accounts ?? []
        return accounts.filter { $0.id == model.selectedAccount?.id }
            + accounts.filter { $0.id != model.selectedAccount?.id }
    }

    private var settingsContent: some View {
        VStack(alignment: .leading, spacing: 20) {
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
            TaskSavingsSettingsView(model: model, save: { actions.configureSavings($0, nil) })
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
