import Foundation

struct StatusPayload: Decodable {
    let nowMs: Double?
    let headline: Headline?
    let accounts: [AccountState]
    let events: [QuotaEvent]
    /// A short-lived capability issued by the local service. It is deliberately
    /// kept in memory and is required for every resume-task mutation.
    let actionToken: String?
    let resumeTasks: [ResumeTask]
    let jobs: [ManagedJobSummary]
    let resetSignals: ResetSignalPayload?
    let resetTracking: ResetTracking?
    let compaction: CompactionPayload?
    var accountPool: AccountPoolPayload? = nil
    var notificationPreferences: NotificationPreferences?

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        nowMs = try values.decodeIfPresent(Double.self, forKey: .nowMs)
        headline = try values.decodeIfPresent(Headline.self, forKey: .headline)
        accounts = try values.decodeIfPresent([AccountState].self, forKey: .accounts) ?? []
        events = try values.decodeIfPresent([QuotaEvent].self, forKey: .events) ?? []
        actionToken = try values.decodeIfPresent(String.self, forKey: .actionToken)
        resumeTasks = try values.decodeIfPresent([ResumeTask].self, forKey: .resumeTasks) ?? []
        jobs = try values.decodeIfPresent([ManagedJobSummary].self, forKey: .jobs) ?? []
        resetSignals = try values.decodeIfPresent(ResetSignalPayload.self, forKey: .resetSignals)
        resetTracking = try values.decodeIfPresent(ResetTracking.self, forKey: .resetTracking)
        compaction = try values.decodeIfPresent(CompactionPayload.self, forKey: .compaction)
        accountPool = try values.decodeIfPresent(AccountPoolPayload.self, forKey: .accountPool)
        notificationPreferences = try values.decodeIfPresent(NotificationPreferences.self, forKey: .notificationPreferences)
    }

    private enum CodingKeys: String, CodingKey {
        case nowMs, headline, accounts, events, actionToken, resumeTasks, jobs, resetSignals, resetTracking, compaction, notificationPreferences, accountPool
    }
}

struct AccountPoolPayload: Decodable {
    let enabled: Bool
    let accounts: [String]
    let recent: [RoutedAccountRequest]
    var error: String? = nil
}

struct RoutedAccountRequest: Decodable {
    let sourceAccount: String
    let account: String
    let accountLabel: String
    let state: String
    let status: Int
    let atMs: Double
}

/// Public execution metadata only. Registration and approval stay in the CLI;
/// prompts, step results and native session references are not part of this type.
struct ManagedJobSummary: Decodable, Identifiable {
    struct Policy: Decodable {
        let mode: String
    }

    let id: String
    let label: String
    let provider: String
    let account: String
    let state: String
    let completedSteps: Int
    let totalSteps: Int
    let reason: String?
    let policy: Policy

    var providerTitle: String {
        switch provider {
        case "codex": return "Codex"
        case "claude": return "Claude"
        default: return Strings.t("jobs.unknown")
        }
    }

    var stateTitle: String {
        switch state {
        case "waiting", "ready", "running", "review", "succeeded", "failed", "cancelled":
            return Strings.t("jobs.state.\(state)")
        default:
            return Strings.t("jobs.unknown")
        }
    }

    var policyTitle: String {
        switch policy.mode {
        case "manual", "auto": return Strings.t("jobs.policy.\(policy.mode)")
        default: return Strings.t("jobs.unknown")
        }
    }

    var progressTitle: String {
        Strings.t("jobs.progress", String(completedSteps), String(totalSteps))
    }

