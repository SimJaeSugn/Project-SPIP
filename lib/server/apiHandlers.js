'use strict';
/**
 * lib/server/apiHandlers.js — 데이터 조회 API (R-10, R-13, 계약 §9)
 *
 *   GET /api/projects → { schemaVersion, generatedAt, hasSnapshot, projects: Project[] }
 *   GET /api/stats    → { total, byLanguage:{lang:count}, staleCount, totalBytes:null, generatedAt }
 *   GET /api/health   → { ok:true, hasSnapshot, codeCli:boolean, git:boolean }
 *
 * [P2-5] 스냅샷 부재/손상 시에도 503이 아니라 200 + hasSnapshot:false + 빈 배열로 응답.
 * 통계 집계는 서버가 계산(필터/정렬/검색은 클라 담당).
 *
 * 외부 의존성 0 — 내부(safeExec resolveBin)만.
 */

const { resolveBin } = require('../common/safeExec');

/** JSON 응답 헬퍼(계약: application/json; charset=utf-8). */
function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload, 'utf8'),
    // 데이터 조회 응답은 캐시 금지(항상 메모리 최신).
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

/** GET /api/projects — 적재된 스냅샷을 그대로 노출(계약 shape). */
function getProjects(req, res, ctx) {
  const store = ctx.store;
  sendJson(res, 200, {
    schemaVersion: store.schemaVersion,
    generatedAt: store.generatedAt,
    hasSnapshot: store.hasSnapshot,
    projects: store.getProjects(),
  });
}

/**
 * GET /api/stats — total·byLanguage·staleCount·totalBytes(null)·generatedAt.
 * byLanguage는 language.primary 기준 count 집계.
 */
function getStats(req, res, ctx) {
  const store = ctx.store;
  const projects = store.getProjects();

  const byLanguage = {};
  let staleCount = 0;
  for (const p of projects) {
    const lang =
      p && p.language && typeof p.language.primary === 'string' && p.language.primary
        ? p.language.primary
        : 'Unknown';
    byLanguage[lang] = (byLanguage[lang] || 0) + 1;
    if (p && p.freshness && p.freshness.isStale) staleCount++;
  }

  sendJson(res, 200, {
    total: projects.length,
    byLanguage,
    staleCount,
    // [M4 §4.3] 스냅샷에 저장된 합계를 읽기만(스캐너가 집계). 미측정 스냅샷이면 null(P2-2 호환).
    totalBytes: store.stats && typeof store.stats.totalBytes === 'number' ? store.stats.totalBytes : null,
    generatedAt: store.generatedAt,
  });
}

/**
 * GET /api/health — { ok:true, hasSnapshot, codeCli, git }.
 * codeCli/git은 실행 파일 절대경로 해석 가능 여부(resolveBin, H-2)로 판정.
 */
function getHealth(req, res, ctx) {
  const store = ctx.store;
  const codeCli = !!resolveBin('code');
  const git = !!resolveBin('git');
  sendJson(res, 200, {
    ok: true,
    hasSnapshot: store.hasSnapshot,
    codeCli,
    git,
  });
}

/**
 * GET /api/scan-status — ScanController 진행 스냅샷(R-15, M4-H-1).
 * 라우터가 checkReadAccess(Host+Origin+X-SPIP-Token, CT 면제)를 선통과시킨다.
 * currentPath는 ScanController가 basename 축약(절대경로 미노출, M4-H-1).
 */
function getScanStatus(req, res, ctx) {
  const controller = ctx.scanController;
  if (!controller || typeof controller.status !== 'function') {
    // 컨트롤러 미주입(이론상 없음) — idle로 안전 응답(내부정보 비노출, L-3).
    sendJson(res, 200, {
      phase: 'idle', scanId: null, dirs: 0, found: 0, currentPath: null,
      elapsedMs: 0, startedAt: null, counts: null, note: null,
    });
    return;
  }
  sendJson(res, 200, controller.status());
}

module.exports = { getProjects, getStats, getHealth, getScanStatus, sendJson };
