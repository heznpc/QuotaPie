import SwiftUI

struct PausedWorkSection: View {
    let tasks: [ResumeTask]
    let hasActionToken: Bool
    let activities: [String: ResumeTaskActivity]
    let onResume: (ResumeTask) -> Void
    let onRetry: (ResumeTask) -> Void
    let onDismiss: (ResumeTask) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            Text(Strings.t("resume.sectionTitle"))
                .font(.caption2)
                .foregroundStyle(.secondary)
            ForEach(tasks) { task in
                ResumeTaskRow(
                    task: task,
                    hasActionToken: hasActionToken,
                    activity: activities[task.id],
                    onResume: { onResume(task) },
                    onRetry: { onRetry(task) },
                    onDismiss: { onDismiss(task) }
                )
            }
        }
    }
}

private struct ResumeTaskRow: View {
    let task: ResumeTask
    let hasActionToken: Bool
    let activity: ResumeTaskActivity?
    let onResume: () -> Void
    let onRetry: () -> Void
    let onDismiss: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Image(systemName: task.isReady ? "play.circle.fill" : "pause.circle")
                    .foregroundStyle(task.isReady ? Color(nsColor: .systemBlue) : .secondary)
                    .accessibilityHidden(true)
                Text(task.projectLabel)
                    .font(.system(size: 12, weight: .semibold))
                    .lineLimit(1)
                Spacer(minLength: 4)
                Text("\(task.providerTitle) · \(task.accountTitle)")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .help(task.projectLabel)
            }

            Text(detailText)
                .font(.caption2)
                .foregroundStyle(detailTone)
                .lineLimit(2)

            HStack(spacing: 7) {
                primaryAction
                Spacer(minLength: 4)
                Button(action: onDismiss) {
                    Label(Strings.t("resume.dismiss"), systemImage: "xmark")
                        .labelStyle(.iconOnly)
                }
                .buttonStyle(.borderless)
                .disabled(!hasActionToken || isBusy)
                .help(Strings.t("resume.dismissHelp"))
                .accessibilityLabel(
                    "\(Strings.t("resume.dismiss")): \(task.providerTitle), \(task.accountTitle), \(task.projectLabel), \(task.shortReference)"
                )
            }
            .controlSize(.small)
        }
        .padding(.vertical, 10)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("\(task.providerTitle), \(task.accountTitle), \(task.projectLabel)")
    }

    @ViewBuilder
    private var primaryAction: some View {
        if isBusy {
            HStack(spacing: 5) {
                ProgressView().controlSize(.small)
                Text(activityText)
            }
            .font(.caption)
            .accessibilityElement(children: .combine)
        } else if task.isWaiting {
            Button(Strings.t("resume.waitingAction"), action: {})
                .buttonStyle(.bordered)
                .disabled(true)
        } else if task.isReady {
            Button(Strings.t("resume.resumeInTerminal"), action: onResume)
                .buttonStyle(.borderedProminent)
                .disabled(!hasActionToken)
                .accessibilityLabel(
                    "\(Strings.t("resume.resumeInTerminal")): \(task.providerTitle), \(task.accountTitle), \(task.projectLabel)"
                )
        } else if task.isApproved {
            Button(Strings.t("resume.retry"), action: onRetry)
                .buttonStyle(.bordered)
                .disabled(!hasActionToken)
                .accessibilityLabel(
                    "\(Strings.t("resume.retry")): \(task.providerTitle), \(task.accountTitle), \(task.projectLabel), \(task.shortReference)"
                )
        }
    }

    private var isBusy: Bool { activity?.isBusy ?? false }

    private var activityText: String {
        switch activity {
        case .approving: return Strings.t("resume.preparing")
        case .opening: return Strings.t("resume.opening")
        case .updating: return Strings.t("resume.updating")
        case .failed, .none: return ""
        }
    }

    private var detailText: String {
        if !hasActionToken { return Strings.t("resume.actionUnavailable") }
        if case .failed(let message) = activity { return "\(message) · \(task.pausedReference)" }
        if let errorDetail = task.errorDetail, !errorDetail.isEmpty {
            return "\(errorDetail) · \(task.pausedReference)"
        }
        let stateText: String
        if task.isWaiting {
            stateText = Strings.t(
                "resume.waitingProvider",
                DisplayFormat.resetStamp(task.expectedResetAtMs)
            )
        } else if task.isReady {
            stateText = Strings.t("resume.readyDetail")
        } else if task.isApproved {
            stateText = Strings.t("resume.approvedDetail")
        } else {
            stateText = Strings.t("resume.unknownState")
        }
        return "\(stateText) · \(task.pausedReference)"
    }

    private var detailTone: Color {
        if !hasActionToken { return .orange }
        if case .failed = activity { return .red }
        return .secondary
    }
}

