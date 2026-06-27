'use strict';
/**
 * electron/ipc/shelf.js — 즐겨찾기 셸프 위젯 IPC 핸들러 (SH-2)
 *
 * 채널(register.js guard 경유): spip:shelf:list/add/remove/reorder/open/refresh/getSettings/setSettings.
 * 계약 정본: docs/api-contract.md §"즐겨찾기 셸프 위젯 — IPC 계약". 렌더러 비신뢰 — main이 전부 재검증.
 *
 * 범위: folder/file(localMeta)·url(urlMeta 크롤·SSRF·og, SH-3) 추가·메타수집·열기·재수집 + 자동
 *   재크롤 토글(SH-4).
 *
 * 보안·정합 불변식:
 *   - 경로(H-1/H-2): folder/file은 add·open 양쪽에서 pathPolicy.gate(canonicalize+deny 재게이트).
 *       열기는 절대경로·shell:false·인자 [real] 고정(safeExec). file=OS 기본앱(shell.openPath),
 *       folder=VS Code(safeExec, 도구 미설정 시 openPath 폴백), url=shell.openExternal(http/https 재검증).
 *   - 영속(L-3/0600): uiStateStore.read/write 재사용(정규화·상한·0600·상승세션 보류).
 *   - [D-1] 변이 원자성: 모든 read-modify-write는 withWriteLock으로 직렬화하고, 느린 크롤은 락 밖에서
 *       수행 후 write 직전 최신 상태를 재-read해 id 기준 머지한다(동시 refresh/add/remove의 stale write
 *       클로버·lost-update·삭제 항목 부활·LIMIT 우회 차단).
 *   - id/createdAt는 main이 스탬프(렌더러 시각 비신뢰). 고정 에러코드만 반환(내부정보 비노출).
 *
 * 외부 의존성 0 — Node 내장(crypto, fs) + 내부 모듈. Electron(shell)·safeExec/resolveBin은
 *   ctx로 주입 가능(헤드리스 단위테스트). 기본은 실제 모듈.
 */

const crypto = require('crypto');
const fs = require('fs');
const uiStateStore = require('../../lib/common/uiStateStore');
const detectType = require('../../lib/shelf/detectType');
const pathPolicy = require('../../lib/shelf/pathPolicy');
const localMeta = require('../../lib/shelf/localMeta');
const urlMeta = require('../../lib/shelf/urlMeta');
const imageCache = require('../../lib/shelf/imageCache');
const config = require('../../lib/common/config');
const toolRegistry = require('../../lib/common/toolRegistry');
const { resolveBin, safeExec } = require('../../lib/common/safeExec');

const MAX_REF_LEN = 4096; // 입력 ref 1차 상한(정규화 경계와 동일)
const MAX_INFLIGHT_OPEN = 2; // id별 열기 in-flight 상한(M-4)

/** ctx에서 uiState 읽기(주입 가능 deps 우회 없이 uiStatePath만 전달). */
function readState(ctx) {
  return uiStateStore.read({ uiStatePath: ctx && ctx.uiStatePath, logger: ctx && ctx.logger });
}

/** ctx로 uiState 쓰기(정규화 후 반환). */
function writeState(state, ctx) {
  return uiStateStore.write(state, { uiStatePath: ctx && ctx.uiStatePath, logger: ctx && ctx.logger });
}

// [D-1] 셸프 변이 직렬화 큐 — 동일 ui-state 파일에 대한 read-modify-write를 순차 실행한다.
//   동시 refresh/add/remove가 같은 스냅샷을 읽고 stale 전체배열을 write해 서로 클로버하던 결함 차단.
//   fn은 최신 상태를 락 안에서 재-read한 뒤 변이·write하는 동기 함수다(느린 크롤은 호출 전 락 밖에서 완료).
const _writeChains = new Map();
function withWriteLock(ctx, fn) {
  const key = (ctx && ctx.uiStatePath) || '__default__';
  const prev = _writeChains.get(key) || Promise.resolve();
  const run = prev.then(() => fn());
  _writeChains.set(key, run.then(() => {}, () => {})); // 체인 지속(한 변이 실패가 다음을 막지 않음)
  return run;
}

