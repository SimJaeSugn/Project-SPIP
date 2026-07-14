'use strict';
/**
 * widget-instances.test.js — 같은 위젯 중복 배치 + 배치별 이름 (위젯 인스턴스 v6)
 *
 * v5 까지 배치 단위는 '위젯 타입'이었다 — 같은 타입을 둘 놓으면 크기·좌표·그룹·UI 상태가 서로를
 * 덮어썼다(키가 타입 하나뿐이라). v6 부터 배치 단위는 **인스턴스**({iid,type,name})다.
 *
 * 여기서 고정하는 계약:
 *   ① 같은 타입을 여러 개 배치할 수 있고, 각 인스턴스가 크기·좌표·그룹·이름을 **독립**으로 갖는다.
 *   ② 배치별 이름을 붙일 수 있다(빈 값이면 타입 기본명).
 *   ③ v5 → v6 이행이 **무손실**이다(타입 id → iid 승격 — 기존 크기/좌표/그룹 키가 그대로 유효).
 *   ④ 인스턴스별 **UI 상태**가 분리된다 — 편집기 2개가 서로 다른 문서를, 탐색기 2개가 서로 다른
 *      폴더를, 메모 2개가 서로 다른 메모를 갖는다(렌더러 배선은 정적 소스로 검증).
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const S = require('../lib/common/uiStateStore');
const uiState = require('../electron/ipc/uiState');
const app = require('../public/app.js');

const ROOT = path.join(__dirname, '..');
const APP_SRC = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const CSS = fs.readFileSync(path.join(ROOT, 'public', 'styles.css'), 'utf8');
const PRELOAD_SRC = fs.readFileSync(path.join(ROOT, 'electron', 'preload.js'), 'utf8');
const REGISTER_SRC = fs.readFileSync(path.join(ROOT, 'electron', 'ipc', 'register.js'), 'utf8');

// 인메모리 store(실제 정규화 재사용) — ipc-uistate 테스트와 동형.
function memStore(initial) {
  let state = S.normalizeState(Object.assign({ schemaVersion: S.SCHEMA_VERSION }, initial || {}));
  return { read: () => state, write: (s) => { state = S.normalizeState(s); return state; }, _get: () => state };
}
function ctxWith(store) { return { uiStateStore: store }; }

/* ───── ① 중복 배치 — 인스턴스마다 크기·좌표·그룹이 독립 ───── */

test('중복 배치 — 마크다운 편집기 3개가 각자의 크기를 갖는다(예전엔 서로 덮어썼다)', () => {
  const ctx = ctxWith(memStore());
  const a = uiState.addWidget({ type: 'mdedit' }, ctx);
  const b = uiState.addWidget({ type: 'mdedit' }, ctx);
  const c = uiState.addWidget({ type: 'mdedit' }, ctx);
  assert.strictEqual(new Set([a.iid, b.iid, c.iid]).size, 3, '서로 다른 인스턴스 3개');

  const r = uiState.setHomeWidgetSizes({ sizes: {
    [a.iid]: { w: 1, h: 240 },
    [b.iid]: { w: 2, h: 480 },
    [c.iid]: { w: 4, h: 960 },
  } }, ctx);
  assert.deepStrictEqual(r.homeWidgetSizes[a.iid], { w: 1, h: 240 });
  assert.deepStrictEqual(r.homeWidgetSizes[b.iid], { w: 2, h: 480 });
  assert.deepStrictEqual(r.homeWidgetSizes[c.iid], { w: 4, h: 960 });
});

test('중복 배치 — 같은 타입 두 인스턴스를 서로 다른 그룹에 넣을 수 있다', () => {
  const ctx = ctxWith(memStore());
  const a = uiState.addWidget({ type: 'mdedit' }, ctx);
  const b = uiState.addWidget({ type: 'mdedit' }, ctx);
  const r = uiState.setGroups({ groups: [
    { id: 'gaaa1', name: '업무', members: [a.iid] },
    { id: 'gbbb2', name: '개인', members: [b.iid] },
  ] }, ctx);
  assert.deepStrictEqual(r.homeWidgetGroups[0].members, [a.iid]);
  assert.deepStrictEqual(r.homeWidgetGroups[1].members, [b.iid]);
});

