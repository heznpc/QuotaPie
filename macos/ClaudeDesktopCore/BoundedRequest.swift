import Foundation

public final class BoundedRequest: NSObject, URLSessionDataDelegate {
    private var data = Data()
    private var continuation: CheckedContinuation<[String: Any], Error>?
    private var failure: DesktopFailure?
    private var session: URLSession?
    private let configuration: URLSessionConfiguration
    public override convenience init() { self.init(configuration: .ephemeral) }
    init(configuration: URLSessionConfiguration) { self.configuration = configuration; super.init() }
    public func load(_ request: URLRequest) async throws -> [String: Any] {
        try await withCheckedThrowingContinuation { continuation in
            self.continuation = continuation
            let config = configuration
            config.httpCookieStorage = nil
            config.httpShouldSetCookies = false
            config.urlCredentialStorage = nil
            config.urlCache = nil
            config.timeoutIntervalForRequest = 15
            config.timeoutIntervalForResource = 20
            let session = URLSession(configuration: config, delegate: self, delegateQueue: nil)
            self.session = session
            session.dataTask(with: request).resume()
        }
    }
    public func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        failure = DesktopFailure("auth-expired", "Claude session redirected; reconnect the desktop app")
        completionHandler(nil)
    }
    public func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse, completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        guard let response = response as? HTTPURLResponse, response.url?.host == "claude.ai", response.url?.scheme == "https" else {
            failure = DesktopFailure("provider-error", "Claude returned an invalid response"); completionHandler(.cancel); return
        }
        let code = response.statusCode
        if code != 200 {
            let category = code == 401 ? "auth-expired" : code == 403 ? "access-denied" : code == 429 ? "rate-limited" : "provider-error"
            failure = DesktopFailure(category, "Claude desktop usage request failed (HTTP \(code))")
        } else if response.expectedContentLength > 1_048_576 || response.mimeType != "application/json" {
            failure = DesktopFailure("provider-error", "Claude returned an unsupported response")
        }
        completionHandler(failure == nil ? .allow : .cancel)
    }
    public func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive chunk: Data) {
        guard data.count + chunk.count <= 1_048_576 else {
            failure = DesktopFailure("provider-error", "Claude response exceeded the size limit"); dataTask.cancel(); return
        }
        data.append(chunk)
    }
    public func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        defer { self.continuation = nil; session.finishTasksAndInvalidate(); self.session = nil }
        if let failure { continuation?.resume(throwing: failure); return }
        if error != nil { continuation?.resume(throwing: DesktopFailure("network", "Claude desktop usage endpoint is unavailable")); return }
        guard let payload = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            continuation?.resume(throwing: DesktopFailure("provider-error", "Claude returned an invalid usage response")); return
        }
        continuation?.resume(returning: payload)
    }
}
