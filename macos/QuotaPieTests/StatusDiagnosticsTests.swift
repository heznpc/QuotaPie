import Foundation
import XCTest
@testable import QuotaPie

final class StatusDiagnosticsTests: XCTestCase {
    private func diagnostic(_ json: String) throws -> String {
        do {
            _ = try JSONDecoder().decode(StatusPayload.self, from: Data(json.utf8))
            XCTFail("The invalid payload must remain a decoding failure")
            return ""
        } catch { return StatusFailure.diagnostic(error) }
    }

    func testDecodingDiagnosticsIdentifyTypedFieldsWithoutPrintingTheirValues() throws {
        let mismatch = try diagnostic(#"{"nowMs":"private-value"}"#)
        XCTAssertTrue(mismatch.contains("decoding=typeMismatch field=$.nowMs"))
        XCTAssertFalse(mismatch.contains("private-value"))
        let missing = try diagnostic(#"{"jobs":[{}]}"#)
        XCTAssertTrue(missing.contains("decoding=keyNotFound field=$.jobs[0].id"))
        let invalid = try diagnostic("not valid JSON private-value")
        XCTAssertTrue(invalid.contains("decoding=dataCorrupted field=$"))
        XCTAssertFalse(invalid.contains("private-value"))
    }

    func testDynamicDictionaryKeysAndUnderlyingErrorDetailsStayPrivate() throws {
        let summary = try diagnostic(#"{"accountPool":{"enabled":true,"accounts":[],"recent":[],"reservePercent":{"private-account-id":"private-value"}}}"#)
        XCTAssertTrue(summary.contains("field=$.accountPool.reservePercent[key]"))
        XCTAssertFalse(summary.contains("private-account-id"))
        XCTAssertFalse(summary.contains("private-value"))
        let numericKey = try diagnostic(#"{"accountPool":{"enabled":true,"accounts":[],"recent":[],"reservePercent":{"123456789":"private-value"}}}"#)
        XCTAssertTrue(numericKey.contains("field=$.accountPool.reservePercent[key]"))
        XCTAssertFalse(numericKey.contains("123456789"))
        let error = NSError(domain: NSURLErrorDomain, code: NSURLErrorTimedOut,
                            userInfo: [NSLocalizedDescriptionKey: "private-token"])
        XCTAssertEqual(StatusFailure.diagnostic(error), "kind=timeout code=-1001")
        XCTAssertTrue(StatusFailure.diagnostic(StatusClientError.httpStatus(503)).hasSuffix("http=503"))
    }

    /// An explicit local diagnostic, never a dependency of the normal test run.
    /// Exercises the same URLSession and StatusPayload decoder as the installed UI.
    func testLiveStatusDecodingWhenExplicitlyRequested() throws {
        guard ProcessInfo.processInfo.environment["QUOTAPIE_VERIFY_LIVE_STATUS"] == "1" else {
            throw XCTSkip("Set QUOTAPIE_VERIFY_LIVE_STATUS=1 for the live local-service check")
        }
        let client = try StatusClient()
        let completed = expectation(description: "Local status decoded")
        client.fetch { result in
            if case .failure(let error) = result { XCTFail(StatusFailure.diagnostic(error)) }
            completed.fulfill()
        }
        wait(for: [completed], timeout: 10)
    }
}