test('중복 배치 — 한 인스턴스를 지워도 같은 타입의 다른 배치는 남는다', () => {
  const ctx = ctxWith(memStore());
  const a = uiState.addWidget({ type: 'explorer' }, ctx);
  const b = uiState.addWidget({ type: 'explorer' }, ctx);
  const r = uiState.removeWidget({ iid: a.iid }, ctx);
  const explorers = r.homeWidgets.filter((w) => w.type === 'explorer');
  assert.strictEqual(explorers.length, 1);
  assert.strictEqual(explorers[0].iid, b.iid);
});

test('중복 배치 — 상한(MAX_WIDGETS) 도달 시 LIMIT(조용한 실패 없음)', () => {
  const ctx = ctxWith(memStore());
  // 기본 배치가 이미 몇 개 있으므로 상한까지 채운다.
  for (let i = 0; i < S.MAX_WIDGETS; i++) {
    const r = uiState.addWidget({ type: 'mail' }, ctx);
    if (!r.ok) { assert.strictEqual(r.code, 'LIMIT'); return; }
  }
  assert.strictEqual(uiState.addWidget({ type: 'mail' }, ctx).code, 'LIMIT');
});

/* ───── ② 배치별 이름 ───── */

test('배치별 이름 — 같은 위젯을 이름으로 구분한다(빈 값이면 타입 기본명)', () => {
  const ctx = ctxWith(memStore());
  const a = uiState.addWidget({ type: 'mdedit' }, ctx);
  const b = uiState.addWidget({ type: 'mdedit' }, ctx);
  uiState.renameWidget({ iid: a.iid, name: '회의록' }, ctx);
  const r = uiState.renameWidget({ iid: b.iid, name: 'TODO' }, ctx);

  const byIid = Object.fromEntries(r.homeWidgets.map((w) => [w.iid, w]));
  assert.strictEqual(byIid[a.iid].name, '회의록');
  assert.strictEqual(byIid[b.iid].name, 'TODO');
  assert.strictEqual(byIid[a.iid].type, byIid[b.iid].type, '타입은 같다 — 이름만 다르다');
});

test('배치별 이름 — 이름은 sanitize + 길이 상한(단일 신뢰 경계는 메인)', () => {
  const ctx = ctxWith(memStore());
  const a = uiState.addWidget({ type: 'mail' }, ctx);
  const r = uiState.renameWidget({ iid: a.iid, name: '  이름  ' }, ctx);
  assert.strictEqual(r.homeWidgets.find((w) => w.iid === a.iid).name, '이름', '트림');
  const long = uiState.renameWidget({ iid: a.iid, name: 'x'.repeat(500) }, ctx);
  assert.strictEqual(long.homeWidgets.find((w) => w.iid === a.iid).name.length, S.MAX_WIDGET_NAME);
});

test('배치별 이름 — 렌더러 표시명: 이름이 있으면 그것, 없으면 타입 기본명', () => {
  // widgetDisplayName 은 클로저 안이라 정적 소스로 계약을 고정한다.
  assert.ok(/function widgetDisplayName\(inst\)[\s\S]{0,200}if \(inst\.name\) return inst\.name;/.test(APP_SRC),
    '사용자 지정 이름 우선');
  assert.ok(/const meta = WIDGET_META\[inst\.type\];/.test(APP_SRC), '없으면 타입 기본명');
  // 위젯 카드 제목이 표시명을 쓴다(마크다운 편집기·탐색기·메모·셸프).
  assert.ok(/cls: 'md-title', text: widgetDisplayName\(inst\)/.test(APP_SRC), 'MD 편집기 제목');
  assert.ok(/cls: 'fx-title', text: widgetDisplayName\(inst\)/.test(APP_SRC), '탐색기 제목');
  assert.ok(/text: widgetDisplayName\(inst\) \|\| '메모'/.test(APP_SRC), '메모 제목');
});

