import Foundation

struct StatusPayload: Decodable {
    let nowMs: Double?
    let statuses: [AccountStatus]
    let events: [QuotaEvent]

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        nowMs = try values.decodeIfPresent(Double.self, forKey: .nowMs)
        statuses = try values.decodeIfPresent([AccountStatus].self, forKey: .statuses) ?? []
        events = try values.decodeIfPresent([QuotaEvent].self, forKey: .events) ?? []
    }

    private enum CodingKeys: String, CodingKey { case nowMs, statuses, events }
}

struct AccountStatus: Decodable {
    let provider: String
    let account: String?
    let accountLabel: String?
    let windows: [QuotaWindow]
    let bottleneckBucket: String?
    let updatedAtMs: Double?
}

struct QuotaWindow: Decodable {
    let provider: String
    let account: String
    let bucket: String
    let label: String
    let freshness: String
    let observedAtMs: Double
    let remainingPercent: Double?
    let resetsAtMs: Double?
    let paceRatio: Double?
    let minutesBeforeReset: Double?
    let bottleneckScore: Double?
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

    static func age(since date: Date, now: Date = Date()) -> String {
        let seconds = max(0, now.timeIntervalSince(date))
        if seconds < 60 { return "방금 전" }
        if seconds < 3_600 { return "\(Int(seconds / 60))분 전" }
        return "\(Int(seconds / 3_600))시간 전"
    }

    private static let clockFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "ko_KR")
        formatter.dateFormat = "HH:mm"
        return formatter
    }()
}
