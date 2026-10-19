import Foundation
import Combine

struct UsageReportResponse: Decodable {
    let state: String
    let report: UsageReport?
    let error: String?
}

struct UsageTotals: Decodable {
    let inputTokens: Double
    let cachedInputTokens: Double
    let cacheCreationTokens: Double
    let outputTokens: Double
    let reasoningTokens: Double
    let totalTokens: Double
    let requests: Int
    let subagentTokens: Double
}

struct UsageActivity: Decodable {
    let localCompactions: Int?
    let compactions: Int
    let retries: Int
    let failedRequests: Int
    let attributedRequestTokens: Double
    let unattributedRequestTokens: Double
    let compactionTokens: Double?
    let retryTokens: Double?
    let requestsWithoutUsage: Int?
}

struct UsageBucket: Decodable, Identifiable {
    let id: String
    let label: String
    let fromMs: Double?
    let toMs: Double?
    let provider: String?
    let account: String?
    let sessionId: String?
    let model: String?
    let isSubagent: Bool?
    let previousTotalTokens: Double?
    let resetKind: String?
    let accountLabel: String?
    let resetAtMs: Double?
    let startClipped: Bool?
    let activity: UsageActivity?
    let models: [UsageBucket]?
    let parentSessionId: String?
    let repositoryUrl: String?
    let quotapieEvidence: String?
    let quotapieCandidateEvidence: String?
    let totals: UsageTotals

    private enum CodingKeys: String, CodingKey {
        case models, parentSessionId, repositoryUrl, quotapieEvidence, quotapieCandidateEvidence
        case id, label, fromMs, toMs, provider, account, sessionId, model, isSubagent, previousTotalTokens, resetKind, accountLabel, resetAtMs, startClipped, activity
    }
    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        id = try values.decode(String.self, forKey: .id)
        label = try values.decode(String.self, forKey: .label)
        fromMs = try values.decodeIfPresent(Double.self, forKey: .fromMs)
        toMs = try values.decodeIfPresent(Double.self, forKey: .toMs)
        provider = try values.decodeIfPresent(String.self, forKey: .provider)
        account = try values.decodeIfPresent(String.self, forKey: .account)
        sessionId = try values.decodeIfPresent(String.self, forKey: .sessionId)
        model = try values.decodeIfPresent(String.self, forKey: .model)
        isSubagent = try values.decodeIfPresent(Bool.self, forKey: .isSubagent)
        previousTotalTokens = try values.decodeIfPresent(Double.self, forKey: .previousTotalTokens)
        resetKind = try values.decodeIfPresent(String.self, forKey: .resetKind)
        accountLabel = try values.decodeIfPresent(String.self, forKey: .accountLabel)
        resetAtMs = try values.decodeIfPresent(Double.self, forKey: .resetAtMs)
        startClipped = try values.decodeIfPresent(Bool.self, forKey: .startClipped)
        activity = try values.decodeIfPresent(UsageActivity.self, forKey: .activity)
        models = try values.decodeIfPresent([UsageBucket].self, forKey: .models)
        parentSessionId = try values.decodeIfPresent(String.self, forKey: .parentSessionId)
        repositoryUrl = try values.decodeIfPresent(String.self, forKey: .repositoryUrl)
        quotapieEvidence = try values.decodeIfPresent(String.self, forKey: .quotapieEvidence)
        quotapieCandidateEvidence = try values.decodeIfPresent(String.self, forKey: .quotapieCandidateEvidence)
        totals = try UsageTotals(from: decoder)
    }
}

struct UsageReport: Decodable {
    let consumption: UsageConsumption?
    let generatedAtMs: Double
    let fromMs: Double
    let toMs: Double
    let timeZone: String
    let total: UsageTotals
    let previous: UsageTotals
    let days: [UsageBucket]
    let models: [UsageBucket]
    let sessions: [UsageBucket]
    let resetPeriods: [UsageBucket]
    let relayModels: [UsageBucket]?
    let coverage: Coverage
    let activity: UsageActivity

    struct Coverage: Decodable {
        let filesScanned: Int
        let filesPending: Int
        let compressedFilesSkipped: Int?
        let filesSkipped: Int
        let malformedLines: Int
        let unknownModelTokens: Double
        let firstObservedAtMs: Double?
        let lastObservedAtMs: Double?
        let relayFirstObservedAtMs: Double?
        let relayLastObservedAtMs: Double?
        let notes: [String]
    }
}

enum UsageDateRange: String, CaseIterable, Identifiable {
    case sinceThursday, sevenDays, fourteenDays, custom
    var id: String { rawValue }
    var title: String { Strings.t("usage.range." + rawValue) }

    func interval(now: Date, calendar: Calendar = .current) -> DateInterval? {
        let start = calendar.startOfDay(for: now)
        let days: Int
        switch self {
        case .sinceThursday:
            let distance = (calendar.component(.weekday, from: now) - 5 + 7) % 7
            days = distance == 0 ? 7 : distance
        case .sevenDays: days = 6
        case .fourteenDays: days = 13
        case .custom: return nil
        }
        guard let from = calendar.date(byAdding: .day, value: -days, to: start) else { return nil }
        return DateInterval(start: from, end: now)
    }
}

