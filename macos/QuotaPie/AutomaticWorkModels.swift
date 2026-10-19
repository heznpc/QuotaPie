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
    let resetUncertaintyMs: Double?
    let maxObservationGapMs: Double?
    let unusedBeforeResetPercent: Double?
}
struct AutomaticWorkPerformance: Decodable {
    let policyRevision: Int
    let buckets: [String: AutomaticWorkBucketPerformance]
    let usefulWorkCompleted: Bool
    let completionAssessment: String?
    let limitsRespected: Bool
    let limitsAssessment: String
    let attributionAvailable: Bool
    let usefulWorkBeforeReset: String?
}

struct AutomaticWorkAdmission: Decodable {
    let ready: Bool
    let reason: String
    let planning: AutomaticWorkPlanning?
    var executionTarget: AutomaticWorkExecutionTarget? = nil
}
struct AutomaticWorkExecutionTarget: Decodable {
    let account: String
}
struct AutomaticWorkPlanning: Decodable {
    let horizonAtMs: Double
    let expectedWorkMinutes: Double
    let expectedWorkSource: String
    let deadlineAtMs: Double?
    let deadlineSource: String?
    let finishAtMs: Double?
    let startByAtMs: Double?
}

enum AutomaticWorkReason {
    static func text(_ code: String) -> String {
        let key: String
        switch code {
        case "work-revision-conflict": return Strings.t("automatic.conflict")
        case "host-goal-complete": return Strings.t("automatic.goal.reason.complete")
        case "host-goal-objective-changed": return Strings.t("automatic.goal.reason.changed")
        case "host-goal-paused", "host-goal-blocked", "host-goal-budget-limited", "host-goal-inactive": return Strings.t("automatic.goal.reason.paused")
        case "host-goal-account-changed": return Strings.t("goals.read.account_changed")
        case "work-host-goal-review-required": return Strings.t("automatic.goal.reason.reviewRequired")
        case "host-goal-loading", "host-goal-unavailable", "host-goal-error", "host-goal-stale", "host-goal-unknown", "host-goal-no-goal", "host-goal-unsupported": return Strings.t("automatic.goal.reason.unavailable")
        case "claude-auth-required", "claude-subscription-auth-required", "claude-auth-unverified": key = "login"
        case "claude-paid-overage-not-disabled", "claude-subscription-routing-unverified", "claude-subscription-usage-unverified": key = "subscription"
        case "account-unavailable", "profile-unavailable", "account-identity-unavailable", "account-session-mismatch", "work-binding-changed", "thread-profile-unverified": key = "binding"
        case "legacy-work-active", "work-already-claimed", "work-already-claimed-or-held": key = "busy"
        case "quota-unknown", "quota-stale", "reset-unconfirmed", "awaiting-quota-recovery": key = "quota"
        case "host-queue-turn-failed": return Strings.t("autoResume.reason.turnFailed")
        case "host-queue-turn-interrupted": return Strings.t("autoResume.reason.turnInterrupted")
        case "host-queue-quota-blocked": return Strings.t("autoResume.reason.turnQuotaBlocked")
        case "execution-target-provider-rejected": return Strings.t("autoResume.reason.targetProviderRejected")
        case "execution-target-provider-quota-blocked": return Strings.t("autoResume.reason.targetProviderQuota")
        case "execution-target-completion-unconfirmed": return Strings.t("autoResume.reason.targetCompletionUnknown")
        case "execution-target-relay-verifying", "execution-target-native-writer-required", "execution-target-relay-unavailable", "execution-target-native-route-unverified", "execution-target-lease-unavailable": return Strings.t("autoResume.reason.targetRoute")
        case "execution-target-policy-changed", "execution-target-identity-changed", "execution-target-native-owner-changed", "local-repair-parent-changed", "local-repair-target-changed", "execution-target-local-recovery-changed", "execution-target-local-recovery-generation-changed": return Strings.t("autoResume.reason.targetChanged")
        case "execution-target-quota-period-changed", "execution-target-expired", "execution-target-quota-unavailable", "execution-target-unavailable", "local-repair-target-unavailable": return Strings.t("autoResume.reason.targetQuota")
        case "execution-target-lease-busy": return Strings.t("autoResume.reason.targetBusy")
        case "execution-target-lease-conflict", "execution-target-lease-invalid", "execution-target-message-mismatch", "execution-target-message-order-unverified", "execution-target-turn-unverified", "execution-target-response-unverified", "execution-target-relay-ack-unverified", "execution-target-unverified", "local-repair-unverified", "local-repair-evidence-changed", "execution-target-local-recovery-unverified", "execution-target-local-recovery-conflict", "execution-target-local-recovery-consumed": return Strings.t("autoResume.reason.targetProof")
        case "local-repair-goal-changed": return Strings.t("autoResume.reason.goal")
        case "execution-target-authorization-expired", "execution-target-authorization-changed": return Strings.t("autoResume.reason.targetAuthorization")
        case "reserve-reached": key = "reserve"
        case "usage-budget-ended", "turn-budget-ended", "time-budget-ended": key = "budget"
        case "expired": key = "expired"
        case "activity-paused": key = "schedule"
        case "notification-only": key = "notifyOnly"
        case "forecast-unavailable", "forecast-unavailable-notify": key = "forecastUnknown"
        case "awaiting-planned-start", "forecast-personal-deadline-required": key = "plannedStart"
        case "awaiting-forecast-probability": key = "forecastProbability"
        case "work-invalid-planning", "work-invalid-probability", "work-personal-deadline-required": key = "settings"
        case "awaiting-announcement": key = "announcement"
        case "awaiting-reset-window": key = "resetWindow"
        case "needs-user-input": key = "input"
        case "work-needs-review", "uncertain", "execution-record-unavailable": key = "review"
        case "work-forecast-bucket-required": key = "forecastBucket"
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
    var purpose: String? = nil
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
    var activityMode: String?
    var expectedWorkMinutes: Double?
    var finishBufferMinutes: Double?
    var earlyResetQuantile: Double?
    var startProbability: Double?
    var unknownForecastAction: String?
    var personalDeadline: Double?
    var usePersonalDeadlineForPlanning: Bool?
    var opportunityMaxAgeMinutes: Double?
    var timingHistoryDays: Double?
    var workDeadline: Double?
    var onReset: String
    var revision: Int?
    var state: AutomaticWorkState?
    var preferenceSources: [String: String]?
    var localPreferenceSnapshot: String?
    var performance: AutomaticWorkPerformance?
    var admission: AutomaticWorkAdmission?
    var hostGoal: AutomaticWorkHostGoal?

    var goalSessionKey: String { provider + "/" + account + "/" + nativeSessionId }
    var isUserEditable: Bool { purpose == nil }

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
        if let activityMode { value["activityMode"] = activityMode }
        if let expectedWorkMinutes { value["expectedWorkMinutes"] = expectedWorkMinutes }
        if let finishBufferMinutes { value["finishBufferMinutes"] = finishBufferMinutes }
        if let earlyResetQuantile { value["earlyResetQuantile"] = earlyResetQuantile }
        if let startProbability { value["startProbability"] = startProbability }
        if let unknownForecastAction { value["unknownForecastAction"] = unknownForecastAction }
        if let personalDeadline { value["personalDeadline"] = personalDeadline }
        if let usePersonalDeadlineForPlanning { value["usePersonalDeadlineForPlanning"] = usePersonalDeadlineForPlanning }
        if let opportunityMaxAgeMinutes { value["opportunityMaxAgeMinutes"] = opportunityMaxAgeMinutes }
        if let timingHistoryDays { value["timingHistoryDays"] = timingHistoryDays }
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
    let lastActiveAtMs: Double?
    var id: String { nativeSessionId }

    func selectionTitle(at now: Date = Date()) -> String {
        // Codex UUIDs can share a timestamp prefix. The suffix distinguishes
        // conversations created close together in the same project.
        let reference = "…" + String(nativeSessionId.suffix(8))
        guard let lastActiveAtMs, lastActiveAtMs.isFinite, lastActiveAtMs > 0,
              lastActiveAtMs <= now.timeIntervalSince1970 * 1_000 else { return title + " · " + reference }
        return title + " · " + DisplayFormat.age(since: Date(timeIntervalSince1970: lastActiveAtMs / 1_000), now: now) + " · " + reference
    }
}
struct AutomaticWorkExecution: Decodable, Identifiable {
    let id: String
    let policyId: String
    let owner: String
    let turnOrdinal: Int
    let claimedAtMs: Double
    let status: String
    let result: AutomaticWorkResult?
    var executionTarget: AutomaticWorkExecutionTarget? = nil
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

/// A read-only host observation. It is independent of the runner's turn/result
/// state and is never serialized as executable policy authority.
struct AutomaticWorkHostGoal: Decodable {
    let readState: String
    let objective: String?
    let hostStatus: String?
    let observedAtMs: Double?
    let expiresAtMs: Double?

    func displayReadState(at nowMs: Double, transportUnavailable: Bool) -> String {
        if readState == "account_changed" { return "account_changed" }
        if transportUnavailable { return "stale" }
        if let expiresAtMs, expiresAtMs <= nowMs { return "stale" }
        guard ["loading", "ready", "no_goal", "unsupported", "error", "stale"].contains(readState) else { return "unknown" }
        if readState == "ready" {
            guard let observedAtMs, observedAtMs > 0, observedAtMs <= nowMs,
                  let expiresAtMs, expiresAtMs > observedAtMs else { return "stale" }
            guard let objective, !objective.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                  let hostStatus, Self.hostStates.contains(hostStatus) else { return "unknown" }
        }
        return readState
    }

    func visibleObjective(at nowMs: Double, transportUnavailable: Bool) -> String? {
        guard ["ready", "error", "stale"].contains(readState),
              ["ready", "error", "stale"].contains(displayReadState(at: nowMs, transportUnavailable: transportUnavailable)) else { return nil }
        return objective
    }

    func canUseObjective(at nowMs: Double, transportUnavailable: Bool) -> Bool {
        displayReadState(at: nowMs, transportUnavailable: transportUnavailable) == "ready"
    }

    var hostStatusTitle: String {
        guard let hostStatus, Self.hostStates.contains(hostStatus) else { return Strings.t("goals.host.unknown") }
        return Strings.t("goals.host." + hostStatus)
    }

    private static let hostStates = ["active", "paused", "blocked", "usageLimited", "budgetLimited", "complete"]
}

struct AutomaticWorkHostGoalResponse: Decodable { let hostGoal: AutomaticWorkHostGoal? }

struct AutomaticWorkPreferenceValues: Decodable {
    var budgetByBucket: [String: AutomaticWorkBudget]?
    var maxTurns: Int?
    var maxDurationSeconds: Double?
    var maxTotalDurationSeconds: Double?
    var priority: Double?
    var activityMode: String?
    var activitySchedule: AutomaticWorkSchedule?
    var expectedWorkMinutes: Double?
    var finishBufferMinutes: Double?
    var earlyResetQuantile: Double?
    var startProbability: Double?
    var unknownForecastAction: String?
    var personalDeadline: Double?
    var usePersonalDeadlineForPlanning: Bool?
    var opportunityMaxAgeMinutes: Double?
    var timingHistoryDays: Double?
}
struct AutomaticWorkPreferences: Decodable {
    let scope: String
    let provider: String?
    let account: String?
    let revision: Int
    let values: AutomaticWorkPreferenceValues
}
struct AutomaticWorkPreferencesResponse: Decodable { let preferences: [AutomaticWorkPreferences] }
struct AutomaticWorkPreferenceSaveResponse: Decodable { let preference: AutomaticWorkPreferences }
extension AutomaticWorkPolicy {
    var registrationInput: [String: Any] {
        var result = input
        if revision == nil, let snapshot = localPreferenceSnapshot?.data(using: .utf8),
           let inherited = (try? JSONSerialization.jsonObject(with: snapshot)) as? [String: Any] {
            for (key, value) in inherited {
                if let current = result[key], NSDictionary(dictionary: [key: current]).isEqual(to: [key: value]) { result.removeValue(forKey: key) }
            }
        }
        return result
    }
    var preferenceInput: [String: Any] {
        let allowed: Set<String> = ["budgetByBucket", "maxTurns", "maxDurationSeconds", "maxTotalDurationSeconds", "priority", "activityMode", "activitySchedule", "expectedWorkMinutes", "finishBufferMinutes", "earlyResetQuantile", "startProbability", "unknownForecastAction", "personalDeadline", "usePersonalDeadlineForPlanning", "opportunityMaxAgeMinutes", "timingHistoryDays"]
        return input.filter { allowed.contains($0.key) }
    }
    mutating func applyPreferences(_ preferences: [AutomaticWorkPreferences]) {
        localPreferenceSnapshot = nil
        var appliedKeys = Set<String>()
        let order = ["global": 0, "provider": 1, "account": 2]
        for preference in preferences.filter({ $0.scope == "global" || $0.provider == provider && ($0.scope == "provider" || $0.account == account) }).sorted(by: { (order[$0.scope] ?? 0) < (order[$1.scope] ?? 0) }) {
            let values = preference.values
            if let value = values.budgetByBucket { for (bucket, budget) in value where budgetByBucket[bucket] != nil { budgetByBucket[bucket] = budget } }
            if let value = values.maxTurns { maxTurns = value; appliedKeys.insert("maxTurns") }
            if let value = values.maxDurationSeconds { maxDurationSeconds = value; appliedKeys.insert("maxDurationSeconds") }
            if let value = values.maxTotalDurationSeconds { maxTotalDurationSeconds = value; appliedKeys.insert("maxTotalDurationSeconds") }
            if let value = values.priority { priority = value; appliedKeys.insert("priority") }
            if let value = values.activityMode { activityMode = value; appliedKeys.insert("activityMode") }
            if let value = values.activitySchedule { activitySchedule = value; appliedKeys.insert("activitySchedule") }
            if let value = values.expectedWorkMinutes { expectedWorkMinutes = value; appliedKeys.insert("expectedWorkMinutes") }
            if let value = values.finishBufferMinutes { finishBufferMinutes = value; appliedKeys.insert("finishBufferMinutes") }
            if let value = values.earlyResetQuantile { earlyResetQuantile = value; appliedKeys.insert("earlyResetQuantile") }
            if let value = values.startProbability { startProbability = value; appliedKeys.insert("startProbability") }
            if let value = values.unknownForecastAction { unknownForecastAction = value; appliedKeys.insert("unknownForecastAction") }
            if let value = values.personalDeadline { personalDeadline = value; appliedKeys.insert("personalDeadline") }
            if let value = values.usePersonalDeadlineForPlanning { usePersonalDeadlineForPlanning = value; appliedKeys.insert("usePersonalDeadlineForPlanning") }
            if let value = values.opportunityMaxAgeMinutes { opportunityMaxAgeMinutes = value; appliedKeys.insert("opportunityMaxAgeMinutes") }
            if let value = values.timingHistoryDays { timingHistoryDays = value; appliedKeys.insert("timingHistoryDays") }
        }
        if let data = try? JSONSerialization.data(withJSONObject: input.filter { appliedKeys.contains($0.key) }, options: .sortedKeys) {
            localPreferenceSnapshot = String(data: data, encoding: .utf8)
        }
    }
}
