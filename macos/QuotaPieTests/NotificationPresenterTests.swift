import Foundation
import XCTest
@testable import QuotaPie

final class NotificationPresenterTests: XCTestCase {
    private let fixedNow = Date(timeIntervalSince1970: 2_000_000_000)

    func testDuplicateClaimIsAcknowledgedFromLedgerWithoutAddingTwice() {
        let notification = makeNotification()
        let client = FakeNotificationClient(claims: [
            .success(NotificationClaimResponse(notification: notification)),
            .success(NotificationClaimResponse(notification: notification)),
            .success(NotificationClaimResponse(notification: nil)),
        ])
        let scheduler = FakeNotificationScheduler(status: .authorized)
        let ledger = InMemoryNotificationLedger()
        let drained = expectation(description: "outbox drained")
        client.onClaim = { count in
            if count == 3 { drained.fulfill() }
        }
        client.onComplete = { _, _, count in
            if count == 1 {
                XCTAssertTrue(ledger.contains(notification.id, at: self.fixedNow))
            }
        }

        let presenter = makePresenter(client: client, scheduler: scheduler, ledger: ledger)
        presenter.statusDidRefresh(actionToken: "action-token")
        wait(for: [drained], timeout: 1)

        XCTAssertEqual(scheduler.added.count, 1)
        XCTAssertEqual(
            scheduler.added.first?.identifier,
            "local.quotapie.notification.11111111-1111-4111-8111-111111111111"
        )
        XCTAssertEqual(client.completions.map(\.disposition), [.scheduled, .scheduled])
        XCTAssertTrue(client.releases.isEmpty)
    }

    func testDeniedAuthorizationCompletesAsSuppressed() {
        let notification = makeNotification()
        let client = FakeNotificationClient(claims: [
            .success(NotificationClaimResponse(notification: notification)),
            .success(NotificationClaimResponse(notification: nil)),
        ])
        let scheduler = FakeNotificationScheduler(status: .denied)
        let ledger = InMemoryNotificationLedger()
        let drained = expectation(description: "outbox drained")
        client.onClaim = { count in
            if count == 2 { drained.fulfill() }
        }

        let presenter = makePresenter(client: client, scheduler: scheduler, ledger: ledger)
        presenter.statusDidRefresh(actionToken: "action-token")
        wait(for: [drained], timeout: 1)

        XCTAssertEqual(client.completions.map(\.disposition), [.suppressed])
        XCTAssertTrue(scheduler.added.isEmpty)
        XCTAssertTrue(client.releases.isEmpty)
    }

    func testExpiredClaimCompletesWithoutConsultingNotificationSettings() {
        let notification = makeNotification(expiresAtMs: fixedNow.timeIntervalSince1970 * 1_000 - 1)
        let client = FakeNotificationClient(claims: [
            .success(NotificationClaimResponse(notification: notification)),
            .success(NotificationClaimResponse(notification: nil)),
        ])
        let scheduler = FakeNotificationScheduler(status: .authorized)
        let ledger = InMemoryNotificationLedger()
        let drained = expectation(description: "outbox drained")
        client.onClaim = { count in
            if count == 2 { drained.fulfill() }
        }

        let presenter = makePresenter(client: client, scheduler: scheduler, ledger: ledger)
        presenter.statusDidRefresh(actionToken: "action-token")
        wait(for: [drained], timeout: 1)

        XCTAssertEqual(client.completions.map(\.disposition), [.expired])
        XCTAssertEqual(scheduler.settingsRequests, 0)
        XCTAssertTrue(scheduler.added.isEmpty)
    }

    func testAddFailureReleasesClaimAndStopsDrain() {
        let notification = makeNotification()
        let client = FakeNotificationClient(claims: [
            .success(NotificationClaimResponse(notification: notification)),
            .success(NotificationClaimResponse(notification: nil)),
        ])
        let scheduler = FakeNotificationScheduler(
            status: .authorized,
            addResults: [TestFailure.expected]
        )
        let ledger = InMemoryNotificationLedger()
        let released = expectation(description: "claim released")
        client.onRelease = { _, count in
            if count == 1 { released.fulfill() }
        }

        let presenter = makePresenter(client: client, scheduler: scheduler, ledger: ledger)
        presenter.statusDidRefresh(actionToken: "action-token")
        wait(for: [released], timeout: 1)

        XCTAssertEqual(client.claimCount, 1)
        XCTAssertEqual(client.releases.first?.claimToken, notification.claimToken)
        XCTAssertTrue(client.completions.isEmpty)
        XCTAssertFalse(ledger.contains(notification.id, at: fixedNow))
    }

