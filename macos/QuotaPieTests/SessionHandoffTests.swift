import Foundation
import XCTest
@testable import QuotaPie

final class SessionHandoffTests: XCTestCase {
    private let id = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"

    func testModoreAndQuotaPieRoundTripWithoutRegisteredResumeTask() throws {
        // Must match Modore's WorkSessionLinkTests contract vector.
        XCTAssertEqual(SessionHandoff.modoreURL(threadID: id.uppercased())?.absoluteString,
                       "modore://work/session/codex/\(id)")
        XCTAssertEqual(QuotaPieRoute(url: URL(string: "quotapie://session/\(id)")!), .session(id))
        XCTAssertEqual(QuotaPieRoute(url: URL(string: "quotapie://resume/\(id)")!), .resume(id))
    }

    func testNavigationRejectsPathsAndActionParameters() {
        for input in ["", "../project", "not-a-uuid", id + "?account=other"] {
            XCTAssertNil(SessionHandoff.modoreURL(threadID: input))
        }
        for suffix in ["?execute=true", "#approval", "/", "/extra"] {
            XCTAssertNil(QuotaPieRoute(url: URL(string: "quotapie://session/\(id)\(suffix)")!))
        }
        for input in ["quotapie://user@session/\(id)", "quotapie://session:42/\(id)",
                      "quotapie://session/%61aaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"] {
            XCTAssertNil(QuotaPieRoute(url: URL(string: input)!))
        }
    }

    func testUntitledConversationsRemainDistinctAndSearchableByID() throws {
        let row = RequestAccountConversation(threadId: id, title: "   ", sourceAccount: "main",
                                             currentAccount: "main", targetAccount: nil, active: false)
        XCTAssertTrue(SessionHandoff.matches(row, query: "AAAAAAA"))
        XCTAssertTrue(SessionHandoff.matches(row, query: "  "))
        XCTAssertFalse(SessionHandoff.matches(row, query: "another-project"))
        let titled = RequestAccountConversation(threadId: id, title: "Modore service", sourceAccount: nil,
                                               currentAccount: nil, targetAccount: nil, active: false)
        XCTAssertTrue(SessionHandoff.matches(titled, query: "  MODORE  "))
    }
}
