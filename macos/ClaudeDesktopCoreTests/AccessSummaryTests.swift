import XCTest
@testable import ClaudeDesktopCore

final class AccessSummaryTests: XCTestCase {
    func testSelectedOrganizationOnlyAndNoCredentialDisclosure() throws {
        let account = UUID().uuidString.lowercased(), org = UUID().uuidString.lowercased()
        let payload: [String: Any] = ["account": ["uuid": account, "email_address": "me@example.com", "sessionKey": "private",
            "memberships": [["role": "member", "organization": ["uuid": org, "name": "Team"]],
                            ["role": "admin", "organization": ["uuid": UUID().uuidString, "name": "Other"]]]]]
        let result = try verifiedAccessSummary(payload, organizationID: org)
        XCTAssertEqual(result["organizationName"] as? String, "Team")
        XCTAssertEqual(result["role"] as? String, "member")
        XCTAssertEqual(result["email"] as? String, "me@example.com")
        XCTAssertEqual(result.count, 3)
        XCTAssertThrowsError(try verifiedAccessSummary(payload, organizationID: UUID().uuidString))
    }
}
