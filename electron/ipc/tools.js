'use strict';
/**
 * electron/ipc/tools.js — 외부 툴 경로 설정 IPC (R-18, M6-H-1/H-2/M-1/M-2)
 *
 *   spip:getTools            → config.tools를 읽어 해석상태(resolved/source)까지 산출(args 없음)
 *   spip:setToolPath { id, path } → toolId 화이트리스트 + force 재검증 + 캐시 무효화 + persist
 *   spip:pickToolExecutable { id } → dialog(.exe) → 결과도 setToolPath와 동일 main 재검증 + persist
 *
 * [보안 게이트]
 *   ① toolId는 KNOWN_TOOL_IDS 화이트리스트 멤버만(M6-M-1)
 *   ② setToolPath/pick 모두 resolveBin(path,{force:true})로 캐시 우회 강제 재검증(M6-H-1)
 *      → 성공 시 _clearBinCache로 이전 캐시값 폐기(P3-2)
 *   ③ tools 스키마에 args 없음(M6-H-2) — 응답에도 args 미포함
 *   ④ dialog의 .exe 필터는 신뢰 근거 아님 — 반환 경로 동일 재검증(M6-M-2)
 *   ⑤ persistConfigKeys({tools})로 0600 원자적 부분 갱신(P2-1)
 *
 * [헤드리스 검증, F-3] resolveBin·_clearBinCache·persistConfigKeys·toolRegistry는 ctx로 주입
 *   가능(기본 실제 모듈). 검증 체인·실패 code·캐시 무효화 호출을 모킹으로 단위테스트.
 *
 * 외부 의존성 0 — Electron API 미import(dialog/win은 register.js에서 주입).
 */

const path = require('path');
const safeExec = require('../../lib/common/safeExec');
const toolRegistry = require('../../lib/common/toolRegistry');
const config = require('../../lib/common/config');

const MAX_TOOL_PATH_LEN = toolRegistry.MAX_TOOL_PATH_LEN; // 4096

/** ctx에서 의존성 해석(주입 우선, 기본 실제 모듈). */
function deps(ctx) {
  return {
    resolveBin: (ctx && typeof ctx.resolveBin === 'function') ? ctx.resolveBin : safeExec.resolveBin,
    clearBinCache: (ctx && typeof ctx.clearBinCache === 'function') ? ctx.clearBinCache : safeExec._clearBinCache,
    persistConfigKeys: (ctx && typeof ctx.persistConfigKeys === 'function') ? ctx.persistConfigKeys : config.persistConfigKeys,
  };
}

/** 단일 툴의 해석상태를 산출. {id,label,path,resolved,source}(args 없음). */
function describeTool(toolId, cfg, d) {
  const tools = (cfg && cfg.tools && typeof cfg.tools === 'object') ? cfg.tools : {};
  const entry = (tools[toolId] && typeof tools[toolId] === 'object') ? tools[toolId] : {};
  const r = toolRegistry.resolveTool(toolId, cfg, { resolveBin: d.resolveBin }); // force 경로(P3-2)
  return {
    id: toolId,
    label: typeof entry.label === 'string' && entry.label ? entry.label : toolId,
    path: typeof entry.path === 'string' && entry.path ? entry.path : null,
    resolved: !!r.bin,
    source: r.source,
  };
}

/**
 * spip:getTools — 등록 known toolId 전체의 해석상태를 산출(설정 드로어 오픈 시에만 호출).
 * config에 등록되지 않은 known id도 포함(PATH 폴백 해석 표시).
 * @param {object} ctx { config, resolveBin? }
 * @returns {{ok:true, tools:Array<{id,label,path,resolved,source}>}}
 */
function getTools(ctx) {
  const cfg = (ctx && ctx.config) || {};
  const d = deps(ctx);
  const tools = [];
  for (const id of toolRegistry.KNOWN_TOOL_IDS) {
    tools.push(describeTool(id, cfg, d));
  }
  return { ok: true, tools };
}

/**
 * 사용자 지정 경로를 main에서 재검증한다(setToolPath·pickToolExecutable 공통, M6-H-1/H-2/M-2).
 * 절대·길이·.exe(win은 resolveBin이 강제)·존재·실행파일·realpath를 resolveBin(path,{force:true})로 확인.
 * @returns {{ok:true, real:string} | {ok:false, code:string}}
 */
function validateToolPath(rawPath, d) {
  if (typeof rawPath !== 'string' || rawPath.length === 0 || rawPath.length > MAX_TOOL_PATH_LEN) {
    return { ok: false, code: 'NOT_ABSOLUTE' };
  }
  if (!path.isAbsolute(rawPath)) return { ok: false, code: 'NOT_ABSOLUTE' };
  // ★M6-H-1: 캐시 우회 강제 재검증(존재·일반파일·(win).exe·realpath는 resolveBin 내부에서).
  const real = d.resolveBin(rawPath, { force: true });
  if (!real) return { ok: false, code: 'NOT_EXECUTABLE' }; // 미존재·비실행·비.exe 모두 여기로
  return { ok: true, real };
}

