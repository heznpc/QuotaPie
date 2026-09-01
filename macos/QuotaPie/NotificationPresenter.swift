import Foundation
import UserNotifications

protocol NotificationAPIClient: AnyObject {
    func claimNotification(
        actionToken: String,
        completion: @escaping (Result<NotificationClaimResponse, Error>) -> Void
    )

    func completeNotification(
        id: String,
        disposition: NotificationCompletionDisposition,
        claimToken: String,
        actionToken: String,
        completion: @escaping (Result<Void, Error>) -> Void
    )

    func renewNotification(
        id: String,
        claimToken: String,
        actionToken: String,
        completion: @escaping (Result<Void, Error>) -> Void
    )

    func releaseNotification(
        id: String,
        claimToken: String,
        actionToken: String,
        completion: @escaping (Result<Void, Error>) -> Void
    )
}

extension StatusClient: NotificationAPIClient {}

enum NativeNotificationAuthorization {
    case notDetermined
    case denied
    case authorized
    case provisional
}

struct NativeNotificationRequest {
    let identifier: String
    let title: String
    let body: String
    let notificationID: String
    let severity: String
}

protocol NativeNotificationScheduling: AnyObject {
    func authorizationStatus(completion: @escaping (NativeNotificationAuthorization) -> Void)
    func requestAlertAuthorization(completion: @escaping (Bool, Error?) -> Void)
    func add(_ request: NativeNotificationRequest, completion: @escaping (Error?) -> Void)
}

final class UserNotificationScheduler: NativeNotificationScheduling {
    private let center: UNUserNotificationCenter

    init(center: UNUserNotificationCenter = .current()) {
        self.center = center
    }

    func authorizationStatus(completion: @escaping (NativeNotificationAuthorization) -> Void) {
        center.getNotificationSettings { settings in
            switch settings.authorizationStatus {
            case .notDetermined: completion(.notDetermined)
            case .denied: completion(.denied)
            case .authorized, .ephemeral: completion(.authorized)
            case .provisional: completion(.provisional)
            @unknown default: completion(.denied)
            }
        }
    }

    func requestAlertAuthorization(completion: @escaping (Bool, Error?) -> Void) {
        center.requestAuthorization(options: [.alert], completionHandler: completion)
    }

    func add(_ request: NativeNotificationRequest, completion: @escaping (Error?) -> Void) {
        let content = UNMutableNotificationContent()
        content.title = request.title
        content.body = request.body
        content.sound = nil
        content.userInfo = [
            "notificationID": request.notificationID,
            "severity": request.severity,
        ]
        center.add(
            UNNotificationRequest(identifier: request.identifier, content: content, trigger: nil),
            withCompletionHandler: completion
        )
    }
}

protocol NotificationDeliveryLedger: AnyObject {
    func contains(_ notificationID: String, at date: Date) -> Bool
    func record(_ notificationID: String, at date: Date)
}

/// UserNotifications accepts a request before it is necessarily visible. This
/// small ledger closes the crash window between that acceptance and the daemon
/// acknowledgement, so reclaiming the same row cannot produce another banner.
final class UserDefaultsNotificationLedger: NotificationDeliveryLedger {
    private let defaults: UserDefaults
    private let storageKey: String
    private let maximumEntries: Int
    private let retentionInterval: TimeInterval

    init(
        defaults: UserDefaults = .standard,
        storageKey: String = "local.quotapie.notification-ledger.v1",
        maximumEntries: Int = 256,
        retentionInterval: TimeInterval = 30 * 24 * 60 * 60
    ) {
        self.defaults = defaults
        self.storageKey = storageKey
        self.maximumEntries = max(1, maximumEntries)
        self.retentionInterval = max(0, retentionInterval)
    }

    func contains(_ notificationID: String, at date: Date) -> Bool {
        var entries = load()
        let original = entries
        prune(&entries, at: date)
        if entries != original { save(entries) }
        return entries[notificationID] != nil
    }

