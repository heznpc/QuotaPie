import SwiftUI

/// Overview and detail navigation stay inside the menu bar popover.
struct PopoverView: View {
    @ObservedObject var model: PopoverModel
    @ObservedObject private var awake = AwakeController.shared
    @ObservedObject private var profiles = CodexProfilesModel.shared
    @State private var overviewSupplementaryExpanded = false
    @State private var showingConnectionRecovery = false
    let actions: PopoverActions

    var body: some View {
        Group {
            if model.detailSection != nil {
                DetailsView(model: model, section: Binding(
                    get: { model.detailSection ?? .quota },
                    set: { model.detailSection = $0 }
                ), actions: actions, back: model.showOverview)
                    .frame(width: 460, height: AppVerification.current?.contentHeight.map { CGFloat(min(1200, max(560, $0))) } ?? model.popoverDetailHeight)
            } else if model.isShowingAccountList {
                accountList
            } else {
                overview
            }
        }
        .task {
            while !Task.isCancelled {
                actions.loadRequestAccounts { _ in }
                do { try await Task.sleep(nanoseconds: 5_000_000_000) }
                catch { break }
            }
        }
        .onChange(of: model.payload?.actionToken) { _ in actions.loadRequestAccounts { _ in } }
        .onChange(of: model.inspectedAccountID) { _ in overviewSupplementaryExpanded = false }
        .sheet(isPresented: $showingConnectionRecovery) {
            VStack(alignment: .leading, spacing: 12) {
                OriginalConnectionRecoveryView(model: model, actions: actions)
                Button(Strings.t("requestAccount.close")) { showingConnectionRecovery = false }
                    .disabled(model.connectionRestoring)
            }.padding(20).frame(width: 360)
        }
        .sheet(item: $model.requestAccountTarget) { account in
            RequestAccountSelectionView(account: account, actions: actions)
        }
    }

    private var accountList: some View {
        // Select a complete surface so native popover chrome and the chosen
        // content share one rendering subtree on macOS.
        ViewThatFits(in: .vertical) {
            accountListFrame {
                accountListContent.fixedSize(horizontal: false, vertical: true)
            }
            accountListFrame {
                ScrollView { accountListContent }
                    .frame(height: max(1, model.popoverDetailHeight - 86))
            }
        }
        .frame(width: 360)
        .frame(maxHeight: model.popoverDetailHeight)
        .accessibilityIdentifier("accounts.list")
    }

    private func accountListFrame<Content: View>(@ViewBuilder content: () -> Content) -> some View {
        VStack(spacing: 0) {
            HStack(alignment: .firstTextBaseline) {
                Text(Strings.t("accounts.list.title")).font(.system(size: 13, weight: .semibold))
                    .accessibilityLabel(Strings.t("accounts.list.title") + ", " + Strings.t("accounts.list.count", String(model.enabledAccounts.count)))
                Spacer()
                if model.payload?.collection?.refreshing == true {
                    Image(systemName: "arrow.triangle.2.circlepath")
                        .font(.caption2).foregroundStyle(.secondary)
                        .accessibilityLabel(Strings.t("collection.refreshing"))
                }
                Text(Strings.t("accounts.list.remaining")).font(.caption).foregroundStyle(.secondary)
            }.padding(.horizontal, 16).frame(height: 44)
            Divider()
            content()
            Divider()
            footer.padding(.horizontal, 12).frame(height: 40)
        }
        .frame(width: 360)
    }

