'use strict';
/**
 * ipc-uistate.test.js — electron/ipc/uiState.js (M6 R-19/R-20, 헤드리스 F-3)
 * getUiState·setFavorite·setOrder·setSortMode. id 형식 검증·집합·manual 전환.
 * uiStateStore를 인메모리 stub으로 주입.
 */
const { test } = require('node:test');
const assert = require('node:assert');

const uiState = require('../electron/ipc/uiState');
const realStore = require('../lib/common/uiStateStore');

// 인메모리 store stub (read/write + normalize 실제 로직 재사용).
function memStore(initial) {
  // [SH-1 P1] schemaVersion:2 기본 — 이행 union(shelf/shelfWide) 회피(셸프 무관 핸들러 테스트 격리).
  let state = realStore.normalizeState(Object.assign({ schemaVersion: realStore.SCHEMA_VERSION }, initial || {}));
  return {
    read: () => state,
    write: (s) => { state = realStore.normalizeState(s); return state; },
    _get: () => state,
  };
}
function ctxWith(store) { return { uiStateStore: store }; }

test('getUiState — graceful 반환 shape', () => {
  const ctx = ctxWith(memStore({ favorites: ['aa11'], order: ['aa11'], sortMode: 'manual' }));
  const r = uiState.getUiState(ctx);
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.favorites, ['aa11']);
  assert.deepStrictEqual(r.order, ['aa11']);
  assert.strictEqual(r.sortMode, 'manual');
});

test('setFavorite — 잘못된 id → INVALID_ID', () => {
  const ctx = ctxWith(memStore());
  assert.deepStrictEqual(uiState.setFavorite({ id: 'BAD!', on: true }, ctx), { ok: false, code: 'INVALID_ID' });
  assert.deepStrictEqual(uiState.setFavorite({ id: 123, on: true }, ctx), { ok: false, code: 'INVALID_ID' });
});

test('setFavorite — add/remove 집합', () => {
  const s = memStore();
  const ctx = ctxWith(s);
  let r = uiState.setFavorite({ id: 'aa11', on: true }, ctx);
  assert.deepStrictEqual(r.favorites, ['aa11']);
  r = uiState.setFavorite({ id: 'bb22', on: true }, ctx);
  assert.deepStrictEqual(r.favorites.sort(), ['aa11', 'bb22']);
  r = uiState.setFavorite({ id: 'aa11', on: false }, ctx);
  assert.deepStrictEqual(r.favorites, ['bb22']);
});

test('setFavorite — 중복 add 무해(집합)', () => {
  const ctx = ctxWith(memStore({ favorites: ['aa11'] }));
  const r = uiState.setFavorite({ id: 'aa11', on: true }, ctx);
  assert.deepStrictEqual(r.favorites, ['aa11']);
});

test('setOrder — ids 배열 아니면 INVALID_ORDER', () => {
  const ctx = ctxWith(memStore());
  assert.deepStrictEqual(uiState.setOrder({ ids: 'nope' }, ctx), { ok: false, code: 'INVALID_ORDER' });
});

test('setOrder — 순서 설정 + sortMode=manual 전환·중복/형식 정리', () => {
  const ctx = ctxWith(memStore({ sortMode: 'auto' }));
  const r = uiState.setOrder({ ids: ['bb22', 'aa11', 'bb22', 'BAD!'] }, ctx);
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.order, ['bb22', 'aa11']); // 중복·형식불일치 제거
  assert.strictEqual(r.sortMode, 'manual');
});

test('setSortMode — 화이트리스트 외 → auto', () => {
  const ctx = ctxWith(memStore({ sortMode: 'manual' }));
  assert.strictEqual(uiState.setSortMode({ mode: 'weird' }, ctx).sortMode, 'auto');
  assert.strictEqual(uiState.setSortMode({ mode: 'manual' }, ctx).sortMode, 'manual');
});

