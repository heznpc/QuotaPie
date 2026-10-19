import Foundation

/// One transport replacement per outage. A new successful read, rather than a
/// timer or another failed attempt, permits a later replacement.
struct QuotaTransportRecovery {
    struct Retry: Equatable {
        let delay: TimeInterval
        let replaceTransport: Bool
    }

    private(set) var failures = 0
    private var consecutiveTimeouts = 0
    private var replacedDuringOutage = false

    mutating func failed(_ error: Error) -> Retry {
        let delays: [TimeInterval] = [2, 5, 15, 30]
        let delay = delays[min(failures, delays.count - 1)]
        failures = min(failures + 1, 1_000_000)
        let error = error as NSError
        consecutiveTimeouts = error.domain == NSURLErrorDomain && error.code == NSURLErrorTimedOut
            ? consecutiveTimeouts + 1 : 0
        if consecutiveTimeouts >= 2, !replacedDuringOutage {
            transportWasReplaced()
            return Retry(delay: 0.15, replaceTransport: true)
        }
        return Retry(delay: delay, replaceTransport: false)
    }

    mutating func transportWasReplaced() {
        consecutiveTimeouts = 0
        replacedDuringOutage = true
    }

    mutating func succeeded() {
        failures = 0
        consecutiveTimeouts = 0
        replacedDuringOutage = false
    }
}
