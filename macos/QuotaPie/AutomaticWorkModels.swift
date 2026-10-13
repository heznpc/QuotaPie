import Foundation

struct AutomaticWorkBudget: Codable {
    var reservePercent: Double
    var maxUsagePercent: Double
    var targetUsagePercent: Double?
}

struct AutomaticWorkSchedule: Codable {
    var timeZone: String
    var days: [Int]
    var start: String
    var end: String
}

struct AutomaticWorkResult: Codable {
    var status: String
    var report: String?
    var summary: String?
    var evidenceRefs: [String]?
    var remainingWork: String?
    var blockingQuestion: String?
    var completionAssessment: String?
    var reason: String?
    var durationSeconds: Double?
}

struct AutomaticWorkState: Decodable {
    var spentByBucket: [String: Double]
    var turns: Int
    var totalDurationSeconds: Double
    var status: String
    var activeExecutionId: String?
    var lastResult: AutomaticWorkResult?
}

struct AutomaticWorkBucketPerformance: Decodable {
    let targetMet: String
    let accountUsage: Double
    let accountUsageScope: String?
    let beforeResetAccountUsage: Double?
    let beforeResetTargetMet: String?
    let targetUsagePercent: Double?
    let maxUsagePercent: Double
}
struct AutomaticWorkPerformance: Decodable {
    let policyRevision: Int
    let buckets: [String: AutomaticWorkBucketPerformance]
    let usefulWorkCompleted: Bool
    let completionAssessment: String?
    let limitsRespected: Bool
    let limitsAssessment: String
    let attributionAvailable: Bool
}

struct AutomaticWorkAdmission: Decodable {
    let ready: Bool
    let reason: String
}

enum AutomaticWorkReason {
    static func text(_ code: String) -> String {
        let key: String
        switch code {
        case "work-revision-conflict": return Strings.t("automatic.conflict")
        case "claude-auth-required", "claude-subscription-auth-required", "claude-auth-unverified": key = "login"
        case "claude-paid-overage-not-disabled", "claude-subscription-routing-unverified", "claude-subscription-usage-unverified": key = "subscription"
        case "account-unavailable", "profile-unavailable", "account-identity-unavailable", "account-session-mismatch", "work-binding-changed", "thread-profile-unverified": key = "binding"
        case "legacy-work-active", "work-already-claimed", "work-already-claimed-or-held": key = "busy"
        case "quota-unknown", "quota-stale", "reset-unconfirmed", "awaiting-quota-recovery": key = "quota"
        case "reserve-reached": key = "reserve"
        case "usage-budget-ended", "turn-budget-ended", "time-budget-ended": key = "budget"
        case "expired": key = "expired"
        case "activity-paused": key = "schedule"
        case "awaiting-announcement": key = "announcement"
        case "awaiting-reset-window": key = "resetWindow"
        case "needs-user-input": key = "input"
        case "work-needs-review", "uncertain", "execution-record-unavailable": key = "review"
        case "work-general-budget-required", "work-budgets-required": key = "buckets"
        case "work-target-exceeds-limit", "work-invalid-percent", "work-invalid-limit", "work-invalid-turn-limit", "work-invalid-schedule", "work-completion-criteria-required": key = "settings"
        case "forbidden": return Strings.t("client.missingActionToken")
        case "disabled", "stopped": return Strings.t("automatic.disable")
        case "objective-completed": return Strings.t("automatic.status.objective-completed")
        case "ready": key = "ready"
        default: return Strings.t("automatic.reason.other", code)
        }
        return Strings.t("automatic.reason." + key)
    }
}

struct AutomaticWorkError: LocalizedError {
    let code: String
    let status: Int
    init(data: Data, status: Int) {
        struct Failure: Decodable { let error: String }
        let received = (try? JSONDecoder().decode(Failure.self, from: data))?.error ?? "work-action-failed"
        code = received.range(of: "^[a-z][a-z_-]{1,99}$", options: .regularExpression) != nil ? received : "work-action-failed"
        self.status = status
    }
    var errorDescription: String? { AutomaticWorkReason.text(code) }
}

