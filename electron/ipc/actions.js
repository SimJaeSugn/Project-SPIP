'use strict';
/**
 * electron/ipc/actions.js — 액션 IPC 핸들러 (electron-migration §4.1/§4.2 actions 채널)
 *
 *   spip:openInVsCode { id }            → VS Code로 프로젝트 열기(H-1/H-2/M-4)
 *   spip:rescan       { withSize?, allDrives? } → 백그라운드 재스캔 트리거(게이트·락)
 *
 * actionHandlers.js의 open/rescan 핵심 흐름을 (args, ctx) → result 순수 함수로 이식한다.
 *   · readJsonBody·HTTP 응답코드 매핑은 드롭(IPC는 인자를 직접 받고 객체 반환).
 *   · [F-2] actionHandlers의 require('./apiHandlers').sendJson 결합을 절단 — 객체만 반환.
 *   · H-1(pathGuard) · H-2(safeExec resolveBin·shell:false) · M-4(in-flight 상한) 전부 유지.
 *
 * [§4.2 입력 재검증] renderer는 신뢰하지 않는다.
 *   open : id는 string·0<len≤512. 경로 인자 미수신 — id로만 역참조.
 *   rescan: opts는 plain object만, 키 화이트리스트 {withSize,allDrives}만 Boolean() 강제.
 *           allDrives는 config.allowAllDrives 게이트 전용(인자만으로 못 켬 → 강등+note).
 *
 * [헤드리스 검증, F-3] Electron API 미import. 의존(pathGuard·safeExec·driveEnum)은 ctx로
 *   주입 가능(기본 실제 모듈). 검증 체인·실패 code를 모킹 없이 단위테스트.
 *
 * 외부 의존성 0 — 내부(pathGuard, safeExec, driveEnum)만.
 */

const pathGuard = require('../../lib/common/pathGuard');
const { resolveBin, safeExec } = require('../../lib/common/safeExec');
const driveEnum = require('../../lib/scan/driveEnum');
const toolRegistry = require('../../lib/common/toolRegistry');

// id별 in-flight 상한(M-4) — 같은 프로젝트 중복 열기 폭주 차단(actionHandlers와 동일).
const MAX_INFLIGHT_PER_ID = 2;
// id 길이 상한(§4.2). 512 초과는 즉시 거부.
const MAX_ID_LEN = 512;

/**
 * §4.2 open 인자 스키마 검증. { id } 객체에서 유효 id만 추출, 아니면 null.
 * @returns {string|null}
 */
function sanitizeOpenId(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return null;
  const id = args.id;
  if (typeof id !== 'string' || id.length === 0 || id.length > MAX_ID_LEN) return null;
  return id;
}

/**
 * §4.2 rescan 옵션 sanitize. plain object만, 키 화이트리스트 {withSize,allDrives}만 Boolean() 강제.
 * 그 외 키 무시. plain object가 아니면 {withSize:false,allDrives:false}로 강등.
 */
function sanitizeRescanOpts(opts) {
  const isPlain = opts && typeof opts === 'object' && !Array.isArray(opts);
  const src = isPlain ? opts : {};
  return {
    withSize: Boolean(src.withSize),
    allDrives: Boolean(src.allDrives),
  };
}

/**
 * §4.2 toolId sanitize. 비문자열/형식불일치/미등록(화이트리스트 외)은 null(M6-M-1).
 * @returns {string|null}
 */
function sanitizeToolId(raw) {
  return toolRegistry.isKnownToolId(raw) ? raw : null;
}

/**
 * spip:openInVsCode(확장) — id로 역참조 → 화이트리스트 검증(H-1) → 툴 실행(H-2/M-4 + M6-H-1/H-2/M-1).
 * toolId 미지정 시 'code'(하위호환). toolId는 KNOWN_TOOL_IDS 멤버만 허용(M6-M-1).
 * resolveTool이 spawn 직전 resolveBin(.,{force:true})로 캐시 우회 강제 재검증(M6-H-1).
 * 실행 인자는 [real] 고정(사용자 args 없음, M6-H-2).
 * @param {object} args { id, toolId? }
 * @param {object} ctx { store, config, pathGuard?, resolveBin?, safeExec?, logger }
 * @returns {Promise<{ok:true,code:'OPENING'} | {ok:false,code:string}>}
 */
