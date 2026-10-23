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
guard arguments.isEmpty || arguments == ["--connect"] || arguments == ["--inspect-limits"] || arguments == ["--session-identity"] else {
    emit(["ok": false, "category": "provider-error", "error": "Unsupported helper arguments"]); exit(1)
}
Task {
    do {
        let initial = try DesktopSession.read(allowInteraction: arguments == ["--connect"])
        if arguments == ["--session-identity"] {
            emit(["ok": true, "fingerprint": initial.fingerprint])
            exit(0)
        }
        let bootstrap = try await BoundedRequest().load(initial.bootstrapRequest)
        let accountID = try verifiedAccount(bootstrap, organizationID: initial.organizationID)
        let plan = try verifiedPlan(bootstrap, organizationID: initial.organizationID)
        let usage = try await BoundedRequest().load(initial.usageRequest)
        var diagnostics: [String: Any]?
        if arguments == ["--inspect-limits"] {
            var value: [String: Any] = ["bootstrap": limitMetadata(bootstrap, organizationID: initial.organizationID)]
            do {
                let appStart = try await BoundedRequest().load(initial.appStartRequest)
                guard try verifiedAccount(appStart, organizationID: initial.organizationID) == accountID else {
                    throw DesktopFailure("account-mismatch", "Claude account changed during collection; reconnect")
                }
                value["appStart"] = limitMetadata(appStart, organizationID: initial.organizationID)
            } catch let failure as DesktopFailure {
                if ["account-mismatch", "auth-expired", "access-denied"].contains(failure.category) { throw failure }
                value["appStart"] = ["errorCategory": failure.category]
            }
            diagnostics = value
        }
        let current = try DesktopSession.read(allowInteraction: false)
        guard initial == current else { throw DesktopFailure("account-mismatch", "Claude account changed during collection; reconnect") }
        var output: [String: Any] = ["ok": true, "accountId": accountID, "organizationId": initial.organizationID, "plan": plan, "usage": try sanitizedUsage(usage)]
        output["access"] = (try? verifiedAccessSummary(bootstrap, organizationID: initial.organizationID)) ?? [:]
        output["sessionFingerprint"] = initial.fingerprint
        if let diagnostics { output["limitMetadata"] = diagnostics }
        emit(output)
        exit(0)
    } catch let failure as DesktopFailure {
        emit(["ok": false, "category": failure.category, "error": failure.message]); exit(1)
    } catch {
        emit(["ok": false, "category": "provider-error", "error": "Claude desktop collection failed"]); exit(1)
    }
}
dispatchMain()
