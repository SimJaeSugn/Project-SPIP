'use strict';
/**
 * lib/common/uiStateStore.js — UI 상태(즐겨찾기·순서·정렬모드) 저장소 (R-19/R-20, M6-M-4)
 *
 * ui-state.json = { schemaVersion, favorites:[id], order:[id], sortMode:'auto'|'manual' }.
 * GUI 전용(CLI 무관). 손상/부재 시 graceful 빈 상태. 0600 원자적 쓰기.
 *
 * [M6-M-4] read() DoS/손상 방어:
 *   ① 파싱 전 파일 크기 상한(1MB) → 초과 즉시 기본값
 *   ② raw 길이 재확인(symlink·경합 대비)
 *   ③ _safeParse(JSON 깊이/예외 가드, H-3 패턴 재사용) → 실패 시 null
 *   ④ normalizeState로 id 형식·배열 길이 상한·중복 제거·sortMode 화이트리스트·schemaVersion 폴백
 *   어떤 실패든 graceful 빈 상태(DEFAULT_STATE clone), 0600 유지.
 *
 * 외부 의존성 0 — fs, path + 내부(paths). 순수 검증 로직(normalizeState 등)은 fs 없이 단위테스트.
 */

const fs = require('fs');
const path = require('path');
const paths = require('./paths');

const SCHEMA_VERSION = 1;
const MAX_UISTATE_BYTES = 1 * 1024 * 1024; // 1MB 상한(M6-M-4)
const MAX_JSON_DEPTH = 32;
const MAX_FAVORITES = 512;
const MAX_ORDER = 4096; // order는 favorites보다 클 수 있음(전체 카드 순서)
const FILE_MODE = 0o600;

const ID_RE = /^[0-9a-f]{1,64}$/; // 스냅샷 id 형태(경로 해시)
const SORT_MODES = new Set(['auto', 'manual']);

function defaultState() {
  return { schemaVersion: SCHEMA_VERSION, favorites: [], order: [], sortMode: 'auto' };
}

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** 객체/배열 중첩 깊이 가드(H-3 패턴, JSON 폭탄 차단). 명시 스택으로 스택오버플로 회피. */
function depthWithinLimit(value, maxDepth) {
  const stack = [{ v: value, d: 1 }];
  while (stack.length > 0) {
    const { v, d } = stack.pop();
    if (d > maxDepth) return false;
    if (v && typeof v === 'object') {
      if (Array.isArray(v)) {
        for (let i = 0; i < v.length; i++) stack.push({ v: v[i], d: d + 1 });
      } else {
        for (const k in v) {
          if (Object.prototype.hasOwnProperty.call(v, k)) stack.push({ v: v[k], d: d + 1 });
        }
      }
    }
  }
  return true;
}

/** 가드를 거친 JSON 파싱(H-3 ③). 실패 시 null. */
function _safeParse(raw) {
  if (typeof raw !== 'string') return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_) {
    return null;
  }
  if (!depthWithinLimit(parsed, MAX_JSON_DEPTH)) return null;
  return parsed;
}

