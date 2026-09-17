import Foundation
import XCTest
@testable import QuotaPie

final class SingleInstanceLockTests: XCTestCase {
    func testDuplicateIsRejectedAndLockIsReleasedWhenOwnerExits() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("quotapie-instance-\(UUID())")
        defer { try? FileManager.default.removeItem(at: directory) }
        var first: SingleInstanceLock? = SingleInstanceLock()
        XCTAssertTrue(try first!.acquire(at: directory))
        let second = SingleInstanceLock()
        XCTAssertFalse(try second.acquire(at: directory))
        first = nil
        XCTAssertTrue(try second.acquire(at: directory))
        XCTAssertTrue(try second.acquire(at: directory))
    }
}