// ── 홈 섹션 순서(homeLayout) 핸들러 (R-32) ──
test('setHomeLayout — 정규화·영속·응답(중복/미지/비배열 흡수)', () => {
  const s = memStore();
  const ctx = ctxWith(s);
  // 유효 재정렬 + 중복 + 미지 id + 비문자열 → 정규화가 흡수, 누락 섹션 기본 순서 보충.
  const r = uiState.setHomeLayout({ ids: ['mail', 'attention', 'mail', 'bogus', 7] }, ctx);
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.homeLayout, ['mail', 'attention', 'productivity', 'activity', 'todos', 'disk', 'aiusage', 'shelf', 'shelfWide', 'scratchpad', 'commitHeatmap', 'systemStatus', 'explorer', 'mdedit', 'featureAdd']);
  // 영속 반영 확인(write를 거친 store 상태와 일치).
  assert.deepStrictEqual(s._get().homeLayout, r.homeLayout);
});

test('setHomeLayout — 비배열/누락 args도 graceful(기본 순서)', () => {
  const ctx = ctxWith(memStore());
  assert.deepStrictEqual(uiState.setHomeLayout({ ids: 'nope' }, ctx).homeLayout, realStore.HOME_SECTION_IDS);
  assert.deepStrictEqual(uiState.setHomeLayout({}, ctx).homeLayout, realStore.HOME_SECTION_IDS);
  assert.deepStrictEqual(uiState.setHomeLayout(undefined, ctx).homeLayout, realStore.HOME_SECTION_IDS);
});

test('getUiState — homeLayout 포함(toResponse 노출)', () => {
  const ctx = ctxWith(memStore({ homeLayout: ['disk', 'mail'] }));
  const r = uiState.getUiState(ctx);
  assert.ok(Array.isArray(r.homeLayout));
  assert.strictEqual(r.homeLayout[0], 'disk');
  assert.strictEqual(r.homeLayout[1], 'mail');
  assert.strictEqual(r.homeLayout.length, realStore.HOME_SECTION_IDS.length); // 누락 보충
});

// ── [로드맵 Phase 5·B] setLayoutMode / setWidgetPositions (프리폼) ──
test('setLayoutMode/setWidgetPositions — 활성 프리셋 반영·정규화·getUiState 노출', () => {
  const s = memStore();
  const ctx = ctxWith(s);
  // 기본 masonry.
  assert.strictEqual(uiState.getUiState(ctx).layoutMode, 'masonry');
  // freeform 전환.
  let r = uiState.setLayoutMode({ mode: 'freeform' }, ctx);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.layoutMode, 'freeform');
  assert.strictEqual(uiState.getUiState(ctx).layoutMode, 'freeform', '영속·노출');
  // 좌표 설정 — 미지/featureAdd 제거, 정수 클램프.
  r = uiState.setWidgetPositions({ positions: { mail: { x: 2, y: 3 }, bogus: { x: 1, y: 1 }, featureAdd: { x: 0, y: 0 }, disk: { x: -5, y: 2.9 } } }, ctx);
  assert.strictEqual(r.ok, true);
  // 미지(bogus) 제거, featureAdd 허용(프리폼 배치), 음수→0·반올림 클램프.
  assert.deepStrictEqual(r.homeWidgetPositions, { mail: { x: 2, y: 3 }, featureAdd: { x: 0, y: 0 }, disk: { x: 0, y: 3 } }, '화이트리스트·클램프·반올림');
  assert.deepStrictEqual(uiState.getUiState(ctx).homeWidgetPositions, { mail: { x: 2, y: 3 }, featureAdd: { x: 0, y: 0 }, disk: { x: 0, y: 3 } });
  // 무효 모드 → masonry.
  assert.strictEqual(uiState.setLayoutMode({ mode: 'bogus' }, ctx).layoutMode, 'masonry');
});

