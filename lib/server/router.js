'use strict';
/**
 * lib/server/router.js — 메서드·경로 매칭 디스패치 (R-10)
 *
 * 비즈니스 로직 없음 — 순수 라우팅만.
 *   /api/*  → API/액션 핸들러(메서드별)
 *   그 외 GET → staticHandler
 *
 * 상태변경 POST(/api/open)는 security.checkStateChange(M-1)를 선통과시킨 뒤
 * actionHandler로 넘긴다. 미매칭/미허용 메서드는 안전한 고정 응답(L-3).
 *
 * 외부 의존성 0 — 내부 핸들러/보안만.
 */

const apiHandlers = require('./apiHandlers');
const actionHandlers = require('./actionHandlers');
const staticHandler = require('./staticHandler');
const security = require('./security');
const { sendJson } = require('./apiHandlers');

/** 요청 URL의 path 컴포넌트(쿼리/프래그먼트 제거). */
function pathOf(req) {
  const raw = req.url || '/';
  return raw.split('?')[0].split('#')[0];
}

/**
 * 라우팅 핸들러를 생성한다(클로저로 ctx 고정).
 * @param {object} ctx { store, token, hostAllow, originAllow }
 * @returns {(req,res)=>void} http 요청 핸들러
 */
function createHandler(ctx) {
  return function handle(req, res) {
    let urlPath;
    try {
      urlPath = pathOf(req);
    } catch (_) {
      sendJson(res, 404, { ok: false, code: 'NOT_FOUND' });
      return;
    }
    const method = req.method || 'GET';

    // /api/* 라우팅.
    if (urlPath === '/api/projects') {
      if (method !== 'GET') return methodNotAllowed(res);
      return apiHandlers.getProjects(req, res, ctx);
    }
    if (urlPath === '/api/stats') {
      if (method !== 'GET') return methodNotAllowed(res);
      return apiHandlers.getStats(req, res, ctx);
    }
    if (urlPath === '/api/health') {
      if (method !== 'GET') return methodNotAllowed(res);
      return apiHandlers.getHealth(req, res, ctx);
    }
    if (urlPath === '/api/open') {
      if (method !== 'POST') return methodNotAllowed(res);
      // [M-1] 상태변경 경계 통제 선통과.
      const guard = security.checkStateChange(req, ctx);
      if (!guard.ok) {
        sendJson(res, 403, { ok: false, code: guard.code });
        return;
      }
      return actionHandlers.open(req, res, ctx);
    }
    if (urlPath === '/api/rescan') {
      // [P1-2/C-1] POST 한정 + checkStateChange(M-1) 선통과(open과 동형). 메서드 무관 404 폐기.
      if (method !== 'POST') return methodNotAllowed(res);
      const guard = security.checkStateChange(req, ctx);
      if (!guard.ok) {
        sendJson(res, 403, { ok: false, code: guard.code });
        return;
      }
      return actionHandlers.rescan(req, res, ctx);
    }
    if (urlPath === '/api/scan-status') {
      // [M4-H-1/C-1] GET 한정 + checkReadAccess(Host+Origin+토큰, CT 면제) 읽기 게이트.
      if (method !== 'GET') return methodNotAllowed(res);
      const guard = security.checkReadAccess(req, ctx);
      if (!guard.ok) {
        sendJson(res, 403, { ok: false, code: guard.code });
        return;
      }
      return apiHandlers.getScanStatus(req, res, ctx);
    }

    // 그 외 /api/* 는 404(정적 서빙 대상 아님).
    if (urlPath.startsWith('/api/')) {
      return sendJson(res, 404, { ok: false, code: 'NOT_FOUND' });
    }

    // 그 외 GET → 정적 서빙. 비-GET은 405.
    if (method !== 'GET' && method !== 'HEAD') {
      return methodNotAllowed(res);
    }
    return staticHandler.handle(req, res, { token: ctx.token, urlPath });
  };
}

function methodNotAllowed(res) {
  sendJson(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED' });
}

module.exports = { createHandler, pathOf };
