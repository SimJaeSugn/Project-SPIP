'use strict';
/**
 * explorer-widget.test.js — 폴더 탐색기 위젯 렌더러 배선 (정적 소스 + 순수 로직, 헤드리스 F-3)
 *
 * 프로젝트 UI 규약(CLAUDE.md §"UI 규약 — 홈 위젯 반응형")과 보안 규약(L-1)이 실제로 지켜지는지
 * 소스 대조로 회귀 방지한다. DOM 없이 검증 가능한 것만 본다.
 *
 *   · 위젯 id 가 세 레지스트리(HOME_SECTION_IDS / WIDGET_META / renderHomeSection switch)에 모두 배선
 *   · preload 노출 표면(spip.explorer.*) ↔ 렌더러 explorerIpc('메서드') 호출 정합
 *   · preload 채널명 ↔ register.js 등록 채널 정합(드리프트 0)
 *   · 반응형 계약: .fx-list/.fx-row 가 @container hw 로 위젯 폭에 반응(뷰포트 미디어쿼리 아님)
 *   · §3 코너 규약: 위젯 우하단 상시 컨트롤 없음(행 메뉴는 행 우측 절대배치)
 *   · L-1: 탐색기 렌더 경로에 innerHTML 없음
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { HOME_SECTION_IDS, TOGGLEABLE_WIDGET_IDS, homeDefaultSpan, HOME_MAX_COLS } = require('../public/app.js');

const ROOT = path.join(__dirname, '..');
const APP_SRC = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const CSS = fs.readFileSync(path.join(ROOT, 'public', 'styles.css'), 'utf8');
const PRELOAD_SRC = fs.readFileSync(path.join(ROOT, 'electron', 'preload.js'), 'utf8');
const REGISTER_SRC = fs.readFileSync(path.join(ROOT, 'electron', 'ipc', 'register.js'), 'utf8');

/** preload 의 explorer:{...} 블록에서 최상위 메서드 키를 뽑는다. */
function preloadExplorerKeys() {
  const at = PRELOAD_SRC.indexOf('explorer: {');
  assert.ok(at >= 0, 'preload 에 explorer 네임스페이스가 있어야 한다');
  const objStart = PRELOAD_SRC.indexOf('{', at);
  let depth = 0;
  const keys = new Set();
  for (let i = objStart; i < PRELOAD_SRC.length; i++) {
    const ch = PRELOAD_SRC[i];
    if (ch === '{') { depth++; continue; }
    if (ch === '}') { depth--; if (depth === 0) break; continue; }
    if (depth === 1 && /[A-Za-z_$]/.test(ch)) {
      let j = i;
      while (j < PRELOAD_SRC.length && /[A-Za-z0-9_$]/.test(PRELOAD_SRC[j])) j++;
      let k = j;
      while (k < PRELOAD_SRC.length && /\s/.test(PRELOAD_SRC[k])) k++;
      if (PRELOAD_SRC[k] === ':') keys.add(PRELOAD_SRC.slice(i, j));
      i = j - 1;
    }
  }
  return keys;
}

/** 탐색기 렌더/로직 구간(renderHomeExplorer 를 포함하는 fx* 코드 영역)을 대략 잘라낸다. */
function explorerSection() {
  const start = APP_SRC.indexOf('/* ===== [탐색기 위젯] 폴더 탐색기 =====');
  assert.ok(start >= 0, '탐색기 위젯 섹션 주석이 있어야 한다');
  const end = APP_SRC.indexOf('function renderHomeFeatureAdd()', start);
  assert.ok(end > start, '섹션 끝(renderHomeFeatureAdd) 을 찾아야 한다');
  return APP_SRC.slice(start, end);
}