/** 'b'+16hex 형식 id 생성(crypto.randomBytes — 렌더러 시각 비신뢰). */
function genId() {
  return 'b' + crypto.randomBytes(8).toString('hex');
}

/**
 * 저장 형태(bannerKey 보유) → 응답 뷰(bannerImage 부착).
 *   url 항목은 imageCache.toDataUri(bannerKey)로 og:image data:URI를 붙이고(ADR-SH-1/2),
 *   키가 없거나 캐시 미스면 null(그라데이션 폴백). folder/file은 bannerKey 없음 → null.
 */
function toView(bm, ctx) {
  let bannerImage = null;
  if (bm.bannerKey) {
    try { bannerImage = imageCache.toDataUri(bm.bannerKey, ctx); } catch (_) { bannerImage = null; }
  }
  return {
    id: bm.id,
    type: bm.type,
    ref: bm.ref,
    // 사용자 지정 책 제목이 있으면 우선. 없으면 크롤/스캔 name. customName은 편집 입력 prefill용으로 동봉.
    name: bm.customName || bm.name,
    customName: bm.customName || '',
    title: bm.title,
    sub: bm.sub,
    desc: bm.desc,
    color: bm.color,
    mono: bm.mono,
    cat: bm.cat,
    status: bm.status,
    bannerImage,
    lastChecked: bm.lastChecked,
    addedAt: bm.addedAt,
  };
}

/** add 인자 sanitize — { type, ref } 문자열만. */
function sanitizeAddArgs(args) {
  const a = (args && typeof args === 'object' && !Array.isArray(args)) ? args : {};
  const type = typeof a.type === 'string' ? a.type : '';
  let ref = typeof a.ref === 'string' ? a.ref.trim() : '';
  if (ref.length > MAX_REF_LEN) ref = '';
  return { type, ref };
}

/** id 인자 sanitize — 형식 검증된 셸프 id 또는 null. */
function sanitizeId(args) {
  const a = (args && typeof args === 'object' && !Array.isArray(args)) ? args : {};
  const id = a.id;
  return (typeof id === 'string' && uiStateStore.SHELF_ID_RE.test(id)) ? id : null;
}

/**
 * spip:shelf:list — 전체 북마크 뷰. 실패는 graceful({ok:true,bookmarks:[]}).
 */
function list(_args, ctx) {
  try {
    const state = readState(ctx);
    // [SH-4] autoRefresh 토글값 동봉(프론트 초기 상태 1회 적재 — 별도 getSettings도 제공).
    return { ok: true, bookmarks: state.shelfBookmarks.map((b) => toView(b, ctx)), autoRefresh: getAutoRefresh(ctx) };
  } catch (_) {
    return { ok: true, bookmarks: [], autoRefresh: getAutoRefresh(ctx) };
  }
}

/** [SH-4] 자동 재크롤 토글 현재값(config.shelfAutoRefresh, 기본 true). */
function getAutoRefresh(ctx) {
  return !(ctx && ctx.config && ctx.config.shelfAutoRefresh === false);
}

/** spip:shelf:getSettings — 셸프 설정(자동 재크롤 토글) 조회. */
function getSettings(_args, ctx) {
  return { ok: true, autoRefresh: getAutoRefresh(ctx) };
}

/**
 * spip:shelf:setSettings — 자동 재크롤 토글 변경. boolean만 허용. config 영속(persistConfigKeys).
 *   ctx.config(라이브 객체)를 즉시 갱신해 스케줄러 tick이 다음 주기부터 반영. 영속 실패는 메모리 유지.
 */