    var reasonTitle: String? {
        guard let reason, !reason.isEmpty else { return nil }
        switch reason {
        case "quota-collection-wait": return Strings.t("jobs.reason.collection")
        case "quota-wait", "quota-exhausted": return Strings.t("jobs.reason.quota")
        case "quota-retry-review", "review-retry-requested": return Strings.t("jobs.reason.retry")
        case "execution-uncertain", "lease-expired": return Strings.t("jobs.reason.uncertain")
        case "policy-expired": return Strings.t("jobs.reason.expired")
        case "attempts-exhausted": return Strings.t("jobs.reason.attempts")
        case "cli-update-required": return Strings.t("jobs.reason.cliUpdate")
        case "auth-required": return Strings.t("jobs.reason.auth")
        case "provider-access-denied": return Strings.t("jobs.reason.access")
        case "result-limit": return Strings.t("jobs.reason.resultLimit")
        case "profile-changed": return Strings.t("jobs.reason.profile")
        case "workspace-unavailable": return Strings.t("jobs.reason.workspace")
        case "account-or-workspace-unavailable": return Strings.t("jobs.reason.accountWorkspace")
        case "dispatch-precondition-changed": return Strings.t("jobs.reason.precondition")
        case "quota-scope-unconfirmed", "quota-unavailable": return Strings.t("jobs.reason.scope")
        case "execution-failed", "legacy-step-failed": return Strings.t("jobs.reason.failed")
        case "account-binding-changed": return Strings.t("jobs.reason.accountChanged")
        case "user-cancelled": return Strings.t("jobs.reason.cancelled")
        default: return Strings.t("jobs.reason.unknown")
        }
    }
}

/// Work that QuotaPie observed pausing at a provider limit. The service owns
/// the state machine; the app only offers explicit, user-approved actions.
struct ResumeTask: Decodable, Identifiable {
    let id: String
    let provider: String
    let account: String
    let accountLabel: String
    let projectLabel: String
    let state: String
    let registeredAtMs: Double
    let expectedResetAtMs: Double?
    let readyAtMs: Double?
    let errorDetail: String?

    var providerTitle: String {
        provider == "codex" ? "Codex" : provider == "claude" ? "Claude" : provider
    }

    var accountTitle: String {
        accountLabel == account ? accountLabel : "\(accountLabel) [\(account)]"
    }

    var shortReference: String { "#\(id.prefix(8))" }

    var pausedReference: String {
        Strings.t("resume.pausedReference", DisplayFormat.clock(registeredAtMs), shortReference)
    }

    var isWaiting: Bool { state == "waiting" }
    var isReady: Bool { state == "ready" }
    var isApproved: Bool { state == "approved" }
    var isActive: Bool { isWaiting || isReady || isApproved }
}

/// The only executable material accepted from the service. No shell command or
/// prompt field exists in this wire type by design.
struct ResumePlan: Decodable {
    let executable: String
    let arguments: [String]
    let environment: [String: String]
    let workingDirectory: String
}

struct ResumeApprovalResponse: Decodable {
    let task: ResumeTask
    let plan: ResumePlan
}

/// JSON-safe values carried beside a localisation key. The daemon never sends
/// prose as meaning here: numbers and identifiers stay data until this app
/// renders them in the viewer's language.
enum MessageParameter: Decodable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case null

    init(from decoder: Decoder) throws {
        let value = try decoder.singleValueContainer()
        if value.decodeNil() { self = .null }
        else if let decoded = try? value.decode(Bool.self) { self = .bool(decoded) }
        else if let decoded = try? value.decode(Double.self) { self = .number(decoded) }
        else if let decoded = try? value.decode(String.self) { self = .string(decoded) }
        else {
            throw DecodingError.typeMismatch(
                MessageParameter.self,
                .init(codingPath: decoder.codingPath, debugDescription: "Expected a JSON scalar")
            )
        }
    }

    var text: String? {
        switch self {
        case .string(let value): return value
        case .number(let value):
            return value.rounded() == value ? String(Int(value)) : String(value)
        case .bool(let value): return String(value)
        case .null: return nil
        }
    }

    var number: Double? {
        if case .number(let value) = self { return value }
        return nil
    }
}

struct LocalizedMessagePayload: Decodable {
    let key: String
    let params: [String: MessageParameter]

    func rendered(fallback: String) -> String {
        guard let arguments else { return fallback }
        let result = Strings.format(key, arguments: arguments)
        return result == key ? fallback : result
    }

