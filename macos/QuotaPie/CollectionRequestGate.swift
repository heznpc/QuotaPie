import Foundation

/// Collection requests share the quota transport. Replacing that transport
/// must preserve their intent and reject the cancelled generation's callback.
struct CollectionRequestGate {
    struct Request: Equatable {
        let reason: String
        fileprivate let generation: Int
    }

    private(set) var pendingReason: String?
    private var active: Request?
    private var generation = 0

    mutating func request(_ reason: String) { pendingReason = reason }

    mutating func begin() -> Request? {
        guard active == nil, let reason = pendingReason else { return nil }
        generation += 1
        let request = Request(reason: reason, generation: generation)
        active = request
        pendingReason = nil
        return request
    }

    mutating func finish(_ request: Request, retry: Bool) -> Bool {
        guard active == request else { return false }
        active = nil
        if retry, pendingReason == nil { pendingReason = request.reason }
        return true
    }

    mutating func transportWasReplaced() {
        if pendingReason == nil { pendingReason = active?.reason }
        generation += 1
        active = nil
    }
}
