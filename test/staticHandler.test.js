'use strict';
/**
 * staticHandler.test.js — P1-1 매핑·public 이탈 차단·MIME·CSP·토큰 주입 (N-03, P1-1, L-1, M-1)
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const staticHandler = require('../lib/server/staticHandler');

/** http.ServerResponse 모킹(테스트용). */
function mockRes() {
  return {
    statusCode: null,
    headers: null,
    body: null,
    writeHead(status, headers) { this.statusCode = status; this.headers = headers; },
    end(buf) { this.body = buf == null ? '' : (Buffer.isBuffer(buf) ? buf.toString('utf8') : buf); },
  };
}

function setupPublic() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spip-pub-'));
  fs.writeFileSync(path.join(root, 'index.html'),
    '<!doctype html><meta name="spip-session-token" content="__SPIP_SESSION_TOKEN__"><h1>SPIP</h1>');
  fs.writeFileSync(path.join(root, 'app.js'), 'console.log(1);');
  fs.writeFileSync(path.join(root, 'app.css'), 'body{}');
  return root;
}

test('GET / → index.html + 토큰 주입 + CSP (P1-1, L-1, M-1)', () => {
  const root = setupPublic();
  const res = mockRes();
  staticHandler.handle({ url: '/' }, res, { publicRoot: root, token: 'deadbeef' });
  assert.strictEqual(res.statusCode, 200);
  assert.match(res.headers['Content-Type'], /text\/html/);
  assert.ok(res.headers['Content-Security-Policy'].includes("default-src 'self'"));
  assert.ok(res.body.includes('content="deadbeef"'));
  assert.ok(!res.body.includes('__SPIP_SESSION_TOKEN__'));
});

test('GET /static/app.js → public/app.js + MIME', () => {
  const root = setupPublic();
  const res = mockRes();
  staticHandler.handle({ url: '/static/app.js' }, res, { publicRoot: root, token: 't' });
  assert.strictEqual(res.statusCode, 200);
  assert.match(res.headers['Content-Type'], /javascript/);
  assert.strictEqual(res.body, 'console.log(1);');
});

test('GET /static/app.css → text/css', () => {
  const root = setupPublic();
  const res = mockRes();
  staticHandler.handle({ url: '/static/app.css' }, res, { publicRoot: root, token: 't' });
  assert.strictEqual(res.statusCode, 200);
  assert.match(res.headers['Content-Type'], /text\/css/);
});

test('public 이탈(../) → 404 (N-03)', () => {
  const root = setupPublic();
  // 부모에 비밀 파일 배치.
  fs.writeFileSync(path.join(root, '..', 'secret.txt'), 'top secret');
  const res = mockRes();
  staticHandler.handle({ url: '/static/../secret.txt' }, res, { publicRoot: root, token: 't' });
  assert.strictEqual(res.statusCode, 404);
});

test('인코딩된 이탈(%2e%2e) → 404', () => {
  const root = setupPublic();
  const res = mockRes();
  staticHandler.handle({ url: '/static/%2e%2e/%2e%2e/etc' }, res, { publicRoot: root, token: 't' });
  assert.strictEqual(res.statusCode, 404);
});

test('널바이트 → 404', () => {
  const root = setupPublic();
  const res = mockRes();
  staticHandler.handle({ url: '/static/app.js%00.png' }, res, { publicRoot: root, token: 't' });
  assert.strictEqual(res.statusCode, 404);
});

test('미존재 자산 → 404', () => {
  const root = setupPublic();
  const res = mockRes();
  staticHandler.handle({ url: '/static/missing.js' }, res, { publicRoot: root, token: 't' });
  assert.strictEqual(res.statusCode, 404);
});

test('매핑 외 경로(/foo) → 404', () => {
  const root = setupPublic();
  const res = mockRes();
  staticHandler.handle({ url: '/foo/bar' }, res, { publicRoot: root, token: 't' });
  assert.strictEqual(res.statusCode, 404);
});

test('HEAD /static/app.js → 헤더(Content-Length)만, 본문 미전송 (P2-6)', () => {
  const root = setupPublic();
  const res = mockRes();
  staticHandler.handle({ url: '/static/app.js', method: 'HEAD' }, res, { publicRoot: root, token: 't' });
  assert.strictEqual(res.statusCode, 200);
  assert.match(res.headers['Content-Type'], /javascript/);
  // GET과 동일한 Content-Length 헤더는 유지하되 본문은 비어 있어야 함.
  assert.strictEqual(res.headers['Content-Length'], Buffer.byteLength('console.log(1);', 'utf8'));
  assert.strictEqual(res.body, '');
});

test('HEAD / → 헤더만, 본문 미전송 (P2-6)', () => {
  const root = setupPublic();
  const res = mockRes();
  staticHandler.handle({ url: '/', method: 'HEAD' }, res, { publicRoot: root, token: 'deadbeef' });
  assert.strictEqual(res.statusCode, 200);
  assert.match(res.headers['Content-Type'], /text\/html/);
  assert.ok(typeof res.headers['Content-Length'] === 'number' && res.headers['Content-Length'] > 0);
  assert.strictEqual(res.body, ''); // 본문 없음(토큰 주입된 HTML도 미전송)
});

test('HEAD 미존재 자산 → 404 헤더만 (P2-6)', () => {
  const root = setupPublic();
  const res = mockRes();
  staticHandler.handle({ url: '/static/missing.js', method: 'HEAD' }, res, { publicRoot: root, token: 't' });
  assert.strictEqual(res.statusCode, 404);
  assert.strictEqual(res.body, '');
});
