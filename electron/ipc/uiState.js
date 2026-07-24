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
    // [위젯 인스턴스] 할 일은 인스턴스별 박스 { iid: Todo[] }. todos(전역)는 폐기 — 항상 빈 배열(하위호환 키).
    //   legacyTodos = 아직 어느 인스턴스도 흡수 안 한 전역 시절 할 일(첫 할 일 위젯이 열릴 때 흡수됨).
    //   렌더러는 자기 iid 의 todoBoxes[iid] 만 표시한다.
    todos: state.todos, todoBoxes: state.todoBoxes || {}, legacyTodos: state.legacyTodos || [],
    langTrend: state.langTrend,
    // [위젯 인스턴스] 배치 = [{iid,type,name}] — 배열 순서 = 배치 순서, 없으면 미배치(옛 '숨김').
    //   같은 type 이 여러 번 올 수 있다(중복 배치). name 은 배치별 사용자 지정명(빈 값이면 렌더러가 타입 기본명).
    homeWidgets: state.homeWidgets || [],
    homeWidgetSizes: state.homeWidgetSizes || {}, // [홈 위젯 크기] 인스턴스별 폭(열 스팬)·높이(px) — 키는 iid
    briefing: { items: openItems, counters: briefing.counters },
    // [항목3] 연결된 LLM 모델 토큰 사용량 누적(표시·집계 전용 수치만). 정규화된 값 그대로 노출.
    aiUsage: state.aiUsage || uiStateStore.defaultAiUsage(),
    // [로드맵 Phase 2] 대시보드(프리셋) — 렌더러가 프리셋 탭·전환에 사용. 활성 프리셋은 레거시 키와 동기.
    dashboard: state.dashboard || uiStateStore.defaultDashboardState(),
    // [로드맵 Phase 3·G] 스크래치패드 메모(전역 콘텐츠) — 렌더러 위젯이 표시·편집.
    // [위젯 인스턴스] 메모는 인스턴스별 — { iid: {text,updatedAt} }.
    scratchpads: state.scratchpads || {},
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

/* ── [위젯 인스턴스] 할 일 박스(iid) — 인스턴스별 목록 격리 + 전역 todos 무손실 흡수 ──────────────
 *   markdown.js(문서함) 선례를 미러링한다: 채널은 첫 인자로 박스(iid)를 받고, 메인이 (a) iid 형식,
 *   (b) 배치된 위젯의 iid 인지(격리) 를 강제한다. 남의/없는 박스 접근은 NOT_FOUND(mdedit 동형). */

/** args 에서 박스 키(=할 일 위젯 인스턴스 id) — 형식 불량이면 null(호출부가 BAD_INPUT). */
function argBox(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return null;
  const box = args.box;
  return (typeof box === 'string' && uiStateStore.IID_RE.test(box)) ? box : null;
}

/** 첫 할 일(todos) 위젯 인스턴스의 iid(배치 순서) — 레거시 전역 할 일을 흡수할 박스. 없으면 null. */
function firstTodoBox(state) {
  const widgets = Array.isArray(state.homeWidgets) ? state.homeWidgets : [];
  const first = widgets.find((w) => w && w.type === 'todos');
  return (first && typeof first.iid === 'string') ? first.iid : null;
}

/** 박스가 배치된 할 일 위젯의 iid 인지(격리 검증). */
function isPlacedTodoBox(state, box) {
  const widgets = Array.isArray(state.homeWidgets) ? state.homeWidgets : [];
  return widgets.some((w) => w && w.iid === box && w.type === 'todos');
}

// [Med-1] 박스 목록 조회/교체는 저장소 단일 헬퍼(uiStateStore.todosOf/withTodos) 재사용 — 로컬 재구현 없음.

/**
 * [전역 todos → 인스턴스 박스 흡수] 전역 시절의 할 일(state.legacyTodos)을 **첫 할 일 위젯 인스턴스**의
 *   박스로 흡수한다(markdown.js adoptLegacy 동형). 다른 인스턴스가 먼저 접근해도 흡수하지 않는다(엉뚱한
 *   위젯으로 가지 않게). 흡수 대상이 아직 배치되지 않았으면 legacyTodos 는 그대로 보존된다(무손실).
 *   흡수 시 legacyTodos 를 비우고 영속한다. @returns {object} 흡수 후(또는 그대로의) 정규화 상태
 */