/** id 배열을 형식 검증·중복 제거·개수 상한 적용. */
function normalizeIdArray(input, maxLen) {
  if (!Array.isArray(input)) return [];
  const out = [];
  const seen = new Set();
  for (const item of input) {
    if (out.length >= maxLen) break;
    if (typeof item !== 'string' || !ID_RE.test(item)) continue;
    if (seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

/**
 * 파싱된 객체(또는 임의 값)를 검증·정규화해 안전한 상태 객체로 만든다.
 * schemaVersion 불일치·잘못된 타입은 폴백. id 형식·길이 상한·중복 제거·sortMode 화이트리스트.
 * @param {*} obj
 * @returns {{schemaVersion:number,favorites:string[],order:string[],sortMode:string}}
 */
function normalizeState(obj) {
  if (!isPlainObject(obj)) return defaultState();
  const favorites = normalizeIdArray(obj.favorites, MAX_FAVORITES);
  const order = normalizeIdArray(obj.order, MAX_ORDER);
  const sortMode = (typeof obj.sortMode === 'string' && SORT_MODES.has(obj.sortMode)) ? obj.sortMode : 'auto';
  return { schemaVersion: SCHEMA_VERSION, favorites, order, sortMode };
}

/**
 * ui-state.json을 읽어 정규화된 상태를 반환한다. 부재/손상/거대/깊은중첩 모두 graceful 빈 상태(M6-M-4).
 * @param {object} [ctx] { logger, uiStatePath?, deps?{fs,paths} }
 * @returns {{schemaVersion:number,favorites:string[],order:string[],sortMode:string}}
 */
function read(ctx) {
  ctx = ctx || {};
  const _fs = (ctx.deps && ctx.deps.fs) || fs;
  const _paths = (ctx.deps && ctx.deps.paths) || paths;
  const file = ctx.uiStatePath || _paths.uiStatePath();
  try {
    const st = _fs.statSync(file);
    if (!st.isFile()) return defaultState();
    if (st.size > MAX_UISTATE_BYTES) return defaultState();   // ① 크기 상한
    const raw = _fs.readFileSync(file, 'utf8');
    if (typeof raw !== 'string' || raw.length > MAX_UISTATE_BYTES) return defaultState(); // ② 길이 재확인
    const obj = _safeParse(raw);                              // ③ 깊이/예외 가드
    if (!isPlainObject(obj)) return defaultState();
    return normalizeState(obj);                              // ④ 정규화 재적용
  } catch (_) {
    return defaultState(); // 부재/손상/권한 → graceful
  }
}

/**
 * 상태 객체를 정규화 후 0600 원자적 쓰기로 영속한다(임시파일→fsync→rename→0600).
 * @param {object} state
 * @param {object} [ctx] { logger, uiStatePath?, deps?{fs,paths} }
 * @returns {{schemaVersion:number,favorites:string[],order:string[],sortMode:string}} 영속된 정규화 상태
 */
function write(state, ctx) {
  ctx = ctx || {};
  const _fs = (ctx.deps && ctx.deps.fs) || fs;
  const _paths = (ctx.deps && ctx.deps.paths) || paths;
  const file = ctx.uiStatePath || _paths.uiStatePath();
  const logger = ctx.logger;

  const normalized = normalizeState(state);
  const body = JSON.stringify(normalized, null, 2);

  const dir = _paths.ensureDirFor(file); // 0700 보장(M-2)
  const tmp = path.join(dir, '.' + path.basename(file) + '.' + process.pid + '.' + Date.now() + '.tmp');

  let fd;
  try {
    fd = _fs.openSync(tmp, 'wx', FILE_MODE);
    _fs.writeFileSync(fd, body, { encoding: 'utf8' });
    try { _fs.fsyncSync(fd); } catch (_) { /* noop */ }
    _fs.closeSync(fd);
    fd = undefined;
    try { _fs.chmodSync(tmp, FILE_MODE); } catch (_) { /* noop */ }
    _fs.renameSync(tmp, file);
    try { _fs.chmodSync(file, FILE_MODE); } catch (_) { /* noop */ }
  } catch (err) {
    if (fd !== undefined) { try { _fs.closeSync(fd); } catch (_) { /* noop */ } }
    try { if (_fs.existsSync(tmp)) _fs.unlinkSync(tmp); } catch (_) { /* noop */ }
    if (logger) logger.error('ui-state 영속화 실패', err);
    throw err;
  }
  return normalized;
}

module.exports = {
  read,
  write,
  normalizeState,
  normalizeIdArray,
  _safeParse,
  depthWithinLimit,
  defaultState,
  SCHEMA_VERSION,
  MAX_UISTATE_BYTES,
  MAX_FAVORITES,
  MAX_ORDER,
  ID_RE,
  SORT_MODES,
  FILE_MODE,
};