    private var arguments: [CVarArg]? {
        func text(_ name: String) -> String? { params[name]?.text }
        func required(_ names: String...) -> [CVarArg]? {
            let values = names.compactMap(text)
            return values.count == names.count ? values.map { $0 as CVarArg } : nil
        }

        switch key {
        case "model.notice.compaction", "model.notice.savings", "model.notice.original", "model.notice.unknown":
            return []
        case "model.notice.request":
            return required("fromLabel", "toLabel")
        case "model.notice.confirmed":
            return required("toLabel", "label")
        case "model.notice.completed":
            guard let to = text("toLabel"), let detail = text("detail"), let label = text("label") else { return nil }
            return [to, detail, label == "?" ? Strings.t("model.notice.unknown") : label]
        case "model.notice.failed":
            return required("toLabel", "detail")
        case "signal.possible", "signal.announced", "signal.reported", "signal.updated", "signal.withdrawn":
            return []
        case "signal.message.relay", "signal.message.direct":
            return required("source", "detail", "url")
        case "alert.remaining.title", "alert.stale.title",
             "alert.rapid.title",
             "alert.event.title.payment",
             "alert.event.title.resync", "alert.pace.title.measured",
             "alert.pace.title.projected", "alert.resume.ready.title":
            return required("provider", "account")
        case "alert.remaining.message":
            return required("label", "percent", "threshold")
        case "alert.rapid.message":
            return required("label", "minutes", "drop", "percent")
        case "alert.stale.message", "alert.resume.ready.message":
            return required("label")
        case "alert.jobs.title":
            return required("label")
        case "alert.jobs.ready.message", "alert.jobs.succeeded.message",
             "alert.jobs.failed.message", "alert.jobs.review.message":
            return []
        case "alert.pace.message.measured", "alert.pace.message.projected":
            guard let label = text("label") else { return nil }
            let gap = params["minutes"]?.number.map {
                DisplayFormat.interval(milliseconds: $0 * 60_000)
            } ?? text("detail")
            guard let gap else { return nil }
            return [label, gap]
        case "alert.event.title.window", "alert.event.title.account", "alert.event.title.plan":
            return required("account")
        case "alert.test.title", "alert.test.message", "event.banked_reset_consumed", "event.account_changed":
            return []
        case "event.paid_usage", "event.credit_topup":
            return required("provider")
        case "event.window_changed":
            return required("fromLabel", "toLabel")
        case "event.plan_changed":
            return required("fromPlan", "toPlan")
        case "event.first_observation", "event.out_of_order", "event.source_changed",
             "event.source_unknown", "event.scheduled_reset", "event.external_relief",
             "event.allowance_relief", "event.meter_correction", "event.schedule_rebased",
             "event.bucket_retired":
            return required("label")
        default:
            return nil
        }
    }
}

struct NotificationPresentationPayload: Decodable {
    let title: LocalizedMessagePayload
    let message: LocalizedMessagePayload
}

/// A durable alert claimed from the local QuotaPie service. The claim token is
/// an opaque, short-lived capability and must only be sent back to the matching
/// completion or release endpoint.
struct ClaimedNotification: Decodable, Identifiable {
    let id: String
    let title: String
    let message: String
    let presentation: NotificationPresentationPayload?
    let severity: String
    let createdAtMs: Double
    let expiresAtMs: Double
    let claimToken: String

    var requestIdentifier: String {
        "local.quotapie.notification.\(id.lowercased())"
    }

    var localizedTitle: String {
        presentation?.title.rendered(fallback: title) ?? title
    }

    var localizedMessage: String {
        presentation?.message.rendered(fallback: message) ?? message
    }
}

struct NotificationClaimResponse: Decodable {
    let notification: ClaimedNotification?
}

enum NotificationCompletionDisposition: String {
    case scheduled
    case suppressed
    case expired
}

/// Menu bar reading for the selected account, with a backend fallback before selection.
struct Headline: Decodable {
    let kind: String
    let provider: String?
    let account: String?
    let accountLabel: String?
    let bucket: String?
    let windowKind: String?
    let windowLabel: String?
    let remainingPercent: Double?
    let exhaustsAtMs: Double?
    let errorCategory: String?
    /// The backend's own rendering, kept as a fallback for anything this app
    /// has no localisation for. Prefer building the sentence from the fields
    /// above so the app follows the viewer's language, not the daemon's.
    let displayText: String
    let displayDetail: String?