function adoptLegacyTodos(state, box, store, storeCtx) {
  const legacy = Array.isArray(state.legacyTodos) ? state.legacyTodos : [];
  if (legacy.length === 0) return state;
  if (box !== firstTodoBox(state)) return state;

  const merged = legacy.concat(uiStateStore.todosOf(state, box)).slice(0, uiStateStore.MAX_TODOS);
  const todoBoxes = uiStateStore.withTodos(state, box, merged);
  const nextState = Object.assign({}, state, { todoBoxes, legacyTodos: [] });
  // write 실패해도 응답엔 메모리 병합본을 반영한다(로드-시 흡수가 화면에서 할 일을 잃지 않게) — 정규화 통과.
  try { return store.write(nextState, storeCtx); } catch (_) { return uiStateStore.normalizeState(nextState); }
}

/** 박스 스코프 상태 읽기 + 레거시 흡수. 모든 할 일 CRUD 의 단일 진입.
 *   @returns {{box:string,state:object}|{code:string}} 박스 형식/격리 실패는 code(BAD_INPUT/NOT_FOUND). */
function readTodoBox(args, store, storeCtx) {
  const box = argBox(args);
  if (!box) return { code: 'BAD_INPUT' };
  let state = store.read(storeCtx);
  state = adoptLegacyTodos(state, box, store, storeCtx);
  // 배치된 할 일 위젯 인스턴스가 아니면 접근 거부(격리 — 남의/없는 박스). mdedit NOT_FOUND 동형.
  if (!isPlacedTodoBox(state, box)) return { code: 'NOT_FOUND' };
  return { box, state };
}

/**
 * spip:getUiState — 현재 UI 상태 반환(graceful). 스냅샷이 있으면 즐겨찾기·순서를
 *   현재 프로젝트 id 집합에 맞춰 머지·정리(재스캔으로 사라진 항목 제거)하고 변경 시 영속한다.
 *
 * [위젯 인스턴스] 할 일은 read/list 채널이 없고 이 번들로만 내려간다 — 그래서 **여기서 legacyTodos 를
 *   로드-시 흡수**한다(mdedit 이 readBox→adoptLegacy 로 read 경로에서 흡수하는 것과 대칭). 첫 mutation 전
 *   앱 기동 직후에도 기존 사용자의 할 일이 첫 할 일 박스에 담겨 즉시 표시된다(프론트 무변경). 첫 할 일 위젯이
 *   배치돼 있을 때만 흡수하고(없으면 legacy 보존·무손실), 이미 비었으면 no-op(멱등). 상승 세션이면 store.write
 *   가 디스크 no-op 이지만 메모리 병합 결과를 반환하므로 응답엔 병합본이 반영된다.
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
  // [로드-시 흡수] 첫 할 일 박스가 배치돼 있으면 legacyTodos 를 그 박스로 흡수(read 경로 흡수). box=null 이거나
  //   legacy 가 비면 adoptLegacyTodos 가 그대로 상태를 돌려준다(no-op). write 실패는 graceful(메모리 병합만).
  const firstBox = firstTodoBox(state);
  if (firstBox) {
    try { state = adoptLegacyTodos(state, firstBox, store, storeCtx); } catch (_) { /* graceful */ }
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
 * [위젯 인스턴스] spip:setHomeLayout — 배치 **순서**만 바꾼다(iid 순열). 추가/제거는 addWidget/removeWidget,
 *   이름 변경은 renameWidget 이 담당한다 — 이 채널로는 인스턴스를 만들거나 없앨 수 없다.
 *   렌더러가 보낸 iid 중 실재하는 것만 그 순서로 앞에 놓고, 빠뜨린 것은 기존 순서대로 뒤에 보충한다
 *   (드래그 재정렬 도중 DOM 에서 일부 셀을 못 읽어도 위젯이 사라지지 않게 — 손실 방지).
 * @param {object} args { ids:string[] }  iid 순열
 * @returns {{ok:true,homeWidgets:Array}}
 */
