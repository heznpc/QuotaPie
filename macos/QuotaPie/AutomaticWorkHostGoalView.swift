import SwiftUI

/// Shared by the existing work editor and its saved policy row. A host's goal
/// completion is displayed as an observation, never as a runner result.
struct AutomaticWorkHostGoalView: View {
    let goal: AutomaticWorkHostGoal
    let transportUnavailable: Bool

    var body: some View {
        TimelineView(.periodic(from: .now, by: 30)) { context in
            let nowMs = context.date.timeIntervalSince1970 * 1_000
            let state = goal.displayReadState(at: nowMs, transportUnavailable: transportUnavailable)
            VStack(alignment: .leading, spacing: 4) {
                if let objective = goal.visibleObjective(at: nowMs, transportUnavailable: transportUnavailable) {
                    if state != "ready" {
                        Text(Strings.t("goals.previousObservation")).font(.caption).foregroundStyle(.secondary)
                    }
                    Text(objective).font(.callout).lineLimit(3).textSelection(.enabled).help(objective)
                    Text(Strings.t("goals.hostStatus", goal.hostStatusTitle)).font(.caption).foregroundStyle(.secondary)
                }
                if state != "ready" {
                    Text(Strings.t("goals.read." + state)).font(.caption)
                        .foregroundStyle(["error", "stale", "account_changed", "unknown"].contains(state) ? Color.orange : .secondary)
                }
                if let observedAtMs = goal.observedAtMs, observedAtMs > 0, state != "account_changed" {
                    Text(Strings.t("goals.lastObserved", DisplayFormat.age(
                        since: Date(timeIntervalSince1970: observedAtMs / 1_000), now: context.date)))
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
        }
    }
}
