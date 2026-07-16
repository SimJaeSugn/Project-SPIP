'use strict';
/**
 * lib/ai/briefingConnections.js — 복수 AI(브리핑) 연결 레지스트리 (mailAccounts 패턴 차용)
 *
 * config.briefingConnections(배열)를 정규화·검증하고, 추가/수정/삭제를 (input)→object 순수 함수로
 * 제공한다. Electron API·네트워크·config를 import하지 않는 순수 도메인 모듈(헤드리스 단위테스트, F-3).
 *
 * 연결 엔트리 shape(설정 파일에 평문 0600 저장 — 로컬 단일 사용자 모델):
 *   { id, label, baseURL, model, apiKey, systemPrompt, temperature, maxTokens, timeoutMs, advanced }
 *   ※ enabled(브리핑 on/off)는 **전역**이라 연결 엔트리에는 두지 않는다 — config.briefing.enabled 단독.
 *
 * 설계 핵심 — **활성 연결 ↔ config.briefing 미러 불변식**:
 *   config.briefing 은 항상 "활성 연결의 실효 설정(+전역 enabled)"이다. 이렇게 두면 llmClient·
 *   브리핑 오케스트레이터·에이전트 등 기존의 모든 `config.briefing` 라이브 리더가 그대로 활성 연결을
 *   사용한다(재배선 0). resolveState()가 이 불변식을 강제하고, 최초/레거시(연결 목록 없음)일 땐 기존
 *   briefing 을 첫 연결로 승격해 무손실 이행한다.
 *
 * 보안:
 *   · apiKey 는 평문 0600 저장(브리핑·메일 계정과 동일 로컬 모델). 렌더러엔 toPublicView 로 hasApiKey 만.
 *   · 라벨은 제어/방향제어문자 제거·길이 절단(clampString, L-2 일관).
 *   · LLM 필드(baseURL M-1 검증 등) 정규화는 **주입된 normalizeSettings**(= config.normalizeBriefing)에
 *     위임한다 — 단일 검증 경계 유지(드리프트 0) + config 순환 의존 회피.
 *
 * 외부 의존성 0 — 내부(logger.clampString) + Node 내장 crypto(id 생성, 주입 가능).
 */

const crypto = require('crypto');
const { clampString } = require('../common/logger');

const MAX_CONNECTIONS = 12;
const MAX_LABEL_LEN = 64;
const ID_RE = /^[a-z0-9]{6,32}$/;

