import AppKit
import SwiftUI

struct QuotaPieInstallation: Equatable {
    let id: String
    let isUpdate: Bool

    static func read(environment: [String: String] = ProcessInfo.processInfo.environment,
                     bundlePath: String = Bundle.main.bundlePath,
                     home: URL = FileManager.default.homeDirectoryForCurrentUser) -> Self? {
        // Reading the installed agent also covers launching the app from Finder.
        // A development bundle must never consume the installed app's receipt.
        let path = home.appendingPathComponent("Library/LaunchAgents/local.quotapie.menubar.plist")
        guard let data = try? Data(contentsOf: path),
              let plist = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any],
              let arguments = plist["ProgramArguments"] as? [String],
              arguments.first == bundlePath + "/Contents/MacOS/QuotaPie",
              let values = plist["EnvironmentVariables"] as? [String: String],
              let id = values["QUOTAPIE_INSTALL_ID"], !id.isEmpty,
              let update = values["QUOTAPIE_INSTALL_IS_UPDATE"], ["0", "1"].contains(update)
        else { return nil }
        // An old process must not acknowledge a replacement that has not started.
        if let runningID = environment["QUOTAPIE_INSTALL_ID"], runningID != id { return nil }
        return Self(id: id, isUpdate: update == "1")
    }
}

final class UpdateSettingsReviewPolicy {
    // Increment only when an update adds a user-selectable setting. Ordinary
    // releases keep this value, so "always keep" remains effective. A new
    // schema requires reviewing the settings and explicitly confirming the choices.
    static let settingsSchemaVersion = 2
    private static let key = "updates.settingsReview.v1"
    private let defaults: UserDefaults
    private let schema: Int
    private struct State: Codable {
        var reviewedInstallIDs: [String] = []
        var alwaysKeep = false
        var reviewedSchema = 0
    }
    struct Review: Equatable {
        let installation: QuotaPieInstallation
        let hasNewSettings: Bool
        let alwaysKeep: Bool
    }
    private var state: State

    init(defaults: UserDefaults = .standard, schema: Int = settingsSchemaVersion) {
        self.defaults = defaults
        self.schema = schema
        state = defaults.data(forKey: Self.key).flatMap { try? JSONDecoder().decode(State.self, from: $0) } ?? State()
    }

    func review(for installation: QuotaPieInstallation) -> Review? {
        let hasNewSettings = state.reviewedSchema > 0 && schema > state.reviewedSchema
        if state.reviewedInstallIDs.contains(installation.id), !hasNewSettings { return nil }
        if !installation.isUpdate && state.reviewedInstallIDs.isEmpty {
            complete(installation, alwaysKeep: false)
            return nil
        }
        if state.alwaysKeep && !hasNewSettings {
            complete(installation)
            return nil
        }
        return Review(installation: installation, hasNewSettings: hasNewSettings, alwaysKeep: state.alwaysKeep)
    }

    func complete(_ installation: QuotaPieInstallation, alwaysKeep: Bool? = nil) {
        if let alwaysKeep { state.alwaysKeep = alwaysKeep }
        state.reviewedSchema = max(state.reviewedSchema, schema)
        state.reviewedInstallIDs.removeAll { $0 == installation.id }
        state.reviewedInstallIDs.append(installation.id)
        state.reviewedInstallIDs = Array(state.reviewedInstallIDs.suffix(32))
        if let data = try? JSONEncoder().encode(state) { defaults.set(data, forKey: Self.key) }
    }
}

final class UpdateSettingsWindowController: NSWindowController {
    init(review: UpdateSettingsReviewPolicy.Review, model: PopoverModel, actions: PopoverActions,
         complete: @escaping (Bool?) -> Void) {
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 680, height: 690),
                              styleMask: [.titled, .resizable], backing: .buffered, defer: false)
        super.init(window: window)
        window.title = Strings.t("updateSettings.title")
        window.identifier = NSUserInterfaceItemIdentifier("quotapie.updateSettings")
        window.isReleasedWhenClosed = false
        window.contentMinSize = NSSize(width: 620, height: 580)
        let hosting = NSHostingController(rootView: UpdateSettingsReviewView(
            review: review, model: model, actions: actions,
            complete: { [weak self] alwaysKeep in
                complete(alwaysKeep)
                self?.close()
            }))
        // Expanding settings must scroll inside this window, never resize it to
        // the full content height or push the confirmation controls offscreen.
        hosting.sizingOptions = []
        window.contentViewController = hosting
        window.setContentSize(NSSize(width: 680, height: 690))
        window.center()
    }

    required init?(coder: NSCoder) { nil }

    func present() {
        showWindow(nil)
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }
}

struct UpdateSettingsReviewView: View {
    let review: UpdateSettingsReviewPolicy.Review
    @ObservedObject var model: PopoverModel
    let actions: PopoverActions
    let complete: (Bool?) -> Void
    @ObservedObject private var awake = AwakeController.shared
    @State private var expanded: Set<SettingsCategory> = []
    @State private var settingsOpened = false
    @State private var alwaysKeep: Bool
    @AppStorage(NotchController.preferenceKey) private var notchEnabled = true

