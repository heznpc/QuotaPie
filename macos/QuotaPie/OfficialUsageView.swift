import SwiftUI
import Charts

struct OfficialUsageView: View {
    @ObservedObject var store: OfficialUsageStore
    let client: StatusClient?
    let actionToken: String?
    let accounts: [AccountState]
    @State private var selectedAccount = ""
    @State private var days = 7
    @State private var grouping = Grouping.features
    @State private var showOriginal = false

    private enum Grouping: String, CaseIterable, Identifiable {
        case features, models, surfaces, triggers
        var id: String { rawValue }
        var title: String { Strings.t("usage.dashboard.group." + rawValue) }
        func rows(_ account: OfficialUsageAccount) -> [OfficialUsageRow] {
            switch self {
            case .features: return account.features
            case .models: return account.models
            case .surfaces: return account.surfaces
            case .triggers: return account.triggers
            }
        }
        func rows(_ day: OfficialUsageDay) -> [OfficialUsageRow] {
            switch self {
            case .features: return day.features
            case .models: return day.models
            case .surfaces: return day.surfaces
            case .triggers: return day.triggers
            }
        }
    }

    private var account: OfficialUsageAccount? {
        store.report?.accounts.first { $0.account == selectedAccount } ?? store.report?.accounts.first
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 6) {
                    Text(Strings.t("usage.analysis.title")).font(.system(size: 26, weight: .bold))
                    Text(Strings.t("usage.analysis.subtitle")).foregroundStyle(.secondary)
                }
                Spacer()
                if let report = store.report, report.accounts.count > 1 {
                    Picker(Strings.t("usage.dashboard.account"), selection: Binding(get: { account?.account ?? "" }, set: { selectedAccount = $0 })) {
                        ForEach(report.accounts, id: \.account) { item in Text(item.label).tag(item.account) }
                    }.labelsHidden().frame(width: 190)
                }
                Button { store.load(client: client, actionToken: actionToken, days: days, refresh: true) } label: {
                    Image(systemName: "arrow.clockwise")
                }.help(Strings.t("action.refresh")).disabled(store.loading)
            }
            if store.loading {
                HStack { ProgressView().controlSize(.small); Text(Strings.t("usage.dashboard.officialLoading")).foregroundStyle(.secondary) }
            }
            if store.error != nil { Label(Strings.t("usage.dashboard.loadError"), systemImage: "exclamationmark.circle").foregroundStyle(.orange) }
            if let account {
                if account.error != nil { Label(Strings.t("usage.dashboard.accountError"), systemImage: "exclamationmark.circle").foregroundStyle(.orange) }
                if let freshness = account.dataFreshnessMs, Date().timeIntervalSince1970 * 1000 - freshness > 86400000 {
                    Label(Strings.t("usage.dashboard.stale"), systemImage: "clock.badge.exclamationmark")
                        .font(.callout).foregroundStyle(.orange)
                }
                if account.status != "ready" || account.days.isEmpty {
                    VStack(spacing: 12) {
                        Image(systemName: "chart.bar.xaxis").font(.largeTitle).foregroundStyle(.secondary)
                        Text(Strings.t("usage.dashboard.officialEmpty")).font(.headline)
                        Text(Strings.t("usage.dashboard.officialEmptyHelp")).foregroundStyle(.secondary)
                    }.frame(maxWidth: .infinity).padding(50)
                } else {
                    OfficialUsageAnalysisView(analysis: account.analysis)
                    DisclosureGroup(Strings.t("usage.analysis.original"), isExpanded: $showOriginal) {
                        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Picker(Strings.t("usage.range"), selection: $days) {
                    Text(Strings.t("usage.dashboard.sevenDays")).tag(7)
                    Text(Strings.t("usage.dashboard.thirtyDays")).tag(30)
                }.pickerStyle(.segmented).frame(width: 150)
                Spacer()
                if let report = store.report {
                    Text(report.startDate + " – " + report.endDate).font(.callout).foregroundStyle(.secondary)
                }
            }
                            chart(account)
                        }.padding(.top, 12)
                    }.font(.callout)
                }
                Text(Strings.t("usage.dashboard.officialScope")).font(.caption).foregroundStyle(.secondary)
                if let freshness = account.dataFreshnessMs {
                    Text(Strings.t("usage.dashboard.freshness", Date(timeIntervalSince1970: freshness / 1000).formatted(date: .abbreviated, time: .shortened)))
                        .font(.caption).foregroundStyle(.secondary)
                } else {
                    Text(Strings.t("usage.dashboard.freshnessUnknown"))
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
        }
        .accessibilityIdentifier("usage.official")
        .onAppear { store.load(client: client, actionToken: actionToken, days: days) }
        .onDisappear { store.stop() }
        .onChange(of: days) { _ in store.load(client: client, actionToken: actionToken, days: days) }
        .onChange(of: actionToken) { _ in store.load(client: client, actionToken: actionToken, days: days) }
    }

    private var dateLabels: [String] {
        guard let report = store.report else { return [] }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.dateFormat = "yyyy-MM-dd"
        guard var current = formatter.date(from: report.startDate), let end = formatter.date(from: report.endDate) else { return [] }
        var dates: [String] = []
        while current <= end, dates.count < 92 {
            dates.append(formatter.string(from: current))
            current.addTimeInterval(86400)
        }
        return dates
    }

    private let chartColors: [Color] = [.blue, .orange, .green, .purple, .pink, .gray]
    private let otherKey = "__other"

    private func chartRows(_ rows: [OfficialUsageRow], topKeys: [String]) -> [OfficialUsageRow] {
        let lookup = Dictionary(rows.map { ($0.key, $0.value) }, uniquingKeysWith: +)
        var result = topKeys.map { OfficialUsageRow(key: $0, value: lookup[$0] ?? 0) }
        let other = rows.filter { !topKeys.contains($0.key) }.reduce(0) { $0 + $1.value }
        if other > 0 { result.append(OfficialUsageRow(key: otherKey, value: other)) }
        return result
    }

    private func chart(_ account: OfficialUsageAccount) -> some View {
        let topKeys = grouping.rows(account).sorted { $0.value > $1.value }.prefix(5).map(\.key)
        return VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(Strings.t("usage.dashboard.officialDaily")).font(.headline)
                    Text(Strings.t(account.units == "credits" ? "usage.dashboard.creditUnits" : "usage.dashboard.relativeUnits"))
                        .font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                Picker(Strings.t("usage.breakdown"), selection: $grouping) {
                    ForEach(Grouping.allCases) { Text($0.title).tag($0) }
                }.frame(width: 160)
            }
            Chart(account.days, id: \.date) { day in
                ForEach(chartRows(grouping.rows(day), topKeys: topKeys)) { row in
                    BarMark(x: .value("Date", day.date), y: .value("Usage", row.value))
                        .foregroundStyle(by: .value("Category", row.key))
                }
            }
            .chartForegroundStyleScale(domain: topKeys + [otherKey], range: chartColors)
            .chartXScale(domain: dateLabels)
            .chartXAxis {
                AxisMarks(values: .automatic(desiredCount: 7)) { value in
                    AxisValueLabel { if let date = value.as(String.self) { Text(String(date.suffix(5)).replacingOccurrences(of: "-", with: "/")) } }
                }
            }
            .chartYAxis { AxisMarks(position: .leading) }
            .chartLegend(.hidden)
            .frame(height: 205)
            distribution(account)
        }.padding(20).background(.background, in: RoundedRectangle(cornerRadius: 18))
    }

    private func distribution(_ account: OfficialUsageAccount) -> some View {
        let rows = grouping.rows(account).sorted { $0.value > $1.value }
        let topKeys = Array(rows.prefix(5).map(\.key))
        let visible = chartRows(rows, topKeys: topKeys)
        let total = rows.reduce(0) { $0 + $1.value }
        return VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text(grouping.title).font(.headline)
                Spacer()
                Text(Strings.t("usage.dashboard.periodShare")).font(.caption).foregroundStyle(.secondary)
            }
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 235), spacing: 16, alignment: .leading)], alignment: .leading, spacing: 14) {
                ForEach(Array(visible.enumerated()), id: \.element.key) { index, row in
                    HStack(alignment: .top, spacing: 9) {
                        RoundedRectangle(cornerRadius: 2).fill(chartColors[min(index, chartColors.count - 1)]).frame(width: 4, height: 38)
                        VStack(alignment: .leading, spacing: 3) {
                            Text(row.key == otherKey ? Strings.t("usage.dashboard.other") : title(row.key))
                                .font(.callout).foregroundStyle(.secondary).lineLimit(1).help(title(row.key))
                            Text(share(row.value, total: total)).font(.title3.weight(.semibold)).monospacedDigit()
                        }
                        Spacer(minLength: 0)
                    }
                }
            }
            if rows.count > 5 {
                DisclosureGroup(Strings.t("usage.dashboard.otherDetails")) {
                    ForEach(Array(rows.dropFirst(5))) { row in
                        HStack {
                            Text(title(row.key))
                            Spacer()
                            Text(share(row.value, total: total)).monospacedDigit()
                        }.font(.callout).padding(.vertical, 4)
                    }
                }.font(.caption)
            }
        }.padding(.top, 6)
    }

    private func share(_ value: Double, total: Double) -> String {
        guard total > 0 else { return "—" }
        let percent = value / total * 100
        return percent > 0 && percent < 0.1 ? "<0.1%" : String(format: "%.1f%%", percent)
    }

    private func title(_ key: String) -> String {
        let localized = Strings.t("usage.dashboard.category." + key)
        return localized == "usage.dashboard.category." + key ? key.replacingOccurrences(of: "_", with: " ") : localized
    }
}
