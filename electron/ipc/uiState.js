'use strict';
/**
 * electron/ipc/uiState.js — UI 상태 IPC (R-19/R-20)
 *
 *   spip:getUiState              → ui-state.json 로드(graceful)
 *   spip:setFavorite { id, on }  → 즐겨찾기 집합 add/remove + 영속
 *   spip:setOrder { ids }        → 수동 순서 + sortMode='manual' 전환 + 영속
 *   spip:setSortMode { mode }    → 'auto'|'manual' 화이트리스트 + 영속
 *
 * [보안] id는 형식 검증(^[0-9a-f]{1,64}$)·개수 상한·중복 제거. id는 실행/경로에 미사용
 *   (표시·정렬 메타에만) → 오염돼도 표면 극소. 모든 쓰기는 uiStateStore.write(0600 원자적).
 *
 * [헤드리스 검증, F-3] uiStateStore는 ctx로 주입 가능. 검증 로직·실패 code 단위테스트.
 *
 * 외부 의존성 0 — Electron API 미import.
 */

const crypto = require('crypto');
const uiStateStore = require('../../lib/common/uiStateStore');

/** ctx에서 store/storeCtx 해석. */
function resolveStore(ctx) {
  const store = (ctx && ctx.uiStateStore) || uiStateStore;
  // read/write에 넘길 store ctx(파일 경로·deps 주입). ipc ctx를 그대로 전달.
  const storeCtx = { logger: ctx && ctx.logger, uiStatePath: ctx && ctx.uiStatePath, deps: ctx && ctx.uiStateDeps };
  return { store, storeCtx };
}

function toResponse(state) {
  return { favorites: state.favorites, order: state.order, sortMode: state.sortMode, names: state.names, theme: state.theme, todos: state.todos, langTrend: state.langTrend };
}

/** 할 일 id 생성(메인 권한). genTodoId 주입 가능(테스트). */
function genTodoId(ctx) {
  if (ctx && typeof ctx.genTodoId === 'function') return ctx.genTodoId();
  return 't' + crypto.randomBytes(6).toString('hex');
}

/** 생성 시각(ms). 주입 가능(테스트 결정성). */
function nowMs(ctx) {
  if (ctx && typeof ctx.nowMs === 'function') return ctx.nowMs();
  return Date.now();
}

/**
 * spip:getUiState — 현재 UI 상태 반환(graceful). 스냅샷이 있으면 즐겨찾기·순서를
 *   현재 프로젝트 id 집합에 맞춰 머지·정리(재스캔으로 사라진 항목 제거)하고 변경 시 영속한다.
 * @returns {{ok:true,favorites,order,sortMode,names,theme}}
 */
function getUiState(ctx) {
  const { store, storeCtx } = resolveStore(ctx);
  let state = store.read(storeCtx);
  const snap = ctx && ctx.store; // 스냅샷 store(프로젝트 목록)
  if (snap && typeof snap.getProjects === 'function' && snap.hasSnapshot) {
    const ids = new Set();
    for (const p of snap.getProjects()) { if (p && typeof p.id === 'string') ids.add(p.id); }
    const rec = uiStateStore.reconcileState(state, ids);
    if (rec.changed) {
      try { state = store.write(rec.state, storeCtx); } catch (_) { state = rec.state; }
    } else {
      state = rec.state;
    }
  }
  return Object.assign({ ok: true }, toResponse(state));
}

/**
 * spip:setFavorite — id를 즐겨찾기 집합에 add(on=true)/remove(on=false).
 * @param {object} args { id, on }
 * @returns {{ok:true,favorites} | {ok:false,code:'INVALID_ID'}}
 */
