import Foundation

/// A route selects a task for review. It never approves or launches a session.
enum QuotaPieRoute: Equatable {
    case resume(String)
    case session(String)

    init?(url: URL) {
        guard let parts = URLComponents(url: url, resolvingAgainstBaseURL: false),
              parts.scheme?.lowercased() == "quotapie", let host = parts.host,
              ["resume", "session"].contains(host),
              parts.user == nil, parts.password == nil, parts.port == nil,
              parts.percentEncodedQuery == nil, parts.percentEncodedFragment == nil,
              parts.percentEncodedPath == parts.path,
              parts.path.count == 37,
              let uuid = UUID(uuidString: String(parts.path.dropFirst())) else { return nil }
        self = host == "resume" ? .resume(uuid.uuidString.lowercased()) : .session(uuid.uuidString.lowercased())
    }
}