// ── [로드맵 Phase 1·J] setThemePrefs ──
test('setThemePrefs — 액센트·배율 화이트리스트·영속·getUiState 노출·부분 갱신', () => {
  const s = memStore();
  const ctx = ctxWith(s);
  assert.strictEqual(uiState.getUiState(ctx).accent, 'indigo');
  assert.strictEqual(uiState.getUiState(ctx).uiScale, 'normal');
  let r = uiState.setThemePrefs({ accent: 'rose', uiScale: 'large' }, ctx);
  assert.deepStrictEqual({ ok: r.ok, accent: r.accent, uiScale: r.uiScale }, { ok: true, accent: 'rose', uiScale: 'large' });
  assert.strictEqual(uiState.getUiState(ctx).accent, 'rose', '영속');
  // 부분 갱신(accent만) — uiScale 유지.
  r = uiState.setThemePrefs({ accent: 'blue' }, ctx);
  assert.strictEqual(r.accent, 'blue');
  assert.strictEqual(r.uiScale, 'large', '미지정 필드 유지');
  // 무효 값 무시.
  assert.strictEqual(uiState.setThemePrefs({ accent: 'neon' }, ctx).accent, 'blue');
});

// ── [로드맵 Phase 1·L] addTemplatePreset ──
test('addTemplatePreset — 템플릿 구성으로 새 프리셋 추가·활성 전환·정규화', () => {
  const s = memStore();
  const ctx = ctxWith(s);
  const before = uiState.getUiState(ctx).dashboard.presets.length;
  const toggle = realStore.TOGGLEABLE_WIDGET_IDS;
  const hidden = toggle.filter((id) => ['mail', 'todos'].indexOf(id) < 0);
  const r = uiState.addTemplatePreset({ name: '미니멀', template: {
    layout: realStore.HOME_SECTION_IDS.slice(), hidden: hidden, sizes: { mail: { w: 99, h: 5 } }, layoutMode: 'freeform', groups: [],
  } }, ctx);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.dashboard.presets.length, before + 1, '새 프리셋 추가');
  // 활성 프리셋(레거시 키)이 템플릿 내용 — 숨김·모드·크기(클램프).
  assert.deepStrictEqual(r.hiddenWidgets.slice().sort(), hidden.slice().sort());
  assert.strictEqual(r.layoutMode, 'freeform');
  assert.deepStrictEqual(r.homeWidgetSizes.mail, { w: realStore.HOME_MAX_COLS, h: realStore.HOME_H_MIN }, '크기 클램프(정규화)');
  // 상한 초과 시 LIMIT.
  for (let i = 0; i < 20; i++) uiState.addTemplatePreset({ name: 'x' + i, template: {} }, ctx);
  assert.strictEqual(uiState.addTemplatePreset({ name: 'over', template: {} }, ctx).code, 'LIMIT');
});

// ── [로드맵 Phase 5·M] setGroups ──
test('setGroups — 활성 프리셋 그룹 정규화·영속·getUiState 노출', () => {
  const s = memStore();
  const ctx = ctxWith(s);
  assert.deepStrictEqual(uiState.getUiState(ctx).homeWidgetGroups, []);
  const r = uiState.setGroups({ groups: [
    { id: 'g0001', name: '작업', collapsed: false, members: ['mail', 'disk', 'bogus', 'featureAdd'] },
    { id: 'g0002', name: '기타', members: ['disk', 'todos'] }, // disk 선점됨 → todos 만
  ] }, ctx);
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.homeWidgetGroups, [
    { id: 'g0001', name: '작업', collapsed: false, members: ['mail', 'disk'], mode: 'section', active: 0 },
    { id: 'g0002', name: '기타', collapsed: false, members: ['todos'], mode: 'section', active: 0 },
  ]);
  assert.deepStrictEqual(uiState.getUiState(ctx).homeWidgetGroups, r.homeWidgetGroups, '영속·노출');
});