function setFavorite(args, ctx) {
  const id = args && typeof args === 'object' ? args.id : undefined;
  if (typeof id !== 'string' || !uiStateStore.ID_RE.test(id)) return { ok: false, code: 'INVALID_ID' };
  const on = !!(args && args.on);
  const { store, storeCtx } = resolveStore(ctx);
  const state = store.read(storeCtx);
  const set = new Set(state.favorites);
  if (on) {
    if (set.size >= uiStateStore.MAX_FAVORITES && !set.has(id)) {
      // 상한 초과 — 변경 없이 현재 목록 반환(거부보다 graceful, id 자체는 유효).
      return { ok: true, favorites: state.favorites };
    }
    set.add(id);
  } else {
    set.delete(id);
  }
  const next = store.write(Object.assign({}, state, { favorites: Array.from(set) }), storeCtx);
  return { ok: true, favorites: next.favorites };
}

/**
 * spip:setOrder — 수동 순서 설정 + sortMode='manual' 전환.
 * @param {object} args { ids:string[] }
 * @returns {{ok:true,order,sortMode:'manual'} | {ok:false,code:'INVALID_ORDER'}}
 */
function setOrder(args, ctx) {
  const ids = args && typeof args === 'object' ? args.ids : undefined;
  if (!Array.isArray(ids)) return { ok: false, code: 'INVALID_ORDER' };
  const { store, storeCtx } = resolveStore(ctx);
  const state = store.read(storeCtx);
  // normalizeIdArray가 형식·중복·개수 상한을 강제(write 내부에서도 재적용되나 명시 호출로 응답 일관).
  const order = uiStateStore.normalizeIdArray(ids, uiStateStore.MAX_ORDER);
  const next = store.write(Object.assign({}, state, { order, sortMode: 'manual' }), storeCtx);
  return { ok: true, order: next.order, sortMode: next.sortMode };
}

/**
 * spip:setSortMode — 'auto'|'manual' 화이트리스트.
 * @param {object} args { mode }
 * @returns {{ok:true,sortMode}}
 */
function setSortMode(args, ctx) {
  const mode = args && typeof args === 'object' ? args.mode : undefined;
  const next = uiStateStore.SORT_MODES.has(mode) ? mode : 'auto';
  const { store, storeCtx } = resolveStore(ctx);
  const state = store.read(storeCtx);
  const written = store.write(Object.assign({}, state, { sortMode: next }), storeCtx);
  return { ok: true, sortMode: written.sortMode };
}

/**
 * spip:setProjectName — id의 표시 별칭 설정/해제. 빈 이름이면 별칭 제거(감지명 복원).
 *   sanitize(제어문자 제거·길이 상한)는 write 내부 normalizeNames가 강제.
 * @param {object} args { id, name }
 * @returns {{ok:true,names} | {ok:false,code:'INVALID_ID'}}
 */
function setProjectName(args, ctx) {
  const id = args && typeof args === 'object' ? args.id : undefined;
  if (typeof id !== 'string' || !uiStateStore.ID_RE.test(id)) return { ok: false, code: 'INVALID_ID' };
  const name = (args && typeof args.name === 'string') ? args.name : '';
  const { store, storeCtx } = resolveStore(ctx);
  const state = store.read(storeCtx);
  const names = Object.assign({}, state.names);
  const trimmed = name.trim();
  if (trimmed) names[id] = trimmed; else delete names[id];
  const next = store.write(Object.assign({}, state, { names }), storeCtx);
  return { ok: true, names: next.names };
}

/**
 * spip:setTheme — 'light'|'dark'|'system' 화이트리스트.
 * @param {object} args { theme }
 * @returns {{ok:true,theme}}
 */
function setTheme(args, ctx) {
  const theme = args && typeof args === 'object' ? args.theme : undefined;
  const next = uiStateStore.THEMES.has(theme) ? theme : 'system';
  const { store, storeCtx } = resolveStore(ctx);
  const state = store.read(storeCtx);
  const written = store.write(Object.assign({}, state, { theme: next }), storeCtx);
  return { ok: true, theme: written.theme };
}

/**
 * spip:addTodo — 할 일 추가(메인이 id·createdAt 스탬프). 빈 텍스트 거부, 개수 상한.
 * @param {object} args { text }
 * @returns {{ok:true,todos} | {ok:false,code:'INVALID_TEXT'|'LIMIT'}}
 */