    private var accountListContent: some View {
        VStack(spacing: 0) {
            SessionAccountView(model: model)
            Divider().padding(.horizontal, 16)
            if model.enabledAccounts.contains(where: { $0.provider == "codex" }),
               let routing = model.payload?.routing, !routing.active.isEmpty || !routing.recent.isEmpty {
                RoutingSummaryButton(model: model) { showDetails(.activity) }
                Divider().padding(.horizontal, 16)
            }
            if model.lastError != nil {
                Label(model.statusFailureText + (model.enabledAccounts.contains(where: { !$0.windows.isEmpty }) ?
                    " · " + Strings.t("accounts.list.previous") : ""), systemImage: "exclamationmark.circle")
                    .font(.caption).foregroundStyle(.orange)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading).padding(16)
                    .accessibilityIdentifier("accounts.transportFailure")
                if !model.enabledAccounts.isEmpty { Divider().padding(.horizontal, 16) }
            }
            if model.enabledAccounts.isEmpty {
                VStack(alignment: .leading, spacing: 10) {
                    if model.lastError == nil {
                        Text(Strings.t("popover.noAccounts"))
                            .font(.callout).foregroundStyle(.secondary)
                    }
                    Button(Strings.t("action.openSettings")) { showDetails(.settings) }
                }.frame(maxWidth: .infinity, alignment: .leading).padding(16)
            } else {
                ForEach(model.enabledAccounts) { account in
                    AccountListRow(account: account, showingStartupCache: model.showingStartupCache,
                                   transportUnavailable: model.lastError != nil,
                                   select: { model.showAccount(account) },
                                   useAccount: account.provider == "codex" ? { selectRequestAccount(account) } : nil,
                                   canUseAccount: model.canActOnTasks && !model.requestAccountApplying,
                                   routingOption: model.requestAccountCatalog?.option(provider: account.provider, account: account.account),
                                   configureCredits: account.provider == "codex" ? { actions.configureCredits(account.account, $0) } : nil,
                                   creditSaving: model.creditSaving)
                    if account.id != model.enabledAccounts.last?.id { Divider().padding(.horizontal, 16) }
                }
            }
            if let message = model.requestAccountCatalogError {
                Text(message).font(.caption).foregroundStyle(.orange).padding(.horizontal, 16)
            }
            if let message = model.requestAccountResult {
                Text(message).font(.caption).padding(.horizontal, 16)
            }
            OriginalConnectionRecoveryView(model: model, actions: actions)
                .padding(.horizontal, 16).padding(.vertical, 10)
            if let message = model.collectionRequestError, model.lastError == nil {
                Text(message).font(.caption).foregroundStyle(.orange)
                    .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 16).padding(.bottom, 12)
            }
            if let message = model.accountOpenError {
                Text(message).font(.caption).foregroundStyle(.orange)
                    .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 16).padding(.bottom, 12)
            }
            if !model.activeTasks.isEmpty {
                Divider().padding(.horizontal, 16)
                Button { showDetails(.work) } label: {
                    HStack {
                        Label(model.taskOverviewSummary, systemImage: "play.circle")
                        Spacer(minLength: 4)
                        Image(systemName: "chevron.right").font(.caption2)
                    }.font(.caption).contentShape(Rectangle()).padding(16)
                }.buttonStyle(.plain)
            }
            if let incidents = model.payload?.autoResume?.incidents,
               incidents.contains(where: { !["resumed", "skipped"].contains($0.state) }) {
                Button { showDetails(.work) } label: {
                    Label(Strings.t("autoResume.summary.review"), systemImage: "play.circle")
                        .font(.caption).frame(maxWidth: .infinity, alignment: .leading).padding(16)
                }.buttonStyle(.plain).accessibilityIdentifier("accounts.autoResume")
            }
        }.frame(maxWidth: .infinity)
    }

    private func selectRequestAccount(_ account: AccountState) {
        guard !model.requestAccountApplying else { return }
        guard let thread = FocusedConversation.match(title: model.focusedConversationTitle, catalog: model.requestAccountCatalog) else {
            model.chooseRequestAccount(account)
            return
        }
        model.requestAccountApplying = true
        model.requestAccountResult = nil
        actions.useRequestAccount(thread.threadId, account.account) { result in
            model.requestAccountApplying = false
            switch result {
            case .success(let assignment):
                model.requestAccountResult = thread.displayTitle + " · " + Strings.t("requestAccount.next", assignment.label)
                actions.loadRequestAccounts { _ in }
            case .failure(let error): model.requestAccountResult = error.localizedDescription
            }
        }
    }

    private var overview: some View {
        ViewThatFits(in: .vertical) {
            overviewFrame {
                overviewContent.fixedSize(horizontal: false, vertical: true)
            }
            overviewFrame {
                ScrollView(.vertical) { overviewContent }
                    .frame(height: max(1, model.popoverDetailHeight - 86))
            }
        }
        .frame(width: 360)
        .frame(maxHeight: model.popoverDetailHeight)
    }

    private func overviewFrame<Content: View>(@ViewBuilder content: () -> Content) -> some View {
        VStack(spacing: 0) {
            HStack {
                Button(action: model.showAccountList) {
                    Label(Strings.t("navigation.accounts"), systemImage: "chevron.left")
                }.buttonStyle(.plain).accessibilityIdentifier("navigation.accountsBack")
                Spacer()
            }.padding(.horizontal, 16).frame(height: 44)
            Divider()
            content()
            Divider()
            footer.padding(.horizontal, 12).frame(height: 40)
        }
        .frame(width: 360)
    }

    private var overviewContent: some View {
        VStack(alignment: .leading, spacing: 16) {
            SessionAccountView(model: model)
            Divider().padding(.horizontal, 16)
            quotaOverview
            if let error = model.accountOpenError {
                Text(error).font(.caption).foregroundStyle(.orange)
            }
            if !model.detailsLoaded {
                Text(model.detailsError ?? Strings.t("details.loading"))
                    .font(.caption).foregroundStyle(model.detailsError == nil ? Color.secondary : Color.orange)
            }
            if let account = model.displayedAccount, account.provider == "codex" {
                AccountOverviewContinuation(accountID: account.account, payload: model.payload?.autoResume,
                    current: model.canActOnTasks, openWork: { showDetails(.work) })
            }
            if !accountTasks.isEmpty { taskOverview }
            if model.payload?.accountPool?.error != nil || model.payload?.compaction?.latest?.active == true || model.payload?.compaction?.latest?.errorCode != nil {
                Text(Strings.t("detail.overview.globalActivity")).font(.caption2).foregroundStyle(.secondary)
            }
            if let error = model.payload?.accountPool?.error {
                Button(action: actions.openSettings) {
                    Label(poolErrorText(error), systemImage: "exclamationmark.circle")
                        .font(.caption).foregroundStyle(.orange)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }.buttonStyle(.plain)
            }
            if let record = model.payload?.compaction?.latest, record.active || record.errorCode != nil {
                compactActivity(record)
            }
            if hasSupplementaryDetails {
                Divider()
                DisclosureGroup(Strings.t("detail.overview.activityAndNews"), isExpanded: $overviewSupplementaryExpanded) {
                    supplementaryDetails.padding(.top, 10)
                }.font(.system(size: 12, weight: .medium))
                    .accessibilityIdentifier("account.detail.supplementary")
            }
            if awake.enabled || model.notificationsAllowed == false { statusLinks }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var accountTasks: [ResumeTask] {
        guard let account = model.displayedAccount else { return [] }
        return model.activeTasks.filter { $0.provider == account.provider && $0.account == account.account }
    }

    private var hasSupplementaryDetails: Bool {
        let pool = model.payload?.accountPool
        let savings = model.payload?.compaction?.savings
        let latest = model.payload?.compaction?.latest
        return pool.map { $0.enabled || !$0.recent.isEmpty } == true ||
            savings.map { $0.policy?.enabled == true || !($0.insights ?? []).isEmpty } == true ||
            latest.map { !$0.active && $0.errorCode == nil } == true ||
            model.displayedRecovery != nil || model.payload?.resetSignals?.enabled == true
    }

    private func poolErrorText(_ error: String) -> String {
        Strings.t(error == "pool_reserve_reached" ? "pool.settings.blocked" :
            error == "pool_reserve_quota_unavailable" ? "pool.settings.stale" :
            ["pool_request_failed", "pool_response_unverified"].contains(error) ? "pool.requestFailed" : "pool.blocked")
    }

    private var supplementaryDetails: some View {
        VStack(alignment: .leading, spacing: 14) {
            if let pool = model.payload?.accountPool, pool.enabled || !pool.recent.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    Label(Strings.t(pool.enabled ? "pool.enabled" : "pool.disabled"), systemImage: "arrow.triangle.branch")
                    if let request = pool.recent.first {
                        Text(Strings.t(request.state == "completed" ? "pool.lastCompleted" : "pool.lastRouted", request.accountLabel))
                            .foregroundStyle(.secondary)
                        if let headline = model.latestRoutedHeadline {
                            Text(headline.localizedTitle).foregroundStyle(.secondary)
                        }
                    }
                }.font(.caption)
            }
            if let savings = model.payload?.compaction?.savings, savings.policy?.enabled == true || !(savings.insights ?? []).isEmpty {
                Button { showDetails(.activity) } label: {
                    Label(savings.insights?.first.map { Strings.t("savings.insight." + $0.kind, String($0.count)) }
                        ?? savings.latest?.summary ?? Strings.t("savings.waiting"), systemImage: "leaf")
                        .font(.caption).frame(maxWidth: .infinity, alignment: .leading)
                }.buttonStyle(.plain)
            }
            if let record = model.payload?.compaction?.latest, !record.active && record.errorCode == nil {
                compactActivity(record)
            }
            if let recovery = model.displayedRecovery {
                Button { showDetails(.activity) } label: {
                    Label(Strings.t("recovery.overview") + " · " + recovery.evidence.remainingText,
                          systemImage: "arrow.up.circle")
                        .font(.caption).frame(maxWidth: .infinity, alignment: .leading)
                }.buttonStyle(.plain)
            }
            if let feed = model.payload?.resetSignals, feed.enabled {
                Button { showDetails(.resets) } label: {
                    VStack(alignment: .leading, spacing: 4) {
                        Label(Strings.t("overview.resetNews"), systemImage: "newspaper")
                        Text(feed.latestSignal.map { Strings.t($0.summaryKey(nowMs: Date().timeIntervalSince1970 * 1_000)) }
                            ?? Strings.t(feed.state == "ready" ? "signal.empty" : "signal.health." + feed.state))
                            .foregroundStyle(.secondary)
                    }.font(.caption).frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
                }.buttonStyle(.plain)
            }
        }
    }

    private func compactActivity(_ record: CompactionRecord) -> some View {
        let activeCount = model.payload?.compaction?.active.filter(\.active).count ?? 0
        let title = record.active && activeCount > 1 ? Strings.t("detail.overview.compactionsRunning", String(activeCount)) :
            Strings.t(record.phaseKey) + " · " + record.modelText
        return Button { showDetails(.activity) } label: {
            HStack(spacing: 8) {
                Label(title,
                      systemImage: record.active ? "arrow.triangle.2.circlepath" : "doc.text.magnifyingglass")
                Spacer(minLength: 4)
                Image(systemName: "chevron.right").font(.caption2)
            }
            .font(.caption).foregroundStyle(record.errorCode == nil ? Color.primary : Color.orange)
            .contentShape(Rectangle())
        }.buttonStyle(.plain)
    }

    private func showDetails(_ section: DetailSection, taskID: String? = nil) {
        if section == .settings { actions.openSettings(); return }
        model.showDetails(section, taskID: taskID)
    }

    private var quotaOverview: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 8) {
                if let account = model.displayedAccount {
                    Image(nsImage: AccountBadge(accountID: account.id, name: account.accountLabel).image(size: 20))
                        .accessibilityHidden(true)
                }
                accountIdentity
                Spacer(minLength: 4)
                if let account = model.displayedAccount, account.provider == "codex" || account.provider == "claude" {
                    let appAction = codexAppAction(account)
                    Button { actions.openAccount(account) } label: {
                        Label(account.provider == "claude" ? Strings.t("collection.openClaude") : appAction.title,
                              systemImage: "arrow.up.forward.app").font(.caption)
                    }
                    .buttonStyle(.borderless).disabled(model.openingAccount || account.provider == "codex" && !appAction.isEnabled)
                    .help(account.provider == "claude" ? Strings.t("collection.openClaude") : appAction.help)
                    .accessibilityLabel(account.provider == "claude" ? Strings.t("collection.openClaude") : appAction.title)
                    .accessibilityIdentifier("account.openApp")
                }
            }
            HStack {
                Text(Strings.t(model.displayedAccount?.collectionExplanation == nil ? "accounts.list.remaining" : "collection.availability"))
                    .font(.caption).foregroundStyle(.secondary)
                Spacer()
                detailButton("overview.quotaDetail", section: .quota)
            }
            if let account = model.displayedAccount {
                if account.provider == "codex" {
                    VStack(alignment: .leading, spacing: 5) {
                        RequestAccountButton(enabled: model.canActOnTasks) { model.chooseRequestAccount(account) }
                            .accessibilityIdentifier("account.use." + account.id)
                        Text(Strings.t("requestAccount.inspectionOnly")).font(.caption2).foregroundStyle(.secondary)
                    }
                }
                if account.collectionExplanation != nil {
                    CollectionAccessNotice(account: account)
                } else {
                    AccountOverviewQuota(account: account,
                        current: !model.showingStartupCache && model.lastError == nil && account.collection.isHealthy)
                }
                if let credits = account.credits, credits.subscriptionExhausted || credits.spendingObserved {
                    CreditUsageView(credits: credits, current: !model.showingStartupCache && model.lastError == nil)
                }
                if account.collectionExplanation == nil {
                    if model.showingStartupCache {
                        Text(Strings.t("collection.previousReading")).font(.caption).foregroundStyle(.secondary)
                    } else if model.payload?.collection?.refreshing == true {
                        Label(Strings.t("collection.refreshing"), systemImage: "arrow.triangle.2.circlepath")
                            .font(.caption).foregroundStyle(.secondary)
                    } else if let measured = model.displayedMeasurementDate {
                        Text(Strings.t("accounts.list.measured", DisplayFormat.age(since: measured)))
                            .font(.caption2).foregroundStyle(.secondary)
                            .help(Strings.t("collection.measuredAt", measured.formatted(date: .abbreviated, time: .shortened)))
                    }
                }
                if let message = model.collectionRequestError, model.lastError == nil {
                    Text(message).font(.caption).foregroundStyle(.orange)
                }
                if account.windows.contains(where: \.isResetTicketPending) || account.windows.contains(where: \.isUsageBlocked) || account.windows.contains(where: \.isUsagePermissionUnknown) {
                    Label(Strings.t(account.windows.contains(where: \.isResetTicketPending) ? "accounts.list.resetTicketPending" : account.windows.contains(where: \.isUsageBlocked) ? "accounts.list.usageBlocked" :
                        "accounts.list.permissionUnknown"), systemImage: "exclamationmark.circle")
                        .font(.caption).foregroundStyle(.orange)
                }
                if model.lastError != nil {
                    Label(model.statusFailureText + " · " + Strings.t("accounts.list.previous"),
                          systemImage: "exclamationmark.circle")
                        .font(.caption).foregroundStyle(.orange).fixedSize(horizontal: false, vertical: true)
                }
                if account.collectionExplanation == nil && !account.collection.isHealthy && !(model.lastError != nil &&
                    ["network", "stale-success", "attempted-then-failed"].contains(account.collection.errorCategory ?? account.collection.health)) {
                    Button { showDetails(.quota) } label: {
                        Label(account.collectionStatusText + (model.lastError == nil && !account.windows.isEmpty ?
                            " · " + Strings.t("accounts.list.previous") : ""),
                              systemImage: "exclamationmark.circle")
                            .font(.caption).foregroundStyle(.orange).multilineTextAlignment(.leading)
                    }.buttonStyle(.plain)
                }
                if account.windows.isEmpty && account.collectionExplanation == nil {
                    Text(Strings.t("popover.noWindows")).font(.caption).foregroundStyle(.secondary)
                }
            } else {
                Text(model.lastError == nil ? Strings.t("accounts.list.unavailable") : model.statusFailureText)
                    .font(.callout).foregroundStyle(.secondary)
            }
        }
    }

    private func codexAppAction(_ account: AccountState) -> CodexAccountAction {
        let profile = CodexDesktopProfile.forAccount(account.id, in: profiles.profiles)
        return CodexAccountAction(profile: profile, consolidation: profiles.consolidation,
            requiresVerification: profile.map { profiles.requiresConsolidationVerification($0) } ?? false)
    }

    private var accountIdentity: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(model.displayedAccount?.accountLabel ?? Strings.t("accounts.list.unavailable"))
                .font(.system(size: 13, weight: .medium))
                .lineLimit(1).truncationMode(.middle)
            if let account = model.displayedAccount {
                Text(account.providerTitle).font(.caption2).foregroundStyle(.secondary)
            }
        }.help(model.displayedAccount.map { "\($0.providerTitle) · \($0.accountLabel)" } ?? "QuotaPie")
    }

    private var taskOverview: some View {
        VStack(alignment: .leading, spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                Text(Strings.t("resume.sectionTitle")).font(.system(size: 12, weight: .semibold))
                Text(Strings.t("overview.taskCounts", String(accountTasks.filter(\.isReady).count),
                    String(accountTasks.filter(\.isApproved).count), String(accountTasks.filter(\.isWaiting).count)))
                    .font(.caption).foregroundStyle(.secondary)
            }
            ForEach(Array(accountTasks.prefix(2))) { task in
                Button { showDetails(.work, taskID: task.id) } label: {
                    HStack(spacing: 10) {
                        VStack(alignment: .leading, spacing: 3) {
                            Text(task.projectLabel).font(.system(size: 13, weight: .medium))
                                .foregroundStyle(.primary).lineLimit(1)
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
            if accountTasks.count > 2 {
                detailButton("overview.allTasks", section: .work)
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
        HStack(spacing: 12) {
            Button(action: { actions.refresh(); actions.loadRequestAccounts { _ in } }) {
                Image(systemName: "arrow.clockwise").frame(width: 24, height: 24)
            }
            .accessibilityLabel(Strings.t("action.refresh"))
            .accessibilityIdentifier("footer.refresh")
            .help(Strings.t("action.refreshHelp"))
            Button(Strings.t("detail.work")) { showDetails(.work) }
                .accessibilityIdentifier("footer.work")
            Button(Strings.t("detail.usage"), action: actions.openUsageReport)
                .accessibilityIdentifier("footer.usage")
            Spacer(minLength: 0)
            Button(Strings.t("connectionRecovery.short")) { showingConnectionRecovery = true }
                .accessibilityIdentifier("footer.recovery")
            Menu(Strings.t("action.more")) {
                Button(Strings.t("overview.activityDetail")) { showDetails(.activity) }
                Button(Strings.t("detail.resets")) { showDetails(.resets) }
            }
            .menuStyle(.borderlessButton).fixedSize()
            .accessibilityIdentifier("footer.more")
            Button(action: actions.openSettings) { Image(systemName: "gearshape").frame(width: 24, height: 24) }
                .accessibilityLabel(Strings.t("detail.settings"))
                .accessibilityIdentifier("footer.settings")
                .help(Strings.t("detail.settings"))
        }
        .font(.system(size: 12)).controlSize(.small).buttonStyle(.borderless)
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
