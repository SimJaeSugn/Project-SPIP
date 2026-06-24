'use strict';
/**
 * lib/mail/mailAccounts.js — 메일 계정 레지스트리(복수 IMAP 계정 관리) (toolRegistry 패턴 차용)
 *
 * config.mailAccounts(배열)를 정규화·검증하고, 추가/수정/삭제를 (input)→object 순수 함수로
 * 제공한다. Electron API·네트워크를 import하지 않는 순수 도메인 모듈(헤드리스 단위테스트, F-3).
 *
 * 계정 엔트리 shape(설정 파일에 평문 0600 저장 — 로컬 단일 사용자 모델):
 *   { id, label, host, port, user, pass }
 *
 * 보안:
 *   · user/pass/host에 제어문자·CR/LF/NUL을 금지한다 — IMAP LOGIN은 한 줄 명령이라 CRLF가 섞이면
 *     명령 인젝션이 가능하다(imapQuote가 따옴표만 이스케이프하므로 경계에서 차단한다).
 *   · 렌더러로는 toPublicView로 비밀번호를 제거한 뷰만 노출한다(hasPassword 불리언만).
 *   · 라벨은 제어/방향제어문자 제거·길이 절단(L-2 일관).
 *
 * 외부 의존성 0 — 내부(logger.clampString) + Node 내장 crypto(id 생성, 주입 가능).
 */

const crypto = require('crypto');
const { clampString } = require('../common/logger');

const MAX_ACCOUNTS = 20;
const MAX_HOST_LEN = 255;
const MAX_USER_LEN = 255;
const MAX_PASS_LEN = 512;
const MAX_LABEL_LEN = 64;
const DEFAULT_PORT = 993;

const ID_RE = /^[a-z0-9]{6,32}$/;
// 호스트: 영숫자·점·하이픈만(공백·제어·CRLF 자동 배제). IP/도메인 모두 허용.
const HOST_RE = /^[A-Za-z0-9.\-]{1,255}$/;
// 제어문자(C0·DEL) — user/pass에서 금지(CR/LF/NUL 포함).
const CONTROL_RE = new RegExp('[\\u0000-\\u001F\\u007F]');

