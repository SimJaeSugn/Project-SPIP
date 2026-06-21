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
  "frame-ancestors 'none'",
].join('; ');

/** CSP 헤더 객체를 만든다(onHeadersReceived용). */
function buildCspHeader() {
  return { 'Content-Security-Policy': [CSP_POLICY] };
}

/**
 * 세션 응답 헤더에 CSP를 이중주입한다(EM-M-1).
 * @param {object} session Electron session(또는 { webRequest:{ onHeadersReceived } } 모킹)
 */
function applyCspHeaders(session) {
  if (!session || !session.webRequest || typeof session.webRequest.onHeadersReceived !== 'function') return;
  session.webRequest.onHeadersReceived((details, callback) => {
    const responseHeaders = Object.assign({}, details.responseHeaders, buildCspHeader());
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

module.exports = { TRUSTED_ORIGIN, CSP_POLICY, buildCspHeader, applyCspHeaders, hardenWebContents };
