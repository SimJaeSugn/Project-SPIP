'use strict';
/**
 * lib/common/mdDocStore.js — 마크다운 편집기 문서 저장소 (MD-1)
 *
 * 마크다운 편집기 위젯의 문서(CRUD) 단일 신뢰 경계. <appDir>/markdown/md-docs.json 에
 * 0600 원자적 쓰기(tmp→fsync→rename)로 영속한다 — uiStateStore.write 와 동일 패턴.
 *
 * ui-state.json 과 분리한 이유: 문서 본문은 UI 상태(즐겨찾기·순서·테마)보다 크고 저장 빈도·수명이
 * 다르다. 한 파일에 섞으면 ① UI 상태 크기 상한을 문서가 잠식하고 ② 한쪽 손상이 다른 쪽을 날린다.
 *
 * 정규화(normalizeDocs)가 **유일한 검증 경계**다 — 렌더러가 보낸 id/제목/본문은 전부 불신하고
 * 여기서 화이트리스트·상한·제어문자 필터를 통과시킨다. id·시각 스탬프는 메인이 만든다(렌더러 주입 불가).
 *
 * 외부 의존성 0 — Node 내장(fs, path, crypto) + 내부(paths, elevationState).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const paths = require('./paths');
const elevationState = require('./elevationState');

const SCHEMA_VERSION = 2;
const FILE_MODE = 0o600; // 소유자 전용(M-2)

// 상한 — 조용한 절단 대신 호출부가 코드(LIMIT_DOCS / LIMIT_SIZE)로 거절한다.
const MAX_DOCS = 200;          // 문서 수(문서함 1개당)
const MAX_BOXES = 64;          // 문서함 수 — 편집기 위젯 인스턴스 수의 상한(파일 크기 방어)
const MAX_TITLE = 120;         // 제목 문자수
const MAX_BODY = 400000;       // 본문 문자수(≈400KB) — 일반 README·문서엔 충분
const MAX_FILE = 8 * 1024 * 1024; // 저장 파일 전체 상한(읽기 시 방어)

const ID_RE = /^d[0-9a-f]{12}$/;
// 문서함 키 = 편집기 위젯 인스턴스 id(iid). uiStateStore.IID_RE 와 동형 —
//   여기서 직접 정의해 저장소가 UI 상태 모듈에 의존하지 않게 한다(드리프트 시 양쪽 테스트가 잡는다).
const BOX_RE = /^[a-z][a-zA-Z0-9]{0,31}$/;

/* ───── 정규화(단일 검증 경계) ───── */

function isPlainObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }

/** 새 문서 id — 메인만 생성한다(렌더러가 보낸 id 로 새 문서를 만들 수 없게). */
function newId() {
  return 'd' + crypto.randomBytes(6).toString('hex');
}

/**
 * 제목 정제 — 개행 금지(한 줄), 제어문자 제거, 길이 상한. 빈 제목은 호출부가 폴백한다.
 * @param {*} v
 * @returns {string}
 */
function sanitizeTitle(v) {
  if (typeof v !== 'string') return '';
  return Array.from(v)
    .filter((ch) => {
      const c = ch.charCodeAt(0);
      return c >= 32 && c !== 127; // 개행·탭도 제목에선 제거(단일 행)
    })
    .join('')
    .trim()
    .slice(0, MAX_TITLE);
}

/**
 * 본문 정제 — 개행·탭은 보존(마크다운의 의미), 그 외 제어문자 제거, 길이 상한.
 *   본문은 렌더 시 textContent 로만 들어가므로(L-1) 여기서 HTML 이스케이프는 하지 않는다.
 * @param {*} v
 * @returns {string}
 */
function sanitizeBody(v) {
  if (typeof v !== 'string') return '';
  return Array.from(v)
    .filter((ch) => {
      const c = ch.charCodeAt(0);
      return c === 9 || c === 10 || (c >= 32 && c !== 127); // 탭·개행 보존
    })
    .join('')
    .slice(0, MAX_BODY);
}

/** 시각 스탬프 정규화 — 유한 양의 정수만, 그 외 null. */
function normalizeTs(v) {
  return (typeof v === 'number' && Number.isFinite(v) && v > 0) ? Math.floor(v) : null;
}

/**
 * 문서 1건 정규화. id 가 형식에 맞지 않으면 null(제거 대상).
 * @param {*} input
 * @returns {{id:string,title:string,body:string,createdAt:number|null,updatedAt:number|null}|null}
 */
function normalizeDoc(input) {
  if (!isPlainObject(input)) return null;
  const id = (typeof input.id === 'string' && ID_RE.test(input.id)) ? input.id : null;
  if (!id) return null;
  return {
    id,
    title: sanitizeTitle(input.title),
    body: sanitizeBody(input.body),
    createdAt: normalizeTs(input.createdAt),
    updatedAt: normalizeTs(input.updatedAt),
  };
}

/**
 * 문서 배열 정규화 — 손상 항목 제거, id 중복 제거, 개수 상한(초과분은 뒤에서 버림).
 *   비배열/손상 입력은 빈 배열(graceful).
 * @param {*} input
 * @returns {object[]}
 */
function normalizeDocs(input) {
  const out = [];
  const seen = new Set();
  if (Array.isArray(input)) {
    for (const raw of input) {
      const doc = normalizeDoc(raw);
      if (!doc || seen.has(doc.id)) continue;
      seen.add(doc.id);
      out.push(doc);
      if (out.length >= MAX_DOCS) break;
    }
  }
  return out;
}

