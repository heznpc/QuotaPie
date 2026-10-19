import XCTest
@testable import ClaudeDesktopCore

private final class UsageProtocol: URLProtocol {
    static var status = 200
    static var body = Data("{}".utf8)
    static var length: Int?
    static var requests = 0
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.requests += 1
        var headers = ["Content-Type": "application/json"]
        if let length = Self.length { headers["Content-Length"] = String(length) }
        let response = HTTPURLResponse(url: request.url!, statusCode: Self.status, httpVersion: nil, headerFields: headers)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Self.body)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

final class BoundedRequestTests: XCTestCase {
    private func loader() -> BoundedRequest {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [UsageProtocol.self]
        return BoundedRequest(configuration: config)
    }
    private var request: URLRequest { URLRequest(url: URL(string: "https://claude.ai/api/bootstrap")!) }
    override func setUp() {
        UsageProtocol.status = 200; UsageProtocol.body = Data("{}".utf8); UsageProtocol.length = nil; UsageProtocol.requests = 0
    }
    func testSuccess() async throws {
        let payload = try await loader().load(request)
        XCTAssertEqual(payload.count, 0)
    }
    func testStatusCategoriesDoNotExposeResponseBody() async {
        for (code, category) in [(401, "auth-expired"), (403, "access-denied"), (429, "rate-limited"), (500, "provider-error")] {
            UsageProtocol.status = code; UsageProtocol.body = Data("private-token-in-body".utf8)
            do { _ = try await loader().load(request); XCTFail("Expected failure") }
            catch let failure as DesktopFailure {
                XCTAssertEqual(failure.category, category)
                XCTAssertFalse(failure.message.contains("private-token"))
            } catch { XCTFail("Unsanitized error") }
        }
    }
    func testOversizeBodyAndDeclaredLengthAreRejected() async {
        for declared in [false, true] {
            UsageProtocol.body = Data(repeating: 32, count: declared ? 2 : 1_048_577)
            UsageProtocol.length = declared ? 1_048_577 : nil
            do { _ = try await loader().load(request); XCTFail("Expected size rejection") }
            catch let failure as DesktopFailure { XCTAssertEqual(failure.category, "provider-error") }
            catch { XCTFail("Unsanitized error") }
        }
    }
    func testInvalidJSONHasStaticDiagnostic() async {
        UsageProtocol.body = Data("private-token-is-not-json".utf8)
        do { _ = try await loader().load(request); XCTFail("Expected schema rejection") }
        catch let failure as DesktopFailure { XCTAssertEqual(failure.message, "Claude returned an invalid usage response") }
        catch { XCTFail("Unsanitized error") }
    }
    func testRedirectNeverForwardsCookies() {
        let session = URLSession(configuration: .ephemeral)
        defer { session.invalidateAndCancel() }
        let task = session.dataTask(with: request)
        let response = HTTPURLResponse(url: request.url!, statusCode: 302, httpVersion: nil, headerFields: ["Location": "https://example.com"])!
        var called = false
        loader().urlSession(session, task: task, willPerformHTTPRedirection: response,
            newRequest: URLRequest(url: URL(string: "https://example.com")!)) { redirected in
                called = true; XCTAssertNil(redirected)
            }
        XCTAssertTrue(called)
        XCTAssertEqual(UsageProtocol.requests, 0)
    }
}
