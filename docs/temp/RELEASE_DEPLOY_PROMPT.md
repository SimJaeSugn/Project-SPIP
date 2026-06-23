# Electron 릴리즈·자동 업데이트 배포 셋업 — 지시 프롬프트

> 이 문서는 **AGT-Finder(Electron + electron-vite + TypeScript, Windows/NSIS)** 에서 검증한
> "GitHub Releases 기반 자동 업데이트 + 원커맨드 게시" 방식을 **다른 프로젝트에 그대로 옮기기**
> 위한 지시서다. 사람이 따라 해도 되고, AI 에이전트에게 통째로 붙여넣어 시켜도 된다.
> 맨 아래 **[§9 복붙용 지시 프롬프트]** 만 따로 떼어 써도 된다.

---

## 0. 한 줄 요약

`npm run release` 한 번 → electron-vite 빌드 → electron-builder 가 NSIS 설치본을 만들고
**GitHub Releases 에 게시(exe·blockmap·latest.yml)** → 사용자 앱은 `electron-updater` 로
`latest.yml` 을 보고 새 버전을 감지한다. **자동 다운로드는 끄고(autoDownload=false) 사용자가
버튼으로 확인→다운로드→재시작 설치**(원하면 자동으로 바꿀 수 있음).

핵심 구성요소: `electron-builder`(패키징·게시) + `electron-updater`(클라이언트 감지/설치) +
`gh` CLI(게시 토큰).

---

## 1. 사전 준비

- **GitHub 저장소** 1개(공개 권장 — 비공개면 사용자 앱에도 토큰 필요).
- **GitHub CLI(`gh`) 로그인**: `gh auth login` → 저장소 소유 계정으로 로그인.
  - 게시용 토큰은 `gh auth token` 으로 즉석에서 꺼내 쓴다(저장소에 토큰 커밋 금지).
- Node/npm, 그리고 Electron 빌드 환경(Windows 타깃이면 Windows 권장).

---

## 2. 의존성 추가

```bash
npm i -D electron-builder@^24      # 패키징·게시
npm i electron-updater@^6          # 클라이언트(런타임 dependency — 메인에서 import)
```

> `electron-updater` 는 **devDependencies 가 아니라 dependencies** 여야 한다(런타임에 import).
> 네이티브 모듈 없음.

---

## 3. `electron-builder.yml` (프로젝트 루트)

`<...>` 부분만 프로젝트에 맞게 바꾼다.

```yaml
appId: com.example.app                 # <역DNS 형식 고유 ID>
productName: MyApp                      # <앱 표시 이름>
copyright: Copyright © 2026 MyApp Team

directories:
  output: dist
  buildResources: resources

# electron-vite 산출물(out/)만 패키징에 포함. sourcemap(.map)은 배포 제외.
files:
  - out/**/*
  - '!out/**/*.map'
  - package.json

asar: true
# (선택) asar 가 못 읽는 파일(.ps1 등)을 풀어둘 때만:
# asarUnpack:
#   - '**/someWorker.ps1'

win:
  target:
    - target: nsis
      arch: [x64]
  icon: resources/icon.ico
  # 코드 서명(선택): CSC_LINK(.pfx 경로/base64)·CSC_KEY_PASSWORD 환경변수를
  # electron-builder 가 자동 인식. 미설정이면 미서명 빌드(경고만, 빌드는 성공).
  signingHashAlgorithms: [sha256]
  # rfc3161TimeStampServer: http://timestamp.digicert.com   # 서명 시 주석 해제

nsis:
  oneClick: false
  perMachine: false                     # 사용자 단위 설치(관리자 권한 불필요)
  allowToChangeInstallationDirectory: true
  createDesktopShortcut: true
  createStartMenuShortcut: true
  shortcutName: MyApp

# ★ 자동 업데이트의 핵심: 게시 위치. electron-builder 가 릴리즈에 인스톨러와 함께
#   latest.yml·*.blockmap 을 올리고, app-update.yml 을 패키지에 번들한다.
publish:
  - provider: github
    owner: <github-owner>               # <GitHub 계정/조직>
    repo: <repo-name>                   # <저장소 이름>
    releaseType: release                # 게시 즉시 공개(자동 업데이트가 바로 인식)
```

> **왜 `files: out/**` 인가**: electron-vite 가 `out/` 에 main/preload/renderer 를 빌드한다.
> `resources/` 는 buildResources(빌드용)일 뿐 자동 포함되지 않으므로, 런타임에 필요한
> 정적 파일은 빌드 스크립트로 `out/` 안에 복사해 넣어야 한다.

---

## 4. `package.json` 스크립트

```jsonc
{
  "main": "./out/main/index.js",
  "scripts": {
    "clean": "node scripts/clean.mjs out",   // 또는 rimraf out
    "prebuild": "npm run clean",              // build 전에 out/ 정리(npm 이 자동 실행)
    "typecheck": "tsc --noEmit -p tsconfig.node.json && tsc --noEmit -p tsconfig.web.json",
    "build": "npm run typecheck && electron-vite build",
    // ★ 원커맨드 게시: 빌드 → NSIS 패키징 → GitHub Releases 업로드
    "release": "npm run build && electron-builder --win --config electron-builder.yml --publish always"
  }
}
```