    func testAcknowledgementFailureUsesLedgerOnNextStatusWithoutReadding() {
        let notification = makeNotification()
        let client = FakeNotificationClient(
            claims: [
                .success(NotificationClaimResponse(notification: notification)),
                .success(NotificationClaimResponse(notification: notification)),
                .success(NotificationClaimResponse(notification: nil)),
            ],
            completionResults: [.failure(TestFailure.expected), .success(())]
        )
        let scheduler = FakeNotificationScheduler(status: .authorized)
        let ledger = InMemoryNotificationLedger()
        let firstAcknowledgement = expectation(description: "first acknowledgement attempted")
        let drained = expectation(description: "second drain completed")
        client.onComplete = { _, _, count in
            if count == 1 { firstAcknowledgement.fulfill() }
        }
        client.onClaim = { count in
            if count == 3 { drained.fulfill() }
        }

        let presenter = makePresenter(client: client, scheduler: scheduler, ledger: ledger)
        presenter.statusDidRefresh(actionToken: "action-token")
        wait(for: [firstAcknowledgement], timeout: 1)
        XCTAssertEqual(client.claimCount, 1)
        XCTAssertTrue(ledger.contains(notification.id, at: fixedNow))

        presenter.statusDidRefresh(actionToken: "action-token")
        wait(for: [drained], timeout: 1)

        XCTAssertEqual(scheduler.added.count, 1)
        XCTAssertEqual(client.completions.map(\.disposition), [.scheduled, .scheduled])
    }

    func testNotDeterminedRequestsAlertAuthorizationBeforeAdding() {
        let notification = makeNotification()
        let client = FakeNotificationClient(claims: [
            .success(NotificationClaimResponse(notification: notification)),
            .success(NotificationClaimResponse(notification: nil)),
        ])
        let scheduler = FakeNotificationScheduler(status: .notDetermined, authorizationResult: (true, nil))
        let ledger = InMemoryNotificationLedger()
        let drained = expectation(description: "outbox drained")
        client.onClaim = { count in
            if count == 2 { drained.fulfill() }
        }

        let presenter = makePresenter(client: client, scheduler: scheduler, ledger: ledger)
        presenter.statusDidRefresh(actionToken: "action-token")
        wait(for: [drained], timeout: 1)

        XCTAssertEqual(scheduler.authorizationRequests, 1)
        XCTAssertEqual(scheduler.added.count, 1)
        XCTAssertEqual(client.completions.map(\.disposition), [.scheduled])
    }

    func testAuthorizationDelayCannotScheduleAnExpiredNotification() {
        let notification = makeNotification(
            expiresAtMs: fixedNow.timeIntervalSince1970 * 1_000 + 30_000
        )
        let client = FakeNotificationClient(claims: [
            .success(NotificationClaimResponse(notification: notification)),
            .success(NotificationClaimResponse(notification: nil)),
        ])
        let scheduler = FakeNotificationScheduler(status: .notDetermined, authorizationResult: (true, nil))
        let ledger = InMemoryNotificationLedger()
        let drained = expectation(description: "expired claim completed")
        client.onClaim = { count in
            if count == 2 { drained.fulfill() }
        }
        var clockReads = 0

        let presenter = makePresenter(
            client: client,
            scheduler: scheduler,
            ledger: ledger,
            now: {
                clockReads += 1
                return clockReads == 1 ? self.fixedNow : self.fixedNow.addingTimeInterval(31)
            }
        )
        presenter.statusDidRefresh(actionToken: "action-token")
        wait(for: [drained], timeout: 1)

        XCTAssertEqual(client.completions.map(\.disposition), [.expired])
        XCTAssertTrue(client.renewals.isEmpty)
        XCTAssertTrue(scheduler.added.isEmpty)
    }

