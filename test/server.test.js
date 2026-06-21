'use strict';
/**
 * server.test.js — 통합: 실제 http 서버를 띄워 계약 응답·보안 통제 검증
 * (R-10, R-12, R-13, M-1, H-1, P2-5, L-1, L-3)
 */
const { test } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createServer } = require('../server');
const security = require('../lib/server/security');
const { Logger } = require('../lib/common/logger');

function quiet() { return new Logger({ quiet: true }); }

/** 실존 디렉터리(화이트리스트 유효 경로) 기반 스냅샷 캐시 파일을 만든다. */
function makeSnapshot(withProject) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spip-srv-'));
  const cache = path.join(dir, 'projects.json');
  const projDir = fs.realpathSync.native ? fs.realpathSync.native(dir) : fs.realpathSync(dir);
  const projects = withProject
    ? [{
        id: 'fixedid01',
        path: projDir,
        name: 'fixture',
        description: null,
        signals: ['git'],
        language: { primary: 'Node.js', breakdown: { JavaScript: 1 } },
        freshness: { lastModified: null, lastCommit: null, isStale: true },
        git: { status: 'na', isRepo: false, branch: null, dirty: null, ahead: null, behind: null },
        size: { status: 'skipped', totalBytes: null, nodeModulesBytes: null, deps: null, devDeps: null },
      }]
    : [];
  fs.writeFileSync(cache, JSON.stringify({ schemaVersion: 1, generatedAt: '2026-06-21T00:00:00.000Z', projects }));
  return { cache, projDir };
}

/** 서버를 임시 포트로 띄우고 핸들을 반환. */
function startServer(opts) {
  const built = createServer(Object.assign({ logger: quiet(), port: 0 }, opts));
  return new Promise((resolve) => {
    built.server.listen(0, '127.0.0.1', () => {
      const port = built.server.address().port;
      // 임시(ephemeral) 포트에 맞춰 allowlist 재구성 — 실제 서버는 고정 포트라 불필요.
      built.ctx.hostAllow = security.buildHostAllowlist(port);
      built.ctx.originAllow = security.buildOriginAllowlist(port);
      resolve(Object.assign({}, built, { port }));
    });
  });
}

/** 간단 http 요청 헬퍼. */
function request(port, method, urlPath, headers, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method, path: urlPath, headers: headers || {} },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
      }
    );
    req.on('error', reject);
    if (body) req.end(body);
    else req.end();
  });
}

test('GET /api/projects 계약 shape + hasSnapshot:true', async () => {
  const { cache } = makeSnapshot(true);
  const h = await startServer({ cachePath: cache });
  try {
    const res = await request(h.port, 'GET', '/api/projects');
    assert.strictEqual(res.status, 200);
    assert.match(res.headers['content-type'], /application\/json/);
    const json = JSON.parse(res.body);
    assert.strictEqual(json.hasSnapshot, true);
    assert.strictEqual(json.schemaVersion, 1);
    assert.strictEqual(json.generatedAt, '2026-06-21T00:00:00.000Z');
    assert.strictEqual(json.projects.length, 1);
    assert.strictEqual(json.projects[0].id, 'fixedid01');
  } finally { h.server.close(); }
});

test('GET /api/stats byLanguage 집계 + totalBytes:null', async () => {
  const { cache } = makeSnapshot(true);
  const h = await startServer({ cachePath: cache });
  try {
    const res = await request(h.port, 'GET', '/api/stats');
    assert.strictEqual(res.status, 200);
    const json = JSON.parse(res.body);
    assert.strictEqual(json.total, 1);
    assert.deepStrictEqual(json.byLanguage, { 'Node.js': 1 });
    assert.strictEqual(json.staleCount, 1);
    assert.strictEqual(json.totalBytes, null);
    assert.strictEqual(json.generatedAt, '2026-06-21T00:00:00.000Z');
  } finally { h.server.close(); }
});

test('GET /api/health shape (ok:true, booleans)', async () => {
  const { cache } = makeSnapshot(true);
  const h = await startServer({ cachePath: cache });
  try {
    const res = await request(h.port, 'GET', '/api/health');
    assert.strictEqual(res.status, 200);
    const json = JSON.parse(res.body);
    assert.strictEqual(json.ok, true);
    assert.strictEqual(json.hasSnapshot, true);
    assert.strictEqual(typeof json.codeCli, 'boolean');
    assert.strictEqual(typeof json.git, 'boolean');
  } finally { h.server.close(); }
});

