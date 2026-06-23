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

const uiStateStore = require('../../lib/common/uiStateStore');

/** ctx에서 store/storeCtx 해석. */
function resolveStore(ctx) {
  const store = (ctx && ctx.uiStateStore) || uiStateStore;
  // read/write에 넘길 store ctx(파일 경로·deps 주입). ipc ctx를 그대로 전달.
  const storeCtx = { logger: ctx && ctx.logger, uiStatePath: ctx && ctx.uiStatePath, deps: ctx && ctx.uiStateDeps };
  return { store, storeCtx };
}

function toResponse(state) {
  return { favorites: state.favorites, order: state.order, sortMode: state.sortMode, names: state.names, theme: state.theme };
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

module.exports = { getUiState, setFavorite, setOrder, setSortMode, setProjectName, setTheme };