    func testRenewalRechecksLedgerBeforeScheduling() {
        let notification = makeNotification()
        let client = FakeNotificationClient(claims: [
            .success(NotificationClaimResponse(notification: notification)),
            .success(NotificationClaimResponse(notification: nil)),
        ])
        let scheduler = FakeNotificationScheduler(status: .authorized)
        let ledger = InMemoryNotificationLedger()
        let drained = expectation(description: "duplicate completed from ledger")
        client.onRenew = { _ in
            ledger.record(notification.id, at: self.fixedNow)
        }
        client.onClaim = { count in
            if count == 2 { drained.fulfill() }
        }

        let presenter = makePresenter(client: client, scheduler: scheduler, ledger: ledger)
        presenter.statusDidRefresh(actionToken: "action-token")
        wait(for: [drained], timeout: 1)

        XCTAssertEqual(client.renewals.map(\.claimToken), [notification.claimToken])
        XCTAssertEqual(client.completions.map(\.disposition), [.scheduled])
        XCTAssertTrue(scheduler.added.isEmpty)
    }

    func testOldDaemon404StopsSilentlyAndAllowsLaterStatusToRetry() {
        let client = FakeNotificationClient(claims: [
            .failure(StatusClientError.httpStatus(404)),
            .success(NotificationClaimResponse(notification: nil)),
        ])
        let scheduler = FakeNotificationScheduler(status: .authorized)
        let ledger = InMemoryNotificationLedger()
        let firstClaim = expectation(description: "old daemon claim attempted")
        let secondClaim = expectation(description: "later status retries")
        client.onClaim = { count in
            if count == 1 { firstClaim.fulfill() }
            if count == 2 { secondClaim.fulfill() }
        }

        let presenter = makePresenter(client: client, scheduler: scheduler, ledger: ledger)
        presenter.statusDidRefresh(actionToken: "action-token")
        wait(for: [firstClaim], timeout: 1)
        presenter.statusDidRefresh(actionToken: "action-token")
        wait(for: [secondClaim], timeout: 1)

        XCTAssertTrue(client.completions.isEmpty)
        XCTAssertTrue(client.releases.isEmpty)
        XCTAssertTrue(scheduler.added.isEmpty)
    }

    func testUserDefaultsLedgerPrunesByAgeAndBoundsEntryCount() {
        let suiteName = "NotificationPresenterTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName)!
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let ledger = UserDefaultsNotificationLedger(
            defaults: defaults,
            storageKey: "ledger",
            maximumEntries: 2,
            retentionInterval: 100
        )
        let now = Date(timeIntervalSince1970: 1_000)

        ledger.record("old", at: Date(timeIntervalSince1970: 800))
        ledger.record("first", at: Date(timeIntervalSince1970: 990))
        ledger.record("second", at: now)

        XCTAssertFalse(ledger.contains("old", at: now))
        XCTAssertTrue(ledger.contains("first", at: now))
        XCTAssertTrue(ledger.contains("second", at: now))
        XCTAssertEqual(defaults.dictionary(forKey: "ledger")?.count, 2)
    }

    private func makePresenter(
        client: FakeNotificationClient,
        scheduler: FakeNotificationScheduler,
        ledger: NotificationDeliveryLedger,
        now: (() -> Date)? = nil
    ) -> NotificationPresenter {
        NotificationPresenter(
            client: client,
            scheduler: scheduler,
            ledger: ledger,
            now: now ?? { self.fixedNow },
            openPopover: {}
        )
    }

    private func makeNotification(
        id: String = "11111111-1111-4111-8111-111111111111",
        expiresAtMs: Double? = nil
    ) -> ClaimedNotification {
        ClaimedNotification(
            id: id,
            title: "Quota available",
            message: "The weekly window is available again.",
            severity: "info",
            createdAtMs: fixedNow.timeIntervalSince1970 * 1_000 - 1_000,
            expiresAtMs: expiresAtMs ?? fixedNow.timeIntervalSince1970 * 1_000 + 60_000,
            claimToken: "claim-token"
        )
    }
}

private enum TestFailure: Error {
    case expected
}

private final class InMemoryNotificationLedger: NotificationDeliveryLedger {
    private var notificationIDs: Set<String> = []

    func contains(_ notificationID: String, at date: Date) -> Bool {
        notificationIDs.contains(notificationID)
    }

    func record(_ notificationID: String, at date: Date) {
        notificationIDs.insert(notificationID)
    }
}

private final class FakeNotificationScheduler: NativeNotificationScheduling {
    let status: NativeNotificationAuthorization
    var authorizationResult: (Bool, Error?)
    var addResults: [Error?]
    private(set) var settingsRequests = 0
    private(set) var authorizationRequests = 0
    private(set) var added: [NativeNotificationRequest] = []

