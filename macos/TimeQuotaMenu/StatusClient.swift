import Foundation

enum StatusClientError: LocalizedError {
    case invalidLocalURL
    case invalidResponse
    case httpStatus(Int)

    var errorDescription: String? {
        switch self {
        case .invalidLocalURL: return "로컬 API 주소가 올바르지 않습니다."
        case .invalidResponse: return "로컬 API 응답을 읽을 수 없습니다."
        case .httpStatus(let code): return "로컬 서비스가 HTTP \(code)를 반환했습니다."
        }
    }
}

final class StatusClient {
    let baseURL: URL
    private let session: URLSession

    init(environment: [String: String] = ProcessInfo.processInfo.environment) throws {
        let raw = environment["TIMEQUOTA_API_URL"] ?? "http://127.0.0.1:47831"
        guard let url = URL(string: raw),
              url.scheme == "http",
              let host = url.host?.lowercased(),
              ["127.0.0.1", "localhost", "::1"].contains(host) else {
            throw StatusClientError.invalidLocalURL
        }
        baseURL = url
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 5
        configuration.timeoutIntervalForResource = 8
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        session = URLSession(configuration: configuration)
    }

    func fetch(completion: @escaping (Result<StatusPayload, Error>) -> Void) {
        let url = baseURL.appendingPathComponent("api/status")
        var request = URLRequest(url: url)
        request.cachePolicy = .reloadIgnoringLocalCacheData
        session.dataTask(with: request) { data, response, error in
            if let error {
                completion(.failure(error))
                return
            }
            guard let http = response as? HTTPURLResponse else {
                completion(.failure(StatusClientError.invalidResponse))
                return
            }
            guard (200..<300).contains(http.statusCode) else {
                completion(.failure(StatusClientError.httpStatus(http.statusCode)))
                return
            }
            guard let data else {
                completion(.failure(StatusClientError.invalidResponse))
                return
            }
            do {
                completion(.success(try JSONDecoder().decode(StatusPayload.self, from: data)))
            } catch {
                completion(.failure(error))
            }
        }.resume()
    }
}
