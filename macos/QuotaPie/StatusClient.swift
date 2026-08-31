import Foundation

enum StatusClientError: LocalizedError {
    case invalidLocalURL
    case invalidResponse
    case invalidTaskID
    case missingActionToken
    case httpStatus(Int)

    var errorDescription: String? {
        switch self {
        case .invalidLocalURL: return Strings.t("client.badURL")
        case .invalidResponse: return Strings.t("client.badResponse")
        case .invalidTaskID: return Strings.t("client.badTaskID")
        case .missingActionToken: return Strings.t("client.missingActionToken")
        case .httpStatus(let code): return Strings.t("client.httpStatus", String(code))
        }
    }
}

enum ResumeTaskTransition: String {
    case resumed
    case retry
    case dismiss
}

/// Never follow a redirect while a local action capability is attached. A
/// compromised or misconfigured localhost service must not be able to forward
/// that capability to another origin.
private final class LocalOnlySessionDelegate: NSObject, URLSessionTaskDelegate {
    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest,
        completionHandler: @escaping (URLRequest?) -> Void
    ) {
        completionHandler(nil)
    }
}

final class StatusClient {
    let baseURL: URL
    private let session: URLSession
    private let sessionDelegate: LocalOnlySessionDelegate

    init(environment: [String: String] = ProcessInfo.processInfo.environment) throws {
        let raw = environment["QUOTAPIE_API_URL"] ?? "http://127.0.0.1:47831"
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
        let delegate = LocalOnlySessionDelegate()
        sessionDelegate = delegate
        session = URLSession(configuration: configuration, delegate: delegate, delegateQueue: nil)
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

    func approveResumeTask(
        id: String,
        actionToken: String,
        completion: @escaping (Result<ResumeApprovalResponse, Error>) -> Void
    ) {
        do {
            let request = try resumeRequest(id: id, action: "approve", actionToken: actionToken)
            session.dataTask(with: request) { data, response, error in
                if let error {
                    completion(.failure(error))
                    return
                }
                do {
                    let data = try Self.successData(data: data, response: response)
                    completion(.success(try JSONDecoder().decode(ResumeApprovalResponse.self, from: data)))
                } catch {
                    completion(.failure(error))
                }
            }.resume()
        } catch {
            completion(.failure(error))
        }
    }

    func transitionResumeTask(
        id: String,
        transition: ResumeTaskTransition,
        actionToken: String,
        completion: @escaping (Result<Void, Error>) -> Void
    ) {
        do {
            let request = try resumeRequest(id: id, action: transition.rawValue, actionToken: actionToken)
            session.dataTask(with: request) { data, response, error in
                if let error {
                    completion(.failure(error))
                    return
                }
                do {
                    _ = try Self.successData(data: data, response: response)
                    completion(.success(()))
                } catch {
                    completion(.failure(error))
                }
            }.resume()
        } catch {
            completion(.failure(error))
        }
    }

    private func resumeRequest(id: String, action: String, actionToken: String) throws -> URLRequest {
        guard !id.isEmpty, !id.contains("/"), !id.contains("\\") else {
            throw StatusClientError.invalidTaskID
        }
        guard !actionToken.isEmpty else { throw StatusClientError.missingActionToken }

        let url = baseURL
            .appendingPathComponent("api", isDirectory: true)
            .appendingPathComponent("resume-tasks", isDirectory: true)
            .appendingPathComponent(id, isDirectory: true)
            .appendingPathComponent(action)
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.setValue(actionToken, forHTTPHeaderField: "x-quotapie-action-token")
        request.setValue("0", forHTTPHeaderField: "content-length")
        return request
    }

    private static func successData(data: Data?, response: URLResponse?) throws -> Data {
        guard let http = response as? HTTPURLResponse else {
            throw StatusClientError.invalidResponse
        }
        guard (200..<300).contains(http.statusCode) else {
            throw StatusClientError.httpStatus(http.statusCode)
        }
        return data ?? Data()
    }
}