function setSettings(args, ctx) {
  const a = (args && typeof args === 'object' && !Array.isArray(args)) ? args : {};
  if (typeof a.autoRefresh !== 'boolean') return { ok: false, code: 'BAD_INPUT' };
  const val = a.autoRefresh;
  if (ctx && ctx.config) ctx.config.shelfAutoRefresh = val; // 라이브 반영(스케줄러 isEnabled가 즉시 읽음)
  try {
    config.persistConfigKeys({ shelfAutoRefresh: val }, { logger: ctx && ctx.logger, configPath: ctx && ctx.configPath });
  } catch (_) { /* 영속 실패 — 메모리 반영은 유지 */ }
  return { ok: true, autoRefresh: val };
}

/**
 * [D-1] url 추가의 원자적 append — 느린 크롤은 호출 전(락 밖)에 끝내고, 여기서 withWriteLock으로
 *   최신 상태를 재-read해 상한을 재확인한 뒤 append·write한다(동시 add의 lost-update·LIMIT 우회 차단).
 *   spec: { type, ref, bannerKey, meta, lastChecked }.
 */
function appendBookmark(spec, ctx) {
  return withWriteLock(ctx, () => {
    const state = readState(ctx);
    if (state.shelfBookmarks.length >= uiStateStore.MAX_SHELF) return { ok: false, code: 'LIMIT' };
    const id = genId();
    const bm = Object.assign({
      id,
      type: spec.type,
      ref: spec.ref,
      bannerKey: spec.bannerKey || null,
      lastChecked: spec.lastChecked != null ? spec.lastChecked : null,
      addedAt: Date.now(),
    }, spec.meta || {});
    // 핵심 식별 필드는 meta에 덮이지 않도록 후행 보정(meta는 표시 필드만 보유).
    bm.id = id;
    bm.type = spec.type;
    bm.ref = spec.ref;
    bm.bannerKey = spec.bannerKey || null;
    bm.lastChecked = spec.lastChecked != null ? spec.lastChecked : null;
    const next = Object.assign({}, state, { shelfBookmarks: state.shelfBookmarks.concat([bm]) });
    const written = writeState(next, ctx);
    const stored = written.shelfBookmarks.find((b) => b.id === id);
    if (!stored) return { ok: false, code: 'INTERNAL' };
    return { ok: true, bookmark: toView(stored, ctx) };
  });
}

/**
 * spip:shelf:add — 북마크 추가. ① type 화이트리스트 ② detectType 재확인 ③ url→urlMeta 크롤(SSRF·og, SH-3) /
 *   folder·file→pathPolicy 게이트+fs.stat 유형보정+localMeta ④ 정규화 영속 ⑤ 상한 초과=LIMIT.
 */