    func record(_ notificationID: String, at date: Date) {
        var entries = load()
        prune(&entries, at: date)
        entries[notificationID] = date.timeIntervalSince1970
        trim(&entries)
        save(entries)
    }

    private func load() -> [String: TimeInterval] {
        guard let stored = defaults.dictionary(forKey: storageKey) else { return [:] }
        return stored.reduce(into: [:]) { result, item in
            if let value = item.value as? NSNumber {
                result[item.key] = value.doubleValue
            }
        }
    }

    private func prune(_ entries: inout [String: TimeInterval], at date: Date) {
        let cutoff = date.timeIntervalSince1970 - retentionInterval
        entries = entries.filter { $0.value >= cutoff }
        trim(&entries)
    }

    private func trim(_ entries: inout [String: TimeInterval]) {
        guard entries.count > maximumEntries else { return }
        let newest = entries
            .sorted { lhs, rhs in
                if lhs.value == rhs.value { return lhs.key < rhs.key }
                return lhs.value > rhs.value
            }
            .prefix(maximumEntries)
        entries = Dictionary(uniqueKeysWithValues: newest.map { ($0.key, $0.value) })
    }

    private func save(_ entries: [String: TimeInterval]) {
        defaults.set(entries, forKey: storageKey)
    }
}

private enum NotificationPresentationError: Error {
    case invalidIdentifier
}

/// Serially drains the daemon outbox. Every callback is re-entered on the main
/// queue so a status refresh, a claim, and a completion can never overlap.
final class NotificationPresenter: NSObject, UNUserNotificationCenterDelegate {
    private let client: NotificationAPIClient
    private let scheduler: NativeNotificationScheduling
    private let ledger: NotificationDeliveryLedger
    private let now: () -> Date
    private let openPopover: () -> Void
    private var actionToken: String?
    private var isDraining = false

    init(
        client: NotificationAPIClient,
        scheduler: NativeNotificationScheduling = UserNotificationScheduler(),
        ledger: NotificationDeliveryLedger = UserDefaultsNotificationLedger(),
        now: @escaping () -> Date = Date.init,
        openPopover: @escaping () -> Void
    ) {
        self.client = client
        self.scheduler = scheduler
        self.ledger = ledger
        self.now = now
        self.openPopover = openPopover
        super.init()
    }

    func statusDidRefresh(actionToken: String) {
        guard !actionToken.isEmpty else { return }
        onMain { [weak self] in
            guard let self else { return }
            self.actionToken = actionToken
            guard !self.isDraining else { return }
            self.isDraining = true
            self.claimNext()
        }
    }

    private func claimNext() {
        dispatchPrecondition(condition: .onQueue(.main))
        guard let actionToken, !actionToken.isEmpty else {
            stopDrain()
            return
        }
        client.claimNotification(actionToken: actionToken) { [weak self] result in
            self?.onMain {
                guard let self else { return }
                switch result {
                case .success(let response):
                    guard let notification = response.notification else {
                        self.stopDrain()
                        return
                    }
                    self.handle(notification, actionToken: actionToken)
                case .failure:
                    // A 404 is the expected compatibility response from an old
                    // daemon. Other transport errors also wait for the next
                    // successful status refresh rather than spinning here.
                    self.stopDrain()
                }
            }
        }
    }

    private func handle(_ notification: ClaimedNotification, actionToken: String) {
        dispatchPrecondition(condition: .onQueue(.main))
        let date = now()
        if ledger.contains(notification.id, at: date) {
            complete(notification, as: .scheduled, actionToken: actionToken)
            return
        }
        if notification.expiresAtMs <= date.timeIntervalSince1970 * 1_000 {
            complete(notification, as: .expired, actionToken: actionToken)
            return
        }
        guard UUID(uuidString: notification.id) != nil else {
            releaseAndStop(notification, actionToken: actionToken)
            return
        }

        scheduler.authorizationStatus { [weak self] status in
            self?.onMain {
                guard let self else { return }
                switch status {
                case .authorized, .provisional:
                    self.schedule(notification, actionToken: actionToken)
                case .denied:
                    self.complete(notification, as: .suppressed, actionToken: actionToken)
                case .notDetermined:
                    self.requestAuthorization(for: notification, actionToken: actionToken)
                }
            }
        }
    }

