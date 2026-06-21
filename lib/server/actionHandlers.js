'use strict';
/**
 * lib/server/actionHandlers.js — 액션 API (R-12, R-16, M-1, M-4, H-1, H-2)
 *
 *   POST /api/open    { id }                  → VS Code로 프로젝트 열기.
 *   POST /api/rescan  { withSize?, allDrives? } → 백그라운드 재스캔 트리거(202/409, M4 R-16).
 *
 * 흐름(/api/open):
 *   1) [M-1] security.checkStateChange 선통과(Host/Origin/토큰/CT) — 라우터가 보장.
 *   2) body JSON 파싱(상한). id 추출.
 *   3) snapshotStore.getById(id)로 역참조 — 미존재 404 ID_NOT_FOUND.
 *   4) [H-1] pathGuard.isAllowed(path, allowKeySet) — canonicalize 정확 일치.
 *      실경로 소멸(canonicalize null) → PATH_GONE, 불일치 → 403 PATH_NOT_ALLOWED.
 *   5) [H-2] safeExec(resolveBin('code'), [path], {shell:false}) — 절대경로 spawn.
 *      [M-4] inflightKey=id로 id별 중복 spawn 차단.
 *   6) 계약 응답 { ok:true, code:'OPENING', message }.
 *
 * 에러 응답은 내부정보 비노출(L-3) — 고정 code/message만.
 *
 * 외부 의존성 0 — 내부(pathGuard, safeExec)만.
 */

const pathGuard = require('../common/pathGuard');
const { resolveBin, safeExec } = require('../common/safeExec');
const { sendJson } = require('./apiHandlers');
const driveEnum = require('../scan/driveEnum'); // [P3-2] 상단 require로 일관(핫패스 인라인 require 제거, 순환 없음)

// 요청 본문 상한(부분신뢰 입력 가드). id 하나면 충분.
const MAX_BODY_BYTES = 16 * 1024; // 16KB
// id별 in-flight 상한(M-4) — 같은 프로젝트 중복 열기 폭주 차단.
const MAX_INFLIGHT_PER_ID = 2;

/**
 * 요청 본문을 상한 내에서 수집해 JSON 파싱한다.
 * @returns {Promise<object|null>} 파싱 객체 또는 실패 시 null
 */
function readJsonBody(req) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    let aborted = false;

    req.on('data', (chunk) => {
      if (aborted) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        aborted = true;
        // 더 읽지 않도록 소켓 폐기 시도.
        try { req.destroy(); } catch (_) { /* noop */ }
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (aborted) return;
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (raw === '') {
        resolve({}); // 빈 본문은 빈 객체로 취급(rescan {} 등)
        return;
      }
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) resolve(parsed);
        else resolve(null);
      } catch (_) {
        resolve(null);
      }
    });
    req.on('error', () => resolve(null));
  });
}

/**
 * POST /api/open — id로 역참조 → 화이트리스트 검증 → code 실행.
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 * @param {object} ctx { store }
 */
async function open(req, res, ctx) {
  const store = ctx.store;

  const body = await readJsonBody(req);
  if (body === null || typeof body.id !== 'string' || !body.id) {
    // 잘못된 본문/누락 id — 식별 불가이므로 ID_NOT_FOUND로 처리(내부정보 비노출).
    sendJson(res, 404, { ok: false, code: 'ID_NOT_FOUND' });
    return;
  }

  // 3) id 역참조(R-12). 미존재 404.
  const project = store.getById(body.id);
  if (!project) {
    sendJson(res, 404, { ok: false, code: 'ID_NOT_FOUND' });
    return;
  }

  // 4) 실경로 화이트리스트 검증(H-1). canonicalize 실패(소멸) → PATH_GONE.
  const real = pathGuard.canonicalize(project.path);
  if (real === null) {
    sendJson(res, 410, { ok: false, code: 'PATH_GONE' });
    return;
  }
  if (!pathGuard.isAllowed(project.path, store.getAllowKeySet())) {
    sendJson(res, 403, { ok: false, code: 'PATH_NOT_ALLOWED' });
    return;
  }

  // 5) code CLI 절대경로 해석(H-2). 미설치 → 계약 200 + ok:false CODE_CLI_NOT_FOUND.
  const codeBin = resolveBin('code');
  if (!codeBin) {
    sendJson(res, 200, {
      ok: false,
      code: 'CODE_CLI_NOT_FOUND',
      message: 'VS Code CLI(code)를 찾을 수 없습니다',
    });
    return;
  }

  // 6) safeExec spawn(shell:false, H-2) + id별 in-flight 상한(M-4).
  //    [P2-3 정정] "성공" = spawn 시작 성공. detached(fire-and-forget) 모드로 child 'spawn'
  //    이벤트 시점에 즉시 OPENING 응답하고, code 프로세스 종료를 기다리지 않는다(R-12 2초 피드백).
  //    spawn 실패(ENOENT 등)는 'error'로 reject되어 아래 catch에서 OPEN_FAILED로 구분.
  //    검증된 실경로(real)를 인자로 전달(TOCTOU 표면 축소).
  try {
    await safeExec(codeBin, [real], {
      shell: false,
      detached: true,
      inflightKey: 'open:' + body.id,
      maxInflight: MAX_INFLIGHT_PER_ID,
    });
    sendJson(res, 200, { ok: true, code: 'OPENING', message: 'VS Code에서 여는 중' });
  } catch (_) {
    // in-flight 초과/spawn 실패 — 내부정보 비노출(L-3).
    sendJson(res, 200, {
      ok: false,
      code: 'OPEN_FAILED',
      message: 'VS Code 실행을 시작하지 못했습니다',
    });
  }
}

