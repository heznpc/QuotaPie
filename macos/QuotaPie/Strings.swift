import Foundation

/// Every sentence this app shows comes from here.
///
/// The backend hands over meaning — a headline kind, a window kind, an error
/// category — and the app turns that into a sentence in the viewer's language.
/// English is the default; Korean is a locale.
///
/// The keys deliberately match the backend catalog in src/i18n.ts, so the same
/// concept is named the same thing on both sides and a missing translation is
/// obvious rather than silently English.
enum Strings {
    enum Language: String {
        case english = "en"
        case korean = "ko"
    }

    /// Resolved once from the viewer's preferred languages. The environment
    /// override exists so the fixture harness can drive either language.
    static let language: Language = {
        if let forced = ProcessInfo.processInfo.environment["QUOTAPIE_LOCALE"],
           let match = Language(rawValue: String(forced.prefix(2)).lowercased()) {
            return match
        }
        for preferred in Locale.preferredLanguages {
            let code = String(preferred.prefix(2)).lowercased()
            if let match = Language(rawValue: code) { return match }
        }
        return .english
    }()

    static func localeIdentifier() -> String {
        language == .korean ? "ko_KR" : "en_US"
    }

    private static let table: [String: [Language: String]] = [
        "headline.checking": [.english: "Checking", .korean: "확인 중"],
        "headline.disconnected": [.english: "Disconnected", .korean: "연결 끊김"],
        "headline.degraded": [.english: "Limits unconfirmed", .korean: "한도 확인 지연"],
        "headline.setup": [.english: "Setup needed", .korean: "설정 필요"],
        "headline.lastGood": [.english: "Last good reading", .korean: "마지막 정상값"],

        "window.five-hour": [.english: "5-hour", .korean: "5시간"],
        "window.weekly": [.english: "weekly", .korean: "주간"],
        "window.monthly": [.english: "monthly", .korean: "월간"],
        "headline.atRisk": [.english: "⚠ %@ at risk", .korean: "⚠ %@ 위험"],
        "headline.runsDryOn": [.english: "runs dry around %@", .korean: "%@경 소진 예상"],
        "format.dayMonth": [.english: "MMM d", .korean: "M월 d일"],

        "collection.auth-required": [.english: "Sign-in required", .korean: "로그인이 필요합니다"],
        "collection.auth-expired": [.english: "Sign-in expired", .korean: "로그인이 만료됐습니다"],
        "collection.rate-limited": [
            .english: "Provider rate limit reached", .korean: "공급자 요청 한도에 걸렸습니다",
        ],
        "collection.network": [.english: "Cannot reach the network", .korean: "네트워크에 연결할 수 없습니다"],
        "collection.not-configured": [
            .english: "Collection is not configured", .korean: "수집이 설정되지 않았습니다",
        ],
        "collection.isolation-unsafe": [
            .english: "Account credentials need isolating", .korean: "계정 자격증명 격리가 필요합니다",
        ],
        "collection.provider-error": [
            .english: "Could not read the provider's response", .korean: "공급자 응답을 읽지 못했습니다",
        ],
        "collection.no-windows": [
            .english: "The response carried no limit windows", .korean: "응답에 한도 창이 없습니다",
        ],
        "collection.never-attempted": [.english: "Not collected yet", .korean: "아직 수집을 시도하지 않았습니다"],
        "collection.stale-success": [
            .english: "Collection is running late", .korean: "한도 확인이 지연되고 있습니다",
        ],
        "collection.attempted-then-failed": [.english: "Collection failed", .korean: "수집에 실패했습니다"],

        "source.official": [.english: "official", .korean: "공식"],
        "source.statusline": [.english: "status line", .korean: "상태줄"],

        "window.used": [.english: "%@%% used", .korean: "%@%% 사용"],
        "window.remaining": [.english: "%@%% left", .korean: "%@%% 남음"],
        "window.usageUnknown": [.english: "Usage unknown", .korean: "사용량 미확인"],
        "window.resetsAt": [.english: "resets %@", .korean: "%@ 갱신"],
        "window.resetUnknown": [.english: "Reset time unknown", .korean: "갱신 시각 미확인"],
        "window.exhausted": [.english: "Exhausted", .korean: "소진됨"],
        "window.paceComfortable": [.english: "Pace is comfortable", .korean: "현재 속도는 여유 있음"],
        "window.paceTight": [
            .english: "On this pattern it will be tight", .korean: "이 패턴이면 갱신 전에 빠듯합니다",
        ],
        "window.runsDry": [.english: "⚠ runs dry around %@", .korean: "⚠ %@경 소진 예상"],
        "window.stale": [.english: "Stale value", .korean: "오래된 값"],
        "window.resetDue": [.english: "Confirming reset", .korean: "갱신 확인 중"],
        "window.unknown": [.english: "Needs checking", .korean: "확인 필요"],

        "popover.noAccounts": [.english: "No accounts to track", .korean: "추적할 계정이 없습니다"],
        "popover.noAccountsDetail": [
            .english: "Enable a Codex or Claude account in the settings file.",
            .korean: "설정 파일에서 Codex 또는 Claude 계정을 활성화하십시오.",
        ],
        "popover.noWindows": [
            .english: "No limit windows to show.", .korean: "표시할 한도 창이 없습니다.",
        ],
        "popover.disconnected": [
            .english: "Cannot reach the local service", .korean: "로컬 서비스에 연결할 수 없습니다",
        ],
        "popover.cachedNotice": [
            .english: "The values below are the last good reading · %@",
            .korean: "아래는 마지막 정상값입니다 · %@",
        ],
        "popover.recentChanges": [.english: "Recent changes", .korean: "최근 변화"],
        "popover.runInTerminal": [
            .english: "Run %@ in a terminal", .korean: "터미널에서 %@ 실행",
        ],

        "resume.sectionTitle": [.english: "Paused work", .korean: "중단된 작업"],
        "resume.readyCount": [.english: "▶ %@ ready", .korean: "▶ %@개 재개"],
        "resume.readyTooltip": [.english: "%@ · %@ · %@", .korean: "%@ · %@ · %@"],
        "resume.pausedReference": [
            .english: "paused %@ · %@", .korean: "%@ 중단 · %@",
        ],
        "resume.waitingAction": [.english: "Waiting", .korean: "대기 중"],
        "resume.waitingProvider": [
            .english: "Waiting for provider-confirmed capacity · %@",
            .korean: "공급자가 확인한 사용 가능 한도 대기 · %@",
        ],
        "resume.readyDetail": [
            .english: "Fresh provider capacity confirmed", .korean: "공급자의 최신 사용 가능 한도 확인됨",
        ],
        "resume.approvedDetail": [
            .english: "Opening was interrupted. Reset it before retrying.",
            .korean: "열기가 중단되었습니다. 재시도 상태로 되돌리십시오.",
        ],
        "resume.unknownState": [
            .english: "Resume state needs checking", .korean: "재개 상태 확인 필요",
        ],
        "resume.actionUnavailable": [
            .english: "Actions unavailable. Refresh the local service.",
            .korean: "작업을 실행할 수 없습니다. 로컬 서비스를 새로고침하십시오.",
        ],
        "resume.resumeInTerminal": [
            .english: "Resume in Terminal", .korean: "Terminal에서 재개",
        ],
        "resume.retry": [.english: "Retry", .korean: "재시도"],
        "resume.dismiss": [.english: "Dismiss", .korean: "제거"],
        "resume.dismissHelp": [
            .english: "Remove this paused-work item", .korean: "이 중단 작업 항목 제거",
        ],
        "resume.preparing": [.english: "Preparing…", .korean: "준비 중…"],
        "resume.opening": [.english: "Opening Terminal…", .korean: "Terminal 여는 중…"],
        "resume.updating": [.english: "Updating…", .korean: "업데이트 중…"],
        "resume.confirmTitle": [.english: "Resume paused work?", .korean: "중단된 작업을 재개할까요?"],
        "resume.confirmMessage": [
            .english: "Open %@ · %@ · %@ (%@, paused %@). QuotaPie does not send a prompt. Tokens are used only after you type and submit one.",
            .korean: "%@ · %@ · %@ (%@, %@ 중단)를 엽니다. QuotaPie는 prompt를 보내지 않으며 사용자가 입력한 뒤에만 토큰이 사용됩니다.",
        ],
        "resume.confirmOpen": [.english: "Open", .korean: "열기"],
        "resume.confirmCancel": [.english: "Cancel", .korean: "취소"],

        "resume.error.executableNotAllowed": [
            .english: "The resume executable is not allowed.", .korean: "허용되지 않은 재개 실행 파일입니다.",
        ],
        "resume.error.executableNotFound": [
            .english: "The approved CLI executable could not be found.",
            .korean: "승인된 CLI 실행 파일을 찾을 수 없습니다.",
        ],
        "resume.error.argumentsNotAllowed": [
            .english: "The resume arguments were rejected.", .korean: "재개 인수가 거부되었습니다.",
        ],
        "resume.error.environmentNotAllowed": [
            .english: "The resume environment was rejected.", .korean: "재개 환경 변수가 거부되었습니다.",
        ],
        "resume.error.workingDirectoryNotAllowed": [
            .english: "The project folder is not an existing absolute path.",
            .korean: "프로젝트 폴더가 존재하는 절대 경로가 아닙니다.",
        ],
        "resume.error.launcherCreationFailed": [
            .english: "Could not create the one-shot launcher: %@",
            .korean: "일회용 실행 파일을 만들 수 없습니다: %@",
        ],
        "resume.error.cannotWriteLauncher": [
            .english: "the launcher file could not be written",
            .korean: "실행 파일을 쓸 수 없음",
        ],
        "resume.error.terminalUnavailable": [
            .english: "Terminal.app is unavailable.", .korean: "Terminal.app을 사용할 수 없습니다.",
        ],
        "resume.error.terminalOpenFailed": [
            .english: "Could not open Terminal: %@", .korean: "Terminal을 열 수 없습니다: %@",
        ],
        "resume.error.launcherStartUnconfirmed": [
            .english: "Terminal accepted the request, but the resume command did not start.",
            .korean: "Terminal이 요청을 받았지만 재개 명령 시작을 확인하지 못했습니다.",
        ],

        "action.refresh": [.english: "Refresh", .korean: "새로고침"],
        "action.refreshHelp": [.english: "Refresh (⌘R)", .korean: "새로고침 (⌘R)"],
        "action.copyHelp": [.english: "Copy status (⌘C)", .korean: "상태 복사 (⌘C)"],
        "action.copyCommandHelp": [
            .english: "Copy the recovery command to run in a terminal",
            .korean: "터미널에서 실행할 복구 명령 복사",
        ],
        "action.openSettingsHelp": [
            .english: "Open the QuotaPie settings file", .korean: "QuotaPie 설정 파일 열기",
        ],
        "popover.runCommand": [
            .english: "Run %@ in a terminal.", .korean: "%@ 명령을 터미널에서 실행하십시오.",
        ],
        "action.copy": [.english: "Copy status", .korean: "상태 복사"],
        "action.openDashboard": [.english: "Open web view", .korean: "웹 화면 열기"],
        "action.openSettings": [.english: "Open settings", .korean: "설정 열기"],
        "action.copyCommand": [.english: "Copy recovery command", .korean: "복구 명령 복사"],
        "action.more": [.english: "More", .korean: "더 보기"],
        "action.moreHelp": [.english: "Settings and quit", .korean: "설정 및 종료"],
        "action.quit": [.english: "Quit QuotaPie", .korean: "QuotaPie 종료"],

        "time.justNow": [.english: "just now", .korean: "방금"],
        "time.minutesAgo": [.english: "%@ min ago", .korean: "%@분 전"],
        "time.hoursAgo": [.english: "%@ h ago", .korean: "%@시간 전"],
        "time.days": [.english: "%@ d %@ h", .korean: "%@일 %@시간"],
        "time.hours": [.english: "%@ h %@ m", .korean: "%@시간 %@분"],
        "time.minutes": [.english: "%@ min", .korean: "%@분"],

        "status.tooltip": [
            .english: "Codex and Claude usage limits", .korean: "Codex와 Claude의 실사용 한도",
        ],
        "status.noData": [
            .english: "QuotaPie: no limit data yet.", .korean: "QuotaPie: 아직 한도 데이터가 없습니다.",
        ],
        "client.badURL": [
            .english: "The local API address is not valid.", .korean: "로컬 API 주소가 올바르지 않습니다.",
        ],
        "client.badResponse": [
            .english: "Could not read the local API response.", .korean: "로컬 API 응답을 읽을 수 없습니다.",
        ],
        "client.badTaskID": [
            .english: "The paused-work identifier is not valid.", .korean: "중단 작업 식별자가 올바르지 않습니다.",
        ],
        "client.missingActionToken": [
            .english: "The local action token is missing.", .korean: "로컬 작업 토큰이 없습니다.",
        ],
        "client.httpStatus": [
            .english: "The local service returned HTTP %@.", .korean: "로컬 서비스가 HTTP %@를 반환했습니다.",
        ],
    ]

    /// A missing key returns the key itself: visible in a screenshot, rather
    /// than a blank space nobody notices.
    static func t(_ key: String, _ arguments: CVarArg...) -> String {
        guard let entry = table[key], let template = entry[language] ?? entry[.english] else { return key }
        return arguments.isEmpty ? template : String(format: template, arguments: arguments)
    }
}
