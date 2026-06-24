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
  let state = realStore.normalizeState(initial || {});
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
  assert.deepStrictEqual(r.homeLayout, ['mail', 'attention', 'productivity', 'activity', 'todos', 'disk', 'aiusage', 'featureAdd']);
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