/// A separate read channel keeps historical scans off the menu-meter refresh path.
/// Responses are generation-scoped so changing range cannot show an older request.
final class UsageReportStore: ObservableObject {
    @Published private(set) var report: UsageReport?
    @Published private(set) var loading = false
    @Published private(set) var error: String?
    @Published private(set) var preset: UsageDateRange = .sinceThursday
    @Published var customFrom: Date = Calendar.current.startOfDay(for: Date())
    @Published var customTo: Date = Date()
    @Published private(set) var resetSelection: UsageBucket?
    @Published private(set) var resetChoices: [UsageBucket] = []
    private var request: URLSessionDataTask?
    private var poll: DispatchWorkItem?
    private var generation = 0
    private var activeInterval: DateInterval?

    func select(_ range: UsageDateRange, client: StatusClient?, actionToken: String?) {
        preset = range
        resetSelection = nil
        if range == .custom, let report {
            customFrom = Date(timeIntervalSince1970: report.fromMs / 1_000)
            customTo = Date(timeIntervalSince1970: max(report.fromMs, report.toMs - 1) / 1_000)
        }
        load(client: client, actionToken: actionToken)
    }

    func selectReset(_ reset: UsageBucket, client: StatusClient?, actionToken: String?) {
        guard let from = reset.fromMs, let to = reset.toMs, to > from,
              reset.provider != nil, reset.account != nil else { return }
        resetSelection = reset
        preset = .custom
        customFrom = Date(timeIntervalSince1970: resetStart(reset, fallback: from, to: to) / 1_000)
        customTo = Date(timeIntervalSince1970: (to - 1) / 1_000)
        load(client: client, actionToken: actionToken)
    }

    func applyCustom(client: StatusClient?, actionToken: String?) {
        resetSelection = nil
        load(client: client, actionToken: actionToken)
    }

    func load(client: StatusClient?, actionToken: String?, refresh: Bool = false, continueScan: Bool = false) {
        stop()
        if !continueScan { report = nil }
        guard let client else { error = Strings.t("usage.unavailable"); return }
        guard let actionToken, !actionToken.isEmpty else { error = Strings.t("client.missingActionToken"); return }
        let now = Date()
        let interval: DateInterval
        if continueScan, let activeInterval { interval = activeInterval }
        else if let reset = resetSelection, let from = reset.fromMs, let to = reset.toMs {
            interval = DateInterval(start: Date(timeIntervalSince1970: resetStart(reset, fallback: from, to: to) / 1_000), end: Date(timeIntervalSince1970: to / 1_000))
        } else if let selected = preset.interval(now: now) { interval = selected }
        else {
            let start = Calendar.current.startOfDay(for: customFrom)
            let end = min(now, Calendar.current.date(byAdding: .day, value: 1, to: Calendar.current.startOfDay(for: customTo)) ?? now)
            guard start < end else { error = Strings.t("usage.invalidRange"); return }
            interval = DateInterval(start: start, end: end)
        }
        guard interval.duration <= 90 * 24 * 60 * 60 else { error = Strings.t("usage.rangeTooLong"); return }
        activeInterval = interval
        error = nil
        loading = true
        let expectedGeneration = generation
        request = client.fetchUsageReport(fromMs: interval.start.timeIntervalSince1970 * 1_000,
            toMs: interval.end.timeIntervalSince1970 * 1_000, timeZone: TimeZone.current.identifier,
            actionToken: actionToken, provider: resetSelection?.provider, account: resetSelection?.account, refresh: refresh) { [weak self] result in
                DispatchQueue.main.async {
                    guard let self, self.generation == expectedGeneration else { return }
                    self.request = nil
                    switch result {
                    case .failure(let failure):
                        self.loading = false
                        self.error = failure.localizedDescription
                    case .success(let response):
                        if let value = response.report {
                            self.report = value
                            if self.resetSelection == nil { self.resetChoices = value.resetPeriods }
                        }
                        self.loading = response.state == "loading" || (response.report?.coverage.filesPending ?? 0) > 0
                        if response.state == "error" {
                            self.error = Strings.t("usage.readError")
                            self.loading = false
                        }
                        if self.loading {
                            let next = DispatchWorkItem { [weak self] in self?.load(client: client, actionToken: actionToken, continueScan: true) }
                            self.poll = next
                            DispatchQueue.main.asyncAfter(deadline: .now() + 2, execute: next)
                        }
                    }
                }
            }
    }

    func stop() {
        generation += 1
        request?.cancel()
        request = nil
        poll?.cancel()
        poll = nil
        loading = false
    }

    private func resetStart(_ reset: UsageBucket, fallback: Double, to: Double) -> Double {
        guard let observed = reset.resetAtMs, observed < to, to - observed <= 90 * 24 * 60 * 60 * 1_000 else { return fallback }
        return observed
    }
}

struct UsageConsumption: Decodable {
    let basis: String
    let quotaPercent: Double?
    let quotapie: QuotaPieConsumption
    let conversations: [UsageBucket]
    let subagents: [UsageBucket]
}

struct QuotaPieConsumption: Decodable {
    let candidates: UsageTotals?
    let candidateSessionIds: [String]?
    let development: UsageTotals
    let developmentSessionIds: [String]
    let evidence: String
    let relay: UsageActivity
    let quotaPercent: Double?
    let note: String
}
