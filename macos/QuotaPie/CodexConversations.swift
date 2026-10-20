import Foundation

struct CodexConversation: Decodable, Identifiable {
    let id: String
    let title: String?
    let active: Bool?
    let updatedAt: Double?
    var displayTitle: String { title?.isEmpty == false ? title! : String(id.prefix(8)) }
}

struct CodexConversationPage: Decodable {
    let account: String
    let sessionOwner: String
    let consolidated: Bool
    let conversations: [CodexConversation]
    let nextCursor: String?
}

struct CodexMessageReceipt: Codable {
    let submissionId: String
    let threadId: String
    let state: String
    let reason: String?
    var terminal: Bool { ["completed", "failed"].contains(state) }
}

private final class ConversationSessionDelegate: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

final class CodexConversationsClient {
    private let base: URL
    private let session: URLSession
    init(environment: [String: String] = ProcessInfo.processInfo.environment) throws {
        base = try StatusClient(environment: environment).baseURL
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 45
        config.timeoutIntervalForResource = 50
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        session = URLSession(configuration: config, delegate: ConversationSessionDelegate(), delegateQueue: nil)
    }
    func request<T: Decodable>(_ path: String, token: String, query: [URLQueryItem] = [], body: [String: String]? = nil) async throws -> T {
        guard !token.isEmpty else { throw StatusClientError.missingActionToken }
        var url = URLComponents(url: base.appendingPathComponent(path), resolvingAgainstBaseURL: false)!
        url.queryItems = query.isEmpty ? nil : query
        var request = URLRequest(url: url.url!)
        request.setValue(token, forHTTPHeaderField: "x-quotapie-action-token")
        if let body {
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "content-type")
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw StatusClientError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else {
            let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            throw CodexConversationError(code: value?["error"] as? String ?? "unavailable",
                notAccepted: value?["accepted"] as? Bool == false || [400, 401, 403, 405, 413].contains(http.statusCode))
        }
        return try JSONDecoder().decode(T.self, from: data)
    }
    func list(account: String, cursor: String?, token: String) async throws -> CodexConversationPage {
        var query = [URLQueryItem(name: "account", value: account)]
        if let cursor { query.append(URLQueryItem(name: "cursor", value: cursor)) }
        return try await request("api/profiles/conversations", token: token, query: query)
    }
    func send(account: String, thread: String, text: String, submission: String, token: String) async throws -> CodexMessageReceipt {
        try await request("api/profiles/message", token: token, body: ["account": account, "threadId": thread,
            "text": text, "submissionId": submission])
    }
    func receipt(account: String, submission: String, token: String) async throws -> CodexMessageReceipt {
        try await request("api/profiles/message", token: token, query: [URLQueryItem(name: "account", value: account),
            URLQueryItem(name: "submissionId", value: submission)])
    }
}

struct CodexConversationError: LocalizedError {
    let code: String
    var notAccepted = false
    var errorDescription: String? {
        if code.contains("busy") || code.contains("active") { return Strings.t("conversations.busy") }
        if code.contains("quota") { return Strings.t("conversations.quotaUnavailable") }
        if code.contains("identity") || code.contains("account") || code.contains("location") { return Strings.t("conversations.accountUnavailable") }
        if code.contains("owner") || code.contains("host") { return Strings.t("conversations.hostUnavailable") }
        return Strings.t("conversations.unavailable")
    }
}

