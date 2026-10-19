import Foundation
import Combine

struct OfficialUsageRow: Decodable, Identifiable {
    let key: String
    let value: Double
    var id: String { key }
}

struct OfficialUsageDay: Decodable, Identifiable {
    let date: String
    let total: Double
    let features: [OfficialUsageRow]
    let models: [OfficialUsageRow]
    let surfaces: [OfficialUsageRow]
    let triggers: [OfficialUsageRow]
    var id: String { date }
}

struct OfficialUsageAccount: Decodable, Identifiable {
    let account: String
    let label: String
    let status: String
    let error: String?
    let units: String
    let dataFreshnessMs: Double?
    let days: [OfficialUsageDay]
    let total: Double
    let features: [OfficialUsageRow]
    let models: [OfficialUsageRow]
    let surfaces: [OfficialUsageRow]
    let triggers: [OfficialUsageRow]
    let periodsAsOfMs: Double?
    let periodsComplete: Bool
    let periodsApproximate: Bool
    let threads: [OfficialUsageThread]?
    let threadsAsOfMs: Double?
    let threadsError: String?
    let analysis: OfficialUsageAnalysis?
    var id: String { account }
}

struct OfficialUsageReport: Decodable {
    let generatedAtMs: Double
    let startDate: String
    let endDate: String
    let accounts: [OfficialUsageAccount]
}

final class OfficialUsageStore: ObservableObject {
    @Published private(set) var report: OfficialUsageReport?
    @Published private(set) var loading = false
    @Published private(set) var error: String?
    private var request: URLSessionDataTask?
    private var generation = 0
    private(set) var selectedDays = 7
    private var loadedToken: String?

    func load(client: StatusClient?, actionToken: String?, days: Int = 7, refresh: Bool = false) {
        guard [7, 30].contains(days) else { return }
        guard let client, let actionToken, !actionToken.isEmpty else {
            stop()
            report = nil
            loadedToken = nil
            error = Strings.t("usage.unavailable"); return
        }
        if !refresh, days == selectedDays, loadedToken == actionToken,
           let report, Date().timeIntervalSince1970 * 1_000 - report.generatedAtMs < 60_000 { return }
        stop()
        if days != selectedDays || loadedToken != actionToken { report = nil }
        selectedDays = days
        loadedToken = actionToken
        loading = true
        error = nil
        let expected = generation
        let now = Date()
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd"
        let calendar = Calendar.current
        let weekdayDistance = (calendar.component(.weekday, from: now) - 5 + 7) % 7
        let thursday = calendar.date(byAdding: .day, value: -(weekdayDistance == 0 ? 7 : weekdayDistance), to: now) ?? now
        let start = Calendar.current.date(byAdding: .day, value: -(days - 1), to: now) ?? now
        request = client.fetchOfficialUsage(startDate: formatter.string(from: start), endDate: formatter.string(from: now), actionToken: actionToken, refresh: refresh, analysisDate: formatter.string(from: thursday), analysisTimeZone: TimeZone.current.identifier) { [weak self] result in
            DispatchQueue.main.async {
                guard let self, expected == self.generation else { return }
                self.loading = false
                self.request = nil
                switch result {
                case .success(let report): self.report = report
                case .failure: self.error = Strings.t("usage.readError")
                }
            }
        }
    }

    func stop() {
        generation += 1
        request?.cancel()
        request = nil
        loading = false
    }
}

struct OfficialUsageThread: Decodable, Identifiable {
    let threadId: String
    let title: String
    let createdAtMs: Double
    let scope: String
    let descendantCount: Int
    let ownershipBasis: String?
    let weeklyLimitPercent: Double?
    let fiveHourLimitPercent: Double?
    let dataStatus: String
    let groups: [OfficialUsageThreadGroup]
    var id: String { threadId }
}
struct OfficialUsageThreadGroup: Decodable {
    let model: String
    let reasoningEffort: String
    let weeklyLimitPercent: Double?
    let fiveHourLimitPercent: Double?
}