async function openInVsCode(args, ctx) {
  const store = ctx.store;
  const pg = (ctx && ctx.pathGuard) || pathGuard;
  const rb = (ctx && typeof ctx.resolveBin === 'function') ? ctx.resolveBin : resolveBin;
  const exec = (ctx && typeof ctx.safeExec === 'function') ? ctx.safeExec : safeExec;
  const config = (ctx && ctx.config) || {};

  const id = sanitizeOpenId(args);
  if (id === null) return { ok: false, code: 'ID_NOT_FOUND' };

  // toolId: 미지정 하위호환='code'. 비null이지만 미등록이면 거부(M6-M-1).
  const rawToolId = args && typeof args === 'object' ? args.toolId : undefined;
  let toolId;
  if (rawToolId === undefined || rawToolId === null || rawToolId === '') {
    toolId = 'code';
  } else {
    toolId = sanitizeToolId(rawToolId);
    if (toolId === null) return { ok: false, code: 'TOOL_NOT_FOUND' }; // 화이트리스트 외 toolId
  }

  const project = store.getById(id);
  if (!project) return { ok: false, code: 'ID_NOT_FOUND' };

  // H-1: 실경로 화이트리스트 검증. canonicalize 실패(소멸) → PATH_GONE.
  const real = pg.canonicalize(project.path);
  if (real === null) return { ok: false, code: 'PATH_GONE' };
  if (!pg.isAllowed(project.path, store.getAllowKeySet())) {
    return { ok: false, code: 'PATH_NOT_ALLOWED' };
  }

  // H-2 + ★M6-H-1: resolveTool이 사용자 경로 우선→PATH 폴백, 매 호출 force 재검증(캐시 우회).
  const r = toolRegistry.resolveTool(toolId, config, { resolveBin: rb });
  if (!r.bin) {
    return { ok: false, code: toolId === 'code' ? 'CODE_CLI_NOT_FOUND' : 'TOOL_NOT_FOUND' };
  }

  // H-2/M-4: spawn(shell:false, detached) + 툴/id별 in-flight 상한. ★실행 인자 [real] 고정(M6-H-2).
  try {
    await exec(r.bin, [real], {
      shell: false,
      detached: true,
      inflightKey: 'open:' + toolId + ':' + id, // P3-1: 툴별 분리
      maxInflight: MAX_INFLIGHT_PER_ID,
    });
    return { ok: true, code: 'OPENING' };
  } catch (_) {
    // in-flight 초과/spawn 실패 — 내부정보 비노출(L-3).
    return { ok: false, code: 'OPEN_FAILED' };
  }
}

/**
 * spip:openPath — id로 프로젝트 폴더를 OS 파일 탐색기에서 연다(shell.openPath).
 * openInVsCode와 동일한 검증 체인: id 역참조 → canonicalize(H-1) → 화이트리스트 isAllowed.
 *   임의 경로 실행 표면을 만들지 않도록 경로 인자는 받지 않고 id로만 역참조한다.
 * @param {object} args { id }
 * @param {object} ctx { store, pathGuard?, shell }
 * @returns {Promise<{ok:true,code:'OPENING'} | {ok:false,code:string}>}
 */
async function openPath(args, ctx) {
  const store = ctx.store;
  const pg = (ctx && ctx.pathGuard) || pathGuard;
  const shell = ctx && ctx.shell;

  const id = sanitizeOpenId(args);
  if (id === null) return { ok: false, code: 'ID_NOT_FOUND' };

  const project = store.getById(id);
  if (!project) return { ok: false, code: 'ID_NOT_FOUND' };

  // H-1: 실경로 화이트리스트 검증(소멸/비허용 거부).
  const real = pg.canonicalize(project.path);
  if (real === null) return { ok: false, code: 'PATH_GONE' };
  if (!pg.isAllowed(project.path, store.getAllowKeySet())) {
    return { ok: false, code: 'PATH_NOT_ALLOWED' };
  }
  if (!shell || typeof shell.openPath !== 'function') return { ok: false, code: 'INTERNAL' };

  try {
    // shell.openPath: 성공 시 빈 문자열, 실패 시 오류 메시지 반환(throw 아님).
    const err = await shell.openPath(real);
    if (err) return { ok: false, code: 'OPEN_FAILED' };
    return { ok: true, code: 'OPENING' };
  } catch (_) {
    return { ok: false, code: 'OPEN_FAILED' };
  }
}

