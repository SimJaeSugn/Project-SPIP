'use strict';
/**
 * electron-security.test.js — electron/security.js + register.js senderFrame 검증 (EM-M-1/M-2, 헤드리스)
 */
const { test } = require('node:test');
const assert = require('node:assert');

const security = require('../electron/security');
const { isTrustedSender } = require('../electron/ipc/register');

test('CSP_POLICY — default-src none 기반 전 디렉티브 보존', () => {
  const p = security.CSP_POLICY;
  for (const d of [
    "default-src 'none'", "script-src 'self'", "style-src 'self'", "img-src 'self' data:",
    "font-src 'self'", "connect-src 'none'", "object-src 'none'", "base-uri 'none'",
    "form-action 'none'", "frame-ancestors 'none'",
  ]) {
    assert.ok(p.includes(d), '누락 디렉티브: ' + d);
  }
});

test('buildCspHeader — onHeadersReceived 형태', () => {
  const h = security.buildCspHeader();
  assert.ok(Array.isArray(h['Content-Security-Policy']));
  assert.strictEqual(h['Content-Security-Policy'][0], security.CSP_POLICY);
});

test('applyCspHeaders — 응답 헤더에 CSP 주입', () => {
  let registered = null;
  const session = { webRequest: { onHeadersReceived: (cb) => { registered = cb; } } };
  security.applyCspHeaders(session);
  let result = null;
  registered({ responseHeaders: { 'X-Existing': ['1'] } }, (out) => { result = out; });
  assert.ok(result.responseHeaders['Content-Security-Policy']);
  assert.deepStrictEqual(result.responseHeaders['X-Existing'], ['1']); // 기존 보존
});

test('[메일 뷰어] cspForUrl — 이메일 문서엔 격리 CSP(스크립트 금지), 그 외엔 앱 CSP', () => {
  // 일반 URL → 스트릭트 앱 CSP.
  assert.strictEqual(security.cspForUrl('app://index.html'), security.CSP_POLICY);
  // app://mailbody → 이메일 CSP: 스크립트 금지, 인라인 스타일 허용, 원격 이미지 기본 차단.
  const mc = security.cspForUrl('app://mailbody/view?n=3');
  assert.ok(/script-src 'none'/.test(mc), '스크립트 전면 금지');
  assert.ok(/style-src 'unsafe-inline'/.test(mc), '인라인 스타일 허용');
  assert.ok(/img-src data:(?!.*https)/.test(mc), '원격 이미지 기본 차단(data:만)');
  // ?img=1 → 원격 이미지 허용.
  const mcImg = security.cspForUrl('app://mailbody/view?n=3&img=1');
  assert.ok(/img-src data: https: http:/.test(mcImg), 'opt-in 시 원격 이미지 허용');
  assert.strictEqual(security.isMailViewUrl('app://mailbody/x'), true);
  assert.strictEqual(security.isMailViewUrl('app://index.html'), false);
});

test('[메일 뷰어] applyCspHeaders — mailbody URL엔 이메일 CSP, 기존 CSP 헤더는 교체', () => {
  let cb = null;
  security.applyCspHeaders({ webRequest: { onHeadersReceived: (f) => { cb = f; } } });
  let out = null;
  cb({ url: 'app://mailbody/view', responseHeaders: { 'content-security-policy': ['old'] } }, (r) => { out = r; });
  const csp = out.responseHeaders['Content-Security-Policy'][0];
  assert.ok(/script-src 'none'/.test(csp));
  // 소문자 기존 CSP 헤더는 제거됨(중복 주입 방지).
  assert.ok(!out.responseHeaders['content-security-policy']);
});

test('hardenWebContents — will-navigate 차단(우리 origin 외)', () => {
  const handlers = {};
  let openHandler = null;
  const wc = {
    on: (ev, cb) => { handlers[ev] = cb; },
    setWindowOpenHandler: (cb) => { openHandler = cb; },
  };
  security.hardenWebContents(wc, { trustedOrigin: 'app://' });

  let prevented = false;
  handlers['will-navigate']({ preventDefault: () => { prevented = true; } }, 'https://evil.example');
  assert.strictEqual(prevented, true);

  prevented = false;
  handlers['will-navigate']({ preventDefault: () => { prevented = true; } }, 'app://index.html');
  assert.strictEqual(prevented, false); // 우리 origin은 허용

  // setWindowOpenHandler는 모두 deny.
  assert.deepStrictEqual(openHandler(), { action: 'deny' });

  // webview attach 거부.
  let webviewPrevented = false;
  handlers['will-attach-webview']({ preventDefault: () => { webviewPrevented = true; } });
  assert.strictEqual(webviewPrevented, true);
});

// ── isTrustedSender (EM-M-2) ──
test('isTrustedSender — app:// origin 허용', () => {
  assert.strictEqual(isTrustedSender({ senderFrame: { url: 'app://index.html' } }), true);
});

test('isTrustedSender — 외부 origin 거부', () => {
  assert.strictEqual(isTrustedSender({ senderFrame: { url: 'https://evil.example' } }), false);
  assert.strictEqual(isTrustedSender({ senderFrame: { url: 'file:///c/x.html' } }), false); // allowFileUrl 기본 false
  assert.strictEqual(isTrustedSender({ senderFrame: null }), false);
  assert.strictEqual(isTrustedSender({}), false);
});

test('isTrustedSender — allowFileUrl 옵션 시 file:// 허용', () => {
  assert.strictEqual(isTrustedSender({ senderFrame: { url: 'file:///c/x.html' } }, { allowFileUrl: true }), true);
});

// ── EI-L-1: 접두 매칭이 아니라 정확 스킴/origin 매칭 ──
test('isTrustedSender — EI-L-1: app: opaque/이탈 origin 거부(접두 매칭 금지)', () => {
  // opaque 'app:anything'(// 없음) — 접두 매칭이면 통과했을 비정상 origin → 거부.
  assert.strictEqual(isTrustedSender({ senderFrame: { url: 'app:anything' } }), false);
  assert.strictEqual(isTrustedSender({ senderFrame: { origin: 'app:anything' } }), false);
  // 경로 이탈 host — 거부.
  assert.strictEqual(isTrustedSender({ senderFrame: { url: 'app://../../etc' } }), false);
  // 스킴 혼동(app-evil://) — 거부.
  assert.strictEqual(isTrustedSender({ senderFrame: { url: 'app-evil://index.html' } }), false);
  // 파싱 불가 문자열 — 거부.
  assert.strictEqual(isTrustedSender({ senderFrame: { url: 'not a url' } }), false);
});

test('isTrustedSender — EI-L-1: 정상 app:// 자산 origin은 여전히 허용', () => {
  assert.strictEqual(isTrustedSender({ senderFrame: { url: 'app://index.html' } }), true);
  assert.strictEqual(isTrustedSender({ senderFrame: { origin: 'app://index.html' } }), true);
  assert.strictEqual(isTrustedSender({ senderFrame: { url: 'app://index.html/sub/app.js' } }), true);
});
