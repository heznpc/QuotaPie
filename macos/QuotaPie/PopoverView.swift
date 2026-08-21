import SwiftUI

final class PopoverModel: ObservableObject {
    @Published var payload: StatusPayload?
    @Published var lastError: String?
    @Published var lastSuccessAt: Date?
}

/// The first thing on screen has to answer four questions without anything
/// being expanded: which account, how much is used and left, when it resets,
/// and whether this pace lasts.
struct PopoverView: View {
    @ObservedObject var model: PopoverModel
    let onRefresh: () -> Void
    let onCopy: () -> Void
    let onOpenDashboard: () -> Void
    let onOpenConfig: () -> Void
    let onCopyCommand: (String) -> Void
    let onQuit: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            header
                .padding(.horizontal, 14)
                .padding(.vertical, 12)
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    content
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(14)
            }
            .frame(maxHeight: 460)
            Divider()
            footer
                .padding(.horizontal, 10)
                .padding(.vertical, 8)
        }
        .frame(width: 380)
    }

    @ViewBuilder
    private var content: some View {
        let payload = model.payload
        let lastError = model.lastError
        let lastSuccessAt = model.lastSuccessAt
        if let lastError {
            CalloutView(
                text: Strings.t("popover.disconnected"),
                // Say when the numbers below are from. Rather than discarding
                // the cache, give it an age.
                detail: payload == nil
                    ? lastError
                    : Strings.t(
                        "popover.cachedNotice",
                        lastSuccessAt.map { DisplayFormat.age(since: $0) } ?? "—"
                    ) + " · " + lastError,
                tone: .warning
            )
        }
        if let payload, !payload.accounts.isEmpty {
            ForEach(payload.accounts) { account in
                AccountSection(
                    account: account,
                    onOpenConfig: onOpenConfig,
                    onCopyCommand: onCopyCommand
                )
            }
        } else if lastError == nil {
            CalloutView(
                text: Strings.t("popover.noAccounts"),
                detail: Strings.t("popover.noAccountsDetail"),
                tone: .neutral
            )
        }
        if let events = payload?.events, !events.isEmpty {
            Divider()
            RecentChanges(events: Array(events.prefix(3)))
        }
    }

    /// The status item already switches to the degraded title when the transport is
    /// down. The header has to agree: leaving the cached conclusion as the
    /// largest text on screen makes a stale reading look like the current one.
    private var isDisconnected: Bool { model.lastError != nil }

    private var header: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(alignment: .firstTextBaseline) {
                Text(headlineTitle)
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(headlineTone)
                Spacer()
                if let lastSuccessAt = model.lastSuccessAt {
                    Text(DisplayFormat.age(since: lastSuccessAt))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            if let detail = headlineDetail {
                Text(detail).font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    private var headlineTitle: String {
        if isDisconnected { return model.payload == nil ? Strings.t("headline.disconnected") : Strings.t("headline.degraded") }
        return model.payload?.headline?.localizedTitle ?? Strings.t("headline.checking")
    }

    private var headlineDetail: String? {
        guard !isDisconnected else {
            guard let cached = model.payload?.headline?.localizedTitle else { return nil }
            return Strings.t("headline.lastGood") + " · " + cached
        }
        return model.payload?.headline?.localizedDetail
    }

    private var headlineTone: Color {
        if isDisconnected { return .orange }
        switch model.payload?.headline?.kind {
        case "pace-risk": return .orange
        case "degraded", "setup": return .secondary
        default: return .primary
        }
    }

    private var footer: some View {
        HStack(spacing: 4) {
            Button(action: onRefresh) {
                Label(Strings.t("action.refresh"), systemImage: "arrow.clockwise")
                    .labelStyle(.iconOnly)
            }
            .keyboardShortcut("r", modifiers: .command)
            .help(Strings.t("action.refreshHelp"))

            Button(action: onCopy) {
                Label(Strings.t("action.copy"), systemImage: "doc.on.doc")
                    .labelStyle(.iconOnly)
            }
            .keyboardShortcut("c", modifiers: .command)
            .help(Strings.t("action.copyHelp"))

            Button(action: onOpenDashboard) {
                Label(Strings.t("action.openDashboard"), systemImage: "safari")
                    .labelStyle(.iconOnly)
            }
            .help(Strings.t("action.openDashboard"))

            Spacer()

            Menu {
                Button(action: onOpenConfig) {
                    Label(Strings.t("action.openSettings"), systemImage: "gearshape")
                }
                Divider()
                Button(role: .destructive, action: onQuit) {
                    Label(Strings.t("action.quit"), systemImage: "power")
                }
                .keyboardShortcut("q", modifiers: .command)
            } label: {
                Label(Strings.t("action.more"), systemImage: "ellipsis.circle")
                    .labelStyle(.iconOnly)
            }
            .menuStyle(.borderlessButton)
            .help(Strings.t("action.moreHelp"))
        }
        .buttonStyle(.borderless)
        .controlSize(.small)
    }
}

private struct AccountSection: View {
    let account: AccountState
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
            ForEach(account.windows) { window in
                WindowRow(window: window)
            }
        }
    }

    private var statusTrail: String {
        let age = account.collection.lastSuccessAtMs
            .map { DisplayFormat.age(since: Date(timeIntervalSince1970: $0 / 1_000)) } ?? "—"
        return "\(account.collection.sourceLabel) · \(age)"
    }
}

private struct WindowRow: View {
    let window: QuotaWindow

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 8) {
                Text(window.shortLabel)
                    .font(.system(size: 11, weight: .medium))
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
                    .frame(width: 44, alignment: .leading)
                Text(usedText)
                    .font(.system(size: 11).monospacedDigit())
                    .foregroundStyle(.secondary)
                    .frame(width: 76, alignment: .trailing)
                UsageBar(window: window)
                Text(remainingText)
                    .font(.system(size: 11).monospacedDigit())
                    .foregroundStyle(window.isExhausted ? Color.red : Color.primary)
                    .frame(width: 74, alignment: .trailing)
            }
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
            .padding(.leading, 52)
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
        if window.isAtRisk { return .orange }
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
        if window.isAtRisk { return Color(nsColor: .systemOrange) }
        if window.isWatch { return Color(nsColor: .systemYellow) }
        return Color(nsColor: .systemBlue)
    }
}

private struct RecentChanges: View {
    let events: [QuotaEvent]

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(Strings.t("popover.recentChanges")).font(.caption2).foregroundStyle(.secondary)
            ForEach(events.indices, id: \.self) { index in
                let event = events[index]
                Text("\(event.summary) · \(DisplayFormat.age(since: Date(timeIntervalSince1970: event.occurredAtMs / 1_000)))")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
        }
    }
}

private struct CalloutView: View {
    enum Tone { case warning, neutral }

    let text: String
    let detail: String?
    let tone: Tone

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(text).font(.system(size: 12, weight: .medium))
                .foregroundStyle(tone == .warning ? Color.orange : Color.primary)
            if let detail {
                Text(detail).font(.caption2).foregroundStyle(.secondary).lineLimit(3)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(8)
        .background(RoundedRectangle(cornerRadius: 6).fill(Color.secondary.opacity(0.10)))
    }
}