struct AutomaticWorkPolicy: Decodable, Identifiable {
    var id: String
    var provider: String
    var account: String
    var nativeSessionId: String
    var model: String?
    var prompt: String
    var objective: String
    var completionCriteria: [String]
    var dispatchOwner: String
    var enabled: Bool
    var trigger: String
    var resetBucket: String?
    var resetWithinMinutes: Double
    var budgetByBucket: [String: AutomaticWorkBudget]
    var maxTurns: Int
    var maxDurationSeconds: Double
    var maxTotalDurationSeconds: Double
    var expiresAtMs: Double
    var priority: Double
    var activitySchedule: AutomaticWorkSchedule?
    var workDeadline: Double?
    var onReset: String
    var revision: Int?
    var state: AutomaticWorkState?
    var performance: AutomaticWorkPerformance?
    var admission: AutomaticWorkAdmission?

    static func draft(provider: String, account: String, buckets: [String], reserveByBucket: [String: Double] = [:]) -> Self {
        Self(id: UUID().uuidString, provider: provider, account: account, nativeSessionId: "",
             prompt: "", objective: "", completionCriteria: [], dispatchOwner: "local", enabled: false,
             trigger: "quota-ready", resetWithinMinutes: 60,
             budgetByBucket: Dictionary(uniqueKeysWithValues: buckets.map { ($0, AutomaticWorkBudget(reservePercent: reserveByBucket[$0] ?? 0, maxUsagePercent: 20)) }),
             maxTurns: 3, maxDurationSeconds: 600, maxTotalDurationSeconds: 1800,
             expiresAtMs: Date().addingTimeInterval(86400).timeIntervalSince1970 * 1000,
             priority: 0, onReset: "stop")
    }

    // Only the editable contract is sent. Identity, working directory and runtime
    // state are resolved by the service, never trusted from a UI snapshot.
    var input: [String: Any] {
        var value: [String: Any] = ["id": id, "provider": provider, "account": account,
            "nativeSessionId": nativeSessionId, "prompt": prompt, "objective": objective,
            "completionCriteria": completionCriteria.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }, "dispatchOwner": dispatchOwner,
            "enabled": enabled, "trigger": trigger, "resetWithinMinutes": resetWithinMinutes,
            "budgetByBucket": budgetByBucket.mapValues { budget -> [String: Any] in
                var row: [String: Any] = ["reservePercent": budget.reservePercent, "maxUsagePercent": budget.maxUsagePercent]
                if let target = budget.targetUsagePercent { row["targetUsagePercent"] = target }
                return row
            }, "maxTurns": maxTurns, "maxDurationSeconds": maxDurationSeconds,
            "maxTotalDurationSeconds": maxTotalDurationSeconds, "expiresAtMs": expiresAtMs,
            "priority": priority, "onReset": onReset]
        if let resetBucket { value["resetBucket"] = resetBucket }
        if let workDeadline { value["workDeadline"] = workDeadline }
        if let schedule = activitySchedule {
            value["activitySchedule"] = ["timeZone": schedule.timeZone, "days": schedule.days, "start": schedule.start, "end": schedule.end]
        }
        return value
    }
}

struct AutomaticWorkAccount: Decodable, Identifiable {
    let provider: String
    let account: String
    let label: String
    let buckets: [String]
    let reserveByBucket: [String: Double]
    var id: String { provider + "/" + account }
}
struct AutomaticWorkTarget: Decodable, Identifiable {
    let nativeSessionId: String
    let title: String
    let cwd: String
    let model: String?
    var id: String { nativeSessionId }
}
struct AutomaticWorkExecution: Decodable, Identifiable {
    let id: String
    let policyId: String
    let owner: String
    let turnOrdinal: Int
    let claimedAtMs: Double
    let status: String
    let result: AutomaticWorkResult?
}
struct AutomaticWorkDefaults: Decodable { let timeZone: String }
struct AutomaticWorkResponse: Decodable {
    let defaults: AutomaticWorkDefaults
    let policies: [AutomaticWorkPolicy]
    let accounts: [AutomaticWorkAccount]
    let executions: [AutomaticWorkExecution]
}
struct AutomaticWorkTargetsResponse: Decodable { let targets: [AutomaticWorkTarget] }
struct AutomaticWorkSaveResponse: Decodable { let policy: AutomaticWorkPolicy }
