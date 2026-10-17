import SwiftUI

struct HostGoalsSection: View {
    let payload: HostGoalsPayload?
    let isLoading: Bool
    let transportUnavailable: Bool
    let tasks: [ResumeTask]
    let onReview: (String) -> Void

    var body: some View {
        // Expiry remains visible even while the service cannot refresh.
        TimelineView(.periodic(from: .now, by: 30)) { context in
            VStack(alignment: .leading, spacing: 12) {
                Text(Strings.t("goals.title")).font(.headline)
                if isLoading {
                    Text(Strings.t("goals.loading")).font(.callout).foregroundStyle(.secondary)
                } else if let payload {
                    if payload.items.isEmpty {
                        Text(Strings.t(transportUnavailable ? "goals.unavailable" : "goals.empty"))
                            .font(.callout).foregroundStyle(.secondary)
                        if !transportUnavailable {
                            Text(Strings.t("goals.linkHelp")).font(.caption).foregroundStyle(.secondary)
                            Text("quotapie pause --provider codex --goal")
                                .font(.system(.caption, design: .monospaced)).textSelection(.enabled)
                        }
                    } else {
                        ForEach(payload.items) { goal in
                            goalRow(goal, nowMs: context.date.timeIntervalSince1970 * 1_000)
                            if goal.id != payload.items.last?.id { Divider() }
                        }
                    }
                } else {
                    Text(Strings.t(transportUnavailable ? "goals.unavailable" : "goals.serviceUnsupported"))
                        .font(.callout).foregroundStyle(.secondary)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private func goalRow(_ goal: HostGoalLinkSummary, nowMs: Double) -> some View {
        let state = goal.displayReadState(at: nowMs, transportUnavailable: transportUnavailable)
        return VStack(alignment: .leading, spacing: 6) {
            Text(goal.projectLabel).fontWeight(.medium).lineLimit(1).help(goal.projectLabel)
            Text("Codex · \(goal.accountLabel.isEmpty ? goal.account : goal.accountLabel)")
                .font(.caption).foregroundStyle(.secondary).lineLimit(1)
            if let objective = goal.visibleObjective(at: nowMs, transportUnavailable: transportUnavailable) {
                if state != "ready" {
                    Text(Strings.t("goals.previousObservation")).font(.caption).foregroundStyle(.secondary)
                }
                Text(objective).font(.callout).lineLimit(3).textSelection(.enabled).help(objective)
                Text(Strings.t("goals.hostStatus", goal.hostStatusTitle))
                    .font(.caption).foregroundStyle(.secondary)
            }
            if state != "ready" {
                Text(Strings.t("goals.read." + state))
                    .font(.callout)
                    .foregroundStyle(["error", "stale", "account_changed", "unknown"].contains(state) ? Color.orange : .secondary)
            }
            Text(goal.resumeStatusTitle(at: nowMs, transportUnavailable: transportUnavailable))
                .font(.caption).foregroundStyle(.secondary)
            if let observedAtMs = goal.observedAtMs, observedAtMs > 0, state != "account_changed" {
                Text(Strings.t("goals.lastObserved", DisplayFormat.age(
                    since: Date(timeIntervalSince1970: observedAtMs / 1_000),
                    now: Date(timeIntervalSince1970: nowMs / 1_000))))
                    .font(.caption).foregroundStyle(.secondary)
            }
            if goal.canReview(tasks, at: nowMs, transportUnavailable: transportUnavailable) {
                Button(Strings.t("goals.reviewTask")) { onReview(goal.taskId) }
                    .buttonStyle(.link)
            }
        }
        .accessibilityElement(children: .contain)
    }
}
