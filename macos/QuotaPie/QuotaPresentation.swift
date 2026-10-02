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

    /// Log schema locations, never provider values, error descriptions or dynamic
    /// dictionary keys (which can be account IDs, environment names or user data).
    static func diagnostic(_ error: Error) -> String {
        var result = "kind=\(StatusFailure(error).rawValue) code=\((error as NSError).code)"
        if case StatusClientError.httpStatus(let status) = error { result += " http=\(status)" }
        let issue: String
        let path: [CodingKey]
        switch error {
        case DecodingError.typeMismatch(_, let context):
            issue = "typeMismatch"; path = context.codingPath
        case DecodingError.valueNotFound(_, let context):
            issue = "valueNotFound"; path = context.codingPath
        case DecodingError.keyNotFound(let key, let context):
            issue = "keyNotFound"; path = context.codingPath + [key]
        case DecodingError.dataCorrupted(let context):
            issue = "dataCorrupted"; path = context.codingPath
        default: return result
        }
        let field = path.prefix(16).reduce("$") { value, key in
            if let index = key.intValue, key.stringValue == "Index \(index)" { return value + "[\(index)]" }
            let typeName = String(reflecting: type(of: key))
            // Only keys declared by our typed models are safe to publish.
            // Foundation's dictionary keys deliberately do not match this.
            if typeName.hasPrefix("QuotaPie."), typeName.hasSuffix(".CodingKeys") {
                return value + "." + key.stringValue
            }
            return value + "[key]"
        }
        return result + " decoding=\(issue) field=\(field)" + (path.count > 16 ? "…" : "")
    }
}
