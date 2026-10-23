import SwiftUI

struct ClaudeResetGrantState: Codable {
    let source: String
    let state: String
    let eligible: Bool?
    let grants: [ClaudeResetGrant]?
}

struct ClaudeResetGrant: Codable, Identifiable {
    let id: String
    let resets_left: Int
    let resets_total: Int
    let starts_at: String?
    let ends_at: String?
    let usable_now: Bool?
    let claimable: Bool?
    let paused: Bool?
    let clears: [String]?
    let blocking: [String]?
}

struct ClaudeResetGrantView: View {
    let state: ClaudeResetGrantState
    let observedAtMs: Double
    let isCurrent: Bool
    @State private var expanded = true

    var body: some View {
        DisclosureGroup(Strings.t("claude.reset.title"), isExpanded: $expanded) {
            VStack(alignment: .leading, spacing: 6) {
                Text(Strings.t(isCurrent ? "claude.reset.server" : "claude.reset.previous"))
                    .foregroundStyle(isCurrent ? Color.secondary : Color.orange)
                Text(Date(timeIntervalSince1970: observedAtMs / 1_000), style: .date)
                    + Text(" · ") + Text(Date(timeIntervalSince1970: observedAtMs / 1_000), style: .time)
                if state.state != "reported" {
                    Text(Strings.t("claude.reset.unknown"))
                } else if let grants = state.grants, !grants.isEmpty {
                    ForEach(grants) { grant in
                        VStack(alignment: .leading, spacing: 3) {
                            Text(Strings.t("claude.reset.count", String(grant.resets_left), String(grant.resets_total)))
                                .fontWeight(.semibold)
                            Text(Strings.t("claude.reset.usable", decision(grant.usable_now)))
                            Text(Strings.t("claude.reset.claimable", decision(grant.claimable)))
                            Text(Strings.t("claude.reset.expiry", grant.ends_at ?? Strings.t("claude.reset.unreported")))
                            Text(grant.id).foregroundStyle(.secondary).textSelection(.enabled)
                        }
                    }
                } else {
                    Text(Strings.t("claude.reset.empty"))
                }
            }.padding(.top, 5)
        }.font(.caption)
    }

    private func decision(_ value: Bool?) -> String {
        Strings.t(value == true ? "claude.reset.yes" : value == false ? "claude.reset.no" : "claude.reset.unreported")
    }
}