function setHomeLayout(args, ctx) {
  const ids = (args && typeof args === 'object' && Array.isArray(args.ids)) ? args.ids : [];
  const { store, storeCtx } = resolveStore(ctx);
  const state = store.read(storeCtx);
  const cur = Array.isArray(state.homeWidgets) ? state.homeWidgets : [];

  const byIid = new Map(cur.map((w) => [w.iid, w]));
  const ordered = [];
  const seen = new Set();
  for (const id of ids) {
    const w = (typeof id === 'string') ? byIid.get(id) : null;
    if (!w || seen.has(id)) continue; // 미지·중복 iid 는 무시(새 인스턴스를 만들지 않는다)
    seen.add(id);
    ordered.push(w);
  }
  for (const w of cur) if (!seen.has(w.iid)) ordered.push(w); // 누락분은 기존 순서로 보충(손실 0)

  const next = store.write(Object.assign({}, state, { homeWidgets: ordered }), storeCtx);
  return { ok: true, homeWidgets: next.homeWidgets };
}

/**
 * [위젯 인스턴스] spip:addWidget — 타입 1개를 새 인스턴스로 배치 끝에 추가. **iid 는 메인이 발급**한다
 *   (렌더러가 id 를 주입할 수 없다 — 기존 shelf/mdedit/preset 과 동일 규약).
 *   같은 타입을 여러 번 추가할 수 있다(중복 배치가 이 기능의 목적).
 * @param {object} args { type, name? }
 * @returns {{ok:true,homeWidgets,iid} | {ok:false,code:'BAD_TYPE'|'LIMIT'}}
 */
function addWidget(args, ctx) {
  const type = (args && typeof args === 'object') ? args.type : undefined;
  if (typeof type !== 'string' || uiStateStore.TOGGLEABLE_WIDGET_IDS.indexOf(type) < 0) {
    return { ok: false, code: 'BAD_TYPE' };
  }
  const name = (args && typeof args.name === 'string') ? args.name : '';

  const { store, storeCtx } = resolveStore(ctx);
  const state = store.read(storeCtx);
  const cur = Array.isArray(state.homeWidgets) ? state.homeWidgets : [];
  if (cur.length >= uiStateStore.MAX_WIDGETS) return { ok: false, code: 'LIMIT' };

  const iid = uiStateStore.nextWidgetIid(cur);
  const next = store.write(Object.assign({}, state, {
    homeWidgets: cur.concat([{ iid, type, name }]),
  }), storeCtx);
  return Object.assign({ ok: true, iid }, toResponse(next));
}

/**
 * [위젯 인스턴스] spip:removeWidget — 배치에서 인스턴스 1개 제거(정확 iid 일치).
 *   그 인스턴스의 크기·좌표·그룹 소속은 normalizeState 가 자동 정리한다(배치된 iid 만 유효 — 고아 키 0).
 * @param {object} args { iid }
 * @returns {{ok:true,homeWidgets} | {ok:false,code:'NOT_FOUND'}}
 */
function removeWidget(args, ctx) {
  const iid = (args && typeof args === 'object') ? args.iid : undefined;
  const { store, storeCtx } = resolveStore(ctx);
  const state = store.read(storeCtx);
  const cur = Array.isArray(state.homeWidgets) ? state.homeWidgets : [];
  const kept = cur.filter((w) => w.iid !== iid);
  if (kept.length === cur.length) return { ok: false, code: 'NOT_FOUND' };
  const next = store.write(Object.assign({}, state, { homeWidgets: kept }), storeCtx);
  return Object.assign({ ok: true }, toResponse(next));
}

/**
 * [위젯 인스턴스] spip:renameWidget — 배치된 위젯의 표시명 변경. 빈 이름은 '이름 해제'(타입 기본명으로 복귀).
 *   sanitize·길이 상한은 normalizeHomeWidgets 단일 검증 경계.
 * @param {object} args { iid, name }
 * @returns {{ok:true,homeWidgets} | {ok:false,code:'NOT_FOUND'}}
 */
