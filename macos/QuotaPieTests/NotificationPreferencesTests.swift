import Foundation
import XCTest
@testable import QuotaPie

final class NotificationPreferencesTests: XCTestCase {
    func testLateStatusCannotRevertSavedPreferencesButOtherStatusStillUpdates() throws {
        // Exercise fetches started both before and during a save, completing
        // after the save response. Neither may restore the old checkbox value.
        for duringSave in [false, true] {
            let model = PopoverModel()
            model.payload = try status(enabled: true, time: 1)
            var revision = model.notificationPreferencesRevision
            model.beginNotificationSave()
            if duringSave { revision = model.notificationPreferencesRevision }
            model.finishNotificationSave(try status(enabled: false, time: 2).notificationPreferences)
            model.applyStatus(try status(enabled: true, time: 3), notificationRevision: revision)
            XCTAssertEqual(model.payload?.notificationPreferences?.enabled, false)
            XCTAssertEqual(model.payload?.notificationPreferences?.topics["payments"], false)
            XCTAssertEqual(model.payload?.nowMs, 3)
            XCTAssertFalse(model.notificationSaving)

            // Fresh polls must still accept changes made by another client.
            model.applyStatus(try status(enabled: true, time: 4),
                              notificationRevision: model.notificationPreferencesRevision)
            XCTAssertEqual(model.payload?.notificationPreferences?.enabled, true)
        }
    }

    func testStatusDuringSaveDoesNotChangePreferences() throws {
        let model = PopoverModel()
        model.payload = try status(enabled: false, time: 1)
        model.beginNotificationSave()
        model.applyStatus(try status(enabled: true, time: 2),
                          notificationRevision: model.notificationPreferencesRevision)
        XCTAssertEqual(model.payload?.notificationPreferences?.enabled, false)
        XCTAssertEqual(model.payload?.nowMs, 2)
        XCTAssertTrue(model.notificationSaving)
        model.finishNotificationSave(try status(enabled: true, time: 3).notificationPreferences)
        XCTAssertEqual(model.payload?.notificationPreferences?.enabled, true)
    }

    func testFailedSavePreservesDisplayAndAllowsSubsequentReconciliation() throws {
        let model = PopoverModel()
        model.payload = try status(enabled: true, time: 1)
        model.beginNotificationSave()
        let revision = model.notificationPreferencesRevision
        model.finishNotificationSave(nil)
        model.applyStatus(try status(enabled: false, time: 2), notificationRevision: revision)
        XCTAssertEqual(model.payload?.notificationPreferences?.enabled, true)
        XCTAssertFalse(model.notificationSaving)
        // A lost POST response can still mean a successful server-side save.
        model.applyStatus(try status(enabled: false, time: 3),
                          notificationRevision: model.notificationPreferencesRevision)
        XCTAssertEqual(model.payload?.notificationPreferences?.enabled, false)
    }

    private func status(enabled: Bool, time: Int) throws -> StatusPayload {
        let json = """
        {"nowMs":\(time),"notificationPreferences":{"enabled":\(enabled),
          "topics":{"payments":\(enabled)},"desktopEnabled":true,"resetCollectionEnabled":true}}
        """
        return try JSONDecoder().decode(StatusPayload.self, from: Data(json.utf8))
    }
}