    init(account: AccountState) {
        let window = account.overviewWindow
        kind = window?.freshness == "fresh" && account.collection.isHealthy && window?.remainingPercent != nil
            ? "normal" : "degraded"
        provider = account.provider
        self.account = account.account
        accountLabel = account.accountLabel
        bucket = window?.bucket
        windowKind = nil
        windowLabel = window?.shortLabel
        remainingPercent = window?.remainingPercent
        exhaustsAtMs = window?.exhaustsAtMs
        errorCategory = account.collection.errorCategory ?? (window == nil ? "never-attempted" : "stale-success")
        displayText = ""
        displayDetail = nil
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        kind = try values.decode(String.self, forKey: .kind)
        provider = try values.decodeIfPresent(String.self, forKey: .provider)
        account = try values.decodeIfPresent(String.self, forKey: .account)
        accountLabel = try values.decodeIfPresent(String.self, forKey: .accountLabel)
        bucket = try values.decodeIfPresent(String.self, forKey: .bucket)
        windowKind = try values.decodeIfPresent(String.self, forKey: .windowKind)
        windowLabel = try values.decodeIfPresent(String.self, forKey: .windowLabel)
        remainingPercent = try values.decodeIfPresent(Double.self, forKey: .remainingPercent)
        exhaustsAtMs = try values.decodeIfPresent(Double.self, forKey: .exhaustsAtMs)
        errorCategory = try values.decodeIfPresent(String.self, forKey: .errorCategory)
        // The fallback to the old names lives only here, at the decoding
        // boundary, so it cannot spread back into the app: an older daemon
        // sends title/detail, a current one sends displayText/displayDetail.
        displayText = try values.decodeIfPresent(String.self, forKey: .displayText)
            ?? values.decodeIfPresent(String.self, forKey: .title)
            ?? ""
        displayDetail = try values.decodeIfPresent(String.self, forKey: .displayDetail)
            ?? values.decodeIfPresent(String.self, forKey: .detail)
    }

    private enum CodingKeys: String, CodingKey {
        case kind, provider, account, accountLabel, bucket, windowKind, windowLabel
        case remainingPercent, exhaustsAtMs, errorCategory
        case displayText, displayDetail, title, detail
    }

    /// The conclusion, said in the viewer's language.
    var localizedTitle: String {
        switch kind {
        case "pace-risk", "normal":
            guard let remainingPercent else { return displayText }
            let providerName = provider == "codex" ? "Codex" : provider == "claude" ? "Claude" : provider ?? ""
            let name = windowKind.flatMap(Self.windowName) ?? windowLabel ?? ""
            return Strings.t("headline.remaining", providerName, name, String(Int(remainingPercent.rounded())))
        case "degraded": return cachedTitle
        case "setup": return Strings.t("headline.setup")
        default: return displayText
        }
    }

    var cachedTitle: String {
        cachedTitle(reason: nil)
    }

    func cachedTitle(reason: String?) -> String {
        guard let remainingPercent, remainingPercent.isFinite else { return reason ?? Strings.t("headline.degraded") }
        let providerName = provider == "codex" ? "Codex" : provider == "claude" ? "Claude" : provider ?? ""
        let name = windowKind.flatMap(Self.windowName) ?? windowLabel ?? ""
        if let reason {
            return Strings.t("headline.cachedReason", providerName, name, String(Int(remainingPercent.rounded())), reason)
        }
        return Strings.t("headline.cached", providerName, name, String(Int(remainingPercent.rounded())))
    }

    /// The supporting line, also said in the viewer's language. Falling back to
    /// the backend's `detail` here is what left a Korean title sitting above an
    /// English sentence.
    var localizedDetail: String? {
        guard let provider else { return displayDetail }
        let providerName = provider == "codex" ? "Codex" : provider == "claude" ? "Claude" : provider
        var parts = [providerName]
        if let accountLabel { parts.append(accountLabel) }
        switch kind {
        case "pace-risk", "normal":
            if let windowKind, let name = Self.windowName(windowKind) { parts.append(name) }
            else if let windowLabel { parts.append(windowLabel) }
        case "degraded", "setup":
            parts.append(Strings.t("collection.\(errorCategory ?? (kind == "degraded" ? "stale-success" : "never-attempted"))"))
        default:
            return displayDetail
        }
        return parts.joined(separator: " · ")
    }