/**
 * POST /api/rescan — 재스캔 트리거(R-16). 라우터가 checkStateChange(M-1)를 선통과시킨다.
 *
 *   1) 본문 파싱(16KB 상한). { withSize?, allDrives? } — 둘 다 선택.
 *   2) scanRoots 미설정이면 409 NO_SCAN_ROOTS.
 *   3) ScanController.acquire() — 락 실패(이미 진행 중)면 409 SCAN_IN_PROGRESS.
 *   4) 옵션 게이트(M4-M-1):
 *        · allDrives = config.allowAllDrives 게이트 전용(본문만으로는 못 켬 → 강등 + note).
 *        · withSize  = 본문 허용(예산 내). config.size.enabled를 덮어쓸 수 있음.
 *   5) start() 백그라운드 실행(대기 안 함) → 202 SCAN_STARTED{ scanId, startedAt }.
 *
 * 경로는 모두 서버 config에서 가져온다(본문으로 경로 안 받음 — H-1 정합).
 * @param {object} ctx { store, config, scanController, logger }
 */
async function rescan(req, res, ctx) {
  const controller = ctx.scanController;
  const config = ctx.config || {};
  const logger = ctx.logger;

  // 컨트롤러 미주입(이론상 없음) — 안전한 고정 응답(L-3).
  if (!controller || typeof controller.acquire !== 'function') {
    sendJson(res, 500, { ok: false, code: 'INTERNAL' });
    return;
  }

  const body = await readJsonBody(req);
  if (body === null) {
    // 잘못된 본문(비-JSON/상한 초과) — 빈 옵션으로 진행할 수도 있으나 명시적 거부가 안전.
    sendJson(res, 400, { ok: false, code: 'BAD_REQUEST' });
    return;
  }

  // 2) scanRoots 미설정 → 409 NO_SCAN_ROOTS.
  const roots = Array.isArray(config.scanRoots) ? config.scanRoots : [];
  if (roots.length === 0) {
    sendJson(res, 409, {
      ok: false,
      code: 'NO_SCAN_ROOTS',
      message: '스캔할 루트가 설정되어 있지 않습니다',
    });
    return;
  }

  // 4) 옵션 게이트(M4-M-1).
  const wantAllDrives = body.allDrives === true;
  const allowAllDrives = config.allowAllDrives === true;
  const effectiveAllDrives = wantAllDrives && allowAllDrives;
  let note = null;
  if (wantAllDrives && !allowAllDrives) {
    note = 'all-drives는 서버 설정에서 비활성'; // 강등 안내(textContent 렌더, L-1)
  }
  const withSize = body.withSize === true; // 본문 허용(예산 내 강제, size.js 가드)

  // all-drives 활성 시 드라이브/마운트 열거를 루트로 사용.
  let scanRoots = roots;
  if (effectiveAllDrives) {
    try {
      const enumerated = driveEnum.enumerateRoots({ logger });
      if (enumerated.length > 0) scanRoots = enumerated;
    } catch (err) {
      if (logger) logger.error('drive enumeration failed', err);
    }
  }

  // 3) 락 시도.
  const acquired = controller.acquire({ note });
  if (!acquired) {
    sendJson(res, 409, {
      ok: false,
      code: 'SCAN_IN_PROGRESS',
      scanId: controller.status().scanId,
    });
    return;
  }

  // 5) 백그라운드 실행(대기 안 함) → 202.
  controller.start({
    config,
    roots: scanRoots,
    withSize,
    allDrives: effectiveAllDrives,
    store: ctx.store,
    cachePath: ctx.cachePath, // [P2-2] finalizing write/load 경로 일관 전파
    logger,
  });

  sendJson(res, 202, {
    ok: true,
    code: 'SCAN_STARTED',
    scanId: acquired.scanId,
    startedAt: acquired.startedAt,
  });
}

module.exports = { open, rescan, readJsonBody, MAX_BODY_BYTES, MAX_INFLIGHT_PER_ID };