test('탐색기 — 위젯 id 가 세 레지스트리에 모두 배선(HOME_SECTION_IDS / WIDGET_META / switch)', () => {
  assert.ok(HOME_SECTION_IDS.includes('explorer'), 'HOME_SECTION_IDS 에 explorer');
  assert.ok(TOGGLEABLE_WIDGET_IDS.includes('explorer'), '갤러리에서 추가/제거 가능(토글 위젯)');
  assert.ok(/explorer:\s*\{\s*name:\s*'폴더 탐색기'/.test(APP_SRC), 'WIDGET_META 에 표시 메타');
  // [위젯 인스턴스] 렌더 함수는 인스턴스({iid,type,name})를 받는다 — 같은 위젯을 여러 개 놓을 수 있다.
  assert.ok(/case 'explorer':\s*return renderHomeExplorer\(inst\);/.test(APP_SRC), 'renderHomeSection switch 배선(인스턴스 전달)');
  assert.ok(/maybeLoadExplorer\(\);/.test(APP_SRC), 'renderHome 에서 지연 적재 호출');
});

test('탐색기 — 숨김 위젯이면 IPC 0(불필요한 디스크 열람 회피)', () => {
  const m = APP_SRC.match(/function maybeLoadExplorer\(\)\s*\{[\s\S]*?\n  \}/);
  assert.ok(m, 'maybeLoadExplorer 정의');
  assert.ok(/homeWidgetVisible\('explorer'\)/.test(m[0]), '표시 중일 때만 적재');
});

test('탐색기 — 기본 폭 스팬은 2열(이름+크기+수정일이 들어갈 폭), 클램프 범위 내', () => {
  assert.strictEqual(homeDefaultSpan('explorer'), 2);
  assert.ok(homeDefaultSpan('explorer') <= HOME_MAX_COLS);
});

test('탐색기 — preload 표면(spip.explorer.*) ↔ 렌더러 explorerIpc 호출 정합', () => {
  const exposed = preloadExplorerKeys();
  const called = new Set();
  const re = /explorerIpc\('([A-Za-z0-9_$]+)'/g;
  let m;
  while ((m = re.exec(APP_SRC)) !== null) called.add(m[1]);

  assert.ok(called.size > 0, '렌더러가 explorerIpc 를 사용해야 한다');
  for (const c of called) {
    assert.ok(exposed.has(c), 'preload 에 노출되지 않은 메서드 호출: ' + c);
  }
  // 계약 최소 집합.
  for (const need of ['getRoots', 'pickRoot', 'removeRoot', 'list', 'open', 'reveal', 'openWith', 'mkdir', 'rename', 'trash']) {
    assert.ok(exposed.has(need), 'preload 노출 누락: ' + need);
  }
});

test('탐색기 — preload 채널명 ↔ register.js 등록 채널 정합(드리프트 0)', () => {
  const chans = new Set();
  const re = /'(spip:explorer:[A-Za-z]+)'/g;
  let m;
  while ((m = re.exec(PRELOAD_SRC)) !== null) chans.add(m[1]);
  assert.strictEqual(chans.size, 10, 'preload 가 10개 탐색기 채널을 호출');
  for (const c of chans) {
    assert.ok(REGISTER_SRC.includes("guard('" + c + "'"), 'register.js 미등록 채널: ' + c);
  }
});

test('탐색기 — 렌더러는 임의 경로 입력을 IPC 로 보내지 않는다(루트는 pickRoot=dialog 로만)', () => {
  const src = explorerSection();
  // 렌더러에 '경로 문자열 직접 입력' UI(prompt→addRoot 류)가 없어야 한다.
  assert.ok(!/explorerIpc\('addRoot'/.test(APP_SRC), 'addRoot(임의 경로 등록) 채널을 쓰지 않는다');
  assert.ok(/explorerIpc\('pickRoot'\)/.test(src), '루트 등록은 pickRoot(dialog)로만');
  // 이동 대상은 main 이 돌려준 실경로(cwd/parent/root) 또는 그 하위 이름 조립 — main 이 매 호출 재게이트.
  //   [위젯 인스턴스] 이동은 인스턴스별이라 iid 를 함께 넘긴다(탐색기 2개가 서로 다른 폴더를 본다).
  assert.ok(/explorerNavigate\(iid, fx\.parent\)/.test(src), '상위 이동은 main 이 준 parent 실경로');
});

test('탐색기 — L-1: 렌더 경로에 innerHTML 없음(전부 textContent/el)', () => {
  // 주석은 제거하고 실행 코드만 본다(설명 주석에 토큰이 들어가도 오탐 없게).
  const code = explorerSection()
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/innerHTML/.test(code), '탐색기 섹션 실행 코드에 innerHTML 금지');
  assert.ok(/text: entry\.name/.test(code), '항목 이름은 el({text}) → textContent');
});

test('탐색기 — L-3: 실패 코드 → 고정 문구 매핑(내부 경로·errno 비노출)', () => {
  const src = explorerSection();
  assert.ok(/var FX_CODES = \{/.test(src), '고정 코드 매핑 테이블');
  for (const code of ['PATH_DENIED', 'PATH_NOT_ALLOWED', 'READ_FAILED', 'ROOT_PROTECTED', 'EXISTS', 'BAD_NAME']) {
    assert.ok(new RegExp(code + ':').test(src), 'FX_CODES 누락: ' + code);
  }
  assert.ok(/function fxMessage\(code\)/.test(src), '미지 코드는 기본 문구로 폴백');
});

test('탐색기 — 조용한 절단 금지: truncated 면 표시 개수/전체 개수를 알린다', () => {
  const src = explorerSection();
  assert.ok(/fx\.truncated/.test(src) && /fx\.total/.test(src), 'truncated·total 을 UI 에 반영');
});

test('탐색기 — 파괴적 동작은 확인 모달을 거친다(휴지통·루트 등록 해제)', () => {
  const src = explorerSection();
  const trashBlock = src.slice(src.indexOf("if (action === 'trash')"));
  assert.ok(/askConfirm\(\{/.test(trashBlock), '휴지통 전송은 askConfirm');
  assert.ok(/danger: true/.test(trashBlock), '위험 액션 표시');
  const rmRoot = src.slice(src.indexOf('function explorerRemoveRootConfirm'));
  assert.ok(/askConfirm\(\{/.test(rmRoot), '루트 등록 해제도 확인 모달');
});

// ── 반응형 계약(CLAUDE.md UI 규약) ───────────────────────────────────────
test('탐색기 — 반응형: 위젯 폭 기준 @container hw 로 열을 접는다(뷰포트 미디어쿼리 아님)', () => {
  assert.ok(/@container hw \(max-width: 420px\)[\s\S]*?\.fx-row__time \{ display: none/.test(CSS),
    '≤420px 에서 수정일 열 접기');
  assert.ok(/@container hw \(max-width: 300px\)[\s\S]*?\.fx-row__size \{ display: none/.test(CSS),
    '≤300px 에서 크기 열 접기');
  // 탐색기 전용 규칙에 뷰포트 미디어쿼리를 쓰지 않았는지 — @media 블록 안에 .fx- 셀렉터가 없어야 한다.
  const mediaBlocks = CSS.match(/@media[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g) || [];
  for (const b of mediaBlocks) {
    assert.ok(!/\.fx-/.test(b), '탐색기 스타일은 뷰포트 @media 가 아니라 @container 로 반응해야 한다');
  }
});

test('탐색기 — 높이 가변: 목록이 남는 높이를 채우고 내부 스크롤(상단 정렬)', () => {
  assert.ok(/\.fx-list \{[^}]*flex: 1 1 auto[^}]*overflow-y: auto/.test(CSS), '목록이 높이를 채우고 스크롤');
  assert.ok(/\.fx-list \{[^}]*align-content: start/.test(CSS), '콘텐츠 상단 정렬(빈 공간 허용)');
  assert.ok(/\.home-section__content--sized \.fx-list \{ max-height: none/.test(CSS),
    '사용자 지정 높이면 기본 캡 해제 → 높이에 실제 반응');
});

test('탐색기 — §3 코너 규약: 위젯 우하단을 점유하는 상시 컨트롤 없음', () => {
  // 행 메뉴는 행(.fx-row) 기준 절대배치이며 카드 우하단(리사이즈 핸들)에 고정되지 않는다.
  assert.ok(/\.fx-menu \{[^}]*position: absolute/.test(CSS));
  assert.ok(/\.fx-row \{[^}]*position: relative/.test(CSS), '메뉴 기준점은 행');
  assert.ok(!/\.fx-[a-z-]*\s*\{[^}]*position: absolute[^}]*bottom: 0[^}]*right: 0/.test(CSS),
    '우하단 고정 컨트롤 금지(리사이즈 핸들과 충돌)');
  // 액션 버튼은 상단 툴바(.fx-tools)에 있다.
  assert.ok(/\.fx-tools \{/.test(CSS));
});

test('탐색기 — 좁은 폭에서 루트 칩·브레드크럼이 무너지지 않고 가로 스크롤로 흡수', () => {
  assert.ok(/\.fx-roots \{[^}]*overflow-x: auto/.test(CSS));
  assert.ok(/\.fx-crumbs \{[^}]*overflow-x: auto/.test(CSS));
});

// ── 순수 로직 ────────────────────────────────────────────────────────────
test('탐색기 — 편집 모드 재정렬 드래그와 분리(행 pointerdown stopPropagation)', () => {
  const src = explorerSection();
  assert.ok(/pointerdown: function \(e\) \{ e\.stopPropagation\(\); \}/.test(src),
    'SortableJS 드래그가 행 클릭/선택을 삼키지 않도록 분리');
});
