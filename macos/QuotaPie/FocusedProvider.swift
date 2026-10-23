import AppKit

enum FocusedProvider: String {
    case codex, claude

    init?(bundleIdentifier: String?) {
        switch bundleIdentifier {
        case "com.openai.codex", "com.openai.chat": self = .codex
        case "com.anthropic.claudefordesktop": self = .claude
        default: return nil
        }
    }

    var title: String { self == .codex ? "Codex" : "Claude" }
}

extension PopoverModel {
    func followProvider(_ provider: FocusedProvider) {
        guard focusedProvider != provider else { return }
        focusedProvider = provider
        focusedConversationID = nil
        focusedConversationTitle = nil
        claudeSessionFingerprint = nil
    }

    var focusedClaudeAccount: AccountState? {
        guard let fingerprint = claudeSessionFingerprint else { return nil }
        let matches = enabledAccounts.filter {
            $0.isClaudeDesktop && $0.desktopSessionFingerprint == fingerprint
        }
        // Multiple bindings are ambiguous; a previously selected account is not evidence.
        return matches.count == 1 ? matches.first : nil
    }
}

/// Reads only the local session marker. No network, login UI, quota refresh or
/// credentials leave the fixed-function helper. A failed read clears attribution.
final class ClaudeFocusReader {
    private var busy = false
    private var lastAttempt = Date.distantPast

    func read(force: Bool = false, completion: @escaping (String?) -> Void) {
        guard !busy, force || Date().timeIntervalSince(lastAttempt) >= 10 else { return }
        busy = true
        lastAttempt = Date()
        let executable = Bundle.main.bundleURL.appendingPathComponent("Contents/Helpers/QuotaPieClaudeSessionHelper")
        DispatchQueue.global(qos: .utility).async {
            let process = Process()
            let output = Pipe()
            process.executableURL = executable
            process.arguments = ["--session-identity"]
            process.standardOutput = output
            process.standardError = FileHandle.nullDevice
            var fingerprint: String?
            do {
                try process.run()
                let timeout = DispatchWorkItem {
                    if process.isRunning { process.terminate() }
                }
                DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + 3, execute: timeout)
                process.waitUntilExit()
                timeout.cancel()
                let data = output.fileHandleForReading.readDataToEndOfFile()
                if process.terminationStatus == 0, data.count < 4096,
                   let reply = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                   reply["ok"] as? Bool == true, let value = reply["fingerprint"] as? String,
                   value.count == 64, value.allSatisfy({ "0123456789abcdef".contains($0) }) {
                    fingerprint = value
                }
            } catch { /* Unavailable identity must not select a fallback account. */ }
            let result = fingerprint
            DispatchQueue.main.async {
                self.busy = false
                completion(result)
            }
        }
    }
}