    init(review: UpdateSettingsReviewPolicy.Review, model: PopoverModel, actions: PopoverActions,
         complete: @escaping (Bool?) -> Void) {
        self.review = review; self.model = model; self.actions = actions
        self.complete = complete
        _alwaysKeep = State(initialValue: review.alwaysKeep)
    }

    private var saving: Bool {
        model.poolSaving || model.compactionSaving || model.savingsSaving || model.notificationSaving
    }

    var body: some View {
        VStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 10) {
                Label(Strings.t("updateSettings.title"), systemImage: "checkmark.circle")
                    .font(.title2.bold())
                Text(Strings.t(review.hasNewSettings ? "updateSettings.newSettings" : "updateSettings.message"))
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }.frame(maxWidth: .infinity, alignment: .leading).padding(24)
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    Text(Strings.t("updateSettings.current")).font(.headline)
                    Text(Strings.t("updateSettings.expandHint"))
                        .font(.callout).foregroundStyle(.secondary)
                    if let error = model.detailsError ?? model.lastError {
                        HStack {
                            Text(error).font(.callout).foregroundStyle(.orange)
                            Spacer()
                            Button(Strings.t("action.refresh"), action: actions.refresh)
                        }
                    }
                    ForEach([SettingsCategory.automation, .notifications, .power, .accounts, .general]) { category in
                        DisclosureGroup(isExpanded: Binding(
                            get: { expanded.contains(category) },
                            set: { value in
                                if value { expanded.insert(category); settingsOpened = true }
                                else { expanded.remove(category) }
                            }
                        )) {
                            VStack(alignment: .leading, spacing: 18) {
                                SettingsPanelView(model: model, actions: actions, initialCategory: category)
                                    .categoryContent
                            }
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(.top, 16)
                                .padding(.bottom, 4)
                        } label: {
                            HStack(alignment: .top, spacing: 12) {
                                Image(systemName: category.symbol)
                                    .foregroundStyle(.secondary).frame(width: 22).padding(.top, 2)
                                VStack(alignment: .leading, spacing: 5) {
                                    Text(category.title).font(.body.weight(.semibold))
                                    Text(summary(category)).font(.callout).foregroundStyle(.secondary)
                                        .fixedSize(horizontal: false, vertical: true)
                                }
                                Spacer(minLength: 0)
                            }.padding(.vertical, 3)
                        }
                        .padding(14)
                        .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 10))
                        .overlay(RoundedRectangle(cornerRadius: 10).stroke(Color.primary.opacity(0.08)))
                        .accessibilityIdentifier("updateSettings.section." + category.rawValue)
                    }
                }.padding(24)
            }
            .frame(minHeight: 0, maxHeight: .infinity)
            Divider()
            VStack(alignment: .leading, spacing: 12) {
                Toggle(Strings.t("updateSettings.dontAsk"), isOn: $alwaysKeep)
                    .toggleStyle(.checkbox)
                    .accessibilityIdentifier("updateSettings.alwaysKeep")
                Text(Strings.t("updateSettings.retention"))
                    .font(.caption).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                HStack {
                    Spacer()
                    if saving { ProgressView().controlSize(.small) }
                    Button(Strings.t("updateSettings.useCurrent")) { complete(alwaysKeep) }
                        .keyboardShortcut(.defaultAction)
                        .disabled(saving || (review.hasNewSettings && !settingsOpened))
                        .accessibilityIdentifier("updateSettings.keep")
                }
            }.padding(24)
                .fixedSize(horizontal: false, vertical: true)
        }
        .buttonStyle(.bordered)
        .controlSize(.regular)
        .background(Color(nsColor: .windowBackgroundColor))
        .accessibilityIdentifier("updateSettings.window")
    }

    private func state(_ enabled: Bool?) -> String {
        guard let enabled else { return Strings.t("updateSettings.unavailable") }
        return Strings.t(enabled ? "updateSettings.on" : "updateSettings.off")
    }

    private func summary(_ category: SettingsCategory) -> String {
        let payload = model.payload
        switch category {
        case .automation:
            let compaction = payload?.compaction?.policy.map { CompactionRecord.shortModel($0.model) }
                ?? Strings.t("updateSettings.unavailable")
            return Strings.t("updateSettings.automationSummary", state(payload?.accountPool?.enabled),
                             compaction, state(payload?.compaction?.savings?.policy?.enabled))
        case .notifications:
            guard let preferences = payload?.notificationPreferences else {
                return Strings.t(model.detailsLoading ? "details.loading" : "updateSettings.unavailable")
            }
            return Strings.t("updateSettings.notificationSummary", state(preferences.enabled), state(preferences.usageSpeed ?? false))
        case .power:
            return awake.summary
        case .accounts:
            guard let accounts = payload?.accounts else { return Strings.t("updateSettings.unavailable") }
            return accounts.map { $0.accountLabel }.joined(separator: " · ")
        case .general:
            return Strings.t("notch.settings.summary", state(notchEnabled))
        case .advanced:
            return Strings.t("settings.organized.toolsDescription")
        }
    }
}