// ── [로드맵 Phase 3·G] setScratchpad ──
test('setScratchpad — 텍스트 정규화·영속·updatedAt 메인 스탬프 + getUiState 노출', () => {
  const s = memStore();
  const ctx = Object.assign(ctxWith(s), { nowMs: () => 1717000000000 });
  // 개행 보존 + 제어문자 제거.
  const raw = 'line1' + String.fromCharCode(10) + 'line2' + String.fromCharCode(7);
  const r = uiState.setScratchpad({ text: raw }, ctx);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.scratchpad.text, 'line1' + String.fromCharCode(10) + 'line2');
  assert.strictEqual(r.scratchpad.updatedAt, 1717000000000, 'updatedAt 은 메인 스탬프');
  // 영속 + getUiState 노출.
  assert.deepStrictEqual(s._get().scratchpad, r.scratchpad);
  assert.deepStrictEqual(uiState.getUiState(ctx).scratchpad, r.scratchpad);
  // 비문자열/누락 args graceful(빈 텍스트).
  assert.strictEqual(uiState.setScratchpad({}, ctx).scratchpad.text, '');
  assert.strictEqual(uiState.setScratchpad(undefined, ctx).scratchpad.text, '');
});

// ── [위젯 추가/제거] setHiddenWidgets ──

test('setHiddenWidgets — 토글 위젯만 정규화·영속·응답', () => {
  const s = memStore();
  const ctx = ctxWith(s);
  const r = uiState.setHiddenWidgets({ ids: ['mail', 'aiusage', 'featureAdd', 'bogus', 9] }, ctx);
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.hiddenWidgets, ['mail', 'aiusage'], 'featureAdd·미지·비문자열 제거');
  assert.deepStrictEqual(s._get().hiddenWidgets, r.hiddenWidgets);
});

test('setHiddenWidgets — 비배열/누락 graceful(빈 배열=전부 표시)', () => {
  const ctx = ctxWith(memStore());
  assert.deepStrictEqual(uiState.setHiddenWidgets({ ids: 'nope' }, ctx).hiddenWidgets, []);
  assert.deepStrictEqual(uiState.setHiddenWidgets({}, ctx).hiddenWidgets, []);
});

test('getUiState — hiddenWidgets 포함(toResponse 노출)', () => {
  const r = uiState.getUiState(ctxWith(memStore({ hiddenWidgets: ['disk'] })));
  assert.deepStrictEqual(r.hiddenWidgets, ['disk']);
});

// ── 할 일(todos) 핸들러 ──
function todoCtx(store) {
  let n = 0;
  return { uiStateStore: store, genTodoId: () => 't' + (0x100000 + (n++)).toString(16), nowMs: () => 1700000000000 };
}

test('addTodo — 추가(id·createdAt 스탬프 주입)·trim·todos 반환', () => {
  const ctx = todoCtx(memStore());
  const r = uiState.addTodo({ text: '  배포 확인  ' }, ctx);
  assert.ok(r.ok);
  assert.strictEqual(r.todos.length, 1);
  assert.strictEqual(r.todos[0].text, '배포 확인');
  assert.strictEqual(r.todos[0].done, false);
  assert.strictEqual(r.todos[0].createdAt, 1700000000000);
  assert.ok(/^t[0-9a-f]{6,}$/.test(r.todos[0].id));
});

test('addTodo — 빈 텍스트 → INVALID_TEXT', () => {
  assert.strictEqual(uiState.addTodo({ text: '   ' }, todoCtx(memStore())).code, 'INVALID_TEXT');
  assert.strictEqual(uiState.addTodo({}, todoCtx(memStore())).code, 'INVALID_TEXT');
});

test('toggleTodo — 완료 토글 / 없는 id / 잘못된 id', () => {
  const ctx = todoCtx(memStore());
  const id = uiState.addTodo({ text: 'x' }, ctx).todos[0].id;
  let r = uiState.toggleTodo({ id, done: true }, ctx);
  assert.ok(r.ok); assert.strictEqual(r.todos[0].done, true);
  r = uiState.toggleTodo({ id, done: false }, ctx);
  assert.strictEqual(r.todos[0].done, false);
  assert.strictEqual(uiState.toggleTodo({ id: 'tffffff', done: true }, ctx).code, 'NOT_FOUND');
  assert.strictEqual(uiState.toggleTodo({ id: 'BAD' }, ctx).code, 'INVALID_ID');
});

