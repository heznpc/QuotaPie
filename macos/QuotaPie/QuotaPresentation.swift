import Foundation

enum QuotaPresentation {
    static func isLow(_ remaining: Double?) -> Bool {
        guard let remaining, remaining.isFinite else { return false }
        return remaining < 20
    }
}

enum StatusFailure: String {
    case timeout, connection, response

    init(_ error: Error) {
        let nsError = error as NSError
        if nsError.domain == NSURLErrorDomain {
            switch nsError.code {
            case NSURLErrorTimedOut: self = .timeout
            case NSURLErrorCannotConnectToHost, NSURLErrorCannotFindHost,
                 NSURLErrorNetworkConnectionLost, NSURLErrorNotConnectedToInternet:
                self = .connection
            default: self = .response
            }
        } else { self = .response }
    }

    var shortText: String { Strings.t("status.failure.\(rawValue)") }
    var detailText: String { Strings.t("status.failure.\(rawValue).detail") }
}
