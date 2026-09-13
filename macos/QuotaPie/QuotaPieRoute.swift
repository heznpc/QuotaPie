import Foundation

/// A route selects a task for review. It never approves or launches a session.
enum QuotaPieRoute: Equatable {
    case resume(String)

    init?(url: URL) {
        guard let parts = URLComponents(url: url, resolvingAgainstBaseURL: false),
              parts.scheme?.lowercased() == "quotapie", parts.host == "resume",
              parts.user == nil, parts.password == nil, parts.port == nil,
              parts.percentEncodedQuery == nil, parts.percentEncodedFragment == nil,
              parts.percentEncodedPath == parts.path,
              parts.path.count == 37,
              let uuid = UUID(uuidString: String(parts.path.dropFirst())) else { return nil }
        self = .resume(uuid.uuidString.lowercased())
    }
}