/**
 * spip:rescan — 재스캔 트리거. 게이트·락·start (actionHandlers.rescan 이식).
 * 경로는 config에서만 가져온다(인자로 경로 안 받음 — H-1 정합).
 * @param {object} args { withSize?, allDrives? }
 * @param {object} ctx { scanController, config, store, cachePath, logger, driveEnum?, sendProgress? }
 * @returns {{ok:true,code:'SCAN_STARTED',scanId,startedAt} | {ok:false,code:string,scanId?}}
 */
function rescan(args, ctx) {
  const controller = ctx.scanController;
  const config = ctx.config || {};
  const logger = ctx.logger;
  const de = (ctx && ctx.driveEnum) || driveEnum;

  if (!controller || typeof controller.acquire !== 'function') {
    return { ok: false, code: 'INTERNAL' };
  }

  const { withSize, allDrives: wantAllDrives } = sanitizeRescanOpts(args);

  // scanRoots 미설정 → NO_SCAN_ROOTS.
  const roots = Array.isArray(config.scanRoots) ? config.scanRoots : [];
  if (roots.length === 0) {
    return { ok: false, code: 'NO_SCAN_ROOTS' };
  }

  // 옵션 게이트(M4-M-1): allDrives는 config.allowAllDrives 게이트 전용(인자만으로 못 켬 → 강등+note).
  const allowAllDrives = config.allowAllDrives === true;
  const effectiveAllDrives = wantAllDrives && allowAllDrives;
  let note = null;
  if (wantAllDrives && !allowAllDrives) {
    note = 'all-drives는 설정에서 비활성'; // 강등 안내(textContent 렌더, L-1)
  }

  // all-drives 활성 시 드라이브/마운트 열거를 루트로 사용.
  let scanRoots = roots;
  if (effectiveAllDrives) {
    try {
      const enumerated = de.enumerateRoots({ logger });
      if (Array.isArray(enumerated) && enumerated.length > 0) scanRoots = enumerated;
    } catch (err) {
      if (logger) logger.error('drive enumeration failed', err);
    }
  }

  // [#5] 스캔 루트에 드라이브 루트(C:\ 등)가 포함되면 all-drives 보호장치(시스템 폴더 제외 +
  //   더 낮은 깊이 상한)를 켠다 — all-drives 모드가 아니어도 드라이브 단위 스캔은 동일 위험이므로.
  //   드라이브 열거(전체 확장)는 하지 않고 사용자가 고른 드라이브만 스캔한다(effectiveAllDrives와 구분).
  const isDriveRoot = (r) => {
    const s = String(r).replace(/[\\/]+$/, '');
    return /^[A-Za-z]:$/.test(s) || s === '' || r === '/';
  };
  const hasDriveRoot = scanRoots.some(isDriveRoot);
  const driveProtect = effectiveAllDrives || hasDriveRoot;

  // 락 시도. 실패(이미 진행 중) → SCAN_IN_PROGRESS(현 scanId 동봉).
  const acquired = controller.acquire({ note });
  if (!acquired) {
    return { ok: false, code: 'SCAN_IN_PROGRESS', scanId: controller.status().scanId };
  }

  // 백그라운드 실행(대기 안 함). onProgress 공개 콜백으로 진행 push(F-1, §4.3).
  controller.start({
    config,
    roots: scanRoots,
    withSize,
    allDrives: driveProtect,
    store: ctx.store,
    cachePath: ctx.cachePath,
    logger,
    onProgress: (typeof ctx.sendProgress === 'function') ? ctx.sendProgress : undefined,
  });

  return { ok: true, code: 'SCAN_STARTED', scanId: acquired.scanId, startedAt: acquired.startedAt };
}

module.exports = { openInVsCode, openPath, rescan, sanitizeOpenId, sanitizeToolId, sanitizeRescanOpts, MAX_INFLIGHT_PER_ID, MAX_ID_LEN };
