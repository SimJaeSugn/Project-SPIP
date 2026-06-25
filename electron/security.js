'use strict';
/**
 * electron/security.js — Electron 보안 베이스라인 헬퍼 (electron-migration §6.2)
 *
 *   · CSP_POLICY: default-src 'none' 기반 전 디렉티브(§6.2 권장 정책).
 *   · applyCspHeaders: session.webRequest.onHeadersReceived로 CSP 헤더 이중주입(EM-M-1).
 *   · hardenWebContents: will-navigate 차단·setWindowOpenHandler:deny·webview 거부(§6.2).
 *
 * CSP_POLICY·buildCspHeader는 순수 값/함수로 분리해 단위테스트한다(Electron 미설치).
 * applyCspHeaders/hardenWebContents는 session/webContents 모킹으로 호출 검증 가능.
 */

// [P3-4] 신뢰 origin 단일 원천. main.js·register.js가 이 상수를 재사용한다(리터럴 이중정의 제거).
const TRUSTED_ORIGIN = 'app://';

// §6.2 권장 정책. app:// origin에서 'self'는 app:// 자원을 의미.
// connect-src 'none' — IPC만 쓰므로 네트워크 fetch 불필요.
const CSP_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  // [메일 뷰어] 격리 이메일 뷰어(app://index.html?mailview=1 — 메인과 동일 origin)를 같은 origin iframe으로 임베드 허용.
  "frame-src 'self'",
  "frame-ancestors 'none'",
].join('; ');

// [메일 뷰어] 격리 이메일 뷰어는 메인 페이지와 **동일 origin**(app://index.html)에 ?mailview=1로 서빙한다.
//   → 'self' 프레이밍이 표준대로 동작(다른 host면 origin이 갈려 frame-src/frame-ancestors가 막힌다).
//   이 URL 응답에만 이메일용 CSP를 부여해, 앱 전체 스트릭트 CSP는 그대로 유지한다(스크립트는 항상 금지).
const MAIL_VIEW_PARAM = 'mailview';

/** url이 격리 이메일 뷰어 문서(…?mailview=1)인가. */
function isMailViewUrl(url) {
  try { return new URL(String(url)).searchParams.get(MAIL_VIEW_PARAM) === '1'; } catch (_) { return false; }
}

/**
 * [메일 뷰어] 이메일 문서 전용 CSP. 스크립트 전면 금지(script-src 'none'), 인라인 스타일만 허용,
 *   이미지는 기본 data:만(원격 차단=트래킹 픽셀 방지). showImages=true면 원격 이미지 허용(사용자 opt-in).
 * @param {boolean} showImages
 */
function buildMailCsp(showImages) {
  const remote = showImages ? ' https: http:' : '';
  return [
    "default-src 'none'",
    "script-src 'none'",
    "style-src 'unsafe-inline'",
    'img-src data:' + remote,
    'media-src data:' + remote,
    'font-src data:',
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'self'", // 같은 origin(메인 app://index.html)만 임베드 가능
  ].join('; ');
}

/** url별 적용할 CSP 문자열. 이메일 뷰어 문서면 이메일 CSP(?img=1 시 원격 이미지 허용), 그 외는 스트릭트 앱 CSP. */
function cspForUrl(url) {
  if (isMailViewUrl(url)) return buildMailCsp(/[?&]img=1(?:&|$)/.test(String(url || '')));
  return CSP_POLICY;
}

/** CSP 헤더 객체를 만든다(onHeadersReceived용). */
function buildCspHeader() {
  return { 'Content-Security-Policy': [CSP_POLICY] };
}

/**
 * 세션 응답 헤더에 CSP를 주입한다(EM-M-1). 이메일 뷰어 문서(app://mailbody)에는 격리된 이메일 CSP를,
 *   그 외 모든 응답에는 스트릭트 앱 CSP를 준다(기존 CSP 헤더는 제거 후 주입 — 대소문자 변형 대비).
 * @param {object} session Electron session(또는 { webRequest:{ onHeadersReceived } } 모킹)
 */
function applyCspHeaders(session) {
  if (!session || !session.webRequest || typeof session.webRequest.onHeadersReceived !== 'function') return;
  session.webRequest.onHeadersReceived((details, callback) => {
    const responseHeaders = Object.assign({}, details.responseHeaders);
    for (const k of Object.keys(responseHeaders)) {
      if (k.toLowerCase() === 'content-security-policy') delete responseHeaders[k];
    }
    responseHeaders['Content-Security-Policy'] = [cspForUrl(details.url)];
    callback({ responseHeaders });
  });
}

/**
 * webContents 하드닝(§6.2):
 *   · will-navigate: 우리 origin 외 탐색 차단.
 *   · setWindowOpenHandler: 모든 새 창/팝업 deny.
 *   · will-attach-webview: webview 생성 거부.
 * @param {object} webContents Electron webContents(또는 { on, setWindowOpenHandler } 모킹)
 * @param {object} [opts] { trustedOrigin }
 */
function hardenWebContents(webContents, opts) {
  opts = opts || {};
  const trusted = opts.trustedOrigin || 'app://';
  if (!webContents || typeof webContents.on !== 'function') return;

  webContents.on('will-navigate', (event, url) => {
    if (typeof url !== 'string' || !url.startsWith(trusted)) {
      if (typeof event.preventDefault === 'function') event.preventDefault();
    }
  });

  if (typeof webContents.setWindowOpenHandler === 'function') {
    webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  }

  webContents.on('will-attach-webview', (event) => {
    if (typeof event.preventDefault === 'function') event.preventDefault();
  });
}

module.exports = { TRUSTED_ORIGIN, CSP_POLICY, buildCspHeader, applyCspHeaders, hardenWebContents, MAIL_VIEW_PARAM, isMailViewUrl, buildMailCsp, cspForUrl };
