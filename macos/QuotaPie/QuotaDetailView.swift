import SwiftUI

struct AccountSection: View {
    let account: AccountState
    let recovery: AccountRecovery?
    let transportUnavailable: Bool
    let onOpenConfig: () -> Void
    let onCopyCommand: (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline) {
                Text("\(account.providerTitle) · \(account.accountLabel)")
                    .font(.system(size: 12, weight: .semibold))
                Spacer()
                if account.collection.isHealthy {
                    Text(statusTrail)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                } else {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .font(.caption2)
                        .foregroundStyle(.orange)
                        .help(account.collection.actionText)
                }
            }
            if account.windows.isEmpty || !account.collection.isHealthy {
                CalloutView(
                    text: account.collection.actionText,
                    detail: account.collection.recoveryCommand.map { Strings.t("popover.runCommand", $0) }
                        ?? account.collection.errorDetail,
                    tone: account.collection.isHealthy ? .neutral : .warning
                )
                HStack(spacing: 8) {
                    if let command = account.collection.recoveryCommand {
                        Button { onCopyCommand(command) } label: {
                            Label(Strings.t("action.copyCommand"), systemImage: "doc.on.doc")
                        }
                        .help(Strings.t("action.copyCommandHelp"))
                    }
                    Button(action: onOpenConfig) {
                        Label(Strings.t("action.openSettings"), systemImage: "gearshape")
                    }
                    .help(Strings.t("action.openSettingsHelp"))
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
            }
            if account.collection.isHealthy {
                quotaRows
            } else if !account.windows.isEmpty {
                DisclosureGroup(Strings.t("account.previousReadings")) { quotaRows }
                    .font(.caption)
            }
            if let recovery {
                AccountRecoveryView(account: recovery, transportUnavailable: transportUnavailable)
            }
        }
    }

    private var statusTrail: String {
        let age = account.collection.lastSuccessAtMs
            .map { DisplayFormat.age(since: Date(timeIntervalSince1970: $0 / 1_000)) } ?? "—"
        return "\(account.collection.sourceLabel) · \(age)"
    }

    private var quotaRows: some View {
        ForEach(account.windows.sorted { left, right in
            let leftPrimary = left.bucket.hasPrefix("codex:")
            let rightPrimary = right.bucket.hasPrefix("codex:")
            if leftPrimary != rightPrimary { return leftPrimary }
            return (left.windowSeconds ?? 0) < (right.windowSeconds ?? 0)
        }) { WindowRow(window: $0) }
    }
}

private struct WindowRow: View {
    let window: QuotaWindow

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(spacing: 8) {
                Text(window.shortLabel)
                    .font(.system(size: 12, weight: .medium))
                Spacer()
                Text(remainingText)
                    .font(.system(size: 15, weight: .semibold).monospacedDigit())
                    .foregroundStyle(window.isExhausted ? Color.red : Color.primary)
            }
            UsageBar(window: window)
            VStack(alignment: .leading, spacing: 1) {
                Text(DisplayFormat.resetStamp(window.resetsAtMs))
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                if let pace = window.paceText {
                    Text(pace)
                        .font(.caption2)
                        .foregroundStyle(paceTone)
                }
                if window.freshness != "fresh" {
                    Text(freshnessText).font(.caption2).foregroundStyle(.orange)
                }
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(window.shortLabel)
        .accessibilityValue(accessibilityValue)
    }

    private var usedText: String {
        window.usedPercent.map { Strings.t("window.used", String(Int($0.rounded()))) } ?? Strings.t("window.usageUnknown")
    }

    private var remainingText: String {
        window.remainingPercent.map { Strings.t("window.remaining", String(Int($0.rounded()))) } ?? "—"
    }

    private var freshnessText: String {
        switch window.freshness {
        case "stale": return Strings.t("window.stale")
        case "reset_due": return Strings.t("window.resetDue")
        default: return Strings.t("window.unknown")
        }
    }

    private var paceTone: Color {
        if window.isExhausted { return .red }
        return .secondary
    }

    private var accessibilityValue: String {
        let pieces = [usedText, remainingText, DisplayFormat.resetStamp(window.resetsAtMs), window.paceText]
        return pieces.compactMap { $0 }.joined(separator: ", ")
    }
}

/// The fill is always the used percentage. The thin mark is the safety
/// reserve you decided to leave.
private struct UsageBar: View {
    let window: QuotaWindow

    var body: some View {
        GeometryReader { geometry in
            let width = geometry.size.width
            let used = min(1, max(0, (window.usedPercent ?? 0) / 100))
            let reserveLine = window.reservePercent.map { min(1, max(0, 1 - $0 / 100)) }
            ZStack(alignment: .leading) {
                RoundedRectangle(cornerRadius: 2).fill(Color.secondary.opacity(0.18))
                RoundedRectangle(cornerRadius: 2)
                    .fill(fillColor)
                    .frame(width: width * used)
                if let reserveLine {
                    Rectangle()
                        .fill(Color.secondary.opacity(0.55))
                        .frame(width: 1)
                        .offset(x: width * reserveLine)
                }
            }
        }
        .frame(height: 7)
        .accessibilityHidden(true)
    }

    private var fillColor: Color {
        if window.isExhausted { return Color(nsColor: .systemRed) }
        return Color(nsColor: .systemBlue)
    }
}

struct RecentChanges: View {
    let events: [QuotaEvent]

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            ForEach(events.indices, id: \.self) { index in
                let event = events[index]
                Text("\(event.localizedText) · \(DisplayFormat.age(since: Date(timeIntervalSince1970: event.occurredAtMs / 1_000)))")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
        }
    }
}

struct CalloutView: View {
    enum Tone { case warning, neutral }

    let text: String
    let detail: String?
    let tone: Tone

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(text).font(.system(size: 12, weight: .medium))
                .foregroundStyle(tone == .warning ? Color.orange : Color.primary)
            if let detail {
                Text(detail).font(.caption2).foregroundStyle(.secondary).textSelection(.enabled)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(8)
        .background(RoundedRectangle(cornerRadius: 6).fill(Color.secondary.opacity(0.10)))
    }
}
