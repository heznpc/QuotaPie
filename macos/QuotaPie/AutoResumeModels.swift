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
    var quotaAccount: String? = nil
    var quotaAccountLabel: String? = nil
    var quotaTargetState: String? = nil
    var localRepairChildIncidentId: String? = nil
    var localRepairParentIncidentId: String? = nil
    var localRepairReason: String? = nil
    var repairReason: String? = nil

    private func repairFamily(in incidents: [AutoResumeIncident]) -> [AutoResumeIncident]? {
        func edge(_ parent: AutoResumeIncident, _ child: AutoResumeIncident) -> Bool {
            parent.id != child.id && parent.state == "needs-review" && parent.reason == "host-queue-turn-failed" &&
            parent.localRepairReason == "local-before-send-repair-linked" && child.repairReason == "local-before-send-repair" &&
            parent.localRepairChildIncidentId == child.id && child.localRepairParentIncidentId == parent.id &&
            parent.account == child.account && parent.threadId == child.threadId
        }
        var family = [self], seen: Set<String> = [id], current = self
        while let parentID = current.localRepairParentIncidentId {
            guard let parent = incidents.first(where: { $0.id == parentID }), edge(parent, current),
                  !seen.contains(parent.id), family.count < 3 else { return nil }
            family.insert(parent, at: 0); seen.insert(parent.id); current = parent
        }
        current = self
        while let childID = current.localRepairChildIncidentId {
            guard let child = incidents.first(where: { $0.id == childID }), edge(current, child),
                  !seen.contains(child.id), family.count < 3 else { return nil }
            family.append(child); seen.insert(child.id); current = child
        }
        return family
    }

    func linkedRepair(in incidents: [AutoResumeIncident]) -> AutoResumeIncident? {
        guard let family = repairFamily(in: incidents), let index = family.firstIndex(where: { $0.id == id }),
              index + 1 < family.count else { return nil }
        let child = family[index + 1]
        return ["waiting", "queued", "running", "resumed", "needs-review"].contains(family.last!.state) ? child : nil
    }

    func repairText(in incidents: [AutoResumeIncident]) -> String? {
        if linkedRepair(in: incidents) != nil { return Strings.t("autoResume.repair.parent") }
        if let parentID = localRepairParentIncidentId,
           incidents.contains(where: { $0.id == parentID && $0.linkedRepair(in: incidents)?.id == id }) {
            return Strings.t("autoResume.repair.child")
        }
        return nil
    }

    func displayedReason(in incidents: [AutoResumeIncident]) -> String? {
        linkedRepair(in: incidents) != nil ? Strings.t("autoResume.repair.localFailure") : reasonText
    }

    var quotaAccountText: String? {
        guard let quotaAccount, !quotaAccount.isEmpty else { return nil }
        let label = quotaAccountLabel?.isEmpty == false ? quotaAccountLabel! : quotaAccount
        let key: String
        switch quotaTargetState {
        case "candidate": key = "candidate"
        case "confirmed": key = "confirmed"
        case "used": key = "used"
        default: return nil
        }
        return Strings.t("autoResume.quotaTarget." + key, label)
    }

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
        case "host-goal-not-active", "host-goal-stale", "host-goal-unavailable", "local-repair-goal-changed": key = "goal"
        case "local-repair-parent-changed", "local-repair-target-changed", "execution-target-local-recovery-changed", "execution-target-local-recovery-generation-changed": key = "targetChanged"
        case "local-repair-target-unavailable": key = "targetQuota"
        case "local-repair-unverified", "local-repair-evidence-changed", "execution-target-local-recovery-unverified", "execution-target-local-recovery-conflict", "execution-target-local-recovery-consumed": key = "targetProof"
        case "native-writer-present", "native-turn-active": key = "busy"
        case "host-queue-awaiting-turn": key = "queued"
        case "host-queue-wake-sent": key = "wakeSent"
        case "host-queue-wake-unavailable": key = "wakeUnavailable"
        case "host-queue-busy": key = "queueBusy"
        case "host-queue-unsupported": key = "queueUnsupported"
        case "host-queue-turn-failed": key = "turnFailed"
        case "host-queue-turn-interrupted": key = "turnInterrupted"
        case "host-queue-quota-blocked": key = "turnQuotaBlocked"
        case "execution-target-provider-rejected": key = "targetProviderRejected"
        case "execution-target-provider-quota-blocked": key = "targetProviderQuota"
        case "execution-target-completion-unconfirmed": key = "targetCompletionUnknown"
        case "execution-target-relay-verifying", "execution-target-native-writer-required", "execution-target-relay-unavailable", "execution-target-native-route-unverified", "execution-target-lease-unavailable": key = "targetRoute"
        case "execution-target-policy-changed", "execution-target-identity-changed", "execution-target-native-owner-changed": key = "targetChanged"
        case "execution-target-quota-period-changed", "execution-target-expired", "execution-target-quota-unavailable", "execution-target-unavailable": key = "targetQuota"
        case "execution-target-lease-busy": key = "targetBusy"
        case "execution-target-lease-conflict", "execution-target-lease-invalid", "execution-target-message-mismatch", "execution-target-message-order-unverified", "execution-target-turn-unverified", "execution-target-response-unverified", "execution-target-relay-ack-unverified", "execution-target-unverified": key = "targetProof"
        case "execution-target-authorization-expired", "execution-target-authorization-changed": key = "targetAuthorization"
        case "work-turn-limit": key = "limit"
        default: key = "review"
        }
        return Strings.t("autoResume.reason." + key)
    }
}
