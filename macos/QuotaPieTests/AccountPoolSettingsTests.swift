import XCTest
@testable import QuotaPie

final class AccountPoolSettingsTests: XCTestCase {
    func testOldCollectorPayloadStillDecodesWithoutReserves() throws {
        let data = Data(#"{"accountPool":{"enabled":true,"accounts":["a","b"],"recent":[]}}"#.utf8)
        let payload = try JSONDecoder().decode(StatusPayload.self, from: data)
        let pool = try XCTUnwrap(payload.accountPool)
        XCTAssertNil(pool.reservePercent)
        XCTAssertEqual(pool.accounts, ["a", "b"])
    }

    func testSettingsReplyCarriesReservesAndTransferReason() throws {
        let data = Data(#"{"pool":{"enabled":true,"accounts":["a","b"],"reservePercent":{"a":30,"b":0},"recent":[{"sourceAccount":"a","account":"b","accountLabel":"Second","state":"completed","status":200,"atMs":1000,"reason":"reserve"}]}}"#.utf8)
        let response = try JSONDecoder().decode(AccountPoolResponse.self, from: data)
        XCTAssertEqual(response.pool.reservePercent, ["a": 30, "b": 0])
        XCTAssertEqual(response.pool.recent.first?.reason, "reserve")
        XCTAssertEqual(response.pool.recent.first?.account, "b")
    }
}
