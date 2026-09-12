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
                    Text(Date(timeIntervalSince1970: record.startedAtMs / 1000).formatted(date: .abbreviated, time: .standard))
                        .foregroundStyle(.secondary)
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
}
