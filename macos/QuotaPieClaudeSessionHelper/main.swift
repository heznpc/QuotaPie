import Foundation
import ClaudeDesktopCore

// A separate, fixed-function process bounds both Keychain interaction and
// networking without blocking the collector or touching the running Claude app.

func emit(_ value: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) {
        FileHandle.standardOutput.write(data); FileHandle.standardOutput.write(Data([10]))
    }
}

let arguments = Array(CommandLine.arguments.dropFirst())
guard arguments.isEmpty || arguments == ["--connect"] else {
    emit(["ok": false, "category": "provider-error", "error": "Unsupported helper arguments"]); exit(1)
}
Task {
    do {
        let initial = try DesktopSession.read(allowInteraction: arguments == ["--connect"])
        let bootstrap = try await BoundedRequest().load(initial.bootstrapRequest)
        let accountID = try verifiedAccount(bootstrap, organizationID: initial.organizationID)
        let usage = try await BoundedRequest().load(initial.usageRequest)
        let current = try DesktopSession.read(allowInteraction: false)
        guard initial == current else { throw DesktopFailure("account-mismatch", "Claude account changed during collection; reconnect") }
        emit(["ok": true, "accountId": accountID, "organizationId": initial.organizationID, "usage": try sanitizedUsage(usage)])
        exit(0)
    } catch let failure as DesktopFailure {
        emit(["ok": false, "category": failure.category, "error": failure.message]); exit(1)
    } catch {
        emit(["ok": false, "category": "provider-error", "error": "Claude desktop collection failed"]); exit(1)
    }
}
dispatchMain()