    init(
        status: NativeNotificationAuthorization,
        authorizationResult: (Bool, Error?) = (false, nil),
        addResults: [Error?] = []
    ) {
        self.status = status
        self.authorizationResult = authorizationResult
        self.addResults = addResults
    }

    func authorizationStatus(completion: @escaping (NativeNotificationAuthorization) -> Void) {
        settingsRequests += 1
        DispatchQueue.main.async { completion(self.status) }
    }

    func requestAlertAuthorization(completion: @escaping (Bool, Error?) -> Void) {
        authorizationRequests += 1
        let result = authorizationResult
        DispatchQueue.main.async { completion(result.0, result.1) }
    }

    func add(_ request: NativeNotificationRequest, completion: @escaping (Error?) -> Void) {
        added.append(request)
        let result = addResults.isEmpty ? nil : addResults.removeFirst()
        DispatchQueue.main.async { completion(result) }
    }
}

private final class FakeNotificationClient: NotificationAPIClient {
    struct CompletionRecord {
        let id: String
        let disposition: NotificationCompletionDisposition
        let claimToken: String
        let actionToken: String
    }

    struct ReleaseRecord {
        let id: String
        let claimToken: String
        let actionToken: String
    }

    struct RenewalRecord {
        let id: String
        let claimToken: String
        let actionToken: String
    }

    var claims: [Result<NotificationClaimResponse, Error>]
    var completionResults: [Result<Void, Error>]
    var releaseResults: [Result<Void, Error>]
    var renewalResults: [Result<Void, Error>]
    var onClaim: ((Int) -> Void)?
    var onComplete: ((NotificationCompletionDisposition, String, Int) -> Void)?
    var onRelease: ((String, Int) -> Void)?
    var onRenew: ((Int) -> Void)?
    private(set) var claimCount = 0
    private(set) var completions: [CompletionRecord] = []
    private(set) var releases: [ReleaseRecord] = []
    private(set) var renewals: [RenewalRecord] = []

    init(
        claims: [Result<NotificationClaimResponse, Error>],
        completionResults: [Result<Void, Error>] = [],
        releaseResults: [Result<Void, Error>] = [],
        renewalResults: [Result<Void, Error>] = []
    ) {
        self.claims = claims
        self.completionResults = completionResults
        self.releaseResults = releaseResults
        self.renewalResults = renewalResults
    }

    func claimNotification(
        actionToken: String,
        completion: @escaping (Result<NotificationClaimResponse, Error>) -> Void
    ) {
        claimCount += 1
        let count = claimCount
        let result = claims.isEmpty
            ? .success(NotificationClaimResponse(notification: nil))
            : claims.removeFirst()
        DispatchQueue.main.async {
            completion(result)
            self.onClaim?(count)
        }
    }

    func completeNotification(
        id: String,
        disposition: NotificationCompletionDisposition,
        claimToken: String,
        actionToken: String,
        completion: @escaping (Result<Void, Error>) -> Void
    ) {
        completions.append(CompletionRecord(
            id: id,
            disposition: disposition,
            claimToken: claimToken,
            actionToken: actionToken
        ))
        let count = completions.count
        let result = completionResults.isEmpty ? .success(()) : completionResults.removeFirst()
        DispatchQueue.main.async {
            completion(result)
            self.onComplete?(disposition, claimToken, count)
        }
    }

    func releaseNotification(
        id: String,
        claimToken: String,
        actionToken: String,
        completion: @escaping (Result<Void, Error>) -> Void
    ) {
        releases.append(ReleaseRecord(id: id, claimToken: claimToken, actionToken: actionToken))
        let count = releases.count
        let result = releaseResults.isEmpty ? .success(()) : releaseResults.removeFirst()
        DispatchQueue.main.async {
            completion(result)
            self.onRelease?(claimToken, count)
        }
    }

    func renewNotification(
        id: String,
        claimToken: String,
        actionToken: String,
        completion: @escaping (Result<Void, Error>) -> Void
    ) {
        renewals.append(RenewalRecord(id: id, claimToken: claimToken, actionToken: actionToken))
        let count = renewals.count
        let result = renewalResults.isEmpty ? .success(()) : renewalResults.removeFirst()
        DispatchQueue.main.async {
            self.onRenew?(count)
            completion(result)
        }
    }
}
