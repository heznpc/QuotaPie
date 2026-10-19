import SwiftUI

struct AutoResumeSection: View {
    @ObservedObject var model: PopoverModel
    @State private var error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(Strings.t("autoResume.title")).font(.headline)
            Text(Strings.t("autoResume.description")).font(.callout).foregroundStyle(.secondary)
            if let message = statusUnavailableMessage {
                Label(message, systemImage: "exclamationmark.circle")
                    .font(.callout).foregroundStyle(.orange)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("auto-resume-status-unavailable")
            }
            if let value = model.payload?.autoResume {
                ForEach(value.accounts) { account in
                    VStack(alignment: .leading, spacing: 4) {
                        Toggle(isOn: Binding(get: { account.enabled }, set: { enabled in
                            change { client, token, completion in
                                client.setAutoResumeEnabled(account: account.account, enabled: enabled, actionToken: token, completion: completion)
                            }
                        })) {
                            Text(account.label).lineLimit(2)
                        }
                        .toggleStyle(.switch)
                        .accessibilityLabel(Strings.t("autoResume.title") + " · " + account.label)
                        .accessibilityIdentifier("auto-resume-account-" + account.account)
                        .disabled(!canChange)
                        if let scanError = account.scanErrorText {
                            Text(scanError).font(.caption).foregroundStyle(.orange)
                        } else if account.enabled, let at = account.lastScanAtMs {
                            Text(Strings.t("autoResume.lastScan", DisplayFormat.age(since: Date(timeIntervalSince1970: at / 1000))))
                                .font(.caption).foregroundStyle(.secondary)
                        } else if account.enabled {
                            Text(Strings.t("autoResume.scanWaiting")).font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
                if value.accounts.isEmpty { Text(Strings.t("autoResume.noAccounts")).foregroundStyle(.secondary) }
                if value.incidents.isEmpty {
                    Text(Strings.t("autoResume.empty")).font(.callout).foregroundStyle(.secondary)
                }
                ForEach(value.incidents) { incident in
                    incidentRow(incident, accounts: value.accounts)
                }
            } else {
                Text(Strings.t("autoResume.unsupported")).font(.callout).foregroundStyle(.secondary)
            }
            if model.autoResumeSaving { ProgressView().controlSize(.small) }
            if let error { Text(error).font(.caption).foregroundStyle(.red) }
        }
    }

    var statusUnavailableMessage: String? {
        model.canActOnTasks ? nil : Strings.t("autoResume.statusUnavailable")
    }

    private var canChange: Bool { model.canActOnTasks && model.statusClient != nil && !model.autoResumeSaving }

    private func incidentRow(_ incident: AutoResumeIncident, accounts: [AutoResumeAccount]) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .top) {
                Text(incident.projectLabel).font(.callout).lineLimit(2)
                Spacer()
                Text(incident.stateTitle).font(.caption).foregroundStyle(incident.state == "needs-review" ? Color.orange : Color.secondary)
                    .accessibilityIdentifier("auto-resume-state-" + incident.id)
            }
            Text(Strings.t("autoResume.conversationAccount", accounts.first { $0.account == incident.account }?.label ?? incident.account))
                .font(.caption).foregroundStyle(.secondary)
            if let target = incident.quotaAccountText {
                Text(target).font(.caption).foregroundStyle(.secondary)
                    .accessibilityIdentifier("auto-resume-quota-target-" + incident.id)
            }
            Text(incident.threadId).font(.caption2.monospaced()).textSelection(.enabled).lineLimit(1)
            if let reason = incident.reasonText { Text(reason).font(.caption).foregroundStyle(.secondary) }
            Text(Date(timeIntervalSince1970: incident.detectedAtMs / 1000), style: .date).font(.caption).foregroundStyle(.secondary)
            if incident.canSkip {
                Button(Strings.t("autoResume.skip")) {
                    change { client, token, completion in client.skipAutoResume(id: incident.id, actionToken: token, completion: completion) }
                }.disabled(!canChange).accessibilityIdentifier("auto-resume-skip-" + incident.id)
            }
        }
        .padding(.vertical, 5)
        .accessibilityIdentifier("auto-resume-incident-" + incident.id)
    }

    private func change(_ operation: (StatusClient, String, @escaping (Result<AutoResumeResponse, Error>) -> Void) -> Void) {
        guard canChange, let client = model.statusClient, let token = model.payload?.actionToken else { return }
        error = nil
        model.beginAutoResumeSave()
        operation(client, token) { result in
            DispatchQueue.main.async {
                switch result {
                case .success(let reply): model.finishAutoResumeSave(reply.autoResume)
                case .failure:
                    model.finishAutoResumeSave(nil)
                    error = Strings.t("autoResume.saveFailed")
                }
            }
        }
    }
}