    static func windowName(_ kind: String) -> String? {
        switch kind {
        case "five-hour", "weekly", "monthly": return Strings.t("window.\(kind)")
        default: return nil
        }
    }
}

struct AccountState: Decodable, Identifiable {
    let provider: String
    let account: String
    let accountLabel: String
    let enabled: Bool
    let collection: CollectionState
    let windows: [QuotaWindow]
    let bottleneckBucket: String?
    let updatedAtMs: Double?

    var id: String { "\(provider)/\(account)" }
    var providerTitle: String { provider == "codex" ? "Codex" : provider == "claude" ? "Claude" : provider }
}

struct CollectionState: Decodable {
    let health: String
    let activeSource: String?
    let lastSuccessAtMs: Double?
    let errorCategory: String?
    let errorDetail: String?

    var isHealthy: Bool { health == "recent-success" }

    /// Phrased as something the user can act on. The raw provider error is kept
    /// as supporting detail only.
    var actionText: String {
        Strings.t("collection.\(errorCategory ?? health)")
    }

    /// A concrete recovery command is offered only when a login is what is missing.
    var recoveryCommand: String? {
        (errorCategory == "auth-required" || errorCategory == "auth-expired") ? "claude auth login" : nil
    }

    var sourceLabel: String {
        switch activeSource {
        case "claude-oauth", "codex-appserver": return Strings.t("source.official")
        case "claude-statusline": return Strings.t("source.statusline")
        default: return activeSource ?? "—"
        }
    }
}

struct QuotaWindow: Decodable, Identifiable {
    let provider: String
    let account: String
    let bucket: String
    let label: String
    let windowSeconds: Double?
    let freshness: String
    let observedAtMs: Double
    let usedPercent: Double?
    let remainingPercent: Double?
    let resetsAtMs: Double?
    let reservePercent: Double?
    let paceRatio: Double?
    let exhaustsAtMs: Double?
    let minutesBeforeReset: Double?
    let confidence: String?
    let riskLevel: String?
    let recentBurnPerHour: Double?
    let rapidDropPercent: Double?
    let rapidIntervalMinutes: Double?

    var id: String { "\(provider)/\(account)/\(bucket)" }
    var isAtRisk: Bool { riskLevel == "at-risk" }
    var isWatch: Bool { riskLevel == "watch" }
    var isExhausted: Bool { (remainingPercent ?? 1) <= 0 }
    var isLowRemaining: Bool { QuotaPresentation.isLow(remainingPercent) }

    var shortLabel: String {
        guard let windowSeconds else { return label }
        if bucket.hasPrefix("codex_bengalfox:") {
            return "Spark · " + Strings.t(windowSeconds <= 6 * 3_600 ? "window.five-hour" : "window.weekly")
        }
        if windowSeconds >= 28 * 86_400 && windowSeconds <= 31 * 86_400 { return Strings.t("window.monthly") }
        if windowSeconds == 7 * 86_400 {
            if bucket.hasPrefix("seven_day_") {
                let suffix = bucket.dropFirst("seven_day_".count)
                let qualifier = suffix
                    .split(separator: "_")
                    .map { $0.prefix(1).uppercased() + $0.dropFirst() }
                    .joined(separator: " ")
                if !qualifier.isEmpty { return qualifier }
            }
            return Strings.t("window.weekly")
        }
        if windowSeconds == 5 * 3_600 { return Strings.t("window.five-hour") }
        return label
    }

