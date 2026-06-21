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
 * spip:openInVsCode — id로 역참조 → 화이트리스트 검증(H-1) → code 실행(H-2/M-4).
 * actionHandlers.open 3~6단계를 그대로 이식. HTTP 상태코드 매핑은 드롭.
 * @param {object} args { id }
 * @param {object} ctx { store, pathGuard?, resolveBin?, safeExec?, logger }
 * @returns {Promise<{ok:true,code:'OPENING'} | {ok:false,code:string}>}
 */
async function openInVsCode(args, ctx) {
  const store = ctx.store;
  const pg = (ctx && ctx.pathGuard) || pathGuard;
  const rb = (ctx && typeof ctx.resolveBin === 'function') ? ctx.resolveBin : resolveBin;
  const exec = (ctx && typeof ctx.safeExec === 'function') ? ctx.safeExec : safeExec;

  const id = sanitizeOpenId(args);
  if (id === null) return { ok: false, code: 'ID_NOT_FOUND' };

  const project = store.getById(id);
  if (!project) return { ok: false, code: 'ID_NOT_FOUND' };

  // H-1: 실경로 화이트리스트 검증. canonicalize 실패(소멸) → PATH_GONE.
  const real = pg.canonicalize(project.path);
  if (real === null) return { ok: false, code: 'PATH_GONE' };
  if (!pg.isAllowed(project.path, store.getAllowKeySet())) {
    return { ok: false, code: 'PATH_NOT_ALLOWED' };
  }

  // H-2: code CLI 절대경로 해석. 미설치 → CODE_CLI_NOT_FOUND.
  const codeBin = rb('code');
  if (!codeBin) return { ok: false, code: 'CODE_CLI_NOT_FOUND' };

  // H-2/M-4: spawn(shell:false, detached) + id별 in-flight 상한. 검증된 실경로(real) 전달.
  try {
    await exec(codeBin, [real], {
      shell: false,
      detached: true,
      inflightKey: 'open:' + id,
      maxInflight: MAX_INFLIGHT_PER_ID,
    });
    return { ok: true, code: 'OPENING' };
  } catch (_) {
    // in-flight 초과/spawn 실패 — 내부정보 비노출(L-3).
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
    allDrives: effectiveAllDrives,
    store: ctx.store,
    cachePath: ctx.cachePath,
    logger,
    onProgress: (typeof ctx.sendProgress === 'function') ? ctx.sendProgress : undefined,
  });

  return { ok: true, code: 'SCAN_STARTED', scanId: acquired.scanId, startedAt: acquired.startedAt };
}

module.exports = { openInVsCode, rescan, sanitizeOpenId, sanitizeRescanOpts, MAX_INFLIGHT_PER_ID, MAX_ID_LEN };