/**
 * 정규화된 tools 맵에 id의 path를 반영한 새 맵을 만든다(다른 항목 보존).
 * label은 기존 유지(없으면 id). path=null이면 지정 해제(PATH 폴백).
 */
function mergeToolPath(cfg, id, newPath) {
  const tools = (cfg && cfg.tools && typeof cfg.tools === 'object' && !Array.isArray(cfg.tools)) ? cfg.tools : {};
  const next = {};
  for (const [k, v] of Object.entries(tools)) {
    if (v && typeof v === 'object') next[k] = { path: v.path != null ? v.path : null, label: typeof v.label === 'string' ? v.label : k };
  }
  const existingLabel = (next[id] && typeof next[id].label === 'string') ? next[id].label : id;
  next[id] = { path: newPath, label: existingLabel };
  // 단일 화이트리스트 원천: normalizeTools로 한 번 더 통과(args drop·known id 한정·label sanitize).
  return toolRegistry.normalizeTools(next);
}

/**
 * 공통: 검증 통과한 path(또는 null 해제)를 tools에 반영·캐시 무효화·영속하고 해석상태 반환.
 * @returns {{ok:true, tool:object}}
 */
function applyToolPath(id, newPath, ctx, d) {
  const cfg = (ctx && ctx.config) || {};
  const tools = mergeToolPath(cfg, id, newPath);
  // 메모리 config 갱신(다음 open/getTools 반영).
  if (ctx && ctx.config) ctx.config.tools = tools;
  // ★캐시 무효화(P3-2): 이전 절대경로 캐시값 폐기 → 다음 해석은 최신 fs.
  try { if (typeof d.clearBinCache === 'function') d.clearBinCache(); } catch (_) { /* noop */ }
  // 영속(P2-1): tools 전체 맵만 0600 원자적 부분 갱신(scanRoots·기타 키 보존).
  d.persistConfigKeys({ tools }, { logger: ctx && ctx.logger, configPath: ctx && ctx.configPath });
  const tool = describeTool(id, ctx && ctx.config ? ctx.config : { tools }, d);
  return { ok: true, tool };
}

/**
 * spip:setToolPath — toolId 화이트리스트 + 경로 재검증 + 캐시 무효화 + persist.
 * @param {object} args { id, path:string|null }
 * @param {object} ctx { config, resolveBin?, clearBinCache?, persistConfigKeys?, configPath?, logger }
 * @returns {{ok:true, tool} | {ok:false, code:'INVALID_TOOL_ID'|'NOT_ABSOLUTE'|'NOT_FOUND'|'NOT_EXECUTABLE'}}
 */
function setToolPath(args, ctx) {
  const id = args && typeof args === 'object' ? args.id : undefined;
  if (!toolRegistry.isKnownToolId(id)) return { ok: false, code: 'INVALID_TOOL_ID' };
  const d = deps(ctx);
  const rawPath = args.path;

  if (rawPath === null || rawPath === undefined) {
    // 지정 해제(PATH 폴백). 캐시 무효화 후 persist.
    return applyToolPath(id, null, ctx, d);
  }
  const v = validateToolPath(rawPath, d);
  if (!v.ok) return v;
  // 저장은 사용자가 입력한 경로(검증 통과분). real(realpath)이 아니라 입력 경로를 보존(SQ-2 포터블 워크플로).
  return applyToolPath(id, rawPath, ctx, d);
}

/**
 * spip:pickToolExecutable — dialog(.exe) → 결과도 setToolPath와 동일 재검증·persist(M6-M-2).
 * @param {object} args { id }
 * @param {object} ctx { config, dialog, win, resolveBin?, clearBinCache?, persistConfigKeys?, ... }
 * @returns {Promise<{ok:true,tool} | {ok:false,code:'INVALID_TOOL_ID'|'CANCELLED'|'NOT_EXECUTABLE'|'NOT_ABSOLUTE'}>}
 */
async function pickToolExecutable(args, ctx) {
  const id = args && typeof args === 'object' ? args.id : undefined;
  if (!toolRegistry.isKnownToolId(id)) return { ok: false, code: 'INVALID_TOOL_ID' };
  const dialog = ctx && ctx.dialog;
  if (!dialog || typeof dialog.showOpenDialog !== 'function') {
    return { ok: false, code: 'CANCELLED' };
  }
  const res = await dialog.showOpenDialog(ctx.win, {
    title: '실행 파일 선택',
    properties: ['openFile'],
    filters: [{ name: 'Executable', extensions: ['exe'] }],
  });
  if (!res || res.canceled || !Array.isArray(res.filePaths) || res.filePaths.length === 0) {
    return { ok: false, code: 'CANCELLED' };
  }
  const picked = res.filePaths[0];
  const d = deps(ctx);
  // ★dialog 필터는 신뢰 근거 아님 — 동일 재검증(M6-M-2).
  const v = validateToolPath(picked, d);
  if (!v.ok) return v;
  return applyToolPath(id, picked, ctx, d);
}

module.exports = {
  getTools,
  setToolPath,
  pickToolExecutable,
  describeTool,
  validateToolPath,
  mergeToolPath,
  applyToolPath,
  MAX_TOOL_PATH_LEN,
};
