import Foundation

struct StatusPayload: Decodable {
    let nowMs: Double?
    let headline: Headline?
    let accounts: [AccountState]
    let events: [QuotaEvent]

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        nowMs = try values.decodeIfPresent(Double.self, forKey: .nowMs)
        headline = try values.decodeIfPresent(Headline.self, forKey: .headline)
        accounts = try values.decodeIfPresent([AccountState].self, forKey: .accounts) ?? []
        events = try values.decodeIfPresent([QuotaEvent].self, forKey: .events) ?? []
    }

    private enum CodingKeys: String, CodingKey { case nowMs, headline, accounts, events }
}

/// 메뉴 막대에 올릴 결론. 어떤 결론을 고를지는 서비스가 정하고 앱은 그리기만 한다.
struct Headline: Decodable {
    let kind: String
    let title: String
    let detail: String?
    let provider: String?
    let account: String?
    let bucket: String?
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

    /// 사용자가 취할 수 있는 행동으로 바꾼 문구. 원문 오류는 보조 설명으로만 쓴다.
    var actionText: String {
        switch errorCategory {
        case "auth-required": return "로그인이 필요합니다"
        case "auth-expired": return "로그인이 만료됐습니다"
        case "rate-limited": return "공급자 요청 한도에 걸렸습니다"
        case "network": return "네트워크에 연결할 수 없습니다"
        case "not-configured": return "수집이 설정되지 않았습니다"
        case "isolation-unsafe": return "계정 자격증명 격리가 필요합니다"
        case "no-windows": return "응답에 한도 창이 없습니다"
        case "provider-error": return "공급자 응답을 읽지 못했습니다"
        default:
            switch health {
            case "never-attempted": return "아직 수집을 시도하지 않았습니다"
            case "stale-success": return "한도 확인이 지연되고 있습니다"
            case "attempted-then-failed": return "수집에 실패했습니다"
            default: return "확인됨"
            }
        }
    }

    /// 로그인이 필요한 상태에서만 구체적인 복구 명령을 안내한다.
    var recoveryCommand: String? {
        (errorCategory == "auth-required" || errorCategory == "auth-expired") ? "claude auth login" : nil
    }

    var sourceLabel: String {
        switch activeSource {
        case "claude-oauth": return "공식"
        case "claude-statusline": return "상태줄"
        case "codex-appserver": return "공식"
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

    var id: String { "\(provider)/\(account)/\(bucket)" }
    var isAtRisk: Bool { riskLevel == "at-risk" }
    var isWatch: Bool { riskLevel == "watch" }
    var isExhausted: Bool { (remainingPercent ?? 1) <= 0 }

    var shortLabel: String {
        guard let windowSeconds else { return label }
        if windowSeconds >= 28 * 86_400 { return "월간" }
        if windowSeconds >= 7 * 86_400 {
            if bucket.hasPrefix("seven_day_") {
                let suffix = bucket.dropFirst("seven_day_".count)
                let qualifier = suffix
                    .split(separator: "_")
                    .map { $0.prefix(1).uppercased() + $0.dropFirst() }
                    .joined(separator: " ")
                if !qualifier.isEmpty { return "\(qualifier) 주간" }
            }
            return "주간"
        }
        if windowSeconds <= 6 * 3_600 { return "5시간" }
        return label
    }

    /// 속도에 대한 한 줄 판단. 측정된 소진이 없으면 위험을 주장하지 않는다.
    var paceText: String? {
        guard freshness == "fresh" else { return nil }
        if isExhausted { return "소진됨" }
        if isAtRisk, let exhaustsAtMs {
            return "⚠ \(DisplayFormat.day(exhaustsAtMs))경 소진 예상"
        }
        if let paceRatio, paceRatio > 1 {
            return "이 패턴이면 갱신 전에 빠듯합니다"
        }
        if paceRatio != nil { return "현재 속도는 여유 있음" }
        return nil
    }
}

struct QuotaEvent: Decodable {
    let provider: String
    let account: String
    let kind: String
    let severity: String
    let occurredAtMs: Double
    let summary: String
}

enum DisplayFormat {
    static func duration(until timestampMs: Double?, now: Date = Date()) -> String {
        guard let timestampMs else { return "시간 미확인" }
        return interval(milliseconds: max(0, timestampMs - now.timeIntervalSince1970 * 1_000))
    }

    static func interval(milliseconds: Double) -> String {
        let seconds = max(0, milliseconds / 1_000)
        let totalMinutes = Int((seconds / 60).rounded())
        let days = totalMinutes / 1_440
        let hours = (totalMinutes % 1_440) / 60
        let minutes = totalMinutes % 60
        if days > 0 { return "\(days)일 \(hours)시간" }
        if hours > 0 { return "\(hours)시간 \(minutes)분" }
        return "\(minutes)분"
    }

    static func clock(_ timestampMs: Double?) -> String {
        guard let timestampMs else { return "—" }
        return clockFormatter.string(from: Date(timeIntervalSince1970: timestampMs / 1_000))
    }

    /// 오늘·내일이면 시각까지, 그 뒤면 날짜와 시각을 함께 보여준다.
    static func resetStamp(_ timestampMs: Double?, now: Date = Date()) -> String {
        guard let timestampMs else { return "갱신 시각 미확인" }
        let date = Date(timeIntervalSince1970: timestampMs / 1_000)
        let calendar = Calendar.current
        if calendar.isDate(date, inSameDayAs: now) { return "\(clockFormatter.string(from: date)) 갱신" }
        return "\(dayFormatter.string(from: date)) \(clockFormatter.string(from: date)) 갱신"
    }

    static func day(_ timestampMs: Double) -> String {
        dayFormatter.string(from: Date(timeIntervalSince1970: timestampMs / 1_000))
    }

    static func age(since date: Date, now: Date = Date()) -> String {
        let seconds = max(0, now.timeIntervalSince(date))
        if seconds < 60 { return "방금" }
        if seconds < 3_600 { return "\(Int(seconds / 60))분 전" }
        return "\(Int(seconds / 3_600))시간 전"
    }

    private static let clockFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "ko_KR")
        formatter.dateFormat = "HH:mm"
        return formatter
    }()

    private static let dayFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "ko_KR")
        formatter.dateFormat = "M월 d일"
        return formatter
    }()
}