    /// Show measured consumption and mark extrapolation explicitly.
    var paceText: String? {
        guard freshness == "fresh" else { return nil }
        if isExhausted { return Strings.t("window.exhausted") }
        if let drop = rapidDropPercent, let minutes = rapidIntervalMinutes, minutes > 0, drop > 0 {
            return Strings.t("window.recentUsage", String(Int(max(1, ceil(minutes)))), String(format: "%.1f", drop))
        }
        if let rate = recentBurnPerHour, rate > 0 {
            return Strings.t("window.measuredRate", String(format: "%.1f", rate))
        }
        return nil
    }
}

struct QuotaEvent: Decodable {
    let provider: String
    let account: String
    let kind: String
    let severity: String
    let occurredAtMs: Double
    let displayText: String
    let details: [String: MessageParameter]

    var localizedText: String {
        var params = details
        params["provider"] = .string(provider)
        params["account"] = .string(account)
        return LocalizedMessagePayload(key: "event.\(kind)", params: params)
            .rendered(fallback: displayText)
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        provider = try values.decode(String.self, forKey: .provider)
        account = try values.decode(String.self, forKey: .account)
        kind = try values.decode(String.self, forKey: .kind)
        severity = try values.decode(String.self, forKey: .severity)
        occurredAtMs = try values.decode(Double.self, forKey: .occurredAtMs)
        // Old-daemon fallback, decoding boundary only.
        displayText = try values.decodeIfPresent(String.self, forKey: .displayText)
            ?? values.decodeIfPresent(String.self, forKey: .summary)
            ?? ""
        details = try values.decodeIfPresent([String: MessageParameter].self, forKey: .details) ?? [:]
    }

    private enum CodingKeys: String, CodingKey {
        case provider, account, kind, severity, occurredAtMs, displayText, summary, details
    }
}

enum DisplayFormat {
    static func duration(until timestampMs: Double?, now: Date = Date()) -> String {
        guard let timestampMs else { return Strings.t("window.resetUnknown") }
        return interval(milliseconds: max(0, timestampMs - now.timeIntervalSince1970 * 1_000))
    }

    static func interval(milliseconds: Double) -> String {
        let seconds = max(0, milliseconds / 1_000)
        let totalMinutes = Int((seconds / 60).rounded())
        let days = totalMinutes / 1_440
        let hours = (totalMinutes % 1_440) / 60
        let minutes = totalMinutes % 60
        if days > 0 { return Strings.t("time.days", String(days), String(hours)) }
        if hours > 0 { return Strings.t("time.hours", String(hours), String(minutes)) }
        return Strings.t("time.minutes", String(minutes))
    }

    static func clock(_ timestampMs: Double?) -> String {
        guard let timestampMs else { return "—" }
        return clockFormatter.string(from: Date(timeIntervalSince1970: timestampMs / 1_000))
    }

    /// Today shows the time alone; anything later shows the date with it.
    static func resetStamp(_ timestampMs: Double?, now: Date = Date()) -> String {
        guard let timestampMs else { return Strings.t("window.resetUnknown") }
        let date = Date(timeIntervalSince1970: timestampMs / 1_000)
        let calendar = Calendar.current
        let clock = clockFormatter.string(from: date)
        if calendar.isDate(date, inSameDayAs: now) { return Strings.t("window.resetsAt", clock) }
        return Strings.t("window.resetsAt", "\(dayFormatter.string(from: date)) \(clock)")
    }

    static func day(_ timestampMs: Double) -> String {
        dayFormatter.string(from: Date(timeIntervalSince1970: timestampMs / 1_000))
    }

    static func age(since date: Date, now: Date = Date()) -> String {
        let seconds = max(0, now.timeIntervalSince(date))
        if seconds < 60 { return Strings.t("time.justNow") }
        if seconds < 3_600 { return Strings.t("time.minutesAgo", String(Int(seconds / 60))) }
        return Strings.t("time.hoursAgo", String(Int(seconds / 3_600)))
    }

    private static let clockFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: Strings.localeIdentifier())
        formatter.dateFormat = "HH:mm"
        return formatter
    }()

    private static let dayFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: Strings.localeIdentifier())
        formatter.dateFormat = Strings.t("format.dayMonth")
        return formatter
    }()
}