@MainActor final class CodexConversationsModel: ObservableObject {
    @Published var conversations: [CodexConversation] = []
    @Published var selectedID: String?
    @Published var draft = ""
    @Published var loading = false
    @Published var sending = false
    @Published var error: String?
    @Published var receipt: CodexMessageReceipt?
    @Published var nextCursor: String?
    let account: String
    private var client: CodexConversationsClient?
    private let defaults: UserDefaults
    private var pendingID: String?
    private var pendingThread: String?
    private var pendingText: String?
    private var pendingKey: String { "local.quotapie.pending-message." + account }
    init(account: String, defaults: UserDefaults = .standard) {
        self.account = account; self.defaults = defaults
        let saved = defaults.dictionary(forKey: "local.quotapie.pending-message." + account)
        if let id = saved?["submissionId"] as? String, UUID(uuidString: id) != nil,
           let thread = saved?["threadId"] as? String, UUID(uuidString: thread) != nil {
            pendingID = id; pendingThread = thread; selectedID = thread
            if let text = saved?["text"] as? String, !text.isEmpty, text.utf8.count <= 32_768 { pendingText = text }
        }
        let savedDraft = defaults.string(forKey: "local.quotapie.message-draft." + account) ?? ""
        draft = pendingText ?? (savedDraft.utf8.count <= 32_768 ? savedDraft : "")
    }
    var pending: Bool { pendingID != nil }
    var canRecheck: Bool { pending && pendingText != nil && !sending }
    var receiptExplanation: String? {
        guard let receipt, receipt.state == "failed", let reason = receipt.reason else { return nil }
        return CodexConversationError(code: reason).localizedDescription
    }
    func saveDraft() {
        // Oversized input stays editable, but never grows preferences without a bound.
        if draft.utf8.count <= 32_768 { defaults.set(draft, forKey: "local.quotapie.message-draft." + account) }
    }
    var canSend: Bool {
        !sending && !pending && selectedID != nil && !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty &&
            draft.utf8.count <= 32_768 && conversations.contains(where: { $0.id == selectedID && $0.active != true })
    }
    private func api() throws -> CodexConversationsClient {
        if let client { return client }
        let next = try CodexConversationsClient(); client = next; return next
    }
    func load(token: String, more: Bool = false) async {
        guard !loading else { return }
        loading = true; defer { loading = false }
        do {
            let page = try await api().list(account: account, cursor: more ? nextCursor : nil, token: token)
            guard page.account == account else { throw StatusClientError.invalidResponse }
            let rows = more ? conversations + page.conversations : page.conversations
            var seen = Set<String>()
            conversations = rows.filter { seen.insert($0.id).inserted }
            nextCursor = page.nextCursor; error = nil
        } catch { self.error = error.localizedDescription }
    }
    func send(token: String) async {
        guard !token.isEmpty else { error = StatusClientError.missingActionToken.localizedDescription; return }
        guard canSend, let thread = selectedID else { return }
        let id = UUID().uuidString.lowercased()
        // Persist the id before transport. A timeout must never create a second message.
        pendingID = id; pendingThread = thread; pendingText = draft
        defaults.set(["submissionId": id, "threadId": thread, "text": draft], forKey: pendingKey)
        saveDraft()
        sending = true; error = nil; receipt = nil
        defer { sending = false }
        do { try accept(await api().send(account: account, thread: thread, text: draft, submission: id, token: token)) }
        catch let error as CodexConversationError where error.notAccepted {
            pendingID = nil; pendingThread = nil; pendingText = nil; defaults.removeObject(forKey: pendingKey)
            self.error = error.localizedDescription
        } catch { self.error = Strings.t("conversations.deliveryUnknown") }
    }
    func recheckSubmission(token: String) async {
        guard !token.isEmpty, !sending, let id = pendingID, let thread = pendingThread, let text = pendingText else { return }
        // Repeat the exact idempotent submission, never create a new submission ID.
        // The server reconciles an existing intent and never enqueues it twice.
        sending = true; defer { sending = false }
        do { try accept(await api().send(account: account, thread: thread, text: text, submission: id, token: token)); error = nil }
        catch { self.error = Strings.t("conversations.deliveryUnknown") }
    }
    func refreshReceipt(token: String) async {
        guard let pendingID, !sending else { return }
        do { try accept(await api().receipt(account: account, submission: pendingID, token: token)); error = nil }
        catch { self.error = Strings.t("conversations.deliveryUnknown") }
    }
    private func accept(_ value: CodexMessageReceipt) throws {
        guard value.submissionId == pendingID, value.threadId == pendingThread,
              ["queued", "running", "completed", "failed", "uncertain"].contains(value.state) else { throw StatusClientError.invalidResponse }
        receipt = value
        if value.terminal {
            if value.state == "completed" { draft = ""; saveDraft() }
            pendingID = nil; pendingThread = nil; pendingText = nil; defaults.removeObject(forKey: pendingKey)
        }
    }
}
