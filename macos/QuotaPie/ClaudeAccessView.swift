import SwiftUI

struct ClaudeAccessCheck: Codable, Identifiable {
    let id: String
    let result: String
    let source: String
    let observedAtMs: Double
    let count: Int?
    let detail: String?
}

struct ClaudeAccessReport: Codable {
    let organizationName: String?
    let role: String?
    let email: String?
    let observedAtMs: Double
    let checks: [ClaudeAccessCheck]
}

struct ClaudeAccessView: View {
    let report: ClaudeAccessReport

    var body: some View {
        DisclosureGroup(Strings.t("claude.access.title")) {
            VStack(alignment: .leading, spacing: 9) {
                if let organization = report.organizationName {
                    Text(organization).fontWeight(.semibold)
                }
                if let email = report.email { Text(email).textSelection(.enabled) }
                if let role = report.role {
                    Text(Strings.t("claude.access.role", role))
                }
                Text(Strings.t("claude.access.explanation")).foregroundStyle(.secondary)
                ForEach(report.checks) { check in
                    VStack(alignment: .leading, spacing: 2) {
                        HStack(alignment: .firstTextBaseline) {
                            Text(Strings.t("claude.access.item." + check.id))
                            Spacer(minLength: 6)
                            Text(Strings.t("claude.access.result." + check.result))
                                .foregroundStyle(check.result == "not-exposed" ? Color.secondary : Color.primary)
                            if let count = check.count { Text("\(count)").monospacedDigit() }
                        }
                        if let detail = check.detail {
                            Text(detail).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                        }
                        HStack(spacing: 4) {
                            Text(Strings.t("claude.access.source." + check.source))
                            Text("·")
                            Text(Date(timeIntervalSince1970: check.observedAtMs / 1000), style: .date)
                            Text(Date(timeIntervalSince1970: check.observedAtMs / 1000), style: .time)
                        }.font(.caption2).foregroundStyle(.secondary)
                    }
                }
            }.padding(.top, 8)
        }
        .font(.caption)
        .accessibilityIdentifier("claude.access.report")
    }
}
