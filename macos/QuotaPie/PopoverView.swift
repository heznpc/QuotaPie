import SwiftUI

/// 첫 화면이 네 가지를 펼치지 않고 답해야 한다:
/// 어느 계정인가 · 얼마나 썼고 남았나 · 언제 갱신되나 · 이 속도로 버티는가.
struct PopoverView: View {
    let payload: StatusPayload?
    let lastError: String?
    let lastSuccessAt: Date?
    let onRefresh: () -> Void
    let onCopy: () -> Void
    let onOpenDashboard: () -> Void
    let onOpenConfig: () -> Void
    let onCopyCommand: (String) -> Void
    let onQuit: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            header
            if let lastError {
                CalloutView(
                    text: "로컬 서비스에 연결할 수 없습니다",
                    // 아래 숫자들이 언제 것인지 밝힌다. 캐시를 지우는 대신 나이를 붙인다.
                    detail: payload == nil
                        ? lastError
                        : "아래는 마지막 정상값입니다 · \(lastSuccessAt.map { DisplayFormat.age(since: $0) } ?? "시각 미확인") · \(lastError)",
                    tone: .warning
                )
            }
            if let payload, !payload.accounts.isEmpty {
                ForEach(payload.accounts) { account in
                    AccountSection(account: account, onOpenConfig: onOpenConfig, onCopyCommand: onCopyCommand)
                }
            } else if lastError == nil {
                CalloutView(
                    text: "추적할 계정이 없습니다",
                    detail: "설정 파일에서 Codex 또는 Claude 계정을 활성화하십시오.",
                    tone: .neutral
                )
            }
            if let events = payload?.events, !events.isEmpty {
                Divider()
                RecentChanges(events: Array(events.prefix(3)))
            }
            Divider()
            footer
        }
        .padding(14)
        .frame(width: 380)
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(alignment: .firstTextBaseline) {
                Text(payload?.headline?.title ?? "확인 중")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(headlineTone)
                Spacer()
                if let lastSuccessAt {
                    Text(DisplayFormat.age(since: lastSuccessAt))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            if let detail = payload?.headline?.detail {
                Text(detail).font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    private var headlineTone: Color {
        switch payload?.headline?.kind {
        case "pace-risk": return .orange
        case "degraded", "setup": return .secondary
        default: return .primary
        }
    }

    private var footer: some View {
        HStack(spacing: 10) {
            Button("새로고침", action: onRefresh)
            Button("복사", action: onCopy)
            Button("웹 화면", action: onOpenDashboard)
            Spacer()
            Button("종료", action: onQuit)
        }
        .buttonStyle(.borderless)
        .font(.caption)
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
                Text(statusTrail)
                    .font(.caption2)
                    .foregroundStyle(account.collection.isHealthy ? Color.secondary : Color.orange)
            }
            if account.windows.isEmpty || !account.collection.isHealthy {
                CalloutView(
                    text: account.collection.actionText,
                    detail: account.collection.recoveryCommand.map { "터미널에서 `\($0)` 실행" }
                        ?? account.collection.errorDetail,
                    tone: account.collection.isHealthy ? .neutral : .warning
                )
                HStack(spacing: 8) {
                    if let command = account.collection.recoveryCommand {
                        Button("명령 복사") { onCopyCommand(command) }
                    }
                    Button("설정 확인", action: onOpenConfig)
                }
                .buttonStyle(.borderless)
                .font(.caption2)
            }
            ForEach(account.windows) { window in
                WindowRow(window: window)
            }
        }
    }

    private var statusTrail: String {
        guard account.collection.isHealthy else { return account.collection.actionText }
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
                    .frame(width: 44, alignment: .leading)
                Text(usedText)
                    .font(.system(size: 11).monospacedDigit())
                    .foregroundStyle(.secondary)
                UsageBar(window: window)
                Text(remainingText)
                    .font(.system(size: 11).monospacedDigit())
                    .frame(width: 74, alignment: .trailing)
            }
            VStack(alignment: .leading, spacing: 1) {
                Text(DisplayFormat.resetStamp(window.resetsAtMs))
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                if let pace = window.paceText {
                    Text(pace)
                        .font(.caption2)
                        .foregroundStyle(window.isAtRisk ? Color.orange : Color.secondary)
                }
                if window.freshness != "fresh" {
                    Text(freshnessText).font(.caption2).foregroundStyle(.orange)
                }
            }
            .padding(.leading, 52)
        }
    }

    private var usedText: String {
        window.usedPercent.map { "\(Int($0.rounded()))% 사용" } ?? "사용량 미확인"
    }

    private var remainingText: String {
        window.remainingPercent.map { "\(Int($0.rounded()))% 남음" } ?? "—"
    }

    private var freshnessText: String {
        switch window.freshness {
        case "stale": return "오래된 값"
        case "reset_due": return "갱신 확인 중"
        default: return "확인 필요"
        }
    }
}

/// 채움은 항상 "사용한 비율"이다. 얇은 눈금은 남겨두기로 한 안전 여유선이다.
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
                    .fill(window.isAtRisk ? Color.orange : Color.accentColor)
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
    }
}

private struct RecentChanges: View {
    let events: [QuotaEvent]

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text("최근 변화").font(.caption2).foregroundStyle(.secondary)
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