> `--publish always` 가 빌드 산출물을 GitHub Releases 로 올린다. 게시 토큰은 `GH_TOKEN`
> (또는 `GITHUB_TOKEN`) 환경변수로 주입한다(§7 참조).

---

## 5. 메인 프로세스 — `electron-updater` 연동

`src/main/os/autoUpdate.ts`(예시 경로) 를 만들고, `app.whenReady()` 안에서 `initAutoUpdate()` 를 호출한다.

```ts
import { app, BrowserWindow } from 'electron'
// ⚠️ electron-updater 는 CommonJS — ESM 메인에서 `import { autoUpdater }` (named) 는
//    런타임 크래시("Named export 'autoUpdater' not found"). default import 후 구조분해만 동작.
// eslint-disable-next-line import/default
import electronUpdater from 'electron-updater'
// eslint-disable-next-line import/no-named-as-default-member
const { autoUpdater } = electronUpdater

let initialized = false

export function initAutoUpdate(): void {
  if (initialized) return
  initialized = true
  // 패키징된 설치본에서만 동작(dev/미패키징은 app-update.yml 이 없어 throw → 가드).
  if (!app.isPackaged) return

  autoUpdater.autoDownload = false        // 사용자 주도(원하면 true 로 = 완전 자동)
  autoUpdater.autoInstallOnAppQuit = true

  // 진행 상황을 렌더러로 브로드캐스트하고 싶으면 여기서 win.webContents.send(...)
  autoUpdater.on('error', (e) => console.error('[update]', e?.message ?? e))
  autoUpdater.on('update-downloaded', (info) => {
    // 예: 사용자에게 "재시작하여 설치" 안내 → autoUpdater.quitAndInstall(false, true)
    console.log('[update] downloaded', info.version)
  })

  // "시작 시 자동 확인"을 원하면 아래 한 줄(throw 0 격리):
  // autoUpdater.checkForUpdatesAndNotify().catch(() => {})
}
```

`src/main/index.ts`:

```ts
app.whenReady().then(() => {
  // ...창 생성 등...
  initAutoUpdate()   // trigger-and-forget: 실패해도 부팅 영향 0
})
```

> **두 가지 정책 중 택1**
> - **사용자 주도(권장·AGT-Finder 방식)**: `autoDownload=false` + IPC 로 check/download/install
>   버튼을 설정 화면에 노출. (`checkForUpdates()` → `downloadUpdate()` → `quitAndInstall(false,true)`)
> - **완전 자동**: `initAutoUpdate()` 안에서 `autoUpdater.checkForUpdatesAndNotify()` 호출 →
>   백그라운드 다운로드 후 종료 시 자동 설치.

무결성: 업데이트 파일은 `latest.yml` 의 SHA512 로 검증되므로 별도 작업 불필요.

---

## 6. `.gitignore`

```gitignore
out/
dist/
electron-builder.env    # 게시/서명 토큰을 파일로 둘 경우(커밋 금지)
```

---

## 7. 릴리즈 절차 (매 배포마다)

> 전제: 변경 작업이 끝났고 `npm run build` 가 통과하는 상태.

```bash
# 1) 버전업(태그·커밋은 수동으로 — 여기선 파일만 갱신)
npm version <new-version> --no-git-tag-version    # 예: 1.2.3  (package.json + lock 갱신)

# 2) 커밋(버전 표기 + 변경 요약)
git add -A
git commit -m "feat: <요약> (v<new-version>)"

# 3) 태그 + 푸시 (vX.Y.Z 규칙)
git tag v<new-version>
git push origin main
git push origin v<new-version>

# 4) 빌드 + 게시 (gh 토큰 주입)
GH_TOKEN="$(gh auth token)" npm run release

# 5) (선택) 릴리즈 노트 작성
gh release edit v<new-version> \
  --title "v<new-version> — <한 줄 제목>" \
  --notes "$(cat <<'EOF'
## ✨ 변경
- ...

## 📦 설치 / 업데이트
- 신규 설치: `MyApp-Setup-<new-version>.exe`
- 기존 사용자: 자동 업데이트로 새 버전 알림.
EOF
)"

# 6) 확인
gh release view v<new-version> --json tagName,isDraft,assets \
  -q '.tagName, ("draft="+(.isDraft|tostring)), (.assets[].name)'
# 자산 3종이 보여야 정상: <App>-Setup-x.y.z.exe / .exe.blockmap / latest.yml
```

`--publish always` + provider:github 이므로 4단계에서 **태그에 해당하는 릴리즈를 자동 생성**하고
인스톨러/blockmap/latest.yml 을 업로드한다. (태그가 없어도 생성되지만, 위처럼 태그를 먼저
push 해 두면 깔끔하다.)

---

