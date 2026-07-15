'use strict';
/**
 * uiStateStore.test.js — lib/common/uiStateStore.js (M6 R-19/R-20/M6-M-4, 헤드리스 F-3)
 * 1MB DoS 가드·_safeParse·normalizeState·graceful 폴백·0600 원자적 쓰기.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const store = require('../lib/common/uiStateStore');

function tmpFile() {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'spip-ui-')));
  return path.join(dir, 'ui-state', 'ui-state.json');
}

// ── normalizeState (순수 검증) ──
test('normalizeState — id 형식·중복 제거·sortMode 화이트리스트', () => {
  const r = store.normalizeState({
    favorites: ['abc123', 'abc123', 'ZZZ', 'deadbeef', 1],
    order: ['deadbeef', 'abc123', 'nothex!'],
    sortMode: 'weird',
  });
  assert.deepStrictEqual(r.favorites, ['abc123', 'deadbeef']); // 중복·형식불일치 제거
  assert.deepStrictEqual(r.order, ['deadbeef', 'abc123']);
  assert.strictEqual(r.sortMode, 'auto'); // 화이트리스트 외 → auto
  assert.strictEqual(r.schemaVersion, store.SCHEMA_VERSION);
});

test('normalizeState — [Phase 1·J] accent·uiScale 화이트리스트·기본값', () => {
  assert.strictEqual(store.normalizeState({}).accent, 'indigo');
  assert.strictEqual(store.normalizeState({}).uiScale, 'normal');
  assert.strictEqual(store.normalizeState({ accent: 'emerald', uiScale: 'compact' }).accent, 'emerald');
  assert.strictEqual(store.normalizeState({ accent: 'emerald', uiScale: 'compact' }).uiScale, 'compact');
  assert.strictEqual(store.normalizeState({ accent: 'neon', uiScale: 'huge' }).accent, 'indigo'); // 화이트리스트 외 폴백
  assert.strictEqual(store.normalizeState({ accent: 'neon', uiScale: 'huge' }).uiScale, 'normal');
  assert.strictEqual(store.defaultState().accent, 'indigo');
});

test('normalizeState — 비객체 → 기본 빈 상태', () => {
  assert.deepStrictEqual(store.normalizeState(null), store.defaultState());
  assert.deepStrictEqual(store.normalizeState([1]), store.defaultState());
});

test('normalizeIdArray — 개수 상한 강제', () => {
  const many = Array.from({ length: 1000 }, (_, i) => i.toString(16).padStart(8, '0'));
  const r = store.normalizeIdArray(many, 512);
  assert.strictEqual(r.length, 512);
});

// ── _safeParse (M6-M-4 ③ 깊이 가드) ──
test('_safeParse — 잘못된 JSON → null', () => {
  assert.strictEqual(store._safeParse('{not json'), null);
});

test('_safeParse — 과도 깊이 → null (JSON 폭탄)', () => {
  let deep = '1';
  for (let i = 0; i < 100; i++) deep = '[' + deep + ']';
  assert.strictEqual(store._safeParse(deep), null);
});

test('_safeParse — 정상 JSON 통과', () => {
  assert.deepStrictEqual(store._safeParse('{"a":1}'), { a: 1 });
});

// ── read graceful 폴백 ──
test('read — 부재 파일 → 빈 상태(graceful)', () => {
  const file = tmpFile();
  assert.deepStrictEqual(store.read({ uiStatePath: file }), store.defaultState());
});

test('read — 손상 JSON → 빈 상태', () => {
  const file = tmpFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{broken');
  assert.deepStrictEqual(store.read({ uiStatePath: file }), store.defaultState());
});

test('read — 1MB 초과 파일 → 빈 상태 (M6-M-4 ①)', () => {
  const file = tmpFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // 1MB + 1바이트의 유효해 보이는(그러나 거대) 내용.
  const big = '{"favorites":[' + '"deadbeef",'.repeat(120000) + '"deadbeef"]}';
  assert.ok(Buffer.byteLength(big) > store.MAX_UISTATE_BYTES, '테스트 데이터가 1MB 초과여야 함');
  fs.writeFileSync(file, big);
  assert.deepStrictEqual(store.read({ uiStatePath: file }), store.defaultState());
});

// ── write 0600 + roundtrip ──
test('write/read — roundtrip + 0600 권한', () => {
  const file = tmpFile();
  const written = store.write({ favorites: ['aa11', 'bb22'], order: ['bb22', 'aa11'], sortMode: 'manual' }, { uiStatePath: file });
  assert.deepStrictEqual(written.favorites, ['aa11', 'bb22']);
  assert.strictEqual(written.sortMode, 'manual');
  const back = store.read({ uiStatePath: file });
  assert.deepStrictEqual(back.favorites, ['aa11', 'bb22']);
  assert.deepStrictEqual(back.order, ['bb22', 'aa11']);
  assert.strictEqual(back.sortMode, 'manual');
  if (process.platform !== 'win32') {
    const mode = fs.statSync(file).mode & 0o777;
    assert.strictEqual(mode, 0o600);
  }
});

test('write — 정규화 적용(잘못된 id/sortMode 제거)', () => {
  const file = tmpFile();
  const written = store.write({ favorites: ['abc123', 'BAD!'], sortMode: 'nope' }, { uiStatePath: file });
  assert.deepStrictEqual(written.favorites, ['abc123']); // 'BAD!'·비hex 제거
  assert.strictEqual(written.sortMode, 'auto');
});

// ── normalizeTodos (할 일 정규화) ──
test('normalizeTodos — 유효 항목·빈텍스트/비hex id/중복/비객체 폐기', () => {
  const out = store.normalizeTodos([
    { id: 't0a1b2c', text: '  배포 확인 ', done: true, createdAt: 123 }, // 유효
    { id: 'tabcdef', text: '   ' },     // 빈 텍스트 → 폐기
    { id: 'txyz999', text: 'z' },        // 'xyz' 비hex id → 폐기
    { id: 't0a1b2c', text: '중복' },     // 중복 id → 폐기
    'nope',                              // 비객체 → 폐기
    { id: 'tbeef01', text: 'ok' },       // 유효
  ]);
  assert.strictEqual(out.length, 2);
  assert.deepStrictEqual(out[0], { id: 't0a1b2c', text: '배포 확인', done: true, createdAt: 123, dueAt: null });
  assert.strictEqual(out[1].id, 'tbeef01');
  assert.strictEqual(out[1].done, false);
  assert.strictEqual(out[1].createdAt, null);
});

test('normalizeTodos — 개수 상한(MAX_TODOS)', () => {
  const many = Array.from({ length: store.MAX_TODOS + 5 }, (_, i) => ({ id: 't' + (0x100000 + i).toString(16), text: 'x' }));
  assert.strictEqual(store.normalizeTodos(many).length, store.MAX_TODOS);
});

test('normalizeState — todos 포함(기본 빈 배열)', () => {
  assert.deepStrictEqual(store.normalizeState({}).todos, []);
  assert.deepStrictEqual(store.defaultState().todos, []);
});

// ── 언어 추세(langTrend) 정규화 ──
test('normalizeLangCounts — 음수/비숫자/빈키 폐기·정수화', () => {
  assert.deepStrictEqual(store.normalizeLangCounts({ TS: 3, Bad: -1, X: 'n', '': 5, F: 2.9 }), { TS: 3, F: 2 });
  assert.deepStrictEqual(store.normalizeLangCounts(null), {});
});
test('normalizeLangTrend — generatedAt/prev/cur 정규화', () => {
  assert.deepStrictEqual(store.normalizeLangTrend({ generatedAt: 'g1', prev: { A: 2 }, cur: { B: 1.7 } }),
    { generatedAt: 'g1', prev: { A: 2 }, cur: { B: 1 } });
  assert.deepStrictEqual(store.normalizeLangTrend(null), { generatedAt: null, prev: {}, cur: {} });
  assert.deepStrictEqual(store.defaultState().langTrend, { generatedAt: null, prev: {}, cur: {} });
});

// ── 홈 섹션 순서(homeLayout) 정규화 (R-32) ──
test('normalizeHomeLayout — 비배열/손상 → 기본 순서 전체 복원', () => {
  assert.deepStrictEqual(store.normalizeHomeLayout(null), store.HOME_SECTION_IDS);
  assert.deepStrictEqual(store.normalizeHomeLayout('nope'), store.HOME_SECTION_IDS);
  assert.deepStrictEqual(store.normalizeHomeLayout({}), store.HOME_SECTION_IDS);
  assert.deepStrictEqual(store.normalizeHomeLayout([]), store.HOME_SECTION_IDS);
});

test('normalizeHomeLayout — 화이트리스트 외/중복 제거 + 누락 보충(끝)', () => {
  const r = store.normalizeHomeLayout(['mail', 'attention', 'mail', 'bogus', 42, 'mail']);
  // 유효 순서 보존(mail, attention) → 중복·미지·비문자열 제거 → 누락 섹션 기본 순서로 끝에 보충
  assert.deepStrictEqual(r, ['mail', 'attention', 'briefing', 'summary', 'productivity', 'activity', 'todos', 'disk', 'aiusage', 'shelf', 'shelfWide', 'scratchpad', 'commitHeatmap', 'systemStatus', 'explorer', 'mdedit', 'agent', 'featureAdd']);
  // 항상 화이트리스트 전체의 순열
  assert.strictEqual(r.length, store.HOME_SECTION_IDS.length);
  assert.deepStrictEqual(r.slice().sort(), store.HOME_SECTION_IDS.slice().sort());
});

test('normalizeHomeLayout — 완전 재정렬 입력 보존', () => {
  const reordered = store.HOME_SECTION_IDS.slice().reverse();
  assert.deepStrictEqual(store.normalizeHomeLayout(reordered), reordered);
});

// ── [위젯 인스턴스 v6] 배치 = homeWidgets([{iid,type,name}]) — 같은 위젯 중복 배치 + 배치별 이름 ──
test('위젯 인스턴스 — defaultState: 기본 숨김 위젯을 뺀 타입 각 1개(타입 id 를 iid 로)', () => {
  const w = store.defaultState().homeWidgets;
  const hidden = new Set(store.DEFAULT_HIDDEN_WIDGETS);
  assert.deepStrictEqual(w, store.TOGGLEABLE_WIDGET_IDS.filter((t) => !hidden.has(t)).map((t) => ({ iid: t, type: t, name: '' })));
  assert.ok(!w.some((x) => x.type === 'mdedit'), '기본 숨김 위젯은 미배치');
});

test('위젯 인스턴스 — normalizeHomeWidgets: 같은 타입 중복 허용, iid 중복·미지 타입·손상 제거', () => {
  const r = store.normalizeHomeWidgets([
    { iid: 'mdedit', type: 'mdedit', name: '' },
    { iid: 'w1', type: 'mdedit', name: '  회의록  ' },  // 같은 타입 중복 배치 — 허용
    { iid: 'w1', type: 'mail', name: 'dup' },           // iid 중복 → 제거(첫 항목 우선)
    { iid: 'BAD!!', type: 'mail' },                     // iid 형식 불량 → 제거
    { iid: 'w2', type: 'nope' },                        // 미지 타입 → 제거
    { iid: 'w3', type: 'featureAdd' },                  // featureAdd 는 인스턴스가 아니다 → 제거
    { iid: 'gabc1', type: 'mail' },                     // 그룹 id 공간 침범 → 제거
    null, 'x',
  ]);
  assert.deepStrictEqual(r, [
    { iid: 'mdedit', type: 'mdedit', name: '' },
    { iid: 'w1', type: 'mdedit', name: '회의록' },      // 이름은 sanitize(트림)
  ]);
  assert.deepStrictEqual(store.normalizeHomeWidgets(null), [], 'graceful');
  assert.deepStrictEqual(store.normalizeHomeWidgets('x'), []);
});

test('위젯 인스턴스 — 이름 상한(MAX_WIDGET_NAME) + 개수 상한(MAX_WIDGETS)', () => {
  const long = store.normalizeHomeWidgets([{ iid: 'w1', type: 'mail', name: 'x'.repeat(200) }]);
  assert.strictEqual(long[0].name.length, store.MAX_WIDGET_NAME);
  const many = [];
  for (let i = 0; i < store.MAX_WIDGETS + 10; i++) many.push({ iid: 'w' + i.toString(36), type: 'mail', name: '' });
  assert.strictEqual(store.normalizeHomeWidgets(many).length, store.MAX_WIDGETS);
});

test('위젯 인스턴스 — nextWidgetIid: 결정적(무작위성 배제)·미사용 최소 id', () => {
  assert.strictEqual(store.nextWidgetIid([]), 'w1');
  assert.strictEqual(store.nextWidgetIid([{ iid: 'w1' }, { iid: 'w2' }]), 'w3');
  assert.strictEqual(store.nextWidgetIid([{ iid: 'w2' }]), 'w1', '빈 자리를 채운다');
  assert.strictEqual(store.nextWidgetIid([{ iid: 'mdedit' }]), 'w1', '승격된 타입 id 와 충돌하지 않는다');
});

test('위젯 인스턴스 — v5 이행: 타입 id 를 iid 로 승격하고 숨김이었던 타입은 미배치(무손실)', () => {
  // 실제 v5 저장본의 homeLayout 은 항상 전체 순열이다(normalizeHomeLayout 이 보장). 사용자가
  //   todos 를 맨 앞으로 올리고, mail 과 나머지 신규 위젯을 숨겨둔 상태를 재현한다.
  const layout = ['todos'].concat(store.HOME_SECTION_IDS.filter((t) => t !== 'todos'));
  const hidden = ['mail'].concat(store.DEFAULT_HIDDEN_WIDGETS);
  const r = store.normalizeState({
    schemaVersion: 5,
    homeLayout: layout,
    hiddenWidgets: hidden,
    homeWidgetSizes: { todos: { w: 3, h: 400 } },
  });

  // 배치 = 레거시 순서에서 (숨김 ∪ featureAdd) 를 뺀 것. 순서 보존.
  const expected = layout.filter((t) => t !== 'featureAdd' && hidden.indexOf(t) < 0);
  assert.deepStrictEqual(r.homeWidgets.map((w) => w.iid), expected);
  assert.strictEqual(r.homeWidgets[0].iid, 'todos', '사용자가 올려둔 순서 보존');
  assert.deepStrictEqual(r.homeWidgets[0], { iid: 'todos', type: 'todos', name: '' });
  assert.ok(!r.homeWidgets.some((w) => w.type === 'mail'), '숨김이었던 위젯은 미배치');

  // 크기 키(타입 id)가 그대로 iid 키로 살아남는다 — 이행 무손실의 핵심.
  assert.deepStrictEqual(r.homeWidgetSizes, { todos: { w: 3, h: 400 } });
  assert.strictEqual(r.schemaVersion, store.SCHEMA_VERSION);
});

// ── [위젯 추가/제거] hiddenWidgets ──

test('normalizeHiddenWidgets — 토글 위젯 화이트리스트만·중복 제거·featureAdd 불가', () => {
  assert.deepStrictEqual(store.normalizeHiddenWidgets(['mail', 'mail', 'bogus', 7, 'aiusage']), ['mail', 'aiusage']);
  assert.deepStrictEqual(store.normalizeHiddenWidgets(['featureAdd']), [], 'featureAdd는 숨길 수 없음');
  assert.deepStrictEqual(store.normalizeHiddenWidgets(null), []);
  assert.deepStrictEqual(store.normalizeHiddenWidgets('nope'), []);
  // 토글 위젯 = HOME_SECTION_IDS − featureAdd
  assert.deepStrictEqual(store.TOGGLEABLE_WIDGET_IDS, store.HOME_SECTION_IDS.filter((id) => id !== 'featureAdd'));
});

// ── [홈 위젯 크기] homeWidgetSizes ──

test('normalizeHomeWidgetSizes — 배치된 iid 만·클램프(w[1..4]·h[120..1600])·featureAdd 제거', () => {
  // [위젯 인스턴스] 키는 **배치된 iid**(+그룹 id) — 타입 화이트리스트가 아니다. 그래서 같은 타입
  //   위젯 두 개(mail / w1)가 각자의 크기를 가질 수 있다. 배치에 없는 iid(gone)는 정리된다.
  const placed = new Set(['mail', 'aiusage', 'disk', 'todos', 'w1']);
  const r = store.normalizeHomeWidgetSizes({
    mail: { w: 2, h: 300 },
    w1: { w: 1, h: 250 },          // 같은 타입의 두 번째 인스턴스 — 독립 크기
    aiusage: { w: 9, h: 99999 },   // 상한 클램프 → w:4, h:1600
    disk: { w: 0, h: 10 },         // 하한 클램프 → w:1, h:120
    todos: { w: 2, h: null },      // 자동 높이 유지
    featureAdd: { w: 2, h: 200 },  // 제거(추가 트리거는 리사이즈 대상 아님)
    gone: { w: 2, h: 200 },        // 배치에 없는 iid → 제거(고아 키 0)
    attention: 'nope',             // 비객체 제거(+ 미배치)
  }, placed);
  assert.deepStrictEqual(r, {
    mail: { w: 2, h: 300 },
    w1: { w: 1, h: 250 },
    aiusage: { w: 4, h: 1600 },
    disk: { w: 1, h: 120 },
    todos: { w: 2, h: null },
  });
});

test('normalizeHomeWidgetSizes — 비객체/손상 입력 → 빈 객체(graceful)', () => {
  assert.deepStrictEqual(store.normalizeHomeWidgetSizes(null), {});
  assert.deepStrictEqual(store.normalizeHomeWidgetSizes('nope'), {});
  assert.deepStrictEqual(store.normalizeHomeWidgetSizes([1, 2]), {});
  assert.deepStrictEqual(store.normalizeHomeWidgetSizes({ mail: {} }), { mail: { w: 1, h: null } });
});

test('defaultState/normalizeState — homeWidgetSizes 기본 빈 객체', () => {
  assert.deepStrictEqual(store.defaultState().homeWidgetSizes, {});
  assert.deepStrictEqual(store.normalizeState({}).homeWidgetSizes, {});
});

test('write/read — homeWidgetSizes 라운드트립 보존(배치된 iid 만)', () => {
  const file = tmpFile();
  const widgets = [{ iid: 'mail', type: 'mail', name: '' }, { iid: 'todos', type: 'todos', name: '' }];
  const sizes = { mail: { w: 3, h: 260 }, todos: { w: 2, h: null } };
  const written = store.write({ schemaVersion: store.SCHEMA_VERSION, homeWidgets: widgets, homeWidgetSizes: sizes }, { uiStatePath: file });
  assert.deepStrictEqual(written.homeWidgetSizes, sizes);
  assert.deepStrictEqual(store.read({ uiStatePath: file }).homeWidgetSizes, sizes);
});

// [C-M-1 게이트] write→read 라운드트립 보존 — homeWidgets 키가 normalizeState에서 조용히 버려지지 않음.
test('write/read — homeWidgets 라운드트립 보존, 중복 배치·이름 포함 (C-M-1)', () => {
  const file = tmpFile();
  const custom = [
    { iid: 'mdedit', type: 'mdedit', name: '회의록' },
    { iid: 'w1', type: 'mdedit', name: 'TODO' },       // 같은 타입 2개
    { iid: 'mail', type: 'mail', name: '' },
  ];
  const written = store.write({ schemaVersion: store.SCHEMA_VERSION, homeWidgets: custom }, { uiStatePath: file });
  assert.deepStrictEqual(written.homeWidgets, custom, 'write 반환에 정규화된 homeWidgets 보존');
  const back = store.read({ uiStatePath: file });
  assert.deepStrictEqual(back.homeWidgets, custom, 'read 후에도 동일(키가 버려지지 않음)');
});

test('위젯 인스턴스 — 배치에서 사라진 iid 의 크기·그룹 소속은 자동 정리(고아 키 0)', () => {
  const r = store.normalizeState({
    schemaVersion: store.SCHEMA_VERSION,
    homeWidgets: [{ iid: 'mail', type: 'mail', name: '' }],
    homeWidgetSizes: { mail: { w: 2, h: 300 }, w9: { w: 1, h: 200 } }, // w9 는 미배치
    dashboard: {
      activePreset: 'default',
      presets: [{
        id: 'default', name: '기본',
        widgets: [{ iid: 'mail', type: 'mail', name: '' }],
        groups: [{ id: 'gaa11', name: '그룹', members: ['mail', 'w9'] }],
      }],
    },
  });
  assert.deepStrictEqual(Object.keys(r.homeWidgetSizes), ['mail'], '미배치 iid 크기 제거');
  assert.deepStrictEqual(r.dashboard.presets[0].groups[0].members, ['mail'], '미배치 iid 그룹 소속 제거');
});

// ── [로드맵 Phase 5·M] 그룹/섹션 정규화 ──
test('normalizeGroups — id 형식·중복·members(배치된 iid·그룹간 유일)·이름·collapsed·상한', () => {
  // [위젯 인스턴스] members 는 **iid** — 배치된 인스턴스만. 같은 타입 위젯 둘 중 하나만 그룹에 넣을 수 있다.
  const placed = new Set(['mail', 'disk', 'todos', 'w1']);
  const g = store.normalizeGroups([
    { id: 'gabc1', name: '  작업  ', collapsed: true, members: ['mail', 'disk', 'mail', 'bogus', 'featureAdd'] },
    { id: 'gabc2', name: '', members: ['disk', 'todos'] }, // disk 는 g1 이 선점 → 제거
    { id: 'BADID', members: [] },                            // id 형식 불량 → 제거
    { id: 'gabc1', name: 'dup' },                            // 중복 id → 제거
  ], placed);
  assert.strictEqual(g.length, 2);
  assert.deepStrictEqual(g[0], { id: 'gabc1', name: '작업', collapsed: true, members: ['mail', 'disk'], mode: 'section', active: 0 });
  assert.deepStrictEqual(g[1], { id: 'gabc2', name: '그룹', collapsed: false, members: ['todos'], mode: 'section', active: 0 });
  // 비배열/손상 graceful.
  assert.deepStrictEqual(store.normalizeGroups(null), []);
  assert.deepStrictEqual(store.normalizeGroups('x'), []);
  // 개수 상한.
  const many = [];
  for (let i = 0; i < 20; i++) many.push({ id: 'g' + i.toString(36).padStart(4, '0'), name: 'g' + i, members: [] });
  assert.strictEqual(store.normalizeGroups(many).length, store.MAX_GROUPS);
});

test('normalizePreset — groups 스키마 정규화(예약 [] → 실제)', () => {
  const d = store.normalizeDashboardState({
    activePreset: 'a',
    presets: [{ id: 'a', name: 'x', groups: [{ id: 'gaa11', name: '섹션', members: ['mail'] }] }],
  });
  assert.deepStrictEqual(d.presets[0].groups, [{ id: 'gaa11', name: '섹션', collapsed: false, members: ['mail'], mode: 'section', active: 0 }]);
});

test('normalizeGroups — mode(section|stack)·active 클램프', () => {
  const g = store.normalizeGroups([
    { id: 'gs001', name: '탭', members: ['mail', 'disk', 'todos'], mode: 'stack', active: 9 }, // active 클램프 → 2
    { id: 'gs002', members: ['attention'], mode: 'chaos', active: -1 },                        // 잘못된 모드 → section, active → 0
  ]);
  assert.strictEqual(g[0].mode, 'stack');
  assert.strictEqual(g[0].active, 2, 'active 는 멤버 범위로 클램프');
  assert.strictEqual(g[1].mode, 'section');
  assert.strictEqual(g[1].active, 0);
});

// ── [로드맵 Phase 3·G] 스크래치패드 메모 정규화 ──
test('normalizeScratchpad — 개행/탭 보존·제어문자 제거·길이 상한·updatedAt 정규화', () => {
  // 개행(\n)·탭(\t)은 보존, BEL(\x07)·DEL(\x7f)·NUL(\x00)은 제거.
  const raw = 'a' + String.fromCharCode(10) + 'b' + String.fromCharCode(9) + 'c'
    + String.fromCharCode(7) + String.fromCharCode(127) + String.fromCharCode(0) + 'd';
  const r = store.normalizeScratchpad({ text: raw, updatedAt: 1717000000000.9 });
  assert.strictEqual(r.text, 'a' + String.fromCharCode(10) + 'b' + String.fromCharCode(9) + 'cd');
  assert.strictEqual(r.updatedAt, 1717000000000, 'updatedAt floor');
  // 길이 상한.
  const long = store.normalizeScratchpad({ text: 'x'.repeat(store.MAX_SCRATCHPAD + 500) });
  assert.strictEqual(long.text.length, store.MAX_SCRATCHPAD);
  assert.strictEqual(long.updatedAt, null, 'updatedAt 부재 → null');
  // 손상/부재 graceful.
  assert.deepStrictEqual(store.normalizeScratchpad(null), { text: '', updatedAt: null });
  assert.deepStrictEqual(store.normalizeScratchpad({ text: 42, updatedAt: -1 }), { text: '', updatedAt: null });
  assert.deepStrictEqual(store.defaultScratchpad(), { text: '', updatedAt: null });
});

test('normalizeState/write/read — scratchpads(인스턴스별 메모) 라운드트립 보존', () => {
  const file = tmpFile();
  // [위젯 인스턴스] 메모는 인스턴스별 — 메모 위젯 2개면 서로 다른 메모.
  assert.deepStrictEqual(store.normalizeState({}).scratchpads, {});
  const pads = { scratchpad: { text: 'hello memo', updatedAt: 123 }, w1: { text: '두 번째 메모', updatedAt: 456 } };
  const written = store.write({ schemaVersion: store.SCHEMA_VERSION, scratchpads: pads }, { uiStatePath: file });
  assert.deepStrictEqual(written.scratchpads, pads);
  const back = store.read({ uiStatePath: file });
  assert.deepStrictEqual(back.scratchpads, pads, 'read 후에도 보존(키 안 버려짐)');
});

test('위젯 인스턴스 — v5 단일 scratchpad → 승격된 인스턴스(iid "scratchpad")의 메모로 이행', () => {
  const r = store.normalizeState({ schemaVersion: 5, scratchpad: { text: '옛 메모', updatedAt: 111 } });
  assert.deepStrictEqual(r.scratchpads.scratchpad, { text: '옛 메모', updatedAt: 111 }, '메모 내용 무손실 이행');
});

test('위젯 인스턴스 — 메모는 위젯을 지워도 지워지지 않는다(콘텐츠 보존 · 배치 게이트 없음)', () => {
  // 크기·좌표(재생성 가능한 배치 메타)와 달리 메모는 사용자 콘텐츠다 — 미배치 iid 의 메모도 남긴다.
  const r = store.normalizeState({
    schemaVersion: store.SCHEMA_VERSION,
    homeWidgets: [{ iid: 'mail', type: 'mail', name: '' }], // 메모 위젯은 미배치
    scratchpads: { w7: { text: '지우면 안 되는 메모', updatedAt: 9 } },
  });
  assert.strictEqual(r.scratchpads.w7.text, '지우면 안 되는 메모');
});
