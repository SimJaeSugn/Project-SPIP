# CLAUDE.md

이 파일은 Claude Code가 이 저장소에서 작업할 때 따르는 프로젝트 지침이다.

## 작업 방식 — 기능 추가·수정은 하네스로 진행한다 (중요)

이 프로젝트에는 **`dev-harness-plus`** 플러그인(에이전트 팀 하네스)이 활성화되어 있다.
기능을 **추가·수정·보완**하는 작업은 메인 어시스턴트가 즉흥적으로 직접 구현하지 말고
아래 하네스 스킬을 경유한다. (오타 수정, 한 줄 문구 변경, 버전 표기 같은 사소한 변경은 예외 —
직접 처리해도 된다.)

- **설계가 필요한 새 기능/제품** → `dev-orchestrator` 스킬 (기획 → 아키텍처 설계)
- **설계가 끝났거나 기존 코드를 이어서 구현·수정** → `team-dev` 스킬 (개발팀 소집·구현)

판단 기준: "여러 파일에 걸친 기능 단위 작업"이면 하네스를 쓴다. 사용자가 캐주얼하게
("이 기능 추가해줘", "이거 고쳐줘") 요청해도 위 기준에 맞으면 해당 스킬을 먼저 띄울지
한 줄로 제안한 뒤 진행한다. 사용자가 "직접 해줘"라고 하면 그대로 따른다.

설계 산출물은 `docs/architecture/`, `docs/pm/`, `docs/design/`, 리뷰는 `docs/reviews/`에 둔다.

## 프로젝트 개요

PC에 흩어진 VS Code 프로젝트를 스캔해 설명·인사이트와 함께 한눈에 보여주는
**Electron 데스크톱 앱**(로컬 전용·단일 사용자). 과거 로컬 웹서버 방식에서 설치형 앱으로 전환됨.
빌드 도구·프레임워크 없는 **순수 HTML/CSS/JS** 프런트엔드, **CommonJS** Node 백엔드.

## 디렉토리 구조

- `electron/` — Electron 메인 프로세스. 진입점 `electron/main.js`, IPC 핸들러 `electron/ipc/`,
  `electron/preload.js`(렌더러 노출 API).
- `lib/scan/` — 스캔·탐지 로직(`scanner.js`, `detector.js`). Node 내장 모듈만 사용.
- `lib/server/` — 스캔 컨트롤러 등(`scanController.js`).
- `lib/common/` — 공통(`config.js` 설정·정규화·DEFAULTS·LIMITS, `uiStateStore.js`).
- `public/` — 프런트엔드(`app.js`, `styles.css`, `index.html`). 빌드 단계 없음.
- `scan.js` — CLI 진입점(`spip` / `npm run scan`). 앱 없이 스캔 데이터만 생성.
- `test/` — `node --test` 테스트.
- `docs/` — 기획/설계/리뷰 산출물, `docs/temp/RELEASE_DEPLOY_PROMPT.md`(릴리즈 절차).

## 명령어

```bash
npm start            # electron . — 데스크톱 앱 실행(개발)
npm run scan         # CLI 스캔만 실행(데이터 생성)
npm test             # node --test "test/**/*.test.js"
npm run build        # electron-builder (Windows 설치본)
npm run release      # electron-builder --win --publish always (게시)
```

## 코드 규약

- **CommonJS** (`require`/`module.exports`). `"type": "commonjs"`. ESM 금지.
- **순수 프런트엔드**: `public/`에 번들러/트랜스파일 없음. 바닐라 JS·CSS로 작성.
- **런타임 의존성 최소화**: 유일한 런타임 의존성은 `electron-updater`. 스캔 로직은 Node
  내장 모듈만 쓴다. 새 런타임 의존성 추가는 지양하고, 추가 시 근거를 명확히 한다.
- **버전 표시는 `package.json`에서 읽는다** (UI/문서에 버전 문자열 하드코딩 금지).
- 코드·주석·커밋 메시지는 주변 코드와 동일하게 **한국어** 위주.

## 보안 모델 (변경 시 반드시 유지)

로컬 전용 도구지만 신뢰할 수 없는 클론 리포가 섞여도 안전하도록 다음 불변식을 지킨다.
코드에 `L-1`, `H-1`, `H-2`, `M-3`, `R-02` 같은 마커로 추적된다.

- **렌더링은 `textContent`만** — 스캔 데이터를 `innerHTML`로 넣지 않는다(XSS 차단, L-1).
- **경로는 `pathGuard`로 실경로 화이트리스트 검증** 후 사용(H-1). 등록 경로는 realpath 정규화.
- **외부 프로세스는 `safeExec`로 절대경로·`shell:false`** 실행(H-2). 셸 인터폴레이션 금지.
- 스캔 시 시스템 폴더·드라이브 루트는 보안 게이트로 차단, 제외 폴더 하위 미진입(R-02),
  심링크 루프·과도 깊이 방어(M-3).
- 데이터는 OS 앱 데이터 폴더에 저장(프로젝트 폴더 비오염), 상태 파일은 0600 권한.

## 테스트

- `node --test` 사용. 파일은 `test/**/*.test.js`. 현재 전부 통과 상태를 유지한다.
- 테스트 이름에 요구사항 마커(H-1, M6-M-4 등)를 병기하는 컨벤션을 따른다.
- 기능 추가·수정 시 해당 동작과 보안 불변식에 대한 테스트를 함께 추가/갱신한다.

## 릴리즈 절차 (배포 시)

상세는 `docs/temp/RELEASE_DEPLOY_PROMPT.md` §7. 요약:

1. `npm version <ver> --no-git-tag-version` (버전 단조 증가 필수)
2. `git commit -m "feat: <요약> (v<ver>)"`
3. `git tag v<ver>` → `git push origin master` → `git push origin v<ver>`
4. `GH_TOKEN="$(gh auth token)" npm run release` — GitHub Releases에 exe·blockmap·latest.yml 게시
5. `gh release edit v<ver> --title ... --notes ...` 로 릴리즈 노트
6. `gh release view v<ver> --json tagName,isDraft,assets` 로 자산 3종+ 확인

주의: 미서명 빌드라 SmartScreen 경고는 정상. 같은 버전 재게시는 자동 업데이트가 인식 못 함.