## 8. 함정 / 주의사항 (실전에서 겪은 것)

1. **게시 토큰**: `GH_TOKEN`/`GITHUB_TOKEN` 미설정이면 publish 가 실패한다. `gh` 로그인 상태면
   `GH_TOKEN="$(gh auth token)" npm run release` 로 즉석 주입이 가장 간편.
2. **빌드 로그를 `out/` 에 쓰지 말 것**: `prebuild: clean` 이 `out/` 을 지우므로 `out/_release.log`
   같은 파일은 빌드 시작과 동시에 사라진다. 로그는 리포 루트나 시스템 임시 폴더에 둔다.
3. **일시적 게시 실패 → 재시도**: 직전 빌드 산출물(dist/exe)·실행 중인 앱이 파일을 잠그면
   패키징/업로드가 한 번 실패(EXIT=1)할 수 있다. **그대로 한 번 더 `npm run release`** 하면
   대개 성공한다. 실패 시 `gh release view`/`gh release list` 로 실제 게시 여부를 확인.
4. **미서명 빌드 = SmartScreen 경고**: 코드서명 인증서가 없으면 첫 실행 시 Windows SmartScreen
   경고가 뜬다("추가 정보 → 실행"). 정상이며, 배포는 된다. 서명하려면 `CSC_LINK`/`CSC_KEY_PASSWORD`.
5. **`app.isPackaged` 가드 필수**: dev 에서 `autoUpdater` 를 건드리면 `app-update.yml` 부재로
   throw 한다. 반드시 패키징 빌드에서만 동작하게 가드.
6. **electron-updater 의 CJS import**: §5 의 default-import 패턴을 지키지 않으면 메인 프로세스가
   기동 직후 크래시한다.
7. **버전 단조 증가**: GitHub Releases/`latest.yml` 의 버전이 현재 설치본보다 높아야 업데이트가
   감지된다. 같은 버전 재게시는 인식 안 됨 → 항상 새 버전으로 올린다.
8. **검증 한계(정직)**: 코드·빌드·게시까지는 자동 확인되지만, **NSIS 설치본을 실제로 설치해
   자동 업데이트 왕복(감지→다운로드→재시작 설치)** 까지는 별도 수동 검증이 필요하다.

---

## 9. 복붙용 지시 프롬프트 (AI 에이전트에게 줄 때)

아래 블록을 다른 프로젝트의 AI 에이전트에게 그대로 붙여넣으면 된다.

```text
이 Electron(electron-vite + TypeScript) 프로젝트에 "GitHub Releases 기반 자동 업데이트 +
원커맨드 게시"를 설정해줘. 방식은 다음을 따른다:

1. 의존성: electron-builder(-D), electron-updater(런타임 dependency) 추가.
2. electron-builder.yml 작성: appId/productName 은 이 프로젝트에 맞게, win=nsis(x64),
   asar:true, files:[out/**/*, !out/**/*.map, package.json], nsis(oneClick:false·
   perMachine:false·바로가기 생성), publish:[{provider:github, owner:<자동감지 or 물어봐>,
   repo:<자동감지 or 물어봐>, releaseType:release}].
3. package.json 스크립트: clean(out 정리), prebuild=clean, build="typecheck && electron-vite
   build", release="npm run build && electron-builder --win --config electron-builder.yml
   --publish always". main 은 ./out/main/index.js 확인.
4. 메인에 src/main/os/autoUpdate.ts 생성: electron-updater 를 **default import 후 구조분해**
   (named import 금지 — CJS 크래시), app.isPackaged 가드, autoDownload=false,
   autoInstallOnAppQuit=true, error/update-downloaded 리스너. app.whenReady() 에서
   initAutoUpdate() 를 trigger-and-forget 로 호출(throw 0 격리).
5. .gitignore 에 out/·dist/·electron-builder.env 추가.
6. 끝나면 typecheck/build 가 통과하는지 확인하고, 실제 게시는 하지 말고(내가 토큰 주입해
   직접 돌릴 거다) 릴리즈 절차를 README/문서로 정리해줘:
     npm version <ver> --no-git-tag-version → commit → git tag v<ver> → push main+tag →
     GH_TOKEN="$(gh auth token)" npm run release → gh release edit 로 노트.

주의: app.isPackaged 가드/CJS default import 를 빠뜨리면 런타임 크래시. 빌드 로그를 out/ 에
쓰면 prebuild clean 이 지운다. 버전은 항상 단조 증가. 코드서명 미설정이면 SmartScreen 경고는
정상(배포는 됨).
```

---

### 참고: AGT-Finder 실제 값(예시)
- `publish`: provider github / owner `SimJaeSugn` / repo `AGT-Explorer`
- 게시 산출물: `AGT-Finder-Setup-X.Y.Z.exe` · `.exe.blockmap` · `latest.yml`
- 정책: 사용자 주도(설정 "소프트웨어 정보"에서 확인/다운로드/설치 버튼)
- 버전 태그: `vX.Y.Z` (patch=버그수정, minor=기능추가)
