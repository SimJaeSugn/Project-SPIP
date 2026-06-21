'use strict';
/**
 * lib/server/security.js — 상태변경 POST 경계 통제 (M-1, L-3, §11.3)
 *
 * 상태 변경 POST(/api/open 등)에 다음을 선통과시킨다(M-1):
 *   1) Host allowlist 정확 비교 — DNS 리바인딩 차단(Origin만으로 못 막는 우회).
 *      기대값: 127.0.0.1:<port> / localhost:<port>.
 *   2) Origin 폐쇄 기본값 — 없거나 불일치면 거부(FORBIDDEN_ORIGIN).
 *   3) 세션 토큰 — 기동 시 crypto로 생성한 토큰을 index.html에 주입, POST는
 *      X-SPIP-Token 헤더로 전송. 상수시간 비교로 누설 표면 축소.
 *   4) Content-Type: application/json 보조 검증.
 *
 * 실패 시 내부정보 비노출(L-3): { ok:false, code:'FORBIDDEN_ORIGIN' }만 반환.
 *
 * 외부 의존성 0 — crypto(내장)만.
 */

const crypto = require('crypto');

/** 기동 시 1회 세션 토큰 생성(crypto). URL/HTML 안전 16진수. */
function generateSessionToken() {
  return crypto.randomBytes(32).toString('hex');
}

/** 길이 비의존 상수시간 문자열 비교(타이밍 누설 축소). */
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  try {
    return crypto.timingSafeEqual(ba, bb);
  } catch (_) {
    return false;
  }
}

/**
 * 기대 Host allowlist 집합을 구성한다(정확 비교용).
 * @param {number} port
 * @returns {Set<string>}
 */
function buildHostAllowlist(port) {
  return new Set([
    '127.0.0.1:' + port,
    'localhost:' + port,
  ]);
}

/**
 * 기대 Origin allowlist 집합을 구성한다.
 * @param {number} port
 * @returns {Set<string>}
 */
function buildOriginAllowlist(port) {
  return new Set([
    'http://127.0.0.1:' + port,
    'http://localhost:' + port,
  ]);
}

/**
 * 상태변경 POST 경계 통제를 검사한다(M-1).
 * @param {http.IncomingMessage} req
 * @param {object} ctx { hostAllow:Set, originAllow:Set, token:string }
 * @returns {{ ok:true } | { ok:false, code:'FORBIDDEN_ORIGIN' }}
 */
function checkStateChange(req, ctx) {
  const headers = req.headers || {};

  // 1) Host allowlist 정확 비교(M-1: DNS 리바인딩 차단).
  const host = headers['host'];
  if (typeof host !== 'string' || !ctx.hostAllow.has(host)) {
    return { ok: false, code: 'FORBIDDEN_ORIGIN' };
  }

  // 2) Origin 폐쇄 기본값 — 없거나 불일치면 거부.
  const origin = headers['origin'];
  if (typeof origin !== 'string' || !ctx.originAllow.has(origin)) {
    return { ok: false, code: 'FORBIDDEN_ORIGIN' };
  }

  // 3) 세션 토큰(X-SPIP-Token) — 누락/불일치 거부.
  const token = headers['x-spip-token'];
  if (!safeEqual(token, ctx.token)) {
    return { ok: false, code: 'FORBIDDEN_ORIGIN' };
  }

  // 4) Content-Type 보조 검증(application/json).
  const ctype = headers['content-type'];
  if (typeof ctype !== 'string' || !/^application\/json\b/i.test(ctype.trim())) {
    return { ok: false, code: 'FORBIDDEN_ORIGIN' };
  }

  return { ok: true };
}

/**
 * [M4-H-1] 읽기 게이트 — scan-status(GET)처럼 민감 데이터(진행 경로·식별자)를 노출하는
 * 읽기 엔드포인트용. checkStateChange와 1·2·3요소(Host·Origin·토큰)는 공유하되, 본문 없는
 * 폴링 GET을 위해 Content-Type(4요소)만 면제한다. 무인증 로컬 폴러(RC-1) 차단 + DNS
 * 리바인딩·CSRF식 정보유출 방지. 대시보드는 토큰 보유 → 동일출처 fetch로 통과.
 * @param {http.IncomingMessage} req
 * @param {object} ctx { hostAllow:Set, originAllow:Set, token:string }
 * @returns {{ ok:true } | { ok:false, code:'FORBIDDEN_ORIGIN' }}
 */
function checkReadAccess(req, ctx) {
  const headers = req.headers || {};

  // 1) Host allowlist 정확 비교(DNS 리바인딩 차단).
  const host = headers['host'];
  if (typeof host !== 'string' || !ctx.hostAllow.has(host)) {
    return { ok: false, code: 'FORBIDDEN_ORIGIN' };
  }

  // 2) Origin 폐쇄 기본값.
  const origin = headers['origin'];
  if (typeof origin !== 'string' || !ctx.originAllow.has(origin)) {
    return { ok: false, code: 'FORBIDDEN_ORIGIN' };
  }

  // 3) 세션 토큰(X-SPIP-Token).
  const token = headers['x-spip-token'];
  if (!safeEqual(token, ctx.token)) {
    return { ok: false, code: 'FORBIDDEN_ORIGIN' };
  }

  // 4) Content-Type은 면제(본문 없는 GET).
  return { ok: true };
}

module.exports = {
  generateSessionToken,
  safeEqual,
  buildHostAllowlist,
  buildOriginAllowlist,
  checkStateChange,
  checkReadAccess,
};
