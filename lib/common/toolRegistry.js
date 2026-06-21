'use strict';
/**
 * lib/common/toolRegistry.js — 확장형 외부 툴 레지스트리 (R-18, M6-H-1/H-2/M-1)
 *
 * config.tools(맵)를 정규화하고, toolId의 실행 경로를 "사용자 지정 우선 → PATH 폴백"으로
 * 해석한다. Electron API를 import하지 않는 순수 도메인 모듈(외부 의존성 0).
 *
 * [M6-M-1/SQ-3] toolId는 KNOWN_TOOL_IDS(MVP 'code') 화이트리스트 멤버만 채택·실행.
 *   임의 toolId 거부, PATH 폴백도 화이트리스트 멤버에 한정.
 * [M6-H-2] tools 스키마에 args 필드 없음. normalizeTools는 입력의 args 키를 무시(drop).
 *   실행 인자는 main이 구성하는 [projectPath] 고정 → LOLBin 표면 원천 제거.
 * [M6-H-1] resolveTool은 매 실행 resolveBin(path,{force:true})로 캐시를 우회하고 fs를
 *   재확인한다(등록 후 파일이 악성 교체돼도 spawn 직전 최신 상태로 재검증, TOCTOU 방어).
 *
 * 검증 로직은 (input)→object 순수 함수로 분리해 헤드리스 단위테스트한다(F-3).
 */

const { clampString } = require('./logger');

// 알려진 toolId 집합(M6-M-1/SQ-3). MVP는 'code'. 새 툴 추가 시 여기에 등록해야 실행 대상이 됨.
const KNOWN_TOOL_IDS = new Set(['code']); // 향후: 'cursor','idea' 등 명시 추가

// 상한값.
const MAX_TOOLS = 32;
const MAX_TOOL_PATH_LEN = 4096;
const MAX_TOOL_LABEL_LEN = 64;

const TOOL_ID_RE = /^[a-z0-9_-]{1,32}$/;
// 제거 대상(코드포인트 명시 — 소스 인코딩 의존 없이 안전 구성):
//   C0(0000-001F)·DEL(007F)·C1(0080-009F)
//   방향제어문자 LRM(200E)/RLM(200F)·LRE-RLO(202A-202E)·isolates(2066-2069)·BOM(FEFF)
const CONTROL_AND_BIDI_RE = new RegExp(
  '[\\u0000-\\u001F\\u007F-\\u009F\\u200E\\u200F\\u202A-\\u202E\\u2066-\\u2069\\uFEFF]',
  'g'
);

/** plain object 여부(배열·null 제외). */
function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** toolId 형식·화이트리스트 멤버십을 동시 검증(M6-M-1). */
function isKnownToolId(id) {
  return typeof id === 'string' && TOOL_ID_RE.test(id) && KNOWN_TOOL_IDS.has(id);
}

/**
 * 라벨 정제(L-2): 제어/방향제어문자 제거·인쇄가능 문자만·길이 ≤64. 비문자열이면 기본값(id).
 * @param {*} raw
 * @param {string} fallbackId
 * @returns {string}
 */
function sanitizeLabel(raw, fallbackId) {
  if (typeof raw !== 'string') return fallbackId;
  // 제어·방향제어문자 제거 후 길이 절단(clampString는 제어문자를 공백 치환하므로 선제거).
  const stripped = raw.replace(CONTROL_AND_BIDI_RE, '');
  const cleaned = clampString(stripped, MAX_TOOL_LABEL_LEN);
  const trimmed = (typeof cleaned === 'string' ? cleaned : '').trim();
  return trimmed.length > 0 ? trimmed : fallbackId;
}

/**
 * config.tools 정규화(loadConfig가 호출). 형식 검증·폴백.
 * - toolId 형식(^[a-z0-9_-]{1,32}$) + KNOWN_TOOL_IDS 멤버만 채택(M6-M-1)
 * - path: 문자열이고 절대경로 모양이며 ≤4096이면 채택, 아니면 null(PATH 폴백)
 * - label: 제어/방향제어문자 제거·≤64(L-2)
 * - args 등 그 외 키는 무시(M6-H-2)
 * @param {*} input config.tools 후보
 * @param {object} [deps] { isAbsolute } 테스트 주입용(기본 require('path').isAbsolute)
 * @returns {object} 정규화된 tools 맵
 */
function normalizeTools(input, deps) {
  const out = {};
  if (!isPlainObject(input)) return out;
  const isAbsolute = (deps && typeof deps.isAbsolute === 'function')
    ? deps.isAbsolute
    : require('path').isAbsolute;

  for (const [id, v] of Object.entries(input).slice(0, MAX_TOOLS)) {
    if (!TOOL_ID_RE.test(id)) continue;       // 형식 화이트리스트
    if (!KNOWN_TOOL_IDS.has(id)) continue;    // 등록 known id만(M6-M-1)
    if (!isPlainObject(v)) continue;
    let pathVal = null;
    if (typeof v.path === 'string' && v.path.length > 0 && v.path.length <= MAX_TOOL_PATH_LEN && isAbsolute(v.path)) {
      pathVal = v.path;
    }
    out[id] = {
      path: pathVal,
      label: sanitizeLabel(v.label, id),
      // v.args는 읽지 않음(M6-H-2) — 입력에 args가 있어도 drop.
    };
  }
  return out;
}

/**
 * 실행 경로 해석(actions.open이 호출). 사용자 지정 우선 → PATH 폴백.
 * 매 호출 resolveBin(.,{force:true})로 캐시를 우회해 spawn 직전 fs 재검증(M6-H-1).
 * @param {string} toolId
 * @param {object} config { tools }
 * @param {object} deps { resolveBin } 주입 필수(헤드리스 테스트)
 * @returns {{bin:string|null, source:'config'|'path'|'none'}}
 */
function resolveTool(toolId, config, deps) {
  if (!isKnownToolId(toolId)) return { bin: null, source: 'none' }; // 화이트리스트 외 즉시 거부(M6-M-1)
  const rb = deps && deps.resolveBin;
  if (typeof rb !== 'function') return { bin: null, source: 'none' };
  const tools = (config && isPlainObject(config.tools)) ? config.tools : {};
  const tool = (tools && isPlainObject(tools[toolId])) ? tools[toolId] : null;

  // 사용자 지정 절대경로: 캐시를 믿지 않고 매 실행 force 재검증(절대·존재·.exe·realpath).
  if (tool && typeof tool.path === 'string' && tool.path) {
    const abs = rb(tool.path, { force: true }); // ★M6-H-1
    if (abs) return { bin: abs, source: 'config' };
  }
  // 폴백: 화이트리스트 멤버 toolId만 PATH에서 탐색(임의 PATH 바이너리 호출 차단).
  const viaPath = rb(toolId, { force: true });
  if (viaPath) return { bin: viaPath, source: 'path' };
  return { bin: null, source: 'none' };
}

module.exports = {
  KNOWN_TOOL_IDS,
  MAX_TOOLS,
  MAX_TOOL_PATH_LEN,
  MAX_TOOL_LABEL_LEN,
  TOOL_ID_RE,
  isPlainObject,
  isKnownToolId,
  sanitizeLabel,
  normalizeTools,
  resolveTool,
};
