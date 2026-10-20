import Foundation
import XCTest
@testable import QuotaPie

final class CodexConversationsTests: XCTestCase {
    @MainActor
    func testPendingSubmissionSurvivesReopenAndCannotBecomeAnotherSend() throws {
        let suite = "quota-conversations-" + UUID().uuidString
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let thread = UUID().uuidString.lowercased(), submission = UUID().uuidString.lowercased()
        defaults.set(["submissionId": submission, "threadId": thread],
                     forKey: "local.quotapie.pending-message.second")
        defaults.set("Continue the existing task.", forKey: "local.quotapie.message-draft.second")

        for _ in 0..<2 {
            let model = CodexConversationsModel(account: "second", defaults: defaults)
            model.conversations = [CodexConversation(id: thread, title: "Existing conversation", active: false, updatedAt: 1)]
            XCTAssertEqual(model.draft, "Continue the existing task.", "The text must survive a rejected result after reopening")
            XCTAssertEqual(model.selectedID, thread)
            XCTAssertTrue(model.pending)
            XCTAssertFalse(model.canRecheck, "Legacy IDs without the original text may poll receipts but must never reconstruct a message from a draft")
            XCTAssertFalse(model.canSend, "A reopened sheet must resolve the original receipt before offering another send")
        }
        let otherAccount = CodexConversationsModel(account: "primary", defaults: defaults)
        XCTAssertFalse(otherAccount.pending, "Receipt ownership must remain scoped to the selected account")
        XCTAssertNil(otherAccount.selectedID)
        XCTAssertEqual(otherAccount.draft, "")
    }

    @MainActor
    func testSendRequiresSelectedKnownInactiveConversationAndNonemptyText() throws {
        let suite = "quota-conversations-" + UUID().uuidString
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let model = CodexConversationsModel(account: "second", defaults: defaults)
        let thread = UUID().uuidString.lowercased()
        model.selectedID = thread
        model.draft = "Continue the existing task."
        XCTAssertFalse(model.canSend, "A restored or forged selection is not sufficient without a catalogue entry")
        model.conversations = [CodexConversation(id: thread, title: nil, active: true, updatedAt: nil)]
        XCTAssertFalse(model.canSend, "An observed active turn must not accept parallel user work")
        model.conversations = [CodexConversation(id: thread, title: nil, active: false, updatedAt: nil)]
        XCTAssertTrue(model.canSend)
        model.sending = true
        XCTAssertFalse(model.canSend)
        model.sending = false
        model.draft = " \n\t "
        XCTAssertFalse(model.canSend)
    }

    @MainActor
    func testMessageSizeUsesUTF8BytesToMatchQueueAPI() throws {
        let suite = "quota-conversations-" + UUID().uuidString
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let model = CodexConversationsModel(account: "second", defaults: defaults)
        let thread = UUID().uuidString.lowercased()
        model.selectedID = thread
        model.conversations = [CodexConversation(id: thread, title: nil, active: false, updatedAt: nil)]
        model.draft = String(repeating: "가", count: 10_922) + "ab"
        XCTAssertEqual(model.draft.utf8.count, 32_768)
        XCTAssertTrue(model.canSend)
        model.draft += "c"
        XCTAssertFalse(model.canSend, "Character count would incorrectly admit an oversized non-ASCII message")
    }

    func testUnknownDeliveryIsNotTerminalAndCannotBeReportedAsCompleted() throws {
        for state in ["queued", "running", "uncertain", "unknown"] {
            let receipt = CodexMessageReceipt(submissionId: "submission", threadId: "thread", state: state, reason: nil)
            XCTAssertFalse(receipt.terminal, "Only a conclusive host result may release the duplicate-send fence")
        }
        XCTAssertTrue(CodexMessageReceipt(submissionId: "submission", threadId: "thread", state: "completed", reason: nil).terminal)
        XCTAssertTrue(CodexMessageReceipt(submissionId: "submission", threadId: "thread", state: "failed", reason: nil).terminal)
    }

    @MainActor
    func testFailedReceiptExplainsIdentitySeparatelyFromQuota() throws {
        let suite = "quota-conversations-" + UUID().uuidString
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let model = CodexConversationsModel(account: "second", defaults: defaults)
        model.receipt = CodexMessageReceipt(submissionId: "submission", threadId: "thread", state: "failed", reason: "profile_identity_changed")
        XCTAssertEqual(model.receiptExplanation, Strings.t("conversations.accountUnavailable"))
        model.receipt = CodexMessageReceipt(submissionId: "submission", threadId: "thread", state: "failed", reason: "profile_pool_quota_unavailable")
        XCTAssertEqual(model.receiptExplanation, Strings.t("conversations.quotaUnavailable"))
        model.receipt = CodexMessageReceipt(submissionId: "submission", threadId: "thread", state: "running", reason: "profile_identity_changed")
        XCTAssertNil(model.receiptExplanation, "A nonterminal state must not be labelled as a concluded failure")
    }

    @MainActor
    func testMissingActionTokenNeverCreatesAnUnresolvablePendingSubmission() async throws {
        let suite = "quota-conversations-" + UUID().uuidString
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let model = CodexConversationsModel(account: "second", defaults: defaults)
        let thread = UUID().uuidString.lowercased()
        model.selectedID = thread
        model.conversations = [CodexConversation(id: thread, title: nil, active: false, updatedAt: nil)]
        model.draft = "Continue the existing task."
        await model.send(token: "")
        XCTAssertFalse(model.pending)
        XCTAssertNil(defaults.object(forKey: "local.quotapie.pending-message.second"))
        XCTAssertEqual(model.draft, "Continue the existing task.")
        XCTAssertNotNil(model.error)
    }

    @MainActor
    func testOversizedDraftDoesNotGrowPreferencesOrRestoreAsSendableInput() throws {
        let suite = "quota-conversations-" + UUID().uuidString
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let key = "local.quotapie.message-draft.second"
        let model = CodexConversationsModel(account: "second", defaults: defaults)
        model.draft = "Preserved text"
        model.saveDraft()
        model.draft = String(repeating: "가", count: 12_000)
        model.saveDraft()
        XCTAssertEqual(defaults.string(forKey: key), "Preserved text")
        XCTAssertEqual(model.draft.utf8.count, 36_000, "Do not silently truncate the user's editable input")
        defaults.set(model.draft, forKey: key)
        let reopened = CodexConversationsModel(account: "second", defaults: defaults)
        XCTAssertEqual(reopened.draft, "")
        XCTAssertFalse(reopened.canSend)
    }

    @MainActor
    func testRecheckRestoresExactTextFromTheSamePendingRecordInsteadOfAnOlderDraft() throws {
        let suite = "quota-conversations-" + UUID().uuidString
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let thread = UUID().uuidString.lowercased(), submission = UUID().uuidString.lowercased()
        let text = "  Exact current message\n한글  "
        defaults.set(["submissionId": submission, "threadId": thread, "text": text],
                     forKey: "local.quotapie.pending-message.second")
        defaults.set("Older unrelated draft", forKey: "local.quotapie.message-draft.second")
        let model = CodexConversationsModel(account: "second", defaults: defaults)
        XCTAssertEqual(model.draft, text)
        XCTAssertEqual(model.selectedID, thread)
        XCTAssertTrue(model.canRecheck)
        XCTAssertFalse(model.canSend)
        model.sending = true
        XCTAssertFalse(model.canRecheck)
    }
}