test('removeTodo — 삭제 / 없는 id', () => {
  const ctx = todoCtx(memStore());
  const id = uiState.addTodo({ text: 'x' }, ctx).todos[0].id;
  const r = uiState.removeTodo({ id }, ctx);
  assert.ok(r.ok); assert.strictEqual(r.todos.length, 0);
  assert.strictEqual(uiState.removeTodo({ id: 'tabcabc' }, ctx).code, 'NOT_FOUND');
  assert.strictEqual(uiState.removeTodo({ id: 'BAD' }, ctx).code, 'INVALID_ID');
});

// ── [백로그2-4] 할 일 마감 일시(dueAt) ──

test('addTodo — dueAt 설정/무효값 graceful(null)', () => {
  const ctx = todoCtx(memStore());
  assert.strictEqual(uiState.addTodo({ text: 'a', dueAt: 1800000000000 }, ctx).todos[0].dueAt, 1800000000000);
  assert.strictEqual(uiState.addTodo({ text: 'b' }, ctx).todos[1].dueAt, null, '미지정 → null');
  assert.strictEqual(uiState.addTodo({ text: 'c', dueAt: -5 }, ctx).todos[2].dueAt, null, '음수 → null');
  assert.strictEqual(uiState.addTodo({ text: 'd', dueAt: 'x' }, ctx).todos[3].dueAt, null, '비수치 → null');
});

test('setTodoDue — 기존 할 일 마감 설정·해제·검증', () => {
  const ctx = todoCtx(memStore());
  const id = uiState.addTodo({ text: 'x' }, ctx).todos[0].id;
  let r = uiState.setTodoDue({ id, dueAt: 1800000000000 }, ctx);
  assert.ok(r.ok); assert.strictEqual(r.todos[0].dueAt, 1800000000000);
  r = uiState.setTodoDue({ id, dueAt: null }, ctx); // 해제
  assert.strictEqual(r.todos[0].dueAt, null);
  assert.strictEqual(uiState.setTodoDue({ id: 'tffffff', dueAt: 1 }, ctx).code, 'NOT_FOUND');
  assert.strictEqual(uiState.setTodoDue({ id: 'BAD' }, ctx).code, 'INVALID_ID');
});

test('getUiState — todos 포함', () => {
  const ctx = todoCtx(memStore());
  uiState.addTodo({ text: 'a' }, ctx);
  const r = uiState.getUiState(ctx);
  assert.ok(Array.isArray(r.todos));
  assert.strictEqual(r.todos.length, 1);
});

// ── 언어 추세 baseline 갱신 ──
test('updateLangTrend — 새 스캔이면 cur→prev 이동, 같은 스캔이면 baseline 유지', () => {
  const s = memStore();
  const ctx = { uiStateStore: s };
  let r = uiState.updateLangTrend({ generatedAt: 'g1', counts: { TS: 3 } }, ctx);
  assert.deepStrictEqual(r.prev, {});
  assert.deepStrictEqual(r.cur, { TS: 3 });
  r = uiState.updateLangTrend({ generatedAt: 'g1', counts: { TS: 5 } }, ctx); // 같은 스캔
  assert.deepStrictEqual(r.prev, {}, 'baseline 유지');
  r = uiState.updateLangTrend({ generatedAt: 'g2', counts: { TS: 4 } }, ctx); // 새 스캔
  assert.deepStrictEqual(r.prev, { TS: 3 }, '직전 cur가 prev로');
  assert.deepStrictEqual(r.cur, { TS: 4 });
});

// ── [로드맵 Phase 2] 대시보드 프리셋 IPC ────────────────────────────────────
test('Phase2 IPC — getUiState 가 dashboard(기본 프리셋 1개) 노출', () => {
  const r = uiState.getUiState(ctxWith(memStore()));
  assert.ok(r.dashboard && Array.isArray(r.dashboard.presets));
  assert.strictEqual(r.dashboard.presets.length, 1);
  assert.strictEqual(r.dashboard.activePreset, r.dashboard.presets[0].id);
});