/* ───── ③ v5 → v6 이행 무손실 ───── */

test('이행 무손실 — 사용자의 순서·크기·그룹이 그대로 살아난다(타입 id → iid 승격)', () => {
  // 실제 v5 저장본: 전체 순열 layout + 숨김 집합 + 타입 키 크기/그룹.
  const layout = ['todos', 'mail'].concat(S.HOME_SECTION_IDS.filter((t) => t !== 'todos' && t !== 'mail'));
  const hidden = ['disk'].concat(S.DEFAULT_HIDDEN_WIDGETS);
  const v5 = {
    schemaVersion: 5,
    homeLayout: layout,
    hiddenWidgets: hidden,
    homeWidgetSizes: { todos: { w: 3, h: 400 }, mail: { w: 2, h: 300 } },
    dashboard: {
      activePreset: 'default',
      presets: [{
        id: 'default', name: '기본',
        layout, hidden,
        sizes: { todos: { w: 3, h: 400 } },
        positions: { todos: { x: 1, y: 2 } },
        groups: [{ id: 'gaaa1', name: '작업', members: ['todos', 'mail'] }],
        layoutMode: 'freeform',
      }],
    },
  };
  const r = S.normalizeState(v5);

  // 배치: 레거시 순서 보존, 숨김은 미배치.
  assert.deepStrictEqual(r.homeWidgets.slice(0, 2).map((w) => w.iid), ['todos', 'mail'], '순서 보존');
  assert.ok(!r.homeWidgets.some((w) => w.type === 'disk'), '숨김이었던 위젯은 미배치');
  // 크기·좌표·그룹의 키(타입 id)가 그대로 iid 키로 유효 — 하나도 잃지 않는다.
  assert.deepStrictEqual(r.homeWidgetSizes.todos, { w: 3, h: 400 });
  const p = r.dashboard.presets[0];
  assert.deepStrictEqual(p.positions.todos, { x: 1, y: 2 }, '프리폼 좌표 보존');
  assert.deepStrictEqual(p.groups[0].members, ['todos', 'mail'], '그룹 소속 보존');
  assert.strictEqual(p.layoutMode, 'freeform', '레이아웃 모드 보존');
  assert.strictEqual(r.schemaVersion, 6);
});

test('이행 무손실 — 이행 결과는 재정규화에 안정(멱등)', () => {
  const once = S.normalizeState({ schemaVersion: 5, homeLayout: S.HOME_SECTION_IDS.slice(), hiddenWidgets: ['mail'] });
  const twice = S.normalizeState(once);
  assert.deepStrictEqual(twice.homeWidgets, once.homeWidgets);
  assert.deepStrictEqual(twice.homeWidgetSizes, once.homeWidgetSizes);
});

test('이행 무손실 — v5 단일 메모가 승격된 메모 위젯의 메모로 이어진다', () => {
  const r = S.normalizeState({
    schemaVersion: 5,
    homeLayout: S.HOME_SECTION_IDS.slice(),
    hiddenWidgets: [], // 메모 위젯을 노출해둔 사용자
    scratchpad: { text: '옛날 메모', updatedAt: 111 },
  });
  assert.ok(r.homeWidgets.some((w) => w.iid === 'scratchpad'), '메모 위젯이 iid "scratchpad" 로 승격');
  assert.strictEqual(r.scratchpads.scratchpad.text, '옛날 메모', '메모 내용이 그 인스턴스로 이어진다');
});

/* ───── ④ 인스턴스별 UI 상태(렌더러 배선) ───── */

