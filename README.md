# Project-SPIP

PC에 흩어진 VS Code 프로젝트를 스캔해, 간략한 설명과 함께 한눈에 보여주는 **Electron 데스크톱 앱**입니다.

여러 폴더에 흩어져 있는 프로젝트들을 일일이 찾아 열 필요 없이, 한 창에서 목록·설명을 확인하고 바로 VS Code로 열 수 있도록 돕는 것을 목표로 합니다. 터미널을 띄우거나 브라우저 주소를 입력할 필요 없이 **앱을 더블클릭하면 끝**입니다.

> 과거에는 로컬 웹 서버(`127.0.0.1`)를 띄우고 브라우저로 접속하는 방식이었지만, 사용자가 매번 터미널·브라우저를 거쳐야 하는 불편이 있어 **Electron 설치형 데스크톱 앱**으로 전환했습니다. 이제 네이티브 창에서 폴더 선택·재스캔·열기를 모두 처리합니다.

## 주요 기능

- **자동 스캔** — 지정한 폴더 아래의 VS Code 프로젝트(`.git`, `package.json`, `.vscode` 등 보유 폴더)를 탐색합니다(불필요 폴더 제외, 첫 실행 시 스캔 루트는 사용자가 지정). 순회 깊이는 설정·`--depth`(CLI)로 조절할 수 있습니다.
- **인사이트** — 각 프로젝트의 **언어/스택 분포**(`package.json` 의존성 + 확장자 비율), **활동 신선도**(최종 수정·최근 커밋, 기준일 기본 90일 초과 시 stale 표시), **Git 상태**(저장소 여부·브랜치·미커밋 변경·ahead/behind), **규모/의존성**(의존성 개수는 항상 수집, 총 용량·`node_modules` 크기는 `--with-size`로 측정)를 정리합니다. Git 미설치/비저장소는 `N/A`로 graceful 처리됩니다.
- **네이티브 폴더 선택** — 앱에서 **운영체제 폴더 대화상자**로 스캔할 루트를 추가합니다(여러 개 동시 선택 가능). 경로를 **직접 입력**해 추가하거나, 등록된 루트를 제거할 수도 있습니다.
- **인앱 재스캔 · 실시간 진행** — 메뉴/버튼으로 재스캔하면 같은 스캔 로직이 백그라운드(인프로세스)로 다시 실행되고, 진행 상황(순회 폴더·발견 프로젝트 수)이 창에 **실시간 푸시**됩니다. 끝나면 목록이 자동 갱신됩니다.
- **VS Code로 열기** — 카드에서 클릭 한 번으로 해당 프로젝트를 VS Code로 실행합니다. `code` CLI가 PATH에 없으면 **설정에서 실행 경로를 직접 지정**해 열 수 있습니다(아래 [VS Code로 열기](#vs-code로-열기) 참고).
- **경로 복사** — 카드/상세에서 프로젝트의 **절대경로를 클립보드로 복사**합니다(텍스트만 기록).
- **카드 순서 변경 · 즐겨찾기** — 카드를 **드래그(또는 키보드)로 순서 변경**하면 수동 순서로 전환되어 다음 실행에도 유지되고, 정렬을 다시 고르면 자동 정렬로 돌아갑니다. 순서가 바뀔 때 카드가 **점프 없이 부드럽게 이동하는 애니메이션**이 적용됩니다(운영체제 "동작 줄이기" 설정 시 즉시 적용·애니메이션 생략). 카드를 **즐겨찾기**에 등록하고 '즐겨찾기만' 필터로 추릴 수 있습니다(순서·즐겨찾기는 앱 데이터 폴더의 `ui-state.json`에 보관).
- **즐겨찾기 토스트 창** — 트레이 메뉴의 **즐겨찾기**를 누르면, 등록한 프로젝트를 좌우로 넘겨 보는 **별도의 작은 토스트 창**이 화면 **우측 하단**에 뜹니다. 이 창은 **대시보드와 독립**되어 있어, **대시보드를 닫아 트레이에만 남아 있어도** 단독으로 열립니다. 창 밖을 클릭하면 닫히고(Esc·× 버튼으로도 닫힘), 카드에서 바로 **VS Code로 열기·경로 복사·즐겨찾기 해제**를 할 수 있습니다(대시보드와 실시간 동기화).
- **트레이 상주** — 창을 닫아도 종료되지 않고 **트레이에 남습니다**(백그라운드 스캔 유지). 트레이 우클릭 메뉴로 **대시보드 열기 / 즐겨찾기 / 종료**를 제공합니다. 완전히 끄려면 트레이 메뉴의 **종료**를 사용합니다.
- **필터 · 정렬 · 검색** — 언어·신선도·Git 상태로 필터(AND), 이름·수정일 정렬, 이름·경로 검색(모두 클라이언트 메모리에서 처리).
- **접근성** — 키보드 조작(스킵 링크·포커스 윤곽), 상세 드로어의 포커스 트랩·복원, 진행 상태의 `aria-live` 안내, 색상 외 텍스트 라벨 병기.
- **자동화용 CLI** — `spip`/`npm run scan` 명령으로 어디서든 스캔만 실행할 수 있습니다(앱 없이 데이터만 생성). 위 GUI 기능(경로 복사·툴 경로 설정·순서/즐겨찾기·트레이)은 데스크톱 앱 전용입니다.

> **로컬 전용·단일 사용자 도구입니다.** 외부로 데이터를 전송하지 않으며, 모든 처리는 이 PC 안에서만 일어납니다. 신뢰할 수 없는 클론 리포가 섞여 있어도 안전하도록, 스캔 데이터는 `textContent`로만 렌더해 XSS를 차단하고(L-1), 모든 경로는 `pathGuard`로 실경로 화이트리스트 검증을 거치며(H-1), 외부 프로세스는 `safeExec`로 절대경로·`shell:false` 실행됩니다(H-2). 스캔 결과·설정은 OS 앱 데이터 폴더에 저장되어 프로젝트 폴더를 오염시키지 않습니다.

## 요구 사항

- [Node.js](https://nodejs.org/) **18 이상 권장** (개발·빌드 시. `package.json`의 `engines.node`는 `>=18`)
- 설치본을 받아 쓰는 최종 사용자는 Node.js가 필요 없습니다(Electron 런타임이 패키지에 포함).
- (선택) **VS Code 실행 파일** — 'VS Code로 열기' 기능에 필요합니다. `code` CLI가 PATH에 있으면 그대로 동작하고, 없으면 **설정에서 실행 경로를 직접 지정**할 수 있습니다(아래 [VS Code로 열기](#vs-code로-열기) 참고).

## 설치 (개발 환경)

```bash
git clone https://github.com/SimJaeSugn/Project-SPIP.git
cd Project-SPIP
npm install
```

> `electron`·`electron-builder`·`@electron/fuses`는 **devDependencies**입니다. 런타임 의존성은 자동 업데이트 클라이언트인 **`electron-updater` 1개**뿐이며(스캔 로직은 Node.js 내장 모듈만 사용), UI도 빌드 도구·프레임워크 없는 순수 HTML/CSS/JS입니다.

## 실행 (개발)

```bash
npm start          # = electron .  — 데스크톱 앱 창 실행
```

Windows에서는 빌드 없이 바로 띄우고 싶다면 **`run.bat` 더블클릭**으로도 됩니다(`node_modules`가 없으면 `npm install`까지 자동 수행한 뒤 `npm start`).

앱 창이 뜨면:

1. 처음에는 스캔 결과가 없으므로 **첫 실행 화면**이 나타납니다.
2. **폴더 선택** 버튼으로 네이티브 대화상자를 열어 스캔할 루트를 추가하거나, 경로를 직접 입력해 추가합니다.
3. **스캔 시작/재스캔**을 누르면 진행 상황이 실시간으로 표시되고, 끝나면 프로젝트 카드 목록으로 전환됩니다.

루트가 등록되어 있고 시스템 폴더·드라이브 루트가 아니라면(보안 게이트) 곧바로 스캔할 수 있습니다.

## 설치본 빌드 (배포)

`electron-builder`로 Windows용 설치본/포터블을 만듭니다. 결과물은 **NSIS 설치본 + 포터블 실행 파일**(`dist/`)입니다.

**가장 간단한 방법 (Windows, 더블클릭):**

```text
build.bat        # 더블클릭 — 의존성 확인 → 이전 dist 정리 → electron-builder 빌드 → dist 폴더 자동 열기
```

`build.ps1`(PowerShell)도 동일하게 빌드하며 `-Portable` 옵션을 받습니다(포터블만 빌드).

```powershell
powershell -ExecutionPolicy Bypass -File build.ps1            # NSIS + portable
powershell -ExecutionPolicy Bypass -File build.ps1 -Portable  # portable만
```

**npm 스크립트로:**

```bash
npm run build            # NSIS 설치 파일 + portable 실행 파일 (electron-builder.yml의 win.target)
npm run build:portable   # portable 단일 실행 파일만
```

- 산출물은 `dist/`에 생성됩니다(`.gitignore`로 커밋 제외).
- **NSIS 설치본** — 설치 마법사로 설치(설치 경로 변경 가능·바탕화면/시작 메뉴 바로 가기 생성). 설치 후 더블클릭으로 실행.
- **포터블** — 설치 없이 더블클릭으로 바로 실행되는 단일 실행 파일.

> **빌드 실패 흔한 원인 (Windows Defender):** Defender 실시간 검사가 새로 만든 `app.asar`에 핸들을 걸어 이전 빌드 출력(`dist\win-unpacked`) 정리를 막으면 `electron-builder`가 `ERR_ELECTRON_BUILDER_CANNOT_EXECUTE`로 실패할 수 있습니다. 반복 빌드 시 **`add-defender-exclusion.bat`를 1회 관리자 권한으로 실행**해 프로젝트 폴더를 Defender 예외에 등록하면 잠금이 사라집니다(UAC 동의 필요, 1회면 충분).

> **코드 서명 안내(수용된 위험):** 현재 배포본은 **미서명**입니다. Windows에서 처음 실행할 때 SmartScreen이 "Windows의 PC 보호" 경고를 띄울 수 있습니다. 이때 **추가 정보 → 실행**을 누르면 실행됩니다. (PM 위험 수용 확정 사항 — `electron-builder.yml` 주석 참고.)

## 릴리즈 게시 · 자동 업데이트

`npm run release` 한 번으로 **GitHub Releases 에 게시**하면(인스톨러 `exe` + `*.blockmap` + `latest.yml`),
설치본은 `electron-updater` 로 `latest.yml` 을 보고 새 버전을 감지합니다. 업데이트는 **사용자 주도**로,
앱 **설정 → 소프트웨어 업데이트** 섹션에서 **[업데이트 확인] → [다운로드] → [재시작하여 설치]** 버튼으로
진행하며 다운로드 진행률이 실시간 표시됩니다(`autoDownload=false`).

게시 위치는 `electron-builder.yml` 의 `publish`(provider: github / owner `SimJaeSugn` / repo `Project-SPIP`)에,
클라이언트 연동은 `electron/autoUpdate.js`(메인) + `electron/preload.js`(`onUpdateStatus` 등) + `public/app.js`
(설정 UI)에 있습니다.

### 사전 준비

- **GitHub CLI(`gh`) 로그인**: `gh auth login` (저장소 소유 계정). 게시 토큰은 `gh auth token` 으로 즉석에서 꺼내 씁니다(토큰 커밋 금지).
- 토큰을 파일로 둘 경우 `electron-builder.env` 에 두고 커밋하지 않습니다(`.gitignore` 등록됨).

### 릴리즈 절차 (매 배포마다)

```bash
# 1) 버전업 (단조 증가 — 같은 버전 재게시는 업데이트로 인식되지 않음)
npm version <new-version> --no-git-tag-version    # 예: 1.0.2 (package.json + lock 갱신)

# 2) 커밋 + 태그(vX.Y.Z) + 푸시
git add -A
git commit -m "release: v<new-version>"
git tag v<new-version>
git push origin master
git push origin v<new-version>

# 3) 빌드 + 게시 (gh 토큰 주입) — Git Bash/POSIX 쉘 기준
GH_TOKEN="$(gh auth token)" npm run release
#   PowerShell:  $env:GH_TOKEN = (gh auth token); npm run release

# 4) (선택) 릴리즈 노트 작성
gh release edit v<new-version> --title "v<new-version> — <한 줄 제목>" --notes "변경 요약…"

# 5) 확인 — 자산 3종(Setup .exe / .exe.blockmap / latest.yml)이 보여야 정상
gh release view v<new-version> --json tagName,isDraft,assets \
  -q '.tagName, ("draft="+(.isDraft|tostring)), (.assets[].name)'
```

> `npm run release` = `electron-builder --win --publish always`. `--publish always` 가 빌드 산출물(NSIS 설치본·
> portable·`latest.yml`·`*.blockmap`)을 태그에 해당하는 GitHub Releases 로 업로드합니다.

### 함정 / 주의

1. **게시 토큰 필수** — `GH_TOKEN`/`GITHUB_TOKEN` 미설정 시 publish 실패. `gh` 로그인 상태면 위처럼 즉석 주입.
2. **버전 단조 증가** — `latest.yml` 버전이 설치본보다 높아야 감지됩니다. 같은 버전 재게시는 인식 안 됨.
3. **일시적 게시 실패 → 재시도** — 이전 산출물/실행 중 앱이 파일을 잠그면 한 번 실패할 수 있습니다. **그대로 다시 `npm run release`** 하면 대개 성공(실패 시 `gh release view` 로 실게시 여부 확인).
4. **미서명 = SmartScreen 경고** — 정상이며 배포는 됩니다(위 코드 서명 안내 참고).
5. **개발 모드에서는 업데이트 확인 불가** — `app.isPackaged` 가드로 설치본에서만 동작합니다(설정 UI에 "개발 모드" 안내 표시).
6. **검증 한계(정직)** — 코드·빌드·게시까지는 자동 확인되지만, **NSIS 설치본을 실제로 설치해 감지→다운로드→재시작 설치 왕복**까지는 별도 수동 검증이 필요합니다.

## VS Code로 열기

카드의 **'VS Code로 열기'** 액션은 VS Code 실행 파일을 절대경로로 해석해 실행합니다(`safeExec`, `shell:false`, 실행 인자는 프로젝트 경로 1개 고정). 실행 경로는 **사용자가 설정에서 지정한 경로를 우선** 사용하고, 없으면 **PATH의 `code`로 폴백**합니다. 둘 다 없으면 앱이 죽지 않고 `code CLI를 찾을 수 없음` 안내를 표시합니다.

### `code`가 PATH에 없을 때 — 설정에서 실행 경로 지정

`code`가 PATH에 없어 열기가 실패하면, 두 가지로 해결할 수 있습니다.

1. **PATH에 추가** — VS Code에서 명령 팔레트(`Ctrl/Cmd+Shift+P`) → **"Shell Command: Install 'code' command in PATH"** 를 실행합니다. 앱은 미해결 상태일 때 이 안내를 함께 표시합니다.
2. **실행 경로 직접 지정** — 앱 **설정 → 외부 툴 경로**에서 실행 파일(`.exe`) 경로를 직접 입력하거나 **'실행 파일 선택…'** 으로 네이티브 파일 대화상자에서 고릅니다(예: `C:\Program Files\Microsoft VS Code\Code.exe`). 지정한 경로는 `ui` 설정이 아니라 설정 파일의 `tools`에 보관되며, '지정 해제'로 다시 PATH 폴백으로 되돌릴 수 있습니다.

> 지정 경로는 **저장 시점에 검증**(절대경로·존재·`.exe`·실경로)하고, **열 때마다 다시 확인**합니다. 보안상 실행 파일은 `.exe`만 허용하며, 실행 인자에 프로젝트 경로 외 다른 값을 끼워 넣지 않습니다.

> **확장형** — 외부 툴 레지스트리는 향후 다른 에디터/도구를 추가할 수 있도록 설계됐습니다. 현재 등록된 툴 ID는 `code` 하나이며(허용 목록 기반), 새 툴은 코드에 명시 등록해야 실행 대상이 됩니다.

## 자동화용 CLI (앱 없이 스캔만)

앱과 별개로, 스캔 데이터만 생성하는 CLI를 유지합니다(스크립트·자동화용).

```bash
# 스캔할 루트를 인자로 지정 (쉼표로 여러 개)
npm run scan -- --roots "C:/work,C:/code"
# 또는 spip 명령으로 (npm link 후)
spip --roots "C:/work,C:/code"
```

한 번 `--roots`로 지정하거나 설정 파일의 `scanRoots`에 경로를 적어두면, 이후에는 인자 없이 `npm run scan`만 실행해도 됩니다. 스캔 결과는 앱이 읽는 것과 동일한 캐시(`<appDir>/cache/projects.json`)에 저장되므로, CLI로 스캔한 뒤 앱을 열면 그대로 반영됩니다.

주요 옵션:

| 옵션 | 설명 |
| --- | --- |
| `--roots <a,b,c>` | 스캔할 루트 디렉터리(쉼표 구분, 설정 파일보다 우선) |
| `--stale-days <n>` | stale(무활동) 판정 기준일 (기본 90) |
| `--depth <n>` | 순회 깊이 상한 (기본 24, 절대 상한 64) |
| `--with-size` | 규모(총 용량·`node_modules` 크기) 측정 활성화 (opt-in, 기본 off·예산 내) |
| `--all-drives` | 전체 드라이브 스캔 (설정 `allowAllDrives: true`일 때만 적용) |
| `--config <path>` | 설정 파일 경로 지정 |
| `--quiet`, `-q` | 진행 로그 억제 |
| `--help`, `-h` | 도움말 |

| 스크립트 | 명령 | 설명 |
| --- | --- | --- |
| `start` | `electron .` | **데스크톱 앱 실행** |
| `build` | `electron-builder` | 설치본 빌드(Windows NSIS + portable) |
| `build:portable` | `electron-builder --win portable` | 포터블 빌드만 |
| `release` | `electron-builder --win --publish always` | 빌드 + **GitHub Releases 게시**(자동 업데이트용 `latest.yml` 포함) |
| `scan` | `node scan.js` | 자동화용 스캔(데이터만 생성, bin: `spip`) |
| `test` | `node --test "test/**/*.test.js"` | 단위·통합 테스트 (503건) |

> **과도기 HTTP 서버(`start:web`/`serve:http`):** Electron 전환 이전의 로컬 웹 서버(`server.js`, `127.0.0.1`)가 `npm run start:web`으로 **아직 남아 있습니다.** 전환이 완료되어 더 이상 기본 경로가 아니며, **후속으로 제거 예정**입니다(코드 리뷰 P2-2). 일반 사용에는 `npm start`(Electron)를 사용하세요.

## 데이터 저장 위치

스캔 결과(JSON)와 설정은 프로젝트 폴더가 아니라 **OS 앱 데이터 폴더**에 보관됩니다.

| OS | 경로 |
| --- | --- |
| Windows | `%APPDATA%\spip\` |
| macOS | `~/Library/Application Support/spip/` |
| Linux | `$XDG_CONFIG_HOME/spip/` (없으면 `~/.config/spip/`) |

- 설정: `<appDir>/config/spip.config.json`
- 캐시(스캔 결과): `<appDir>/cache/projects.json` (소유자 전용 권한·원자적 쓰기)
- UI 상태(즐겨찾기·카드 순서·정렬 모드): `<appDir>/ui-state/ui-state.json` (소유자 전용 권한·원자적 쓰기)

> 설치본은 **설치 디렉터리를 읽기 전용**으로 두고, 쓰기 데이터는 위 앱 폴더에만 기록합니다(`electron-builder.yml`).

설정 파일에서 쓸 수 있는 주요 키:

| 키 | 기본값 | 설명 |
| --- | --- | --- |
| `scanRoots` | `[]` | 스캔할 루트 디렉터리 목록(앱의 폴더 선택으로도 갱신) |
| `staleDays` | `90` | stale 판정 기준일 |
| `depthLimit` | `24` | 순회 깊이 상한(절대 상한 64) |
| `allowAllDrives` | `false` | `--all-drives` 허용 게이트 |
| `size.enabled` | `false` | 규모(용량) 측정 활성화 |
| `tools` | `{}` | 외부 툴 실행 경로 맵(`{ code: { path, label } }`). 앱 설정의 '외부 툴 경로'로 갱신. 허용된 툴 ID만 채택 |

## 보안 모델 (요약)

- **렌더러 격리** — `contextIsolation:true`·`nodeIntegration:false`·`sandbox:true`. preload는 `window.spip`에 §4 IPC 채널 함수만 allowlist로 노출하며, `ipcRenderer` 원본·범용 invoke는 노출하지 않습니다. **즐겨찾기 토스트 창**도 메인창과 동일한 격리·`app://` 로드·CSP·하드닝·발신자 검증을 적용하되, 전용 preload(`preload-favorites.js`)로 표시·동작에 필요한 6개 채널(`getUiState`·`getProjects`·`open`·`copyText`·`setFavorite`·`onFavoritesChanged`)만 노출해 표면을 더 좁힙니다.
- **자산 서빙** — `app://` 커스텀 프로토콜로 `public/`만 서빙(디렉터리 이탈 차단). 원격 로드·새 창·`webview`·외부 탐색은 전부 차단합니다.
- **CSP** — `default-src 'none'` 기반 정책을 헤더로 주입(`connect-src 'none'` — IPC만 사용).
- **발신자 검증** — 모든 IPC 핸들러는 `senderFrame`이 신뢰 origin(`app://`)인지 정확 일치로 검증하고, 아니면 `FORBIDDEN`을 반환합니다.
- **패키징 하드닝** — `@electron/fuses`(`build/afterPack.js`)로 `RunAsNode` 비활성·`EnableNodeCliInspectArguments` 비활성·`OnlyLoadAppFromAsar` 활성·`EnableNodeOptionsEnvironmentVariable` 비활성을 굽고, `ELECTRON_RUN_AS_NODE` 기동을 즉시 차단합니다. 단 `EnableEmbeddedAsarIntegrityValidation`은 Windows+electron-builder 24.x에서 무결성 리소스가 exe에 자동 주입되지 않아 활성화 시 `FindResource` FATAL로 앱이 즉시 죽는 문제가 있어 **그 항목만 비활성**입니다(나머지 fuse는 유지). 자세한 사유는 `build/afterPack.js` 주석 참고.

## 디렉터리 구조

```
Project-SPIP/
├─ electron/             # Electron main·preload·IPC (데스크톱 앱)
│  ├─ main.js            # composition root: 창·메뉴·생명주기·app:// 프로토콜·보안 wiring
│  ├─ preload.js         # contextBridge allowlist (window.spip — 메인창)
│  ├─ preload-favorites.js # 즐겨찾기 위젯 전용 축소 allowlist 6채널 (R-22)
│  ├─ favoritesWidget.js # 즐겨찾기 독립 토스트 창 생성·우측하단 배치·show/hide 재사용 (R-22)
│  ├─ context.js         # config·store·scanController 조립(server.js 승계)
│  ├─ security.js        # CSP·하드닝·신뢰 origin
│  ├─ menu.js            # 네이티브 메뉴 → spip:menu:* 전송
│  ├─ tray.js            # 트레이 아이콘·컨텍스트 메뉴(대시보드/즐겨찾기/종료) (R-21)
│  ├─ autoUpdate.js      # GitHub Releases 자동 업데이트 클라이언트(electron-updater, 사용자 주도)
│  └─ ipc/               # data·actions·scan·folders·clipboard·tools·uiState·register (순수 (args,ctx)→result)
├─ public/               # index.html · styles.css · app.js (빌드 없는 순수 UI, IPC 어댑터)
│                        # + favorites.html · favorites.js (즐겨찾기 위젯 창 UI, R-22)
├─ lib/
│  ├─ common/            # paths · config · logger · pathGuard · safeExec · toolRegistry · uiStateStore
│  ├─ scan/              # walker · detector · driveEnum · collectors/* · scanner · serializer
│  └─ server/            # scanController · snapshotStore + (과도기 HTTP: router · apiHandlers …)
├─ scan.js               # CLI 스캐너 진입점 (bin: spip)
├─ server.js             # 과도기 HTTP 서버 진입점 (npm run start:web — 제거 예정)
├─ build/                # afterPack.js (electron-builder fuses 적용 훅) · 아이콘
├─ electron-builder.yml  # 패키징 설정(NSIS + portable, fuses, asar)
├─ build.bat / build.ps1 # Windows 빌드 헬퍼(더블클릭 · -Portable)
├─ run.bat               # 빌드 없이 앱 실행(= npm start)
├─ add-defender-exclusion.bat  # 반복 빌드 시 Defender 예외 1회 등록(관리자)
└─ test/                 # node:test 기반 단위·통합 테스트 (503건)
```

## 동작 방식

1. **main 프로세스**(`electron/main.js`)가 `app://` 프로토콜로 `public/` UI를 로드하고, `context.js`로 설정·스냅샷 스토어·스캔 컨트롤러를 조립합니다.
2. **renderer**(`public/app.js`)는 `window.spip.*` IPC만 호출합니다. 폴더 선택(`pickFolders`)·경로 추가(`addRoots`)·재스캔(`rescan`)·열기(`openInVsCode`)는 모두 IPC로 main에 전달되고, main이 입력을 재검증합니다.
3. **재스캔**은 `scanController`가 백그라운드(인프로세스)로 같은 스캔 로직을 실행하고(전역 단일 락), 진행 스냅샷을 `spip:scanProgress`로 창에 push합니다. 끝나면 캐시를 무중단 교체해 목록을 갱신합니다.

> IPC 채널 계약의 정본은 `docs/architecture/electron-migration.html` §4입니다.

## 라이선스

[MIT](LICENSE)