/** plain object 여부(배열·null 제외). */
function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** 라벨 정제: 제어문자 제거·길이 ≤64. 비거나 비문자열이면 fallback. */
function sanitizeLabel(raw, fallback) {
  if (typeof raw !== 'string') return fallback;
  const cleaned = clampString(raw, MAX_LABEL_LEN);
  const trimmed = (typeof cleaned === 'string' ? cleaned : '').trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

const defaultGenId = () => crypto.randomBytes(6).toString('hex'); // 12 hex chars

/** 고유 id 생성(seen과 충돌 없는 ID_RE 매칭값). genId 주입 가능(테스트). */
function genId(deps, seen) {
  const gen = (deps && typeof deps.genId === 'function') ? deps.genId : defaultGenId;
  for (let i = 0; i < 1000; i++) {
    const id = String(gen());
    if (ID_RE.test(id) && !(seen && seen.has(id))) return id;
  }
  throw new Error('briefingConnections: id 생성 실패');
}

/** LLM 필드 정규화 — 주입된 normalizeSettings(config.normalizeBriefing) 위임. 미주입 시 원본 보존(방어). */
function normSettings(deps, input) {
  if (deps && typeof deps.normalizeSettings === 'function') return deps.normalizeSettings(input) || {};
  return isPlainObject(input) ? input : {};
}

/**
 * 연결 1건 정규화 — LLM 필드는 normalizeSettings에 위임(enabled 제거), id/label 부여.
 * @param {*} input 원본(라벨·id 포함 가능)
 * @param {object} deps { normalizeSettings, genId }
 * @param {object} [opts] { fallbackLabel, id }
 */
function normalizeConnection(input, deps, opts) {
  opts = opts || {};
  const src = isPlainObject(input) ? input : {};
  const s = normSettings(deps, src);
  const fields = Object.assign({}, s);
  delete fields.enabled; // enabled 는 전역(briefing)만 관리 — 연결 엔트리에서 제거
  const label = sanitizeLabel(src.label, opts.fallbackLabel || 'AI 연결');
  const id = (typeof src.id === 'string' && ID_RE.test(src.id)) ? src.id : (opts.id || null);
  return Object.assign({ id, label }, fields);
}

/**
 * config.briefingConnections 정규화. 잘못된 엔트리 폐기, 개수 상한·id 중복 보정.
 * @returns {Array<object>}
 */
function normalizeConnections(input, deps) {
  const out = [];
  if (!Array.isArray(input)) return out;
  const seen = new Set();
  for (const item of input.slice(0, MAX_CONNECTIONS)) {
    if (!isPlainObject(item)) continue;
    const c = normalizeConnection(item, deps, { fallbackLabel: 'AI 연결' });
    let id = c.id;
    if (!id || seen.has(id)) id = genId(deps, seen);
    seen.add(id);
    c.id = id;
    out.push(c);
  }
  return out;
}

/** 연결 추가 → { ok:true, connections, connection } | { ok:false, code:'LIMIT' }. */
function addConnection(list, input, deps) {
  const connections = normalizeConnections(list, deps);
  if (connections.length >= MAX_CONNECTIONS) return { ok: false, code: 'LIMIT' };
  const seen = new Set(connections.map((c) => c.id));
  const connection = normalizeConnection(input, deps, { fallbackLabel: '새 연결 ' + (connections.length + 1) });
  connection.id = genId(deps, seen);
  return { ok: true, connections: connections.concat([connection]), connection };
}

/**
 * 연결 수정 → { ok:true, connections, connection } | { ok:false, code:'NOT_FOUND' }.
 *   apiKey 미전송(undefined/null/'')이면 기존 키 유지(렌더러는 평문 미보유). label 미전송이면 기존 유지.
 */
function updateConnection(list, id, input, deps) {
  const connections = normalizeConnections(list, deps);
  const idx = connections.findIndex((c) => c.id === id);
  if (idx < 0) return { ok: false, code: 'NOT_FOUND' };
  const existing = connections[idx];
  const merged = Object.assign({}, isPlainObject(input) ? input : {});
  if (merged.apiKey === undefined || merged.apiKey === null || merged.apiKey === '') merged.apiKey = existing.apiKey;
  if (merged.label === undefined || merged.label === null) merged.label = existing.label;
  const connection = normalizeConnection(merged, deps, { fallbackLabel: existing.label, id: existing.id });
  connection.id = existing.id;
  const next = connections.slice();
  next[idx] = connection;
  return { ok: true, connections: next, connection };
}

/** 연결 삭제 → { ok:true, connections } | { ok:false, code:'NOT_FOUND' }. */
function removeConnection(list, id, deps) {
  const connections = normalizeConnections(list, deps);
  const idx = connections.findIndex((c) => c.id === id);
  if (idx < 0) return { ok: false, code: 'NOT_FOUND' };
  const next = connections.slice();
  next.splice(idx, 1);
  return { ok: true, connections: next };
}

/** 렌더러 노출용 뷰 — apiKey 평문 제거, 보유 여부만. baseURL/model 은 요약 표시용(노출 가능). */
function toPublicView(c) {
  c = c || {};
  return {
    id: c.id,
    label: typeof c.label === 'string' ? c.label : '',
    baseURL: typeof c.baseURL === 'string' ? c.baseURL : '',
    model: typeof c.model === 'string' ? c.model : '',
    hasApiKey: typeof c.apiKey === 'string' && c.apiKey.length > 0,
  };
}

/** 연결 배열 → 공개 뷰 배열(apiKey 제거). */
function toPublicList(list) {
  return (Array.isArray(list) ? list : []).map(toPublicView);
}

/**
 * 활성 연결 ↔ briefing 미러 불변식 강제 + 최초/레거시 이행.
 *   · 연결 목록이 비면 기존 briefing 을 첫 연결('기본 연결')로 승격(무손실).
 *   · activeId 가 없거나 존재하지 않으면 첫 연결로 보정.
 *   · briefing = 활성 연결 필드 미러(+ 전역 enabled 보존).
 * @returns {{ briefing:object, connections:Array, activeId:string }}
 */
function resolveState(briefing, connections, activeId, deps) {
  const b = isPlainObject(briefing) ? briefing : {};
  let conns = normalizeConnections(connections, deps);
  let active = (typeof activeId === 'string' && activeId) ? activeId : '';

  if (conns.length === 0) {
    const seed = normalizeConnection(Object.assign({}, b, { label: '기본 연결' }), deps, { fallbackLabel: '기본 연결' });
    seed.id = genId(deps, new Set());
    conns = [seed];
    active = seed.id;
  }
  if (!conns.find((c) => c.id === active)) active = conns[0].id;

  const activeConn = conns.find((c) => c.id === active);
  // 미러: 활성 연결 필드 → briefing (전역 enabled 는 briefing 값 보존).
  const mirrored = normSettings(deps, Object.assign({}, activeConn, { enabled: !!b.enabled }));
  return { briefing: mirrored, connections: conns, activeId: active };
}

module.exports = {
  MAX_CONNECTIONS, MAX_LABEL_LEN, ID_RE,
  isPlainObject, sanitizeLabel,
  normalizeConnection, normalizeConnections,
  addConnection, updateConnection, removeConnection,
  toPublicView, toPublicList,
  resolveState,
};
