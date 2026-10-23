import SwiftUI

/// Public announcements remain available before a provider account is connected.
struct PublicNewsView: View {
    @ObservedObject var model: PopoverModel
    let actions: PopoverActions
    var expanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label(Strings.t("publicNews.noLogin"), systemImage: "globe")
                .font(.caption).foregroundStyle(.secondary)
            if let feed = model.payload?.resetSignals, feed.enabled {
                if expanded {
                    ResetSignalHistory(feed: feed)
                    Button(Strings.t("publicNews.disable")) { actions.configurePublicNews(false) }
                        .disabled(model.publicNewsSaving || !model.canActOnTasks)
                } else {
                    ResetSignalSummary(feed: feed, openHistory: { model.showDetails(.resets) })
                }
            } else {
                Text(Strings.t("overview.resetNews")).font(.headline)
                Text(Strings.t("publicNews.description")).font(.callout).foregroundStyle(.secondary)
                Button(Strings.t("publicNews.enable")) { actions.configurePublicNews(true) }
                    .disabled(model.publicNewsSaving || !model.canActOnTasks)
                Text(Strings.t("publicNews.sourceHint")).font(.caption).foregroundStyle(.secondary)
            }
            if model.publicNewsSaving { ProgressView().controlSize(.small) }
            if let error = model.publicNewsError { Text(error).font(.caption).foregroundStyle(.orange) }
        }
        .buttonStyle(.borderless)
    }
}
