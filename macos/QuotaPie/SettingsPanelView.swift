import SwiftUI

enum SettingsCategory: String, CaseIterable, Identifiable {
    case general, notifications, accounts, automation, power, advanced
    var id: String { rawValue }
    var title: String { Strings.t("settings.organized." + rawValue) }
    var symbol: String {
        switch self {
        case .general: return "gearshape"
        case .notifications: return "bell"
        case .accounts: return "person.crop.circle"
        case .automation: return "slider.horizontal.3"
        case .power: return "bolt"
        case .advanced: return "ellipsis.circle"
        }
    }
}

final class SettingsSelection: ObservableObject {
    @Published var category: SettingsCategory {
        didSet { if category != oldValue { onChange?(category) } }
    }
    var onChange: ((SettingsCategory) -> Void)?
    init(category: SettingsCategory = .general) { self.category = category }
}

struct SettingsPanelView: View {
    @ObservedObject var model: PopoverModel
    let actions: PopoverActions
    @ObservedObject private var selection: SettingsSelection
    @ObservedObject private var awake = AwakeController.shared
    private var fixture: Bool {
        AppVerification.current != nil || ProcessInfo.processInfo.environment["QUOTAPIE_DEBUG_AUTO_OPEN"] == "1"
    }

    init(model: PopoverModel, actions: PopoverActions, initialCategory: SettingsCategory = .general) {
        self.init(model: model, actions: actions, selection: SettingsSelection(category: initialCategory))
    }

    init(model: PopoverModel, actions: PopoverActions, selection: SettingsSelection) {
        self.model = model; self.actions = actions; self.selection = selection
    }

    var body: some View {
        HStack(spacing: 0) {
            List(selection: Binding<SettingsCategory?>(get: { selection.category }, set: { if let category = $0 { selection.category = category } })) {
                ForEach(SettingsCategory.allCases) { category in
                    Label(category.title, systemImage: category.symbol)
                        .tag(category)
                        .accessibilityIdentifier("settings.category." + category.rawValue)
                }
            }
            .listStyle(.sidebar)
            .frame(width: 184)
            .accessibilityIdentifier("settings.sidebar")
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    Text(selection.category.title).font(.title2.weight(.semibold))
                    if let error = model.lastError {
                        CalloutView(text: model.statusFailureText, detail: error, tone: .warning)
                    }
                    if let error = model.detailsError {
                        Text(error).font(.callout).foregroundStyle(.orange)
                    } else if !model.detailsLoaded, [.notifications, .automation].contains(selection.category) {
                        HStack { ProgressView().controlSize(.small); Text(Strings.t("details.loading")) }
                            .foregroundStyle(.secondary)
                    }
                    categoryContent
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(24)
            }
            .id(selection.category)
            .accessibilityIdentifier("settings.content." + selection.category.rawValue)
        }
        .frame(minWidth: 760, minHeight: 520)
        .buttonStyle(.bordered)
        .controlSize(.regular)
    }

    @ViewBuilder private var categoryContent: some View {
        switch selection.category {
        case .general:
            AccountNicknamesView(model: model, refresh: actions.refresh)
        case .notifications:
            NotificationPreferencesView(model: model, save: actions.configureNotifications)
            Divider()
            VStack(alignment: .leading, spacing: 10) {
                Text(Strings.t(model.notificationsAllowed == false ? "notification.disabled" :
                                model.notificationsAllowed == true ? "notification.enabled" : "notification.checking"))
                    .foregroundStyle(.secondary)
                Button(Strings.t("notification.settings"), action: actions.openNotificationSettings).disabled(fixture)
            }
        case .accounts:
            CodexProfilesView(status: model, actions: actions).disabled(fixture)
            Divider()
            ClaudeDesktopConnectionView(model: model).disabled(fixture)
            Divider()
            DotsConnectionView(model: model)
        case .automation:
            AccountPoolSettingsView(model: model, save: actions.configurePool)
            Divider()
            TaskSavingsSettingsView(model: model, save: { actions.configureSavings($0, nil, nil) }, saveTests: { actions.configureSavings(nil, nil, $0) })
                .disabled(!model.canActOnTasks)
            Divider()
            CompactionSettingsView(model: model, save: actions.configureCompaction)
                .disabled(!model.canActOnTasks)
        case .power:
            powerSettings.disabled(fixture)
        case .advanced:
            VStack(alignment: .leading, spacing: 12) {
                Text(Strings.t("settings.organized.tools")).font(.headline)
                Text(Strings.t("settings.organized.toolsDescription")).foregroundStyle(.secondary)
                Button(Strings.t("settings.organized.openConfig"), action: actions.openConfig).disabled(fixture)
                Button(Strings.t("action.copy"), action: actions.copy)
            }
            Divider()
            Button(Strings.t("action.quit"), action: actions.quit).disabled(fixture)
        }
    }

    private var powerSettings: some View {
        VStack(alignment: .leading, spacing: 14) {
            Toggle(Strings.t("awake.title"), isOn: $awake.enabled).toggleStyle(.switch)
            Text(awake.summary).foregroundStyle(.secondary)
            if awake.enabled {
                Toggle(Strings.t("awake.closedLid"), isOn: $awake.closedLid).toggleStyle(.switch)
                if awake.closedLid || awake.helperState != "not-installed" {
                    Text(awake.lidSummary).font(.callout).foregroundStyle(.secondary)
                }
                HStack {
                    Button(Strings.t("awake.connect")) { awake.connectAgents() }
                    if awake.helperState == "not-installed" {
                        Button(Strings.t("awake.install")) { awake.installHelper() }
                    }
                }.disabled(awake.busy)
                Text(Strings.t("awake.limits")).font(.callout).foregroundStyle(.secondary)
            }
            if let message = awake.message {
                Text(message).font(.callout).fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}
