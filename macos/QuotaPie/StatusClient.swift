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
    private let usageSession: URLSession
    private var quotaSession: URLSession
    private let quotaConfiguration: URLSessionConfiguration
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
        let usageConfiguration = URLSessionConfiguration.ephemeral
        usageConfiguration.timeoutIntervalForRequest = 30
        usageConfiguration.timeoutIntervalForResource = 60
        usageConfiguration.requestCachePolicy = .reloadIgnoringLocalCacheData
        usageSession = URLSession(configuration: usageConfiguration, delegate: delegate, delegateQueue: nil)
        quotaConfiguration = configuration
        quotaSession = URLSession(configuration: configuration, delegate: delegate, delegateQueue: nil)
    }

    /// Replace only the local quota/collection transport after sleep. Other
    /// action requests and detail reads keep their original session.
    func resetQuotaTransport() {
        let previous = quotaSession
        quotaSession = URLSession(configuration: quotaConfiguration, delegate: sessionDelegate, delegateQueue: nil)
        previous.invalidateAndCancel()
    }

    func fetch(completion: @escaping (Result<StatusPayload, Error>) -> Void) {
        let url = baseURL.appendingPathComponent("api/status")
        var request = URLRequest(url: url)
        request.setValue(Strings.language.rawValue, forHTTPHeaderField: "x-quotapie-locale")
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.setValue("1", forHTTPHeaderField: "x-quotapie-recent-work")
        perform(request) { result in
            do {
                completion(.success(try JSONDecoder().decode(StatusPayload.self, from: result.get())))
            } catch {
                completion(.failure(error))
            }
        }
    }

    @discardableResult
    func fetchOfficialUsage(startDate: String, endDate: String, actionToken: String, refresh: Bool = false, analysisDate: String? = nil, analysisTimeZone: String? = nil,
                            completion: @escaping (Result<OfficialUsageReport, Error>) -> Void) -> URLSessionDataTask? {
        var components = URLComponents(url: baseURL.appendingPathComponent("api/official-usage"), resolvingAgainstBaseURL: false)
        components?.queryItems = [URLQueryItem(name: "startDate", value: startDate), URLQueryItem(name: "endDate", value: endDate), URLQueryItem(name: "refresh", value: refresh ? "1" : "0")]
        if let analysisDate {
            components?.queryItems?.append(URLQueryItem(name: "analysisDate", value: analysisDate))
            components?.queryItems?.append(URLQueryItem(name: "analysisTimeZone", value: analysisTimeZone ?? "UTC"))
        }
        guard let url = components?.url else { completion(.failure(StatusClientError.invalidLocalURL)); return nil }
        var request = URLRequest(url: url)
        request.setValue(actionToken, forHTTPHeaderField: "x-quotapie-action-token")
        request.timeoutInterval = 30
        let task = usageSession.dataTask(with: request) { data, response, error in
            completion(Result {
                if let error { throw error }
                guard let response = response as? HTTPURLResponse, let data else { throw StatusClientError.invalidResponse }
                guard (200..<300).contains(response.statusCode) else { throw StatusClientError.httpStatus(response.statusCode) }
                return try JSONDecoder().decode(OfficialUsageReport.self, from: data)
            })
        }
        task.resume()
        return task
    }

    @discardableResult
    func fetchUsageReport(fromMs: Double, toMs: Double, timeZone: String, actionToken: String,
                          provider: String? = nil, account: String? = nil, refresh: Bool = false,
                          completion: @escaping (Result<UsageReportResponse, Error>) -> Void) -> URLSessionDataTask? {
        var components = URLComponents(url: baseURL.appendingPathComponent("api/usage-report"), resolvingAgainstBaseURL: false)
        var query = [URLQueryItem(name: "fromMs", value: String(Int64(fromMs))),
                     URLQueryItem(name: "toMs", value: String(Int64(toMs))),
                     URLQueryItem(name: "timeZone", value: timeZone)]
        if let provider, let account {
            query += [URLQueryItem(name: "provider", value: provider), URLQueryItem(name: "account", value: account)]
        }
        if refresh { query.append(URLQueryItem(name: "refresh", value: "1")) }
        components?.queryItems = query
        guard let url = components?.url else { completion(.failure(StatusClientError.invalidLocalURL)); return nil }
        var request = URLRequest(url: url)
        request.setValue(Strings.language.rawValue, forHTTPHeaderField: "x-quotapie-locale")
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.setValue(actionToken, forHTTPHeaderField: "x-quotapie-action-token")
        return perform(request) { result in
            completion(Result { try JSONDecoder().decode(UsageReportResponse.self, from: result.get()) })
        }
    }

    @discardableResult
    func fetchQuota(completion: @escaping (Result<StatusPayload, Error>) -> Void) -> URLSessionDataTask {
        var request = URLRequest(url: baseURL.appendingPathComponent("api/quota"))
        request.setValue(Strings.language.rawValue, forHTTPHeaderField: "x-quotapie-locale")
        request.cachePolicy = .reloadIgnoringLocalCacheData
        return perform(request, using: quotaSession) { result in
            completion(Result { try JSONDecoder().decode(StatusPayload.self, from: result.get()) })
        }
    }

    func refreshCollection(reason: String, actionToken: String, completion: @escaping (Result<CollectionRefreshState, Error>) -> Void) {
        do {
            var request = try authenticatedPOST(pathComponents: ["api", "collection", "refresh"], actionToken: actionToken)
            request.setValue(nil, forHTTPHeaderField: "content-length")
            request.setValue("application/json", forHTTPHeaderField: "content-type")
            request.httpBody = try JSONSerialization.data(withJSONObject: ["reason": reason])
            perform(request, using: quotaSession) { result in
                struct Reply: Decodable { let collection: CollectionRefreshState }
                completion(Result { try JSONDecoder().decode(Reply.self, from: result.get()).collection })
            }
        } catch { completion(.failure(error)) }
    }

    func dotsConnection(action: String? = nil, actionToken: String,
                        completion: @escaping (Result<DotsConnectionStatus, Error>) -> Void) {
        do {
            var request = try authenticatedPOST(pathComponents: ["api", "dots", "connection"], actionToken: actionToken)
            if let action {
                request.httpBody = try JSONSerialization.data(withJSONObject: ["action": action])
                request.setValue("application/json", forHTTPHeaderField: "content-type")
            } else { request.httpMethod = "GET" }
            perform(request) { result in
                completion(Result { try JSONDecoder().decode(DotsConnectionStatus.self, from: result.get()) })
            }
        } catch { completion(.failure(error)) }
    }

    func connectClaudeDesktop(actionToken: String,
                              completion: @escaping (Result<ClaudeDesktopConnectionReply, Error>) -> Void) {
        do {
            var request = try authenticatedPOST(pathComponents: ["api", "claude", "desktop", "connect"], actionToken: actionToken)
            request.httpBody = Data("{}".utf8)
            request.setValue(nil, forHTTPHeaderField: "content-length")
            request.setValue("application/json", forHTTPHeaderField: "content-type")
            session.dataTask(with: request) { data, response, error in
                if let error { completion(.failure(error)); return }
                guard let http = response as? HTTPURLResponse, let data else {
                    completion(.failure(StatusClientError.invalidResponse)); return
                }
                guard http.statusCode == 200 else {
                    struct Failure: Decodable { let category: String? }
                    let category = (try? JSONDecoder().decode(Failure.self, from: data))?.category ?? "provider-error"
                    completion(.failure(ClaudeDesktopConnectionError(category: category))); return
                }
                completion(Result {
                    let reply = try JSONDecoder().decode(ClaudeDesktopConnectionReply.self, from: data)
                    guard reply.connected, reply.account.isClaudeDesktop else { throw StatusClientError.invalidResponse }
                    return reply
                })
            }.resume()
        } catch { completion(.failure(error)) }
    }

    func automaticWork(actionToken: String, completion: @escaping (Result<AutomaticWorkResponse, Error>) -> Void) {
        workRequest(actionToken: actionToken, completion: completion)
    }

    func setAutoResumeEnabled(account: String, enabled: Bool, actionToken: String,
                              completion: @escaping (Result<AutoResumeResponse, Error>) -> Void) {
        workRequest(path: ["api", "auto-resume"], body: ["action": "enabled", "account": account, "enabled": enabled],
                    actionToken: actionToken, completion: completion)
    }

    func skipAutoResume(id: String, actionToken: String,
                        completion: @escaping (Result<AutoResumeResponse, Error>) -> Void) {
        workRequest(path: ["api", "auto-resume"], body: ["action": "skip", "id": id],
                    actionToken: actionToken, completion: completion)
    }

    func automaticWorkPreferences(actionToken: String, completion: @escaping (Result<AutomaticWorkPreferencesResponse, Error>) -> Void) {
        workRequest(path: ["api", "work", "preferences"], actionToken: actionToken, completion: completion)
    }
    func saveAutomaticWorkPreferences(_ policy: AutomaticWorkPolicy, revision: Int?, actionToken: String,
                                      completion: @escaping (Result<AutomaticWorkPreferenceSaveResponse, Error>) -> Void) {
        workRequest(path: ["api", "work", "preferences"], body: ["scope": "account", "provider": policy.provider,
            "account": policy.account, "values": policy.preferenceInput, "expectedRevision": revision.map { $0 as Any } ?? NSNull()],
            actionToken: actionToken, completion: completion)
    }

    func automaticWorkTargets(provider: String, account: String, actionToken: String,
                              completion: @escaping (Result<AutomaticWorkTargetsResponse, Error>) -> Void) {
        workRequest(path: ["api", "work", "targets"], query: [URLQueryItem(name: "provider", value: provider),
                    URLQueryItem(name: "account", value: account)], actionToken: actionToken, completion: completion)
    }

    func automaticWorkHostGoal(provider: String, account: String, session: String, actionToken: String,
                               completion: @escaping (Result<AutomaticWorkHostGoalResponse, Error>) -> Void) {
        workRequest(path: ["api", "work", "host-goal"], query: [URLQueryItem(name: "provider", value: provider),
                    URLQueryItem(name: "account", value: account), URLQueryItem(name: "session", value: session)],
                    actionToken: actionToken, completion: completion)
    }

    func updateAutomaticWorkHostGoal(id: String, revision: Int, action: String, reviewedObjective: String? = nil, actionToken: String,
                                     completion: @escaping (Result<AutomaticWorkHostGoalResponse, Error>) -> Void) {
        var body: [String: Any] = ["id": id, "expectedRevision": revision, "action": action]
        if let reviewedObjective { body["reviewedObjective"] = reviewedObjective }
        workRequest(path: ["api", "work", "host-goal"], body: body,
                    actionToken: actionToken, completion: completion)
    }

    func saveAutomaticWork(_ policy: AutomaticWorkPolicy, hostGoalLinked: Bool? = nil, reviewedObjective: String? = nil, actionToken: String,
                           completion: @escaping (Result<AutomaticWorkSaveResponse, Error>) -> Void) {
        var body: [String: Any] = ["action": "save", "policy": policy.registrationInput,
            "expectedRevision": policy.revision.map { $0 as Any } ?? NSNull(), "requestId": UUID().uuidString]
        if let hostGoalLinked { body["hostGoalLinked"] = hostGoalLinked }
        if let reviewedObjective { body["reviewedObjective"] = reviewedObjective }
        workRequest(body: body, actionToken: actionToken, completion: completion)
    }

    func enableAutomaticWork(id: String, enabled: Bool, revision: Int, actionToken: String,
                             completion: @escaping (Result<AutomaticWorkSaveResponse, Error>) -> Void) {
        workRequest(body: ["action": "enabled", "id": id, "enabled": enabled,
            "expectedRevision": revision, "requestId": UUID().uuidString], actionToken: actionToken, completion: completion)
    }

    private func workRequest<T: Decodable>(path: [String] = ["api", "work"], query: [URLQueryItem] = [],
                                          body: [String: Any]? = nil, actionToken: String,
                                          completion: @escaping (Result<T, Error>) -> Void) {
        do {
            var request = try authenticatedPOST(pathComponents: path, actionToken: actionToken)
            if !query.isEmpty, let url = request.url {
                var parts = URLComponents(url: url, resolvingAgainstBaseURL: false)
                parts?.queryItems = query
                request.url = parts?.url
            }
            request.setValue(nil, forHTTPHeaderField: "content-length")
            if let body {
                request.httpBody = try JSONSerialization.data(withJSONObject: body)
                request.setValue("application/json", forHTTPHeaderField: "content-type")
            } else { request.httpMethod = "GET" }
            session.dataTask(with: request) { data, response, error in
                if let error { completion(.failure(error)); return }
                guard let http = response as? HTTPURLResponse else {
                    completion(.failure(StatusClientError.invalidResponse)); return
                }
                let payload = data ?? Data()
                guard (200..<300).contains(http.statusCode) else {
                    completion(.failure(AutomaticWorkError(data: payload, status: http.statusCode))); return
                }
                completion(Result { try JSONDecoder().decode(T.self, from: payload) })
            }.resume()
        } catch { completion(.failure(error)) }
    }

    func saveNickname(provider: String, account: String, nickname: String, actionToken: String,
                      completion: @escaping (Result<Void, Error>) -> Void) {
        do {
            var request = try authenticatedPOST(pathComponents: ["api", "accounts", "nickname"], actionToken: actionToken)
            request.httpBody = try JSONSerialization.data(withJSONObject: ["provider": provider, "account": account, "nickname": nickname])
            request.setValue("application/json", forHTTPHeaderField: "content-type")
            session.dataTask(with: request) { _, response, error in
                if let error { completion(.failure(error)); return }
                guard (response as? HTTPURLResponse)?.statusCode == 200 else {
                    completion(.failure(StatusClientError.invalidResponse)); return
                }
                completion(.success(()))
            }.resume()
        } catch { completion(.failure(error)) }
    }

    func openRecentWork(id: String, actionToken: String,
                        completion: @escaping (Result<RecentWorkOpenResponse, Error>) -> Void) {
        guard RecentWork.isValidID(id) else {
            completion(.failure(StatusClientError.invalidTaskID))
            return
        }
        do {
            let request = try authenticatedPOST(pathComponents: ["api", "recent-work", id, "open"], actionToken: actionToken)
            session.dataTask(with: request) { data, response, error in
                if let error { completion(.failure(error)); return }
                guard let http = response as? HTTPURLResponse, let data else {
                    completion(.failure(StatusClientError.invalidResponse)); return
                }
                guard http.statusCode == 200 else {
                    struct Failure: Decodable { let error: String }
                    let code = (try? JSONDecoder().decode(Failure.self, from: data))?.error ?? "recent_work_open_failed"
                    completion(.failure(RecentWorkOpenError(code: code)))
                    return
                }
                completion(Result { try JSONDecoder().decode(RecentWorkOpenResponse.self, from: data) })
            }.resume()
        } catch { completion(.failure(error)) }
    }

    func profileDockIcon(account: String, icon: CodexDockIcon?, actionToken: String,
                         completion: @escaping (Result<DockIconReply, Error>) -> Void) {
        do {
            var request = try authenticatedPOST(pathComponents: ["api", "profiles", "dock-icon"], actionToken: actionToken)
            var body = ["account": account]
            if let icon { body["icon"] = icon.nativeValue }
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
            request.setValue("application/json", forHTTPHeaderField: "content-type")
            perform(request) { result in
                completion(Result { try JSONDecoder().decode(DockIconReply.self, from: result.get()) })
            }
        } catch { completion(.failure(error)) }
    }

    func consolidateSessions(_ profile: CodexDesktopProfile, actionToken: String,
                             completion: @escaping (Result<SessionConsolidationReply, Error>) -> Void) {
        workRequest(path: ["api", "session-consolidation"], body: ["source": [
            "codexHome": CodexDesktopProfile.canonical(profile.codexHome),
            "appData": CodexDesktopProfile.canonical(profile.appData)]], actionToken: actionToken, completion: completion)
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
            let body: [String: Any] = ["enabled", "usageSpeed", "paceForecasts"].contains(key)
                ? [key: enabled] : ["topics": [key: enabled]]
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
            request.setValue(nil, forHTTPHeaderField: "content-length")
            request.setValue("application/json", forHTTPHeaderField: "content-type")
            perform(request) { result in
                completion(Result { try JSONDecoder().decode(NotificationPreferencesResponse.self, from: result.get()) })
            }
        } catch { completion(.failure(error)) }
    }

    func configurePool(enabled: Bool?, account: String?, reservePercent: Int?, actionToken: String,
                       completion: @escaping (Result<AccountPoolResponse, Error>) -> Void) {
        do {
            var request = try authenticatedPOST(pathComponents: ["api", "account-pool", "policy"], actionToken: actionToken)
            var body: [String: Any] = [:]
            if let enabled { body["enabled"] = enabled }
            if let account { body["account"] = account }
            if let reservePercent { body["reservePercent"] = reservePercent }
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
            request.setValue(nil, forHTTPHeaderField: "content-length")
            request.setValue("application/json", forHTTPHeaderField: "content-type")
            perform(request) { result in
                completion(Result { try JSONDecoder().decode(AccountPoolResponse.self, from: result.get()) })
            }
        } catch { completion(.failure(error)) }
    }

    func configureSavings(enabled: Bool?, bypassThread: String?, testOnly: Bool? = nil, actionToken: String,
                          completion: @escaping (Result<TaskSavingsPolicyResponse, Error>) -> Void) {
        do {
            var request = try authenticatedPOST(pathComponents: ["api", "task-savings", "policy"], actionToken: actionToken)
            var body: [String: Any] = [:]
            if let enabled { body["enabled"] = enabled }
            if let bypassThread { body["bypassThread"] = bypassThread }
            if let testOnly { body["testOnly"] = testOnly }
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

    @discardableResult
    private func perform(
        _ request: URLRequest,
        using selectedSession: URLSession? = nil,
        completion: @escaping (Result<Data, Error>) -> Void
    ) -> URLSessionDataTask {
        let task = (selectedSession ?? session).dataTask(with: request) { data, response, error in
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
        }
        if selectedSession != nil { task.priority = URLSessionTask.highPriority }
        task.resume()
        return task
    }
}

struct SessionConsolidationReply: Decodable, Equatable {
    let state: String
    let reason: String?
    let threadCount: Int?
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

struct RecentWorkOpenError: LocalizedError {
    let code: String
    var errorDescription: String? {
        switch code {
        case "recent_work_unavailable": return Strings.t("work.error.unavailable")
        case "forbidden": return Strings.t("client.missingActionToken")
        default: return Strings.t("work.error.openFailed")
        }
    }
}
