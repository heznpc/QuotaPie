import Foundation

enum StatusClientError: LocalizedError {
    case invalidLocalURL
    case invalidResponse
    case invalidTaskID
    case invalidNotificationID
    case missingActionToken
    case missingNotificationClaimToken
    case httpStatus(Int)

    var errorDescription: String? {
        switch self {
        case .invalidLocalURL: return Strings.t("client.badURL")
        case .invalidResponse: return Strings.t("client.badResponse")
        case .invalidTaskID: return Strings.t("client.badTaskID")
        case .invalidNotificationID: return Strings.t("client.badResponse")
        case .missingActionToken: return Strings.t("client.missingActionToken")
        case .missingNotificationClaimToken: return Strings.t("client.badResponse")
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
    var notificationsAuthorized = false
    private let session: URLSession
    private let sessionDelegate: LocalOnlySessionDelegate

    init(environment: [String: String] = ProcessInfo.processInfo.environment, operationTimeout: TimeInterval = 5) throws {
        let raw = environment["QUOTAPIE_API_URL"] ?? "http://127.0.0.1:47831"
        guard let url = URL(string: raw),
              url.scheme == "http",
              let host = url.host?.lowercased(),
              ["127.0.0.1", "localhost", "::1"].contains(host) else {
            throw StatusClientError.invalidLocalURL
        }
        baseURL = url
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = operationTimeout
        configuration.timeoutIntervalForResource = max(8, operationTimeout)
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        let delegate = LocalOnlySessionDelegate()
        sessionDelegate = delegate
        session = URLSession(configuration: configuration, delegate: delegate, delegateQueue: nil)
    }

    func fetch(completion: @escaping (Result<StatusPayload, Error>) -> Void) {
        let url = baseURL.appendingPathComponent("api/status")
        var request = URLRequest(url: url)
        request.cachePolicy = .reloadIgnoringLocalCacheData
        perform(request) { result in
            do {
                completion(.success(try JSONDecoder().decode(StatusPayload.self, from: result.get())))
            } catch {
                completion(.failure(error))
            }
        }
    }

    func connectProfile(_ profile: CodexDesktopProfile, actionToken: String,
                        completion: @escaping (Result<ProfileConnectionReply, Error>) -> Void) {
        do {
            var request = try authenticatedPOST(pathComponents: ["api", "profiles", "connect"], actionToken: actionToken)
            request.httpBody = try JSONSerialization.data(withJSONObject: ["name": profile.name, "codexHome": CodexDesktopProfile.canonical(profile.codexHome)])
            request.setValue("application/json", forHTTPHeaderField: "content-type")
            request.setValue(nil, forHTTPHeaderField: "content-length")
            session.dataTask(with: request) { data, response, error in
                if let error { completion(.failure(error)); return }
                guard let http = response as? HTTPURLResponse, let data else {
                    completion(.failure(StatusClientError.invalidResponse)); return
                }
                if http.statusCode != 200 {
                    struct Failure: Decodable { let error: String }
                    let code = (try? JSONDecoder().decode(Failure.self, from: data))?.error ?? "connection_failed"
                    completion(.failure(ProfileConnectionError(code: code))); return
                }
                completion(Result {
                    try JSONDecoder().decode(ProfileConnectionReply.self, from: data)
                })
            }.resume()
        } catch { completion(.failure(error)) }
    }

    func configureNotifications(key: String, enabled: Bool, actionToken: String,
                                completion: @escaping (Result<NotificationPreferencesResponse, Error>) -> Void) {
        do {
            var request = try authenticatedPOST(pathComponents: ["api", "notifications", "preferences"], actionToken: actionToken)
            let body: [String: Any] = key == "enabled" ? ["enabled": enabled] : ["topics": [key: enabled]]
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
            request.setValue(nil, forHTTPHeaderField: "content-length")
            request.setValue("application/json", forHTTPHeaderField: "content-type")
            perform(request) { result in
                completion(Result { try JSONDecoder().decode(NotificationPreferencesResponse.self, from: result.get()) })
            }
        } catch { completion(.failure(error)) }
    }

    func configureSavings(enabled: Bool?, bypassThread: String?, actionToken: String,
                          completion: @escaping (Result<TaskSavingsPolicyResponse, Error>) -> Void) {
        do {
            var request = try authenticatedPOST(pathComponents: ["api", "task-savings", "policy"], actionToken: actionToken)
            var body: [String: Any] = [:]
            if let enabled { body["enabled"] = enabled }
            if let bypassThread { body["bypassThread"] = bypassThread }
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
            request.setValue(nil, forHTTPHeaderField: "content-length")
            request.setValue("application/json", forHTTPHeaderField: "content-type")
            request.timeoutInterval = 8
            perform(request) { result in
                completion(Result { try JSONDecoder().decode(TaskSavingsPolicyResponse.self, from: result.get()) })
            }
        } catch { completion(.failure(error)) }
    }

    func configureCompaction(model: String, actionToken: String,
                             completion: @escaping (Result<CompactionPolicyResponse, Error>) -> Void) {
        do {
            var request = try authenticatedPOST(pathComponents: ["api", "compaction", "policy"], actionToken: actionToken)
            request.httpBody = try JSONSerialization.data(withJSONObject: ["model": model])
            request.setValue(nil, forHTTPHeaderField: "content-length")
            request.setValue("application/json", forHTTPHeaderField: "content-type")
            request.timeoutInterval = 8
            perform(request) { result in
                completion(Result { try JSONDecoder().decode(CompactionPolicyResponse.self, from: result.get()) })
            }
        } catch { completion(.failure(error)) }
    }

    func approveResumeTask(
        id: String,
        actionToken: String,
        completion: @escaping (Result<ResumeApprovalResponse, Error>) -> Void
    ) {
        do {
            let request = try resumeRequest(id: id, action: "approve", actionToken: actionToken)
            perform(request) { result in
                do {
                    completion(.success(try JSONDecoder().decode(ResumeApprovalResponse.self, from: result.get())))
                } catch {
                    completion(.failure(error))
                }
            }
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
            perform(request) { result in
                do {
                    _ = try result.get()
                    completion(.success(()))
                } catch {
                    completion(.failure(error))
                }
            }
        } catch {
            completion(.failure(error))
        }
    }

    func claimNotification(
        actionToken: String,
        completion: @escaping (Result<NotificationClaimResponse, Error>) -> Void
    ) {
        do {
            var request = try authenticatedPOST(
                pathComponents: ["api", "notifications", "claim"],
                actionToken: actionToken
            )
            request.setValue(String(notificationsAuthorized), forHTTPHeaderField: "x-quotapie-notifications-authorized")
            perform(request) { result in
                do {
                    completion(.success(try JSONDecoder().decode(NotificationClaimResponse.self, from: result.get())))
                } catch {
                    completion(.failure(error))
                }
            }
        } catch {
            completion(.failure(error))
        }
    }

    func completeNotification(
        id: String,
        disposition: NotificationCompletionDisposition,
        claimToken: String,
        actionToken: String,
        completion: @escaping (Result<Void, Error>) -> Void
    ) {
        mutateNotification(
            id: id,
            action: disposition.rawValue,
            claimToken: claimToken,
            actionToken: actionToken,
            responseKeyPath: \.completed,
            completion: completion
        )
    }

    func releaseNotification(
        id: String,
        claimToken: String,
        actionToken: String,
        completion: @escaping (Result<Void, Error>) -> Void
    ) {
        mutateNotification(
            id: id,
            action: "release",
            claimToken: claimToken,
            actionToken: actionToken,
            responseKeyPath: \.released,
            completion: completion
        )
    }

    func renewNotification(
        id: String,
        claimToken: String,
        actionToken: String,
        completion: @escaping (Result<Void, Error>) -> Void
    ) {
        mutateNotification(
            id: id,
            action: "renew",
            claimToken: claimToken,
            actionToken: actionToken,
            responseKeyPath: \.renewed,
            completion: completion
        )
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
        return try authenticatedPOST(url: url, actionToken: actionToken)
    }

    private struct NotificationMutationResponse: Decodable {
        let completed: Bool?
        let released: Bool?
        let renewed: Bool?
    }

    private func mutateNotification(
        id: String,
        action: String,
        claimToken: String,
        actionToken: String,
        responseKeyPath: KeyPath<NotificationMutationResponse, Bool?>,
        completion: @escaping (Result<Void, Error>) -> Void
    ) {
        guard UUID(uuidString: id) != nil else {
            completion(.failure(StatusClientError.invalidNotificationID))
            return
        }
        do {
            let request = try authenticatedPOST(
                pathComponents: ["api", "notifications", id, action],
                actionToken: actionToken,
                notificationClaimToken: claimToken
            )
            perform(request) { result in
                do {
                    let response = try JSONDecoder().decode(NotificationMutationResponse.self, from: result.get())
                    guard response[keyPath: responseKeyPath] == true else {
                        throw StatusClientError.invalidResponse
                    }
                    completion(.success(()))
                } catch {
                    completion(.failure(error))
                }
            }
        } catch {
            completion(.failure(error))
        }
    }

    private func authenticatedPOST(
        pathComponents: [String],
        actionToken: String,
        notificationClaimToken: String? = nil
    ) throws -> URLRequest {
        var url = baseURL
        for component in pathComponents {
            url.appendPathComponent(component)
        }
        return try authenticatedPOST(
            url: url,
            actionToken: actionToken,
            notificationClaimToken: notificationClaimToken
        )
    }

    private func authenticatedPOST(
        url: URL,
        actionToken: String,
        notificationClaimToken: String? = nil
    ) throws -> URLRequest {
        guard !actionToken.isEmpty else { throw StatusClientError.missingActionToken }
        if let notificationClaimToken, notificationClaimToken.isEmpty {
            throw StatusClientError.missingNotificationClaimToken
        }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.setValue(actionToken, forHTTPHeaderField: "x-quotapie-action-token")
        if let notificationClaimToken {
            request.setValue(notificationClaimToken, forHTTPHeaderField: "x-quotapie-notification-claim")
        }
        request.setValue("0", forHTTPHeaderField: "content-length")
        return request
    }

    private func perform(
        _ request: URLRequest,
        completion: @escaping (Result<Data, Error>) -> Void
    ) {
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
            completion(.success(data ?? Data()))
        }.resume()
    }
}

struct ProfileConnectionReply: Decodable {
    let account: String
    let relayConnected: Bool?
}

struct ProfileConnectionError: LocalizedError {
    let code: String
    var errorDescription: String? {
        let known = ["isolation_required", "settings_changed", "account_disabled", "profile_overlap", "profile_relay_failed"]
        return Strings.t(known.contains(code) ? "profiles." + code : "profiles.connectFailed")
    }
}