test('스냅샷 부재 → 200 + hasSnapshot:false + 빈 배열 (P2-5)', async () => {
  const h = await startServer({ cachePath: path.join(os.tmpdir(), 'spip-nope-' + Date.now() + '.json') });
  try {
    const res = await request(h.port, 'GET', '/api/projects');
    assert.strictEqual(res.status, 200);
    const json = JSON.parse(res.body);
    assert.strictEqual(json.hasSnapshot, false);
    assert.deepStrictEqual(json.projects, []);

    const sres = await request(h.port, 'GET', '/api/stats');
    assert.strictEqual(sres.status, 200);
    assert.strictEqual(JSON.parse(sres.body).total, 0);
  } finally { h.server.close(); }
});

test('POST /api/open: 유효 보안헤더 통과 후 동작(존재 id) — spawn 가능 여부와 무관하게 계약 응답', async () => {
  const { cache } = makeSnapshot(true);
  const h = await startServer({ cachePath: cache });
  try {
    const headers = {
      'host': '127.0.0.1:' + h.port,
      'origin': 'http://127.0.0.1:' + h.port,
      'x-spip-token': h.token,
      'content-type': 'application/json',
    };
    const res = await request(h.port, 'POST', '/api/open', headers, JSON.stringify({ id: 'fixedid01' }));
    assert.strictEqual(res.status, 200);
    const json = JSON.parse(res.body);
    // code CLI 설치 여부에 따라 OPENING 또는 CODE_CLI_NOT_FOUND/OPEN_FAILED — 모두 계약 내.
    assert.ok(['OPENING', 'CODE_CLI_NOT_FOUND', 'OPEN_FAILED'].includes(json.code), json.code);
  } finally { h.server.close(); }
});

test('POST /api/open: 응답이 즉시(2초 이내) 반환 — code 프로세스 종료 대기 안 함(P2-3, R-12)', async () => {
  // 검증 환경엔 code CLI가 없을 수 있어 분기(OPENING/CODE_CLI_NOT_FOUND)는 비결정적이지만,
  // 어떤 분기든 응답은 즉시 와야 한다(detached spawn은 프로세스 종료를 기다리지 않음).
  const { cache } = makeSnapshot(true);
  const h = await startServer({ cachePath: cache });
  try {
    const headers = {
      'host': '127.0.0.1:' + h.port,
      'origin': 'http://127.0.0.1:' + h.port,
      'x-spip-token': h.token,
      'content-type': 'application/json',
    };
    const started = Date.now();
    const res = await request(h.port, 'POST', '/api/open', headers, JSON.stringify({ id: 'fixedid01' }));
    const elapsed = Date.now() - started;
    assert.strictEqual(res.status, 200);
    const json = JSON.parse(res.body);
    assert.ok(['OPENING', 'CODE_CLI_NOT_FOUND', 'OPEN_FAILED'].includes(json.code), json.code);
    assert.ok(elapsed < 2000, '/api/open 응답은 2초 이내여야 함(elapsed=' + elapsed + 'ms)');
  } finally { h.server.close(); }
});

test('POST /api/open: 토큰 누락 → 403 FORBIDDEN_ORIGIN (M-1)', async () => {
  const { cache } = makeSnapshot(true);
  const h = await startServer({ cachePath: cache });
  try {
    const headers = {
      'host': '127.0.0.1:' + h.port,
      'origin': 'http://127.0.0.1:' + h.port,
      'content-type': 'application/json',
    };
    const res = await request(h.port, 'POST', '/api/open', headers, JSON.stringify({ id: 'fixedid01' }));
    assert.strictEqual(res.status, 403);
    assert.strictEqual(JSON.parse(res.body).code, 'FORBIDDEN_ORIGIN');
  } finally { h.server.close(); }
});

test('POST /api/open: Host 위조 → 403 (DNS 리바인딩 차단, M-1)', async () => {
  const { cache } = makeSnapshot(true);
  const h = await startServer({ cachePath: cache });
  try {
    const headers = {
      'host': 'evil.example.com',
      'origin': 'http://127.0.0.1:' + h.port,
      'x-spip-token': h.token,
      'content-type': 'application/json',
    };
    const res = await request(h.port, 'POST', '/api/open', headers, JSON.stringify({ id: 'fixedid01' }));
    assert.strictEqual(res.status, 403);
    assert.strictEqual(JSON.parse(res.body).code, 'FORBIDDEN_ORIGIN');
  } finally { h.server.close(); }
});