function addTodo(args, ctx) {
  const raw = (args && typeof args === 'object' && typeof args.text === 'string') ? args.text : '';
  const text = uiStateStore.sanitizeTodoText(raw);
  if (!text) return { ok: false, code: 'INVALID_TEXT' };
  const { store, storeCtx } = resolveStore(ctx);
  const state = store.read(storeCtx);
  if (state.todos.length >= uiStateStore.MAX_TODOS) return { ok: false, code: 'LIMIT' };
  const todo = { id: genTodoId(ctx), text, done: false, createdAt: nowMs(ctx) };
  const next = store.write(Object.assign({}, state, { todos: state.todos.concat([todo]) }), storeCtx);
  return { ok: true, todos: next.todos };
}

/**
 * spip:toggleTodo — id의 완료 상태 설정.
 * @param {object} args { id, done }
 * @returns {{ok:true,todos} | {ok:false,code:'INVALID_ID'|'NOT_FOUND'}}
 */
function toggleTodo(args, ctx) {
  const id = (args && typeof args === 'object') ? args.id : undefined;
  if (typeof id !== 'string' || !uiStateStore.TODO_ID_RE.test(id)) return { ok: false, code: 'INVALID_ID' };
  const done = !!(args && args.done);
  const { store, storeCtx } = resolveStore(ctx);
  const state = store.read(storeCtx);
  let found = false;
  const todos = state.todos.map((t) => {
    if (t.id === id) { found = true; return Object.assign({}, t, { done }); }
    return t;
  });
  if (!found) return { ok: false, code: 'NOT_FOUND' };
  const next = store.write(Object.assign({}, state, { todos }), storeCtx);
  return { ok: true, todos: next.todos };
}

/**
 * spip:removeTodo — id 삭제.
 * @param {object} args { id }
 * @returns {{ok:true,todos} | {ok:false,code:'INVALID_ID'|'NOT_FOUND'}}
 */
function removeTodo(args, ctx) {
  const id = (args && typeof args === 'object') ? args.id : undefined;
  if (typeof id !== 'string' || !uiStateStore.TODO_ID_RE.test(id)) return { ok: false, code: 'INVALID_ID' };
  const { store, storeCtx } = resolveStore(ctx);
  const state = store.read(storeCtx);
  const todos = state.todos.filter((t) => t.id !== id);
  if (todos.length === state.todos.length) return { ok: false, code: 'NOT_FOUND' };
  const next = store.write(Object.assign({}, state, { todos }), storeCtx);
  return { ok: true, todos: next.todos };
}

/**
 * spip:updateLangTrend — 언어 분포 추세 baseline 갱신. 같은 스캔(generatedAt 동일)이면 갱신 없이
 *   직전 baseline(prev)을 돌려주고, 새 스캔이면 직전 cur를 prev로 이동·cur 갱신해 영속한다.
 *   렌더러는 prev와 현재 counts를 비교해 ▲▼를 계산한다.
 * @param {object} args { generatedAt, counts:{lang:n} }
 * @returns {{ok:true, prev:object, cur:object}}
 */
function updateLangTrend(args, ctx) {
  args = (args && typeof args === 'object') ? args : {};
  const generatedAt = (typeof args.generatedAt === 'string' && args.generatedAt) ? args.generatedAt : null;
  const counts = uiStateStore.normalizeLangCounts(args.counts);
  const { store, storeCtx } = resolveStore(ctx);
  const state = store.read(storeCtx);
  const lt = state.langTrend || { generatedAt: null, prev: {}, cur: {} };
  if (lt.generatedAt && generatedAt && lt.generatedAt === generatedAt) {
    return { ok: true, prev: lt.prev || {}, cur: counts }; // 같은 스캔 — baseline 유지
  }
  const next = { generatedAt: generatedAt, prev: lt.cur || {}, cur: counts };
  const written = store.write(Object.assign({}, state, { langTrend: next }), storeCtx);
  return { ok: true, prev: written.langTrend.prev, cur: written.langTrend.cur };
}

module.exports = { getUiState, setFavorite, setOrder, setSortMode, setProjectName, setTheme, addTodo, toggleTodo, removeTodo, updateLangTrend };
