import Foundation
import SwiftUI

/// Runs from bundled files even when the collector or relay API is unavailable.
enum OriginalConnectionRecovery {
    static func restore(completion: @escaping (Result<URL, Error>) -> Void) {
        DispatchQueue.global(qos: .userInitiated).async {
            let result = Result<URL, Error> {
                guard let script = Bundle.main.url(forResource: "restore-original-connection", withExtension: "py") else {
                    throw RecoveryError(message: Strings.t("connectionRecovery.missing"))
                }
                let candidates = ["/opt/homebrew/bin/python3", "/usr/local/bin/python3", "/usr/bin/python3"]
                guard let python = candidates.first(where: { FileManager.default.isExecutableFile(atPath: $0) }) else {
                    throw RecoveryError(message: Strings.t("connectionRecovery.missing"))
                }
                let process = Process()
                let output = Pipe()
                process.executableURL = URL(fileURLWithPath: python)
                process.arguments = ["-B", script.path]
                process.standardOutput = output
                process.standardError = FileHandle.nullDevice
                try process.run()
                let data = output.fileHandleForReading.readDataToEndOfFile()
                process.waitUntilExit()
                struct Response: Decodable { let restored: Bool?; let backupPath: String?; let error: String? }
                let response = try? JSONDecoder().decode(Response.self, from: data)
                guard process.terminationStatus == 0, response?.restored == true,
                      let path = response?.backupPath, path.hasPrefix("/") else {
                    throw RecoveryError(message: response?.error ?? Strings.t("connectionRecovery.failed"))
                }
                return URL(fileURLWithPath: path, isDirectory: true)
            }
            DispatchQueue.main.async { completion(result) }
        }
    }
    private struct RecoveryError: LocalizedError {
        let message: String
        var errorDescription: String? { message }
    }
}

struct OriginalConnectionRecoveryView: View {
    @ObservedObject var model: PopoverModel
    let actions: PopoverActions
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button(Strings.t("connectionRecovery.restore"), action: actions.restoreOriginalConnection)
                .disabled(model.connectionRestoring)
                .accessibilityIdentifier("connectionRecovery.restore")
            Text(Strings.t("connectionRecovery.explanation"))
                .font(.caption2).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            if model.connectionRestoring { ProgressView().controlSize(.small) }
            if let message = model.connectionRecoveryMessage {
                Text(message).font(.caption).fixedSize(horizontal: false, vertical: true)
            }
            if model.connectionRecoveryBackup != nil {
                Button(Strings.t("connectionRecovery.backup"), action: actions.showRecoveryBackup).font(.caption)
            }
        }.frame(maxWidth: .infinity, alignment: .leading)
    }
}