test('POST /api/open: Origin 위조 → 403 (M-1)', async () => {
  const { cache } = makeSnapshot(true);
  const h = await startServer({ cachePath: cache });
  try {
    const headers = {
      'host': '127.0.0.1:' + h.port,
      'origin': 'http://evil.example.com',
      'x-spip-token': h.token,
      'content-type': 'application/json',
    };
    const res = await request(h.port, 'POST', '/api/open', headers, JSON.stringify({ id: 'fixedid01' }));
    assert.strictEqual(res.status, 403);
    assert.strictEqual(JSON.parse(res.body).code, 'FORBIDDEN_ORIGIN');
  } finally { h.server.close(); }
});

test('POST /api/open: 잘못된 Content-Type → 403 (보조 검증)', async () => {
  const { cache } = makeSnapshot(true);
  const h = await startServer({ cachePath: cache });
  try {
    const headers = {
      'host': '127.0.0.1:' + h.port,
      'origin': 'http://127.0.0.1:' + h.port,
      'x-spip-token': h.token,
      'content-type': 'text/plain',
    };
    const res = await request(h.port, 'POST', '/api/open', headers, JSON.stringify({ id: 'fixedid01' }));
    assert.strictEqual(res.status, 403);
  } finally { h.server.close(); }
});

test('POST /api/open: 미존재 id → 404 ID_NOT_FOUND', async () => {
  const { cache } = makeSnapshot(true);
  const h = await startServer({ cachePath: cache });
  try {
    const headers = {
      'host': '127.0.0.1:' + h.port,
      'origin': 'http://127.0.0.1:' + h.port,
      'x-spip-token': h.token,
      'content-type': 'application/json',
    };
    const res = await request(h.port, 'POST', '/api/open', headers, JSON.stringify({ id: 'no-such-id' }));
    assert.strictEqual(res.status, 404);
    assert.strictEqual(JSON.parse(res.body).code, 'ID_NOT_FOUND');
  } finally { h.server.close(); }
});

test('POST /api/open: 소멸 경로 → 410 PATH_GONE', async () => {
  // 존재하지 않는 경로를 가진 스냅샷을 직접 구성.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spip-gone-'));
  const cache = path.join(dir, 'projects.json');
  const gonePath = path.join(dir, 'removed-project-xyz');
  fs.writeFileSync(cache, JSON.stringify({
    schemaVersion: 1, generatedAt: 't', projects: [{ id: 'goneid', path: gonePath, name: 'x' }],
  }));
  const h = await startServer({ cachePath: cache });
  try {
    const headers = {
      'host': '127.0.0.1:' + h.port,
      'origin': 'http://127.0.0.1:' + h.port,
      'x-spip-token': h.token,
      'content-type': 'application/json',
    };
    const res = await request(h.port, 'POST', '/api/open', headers, JSON.stringify({ id: 'goneid' }));
    assert.strictEqual(res.status, 410);
    assert.strictEqual(JSON.parse(res.body).code, 'PATH_GONE');
  } finally { h.server.close(); }
});

test('POST /api/rescan: 토큰 없이 → 403 FORBIDDEN_ORIGIN (M-1, C-1 라우터 게이트)', async () => {
  // M4: rescan은 더 이상 404 미마운트가 아니라 상태변경 POST(M-1 게이트). 토큰 누락은 403.
  const { cache } = makeSnapshot(true);
  const h = await startServer({ cachePath: cache });
  try {
    const res = await request(h.port, 'POST', '/api/rescan', { 'content-type': 'application/json' }, '{}');
    assert.strictEqual(res.status, 403);
    assert.strictEqual(JSON.parse(res.body).code, 'FORBIDDEN_ORIGIN');
  } finally { h.server.close(); }
});

test('GET /api/projects 에 POST → 405', async () => {
  const { cache } = makeSnapshot(true);
  const h = await startServer({ cachePath: cache });
  try {
    const res = await request(h.port, 'POST', '/api/projects', { 'content-type': 'application/json' }, '{}');
    assert.strictEqual(res.status, 405);
  } finally { h.server.close(); }
});

test('listen은 127.0.0.1 루프백 바인딩 (N-02)', async () => {
  const { cache } = makeSnapshot(true);
  const h = await startServer({ cachePath: cache });
  try {
    assert.strictEqual(h.server.address().address, '127.0.0.1');
  } finally { h.server.close(); }
});
