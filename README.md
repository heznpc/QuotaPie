# QuotaPie

Codex와 Claude의 5시간·주간 한도를 공급자 원본 시각으로 추적하고, 개인 사용 패턴으로 안전 소진 시각을 예측하는 로컬 타이머입니다.

단순히 `첫 사용 + 5시간`을 계산하지 않습니다. 리셋 예정 시각이 지나도 로컬에서 사용률을 0으로 만들지 않으며, 공급자 스냅샷이 실제 갱신을 확인할 때만 충전으로 기록합니다.

일상 화면은 **네이티브 macOS 메뉴 막대 앱**입니다. CLI는 진단·자동화용이고, 웹 화면은 자세한 분석이 필요할 때만 여는 선택 기능입니다. 메뉴 앱이 `127.0.0.1`의 숨은 로컬 수집 서비스에서 값을 읽기 때문에 브라우저를 켜둘 필요가 없습니다.

## 무엇이 다른가

- Codex는 공식 `codex app-server`의 `account/rateLimits/read`와 업데이트 이벤트를 사용합니다.
- Claude는 공식 `api/oauth/usage`를 Claude Code의 로컬 OAuth 자격증명으로 읽는 것을 주 수집원으로 삼고, status-line JSON은 폴백으로만 씁니다. 데스크톱 앱만 쓰는 환경에서는 status line이 한 번도 실행되지 않아 상태줄만으로는 영원히 표본이 쌓이지 않기 때문입니다.
- 두 소스가 함께 살아 있으면 최근에 성공한 OAuth 값이 권위를 갖고, 상태줄 값은 이력에 들어가지 않습니다. 동등한 값이 소스만 바꿔 들어와 잡음 이벤트를 만드는 일을 막습니다.
- 수집 상태는 계정이 아니라 **소스 단위**로 저장하고, 계정 건강도는 그중 가장 좋은 상태에서 파생합니다. OAuth 실패가 최근 성공한 상태줄 수집을 덮어쓰지 않습니다.
- 메뉴 막대 제목은 공급자 약어 나열이 아니라 결론 하나입니다. 가장 낮은 잔량이 아니라 **가장 높은 위험**을 고릅니다 — 잔량 89%라도 갱신보다 엿새 먼저 마를 전망이면 `⚠ 주간 위험`이 제목입니다.
- `doctor`와 `/health`는 설정 존재 여부가 아니라 실제 수집 결과로 판정합니다. 표본이 0건인 계정은 통과하지 않습니다.
- 공급자 이메일·원격 계정 ID, OAuth 토큰, 쿠키, 프롬프트 및 대화 내용은 저장하지 않습니다. 다중 계정 구분에는 사용자가 정한 로컬 별칭만 저장합니다.
- 5시간·주간·모델별 창을 독립적으로 추적합니다.
- 여러 Claude 창이 동시에 열려 있어도 원본 세션 ID를 저장하지 않고 짧은 해시별 최신값을 합의해, 오래된 창이 최신 사용률을 되돌리지 못하게 합니다.
- Codex의 프로모션·모델별 항목은 두 번 연속 전체 응답에서 사라질 때 자동 은퇴시켜 유령 타이머를 남기지 않습니다.
- 정상 리셋, 조기 외부 리셋, 한도 증액/서버 보정 가능성, 리셋 시각 재조정, 유료 크레딧 변화를 별도 이벤트로 기록합니다.
- 최근 2시간 속도와 최근 28일의 주중/주말·인접 시간대별 개인 속도를 혼합해 예상 소진 시각을 계산합니다.
- 설정한 활동 시간만 남은 작업시간으로 계산하고, 5시간·주간 중 더 위험한 쪽을 현재 병목으로 표시합니다.
- macOS 알림과 선택적인 외부 명령 트리거를 지원합니다.
- 여러 Codex·Claude 계정을 프로필 디렉터리와 로컬 별칭별로 분리하며, 기록·개인 속도·병목·알림 cooldown도 계정별로 격리합니다.
- 알림은 정직성 원칙을 따릅니다: 최근 실사용이 0이면 pace 경고를 보내지 않고, 실측 소진율이 안전 페이스를 넘을 때만 현재형("사용 속도 과열")을, 습관 패턴만 넘을 때는 전망형("사용 패턴 전망")을 사용합니다.
- 수집 상태를 4상태 하트비트(never-attempted / attempted-then-failed / stale-success / recent-success)로 구분해, 멈춘 수집과 꺼진 수집이 같은 얼굴을 하지 않게 합니다.
- burn 순위 계산은 Claude Code 전사 파일에서 토큰 수·경로 메타데이터(`cwd`, `gitBranch`, `usage`, `timestamp`)만 읽습니다. 대화 본문은 읽지 않습니다.

