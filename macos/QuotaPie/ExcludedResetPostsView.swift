import SwiftUI

struct ExcludedResetPost: Decodable, Identifiable {
    let id: String
    let author: String
    let text: String
    let publishedAtMs: Double
    let contextText: String?
    let missingContext: Bool
    let reason: String
    let source: String
    let firstSeenAtMs: Double
    let lastSeenAtMs: Double
    var identity: String { source + ":" + id }
    var sourceURL: URL? {
        guard !id.isEmpty, id.allSatisfy({ $0.isASCII && $0.isNumber }),
              ["thsottiaux", "reach_vb", "dkundel", "openaidevs", "openai", "claudedevs", "claudeai", "anthropicai", "lydiahallie"].contains(author.lowercased()) else { return nil }
        return URL(string: "https://x.com/\(author)/status/\(id)")
    }
    var reasonKey: String {
        ["unwatched-author", "no-event-evidence", "no-reset-or-benefit-evidence"].contains(reason)
            ? "signal.excluded." + reason : "signal.excluded.unknown"
    }
}

struct ExcludedResetPostsView: View {
    let posts: [ExcludedResetPost]
    var body: some View {
        DisclosureGroup(Strings.t("signal.excluded.title", String(posts.count))) {
            VStack(alignment: .leading, spacing: 12) {
                Text(Strings.t("signal.excluded.coverage")).font(.caption).foregroundStyle(.secondary)
                if posts.isEmpty { Text(Strings.t("signal.excluded.empty")).font(.caption) }
                ForEach(posts, id: \.identity) { post in
                    Divider()
                    HStack {
                        Text("@" + post.author).font(.callout.weight(.medium))
                        Spacer()
                        if let url = post.sourceURL { Link(Strings.t("overview.original"), destination: url).font(.caption) }
                    }
                    Text(Strings.t(post.reasonKey)).font(.caption).foregroundStyle(.orange)
                    Text(post.text).font(.callout).textSelection(.enabled)
                    if let context = post.contextText {
                        DisclosureGroup(Strings.t("signal.replyContext")) {
                            Text(context).font(.caption).textSelection(.enabled)
                        }
                    }
                    if post.missingContext { Text(Strings.t("signal.excluded.missingContext")).font(.caption).foregroundStyle(.orange) }
                    Text(Strings.t("signal.published", ResetSignal.stamp(post.publishedAtMs))).font(.caption2)
                    Text(Strings.t("signal.detected", ResetSignal.stamp(post.firstSeenAtMs))).font(.caption2)
                    Text(Strings.t("signal.checked", ResetSignal.stamp(post.lastSeenAtMs))).font(.caption2)
                    Text(Strings.t("signal.via." + post.source)).font(.caption2).foregroundStyle(.secondary)
                }
            }.frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}
