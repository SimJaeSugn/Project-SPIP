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

/** [로드맵 Phase 5·B] 활성 프리셋의 필드 안전 조회(dashboard 부재/손상 graceful). */
function activePresetField(state, field, fallback) {
  const d = state && state.dashboard;
  if (!d || !Array.isArray(d.presets)) return fallback;
  const p = d.presets.find((x) => x && x.id === d.activePreset) || d.presets[0];
  return (p && p[field] !== undefined && p[field] !== null) ? p[field] : fallback;
}

function toResponse(state) {
  // [M13 C-M-1 ③] briefing 포함 — 별도 파일이라 가장 누락되기 쉬움. 누락 시 getUiState 응답에서 사라짐.
  //   carry-over 표시용으로 open 항목만 노출(done/dismissed는 비노출, 표시 안전·페이로드 최소).
  const briefing = state.briefing || { items: [], counters: { generated: 0, done: 0, dismiss: 0 } };
  const openItems = Array.isArray(briefing.items) ? briefing.items.filter((i) => i && i.status === 'open') : [];
  return {
    favorites: state.favorites, order: state.order, sortMode: state.sortMode, names: state.names,
    theme: state.theme, accent: state.accent || 'indigo', uiScale: state.uiScale || 'normal', // [Phase 1·J] 테마 개인화
    todos: state.todos, langTrend: state.langTrend, homeLayout: state.homeLayout,
    hiddenWidgets: state.hiddenWidgets, // [위젯 추가/제거] 숨긴(미적용) 위젯 집합
    homeWidgetSizes: state.homeWidgetSizes || {}, // [홈 위젯 크기] 위젯별 폭(열 스팬)·높이(px)
    briefing: { items: openItems, counters: briefing.counters },
    // [항목3] 연결된 LLM 모델 토큰 사용량 누적(표시·집계 전용 수치만). 정규화된 값 그대로 노출.
    aiUsage: state.aiUsage || uiStateStore.defaultAiUsage(),
    // [로드맵 Phase 2] 대시보드(프리셋) — 렌더러가 프리셋 탭·전환에 사용. 활성 프리셋은 레거시 키와 동기.
    dashboard: state.dashboard || uiStateStore.defaultDashboardState(),
    // [로드맵 Phase 3·G] 스크래치패드 메모(전역 콘텐츠) — 렌더러 위젯이 표시·편집.
    scratchpad: state.scratchpad || uiStateStore.defaultScratchpad(),
    // [로드맵 Phase 5·B] 활성 프리셋의 레이아웃 모드·프리폼 좌표 — 렌더러가 masonry/freeform 분기·배치에 사용.
    //   layout/hidden/sizes 는 레거시 키(위)와 동기지만, layoutMode/positions/groups 는 프리셋에만 있어 별도 노출.
    layoutMode: activePresetField(state, 'layoutMode', 'masonry'),
    homeWidgetPositions: activePresetField(state, 'positions', {}),
    // [로드맵 Phase 5·M] 활성 프리셋 그룹/섹션 — 렌더러가 접기 섹션으로 표시.
    homeWidgetGroups: activePresetField(state, 'groups', []),
  };
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
 * spip:setHomeLayout — 홈 섹션 순서 설정(R-32). 렌더러 입력은 신뢰하지 않으며
 *   메인의 normalizeHomeLayout이 유일 검증 경계: 화이트리스트 외/중복/비배열/손상 입력을 모두 흡수한다.
 *   잘못된 형태도 정규화가 graceful 처리하므로 에러코드 불필요.
 * @param {object} args { ids:string[] }
 * @returns {{ok:true,homeLayout:string[]}}
 */
function setHomeLayout(args, ctx) {
  const ids = (args && typeof args === 'object') ? args.ids : undefined;
  const homeLayout = uiStateStore.normalizeHomeLayout(ids); // 단일 신뢰 경계
  const { store, storeCtx } = resolveStore(ctx);
  const state = store.read(storeCtx);
  const next = store.write(Object.assign({}, state, { homeLayout }), storeCtx);
  return { ok: true, homeLayout: next.homeLayout };
}

/**
 * [홈 위젯 크기] spip:setHomeWidgetSizes — 위젯별 폭(열 스팬)·높이(px) 설정.
 *   렌더러 입력 불신 — normalizeHomeWidgetSizes 가 유일 검증 경계(화이트리스트·클램프). 손상 입력 흡수(에러코드 불요).
 * @param {object} args { sizes:Object<string,{w,h}> }
 * @returns {{ok:true, homeWidgetSizes}}
 */
function setHomeWidgetSizes(args, ctx) {
  const sizes = (args && typeof args === 'object') ? args.sizes : undefined;
  const homeWidgetSizes = uiStateStore.normalizeHomeWidgetSizes(sizes); // 단일 신뢰 경계
  const { store, storeCtx } = resolveStore(ctx);
  const state = store.read(storeCtx);
  const next = store.write(Object.assign({}, state, { homeWidgetSizes }), storeCtx);
  return { ok: true, homeWidgetSizes: next.homeWidgetSizes };
}

/**
 * [위젯 추가/제거] spip:setHiddenWidgets — 숨긴(미적용) 위젯 집합 설정. 토글 가능 위젯 화이트리스트만(단일 신뢰 경계).
 * @param {object} args { ids:string[] }
 * @returns {{ok:true, hiddenWidgets}}
 */
function setHiddenWidgets(args, ctx) {
  const ids = (args && typeof args === 'object') ? args.ids : undefined;
  const hiddenWidgets = uiStateStore.normalizeHiddenWidgets(ids);
  const { store, storeCtx } = resolveStore(ctx);
  const state = store.read(storeCtx);
  const next = store.write(Object.assign({}, state, { hiddenWidgets }), storeCtx);
  return { ok: true, hiddenWidgets: next.hiddenWidgets };
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
 * [로드맵 Phase 1·J] spip:setThemePrefs { accent?, uiScale? } — 액센트 색·UI 배율 설정(전역).
 *   화이트리스트(THEME_ACCENTS/UI_SCALES)만 — 검증은 메인 단일 경계. 미지정 필드는 기존 유지.
 * @returns {{ok:true, accent, uiScale}}
 */
function setThemePrefs(args, ctx) {
  args = (args && typeof args === 'object') ? args : {};
  const { store, storeCtx } = resolveStore(ctx);
  const state = store.read(storeCtx);
  const patch = {};
  if (typeof args.accent === 'string' && uiStateStore.THEME_ACCENTS.has(args.accent)) patch.accent = args.accent;
  if (typeof args.uiScale === 'string' && uiStateStore.UI_SCALES.has(args.uiScale)) patch.uiScale = args.uiScale;
  const written = store.write(Object.assign({}, state, patch), storeCtx);
  return { ok: true, accent: written.accent, uiScale: written.uiScale };
}

/**
 * [로드맵 Phase 3·G] spip:setScratchpad { text } — 스크래치패드 메모 저장.
 *   렌더러 입력 불신 — normalizeScratchpad 가 유일 검증 경계(개행 보존·제어문자 제거·길이 상한). updatedAt 은 메인 스탬프.
 * @param {object} args { text }
 * @returns {{ok:true, scratchpad:{text,updatedAt}}}
 */
function setScratchpad(args, ctx) {
  const text = (args && typeof args === 'object' && typeof args.text === 'string') ? args.text : '';
  const { store, storeCtx } = resolveStore(ctx);
  const state = store.read(storeCtx);
  const scratchpad = uiStateStore.normalizeScratchpad({ text, updatedAt: nowMs(ctx) });
  const next = store.write(Object.assign({}, state, { scratchpad }), storeCtx);
  return { ok: true, scratchpad: next.scratchpad };
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

// ── [로드맵 Phase 2] 프리셋(대시보드 모드) IPC — 검증·불변식은 uiStateStore 프리셋 CRUD 단일 경계 ──
//   활성 전환/추가/복제/삭제는 '레거시 키(homeLayout/hidden/sizes)를 (새) 활성 프리셋 내용으로 스왑'해
//   normalizeState reconcile 과 일관을 유지한다. 이름 변경은 내용/활성 불변이라 스왑 불요.

/** (활성) 프리셋 내용을 레거시 키에 실어 write — 스왑 후 응답은 toResponse(전체 최신). */
function writeWithActive(store, storeCtx, state, dashboard) {
  const active = (dashboard.presets || []).find((p) => p.id === dashboard.activePreset) || dashboard.presets[0];
  const written = store.write(Object.assign({}, state, {
    dashboard,
    homeLayout: active.layout, hiddenWidgets: active.hidden, homeWidgetSizes: active.sizes,
  }), storeCtx);
  return Object.assign({ ok: true }, toResponse(written));
}

/** spip:setActivePreset { id } — 활성 프리셋 전환(레거시 키 스왑). 없으면 NO_PRESET. */
function setActivePreset(args, ctx) {
  const id = (args && typeof args === 'object') ? args.id : undefined;
  const { store, storeCtx } = resolveStore(ctx);
  const state = store.read(storeCtx);
  if (!(state.dashboard.presets || []).some((p) => p.id === id)) return { ok: false, code: 'NO_PRESET' };
  return writeWithActive(store, storeCtx, state, uiStateStore.presetSetActive(state.dashboard, id));
}

/** spip:addPreset { name } — 새 기본 배치 프리셋 추가 + 활성 전환. 상한 초과 시 LIMIT. */
function addPreset(args, ctx) {
  const name = (args && typeof args === 'object' && typeof args.name === 'string') ? args.name : '';
  const { store, storeCtx } = resolveStore(ctx);
  const state = store.read(storeCtx);
  const r = uiStateStore.presetAdd(state.dashboard, name);
  if (!r.id) return { ok: false, code: 'LIMIT' };
  return writeWithActive(store, storeCtx, state, r.state);
}

/** [로드맵 Phase 1·L] spip:addTemplatePreset { name, template } — 템플릿 구성으로 새 프리셋 추가 + 활성 전환.
 *   template = { layout, hidden, sizes, layoutMode, groups }. 전 필드는 메인 프리셋 정규화(presetUpdate→normalize*)가
 *   유일 검증 경계(화이트리스트·클램프) — 렌더러 템플릿을 그대로 신뢰하지 않는다. 상한 초과 시 LIMIT. */
function addTemplatePreset(args, ctx) {
  const name = (args && typeof args === 'object' && typeof args.name === 'string') ? args.name : '';
  const tpl = (args && typeof args === 'object' && args.template && typeof args.template === 'object') ? args.template : {};
  const { store, storeCtx } = resolveStore(ctx);
  const state = store.read(storeCtx);
  const r = uiStateStore.presetAdd(state.dashboard, name);
  if (!r.id) return { ok: false, code: 'LIMIT' };
  const dashboard = uiStateStore.presetUpdate(r.state, r.id, {
    layout: tpl.layout, hidden: tpl.hidden, sizes: tpl.sizes, layoutMode: tpl.layoutMode, groups: tpl.groups,
  });
  return writeWithActive(store, storeCtx, state, dashboard);
}

/** spip:duplicatePreset { id } — 프리셋 복제 + 활성 전환. 없거나 상한이면 LIMIT. */
function duplicatePreset(args, ctx) {
  const id = (args && typeof args === 'object') ? args.id : undefined;
  const { store, storeCtx } = resolveStore(ctx);
  const state = store.read(storeCtx);
  const r = uiStateStore.presetDuplicate(state.dashboard, id);
  if (!r.id) return { ok: false, code: 'LIMIT' };
  return writeWithActive(store, storeCtx, state, r.state);
}

/** spip:renamePreset { id, name } — 이름 변경(내용·활성 불변). */
function renamePreset(args, ctx) {
  const id = (args && typeof args === 'object') ? args.id : undefined;
  const name = (args && typeof args === 'object' && typeof args.name === 'string') ? args.name : '';
  const { store, storeCtx } = resolveStore(ctx);
  const state = store.read(storeCtx);
  const dashboard = uiStateStore.presetRename(state.dashboard, id, name);
  const written = store.write(Object.assign({}, state, { dashboard }), storeCtx);
  return Object.assign({ ok: true }, toResponse(written));
}

/** spip:removePreset { id } — 프리셋 삭제(마지막은 불가). 활성 삭제 시 인접으로 이동 + 레거시 스왑. */
function removePreset(args, ctx) {
  const id = (args && typeof args === 'object') ? args.id : undefined;
  const { store, storeCtx } = resolveStore(ctx);
  const state = store.read(storeCtx);
  return writeWithActive(store, storeCtx, state, uiStateStore.presetRemove(state.dashboard, id));
}

/** [로드맵 Phase 5·B] spip:setLayoutMode { mode } — 활성 프리셋 레이아웃 모드(masonry|freeform). 검증은 LAYOUT_MODES. */
function setLayoutMode(args, ctx) {
  const mode = (args && typeof args === 'object' && uiStateStore.LAYOUT_MODES.has(args.mode)) ? args.mode : 'masonry';
  const { store, storeCtx } = resolveStore(ctx);
  const state = store.read(storeCtx);
  const dashboard = uiStateStore.presetUpdate(state.dashboard, state.dashboard.activePreset, { layoutMode: mode });
  const written = store.write(Object.assign({}, state, { dashboard }), storeCtx);
  return Object.assign({ ok: true }, toResponse(written));
}

/** [로드맵 Phase 5·B] spip:setWidgetPositions { positions } — 활성 프리셋 프리폼 좌표 { id:{x,y} }.
 *   렌더러 입력 불신 — normalizeWidgetPositions(presetUpdate 내부)가 유일 검증 경계(화이트리스트·정수 클램프). */
function setWidgetPositions(args, ctx) {
  const positions = (args && typeof args === 'object') ? args.positions : undefined;
  const { store, storeCtx } = resolveStore(ctx);
  const state = store.read(storeCtx);
  const dashboard = uiStateStore.presetUpdate(state.dashboard, state.dashboard.activePreset, { positions: positions });
  const written = store.write(Object.assign({}, state, { dashboard }), storeCtx);
  return Object.assign({ ok: true }, toResponse(written));
}

/** [로드맵 Phase 5·M] spip:setGroups { groups } — 활성 프리셋 그룹/섹션 배열 설정.
 *   렌더러 입력 불신 — normalizeGroups(presetUpdate 내부)가 유일 검증 경계(id·이름·members·상한). */
function setGroups(args, ctx) {
  const groups = (args && typeof args === 'object') ? args.groups : undefined;
  const { store, storeCtx } = resolveStore(ctx);
  const state = store.read(storeCtx);
  const dashboard = uiStateStore.presetUpdate(state.dashboard, state.dashboard.activePreset, { groups: groups });
  const written = store.write(Object.assign({}, state, { dashboard }), storeCtx);
  return Object.assign({ ok: true }, toResponse(written));
}

/** spip:exportDashboard — 현재 대시보드(전 프리셋)를 버전드 JSON 문자열로. */
function exportDashboard(ctx) {
  const { store, storeCtx } = resolveStore(ctx);
  const state = store.read(storeCtx);
  return { ok: true, json: uiStateStore.serializeDashboard(state.dashboard) };
}

/** spip:importDashboard { json } — JSON 을 정규화해 대시보드 교체(활성 프리셋 레거시 스왑). 파싱실패 INVALID. */
function importDashboard(args, ctx) {
  const json = (args && typeof args === 'object') ? args.json : undefined;
  const dashboard = uiStateStore.deserializeDashboard(json);
  if (!dashboard) return { ok: false, code: 'INVALID' };
  const { store, storeCtx } = resolveStore(ctx);
  const state = store.read(storeCtx);
  return writeWithActive(store, storeCtx, state, dashboard);
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
  // [백로그2-4] 선택 마감 일시(ms). 유한·양수만 허용, 그 외엔 미설정(null).
  const rawDue = (args && typeof args === 'object') ? args.dueAt : undefined;
  const dueAt = (typeof rawDue === 'number' && Number.isFinite(rawDue) && rawDue > 0) ? Math.floor(rawDue) : null;
  const { store, storeCtx } = resolveStore(ctx);
  const state = store.read(storeCtx);
  if (state.todos.length >= uiStateStore.MAX_TODOS) return { ok: false, code: 'LIMIT' };
  const todo = { id: genTodoId(ctx), text, done: false, createdAt: nowMs(ctx), dueAt };
  const next = store.write(Object.assign({}, state, { todos: state.todos.concat([todo]) }), storeCtx);
  return { ok: true, todos: next.todos };
}

/**
 * [백로그2-4] spip:setTodoDue — 기존 할 일의 마감 일시 설정/해제(dueAt=null=해제).
 * @param {object} args { id, dueAt:number|null }
 * @returns {{ok:true,todos} | {ok:false,code:'INVALID_ID'|'NOT_FOUND'}}
 */
function setTodoDue(args, ctx) {
  const id = (args && typeof args === 'object') ? args.id : undefined;
  if (typeof id !== 'string' || !uiStateStore.TODO_ID_RE.test(id)) return { ok: false, code: 'INVALID_ID' };
  const rawDue = (args && typeof args === 'object') ? args.dueAt : undefined;
  const dueAt = (typeof rawDue === 'number' && Number.isFinite(rawDue) && rawDue > 0) ? Math.floor(rawDue) : null;
  const { store, storeCtx } = resolveStore(ctx);
  const state = store.read(storeCtx);
  let found = false;
  const todos = state.todos.map((t) => {
    if (t.id === id) { found = true; return Object.assign({}, t, { dueAt }); }
    return t;
  });
  if (!found) return { ok: false, code: 'NOT_FOUND' };
  const next = store.write(Object.assign({}, state, { todos }), storeCtx);
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

module.exports = { getUiState, setFavorite, setOrder, setSortMode, setHomeLayout, setHiddenWidgets, setHomeWidgetSizes, setProjectName, setTheme, setThemePrefs, setScratchpad, addTodo, toggleTodo, removeTodo, setTodoDue, updateLangTrend, setActivePreset, addPreset, duplicatePreset, renamePreset, removePreset, addTemplatePreset, setLayoutMode, setWidgetPositions, setGroups, exportDashboard, importDashboard };
