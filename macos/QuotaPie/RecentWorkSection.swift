import SwiftUI

struct RecentWorkSection: View {
    let items: [RecentWork]
    let supportsRecentWork: Bool
    let state: String
    let canOpen: Bool
    let activities: [String: ResumeTaskActivity]
    let onOpen: (RecentWork) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(Strings.t("work.title")).font(.headline)
            Text(Strings.t("work.explanation"))
                .font(.callout).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            if !supportsRecentWork {
                Text(Strings.t("work.serviceUnavailable")).foregroundStyle(.secondary)
            } else {
                if state == "loading" {
                    HStack(spacing: 7) {
                        ProgressView().controlSize(.small)
                        Text(Strings.t("work.loading"))
                    }.font(.caption).foregroundStyle(.secondary)
                } else if state == "error" {
                    Text(Strings.t("work.collectFailed")).font(.callout).foregroundStyle(.orange)
                } else if items.isEmpty {
                    Text(Strings.t("work.empty")).foregroundStyle(.secondary)
                }
                if !items.isEmpty && !canOpen {
                    Text(Strings.t("resume.actionUnavailable")).font(.caption).foregroundStyle(.secondary)
                }
                ForEach(items) { item in
                    RecentWorkRow(item: item, canOpen: canOpen, activity: activities[item.id], onOpen: { onOpen(item) })
                    if item.id != items.last?.id { Divider() }
                }
            }
        }
    }
}

private struct RecentWorkRow: View {
    let item: RecentWork
    let canOpen: Bool
    let activity: ResumeTaskActivity?
    let onOpen: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(item.projectLabel).fontWeight(.medium).lineLimit(1).help(item.projectLabel)
            Text("\(item.providerTitle) · \(item.accountTitle)")
                .font(.caption).foregroundStyle(.secondary).lineLimit(1)
            Text(Strings.t("work.lastActive", DisplayFormat.age(since: Date(timeIntervalSince1970: item.lastActiveAtMs / 1000))))
                .font(.caption).foregroundStyle(.secondary)
                .help(Date(timeIntervalSince1970: item.lastActiveAtMs / 1000).formatted(date: .abbreviated, time: .standard))
            Text(Strings.t("work.tokens", item.tokenText)).font(.callout).monospacedDigit()
            HStack {
                if activity?.isBusy == true {
                    ProgressView().controlSize(.small)
                    Text(Strings.t(activity == .opening ? "resume.opening" : "resume.preparing")).font(.caption)
                } else {
                    Button(Strings.t("work.openInTerminal"), action: onOpen)
                        .buttonStyle(.bordered).controlSize(.small).disabled(!canOpen)
                        .accessibilityLabel("\(Strings.t("work.openInTerminal")): \(item.projectLabel), \(item.providerTitle), \(item.accountTitle)")
                }
            }
            if case .failed(let error) = activity {
                Text(error).font(.caption).foregroundStyle(.orange)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .accessibilityElement(children: .contain)
    }
}