/** plain object 여부(배열·null 제외). */
function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** 라벨 정제: 제어문자 제거(공백 치환)·길이 ≤64. 비거나 비문자열이면 fallback. */
function sanitizeLabel(raw, fallback) {
  if (typeof raw !== 'string') return fallback;
  const cleaned = clampString(raw, MAX_LABEL_LEN);
  const trimmed = (typeof cleaned === 'string' ? cleaned : '').trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

/** 호스트 검증 → 정규 문자열 또는 null. */
function validateHost(h) {
  if (typeof h !== 'string') return null;
  const v = h.trim();
  if (!v || v.length > MAX_HOST_LEN || !HOST_RE.test(v)) return null;
  return v;
}

/** 포트 검증 → 1..65535 정수(미지정/빈값은 기본 993) 또는 null. */
function validatePort(p) {
  const n = (p === undefined || p === null || p === '') ? DEFAULT_PORT : Number(p);
  if (!Number.isInteger(n) || n <= 0 || n > 65535) return null;
  return n;
}

/** 사용자 검증 → trim 문자열 또는 null(제어문자/CRLF 금지). */
function validateUser(u) {
  if (typeof u !== 'string') return null;
  const v = u.trim();
  if (!v || v.length > MAX_USER_LEN || CONTROL_RE.test(v)) return null;
  return v;
}

/** 비밀번호 검증 → 문자열 또는 null(앞뒤 공백 유효, 제어문자/CRLF 금지). */
function validatePass(p) {
  if (typeof p !== 'string') return null;
  if (p.length === 0 || p.length > MAX_PASS_LEN || CONTROL_RE.test(p)) return null;
  return p;
}

/**
 * 계정 입력 검증 → { ok:true, fields:{label,host,port,user,pass} } | { ok:false, code }.
 *   code ∈ INVALID_HOST | INVALID_USER | INVALID_PASS | INVALID_PORT
 */
function validateAccountInput(input) {
  input = isPlainObject(input) ? input : {};
  const host = validateHost(input.host);
  if (!host) return { ok: false, code: 'INVALID_HOST' };
  const user = validateUser(input.user);
  if (!user) return { ok: false, code: 'INVALID_USER' };
  const pass = validatePass(input.pass);
  if (!pass) return { ok: false, code: 'INVALID_PASS' };
  const port = validatePort(input.port);
  if (!port) return { ok: false, code: 'INVALID_PORT' };
  const label = sanitizeLabel(input.label, user + '@' + host);
  return { ok: true, fields: { label, host, port, user, pass } };
}

const defaultGenId = () => crypto.randomBytes(6).toString('hex'); // 12 hex chars

/** 고유 id 생성(seen과 충돌 없는 ID_RE 매칭값). genId 주입 가능(테스트). */
function genId(deps, seen) {
  const gen = (deps && typeof deps.genId === 'function') ? deps.genId : defaultGenId;
  for (let i = 0; i < 1000; i++) {
    const id = String(gen());
    if (ID_RE.test(id) && !(seen && seen.has(id))) return id;
  }
  throw new Error('mailAccounts: id 생성 실패');
}

/**
 * config.mailAccounts 정규화(loadConfig가 호출). 잘못된 엔트리는 폐기, 개수 상한·id 중복 보정.
 * @param {*} input 후보 배열
 * @param {object} [deps] { genId } 테스트 주입
 * @returns {Array<{id,label,host,port,user,pass}>}
 */
function normalizeAccounts(input, deps) {
  const out = [];
  if (!Array.isArray(input)) return out;
  const seen = new Set();
  for (const item of input.slice(0, MAX_ACCOUNTS)) {
    if (!isPlainObject(item)) continue;
    const v = validateAccountInput(item);
    if (!v.ok) continue;
    let id = (typeof item.id === 'string' && ID_RE.test(item.id)) ? item.id : null;
    if (!id || seen.has(id)) id = genId(deps, seen);
    seen.add(id);
    out.push(Object.assign({ id }, v.fields));
  }
  return out;
}

/** 계정 추가 → { ok:true, accounts, account } | { ok:false, code }. */
function addAccount(list, input, deps) {
  const accounts = normalizeAccounts(list, deps);
  if (accounts.length >= MAX_ACCOUNTS) return { ok: false, code: 'LIMIT' };
  const v = validateAccountInput(input);
  if (!v.ok) return v;
  const seen = new Set(accounts.map((a) => a.id));
  const account = Object.assign({ id: genId(deps, seen) }, v.fields);
  return { ok: true, accounts: accounts.concat([account]), account };
}

/**
 * 계정 수정 → { ok:true, accounts, account } | { ok:false, code }.
 *   pass를 비우면(미입력) 기존 비밀번호를 유지한다(렌더러는 비번을 받지 못하므로).
 */
function updateAccount(list, id, input, deps) {
  const accounts = normalizeAccounts(list, deps);
  const idx = accounts.findIndex((a) => a.id === id);
  if (idx < 0) return { ok: false, code: 'NOT_FOUND' };
  const existing = accounts[idx];
  const merged = Object.assign({}, isPlainObject(input) ? input : {});
  if (merged.pass === undefined || merged.pass === null || merged.pass === '') merged.pass = existing.pass;
  const v = validateAccountInput(merged);
  if (!v.ok) return v;
  const account = Object.assign({ id: existing.id }, v.fields);
  const next = accounts.slice();
  next[idx] = account;
  return { ok: true, accounts: next, account };
}

/** 계정 삭제 → { ok:true, accounts } | { ok:false, code:'NOT_FOUND' }. */
function removeAccount(list, id, deps) {
  const accounts = normalizeAccounts(list, deps);
  const idx = accounts.findIndex((a) => a.id === id);
  if (idx < 0) return { ok: false, code: 'NOT_FOUND' };
  const next = accounts.slice();
  next.splice(idx, 1);
  return { ok: true, accounts: next };
}

/** 렌더러 노출용 뷰 — 비밀번호 제거, 보유 여부만 노출. */
function toPublicView(a) {
  a = a || {};
  return {
    id: a.id,
    label: typeof a.label === 'string' ? a.label : '',
    host: typeof a.host === 'string' ? a.host : '',
    port: Number.isInteger(a.port) ? a.port : DEFAULT_PORT,
    user: typeof a.user === 'string' ? a.user : '',
    hasPassword: typeof a.pass === 'string' && a.pass.length > 0,
  };
}

/** 계정 배열 → 공개 뷰 배열(비밀번호 제거). */
function toPublicList(list) {
  return (Array.isArray(list) ? list : []).map(toPublicView);
}

module.exports = {
  MAX_ACCOUNTS, MAX_HOST_LEN, MAX_USER_LEN, MAX_PASS_LEN, MAX_LABEL_LEN, DEFAULT_PORT,
  ID_RE, HOST_RE,
  isPlainObject, sanitizeLabel,
  validateHost, validatePort, validateUser, validatePass, validateAccountInput,
  normalizeAccounts, addAccount, updateAccount, removeAccount,
  toPublicView, toPublicList,
};