test('인스턴스 상태 — 뷰 상태는 iid 로 가르고, 공유 데이터는 전역에 둔다', () => {
  assert.ok(/function makeWState\(type\)/.test(APP_SRC), '타입별 인스턴스 상태 팩토리');
  assert.ok(/function wstate\(iid\)/.test(APP_SRC), 'iid → 인스턴스 상태');
  assert.ok(/function pruneWState\(\)/.test(APP_SRC), '배치에서 사라진 인스턴스 상태 정리(누수 방지)');
  // 하나의 라이브러리를 여러 창으로 보는 공유 데이터는 전역 슬롯에 그대로.
  assert.ok(/roots: \[\],\s*\/\/ 등록된 열람 루트\(실경로\) — 전역 공유/.test(APP_SRC), '탐색기 루트는 전역 공유');
  // 예외 — 마크다운 편집기는 '창'이 아니라 각자의 **문서함**을 가진다(목록까지 인스턴스별).
  assert.ok(/docs: \[\],\s*\/\/ 이 편집기의 문서함/.test(APP_SRC), '문서 목록은 인스턴스별');
  assert.ok(!/store\.mdedit/.test(APP_SRC.replace(/\/\*[\s\S]*?\*\//g, '')), '전역 mdedit 슬롯 없음');
});

test('인스턴스 상태 — 부분 갱신은 그 인스턴스의 셀 안에서만(document 전역 조회 금지)', () => {
  // 같은 타입 위젯이 여럿이면 document.querySelector 는 첫 셀만 고쳐 나머지가 멈춘 화면으로 남는다.
  assert.ok(/function cellQuery\(iid, selector\)/.test(APP_SRC), '셀 스코프 조회 헬퍼');
  // 시스템 상태는 배치된 인스턴스 **전부** 갱신한다.
  const ps = APP_SRC.slice(APP_SRC.indexOf('function patchSystemStatus('), APP_SRC.indexOf('function patchSystemStatus(') + 700);
  assert.ok(/widgetsOfType\('systemStatus'\)/.test(ps), '시스템 상태 위젯 전부 순회');
  assert.ok(!/document\.querySelector\('\.home-section\[data-home-section="systemStatus"\]/.test(APP_SRC),
    '타입으로 첫 셀만 찍어 고치지 않는다');
});

test('인스턴스 상태 — 탐색기: 디스크가 바뀌면 같은 폴더를 보는 모든 탐색기를 갱신', () => {
  assert.ok(/function explorerRefreshAll\(dirPath\)/.test(APP_SRC), '같은 폴더를 보는 탐색기 일괄 갱신');
  const ra = APP_SRC.slice(APP_SRC.indexOf('function explorerRefreshAll('), APP_SRC.indexOf('function explorerRefreshAll(') + 400);
  assert.ok(/widgetsOfType\('explorer'\)/.test(ra) && /st\.cwd === dirPath/.test(ra), '그 폴더를 보는 인스턴스만');
});

test('인스턴스 상태 — 문서를 지우면 그 편집기만 영향받는다(문서함이 인스턴스별이므로)', () => {
  const rm = APP_SRC.slice(APP_SRC.indexOf('function mdRemoveDoc('), APP_SRC.indexOf('function mdImportDoc('));
  // 삭제 대상은 '× 를 누른 칩의 문서'(targetId) — 열려 있지 않아도 지운다.
  assert.ok(/mdIpc\(iid, 'remove', targetId\)/.test(rm), '이 편집기의 문서함에서 지운다');
  // 연 문서를 지웠으면 같은 문서함의 다른 문서로 옮긴다(유령 본문 방지).
  assert.ok(/st\.activeId === targetId[\s\S]{0,400}mdOpenDoc\(iid, fallback/.test(rm), '연 문서였으면 대체 문서로');
});

/* ───── 회귀: 무한 렌더 루프 (v1.37.0 빈 화면 사고) ───── */

test('회귀 — 지연 적재는 할 일이 없으면 render() 를 부르지 않는다(무한 렌더 루프 방지)', () => {
  // maybeLoadMdEdit / maybeLoadExplorer 는 **매 render() 마다** 불린다. 지연 적재 함수가 할 일이
  //   없는데도 render() 를 부르면 render → load → render → … 로 렌더러 스레드가 멈추고 화면이
  //   빈 채로 남는다(예외도 안 뜨므로 진단이 어렵다). 실제로 v1.37.0 에서 이 사고가 났다.
  for (const fn of ['loadMdEdit', 'loadExplorer']) {
    const start = APP_SRC.indexOf('async function ' + fn + '(');
    assert.ok(start >= 0, fn + ' 정의');
    const body = APP_SRC.slice(start, start + 2200);
    assert.ok(/var didWork = false;/.test(body), fn + ' 는 실제 작업 여부를 추적한다');
    assert.ok(/if \(didWork/.test(body), fn + ' 는 실제로 뭔가 바뀐 경우에만 재렌더한다');
    // 무조건 render() 로 끝나는 경로가 없어야 한다.
    assert.ok(!/\n    render\(\);\n  \}\s*$/.test(body.slice(0, body.indexOf('\n  }\n') + 5)),
      fn + ' 끝에 무조건 render() 금지');
  }
  // 인스턴스별 '최초 자동 열기' 재진입 가드.
  assert.ok(/_seeded: false/.test(APP_SRC), '자동 열기 1회 가드(_seeded)');
  assert.ok(/st\._seeded = true;|wstate\(pending\[i\]\.iid\)\._seeded = true;/.test(APP_SRC), '자동 열기 전에 가드 설정');
});

test('회귀 — 모듈 최상위 헬퍼가 배치 목록을 볼 수 있게 store 를 바인딩한다', () => {
  // store 는 initBrowser() **함수 스코프**에 있어서 모듈 최상위 함수(widgetInstance 등)는 볼 수 없다.
  //   예전엔 `typeof store !== 'undefined'` 가드로 조용히 빈 배열을 돌려줬고, 그 결과
  //     · widgetInstance() 가 항상 null → 포커스(크게 보기) 버튼이 눌러도 무반응(예외조차 없음)
  //     · widgetTypeOf() 가 iid 를 타입으로 오인 → 중복 배치 위젯의 기본 스팬·최소 높이가 틀림
  //     · widgetTitleOf() 가 제목 자리에 iid 문자열을 넣음(메일·셸프 부분 갱신)
  //   조용히 잘못된 값을 돌려주는 종류의 버그라 반드시 배선을 고정한다.
  assert.ok(/let __wStore = null;/.test(APP_SRC), '모듈 스코프 store 참조');
  assert.ok(/function bindWidgetStore\(s\) \{ __wStore = s; \}/.test(APP_SRC), '바인딩 함수');
  assert.ok(/\n  bindWidgetStore\(store\);/.test(APP_SRC), 'initBrowser 가 store 를 바인딩');
  // 헬퍼들은 widgetList() 단일 출처를 통해서만 배치를 읽는다(typeof store 가드 금지 — 조용한 실패 원인).
  assert.ok(/function widgetList\(\)/.test(APP_SRC), '배치 조회 단일 출처');
  assert.ok(!/typeof store !== 'undefined' && store && Array\.isArray\(store\.homeWidgets\)/.test(APP_SRC),
    '조용히 빈 배열을 돌려주는 가드 제거');
  // 포커스는 배치된 인스턴스만 연다(가드 자체는 유지).
  assert.ok(/function openFocusWidget\(iid\) \{\s*if \(!widgetInstance\(iid\)\) return;/.test(APP_SRC),
    '포커스는 배치된 인스턴스만');
});

/* ───── IPC 표면 정합 ───── */

test('IPC — preload 표면 ↔ register 등록 채널 정합(신규 3채널)', () => {
  for (const ch of ['spip:addWidget', 'spip:removeWidget', 'spip:renameWidget']) {
    assert.ok(PRELOAD_SRC.includes("'" + ch + "'"), 'preload 노출: ' + ch);
    assert.ok(REGISTER_SRC.includes("guard('" + ch + "'"), 'register 등록: ' + ch);
  }
  // '숨김' 채널은 사라졌다.
  assert.ok(!PRELOAD_SRC.includes("'spip:setHiddenWidgets'"), 'setHiddenWidgets 채널 제거');
  assert.ok(!REGISTER_SRC.includes("guard('spip:setHiddenWidgets'"), 'setHiddenWidgets 등록 제거');
  // iid 는 메인이 발급한다 — 렌더러가 id 를 주입하는 표면이 없다.
  assert.ok(/addWidget: \(type, name\) =>/.test(PRELOAD_SRC), 'addWidget 은 타입·이름만 보낸다(iid 없음)');
});

/* ───── UI 규약 ───── */

test('UI — 컨트롤 버튼은 카드 바깥 세로 레일에 모인다(위젯 툴바를 덮지 않는다)', () => {
  // 예전엔 포커스·이름변경·삭제가 카드 **우상단 코너에 가로로** 겹쳐, 위젯 자신의 우상단 툴바
  //   (MD 편집기·탐색기·히트맵의 새로고침 등)를 덮어 클릭을 가로챘다. 레일로 빼서 콘텐츠 위를 비운다.
  assert.ok(/\.home-rail \{[^}]*position: absolute[^}]*right: -34px/.test(CSS), '카드 바깥(우측 외곽)');
  assert.ok(/\.home-rail \{[^}]*flex-direction: column/.test(CSS), '세로 정렬');
  assert.ok(/\.home-section:hover \.home-rail,/.test(CSS), '호버 시 노출');
  assert.ok(/\.home-masonry--editing \.home-rail \{ opacity: 1;/.test(CSS), '편집 모드에서 상시 노출');
  assert.ok(/\.home-rail \{[^}]*pointer-events: none/.test(CSS), '숨어 있을 땐 이웃 클릭을 가로채지 않는다');

  // 카드 → 레일로 마우스를 옮기는 도중 틈에서 :hover 가 끊기면 레일이 사라져 버튼에 닿을 수 없다.
  //   투명 패딩으로 히트 영역을 카드 우변에 맞닿게 이어 붙이고, 사라질 때만 지연을 준다.
  assert.ok(/\.home-rail \{[^}]*padding: 6px 0 6px 6px/.test(CSS), '카드와 레일 사이 틈을 히트 영역으로 연결');
  assert.ok(/\.home-rail \{[^}]*transition: opacity \.12s ease \.18s/.test(CSS), '사라질 때 지연(깜빡임 방지)');
  assert.ok(/\.home-rail:hover,/.test(CSS), '레일 위에 있으면 유지');
  assert.ok(/\.home-section:hover \.home-rail,[\s\S]{0,120}transition-delay: 0s/.test(CSS), '나타날 땐 즉시');
  // 패딩(6px) = 오프셋(34px) − 버튼 폭(28px) → 카드 안쪽 겹침 0(툴바 가림 재발 방지).
  assert.ok(/\.home-rail \.widget-focus,[\s\S]{0,200}width: 28px/.test(CSS), '버튼 폭 28px(패딩 계산 전제)');
  // 개별 버튼은 절대배치를 갖지 않는다(레일이 위치를 소유) — 코너 겹침 재발 방지.
  assert.ok(/\.home-rail \.widget-focus,[\s\S]{0,80}\.home-rail \.widget-remove \{[^}]*position: static/.test(CSS),
    '버튼은 레일 안에서 static');
  assert.ok(!/^\.widget-focus \{[^}]*position: absolute/m.test(CSS), '포커스 버튼 개별 절대배치 제거');
  assert.ok(!/^\.widget-remove \{[^}]*position: absolute/m.test(CSS), '삭제 버튼 개별 절대배치 제거');

  // 렌더러: 세 버튼이 모두 레일에 들어간다.
  const bc = APP_SRC.slice(APP_SRC.indexOf('function buildHomeCell('), APP_SRC.indexOf('function renderHomeSection('));
  assert.ok(/rail\.appendChild\(widgetFocusBtn\(inst\)\)/.test(bc), '포커스 → 레일');
  assert.ok(/rail\.appendChild\(widgetRenameBtn\(inst\)\)/.test(bc), '이름변경 → 레일');
  assert.ok(/rail\.appendChild\(widgetRemoveBtn\(inst\)\)/.test(bc), '삭제 → 레일');

  // 인라인 입력은 SortableJS 드래그와 분리.
  const wi = APP_SRC.slice(APP_SRC.indexOf('function widgetRenameInput('), APP_SRC.indexOf('function commitWidgetRename('));
  assert.ok(/pointerdown: function \(e\) \{ e\.stopPropagation\(\); \}/.test(wi), '드래그와 분리');
});

test('이름 변경 — 모든 위젯 카드가 표시명을 쓴다(제목 하드코딩 금지)', () => {
  // 제목을 문자열 리터럴로 박으면 이름을 바꿔도 화면이 그대로라 "이름 변경이 안 된다"로 보인다(실제 사고).
  assert.ok(/function widgetCardTitle\(inst, fallback\)/.test(APP_SRC), '표시명 헬퍼');
  const titled = [
    ['renderHomeAttention', '주의가 필요한 프로젝트'],
    ['renderHomeProductivity', '주간 생산성'],
    ['renderHomeActivity', '최근 활동 타임라인'],
    ['renderHomeTodos', '할 일'],
    ['renderHomeDisk', '디스크 회수'],
    ['renderHomeAiUsage', '토큰 사용량'],
    ['renderHomeCommitHeatmap', '커밋 히트맵'],
    ['renderHomeSystemStatus', '시스템 상태'],
  ];
  for (const [fn, fallback] of titled) {
    assert.ok(APP_SRC.includes("widgetCardTitle(inst, '" + fallback + "')"), fn + ' 제목이 표시명을 쓴다');
  }
  // 인스턴스를 받도록 시그니처가 열려 있어야 한다.
  for (const fn of ['renderHomeAttention', 'renderHomeTodos', 'renderHomeSystemStatus', 'renderHomeMail']) {
    assert.ok(new RegExp('function ' + fn + '\\(([\\w, ]*\\b)?inst\\b').test(APP_SRC), fn + ' 이 inst 를 받는다');
  }
  // 메일·셸프는 부분 갱신 경로에서도 표시명을 유지한다(제목 없이 재빌드하면 이름이 되돌아간다).
  const pm = APP_SRC.slice(APP_SRC.indexOf('function patchMailSection('), APP_SRC.indexOf('function patchMailSection(') + 900);
  assert.ok(/widgetTitleOf\(iid\)/.test(pm), '메일 부분 갱신이 표시명 유지');
  const ps = APP_SRC.slice(APP_SRC.indexOf('function patchShelfSection('), APP_SRC.indexOf('function patchShelfSection(') + 900);
  assert.ok(/widgetTitleOf\(iid\)/.test(ps), '셸프 부분 갱신이 표시명 유지');
});

test('UI — 6조합 계약 유지: 기본 스팬·최소 높이는 **타입**의 성질(iid → type 해석)', () => {
  // 인스턴스 id 를 받아도 타입으로 해석해 판정한다 — 안 그러면 두 번째 인스턴스가 기본값을 잃는다.
  assert.ok(/function homeDefaultSpan\(id\) \{\s*const t = widgetTypeOf\(id\);/.test(APP_SRC), 'homeDefaultSpan 이 타입 해석');
  assert.ok(/var m = HOME_WIDGET_MIN_H\[widgetTypeOf\(id\)\];/.test(APP_SRC), 'homeWidgetMinH 가 타입 해석');
  // 미배치 id(테스트·그룹 id)는 그대로 폴백 — 기존 계약 불변.
  assert.strictEqual(app.homeDefaultSpan('mdedit'), 2);
  assert.strictEqual(app.homeWidgetMinH('mdedit'), 240);
  assert.strictEqual(app.homeDefaultSpan('shelfWide'), app.HOME_MAX_COLS);
});