test('Phase2 IPC — addPreset: 새 프리셋 추가 + 활성 전환 + 레거시 키 스왑(기본 배치)', () => {
  const s = memStore({ homeLayout: ['mail', 'todos'] }); // 기존 활성 배치
  const ctx = ctxWith(s);
  const r = uiState.addPreset({ name: '집중' }, ctx);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.dashboard.presets.length, 2);
  assert.strictEqual(r.dashboard.activePreset, r.dashboard.presets[1].id);
  // 새 활성 프리셋은 기본 배치(전 섹션 순서) → 레거시 homeLayout 스왑됨
  assert.deepStrictEqual(r.homeLayout, realStore.HOME_SECTION_IDS);
});

test('Phase2 IPC — setActivePreset: 전환 시 레거시 키가 대상 프리셋 내용으로', () => {
  const ctx = ctxWith(memStore({ homeLayout: ['mail', 'todos'] }));
  // p1(기본 배치) 추가 → 활성 p1
  const a = uiState.addPreset({ name: 'A' }, ctx);
  const firstId = a.dashboard.presets[0].id; // 'default'(배치 mail,todos)
  // 다시 default 로 전환 → 레거시가 default 내용(mail,todos)으로 복귀
  const r = uiState.setActivePreset({ id: firstId }, ctx);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.dashboard.activePreset, firstId);
  assert.deepStrictEqual(r.homeLayout.slice(0, 2), ['mail', 'todos']);
});

test('Phase2 IPC — setActivePreset: 없는 id → NO_PRESET', () => {
  assert.deepStrictEqual(uiState.setActivePreset({ id: 'ghost' }, ctxWith(memStore())), { ok: false, code: 'NO_PRESET' });
});

test('Phase2 IPC — duplicatePreset / renamePreset / removePreset', () => {
  const ctx = ctxWith(memStore());
  const base = uiState.getUiState(ctx).dashboard.presets[0].id;
  // 복제
  let r = uiState.duplicatePreset({ id: base }, ctx);
  assert.strictEqual(r.dashboard.presets.length, 2);
  const dupId = r.dashboard.activePreset;
  assert.notStrictEqual(dupId, base);
  // 이름 변경
  r = uiState.renamePreset({ id: dupId, name: '리뷰 모드' }, ctx);
  assert.strictEqual(r.dashboard.presets.find((p) => p.id === dupId).name, '리뷰 모드');
  // 삭제(활성 복제본) → default 로 이동
  r = uiState.removePreset({ id: dupId }, ctx);
  assert.strictEqual(r.dashboard.presets.length, 1);
  assert.strictEqual(r.dashboard.activePreset, base);
});

test('Phase2 IPC — removePreset: 마지막 프리셋은 삭제 불가(무변경)', () => {
  const ctx = ctxWith(memStore());
  const base = uiState.getUiState(ctx).dashboard.presets[0].id;
  const r = uiState.removePreset({ id: base }, ctx);
  assert.strictEqual(r.dashboard.presets.length, 1);
});

test('Phase1K IPC — exportDashboard → JSON, importDashboard → 적용(활성 레거시 스왑)', () => {
  const ctx = ctxWith(memStore());
  // 프리셋 2개 구성 후 내보내기
  uiState.addPreset({ name: '집중' }, ctx);
  const ex = uiState.exportDashboard(ctx);
  assert.strictEqual(ex.ok, true);
  assert.strictEqual(typeof ex.json, 'string');
  // 새 store 로 가져오기
  const ctx2 = ctxWith(memStore());
  const im = uiState.importDashboard({ json: ex.json }, ctx2);
  assert.strictEqual(im.ok, true);
  assert.strictEqual(im.dashboard.presets.length, 2);
});

test('Phase1K IPC — importDashboard: 파싱 실패 → INVALID', () => {
  assert.deepStrictEqual(uiState.importDashboard({ json: '{broken' }, ctxWith(memStore())), { ok: false, code: 'INVALID' });
  assert.deepStrictEqual(uiState.importDashboard({ json: 42 }, ctxWith(memStore())), { ok: false, code: 'INVALID' });
});
