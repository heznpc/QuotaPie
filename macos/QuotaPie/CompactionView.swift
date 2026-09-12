import SwiftUI

struct CompactionSummary: View {
    let record: CompactionRecord
    let openHistory: () -> Void
    var body: some View {
        Button(action: openHistory) {
            TimelineView(.periodic(from: .now, by: 1)) { context in
                HStack(spacing: 8) {
                    Image(systemName: record.active ? "arrow.triangle.2.circlepath" : "doc.text.magnifyingglass")
                    Text(Strings.t(record.phaseKey) + " · " + record.modelText)
                    Spacer(minLength: 0)
                    Text(record.elapsed(at: context.date)).monospacedDigit().foregroundStyle(.secondary)
                }.font(.caption).contentShape(Rectangle())
            }
        }.buttonStyle(.plain)
    }
}

struct CompactionHistory: View {
    let payload: CompactionPayload
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(Strings.t("compaction.title")).font(.headline)
            Text(Strings.t("compaction.explanation")).font(.caption).foregroundStyle(.secondary)
            if payload.reachable < payload.generations {
                Text(Strings.t("compaction.partial")).font(.caption).foregroundStyle(.orange)
            }
            if payload.latest == nil {
                Text(Strings.t("compaction.empty")).font(.caption).foregroundStyle(.secondary)
            }
            ForEach(payload.active + payload.recent) { record in
                VStack(alignment: .leading, spacing: 5) {
                    TimelineView(.periodic(from: .now, by: 1)) { context in
                        HStack {
                            Text(record.routeText).fontWeight(.medium)
                            Spacer()
                            Text(Strings.t(record.phaseKey) + " · " + record.elapsed(at: context.date))
                                .monospacedDigit()
                        }
                    }
                    Text(Strings.t("compaction.startedAt", stamp(record.startedAtMs)))
                        .foregroundStyle(.secondary)
                    if let end = record.finishedAtMs {
                        Text(Strings.t("compaction.finishedAt", stamp(end))).foregroundStyle(.secondary)
                    }
                    if let followup = record.followup {
                        Text(Strings.t("compaction.followup", followup.modelText, stamp(followup.startedAtMs)))
                            .foregroundStyle(.secondary)
                    } else if !record.active {
                        Text(Strings.t("compaction.followupUnknown")).foregroundStyle(.secondary)
                    }
                    if let threadId = record.threadId {
                        Text(Strings.t("compaction.task", threadId)).foregroundStyle(.secondary).textSelection(.enabled)
                    }
                    if let error = record.errorCode {
                        Text(Strings.t("compaction.evidence", error)).foregroundStyle(.secondary)
                    }
                }.font(.caption).padding(.vertical, 5)
            }
        }
    }

    private func stamp(_ ms: Double) -> String {
        Date(timeIntervalSince1970: ms / 1000).formatted(date: .abbreviated, time: .standard)
    }
}

struct CompactionSettingsView: View {
    @ObservedObject var model: PopoverModel
    let save: (String) -> Void
    @State private var draft = ""
    @State private var loaded = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(Strings.t("compaction.settings.title")).font(.headline)
            Text(Strings.t("compaction.settings.scope")).font(.callout).foregroundStyle(.secondary)
            if let policy = model.payload?.compaction?.policy {
                Picker(Strings.t("compaction.settings.model"), selection: $draft) {
                    if !policy.models.contains(policy.model) {
                        Text(CompactionRecord.shortModel(policy.model)).tag(policy.model)
                    }
                    ForEach(policy.models, id: \.self) { value in
                        Text(CompactionRecord.shortModel(value)).tag(value)
                    }
                }.frame(maxWidth: 300)
                    .disabled(model.compactionSaving || !policy.configurable)
                    .onAppear { draft = policy.model; loaded = policy.model }
                    .onChange(of: policy.model) { value in
                        if draft == loaded { draft = value }
                        loaded = value
                    }
                Text(Strings.t("compaction.settings.effort")).font(.caption).foregroundStyle(.secondary)
                Text(Strings.t("compaction.settings.applied", CompactionRecord.shortModel(policy.model), String(policy.applied), String(policy.generations)))
                    .font(.caption).foregroundStyle(.secondary)
                if policy.applied < policy.generations {
                    Text(Strings.t("compaction.settings.partial")).font(.caption).foregroundStyle(.orange)
                }
                Button(Strings.t(model.compactionSaving ? "compaction.settings.saving" : "compaction.settings.save")) { save(draft) }
                    .disabled(model.compactionSaving || !policy.configurable || !policy.models.contains(draft))
            } else {
                Text(Strings.t("compaction.settings.unavailable")).font(.caption).foregroundStyle(.secondary)
            }
            if let message = model.compactionSaveMessage {
                Text(message).font(.caption).foregroundStyle(.secondary)
            }
        }
    }
}