    private func requestAuthorization(for notification: ClaimedNotification, actionToken: String) {
        scheduler.requestAlertAuthorization { [weak self] granted, error in
            self?.onMain {
                guard let self else { return }
                if error != nil {
                    self.releaseAndStop(notification, actionToken: actionToken)
                } else if granted {
                    self.schedule(notification, actionToken: actionToken)
                } else {
                    self.complete(notification, as: .suppressed, actionToken: actionToken)
                }
            }
        }
    }

    private func schedule(_ notification: ClaimedNotification, actionToken: String) {
        let date = now()
        if notification.expiresAtMs <= date.timeIntervalSince1970 * 1_000 {
            complete(notification, as: .expired, actionToken: actionToken)
            return
        }
        if ledger.contains(notification.id, at: date) {
            complete(notification, as: .scheduled, actionToken: actionToken)
            return
        }
        guard UUID(uuidString: notification.id) != nil else {
            releaseAndStop(notification, actionToken: actionToken)
            return
        }
        // Authorization can remain open past the five-minute claim lease. A
        // compare-and-swap renewal immediately before presentation proves this
        // process still owns the row; otherwise another app instance may have
        // reclaimed and scheduled it already.
        client.renewNotification(
            id: notification.id,
            claimToken: notification.claimToken,
            actionToken: actionToken
        ) { [weak self] result in
            self?.onMain {
                guard let self else { return }
                switch result {
                case .success:
                    self.addAfterRenewal(notification, actionToken: actionToken)
                case .failure:
                    self.stopDrain()
                }
            }
        }
    }

    private func addAfterRenewal(_ notification: ClaimedNotification, actionToken: String) {
        let date = now()
        if notification.expiresAtMs <= date.timeIntervalSince1970 * 1_000 {
            complete(notification, as: .expired, actionToken: actionToken)
            return
        }
        if ledger.contains(notification.id, at: date) {
            complete(notification, as: .scheduled, actionToken: actionToken)
            return
        }
        let request = NativeNotificationRequest(
            identifier: notification.requestIdentifier,
            title: notification.title,
            body: notification.message,
            notificationID: notification.id,
            severity: notification.severity
        )
        scheduler.add(request) { [weak self] error in
            self?.onMain {
                guard let self else { return }
                if error != nil {
                    self.releaseAndStop(notification, actionToken: actionToken)
                    return
                }
                // Persist before acknowledging: if the process exits after this
                // line, a reclaimed notification is completed without re-adding.
                self.ledger.record(notification.id, at: self.now())
                self.complete(notification, as: .scheduled, actionToken: actionToken)
            }
        }
    }

    private func complete(
        _ notification: ClaimedNotification,
        as disposition: NotificationCompletionDisposition,
        actionToken: String
    ) {
        client.completeNotification(
            id: notification.id,
            disposition: disposition,
            claimToken: notification.claimToken,
            actionToken: actionToken
        ) { [weak self] result in
            self?.onMain {
                guard let self else { return }
                switch result {
                case .success: self.claimNext()
                case .failure: self.stopDrain()
                }
            }
        }
    }

    private func releaseAndStop(_ notification: ClaimedNotification, actionToken: String) {
        client.releaseNotification(
            id: notification.id,
            claimToken: notification.claimToken,
            actionToken: actionToken
        ) { [weak self] _ in
            self?.onMain { self?.stopDrain() }
        }
    }

    private func stopDrain() {
        dispatchPrecondition(condition: .onQueue(.main))
        isDraining = false
    }

    private func onMain(_ work: @escaping () -> Void) {
        if Thread.isMainThread {
            work()
        } else {
            DispatchQueue.main.async(execute: work)
        }
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .list])
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let finish = { [openPopover] in
            if response.actionIdentifier == UNNotificationDefaultActionIdentifier {
                openPopover()
            }
            completionHandler()
        }
        onMain(finish)
    }
}
