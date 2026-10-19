import Foundation

struct OfficialUsageChange: Decodable {
    let key: String
    let current: Double
    let previous: Double
    let delta: Double
    let changePercent: Double?
}

struct OfficialUsageAnalysis: Decodable {
    let status: String
    let reason: String?
    let boundaryMs: Double?
    let boundaryKind: String?
    let boundarySource: String?
    let timezone: String
    let currentStartDate: String
    let currentEndDate: String
    let previousStartDate: String
    let previousEndDate: String
    let excludedDates: [String]
    let currentTotal: Double
    let previousTotal: Double
    let changePercent: Double?
    let currentFeatureTotal: Double
    let previousFeatureTotal: Double
    let featureChangePercent: Double?
    let models: [OfficialUsageChange]
    let features: [OfficialUsageChange]
    let speeds: [OfficialUsageChange]
    let triggers: [OfficialUsageChange]
    let conversationStatus: String
    let conversationReason: String
    let freshnessConfirmed: Bool
    let basis: String
}
