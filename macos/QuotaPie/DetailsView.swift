import SwiftUI

final class DetailsModel: ObservableObject {
    @Published var section: DetailSection = .quota
}

struct DetailsView: View {
    @ObservedObject var model: PopoverModel
    @ObservedObject var navigation: DetailsModel
    @ObservedObject private var awake = AwakeController.shared
    let actions: PopoverActions

    var body: some View {
        VStack(spacing: 0) {
            Picker("", selection: $navigation.section) {
                ForEach(DetailSection.allCases) { section in
                    Text(section.title).tag(section)
                }
            }
            .pickerStyle(.segmented).labelsHidden().padding(20)
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    if let error = model.lastError {
                        CalloutView(text: Strings.t("popover.disconnected"), detail: error, tone: .warning)
                    }
                    detailContent
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(24)
            }
            .clipped()
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
        .frame(minWidth: 540, minHeight: 420)
    }

    @ViewBuilder private var detailContent: some View {
        switch navigation.section {
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
            if !model.activeTasks.isEmpty {
                PausedWorkSection(tasks: model.activeTasks, hasActionToken: model.canActOnTasks,
                                  activities: model.resumeActivities, onResume: actions.resumeTask,
                                  onRetry: actions.retryTask, onDismiss: actions.dismissTask)
                Divider()
            } else {
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
                Text(Strings.t("detail.notifications")).font(.headline)
                Text(Strings.t(model.notificationsAllowed == false ? "notification.disabled" :
                                model.notificationsAllowed == true ? "notification.enabled" : "notification.checking"))
                    .font(.callout).foregroundStyle(.secondary)
                Button(Strings.t("notification.settings"), action: actions.openNotificationSettings)
            }
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