struct ResetSignalPayload: Decodable {
    let enabled: Bool
    let source: String
    let state: String
    let lastSuccessMs: Double?
    let error: String?
    let signals: [ResetSignal]
    var sources: [ResetSourceHealth]? = nil
    var coverage: String? = nil
    var coverageKey: String {
        source == "x-api" || coverage == "direct-and-relays" ? "signal.coverage.direct" : "signal.coverage.relays"
    }
}

struct ResetSourceHealth: Decodable, Identifiable {
    let id: String
    let state: String
    let coverage: String
    let lastAttemptMs: Double?
    let lastSuccessMs: Double?
    let latestPublishedAtMs: Double?
    let lastEvidenceMs: Double?
    let newEvidenceCount: Int?
    let error: String?
    let examinedPosts: Int?
    let latestPostAtMs: Double?
    var title: String { id == "public-feed" ? "Reset Beacon" : id == "codexreset" ? "Codex Reset Monitor" : "X API" }
}

struct CompactionPayload: Decodable {
    let checkedAtMs: Double
    let generations: Int
    let reachable: Int
    let active: [CompactionRecord]
    let recent: [CompactionRecord]
    let policy: CompactionPolicy?
    var savings: TaskSavingsPayload? = nil
    var latest: CompactionRecord? { active.first ?? recent.first }
}

struct CompactionPolicy: Decodable {
    let model: String
    let effort: String
    let models: [String]
    let configurable: Bool
    let generations: Int
    let applied: Int
}

struct CompactionPolicyResponse: Decodable { let policy: CompactionPolicy? }

struct CompactionFollowup: Decodable {
    let requestId: String
    let model: String
    let effort: String?
    let startedAtMs: Double
    var modelText: String { [CompactionRecord.shortModel(model), effort?.capitalized].compactMap { $0 }.joined(separator: " ") }
}

struct CompactionRecord: Decodable, Identifiable {
    let requestId: String
    let threadId: String?
    let from: String
    let to: String
    let requestedEffort: String?
    let reasoningEffort: String?
    let routed: Bool
    let phase: String
    let status: Int
    let at: String
    let startedAtMs: Double
    let elapsedMs: Double
    let active: Bool
    let errorCode: String?
    let finishedAtMs: Double?
    let followup: CompactionFollowup?
    var id: String { requestId }
    var phaseKey: String { "compaction." + (active ? "running" : phase) }
    var modelText: String { [Self.shortModel(to), reasoningEffort?.capitalized].compactMap { $0 }.joined(separator: " ") }
    var routeText: String {
        let original = [Self.shortModel(from), requestedEffort?.capitalized].compactMap { $0 }.joined(separator: " ")
        let compression = routed ? "\(original) → \(modelText)" : modelText
        return followup.map { compression + " → " + $0.modelText } ?? compression
    }
    func elapsed(at date: Date) -> String {
        let ms = active ? max(elapsedMs, date.timeIntervalSince1970 * 1000 - startedAtMs) : elapsedMs
        return String(format: "%.1f", ms / 1000) + Strings.t("compaction.seconds")
    }
    static func shortModel(_ value: String) -> String {
        switch value {
        case "gpt-6-astra": return "Astra"
        case "gpt-5.6-sol": return "Sol"
        case "gpt-5.6-luna": return "Luna"
        case "gpt-5.6-terra": return "Terra"
        default: return value
        }
    }
}

struct ResetSignal: Decodable, Identifiable {
    let id: String
    let fingerprint: String
    let author: String
    let sourceUrl: String
    let text: String
    let publishedAtMs: Double
    let state: String
    let resetKind: String
    let timeHint: String?
    let scopeHint: String?
    let observedVia: String
    let targetAtMs: Double?

    var safeSourceURL: URL? {
        guard let url = URL(string: sourceUrl), url.scheme == "https", url.host == "x.com",
              url.user == nil, url.password == nil, url.port == nil,
              url.path == "/\(author)/status/\(id)", id.allSatisfy({ $0.isNumber }), !id.isEmpty,
              ["thsottiaux", "reach_vb", "dkundel", "openaidevs", "openai"].contains(author.lowercased())
        else { return nil }
        return url
    }
}
