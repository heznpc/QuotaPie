import SwiftUI

struct TaskSavingsPayload: Decodable {
    let policy: TaskSavingsPolicy?
    let active: [TaskSavingsRecord]
    let recent: [TaskSavingsRecord]
    var latest: TaskSavingsRecord? { active.first ?? recent.first }
}
struct TaskSavingsPolicy: Decodable {
    let enabled: Bool
    let configurable: Bool
    let supported: Bool
    let generations: Int
    let compatible: Int
    let applied: Int
    let bypassThreads: [String]?
}
struct TaskSavingsPolicyResponse: Decodable { let policy: TaskSavingsPolicy? }
struct TaskSavingsUsage: Decodable { let input: Int; let cachedInput: Int; let output: Int }
struct TaskSavingsRecord: Decodable, Identifiable {
    let requestId: String
    let threadId: String?
    let from: String
    let to: String
    let requestedEffort: String?
    let reasoningEffort: String?
    let responseModel: String?
    let phase: String
    let durationMs: Double
    let savingsReason: String?
    let usage: TaskSavingsUsage?
    let routed: Bool
    let active: Bool
    var id: String { requestId }
    var summary: String {
        Strings.t(routed ? "savings.routed" : "savings.kept", CompactionRecord.shortModel(to), reasoningEffort ?? "?")
    }
}
struct TaskSavingsSettingsView: View {
    @ObservedObject var model: PopoverModel
    let save: (Bool) -> Void
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(Strings.t("savings.title")).font(.headline)
            Text(Strings.t("savings.scope")).font(.callout).foregroundStyle(.secondary)
            if let policy = model.payload?.compaction?.savings?.policy {
                Picker(Strings.t("savings.enable"), selection: Binding(get: { policy.enabled }, set: save)) {
                    Text("Auto").tag(true)
                    Text(Strings.t("savings.off")).tag(false)
                }
                    .pickerStyle(.segmented).disabled(model.savingsSaving || !policy.configurable || (!policy.enabled && !policy.supported))
                Text(Strings.t("savings.applied", String(policy.applied), String(policy.generations))).font(.caption)
                if policy.compatible < policy.generations {
                    Text(Strings.t("savings.partial")).font(.caption).foregroundStyle(.orange)
                }
                if !policy.supported { Text(Strings.t("savings.unsupported")).font(.caption).foregroundStyle(.orange) }
            } else {
                Text(Strings.t("savings.unavailable")).font(.caption).foregroundStyle(.secondary)
            }
            if let message = model.savingsMessage { Text(message).font(.caption).foregroundStyle(.secondary) }
        }
    }
}
struct TaskSavingsHistory: View {
    let payload: TaskSavingsPayload
    let busy: Bool
    let undo: (String) -> Void
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(Strings.t("savings.title")).font(.headline)
            Text(Strings.t("savings.evidenceNotice")).font(.caption).foregroundStyle(.secondary)
            if payload.latest == nil { Text(Strings.t("savings.waiting")).font(.caption) }
            ForEach(payload.active + payload.recent) { record in
                VStack(alignment: .leading, spacing: 5) {
                    Text(record.summary).fontWeight(.medium)
                    Text(Strings.t("savings.original", CompactionRecord.shortModel(record.from), record.requestedEffort ?? "?"))
                    Text(Strings.t("savings.reason." + (record.savingsReason ?? "uncertain_task"))).foregroundStyle(.secondary)
                    Text(Strings.t("savings.response", record.responseModel.map(CompactionRecord.shortModel) ?? Strings.t("savings.unverified")))
                    Text(Strings.t("savings.phase." + (record.phase)) + " · " + String(format: "%.1f", record.durationMs / 1000) + Strings.t("compaction.seconds"))
                    if let usage = record.usage {
                        Text(Strings.t("savings.tokens", String(usage.input), String(usage.cachedInput), String(usage.output))).monospacedDigit()
                    }
                    if let thread = record.threadId {
                        Text(Strings.t("compaction.task", thread)).foregroundStyle(.secondary).textSelection(.enabled)
                        if record.routed {
                            if payload.policy?.bypassThreads?.contains(thread) ?? false {
                                Text(Strings.t("savings.undone")).foregroundStyle(.secondary)
                            } else {
                                Button(Strings.t("savings.undo")) { undo(thread) }.disabled(busy)
                            }
                        }
                    }
                }.font(.caption).padding(.vertical, 5)
            }
        }
    }
}
