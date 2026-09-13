import XCTest
@testable import QuotaPie

final class QuotaPieRouteTests: XCTestCase {
    func testTaskRouteOnlySelectsAnExactUUID() throws {
        let id = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
        XCTAssertEqual(QuotaPieRoute(url: try XCTUnwrap(URL(string: "quotapie://resume/\(id)"))), .resume(id))
        for value in ["quotapie://resume/\(id)?approve=true", "quotapie://resume/\(id)#run", "quotapie://resume/\(id)/extra",
                      "quotapie://user@resume/\(id)", "quotapie://resume:80/\(id)", "https://resume/\(id)",
                      "quotapie://resume/not-a-task", "quotapie://resume/%61aaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"] {
            XCTAssertNil(QuotaPieRoute(url: try XCTUnwrap(URL(string: value))), value)
        }
    }
}
