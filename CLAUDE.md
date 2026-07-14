# CLAUDE.md

이 파일은 Claude Code가 이 저장소에서 작업할 때 따르는 프로젝트 지침이다.
한국어 중심으로 응답을 생성하는 것을 원칙으로 한다.

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

## UI 규약 — 홈 위젯 반응형 (필수)

홈 대시보드 위젯은 크기 조절이 가능하다(폭=열 스팬, 높이=px). 따라서 **모든 위젯은
자신이 표현될 개별 영역의 크기에 따라 반응형으로 적절한 UI를 가져야 한다** — 뷰포트가
아니라 **위젯 자신의 영역 크기**가 기준이다. 신규·수정 위젯은 이 계약을 반드시 지킨다.

- 각 위젯 콘텐츠 래퍼(`.home-section__content`)는 `container-type: inline-size` 컨테이너다.
  위젯 내부 레이아웃은 **컨테이너 쿼리(`@container hw ...`)** 또는 **컨테이너 반응 단위/
  auto-fit**로 위젯 폭에 반응하게 만든다(뷰포트 미디어쿼리 지양).
- 넓어지면 공간을 활용하고(예: 목록형은 `.hw-cols` = `repeat(auto-fit, minmax(…,1fr))`로
  다열), 좁아지면 무너지지 않게 스택/축소한다(예: 가로 2단은 `@container` 로 세로 스택).
- 높이 가변에도 대응한다 — 콘텐츠는 상단 정렬(빈 공간 허용), 필요 시 내부 스크롤/클립.
- 크기는 `homeWidgetSizes`(순서·표시와 직교, 메인 `normalizeHomeWidgetSizes` 단일 신뢰
  경계)로 영속된다. 배치는 `layoutHomeMasonry`(CSS Grid + 폭/높이 스팬)가 계산한다.
- 위젯 추가 시 반응형 동작에 대한 배선 테스트(정적 소스/순수 로직)를 함께 둔다.

**크기 매트릭스 계약 — 최소 크기 + 6개 조합 무잘림(필수).** 모든 위젯은 **최소 가로·세로
크기**를 가져야 하고, 그 최소 크기를 기준으로 아래 (가로 열 스팬, 세로 높이 배수) 6개 조합
각각에 대해 **그 영역에 맞는 반응형 UI**를 갖춰야 한다. 어떤 조합에서도 위젯 내부 콘텐츠가
**잘리거나 넘쳐서는 안 된다**(overflow 시 내부 스크롤/축약/스택으로 흡수, 콘텐츠가 컨테이너
밖으로 새지 않게).

- 대상 조합: **(1,1), (1,2), (1,3), (1,4), (2,1), (3,1)** — `(가로, 세로)`.
  세로형(1×2·1×3·1×4)은 세로로 자라는 공간을, 가로형(2×1·3×1)은 가로로 넓어지는 공간을
  각각 활용하되 그 반대 축이 최소일 때도 무너지지 않아야 한다.
- 판정 기준은 뷰포트가 아니라 **위젯 자신의 영역 크기**다(위 컨테이너 쿼리·컨테이너 단위 원칙).
- 신규·수정 위젯은 이 6개 조합에서 무잘림·반응형을 확인하는 **배선/렌더 테스트**(정적 소스
  또는 순수 로직)를 함께 둔다.

**표현 방식 — 행·열 병합(레이아웃 모델).** 홈은 CSS Grid masonry(`.home-masonry`)다. 위젯을
추가·수정할 때 이 병합 모델을 깨지 않는다.

- **열 병합(폭)**: 위젯 셀의 `grid-column: span w`. 반응형 열 수는 `computeHomeCols`(열 최소폭
  `HOME_COL_MIN_W`=300px, 최대 `HOME_MAX_COLS`=4)가 콘텐츠 폭에서 산출해 `--home-cols`로
  주입하고, `w`는 현재 열 수로 클램프된다. 미조절 기본 스팬은 `homeDefaultSpan`(그 외 1,
  `shelfWide`는 전체폭).
- **행 병합(높이)**: `grid-row: span`. 미세 행 `HOME_ROW_UNIT`=8px·`HOME_GAP`=20px 기준으로
  **측정 높이(또는 사용자 지정 높이)**에서 스팬을 계산해 높이가 제각각인 카드를 masonry로
  촘촘히 채운다. 따라서 위젯은 **고정폭·고정높이를 가정하지 말 것** — 콘텐츠 높이가 바뀌면
  `layoutHomeMasonry`가 rAF·`ResizeObserver`·창 리사이즈로 재측정·재배치한다(async 로드
  위젯은 이 재배치를 전제로 작성).
- 각 위젯 셀은 우하단 **모서리 리사이즈 핸들**(`.home-resize`)을 가진다 — 위젯 내부에 우하단
  코너를 점유하는 상시 컨트롤을 두지 않는다(핸들과 충돌). 재정렬(SortableJS)과도 공존한다.

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
