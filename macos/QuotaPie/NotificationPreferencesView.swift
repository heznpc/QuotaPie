import SwiftUI

struct NotificationPreferences: Decodable {
    let enabled: Bool
    let topics: [String: Bool]
    let desktopEnabled: Bool
    let resetCollectionEnabled: Bool
}
struct NotificationPreferencesResponse: Decodable { let notificationPreferences: NotificationPreferences }

struct NotificationPreferencesView: View {
    @ObservedObject var model: PopoverModel
    let save: (String, Bool) -> Void
    private let groups: [(String, [String])] = [
        ("account", ["quotaWarnings", "quotaRecovery", "accountChanges", "payments"]),
        ("news", ["resetPossible", "resetAnnounced", "resetUpdates", "resetReported"]),
        ("operation", ["resumeReady", "collectionIssues"])
    ]

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(Strings.t("detail.notifications")).font(.headline)
            if let preferences = model.payload?.notificationPreferences {
                Toggle(Strings.t("notification.preferences.enabled"), isOn: Binding(
                    get: { preferences.enabled }, set: { save("enabled", $0) }))
                Text(Strings.t("notification.preferences.history")).font(.caption).foregroundStyle(.secondary)
                ForEach(groups, id: \.0) { group in
                    VStack(alignment: .leading, spacing: 7) {
                        Text(Strings.t("notification.preferences.group." + group.0)).font(.subheadline).bold()
                        ForEach(group.1, id: \.self) { topic in
                            Toggle(Strings.t("notification.topic." + topic), isOn: Binding(
                                get: { preferences.topics[topic] ?? true }, set: { save(topic, $0) }))
                        }
                    }.disabled(!preferences.enabled)
                }
                if !preferences.desktopEnabled {
                    Text(Strings.t("notification.preferences.desktopOff")).font(.caption).foregroundStyle(.orange)
                }
                if !preferences.resetCollectionEnabled {
                    Text(Strings.t("notification.preferences.collectionOff")).font(.caption).foregroundStyle(.secondary)
                }
            } else {
                Text(Strings.t("notification.preferences.unavailable")).font(.callout).foregroundStyle(.secondary)
            }
            if let message = model.notificationSaveMessage {
                Text(message).font(.caption).foregroundStyle(.secondary)
            }
        }
        .toggleStyle(.checkbox)
        .disabled(model.notificationSaving || !model.canActOnTasks)
    }
}