async function add(args, ctx) {
  const { type, ref } = sanitizeAddArgs(args);
  if (!uiStateStore.SHELF_TYPES.has(type)) return { ok: false, code: 'UNSUPPORTED_TYPE' };
  if (!ref) return { ok: false, code: 'BAD_INPUT' };

  // detectType 재확인(권위 검증은 아래 fs.stat / urlMeta). 감지 불가는 거부.
  const detected = detectType.detectType(ref);
  if (!detected) return { ok: false, code: 'BAD_INPUT' };

  if (type === 'url') {
    // SH-3: scheme/자격/길이 1차 검증 → (조기 LIMIT, egress 회피) → urlMeta 크롤(락 밖·동시 허용) →
    //   락 안에서 최신 상태 재-read·상한 재확인·append(D-1 원자성).
    const v = config.validateHttpUrl(ref);
    if (!v.ok) return { ok: false, code: 'BAD_INPUT' };
    if (readState(ctx).shelfBookmarks.length >= uiStateStore.MAX_SHELF) return { ok: false, code: 'LIMIT' };
    const res = await urlMeta.crawl(v.value, ctx);
    if (!res.ok) return { ok: false, code: res.code }; // BLOCKED_HOST/CRAWL_FAILED/BAD_INPUT
    return appendBookmark({ type: 'url', ref: v.value, bannerKey: res.bannerKey || null, meta: res.meta, lastChecked: Date.now() }, ctx);
  }

  // folder/file: 경로처럼 보이지 않으면(=url로 감지) 거부.
  if (detected === 'url') return { ok: false, code: 'BAD_INPUT' };

  // H-1: canonicalize + 민감/시스템 경로 deny 재게이트.
  const g = pathPolicy.gate(ref);
  if (!g.ok) return { ok: false, code: g.code };
  const real = g.real;

  // 권위 유형 보정 — fs.stat으로 folder/file 결정(요청 type와 불일치해도 실제 유형 채택).
  let st;
  try { st = fs.statSync(real); } catch (_) { return { ok: false, code: 'PATH_GONE' }; }
  let actualType;
  if (st.isDirectory()) actualType = 'folder';
  else if (st.isFile()) actualType = 'file';
  else return { ok: false, code: 'PATH_GONE' };

  const meta = localMeta.collect(real, actualType);

  const state = readState(ctx);
  if (state.shelfBookmarks.length >= uiStateStore.MAX_SHELF) return { ok: false, code: 'LIMIT' };

  const id = genId();
  const bm = Object.assign({
    id,
    type: actualType,
    ref: real, // 실경로 저장(표시는 meta.sub로 tidy)
    bannerKey: null,
    lastChecked: null,
    addedAt: Date.now(),
  }, meta);

  const next = Object.assign({}, state, { shelfBookmarks: state.shelfBookmarks.concat([bm]) });
  const written = writeState(next, ctx);
  const stored = written.shelfBookmarks.find((b) => b.id === id);
  if (!stored) return { ok: false, code: 'INTERNAL' };
  return { ok: true, bookmark: toView(stored, ctx) };
}

/** rename 인자 sanitize — { name } 문자열만(없으면 null). */
function sanitizeName(args) {
  const a = (args && typeof args === 'object' && !Array.isArray(args)) ? args : {};
  return typeof a.name === 'string' ? a.name : null;
}

/**
 * spip:shelf:rename — 책 제목(스파인 표시명) 사용자 지정. customName만 갱신하므로 원본 name·메타는
 *   불변이고 refresh가 덮어쓰지 않는다. 빈 문자열이면 사용자 지정 해제(크롤/스캔 name으로 복귀).
 *   [D-1] withWriteLock으로 최신 상태 재-read 후 머지·write(동시 변이와 stale write 차단).
 */
function rename(args, ctx) {
  const id = sanitizeId(args);
  if (!id) return { ok: false, code: 'BAD_INPUT' };
  const raw = sanitizeName(args);
  if (raw == null) return { ok: false, code: 'BAD_INPUT' };
  const name = raw.trim(); // 길이 상한·제어문자 정리는 uiStateStore가 영속 시 재적용
  return withWriteLock(ctx, () => {
    const state = readState(ctx);
    const idx = state.shelfBookmarks.findIndex((b) => b.id === id);
    if (idx < 0) return { ok: false, code: 'NOT_FOUND' };
    const nextArr = state.shelfBookmarks.slice();
    nextArr[idx] = Object.assign({}, state.shelfBookmarks[idx], { customName: name });
    const written = writeState(Object.assign({}, state, { shelfBookmarks: nextArr }), ctx);
    const stored = written.shelfBookmarks.find((b) => b.id === id);
    if (!stored) return { ok: false, code: 'INTERNAL' };
    return { ok: true, bookmark: toView(stored, ctx) };
  });
}

/**
 * spip:shelf:remove — id로 항목 제거 후 영속. 없으면 NOT_FOUND.
 */
