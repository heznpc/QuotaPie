import SwiftUI

/// Only compares values within the same official dimension and one server response.
struct OfficialUsageAnalysisView: View {
    let analysis: OfficialUsageAnalysis?
    @State private var showAllModels = false
    @State private var showOtherFeatures = false

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            if let analysis {
                verdict(analysis)
                if analysis.status == "observed_days" {
                    HStack(alignment: .top, spacing: 16) {
                        VStack(alignment: .leading, spacing: 14) {
                            Text(Strings.t("usage.analysis.models")).font(.headline)
                            Text(Strings.t("usage.analysis.modelsNote")).font(.caption).foregroundStyle(.secondary)
                            let rows = analysis.models.sorted { abs($0.delta) > abs($1.delta) }
                            ForEach(Array(showAllModels ? rows : Array(rows.prefix(5))), id: \.key) { row in
                                changeRow(row, maximum: rows.map { abs($0.delta) }.max() ?? 0)
                            }
                            if rows.count > 5 {
                                Button(Strings.t(showAllModels ? "usage.analysis.less" : "usage.analysis.allModels")) { showAllModels.toggle() }.buttonStyle(.link)
                            }
                        }.padding(20).frame(maxWidth: .infinity, alignment: .topLeading)
                            .background(.background, in: RoundedRectangle(cornerRadius: 16))
                        VStack(alignment: .leading, spacing: 16) {
                            subagents(analysis)
                            conversations
                        }.frame(maxWidth: .infinity, alignment: .topLeading)
                    }
                    DisclosureGroup(Strings.t("usage.analysis.otherFeatures"), isExpanded: $showOtherFeatures) {
                        VStack(alignment: .leading, spacing: 12) {
                            Text(Strings.t("usage.analysis.featuresNote")).font(.caption).foregroundStyle(.secondary)
                            let rows = analysis.features.filter { $0.key != "subagent" && $0.key != "user" }.sorted { abs($0.delta) > abs($1.delta) }
                            ForEach(rows, id: \.key) { row in changeRow(row, maximum: rows.map { abs($0.delta) }.max() ?? 0) }
                        }.padding(.top, 12)
                    }.font(.callout)
                    if !analysis.speeds.isEmpty {
                        DisclosureGroup(Strings.t("usage.analysis.speeds")) {
                            VStack(alignment: .leading, spacing: 12) {
                                Text(Strings.t("usage.analysis.modelsNote")).font(.caption).foregroundStyle(.secondary)
                                let rows = analysis.speeds.sorted { abs($0.delta) > abs($1.delta) }
                                ForEach(rows, id: \.key) { row in changeRow(row, maximum: rows.map { abs($0.delta) }.max() ?? 0) }
                            }.padding(.top, 12)
                        }.font(.callout)
                    }
                } else {
                    Text(reason(analysis.reason)).foregroundStyle(.secondary)
                    conversations
                }
            } else {
                VStack(alignment: .leading, spacing: 8) {
                    Text(Strings.t("usage.analysis.noBoundary")).font(.headline)
                    Text(Strings.t("usage.analysis.noBoundaryHelp")).foregroundStyle(.secondary)
                }.padding(20).frame(maxWidth: .infinity, alignment: .leading)
                    .background(.background, in: RoundedRectangle(cornerRadius: 16))
            }
        }.accessibilityIdentifier("usage.official.analysis")
    }

    private func verdict(_ analysis: OfficialUsageAnalysis) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline, spacing: 14) {
                Text(analysis.status == "observed_days" ? change(analysis.changePercent) : "—")
                    .font(.system(size: 28, weight: .semibold, design: .rounded)).monospacedDigit()
                Text(Strings.t("usage.analysis.observedChange")).font(.callout)
                Spacer()
                Text(Strings.t("usage.analysis.evidenceBadge")).font(.caption)
                    .padding(6).background(Color.accentColor.opacity(0.10), in: Capsule())
            }
            if !analysis.currentStartDate.isEmpty && !analysis.currentEndDate.isEmpty {
                Text(Strings.t("usage.analysis.intervals", analysis.currentStartDate, analysis.currentEndDate, analysis.previousStartDate, analysis.previousEndDate))
                    .font(.callout).foregroundStyle(.secondary)
            }
            Text(Strings.t("usage.analysis.exactUnknown")).font(.callout.weight(.medium))
            DisclosureGroup(Strings.t("usage.analysis.evidenceDetails")) {
                VStack(alignment: .leading, spacing: 7) {
                    Text(Strings.t("usage.analysis.exactReason"))
                    if let boundary = analysis.boundaryMs {
                        Text(Strings.t("usage.analysis.boundary", Date(timeIntervalSince1970: boundary / 1000).formatted(date: .abbreviated, time: .shortened)))
                        Text(Strings.t(analysis.boundaryKind == "scheduled_reset" ? "usage.analysis.scheduledBoundary" : "usage.analysis.recoveryBoundary"))
                    }
                    if !analysis.excludedDates.isEmpty {
                        Text(Strings.t("usage.analysis.excluded", analysis.excludedDates.joined(separator: ", ")))
                    }
                    if !analysis.freshnessConfirmed { Text(Strings.t("usage.analysis.freshness")) }
                }.font(.caption).foregroundStyle(.secondary).frame(maxWidth: .infinity, alignment: .leading).padding(.top, 6)
            }.font(.caption)
        }.padding(18).frame(maxWidth: .infinity, alignment: .leading)
            .background(.background, in: RoundedRectangle(cornerRadius: 16))
    }

    private func subagents(_ analysis: OfficialUsageAnalysis) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(Strings.t("usage.analysis.activityMix")).font(.headline)
            let relevant = analysis.features.filter { $0.key == "subagent" || $0.key == "user" }
            if relevant.isEmpty {
                Text(Strings.t("usage.analysis.subagentUnknown")).foregroundStyle(.secondary)
            } else {
                ForEach(relevant, id: \.key) { row in
                    HStack {
                        Text(label(row.key)).font(.callout)
                        Spacer()
                        Text(change(row.changePercent)).font(.title3.weight(.semibold)).monospacedDigit()
                    }
                    Text(Strings.t("usage.analysis.values", value(row.previous), value(row.current)))
                        .font(.caption).foregroundStyle(.secondary)
                }
                Text(Strings.t("usage.analysis.featuresNote")).font(.caption).foregroundStyle(.secondary)
            }
        }.padding(20).frame(maxWidth: .infinity, alignment: .leading)
            .background(.background, in: RoundedRectangle(cornerRadius: 16))
    }

    private func reason(_ code: String?) -> String {
        switch code {
        case "missing_daily_rows": return Strings.t("usage.analysis.missingDays")
        case "recovery_not_observed": return Strings.t("usage.analysis.noBoundaryHelp")
        default: return Strings.t("usage.analysis.insufficient")
        }
    }

    private var conversations: some View {
        VStack(alignment: .leading, spacing: 9) {
            Label(Strings.t("usage.analysis.conversations"), systemImage: "bubble.left.and.bubble.right").font(.headline)
            Text(Strings.t("usage.analysis.unavailable")).font(.title3.weight(.semibold))
            Text(Strings.t("usage.analysis.conversationsReason")).font(.callout).foregroundStyle(.secondary)
        }.padding(20).frame(maxWidth: .infinity, alignment: .leading)
            .background(.background, in: RoundedRectangle(cornerRadius: 16))
    }

    private func changeRow(_ row: OfficialUsageChange, maximum: Double) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(label(row.key)).font(.callout.weight(.medium)).lineLimit(1).help(row.key)
                Spacer()
                Text(change(row.changePercent)).font(.callout.weight(.medium)).monospacedDigit()
            }
            GeometryReader { proxy in
                HStack(spacing: 0) {
                    ZStack(alignment: .trailing) {
                        Color.clear
                        Capsule().fill(Color.green.opacity(0.7)).frame(width: row.delta < 0 && maximum > 0 ? proxy.size.width / 2 * abs(row.delta) / maximum : 0)
                    }
                    Rectangle().fill(Color.secondary.opacity(0.3)).frame(width: 1)
                    ZStack(alignment: .leading) {
                        Color.clear
                        Capsule().fill(Color.orange.opacity(0.7)).frame(width: row.delta > 0 && maximum > 0 ? proxy.size.width / 2 * row.delta / maximum : 0)
                    }
                }
            }.frame(height: 6).accessibilityHidden(true)
            Text(Strings.t("usage.analysis.values", value(row.previous), value(row.current)))
                .font(.caption).foregroundStyle(.secondary).monospacedDigit()
        }.padding(.vertical, 3)
    }

    private func change(_ value: Double?) -> String {
        guard let value else { return Strings.t("usage.analysis.noBaseline") }
        return String(format: "%+.1f%%", value)
    }
    private func value(_ number: Double) -> String {
        number.formatted(.number.precision(.fractionLength(0...2)).locale(Locale(identifier: Strings.localeIdentifier())))
    }
    private func label(_ key: String) -> String {
        let translated = Strings.t("usage.dashboard.category." + key)
        return translated == "usage.dashboard.category." + key ? key : translated
    }
}
