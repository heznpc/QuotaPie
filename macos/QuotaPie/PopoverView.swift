import SwiftUI

/// Overview and detail navigation stay inside the menu bar popover.
struct PopoverView: View {
    @ObservedObject var model: PopoverModel
    @ObservedObject private var awake = AwakeController.shared
    let actions: PopoverActions

    var body: some View {
        if model.detailSection != nil {
            DetailsView(model: model, section: Binding(
                get: { model.detailSection ?? .quota },
                set: { model.detailSection = $0 }
            ), actions: actions, back: model.showOverview)
                .frame(width: 460, height: model.popoverDetailHeight)
        } else {
            overview
        }
    }

    private var overview: some View {
        VStack(alignment: .leading, spacing: 0) {
#if DEBUG
            if ProcessInfo.processInfo.environment["QUOTAPIE_DEBUG_AUTO_OPEN"] == "1" {
                Text(Strings.t("overview.preview"))
                    .font(.caption).foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 20).padding(.top, 12)
            }
#endif
            quotaOverview.padding(20)
            if let savings = model.payload?.compaction?.savings, savings.policy?.enabled == true {
                Button { showDetails(.activity) } label: {
                    Label(savings.latest?.summary ?? Strings.t("savings.waiting"), systemImage: "leaf")
                        .font(.caption).frame(maxWidth: .infinity, alignment: .leading)
                }.buttonStyle(.plain).padding(.horizontal, 20).padding(.bottom, 12)
            }
            if let record = model.payload?.compaction?.latest {
                CompactionSummary(record: record, openHistory: { showDetails(.activity) })
                    .padding(.horizontal, 20).padding(.bottom, 12)
            }
            if !model.activeTasks.isEmpty {
                Divider().padding(.horizontal, 20)
                taskOverview.padding(20)
            }
            if let feed = model.payload?.resetSignals, feed.enabled {
                Divider().padding(.horizontal, 20)
                ResetSignalSummary(feed: feed, openHistory: { showDetails(.resets) })
                    .padding(.horizontal, 20).padding(.vertical, 16)
            }
            if awake.enabled || model.notificationsAllowed == false {
                Divider().padding(.horizontal, 20)
                statusLinks.padding(.horizontal, 20).padding(.vertical, 10)
            }
            Divider()
            footer.padding(.horizontal, 16).padding(.vertical, 12)
        }
        .frame(width: 380)
        .fixedSize(horizontal: false, vertical: true)
    }

    private func showDetails(_ section: DetailSection, taskID: String? = nil) {
        model.showDetails(section, taskID: taskID)
    }

    private var quotaOverview: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(alignment: .firstTextBaseline) {
                accountPicker
                Spacer(minLength: 8)
                if let last = model.lastSuccessAt {
                    Text(DisplayFormat.age(since: last))
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            if let account = model.selectedAccount {
                if let window = account.overviewWindow {
                    quotaReading(account: account, window: window)
                } else {
                    Text(account.collection.isHealthy ? Strings.t("overview.noGeneralQuota") : account.collection.actionText)
                        .font(.callout).foregroundStyle(.secondary)
                    detailButton("overview.quotaDetail", section: .quota)
                }
                if model.lastError != nil || !account.collection.isHealthy {
                    Button { showDetails(.quota) } label: {
                        Label(model.lastError != nil ? model.statusFailureText : account.collection.actionText,
                              systemImage: "exclamationmark.circle")
                            .font(.caption).foregroundStyle(.orange)
                            .multilineTextAlignment(.leading)
                    }
                    .buttonStyle(.plain)
                }
                if let recovery = model.selectedRecovery {
                    Button { showDetails(.activity) } label: {
                        HStack(spacing: 10) {
                            Image(systemName: "arrow.up.circle.fill").foregroundStyle(.green)
                            VStack(alignment: .leading, spacing: 3) {
                                HStack(spacing: 8) {
                                    Text(Strings.t("recovery.overview")).fontWeight(.medium)
                                    Text(DisplayFormat.age(since: Date(timeIntervalSince1970: recovery.evidence.observedByMs / 1_000)))
                                        .foregroundStyle(.secondary)
                                }
                                Text("\(recovery.label) · \(recovery.evidence.remainingText)")
                                    .foregroundStyle(.secondary)
                            }
                            Spacer(minLength: 0)
                            Text(Strings.t("overview.history")).foregroundStyle(Color.accentColor)
                        }
                        .font(.caption).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
            } else {
                Text(model.lastError == nil ? Strings.t("popover.noAccounts") : model.statusFailureText)
                    .font(.callout).foregroundStyle(.secondary)
                detailButton("overview.quotaDetail", section: .quota)
            }
        }
    }

    @ViewBuilder private var accountPicker: some View {
        if (model.payload?.accounts.filter(\.enabled).count ?? 0) > 1 {
        Menu {
            ForEach(model.payload?.accounts.filter(\.enabled) ?? []) { account in
                Button {
                    model.selectedAccountID = account.id
                } label: {
                    if model.selectedAccount?.id == account.id {
                        Label("\(account.providerTitle) · \(account.accountLabel)", systemImage: "checkmark")
                    } else {
                        Text("\(account.providerTitle) · \(account.accountLabel)")
                    }
                }
            }
        } label: {
            Text(model.selectedAccount.map { "\($0.providerTitle) · \($0.accountLabel)" } ?? "QuotaPie")
                .font(.system(size: 14, weight: .semibold))
                .lineLimit(1).truncationMode(.middle)
        }
        .menuStyle(.borderlessButton)
        .frame(maxWidth: 230, alignment: .leading)
        .accessibilityLabel(Strings.t("overview.chooseAccount"))
        } else {
            Text(model.selectedAccount.map { "\($0.providerTitle) · \($0.accountLabel)" } ?? "QuotaPie")
                .font(.system(size: 14, weight: .semibold))
                .lineLimit(1).truncationMode(.middle)
        }
    }

    private func quotaReading(account: AccountState, window: QuotaWindow) -> some View {
        let current = model.lastError == nil && account.collection.isHealthy && window.freshness == "fresh"
        let percent = window.remainingPercent.map { min(100, max(0, $0)) }
        return VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .bottom) {
                VStack(alignment: .leading, spacing: 2) {
                    HStack(alignment: .firstTextBaseline, spacing: 2) {
                        Text(percent.map { String(Int($0.rounded())) } ?? "—")
                            .font(.system(size: 40, weight: .semibold, design: .rounded).monospacedDigit())
                        if percent != nil {
                            Text("%").font(.system(size: 21, weight: .medium))
                        }
                    }
                    .foregroundStyle(current ? (window.isLowRemaining ? Color.red : Color.primary) : Color.secondary)
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel(Strings.t(current ? "overview.remaining" : "overview.cachedRemaining", window.shortLabel))
                    .accessibilityValue(percent.map { "\(Int($0.rounded()))%" } ?? "—")
                    Text(Strings.t(current ? "overview.remaining" : "overview.cachedRemaining", window.shortLabel))
                        .font(.callout).foregroundStyle(.secondary)
                }
                Spacer()
                detailButton("overview.quotaDetail", section: .quota).padding(.bottom, 3)
            }
            GeometryReader { geometry in
                ZStack(alignment: .leading) {
                    Capsule().fill(Color.primary.opacity(0.10))
                    Capsule().fill(current && window.isLowRemaining ? Color.red : Color.primary.opacity(current ? 0.75 : 0.28))
                        .frame(width: geometry.size.width * (percent ?? 0) / 100)
                }
            }
            .frame(height: 5).accessibilityHidden(true)
            Text(current && window.isExhausted ? Strings.t("window.exhausted") : DisplayFormat.resetStamp(window.resetsAtMs))
                .font(.caption).foregroundStyle(.secondary)
        }
    }

    private var taskOverview: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text(Strings.t("resume.sectionTitle")).font(.system(size: 12, weight: .semibold))
                Spacer()
                Text(Strings.t("overview.taskCounts",
                               String(model.activeTasks.filter(\.isReady).count),
                               String(model.activeTasks.filter { !$0.isReady }.count)))
                    .font(.caption).foregroundStyle(.secondary)
            }
            ForEach(Array(model.activeTasks.prefix(3))) { task in
                Button { showDetails(.activity, taskID: task.id) } label: {
                    HStack(spacing: 10) {
                        VStack(alignment: .leading, spacing: 3) {
                            Text(task.projectLabel).font(.system(size: 13, weight: .medium))
                                .foregroundStyle(.primary).lineLimit(1)
                            Text("\(task.providerTitle) · \(task.accountLabel)")
                                .font(.caption).foregroundStyle(.secondary).lineLimit(1)
                        }
                        Spacer(minLength: 8)
                        Text(Strings.t(task.isReady ? "overview.taskReady" : task.isApproved ? "overview.taskApproved" : "overview.taskWaiting"))
                            .font(.caption)
                            .foregroundStyle(task.isReady ? Color.accentColor : Color.secondary)
                        Image(systemName: "chevron.right").font(.system(size: 9, weight: .semibold))
                            .foregroundStyle(.tertiary)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help("\(task.projectLabel) · \(task.shortReference)")
            }
            if model.activeTasks.count > 3 {
                detailButton("overview.allTasks", section: .activity)
            }
        }
    }

    private var statusLinks: some View {
        HStack {
            if awake.enabled {
                Button { showDetails(.settings) } label: {
                    Label(Strings.t(awake.state == "holding" ? "overview.awakeHolding" : "overview.awakeEnabled"),
                          systemImage: "moon.zzz")
                }.foregroundStyle(.secondary)
            }
            Spacer()
            if model.notificationsAllowed == false {
                Button { showDetails(.settings) } label: {
                    Label(Strings.t("overview.alertsOff"), systemImage: "bell.slash")
                }.foregroundStyle(.orange)
            }
        }
        .font(.caption).buttonStyle(.plain)
    }

    private var footer: some View {
        HStack(spacing: 18) {
            Button(action: actions.refresh) {
                Label(Strings.t("action.refresh"), systemImage: "arrow.clockwise")
            }.help(Strings.t("action.refreshHelp"))
            Spacer(minLength: 0)
            Button(Strings.t("overview.activityDetail")) { showDetails(.activity) }
            Button(Strings.t("detail.settings")) { showDetails(.settings) }
        }
        .font(.caption).buttonStyle(.borderless)
    }

    private func detailButton(_ key: String, section: DetailSection) -> some View {
        Button { showDetails(section) } label: {
            HStack(spacing: 4) {
                Text(Strings.t(key))
                Image(systemName: "chevron.right").font(.system(size: 9, weight: .semibold))
            }
        }.font(.caption).buttonStyle(.borderless)
    }
}