function renameWidget(args, ctx) {
  const iid = (args && typeof args === 'object') ? args.iid : undefined;
  const name = (args && typeof args === 'object' && typeof args.name === 'string') ? args.name : '';
  const { store, storeCtx } = resolveStore(ctx);
  const state = store.read(storeCtx);
  const cur = Array.isArray(state.homeWidgets) ? state.homeWidgets : [];
  if (!cur.some((w) => w.iid === iid)) return { ok: false, code: 'NOT_FOUND' };
  const nextWidgets = cur.map((w) => (w.iid === iid) ? Object.assign({}, w, { name }) : w);
  const next = store.write(Object.assign({}, state, { homeWidgets: nextWidgets }), storeCtx);
  return Object.assign({ ok: true }, toResponse(next));
}

/**
 * [홈 위젯 크기] spip:setHomeWidgetSizes — 인스턴스별 폭(열 스팬)·높이(px) 설정. 키는 iid.
 *   렌더러 입력 불신 — normalizeHomeWidgetSizes 가 유일 검증 경계(배치된 iid 만·클램프). 손상 입력 흡수(에러코드 불요).
 * @param {object} args { sizes:Object<string,{w,h}> }
 * @returns {{ok:true, homeWidgetSizes}}
 */
function setHomeWidgetSizes(args, ctx) {
  const sizes = (args && typeof args === 'object') ? args.sizes : undefined;
  const { store, storeCtx } = resolveStore(ctx);
  const state = store.read(storeCtx);
  // 배치된 iid 집합으로 게이트 — 없는 위젯의 크기를 심을 수 없다(고아 키 0).
  const placed = new Set((state.homeWidgets || []).map((w) => w.iid));
  const homeWidgetSizes = uiStateStore.normalizeHomeWidgetSizes(sizes, placed); // 단일 신뢰 경계
  const next = store.write(Object.assign({}, state, { homeWidgetSizes }), storeCtx);
  return { ok: true, homeWidgetSizes: next.homeWidgetSizes };
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
 * [로드맵 Phase 3·G / 위젯 인스턴스] spip:setScratchpad { iid, text } — 메모 저장.
 *   메모는 **인스턴스별**이다 — 메모 위젯을 2개 놓으면 각자 다른 메모를 쓴다.
 *   렌더러 입력 불신 — normalizeScratchpads 가 유일 검증 경계(개행 보존·제어문자 제거·길이 상한).
 *   updatedAt 은 메인 스탬프. iid 형식이 아니면 BAD_INPUT.
 * @param {object} args { iid, text }
 * @returns {{ok:true, scratchpads} | {ok:false,code:'BAD_INPUT'}}
 */
function setScratchpad(args, ctx) {
  const iid = (args && typeof args === 'object') ? args.iid : undefined;
  if (typeof iid !== 'string' || !uiStateStore.IID_RE.test(iid)) return { ok: false, code: 'BAD_INPUT' };
  const text = (args && typeof args.text === 'string') ? args.text : '';
  const { store, storeCtx } = resolveStore(ctx);
  const state = store.read(storeCtx);
  const scratchpads = Object.assign({}, state.scratchpads || {});
  scratchpads[iid] = { text, updatedAt: nowMs(ctx) };
  const next = store.write(Object.assign({}, state, { scratchpads }), storeCtx);
  return { ok: true, scratchpads: next.scratchpads };
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

/** (활성) 프리셋 내용을 최상위 키에 실어 write — 스왑 후 응답은 toResponse(전체 최신). */
function writeWithActive(store, storeCtx, state, dashboard) {
  const active = (dashboard.presets || []).find((p) => p.id === dashboard.activePreset) || dashboard.presets[0];
  const written = store.write(Object.assign({}, state, {
    dashboard,
    homeWidgets: active.widgets, homeWidgetSizes: active.sizes, // [위젯 인스턴스] 배치·크기 스왑
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
 *   template = { widgets, sizes, layoutMode, groups }. 전 필드는 메인 프리셋 정규화(presetUpdate→normalize*)가
 *   유일 검증 경계(화이트리스트·클램프) — 렌더러 템플릿을 그대로 신뢰하지 않는다. 상한 초과 시 LIMIT. */
function addTemplatePreset(args, ctx) {
  const name = (args && typeof args === 'object' && typeof args.name === 'string') ? args.name : '';
  const tpl = (args && typeof args === 'object' && args.template && typeof args.template === 'object') ? args.template : {};
  const { store, storeCtx } = resolveStore(ctx);
  const state = store.read(storeCtx);
  const r = uiStateStore.presetAdd(state.dashboard, name);
  if (!r.id) return { ok: false, code: 'LIMIT' };
  const dashboard = uiStateStore.presetUpdate(r.state, r.id, {
    widgets: tpl.widgets, sizes: tpl.sizes, layoutMode: tpl.layoutMode, groups: tpl.groups,
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
 * spip:addTodo — 그 박스(위젯 인스턴스)에 할 일 추가(메인이 id·createdAt 스탬프). 박스당 개수 상한.
 *   [위젯 인스턴스] 첫 인자로 박스(iid)를 받는다.
 *   [T-1] 검증 순서 = 박스 격리(BAD_INPUT/NOT_FOUND) **먼저**, 그다음 텍스트(INVALID_TEXT). 텍스트를 먼저
 *   보면 '박스 존재 오라클'(유효 텍스트로만 NOT_FOUND, 빈 텍스트로 INVALID_TEXT → 박스 존재 여부 누설)이
 *   되므로, 4채널 모두 박스 검증을 선행해 시맨틱을 일관시킨다.
 * @param {object} args { box, text, dueAt? }
 * @returns {{ok:true,box,todos} | {ok:false,code:'BAD_INPUT'|'NOT_FOUND'|'INVALID_TEXT'|'LIMIT'}}
 */
function addTodo(args, ctx) {
  const { store, storeCtx } = resolveStore(ctx);
  const r = readTodoBox(args, store, storeCtx); // 박스 격리 선행(오라클 방지)
  if (r.code) return { ok: false, code: r.code };
  const raw = (args && typeof args === 'object' && typeof args.text === 'string') ? args.text : '';
  const text = uiStateStore.sanitizeTodoText(raw);
  if (!text) return { ok: false, code: 'INVALID_TEXT' };
  // [백로그2-4] 선택 마감 일시(ms). 유한·양수만 허용, 그 외엔 미설정(null).
  const rawDue = (args && typeof args === 'object') ? args.dueAt : undefined;
  const dueAt = (typeof rawDue === 'number' && Number.isFinite(rawDue) && rawDue > 0) ? Math.floor(rawDue) : null;
  const cur = uiStateStore.todosOf(r.state, r.box);
  if (cur.length >= uiStateStore.MAX_TODOS) return { ok: false, code: 'LIMIT' };
  const todo = { id: genTodoId(ctx), text, done: false, createdAt: nowMs(ctx), dueAt };
  const next = store.write(Object.assign({}, r.state, { todoBoxes: uiStateStore.withTodos(r.state, r.box, cur.concat([todo])) }), storeCtx);
  return { ok: true, box: r.box, todos: uiStateStore.todosOf(next, r.box) };
}

/**
 * [백로그2-4] spip:setTodoDue — 그 박스의 기존 할 일 마감 일시 설정/해제(dueAt=null=해제).
 *   [T-1] 박스 격리 선행 후 id 형식 검증.
 * @param {object} args { box, id, dueAt:number|null }
 * @returns {{ok:true,box,todos} | {ok:false,code:'BAD_INPUT'|'NOT_FOUND'|'INVALID_ID'}}
 */
function setTodoDue(args, ctx) {
  const { store, storeCtx } = resolveStore(ctx);
  const r = readTodoBox(args, store, storeCtx);
  if (r.code) return { ok: false, code: r.code };
  const id = (args && typeof args === 'object') ? args.id : undefined;
  if (typeof id !== 'string' || !uiStateStore.TODO_ID_RE.test(id)) return { ok: false, code: 'INVALID_ID' };
  const rawDue = (args && typeof args === 'object') ? args.dueAt : undefined;
  const dueAt = (typeof rawDue === 'number' && Number.isFinite(rawDue) && rawDue > 0) ? Math.floor(rawDue) : null;
  let found = false;
  const todos = uiStateStore.todosOf(r.state, r.box).map((t) => {
    if (t.id === id) { found = true; return Object.assign({}, t, { dueAt }); }
    return t;
  });
  if (!found) return { ok: false, code: 'NOT_FOUND' }; // 다른 박스의 할 일은 못 고친다(격리)
  const next = store.write(Object.assign({}, r.state, { todoBoxes: uiStateStore.withTodos(r.state, r.box, todos) }), storeCtx);
  return { ok: true, box: r.box, todos: uiStateStore.todosOf(next, r.box) };
}

/**
 * spip:toggleTodo — 그 박스에서 id의 완료 상태 설정. [T-1] 박스 격리 선행 후 id 형식 검증.
 * @param {object} args { box, id, done }
 * @returns {{ok:true,box,todos} | {ok:false,code:'BAD_INPUT'|'NOT_FOUND'|'INVALID_ID'}}
 */
function toggleTodo(args, ctx) {
  const { store, storeCtx } = resolveStore(ctx);
  const r = readTodoBox(args, store, storeCtx);
  if (r.code) return { ok: false, code: r.code };
  const id = (args && typeof args === 'object') ? args.id : undefined;
  if (typeof id !== 'string' || !uiStateStore.TODO_ID_RE.test(id)) return { ok: false, code: 'INVALID_ID' };
  const done = !!(args && args.done);
  let found = false;
  const todos = uiStateStore.todosOf(r.state, r.box).map((t) => {
    if (t.id === id) { found = true; return Object.assign({}, t, { done }); }
    return t;
  });
  if (!found) return { ok: false, code: 'NOT_FOUND' };
  const next = store.write(Object.assign({}, r.state, { todoBoxes: uiStateStore.withTodos(r.state, r.box, todos) }), storeCtx);
  return { ok: true, box: r.box, todos: uiStateStore.todosOf(next, r.box) };
}

/**
 * spip:removeTodo — 그 박스에서 id 삭제. [T-1] 박스 격리 선행 후 id 형식 검증.
 * @param {object} args { box, id }
 * @returns {{ok:true,box,todos} | {ok:false,code:'BAD_INPUT'|'NOT_FOUND'|'INVALID_ID'}}
 */
function removeTodo(args, ctx) {
  const { store, storeCtx } = resolveStore(ctx);
  const r = readTodoBox(args, store, storeCtx);
  if (r.code) return { ok: false, code: r.code };
  const id = (args && typeof args === 'object') ? args.id : undefined;
  if (typeof id !== 'string' || !uiStateStore.TODO_ID_RE.test(id)) return { ok: false, code: 'INVALID_ID' };
  const cur = uiStateStore.todosOf(r.state, r.box);
  const todos = cur.filter((t) => t.id !== id);
  if (todos.length === cur.length) return { ok: false, code: 'NOT_FOUND' };
  const next = store.write(Object.assign({}, r.state, { todoBoxes: uiStateStore.withTodos(r.state, r.box, todos) }), storeCtx);
  return { ok: true, box: r.box, todos: uiStateStore.todosOf(next, r.box) };
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

// [위젯 인스턴스] setHiddenWidgets 는 제거됐다 — '숨김'이라는 상태가 없어졌다(제거 = 인스턴스 삭제).
//   addWidget/removeWidget/renameWidget 이 그 자리를 대신한다.
module.exports = { getUiState, setFavorite, setOrder, setSortMode, setHomeLayout, addWidget, removeWidget, renameWidget, setHomeWidgetSizes, setProjectName, setTheme, setThemePrefs, setScratchpad, addTodo, toggleTodo, removeTodo, setTodoDue, updateLangTrend, setActivePreset, addPreset, duplicatePreset, renamePreset, removePreset, addTemplatePreset, setLayoutMode, setWidgetPositions, setGroups, exportDashboard, importDashboard, adoptLegacyTodos, firstTodoBox, isPlacedTodoBox };
