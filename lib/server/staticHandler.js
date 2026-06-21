'use strict';
/**
 * lib/server/staticHandler.js — 정적 자산 서빙 (R-10, N-03, P1-1, L-1)
 *
 * [P1-1 통일 규약]
 *   GET /              → public/index.html
 *   GET /static/<asset> → public/<asset>
 * 매핑 후 경로를 public/ 절대경로 하위로 정규화(realpath)해 이탈 시 404(N-03).
 * 프로젝트 폴더 파일은 절대 서빙하지 않는다. /api/* 외 GET만 처리한다.
 *
 * [L-1] CSP 헤더를 함께 부여: default-src 'self', 인라인 스크립트 금지, 동일 출처 자산만.
 * [세션토큰] index.html 서빙 시 플레이스홀더(__SPIP_SESSION_TOKEN__)를 실제 토큰으로 치환해
 *   프론트(meta[name="spip-session-token"])가 X-SPIP-Token 헤더로 재전송할 수 있게 주입한다
 *   (M-1, 프론트 계약 보강 — 프론트 S6 합의 플레이스홀더/메타명에 맞춤).
 *
 * 외부 의존성 0 — fs, path(내장)만.
 */

const fs = require('fs');
const path = require('path');

// public/ 절대경로 루트(서빙 화이트리스트 베이스). 프로젝트 루트 기준 고정.
const PUBLIC_ROOT = path.resolve(__dirname, '..', '..', 'public');

// index.html에 주입할 토큰 플레이스홀더(프론트 S6 합의: meta[name="spip-session-token"]).
const TOKEN_PLACEHOLDER = '__SPIP_SESSION_TOKEN__';

// 확장자 → MIME. 화이트리스트(미지정 확장자는 octet-stream).
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

// L-1 CSP: 동일 출처만, 인라인 스크립트 금지(주입은 meta 태그값 치환이라 스크립트 인라인 아님).
const CSP =
  "default-src 'self'; " +
  "script-src 'self'; " +
  "style-src 'self'; " +
  "img-src 'self' data:; " +
  "connect-src 'self'; " +
  "font-src 'self'; " +
  "base-uri 'none'; " +
  "form-action 'none'; " +
  "frame-ancestors 'none'; " +
  "object-src 'none'";

function mimeFor(filePath) {
  return MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

/** 보안·캐시 공통 헤더. */
function baseHeaders(contentType, bytes) {
  return {
    'Content-Type': contentType,
    'Content-Length': bytes,
    'Content-Security-Policy': CSP,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store',
  };
}

function send404(res, isHead) {
  const body = 'Not Found';
  res.writeHead(404, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(body, 'utf8'),
    'Content-Security-Policy': CSP,
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(isHead ? undefined : body); // P2-6: HEAD는 본문 미전송(Content-Length 유지)
}

/**
 * 요청 URL 경로를 public/ 하위 절대경로로 매핑한다(P1-1).
 *   '/'          → public/index.html
 *   '/static/x'  → public/x
 *   그 외        → null(이 핸들러 대상 아님)
 * 매핑 후 public/ 하위 이탈은 호출부에서 정규화 검증.
 * @param {string} urlPath URL의 path 컴포넌트(쿼리 제외, 디코드 후)
 * @returns {string|null} public 하위 상대 자산 경로 또는 null
 */
function mapToAsset(urlPath) {
  if (urlPath === '/' || urlPath === '/index.html') return 'index.html';
  if (urlPath.startsWith('/static/')) {
    return urlPath.slice('/static/'.length);
  }
  return null;
}

/**
 * 정적 요청을 처리한다.
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 * @param {object} ctx { token:string, urlPath?:string }
 */
function handle(req, res, ctx) {
  ctx = ctx || {};
  // publicRoot는 테스트 주입용(미지정 시 고정 PUBLIC_ROOT). 서비스 경로는 항상 PUBLIC_ROOT.
  const root = typeof ctx.publicRoot === 'string' ? path.resolve(ctx.publicRoot) : PUBLIC_ROOT;
  // [P2-6] HEAD 요청은 HTTP 규약상 헤더만 전송(본문 미전송). Content-Length 등은 GET과 동일.
  const isHead = (req && req.method) === 'HEAD';

  // URL path 컴포넌트 추출(쿼리 제거) + 안전 디코드.
  let urlPath = ctx.urlPath;
  if (typeof urlPath !== 'string') {
    const raw = req.url || '/';
    urlPath = raw.split('?')[0].split('#')[0];
  }
  try {
    urlPath = decodeURIComponent(urlPath);
  } catch (_) {
    return send404(res, isHead); // 잘못된 퍼센트 인코딩 → 거부
  }

  // 널바이트/제어 흔적 차단.
  if (urlPath.indexOf('\0') !== -1) return send404(res, isHead);

  const asset = mapToAsset(urlPath);
  if (asset === null) return send404(res, isHead);

  // public/ 절대경로 하위로 정규화. resolve는 '../'를 접는다.
  const resolved = path.resolve(root, asset);

  // 이탈 차단: resolved가 root 하위(또는 동일)인지 정확 검사(N-03).
  const rel = path.relative(root, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return send404(res, isHead);
  }

  // 심링크 경유 이탈까지 차단: realpath 후 다시 하위 검증(가능할 때).
  let realResolved = resolved;
  try {
    realResolved = fs.realpathSync.native
      ? fs.realpathSync.native(resolved)
      : fs.realpathSync(resolved);
    const realRel = path.relative(root, realResolved);
    if (realRel.startsWith('..') || path.isAbsolute(realRel)) {
      return send404(res, isHead);
    }
  } catch (_) {
    // 파일 부재 등 → 아래 read에서 404 처리.
    realResolved = resolved;
  }

  let st;
  try {
    st = fs.statSync(realResolved);
  } catch (_) {
    return send404(res, isHead);
  }
  if (!st.isFile()) return send404(res, isHead);

  const isIndex = asset === 'index.html';

  let buf;
  try {
    buf = fs.readFileSync(realResolved);
  } catch (_) {
    return send404(res, isHead);
  }

  if (isIndex) {
    // 세션 토큰 주입: 플레이스홀더 치환(M-1). 토큰은 16진수라 HTML 안전.
    let html = buf.toString('utf8');
    const token = typeof ctx.token === 'string' ? ctx.token : '';
    html = html.split(TOKEN_PLACEHOLDER).join(token);
    const out = Buffer.from(html, 'utf8');
    res.writeHead(200, baseHeaders('text/html; charset=utf-8', out.length));
    res.end(isHead ? undefined : out); // HEAD: 헤더만(Content-Length 유지), 본문 없음
    return;
  }

  res.writeHead(200, baseHeaders(mimeFor(realResolved), buf.length));
  res.end(isHead ? undefined : buf); // HEAD: 헤더만, 본문 없음
}

module.exports = { handle, mapToAsset, mimeFor, PUBLIC_ROOT, TOKEN_PLACEHOLDER, CSP };