/**
 * 문서함 맵 정규화 — { [iid]: Doc[] }. 키 형식 불량은 제거, 문서함 수·문서 수 상한 적용.
 * @param {*} input
 * @returns {Object<string, object[]>}
 */
function normalizeBoxes(input) {
  const out = {};
  if (!isPlainObject(input)) return out;
  let n = 0;
  for (const key of Object.keys(input)) {
    if (!BOX_RE.test(key)) continue;         // 키(iid) 형식 화이트리스트
    if (n >= MAX_BOXES) break;
    out[key] = normalizeDocs(input[key]);
    n++;
  }
  return out;
}

/**
 * 저장 상태 전체 정규화 — write 가 통과시키는 유일한 경로.
 *
 * [v2 — 위젯 인스턴스별 문서함] 문서는 편집기 위젯 **인스턴스(iid)** 별로 갈린다:
 *   { schemaVersion: 2, boxes: { <iid>: Doc[] }, legacy: Doc[] }
 * v1({ docs: [...] })은 전역 문서함 하나였다 — 그 문서들은 `legacy` 로 옮겨 두고, 첫 편집기
 * 인스턴스가 자기 문서함으로 흡수한다(ipc/markdown.js adoptLegacy). 흡수 전까지 유실 없이 보존된다.
 */
function normalizeState(input) {
  const o = isPlainObject(input) ? input : {};
  // v1 이행: 최상위 docs 배열은 아직 어느 인스턴스의 것도 아니다 → legacy 로.
  const legacy = Array.isArray(o.docs) ? normalizeDocs(o.docs) : normalizeDocs(o.legacy);
  return { schemaVersion: SCHEMA_VERSION, boxes: normalizeBoxes(o.boxes), legacy };
}

function defaultState() {
  return { schemaVersion: SCHEMA_VERSION, boxes: {}, legacy: [] };
}

/** 문서함(iid)의 문서 목록 — 없으면 빈 배열. */
function docsOf(state, box) {
  const boxes = (state && isPlainObject(state.boxes)) ? state.boxes : {};
  return Array.isArray(boxes[box]) ? boxes[box] : [];
}

/** 문서함(iid)만 교체한 새 상태(불변) — 다른 인스턴스의 문서함은 그대로 둔다. */
function withDocs(state, box, docs) {
  const next = {
    schemaVersion: SCHEMA_VERSION,
    boxes: Object.assign({}, (state && state.boxes) || {}),
    legacy: (state && Array.isArray(state.legacy)) ? state.legacy : [],
  };
  next.boxes[box] = docs;
  return next;
}

/* ───── 영속 ───── */

/**
 * 저장 파일을 읽어 정규화 상태를 돌려준다. 부재·손상·과대 파일은 기본 상태(graceful).
 * @param {object} [ctx] { logger, mdDocsPath?, deps?{fs,paths} }
 */
function read(ctx) {
  ctx = ctx || {};
  const _fs = (ctx.deps && ctx.deps.fs) || fs;
  const _paths = (ctx.deps && ctx.deps.paths) || paths;
  const file = ctx.mdDocsPath || _paths.mdDocsPath();
  const logger = ctx.logger;

  let raw;
  try {
    const st = _fs.statSync(file);
    if (st.size > MAX_FILE) {
      if (logger) logger.warn('md-docs 파일이 상한을 초과 — 기본값 사용');
      return defaultState();
    }
    raw = _fs.readFileSync(file, 'utf8');
  } catch (_) {
    return defaultState(); // 최초 실행 등 — 파일 부재는 정상
  }

  try {
    return normalizeState(JSON.parse(raw));
  } catch (err) {
    if (logger) logger.warn('md-docs 파싱 실패 — 기본값 사용');
    return defaultState();
  }
}

/**
 * 정규화 후 0600 원자적 쓰기(tmp→fsync→rename→0600). uiStateStore.write 와 동형.
 *
 * [M12 b3] 상승 세션이면 디스크 write 를 no-op 한다 — 사용자 문서가 관리자 프로필에 떨어지지 않게.
 *   정규화된 메모리 결과는 그대로 반환한다.
 *
 * @param {object} state
 * @param {object} [ctx] { logger, mdDocsPath?, deps?{fs,paths,elevationState} }
 * @returns {object} 영속된 정규화 상태
 */
function write(state, ctx) {
  ctx = ctx || {};
  const _fs = (ctx.deps && ctx.deps.fs) || fs;
  const _paths = (ctx.deps && ctx.deps.paths) || paths;
  const _elev = (ctx.deps && ctx.deps.elevationState) || elevationState;
  const file = ctx.mdDocsPath || _paths.mdDocsPath();
  const logger = ctx.logger;

  const normalized = normalizeState(state);

  if (_elev.isElevated()) {
    if (logger) logger.warn('상승 세션 — md-docs 디스크 저장 보류(메모리 유지)');
    return normalized;
  }

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
    if (logger) logger.error('md-docs 영속화 실패', err);
    throw err;
  }
  return normalized;
}

module.exports = {
  read,
  write,
  normalizeState,
  normalizeBoxes,
  normalizeDocs,
  normalizeDoc,
  sanitizeTitle,
  sanitizeBody,
  defaultState,
  docsOf,
  withDocs,
  newId,
  SCHEMA_VERSION,
  MAX_DOCS,
  MAX_BOXES,
  MAX_TITLE,
  MAX_BODY,
  ID_RE,
  BOX_RE,
};
