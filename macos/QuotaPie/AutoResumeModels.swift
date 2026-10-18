import Foundation

struct AutoResumePayload: Decodable {
    let accounts: [AutoResumeAccount]
    let incidents: [AutoResumeIncident]
}

struct AutoResumeResponse: Decodable { let autoResume: AutoResumePayload }

struct AutoResumeAccount: Decodable, Identifiable {
    let account: String
    let label: String
    let enabled: Bool
    let enabledAtMs: Double?
    let lastScanAtMs: Double?
    let lastError: String?
    var id: String { account }
    var scanErrorText: String? {
        guard let lastError, !lastError.isEmpty else { return nil }
        return Strings.t(lastError == "account-binding-changed" ? "autoResume.reason.accountChanged" : "autoResume.scanError")
    }
}

struct AutoResumeIncident: Decodable, Identifiable {
    let id: String
    let account: String
    let threadId: String
    let projectLabel: String
    let state: String
    let reason: String?
    let detectedAtMs: Double
    let policyId: String?

    var canSkip: Bool { state == "waiting" }
    var stateTitle: String {
        let known = ["waiting", "queued", "running", "resumed", "skipped", "needs-review"]
        return Strings.t("autoResume.state." + (known.contains(state) ? state : "unknown"))
    }
    var reasonText: String? {
        guard let reason, !reason.isEmpty else { return nil }
        if reason == "ready" { return nil }
        let key: String
        switch reason {
        case "auto-resume-disabled": key = "disabled"
        case "account-binding-changed": key = "accountChanged"
        case "superseded": key = "superseded"
        case "quota-recovery-unconfirmed", "subscription-quota-blocked", "reserve-reached", "quota-stale", "quota-unknown", "reset-unconfirmed": key = "quota"
        case "host-goal-not-active", "host-goal-stale", "host-goal-unavailable": key = "goal"
        case "native-writer-present", "native-turn-active": key = "busy"
        case "host-queue-awaiting-turn": key = "queued"
        case "host-queue-busy": key = "queueBusy"
        case "host-queue-unsupported": key = "queueUnsupported"
        case "work-turn-limit": key = "limit"
        default: key = "review"
        }
        return Strings.t("autoResume.reason." + key)
    }
}