function remove(args, ctx) {
  const id = sanitizeId(args);
  if (!id) return { ok: false, code: 'BAD_INPUT' };
  const state = readState(ctx);
  if (!state.shelfBookmarks.some((b) => b.id === id)) return { ok: false, code: 'NOT_FOUND' };
  const next = Object.assign({}, state, { shelfBookmarks: state.shelfBookmarks.filter((b) => b.id !== id) });
  const written = writeState(next, ctx);
  // 제거된 항목의 og:image 캐시 GC(미참조 정리).
  try {
    const refKeys = written.shelfBookmarks.map((b) => b.bannerKey).filter(Boolean);
    imageCache.gc(refKeys, ctx);
  } catch (_) { /* noop */ }
  return { ok: true, bookmarks: written.shelfBookmarks.map((b) => toView(b, ctx)) };
}

/**
 * spip:shelf:reorder — 현존 id의 순열만 채택(외래/누락 무시). 누락 항목은 원순서로 뒤에 보존(유실 방지).
 */
function reorder(args, ctx) {
  const a = (args && typeof args === 'object' && !Array.isArray(args)) ? args : {};
  const ids = Array.isArray(a.ids) ? a.ids : [];
  const state = readState(ctx);
  const byId = new Map(state.shelfBookmarks.map((b) => [b.id, b]));
  const out = [];
  const seen = new Set();
  for (const rawId of ids) {
    const id = typeof rawId === 'string' ? rawId : null;
    if (id && byId.has(id) && !seen.has(id)) { seen.add(id); out.push(byId.get(id)); }
  }
  for (const b of state.shelfBookmarks) if (!seen.has(b.id)) out.push(b); // 누락분 원순서 보존
  writeState(Object.assign({}, state, { shelfBookmarks: out }), ctx);
  return { ok: true };
}

/**
 * spip:shelf:open — id 역참조 → type 분기. 열기 시점 재게이트.
 *   url=shell.openExternal(http/https 재검증) / file=shell.openPath(OS 기본앱) /
 *   folder=safeExec(VS Code, H-2, 인자 [real] 고정), 도구 미설정 시 shell.openPath 폴백.
 */
async function open(args, ctx) {
  const id = sanitizeId(args);
  if (!id) return { ok: false, code: 'BAD_INPUT' };
  const shell = ctx && ctx.shell;
  const state = readState(ctx);
  const bm = state.shelfBookmarks.find((b) => b.id === id);
  if (!bm) return { ok: false, code: 'NOT_FOUND' };

  if (bm.type === 'url') {
    const v = config.validateHttpUrl(bm.ref); // 임의 스킴 차단(javascript:·file: 등)
    if (!v.ok) return { ok: false, code: 'BAD_INPUT' };
    if (!shell || typeof shell.openExternal !== 'function') return { ok: false, code: 'INTERNAL' };
    try { await shell.openExternal(v.value); return { ok: true, code: 'OPENING' }; }
    catch (_) { return { ok: false, code: 'OPEN_FAILED' }; }
  }

  // folder/file: 재-canonicalize + deny 재게이트(TOCTOU 축소).
  const g = pathPolicy.gate(bm.ref);
  if (!g.ok) return { ok: false, code: g.code };
  const real = g.real;

  // 유형 재확인(저장 후 변동 대비).
  let st;
  try { st = fs.statSync(real); } catch (_) { return { ok: false, code: 'PATH_GONE' }; }
  const actualType = st.isDirectory() ? 'folder' : (st.isFile() ? 'file' : null);
  if (!actualType) return { ok: false, code: 'PATH_GONE' };

  if (actualType === 'file') {
    if (!shell || typeof shell.openPath !== 'function') return { ok: false, code: 'INTERNAL' };
    try {
      const err = await shell.openPath(real); // 성공=빈 문자열
      if (err) return { ok: false, code: 'OPEN_FAILED' };
      return { ok: true, code: 'OPENING' };
    } catch (_) { return { ok: false, code: 'OPEN_FAILED' }; }
  }

  // folder → VS Code(safeExec, 인자 [real] 고정). 도구 미설정/실패 시 OS 기본앱 폴백.
  const rb = (ctx && typeof ctx.resolveBin === 'function') ? ctx.resolveBin : resolveBin;
  const exec = (ctx && typeof ctx.safeExec === 'function') ? ctx.safeExec : safeExec;
  const cfg = (ctx && ctx.config) || {};
  const r = toolRegistry.resolveTool('code', cfg, { resolveBin: rb });
  if (r && r.bin) {
    try {
      await exec(r.bin, [real], { shell: false, detached: true, inflightKey: 'shelf-open:' + id, maxInflight: MAX_INFLIGHT_OPEN });
      return { ok: true, code: 'OPENING' };
    } catch (_) { /* 폴백으로 진행 */ }
  }
  if (shell && typeof shell.openPath === 'function') {
    try {
      const err = await shell.openPath(real);
      if (!err) return { ok: true, code: 'OPENING' };
    } catch (_) { /* noop */ }
  }
  return { ok: false, code: 'OPEN_FAILED' };
}