## 통합 경계면: quota.json

외부 소비자(예: [Modore](https://github.com/heznpc/Modore))는 `~/Library/Application Support/QuotaPie/quota.json` 하나만 읽습니다. 서비스가 매 tick마다 원자적으로(temp+rename, 0600) 갱신합니다.

```jsonc
{
  "schemaVersion": 1,
  "generatedAt": "2026-08-17T…",           // 소비자는 이 값이 오래되면 표시 자체를 숨긴다
  "collection": {
    "lastSampleAt": "…", "healthy": true,   // healthy=false면 낡은 숫자 대신 "수집 끊김"을 보일 것
    "providers": { "codex": "recent-success", "claude": "never-attempted" }
  },
  "window": { "provider": "codex", "usedPercent": 66, "resetsAt": "…" },  // 전역 병목 하나
  "topBurn": [ { "remote": "github.com/…", "percent": 42.0, "lastActiveAt": "…" } ]
}
```

필드 제거·의미 변경은 `schemaVersion`을 올립니다.

## 수집 상태 읽는 법

`quota.json`과 `/health`, 메뉴 앱은 같은 4상태를 씁니다. "켜져 있다"와 "실제로 값이 들어온다"를 구분하기 위한 것입니다.

| 상태 | 뜻 | 표면에서의 취급 |
|---|---|---|
| `never-attempted` | 아직 한 번도 시도하지 않음 | 설정 필요 |
| `attempted-then-failed` | 시도했으나 성공 기록이 없음 | 원인 분류와 복구 명령을 함께 표시 |
| `stale-success` | 성공한 적은 있으나 오래됨 | 숫자 대신 "한도 확인 지연" |
| `recent-success` | 최근 표본 있음 | 정상 표시 |

실패 원인은 `auth-required`, `auth-expired`, `rate-limited`, `network`, `not-configured`, `isolation-unsafe`, `provider-error`, `no-windows`로 분류해 내보냅니다. 자격증명 값 자체는 어떤 필드에도 담기지 않습니다.

Claude 자격증명은 기본 프로필의 경우 `~/.claude/.credentials.json` 또는 키체인 `Claude Code-credentials`에서 **읽기만** 합니다. 별도 `configDir`을 쓰는 프로필은 디렉터리에서 파생한 키체인 서비스 이름을 찾고, 기본 서비스로 폴백하지 않습니다(다른 계정의 토큰을 이 계정 것으로 오인하지 않기 위해서입니다). 비표준 위치를 쓴다면 계정 설정의 `keychainService`로 지정하십시오.

## 요구 사항

- macOS
- [Bun](https://bun.sh/) 1.3+
- 로그인된 Codex CLI
- Claude 추적 시 Claude Code 2.1.80+
- 메뉴 앱을 소스에서 빌드할 때 Apple Swift toolchain

이 프로젝트는 런타임 패키지를 추가로 설치하지 않습니다. SQLite와 HTTP 서버는 Bun 내장 기능을 사용합니다.

## 참고한 기존 구현과 원본

- [Codex App Server의 rate-limit API](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md): `usedPercent`, 공급자 `resetsAt`, 전체 조회와 sparse update의 차이를 기준으로 삼았습니다.
- [Codex 인증 저장 방식](https://learn.chatgpt.com/docs/auth): CLI 로그인 캐시와 `CODEX_HOME`별 `auth.json` 동작을 다중 프로필 격리에 사용합니다.
- [Claude Code 공식 status-line 데이터](https://code.claude.com/docs/en/statusline): `five_hour`/`seven_day`, 누락 가능한 필드, 실행 중 취소 동작을 기준으로 삼았습니다.
- [Claude Code 환경 변수](https://code.claude.com/docs/en/env-vars): 여러 계정을 나란히 실행하기 위한 `CLAUDE_CONFIG_DIR`를 사용합니다.
- [CodexBar](https://github.com/steipete/CodexBar): 여러 공급자·여러 창, stale 상태, 리셋 카운트다운을 한눈에 보여주는 UX를 참고했습니다.
- [ccusage](https://github.com/ryoppippi/ccusage): 로컬 기록을 장기 분석에 쓰는 방향을 참고했습니다. QuotaPie는 토큰 비용 집계보다 공급자 quota 시계와 개인 소진 속도에 집중합니다.

## 빠른 시작

```bash
cd /path/to/Time
./bin/quotapie init
./bin/quotapie doctor
./bin/quotapie serve
./script/build_and_run.sh --verify
```

이후 메뉴 막대의 `TQ C… · A…` 표시만 확인하면 됩니다. `serve`는 브라우저가 아니라 수집·알림·메뉴 앱용 로컬 API를 함께 실행하는 명령입니다. 상세 웹 화면은 필요할 때만 메뉴에서 열거나 [http://127.0.0.1:47831](http://127.0.0.1:47831)에 접속합니다.

CLI를 어디서나 쓰고 싶다면 프로젝트의 `bin`을 `PATH`에 추가하거나 `bin/quotapie`를 원하는 로컬 bin 디렉터리에 링크하십시오.

실사용 런타임은 `~/.local/lib/quotapie`에 두고 `~/.local/bin/quotapie`로 연결할 수 있습니다. macOS가 `launchd`의 Documents 접근을 `Operation not permitted`로 막을 수 있어, 상주 서비스와 Claude status line은 이 보호 경로 밖의 실행본을 쓰는 편이 안정적입니다. 소스 디렉터리는 계속 기준본으로 유지합니다.

## 메뉴 막대 앱

`script/build_and_run.sh`는 SwiftPM 빌드, `.app` 번들 생성, 임시 서명, 실행을 한 번에 처리합니다. Codex 앱의 Run 버튼도 이 스크립트에 연결되어 있습니다.

```bash
./script/build_and_run.sh            # 빌드 후 실행
./script/build_and_run.sh --verify   # 실행 프로세스까지 확인
```

로그인할 때 자동 실행하려면 먼저 빌드된 앱을 사용자 Applications 폴더에 복사한 다음, 백엔드와 별도의 LaunchAgent를 등록합니다.

```bash
mkdir -p ~/Applications ~/Library/LaunchAgents
ditto dist/QuotaPie.app ~/Applications/QuotaPie.app
./bin/quotapie menubar-launchd > /tmp/local.quotapie.menubar.plist
plutil -lint /tmp/local.quotapie.menubar.plist
cp /tmp/local.quotapie.menubar.plist ~/Library/LaunchAgents/local.quotapie.menubar.plist
pkill -x QuotaPie 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/local.quotapie.menubar.plist
```

메뉴 앱이 종료되더라도 수집 서비스와 알림은 계속 동작합니다. 메뉴의 정상 `종료`는 앱을 즉시 되살리지 않지만, 비정상 종료 시에는 LaunchAgent가 다시 실행합니다.

## Claude 연결

`./bin/quotapie init`이 아래와 같은 조각을 출력합니다. 기존 `~/.claude/settings.json`의 다른 설정을 보존하면서 병합하십시오. 이미 별도의 `statusLine`이 있다면 덮어쓰지 말고 기존 스크립트에서 `quotapie claude-statusline`으로 같은 JSON을 전달하도록 합쳐야 합니다.

```json
{
  "statusLine": {
    "type": "command",
    "command": "~/.local/bin/quotapie claude-statusline --account default",
    "padding": 1
  }
}
```

Claude의 `rate_limits` 필드는 첫 API 응답 이후에 생깁니다. 값이 없을 때 QuotaPie는 이를 `0% used`로 바꾸지 않고 `unknown`으로 둡니다. 따라서 가짜 100% 충전이 생기지 않습니다.

status-line 프로세스는 Claude 화면 갱신 때 취소될 수 있으므로 관측 저장과 한 줄 렌더링만 빠르게 수행합니다. 실제 알림과 외부 트리거는 `watch`/`serve` 상주 프로세스가 SQLite의 미전송 이벤트를 이어받아 처리합니다.

## 여러 계정

계정 ID는 이메일이 아니라 `[a-z0-9][a-z0-9._-]{0,31}` 형식의 로컬 별칭입니다. `id`는 기록을 연결하는 불변 키이므로 같은 ID로 다른 로그인을 갈아끼우지 말고, 표시명만 바꾸려면 `label`을 수정하십시오.

```json
{
  "accounts": {
    "codex": [
      { "id": "default", "label": "Personal", "codexHome": "~/.codex", "enabled": true },
      { "id": "work", "label": "Work", "codexHome": "~/.codex-work", "enabled": true }
    ],
    "claude": [
      { "id": "default", "label": "Personal", "configDir": "~/.claude", "enabled": true },
      { "id": "work", "label": "Work", "configDir": "~/.claude-work", "enabled": true }
    ]
  }
}
```

Codex는 각 `CODEX_HOME`에서 별도로 로그인합니다. 여러 프로필을 동시에 쓸 때 OS 자격증명 저장소 하나로 합쳐지지 않도록 각 디렉터리의 `config.toml`에 `cli_auth_credentials_store = "file"`을 넣고 로그인해야 합니다. QuotaPie는 다중 계정에서 이 설정이 없는 프로필을 수집하지 않아 같은 로그인의 이중 집계를 막습니다.

```bash
CODEX_HOME=~/.codex codex login
CODEX_HOME=~/.codex-work codex login
```

기본 단일 계정의 `codexHome: null`은 현재 셸의 `CODEX_HOME` 또는 기본 `~/.codex`를 그대로 상속하는 하위 호환 설정입니다. 다중 계정에서는 모든 홈을 명시하는 편이 안전합니다.

Claude는 `CLAUDE_CONFIG_DIR`로 설정·세션 기록·플러그인 경로를 분리합니다. 공식 문서가 이 변수를 여러 계정의 병렬 실행 용도로 명시하며, macOS 로그인 자격증명 자체는 시스템 Keychain에 남습니다. 각 프로필에서 로그인하고, 각 `settings.json`의 status line에 같은 별칭을 고정합니다.

```bash
CLAUDE_CONFIG_DIR=~/.claude-work claude auth login
```

```json
{
  "statusLine": {
    "type": "command",
    "command": "~/.local/bin/quotapie claude-statusline --account work",
    "padding": 1
  }
}
```

설정한 프로필은 `quotapie accounts`로, 계정별 실제 수집 결과는 `quotapie doctor`로 확인합니다. 한 Codex 계정의 인증이 실패해도 다른 계정의 관측은 계속 저장됩니다. `enabled: false`인 계정은 과거 데이터를 삭제하지 않고 화면·수집·알림에서만 숨기므로 다시 켜면 개인 속도 학습을 이어갑니다.

## 명령

```text
quotapie init                 기본 개인 설정 생성 및 연동 안내
quotapie poll                 Codex 원본을 한 번 조회
quotapie status               현재 한도·속도·예상 소진 표시
quotapie status --account ID  특정 로컬 계정 별칭만 표시
quotapie status --json        자동화용 구조화 출력
quotapie explain              최근 변화의 판정 근거 표시
quotapie accounts             계정 별칭과 프로필 루트 표시
quotapie claude-statusline --account ID
                               해당 Claude 프로필 관측 저장
quotapie watch                적응형 타이머와 알림만 실행
quotapie serve                타이머, 알림, 로컬 대시보드 실행
quotapie doctor               수집기와 연결 상태 점검
quotapie test-alert           알림 채널 실제 전송 점검
quotapie launchd              상주 실행용 plist 출력
quotapie menubar-launchd      메뉴 막대 앱 자동 실행 plist 출력
```

## 개인화

기본 설정은 `~/.config/quotapie/config.json`에 있고 데이터는 `~/.local/share/quotapie/quotapie.sqlite3`에 저장됩니다. 테스트나 격리가 필요하면 환경변수로 바꿀 수 있습니다.

```bash
QUOTAPIE_CONFIG=/path/config.json QUOTAPIE_HOME=/path/data ./bin/quotapie status
```

중요한 설정은 다음과 같습니다.

```json
{
  "profile": {
    "timeZone": "Asia/Seoul",
    "recentLookbackMinutes": 120,
    "historyDays": 28,
    "recentWeight": 0.7,
    "workSchedule": {
      "weekday": [{ "start": "09:00", "end": "02:00" }],
      "weekend": [{ "start": "11:00", "end": "01:00" }]
    }
  },
  "reservePercent": {
    "codex": { "short": 10, "weekly": 15, "other": 10 },
    "claude": { "short": 10, "weekly": 15, "other": 10 }
  },
  "accounts": {
    "codex": [{ "id": "default", "label": "Main", "codexHome": null, "enabled": true }],
    "claude": [{ "id": "default", "label": "Main", "configDir": "~/.claude", "enabled": true }]
  },
  "collection": {
    "claudeSessionTtlSeconds": 900
  }
}
```

- `recentWeight`: 오늘의 실제 속도를 개인 장기 패턴에 얼마나 강하게 반영할지 정합니다. 표본이 적을 때는 자동으로 장기 패턴 비중이 높아집니다.
- `workSchedule`: 자정을 넘는 범위도 지원합니다. `09:00`–`02:00`은 오전 9시부터 다음 날 오전 2시까지입니다.
- `reservePercent`: 리셋 직전까지 남겨둘 안전 여유입니다.
- `accounts.*[].id`: DB·알림에 쓰는 안정적인 로컬 별칭입니다. 같은 공급자 안에서 중복할 수 없습니다.
- `codexHome`/`configDir`: 계정별 프로필 루트입니다. 활성 계정끼리 같은 디렉터리를 공유하면 시작 단계에서 거부합니다.
- `alerts.remainingThresholds`: 잔여량 알림 단계입니다.
- `alerts.staleProviders`: 유휴 데이터에 대해 장애 알림을 보낼 공급자입니다. Claude는 응답 이벤트형이라 기본 제외됩니다.
- `alerts.command`: 추가 트리거를 쉘 없이 정확한 argv 배열로 실행합니다. 결정 JSON은 `QUOTAPIE_EVENT_JSON` 환경변수로 전달됩니다.
- `alerts.deliveryTimeoutSeconds`: 알림 채널 하나가 상주 수집 루프를 붙잡을 수 있는 최대 시간입니다.
- `collection.claudeSessionTtlSeconds`: 같은 리셋 창의 여러 Claude 세션 중 가장 높은 사용률을 유지하는 합의 시간입니다.

macOS 알림과 외부 명령을 함께 켠 경우 설정된 채널이 모두 성공해야 전송 완료로 기록합니다. 먼저 성공한 채널은 개별 기록해 재시도 때 다시 실행하지 않습니다. 명시적 실패는 로그에 채널과 종료 코드를 남기고 다음 수집 주기에 다시 시도하며, 프로세스가 중간에 종료된 claim도 5분 lease 뒤 회수합니다.

예를 들어 macOS Shortcuts를 함께 실행하려면 다음처럼 설정할 수 있습니다.

```json
{
  "alerts": {
    "command": ["/usr/bin/shortcuts", "run", "QuotaPie Alert"]
  }
}
```

## 판정 규칙

| 관측 | QuotaPie 판정 |
|---|---|
| 예정 리셋 부근에서 사용률이 하락하고 새 리셋 시각이 잡힘 | 정상 리셋; 작은 하락은 신뢰도만 낮춤 |
| 예정 시각보다 일찍 사용률이 하락하고 시각도 재설정됨 | 외부 충전/수동 리셋; 작은 하락은 신뢰도만 낮춤 |
| 리셋 시각은 같은데 사용률만 크게 하락 | 리셋·한도 증액·서버 보정 구분 불가 |
| 사용률은 같은데 리셋 시각만 이동 | 타이머 재동기화 |
| 원본 값이 null/누락 | unknown; 이전 값은 기록으로만 유지 |
| 예정 시각이 지났지만 새 원본이 없음 | reset_due; 가짜 충전 금지 |
| 크레딧 잔액 감소 | 유료 사용 경고 |
| 공급자가 저장형 리셋 수를 노출하고 그 값이 감소 | banked reset 사용 추정 |

`quotapie explain`에서 각 변화의 판정과 근거를 확인할 수 있습니다.

## 상주 실행

QuotaPie는 `launchd` 파일을 자동 설치하지 않습니다. 먼저 내용을 검토할 수 있도록 출력만 합니다.

```bash
./bin/quotapie launchd > /tmp/local.quotapie.plist
plutil -lint /tmp/local.quotapie.plist
```

검토 후 `~/Library/LaunchAgents/local.quotapie.plist`로 옮겨 직접 등록할 수 있습니다. 삭제·덮어쓰기 같은 시스템 변경을 자동으로 수행하지 않습니다.

```bash
mkdir -p ~/Library/LaunchAgents
cp /tmp/local.quotapie.plist ~/Library/LaunchAgents/local.quotapie.plist
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/local.quotapie.plist
launchctl print "gui/$(id -u)/local.quotapie"

# 중지 및 제거
launchctl bootout "gui/$(id -u)" ~/Library/LaunchAgents/local.quotapie.plist
rm ~/Library/LaunchAgents/local.quotapie.plist
```

`QUOTAPIE_CONFIG`와 `QUOTAPIE_HOME`을 지정한 상태에서 plist를 생성하면 해당 경로가 plist에도 고정됩니다.

데이터 디렉터리는 `0700`, 설정·SQLite·WAL·로그는 `0600`으로 보정합니다. 분석용 snapshot은 설정한 `historyDays`에 하루 여유를 더해 보존하고, 이벤트는 180일 보존합니다. 각 항목의 최신 snapshot 하나는 오래됐더라도 현재 상태 표시를 위해 남깁니다.

## 검증

```bash
bun run check
```

테스트에는 저사용 정상·조기 리셋, 리셋 시각 재조정, 비율만 낮아지는 한도 완화, null 데이터, 오래된 응답, 다중 Claude 세션 합의, 다중 계정 격리·검증, 계정별 알림 key, Codex 동적 항목 은퇴, 내구성 있는 알림 claim, 파일 권한, 유료 크레딧, 개인 burn-rate, 병목 선택 및 동적 재예약이 포함됩니다.

## 한계

- Claude 개인 구독에는 공개된 상시 quota webhook이 없습니다. Claude가 유휴 상태일 때의 공급자 변경은 다음 Claude 응답에서 status line이 갱신될 때 확인됩니다.
- 같은 Claude 리셋 창의 낮은 사용률은 다른 활성 세션의 더 높은 값이 사라질 때까지 기본 15분간 보수적으로 늦게 반영될 수 있습니다.
- 여러 Claude 계정 각각은 해당 `CLAUDE_CONFIG_DIR`의 Claude가 응답해 status line을 실행할 때 갱신됩니다.
- 같은 프로필 디렉터리에서 로그아웃 후 다른 원격 계정으로 바꾸면 과거 학습과 섞일 수 있습니다. 다른 로그인에는 새 프로필 디렉터리와 새 로컬 ID를 사용하십시오.
- 퍼센트만 제공되는 경우 실제 사용량 삭제와 한도 분모 증액을 완전히 구분할 수 없습니다. 이때는 확정 표현 대신 `allowance_relief`로 기록합니다.
- banked reset 이벤트는 공급자 응답에 해당 수치가 실제로 노출될 때만 감지합니다. QuotaPie 자체는 크레딧을 구매하거나 banked reset을 소비하지 않습니다.

## 라이선스

MIT. 자세한 내용은 [LICENSE](LICENSE)를 보십시오.