/**
 * spip:shelf:refresh — 단건 재수집(메타·lastChecked 갱신) 후 영속. url=urlMeta 재크롤(SH-3).
 */
async function refresh(args, ctx) {
  const id = sanitizeId(args);
  if (!id) return { ok: false, code: 'BAD_INPUT' };
  // 락 밖에서 현재 대상 확인 후 느린 재수집(크롤/스캔)을 수행 — 응답 메타 patch만 만든다.
  const snap = readState(ctx);
  const cur = snap.shelfBookmarks.find((b) => b.id === id);
  if (!cur) return { ok: false, code: 'NOT_FOUND' };

  let patch;
  if (cur.type === 'url') {
    // SH-3: 재크롤(동일 SSRF·og 게이트). ref(저장된 검증 URL)로 재진입.
    const res = await urlMeta.crawl(cur.ref, ctx);
    if (!res.ok) return { ok: false, code: res.code };
    patch = Object.assign({}, res.meta, { type: 'url', ref: cur.ref, bannerKey: res.bannerKey || null, lastChecked: Date.now() });
  } else {
    const g = pathPolicy.gate(cur.ref);
    if (!g.ok) return { ok: false, code: g.code };
    const real = g.real;
    let st;
    try { st = fs.statSync(real); } catch (_) { return { ok: false, code: 'PATH_GONE' }; }
    const actualType = st.isDirectory() ? 'folder' : (st.isFile() ? 'file' : null);
    if (!actualType) return { ok: false, code: 'PATH_GONE' };
    const meta = localMeta.collect(real, actualType);
    patch = Object.assign({}, meta, { type: actualType, ref: real, lastChecked: Date.now() });
  }

  // [D-1] write 직전 락 안에서 최신 상태를 재-read해 id로 머지한다. 그새 remove됐으면 부활시키지
  //   않고 NOT_FOUND. 동시 refresh/scheduler가 같은 stale 배열을 write해 서로 클로버하던 결함 차단.
  return withWriteLock(ctx, () => {
    const state = readState(ctx);
    const idx = state.shelfBookmarks.findIndex((b) => b.id === id);
    if (idx < 0) return { ok: false, code: 'NOT_FOUND' };
    const nextArr = state.shelfBookmarks.slice();
    nextArr[idx] = Object.assign({}, state.shelfBookmarks[idx], patch);
    const written = writeState(Object.assign({}, state, { shelfBookmarks: nextArr }), ctx);
    const stored = written.shelfBookmarks.find((b) => b.id === id);
    if (!stored) return { ok: false, code: 'INTERNAL' };
    return { ok: true, bookmark: toView(stored, ctx) };
  });
}

module.exports = { list, add, remove, rename, reorder, open, refresh, getSettings, setSettings, getAutoRefresh, sanitizeAddArgs, sanitizeId, sanitizeName, toView, genId };
