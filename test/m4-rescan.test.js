'use strict';
/**
 * m4-rescan.test.js — M4 R-16 재스캔 + R-15 scan-status 통합/보안 (C-1·C-3·C-4)
 *   · POST /api/rescan: M-1 게이트(C-1), 202/409(SCAN_IN_PROGRESS·NO_SCAN_ROOTS), 옵션 게이트
 *   · GET /api/scan-status: checkReadAccess 토큰 게이트 403(C-3 무인증 차단), currentPath 축약
 *   · ScanController: 락/watchdog 데드락 방지(C-4), shortenPath 단위
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
const { ScanController, shortenPath } = require('../lib/server/scanController');

function quiet() { return new Logger({ quiet: true }); }

/** scanRoots를 가진 실디렉터리 + 캐시 파일을 구성. */
function makeEnv(withRoots) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spip-m4-'));
  const cache = path.join(dir, 'projects.json');
  fs.writeFileSync(cache, JSON.stringify({ schemaVersion: 1, generatedAt: 't', projects: [] }));
  // 스캔 루트로 쓸 실디렉터리(프로젝트 하나 포함).
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spip-m4root-'));
  fs.mkdirSync(path.join(root, 'proj', '.git'), { recursive: true });
  fs.writeFileSync(path.join(root, 'proj', 'package.json'), JSON.stringify({ name: 'p' }));
  return { cache, root: withRoots ? root : null };
}

function startServer(opts, scanRoots) {
  const built = createServer(Object.assign({ logger: quiet(), port: 0 }, opts));
  // config.scanRoots를 테스트 루트로 주입(loadConfig는 빈 기본값을 줄 수 있으므로).
  if (scanRoots) built.ctx.config.scanRoots = scanRoots;
  else built.ctx.config.scanRoots = [];
  built.ctx.config.allowAllDrives = false;
  return new Promise((resolve) => {
    built.server.listen(0, '127.0.0.1', () => {
      const port = built.server.address().port;
      built.ctx.hostAllow = security.buildHostAllowlist(port);
      built.ctx.originAllow = security.buildOriginAllowlist(port);
      resolve(Object.assign({}, built, { port }));
    });
  });
}

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
    if (body) req.end(body); else req.end();
  });
}

function authHeaders(h) {
  return {
    host: '127.0.0.1:' + h.port,
    origin: 'http://127.0.0.1:' + h.port,
    'x-spip-token': h.token,
    'content-type': 'application/json',
  };
}
function readHeaders(h) {
  // CT 없이 — checkReadAccess는 CT 면제.
  return {
    host: '127.0.0.1:' + h.port,
    origin: 'http://127.0.0.1:' + h.port,
    'x-spip-token': h.token,
  };
}

// ───── shortenPath 단위(M4-H-1) ─────
test('shortenPath: 최대 2세그먼트 basename 축약(절대경로 미노출)', () => {
  assert.strictEqual(shortenPath('E:\\03\\Project-SPIP\\lib\\server'), 'lib/server');
  assert.strictEqual(shortenPath('/home/u/code/app'), 'code/app');
  assert.strictEqual(shortenPath('/single'), 'single');
  assert.strictEqual(shortenPath(null), null);
  assert.strictEqual(shortenPath(''), null);
  // 드라이브 루트만 있으면 드라이브 표기는 1세그먼트로만(전체 경로 아님).
  const r = shortenPath('C:\\Windows\\System32');
  assert.strictEqual(r, 'Windows/System32');
  // [보안 L-1] 드라이브 루트 단독은 드라이브 문자(C:)를 노출하지 않고 일반 라벨로 치환.
  assert.strictEqual(shortenPath('C:\\'), '드라이브 루트');
  assert.strictEqual(shortenPath('D:\\'), '드라이브 루트');
});

// ───── C-1: rescan M-1 게이트 ─────
test('rescan: 토큰 누락 → 403 (C-1)', async () => {
  const env = makeEnv(true);
  const h = await startServer({ cachePath: env.cache }, [env.root]);
  try {
    const res = await request(h.port, 'POST', '/api/rescan',
      { host: '127.0.0.1:' + h.port, origin: 'http://127.0.0.1:' + h.port, 'content-type': 'application/json' }, '{}');
    assert.strictEqual(res.status, 403);
    assert.strictEqual(JSON.parse(res.body).code, 'FORBIDDEN_ORIGIN');
  } finally { h.server.close(); }
});

test('rescan: GET 메서드 → 405 (POST 한정)', async () => {
  const env = makeEnv(true);
  const h = await startServer({ cachePath: env.cache }, [env.root]);
  try {
    const res = await request(h.port, 'GET', '/api/rescan', authHeaders(h));
    assert.strictEqual(res.status, 405);
  } finally { h.server.close(); }
});

// ───── NO_SCAN_ROOTS ─────
test('rescan: scanRoots 미설정 → 409 NO_SCAN_ROOTS', async () => {
  const env = makeEnv(false);
  const h = await startServer({ cachePath: env.cache }, null);
  try {
    const res = await request(h.port, 'POST', '/api/rescan', authHeaders(h), '{}');
    assert.strictEqual(res.status, 409);
    assert.strictEqual(JSON.parse(res.body).code, 'NO_SCAN_ROOTS');
  } finally { h.server.close(); }
});

// ───── 202 SCAN_STARTED + 락 409 ─────
test('rescan: 202 SCAN_STARTED{scanId,startedAt} + 진행 중 재요청 409 SCAN_IN_PROGRESS', async () => {
  const env = makeEnv(true);
  const h = await startServer({ cachePath: env.cache }, [env.root]);
  // watchdog/실제 완료가 빠르게 끝나면 두 번째 요청이 락을 못 잡을 수 있으므로
  // 컨트롤러를 강제로 running 상태로 유지하기 위해 acquire를 직접 잡아둔다.
  try {
    // 첫 요청 — 202.
    const res1 = await request(h.port, 'POST', '/api/rescan', authHeaders(h), '{}');
    assert.strictEqual(res1.status, 202);
    const j1 = JSON.parse(res1.body);
    assert.strictEqual(j1.code, 'SCAN_STARTED');
    assert.match(j1.scanId, /^[0-9a-f]{16}$/);
    assert.ok(typeof j1.startedAt === 'string');
  } finally { h.server.close(); }
});

test('rescan: 진행 중(락 점유)이면 409 SCAN_IN_PROGRESS', async () => {
  const env = makeEnv(true);
  const h = await startServer({ cachePath: env.cache }, [env.root]);
  try {
    // 컨트롤러 락을 직접 점유(start 없이 acquire만) → 항상 running 상태.
    const acquired = h.scanController.acquire({});
    assert.ok(acquired && acquired.scanId);
    const res = await request(h.port, 'POST', '/api/rescan', authHeaders(h), '{}');
    assert.strictEqual(res.status, 409);
    const j = JSON.parse(res.body);
    assert.strictEqual(j.code, 'SCAN_IN_PROGRESS');
    assert.strictEqual(j.scanId, acquired.scanId);
    h.scanController.running = false; // 정리
  } finally { h.server.close(); }
});

// ───── C-3: scan-status 토큰 게이트 ─────
test('scan-status: 토큰 누락 → 403 (C-3 무인증 폴러 차단)', async () => {
  const env = makeEnv(true);
  const h = await startServer({ cachePath: env.cache }, [env.root]);
  try {
    const res = await request(h.port, 'GET', '/api/scan-status',
      { host: '127.0.0.1:' + h.port, origin: 'http://127.0.0.1:' + h.port });
    assert.strictEqual(res.status, 403);
    assert.strictEqual(JSON.parse(res.body).code, 'FORBIDDEN_ORIGIN');
  } finally { h.server.close(); }
});

test('scan-status: Host 위조 → 403 (DNS 리바인딩)', async () => {
  const env = makeEnv(true);
  const h = await startServer({ cachePath: env.cache }, [env.root]);
  try {
    const res = await request(h.port, 'GET', '/api/scan-status',
      { host: 'evil.example.com', origin: 'http://127.0.0.1:' + h.port, 'x-spip-token': h.token });
    assert.strictEqual(res.status, 403);
  } finally { h.server.close(); }
});

test('scan-status: 토큰 보유(CT 없이) → 200 idle ScanProgress', async () => {
  const env = makeEnv(true);
  const h = await startServer({ cachePath: env.cache }, [env.root]);
  try {
    const res = await request(h.port, 'GET', '/api/scan-status', readHeaders(h));
    assert.strictEqual(res.status, 200);
    const j = JSON.parse(res.body);
    assert.strictEqual(j.phase, 'idle');
    assert.strictEqual(j.scanId, null);
    assert.strictEqual(j.dirs, 0);
    assert.strictEqual(j.found, 0);
    assert.strictEqual(j.currentPath, null);
    assert.strictEqual(typeof j.elapsedMs, 'number');
  } finally { h.server.close(); }
});

test('scan-status: POST → 405 (GET 한정)', async () => {
  const env = makeEnv(true);
  const h = await startServer({ cachePath: env.cache }, [env.root]);
  try {
    const res = await request(h.port, 'POST', '/api/scan-status', readHeaders(h), '{}');
    assert.strictEqual(res.status, 405);
  } finally { h.server.close(); }
});

// ───── C-3: currentPath 절대경로 미노출 ─────
test('scan-status: currentPath는 절대경로 미노출(축약만, C-3)', () => {
  const ctrl = new ScanController({ logger: quiet() });
  ctrl.acquire({});
  ctrl._merge({ dirs: 5, found: 2, currentPath: 'E:\\secret\\path\\deep\\folder' });
  const st = ctrl.status();
  assert.strictEqual(st.currentPath, 'deep/folder'); // 축약
  assert.ok(!st.currentPath.includes('secret'), '절대경로 누설 0');
  assert.ok(!st.currentPath.includes('E:'), '드라이브 미노출');
  // 응답 직렬화에 절대경로 흔적이 없어야 한다.
  assert.ok(!JSON.stringify(st).includes('secret'));
  ctrl.running = false;
});

// ───── C-4: watchdog/락 해제 ─────
test('ScanController: start 완료 후 락 항상 해제(C-4 finally)', async () => {
  const env = makeEnv(true);
  const ctrl = new ScanController({ logger: quiet() });
  const store = { load: () => ({ hasSnapshot: true, count: 0 }) };
  const acquired = ctrl.acquire({});
  assert.ok(acquired);
  assert.strictEqual(ctrl.running, true);
  ctrl.start({
    config: { scanRoots: [env.root], excludes: [], staleDays: 90, scan: { watchdogMs: 60000 } },
    roots: [env.root], store, logger: quiet(),
  });
  // 백그라운드 완료 대기(작은 트리라 빠름).
  const deadline = Date.now() + 8000;
  while (ctrl.running && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.strictEqual(ctrl.running, false, 'finally에서 락 해제');
  assert.ok(['done', 'error'].includes(ctrl.status().phase));
});

test('ScanController: watchdog 타임아웃 시 error + 락 해제(C-4)', async () => {
  const ctrl = new ScanController({ logger: quiet() });
  // watchdogMs=1ms로 즉시 발화. scanner는 정상 진행하려 하나 watchdog이 먼저 error 처리.
  const env = makeEnv(true);
  const store = { load: () => ({}) };
  ctrl.acquire({});
  ctrl.start({
    config: { scanRoots: [env.root], excludes: [], staleDays: 90, scan: { watchdogMs: 1 } },
    roots: [env.root], store, logger: quiet(),
  });
  const deadline = Date.now() + 8000;
  while (ctrl.running && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.strictEqual(ctrl.running, false, 'watchdog 후 락 해제');
});

// ───── C-4/P1-1: watchdog 강제해제 — 실제로 hang하는 scan에서 입증 ─────
// 기존 작은-트리 테스트는 scanner가 빨리 끝나 finally가 락을 풀어 강제해제를 입증 못 했다(거짓 안심).
// 여기선 영영 resolve 안 되는 scan을 주입해 watchdog가 finally 없이 즉시 락을 푸는지 단언한다.
test('ScanController: scan이 hang해도 watchdog가 즉시 락 강제 해제(C-4/P1-1, 거짓안심 제거)', async () => {
  const scanner = require('../lib/scan/scanner');
  const origScan = scanner.scan;
  // 영영 resolve되지 않는 프로미스 — 무한 async hang 모의(watchdog가 막으려던 바로 그 상황).
  let resolveHang;
  scanner.scan = () => new Promise((res) => { resolveHang = res; });
  try {
    const ctrl = new ScanController({ logger: quiet() });
    const store = { load: () => ({}) };
    ctrl.acquire({});
    assert.strictEqual(ctrl.running, true);
    ctrl.start({
      config: { scanRoots: ['x'], excludes: [], staleDays: 90, scan: { watchdogMs: 30 } },
      roots: ['x'], store, logger: quiet(),
    });
    // scan은 영영 안 끝나므로 finally에 절대 도달 못 함. 락 해제는 오직 watchdog가 해야 한다.
    const deadline = Date.now() + 2000;
    while (ctrl.running && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.strictEqual(ctrl.running, false, 'watchdog가 finally 없이 즉시 락 해제(영구 409 방지)');
    assert.strictEqual(ctrl.status().phase, 'error');
  } finally {
    if (resolveHang) resolveHang({ counts: {}, projects: [] }); // 매달린 프로미스 정리
    scanner.scan = origScan;
  }
});

// ───── C-4: 세대(scanId) 가드 — 버려진 run이 새 스캔의 락/상태를 못 덮어쓴다 ─────
test('ScanController: watchdog 후 후속 rescan이 즉시 202(영구 409 아님) + 늦은 settle이 새 스캔 미오염(C-4 세대가드)', async () => {
  const scanner = require('../lib/scan/scanner');
  const origScan = scanner.scan;
  // 1회차 scan은 hang. 2회차(후속)는 즉시 정상 완료.
  let hangResolve = null;
  let call = 0;
  scanner.scan = () => {
    call++;
    if (call === 1) return new Promise((res) => { hangResolve = res; }); // 버려질 run
    return Promise.resolve({ counts: { projects: 0 }, projects: [] });    // 후속 정상 run
  };
  try {
    const ctrl = new ScanController({ logger: quiet() });
    const loads = [];
    const store = { load: (o) => { loads.push(o); return {}; } };
    const startOpts = (sc) => ({
      config: { scanRoots: ['x'], excludes: [], staleDays: 90, scan: { watchdogMs: sc } },
      roots: ['x'], store, logger: quiet(),
    });

    // 1) 첫 스캔 acquire+start → watchdog 30ms로 강제 해제 예정.
    const a1 = ctrl.acquire({});
    assert.ok(a1 && a1.scanId);
    ctrl.start(startOpts(30));
    const d1 = Date.now() + 2000;
    while (ctrl.running && Date.now() < d1) await new Promise((r) => setTimeout(r, 10));
    assert.strictEqual(ctrl.running, false, 'watchdog 강제 해제');

    // 2) 후속 rescan 즉시 가능해야 한다(영구 409 아님) — 새 scanId로 acquire 성공.
    const a2 = ctrl.acquire({});
    assert.ok(a2 && a2.scanId, '후속 acquire 성공(202 상당)');
    assert.notStrictEqual(a2.scanId, a1.scanId, '새 세대 scanId');
    ctrl.start(startOpts(60000));
    const d2 = Date.now() + 2000;
    while (ctrl.running && Date.now() < d2) await new Promise((r) => setTimeout(r, 10));
    assert.strictEqual(ctrl.running, false, '후속 스캔 정상 종료 후 해제');
    assert.strictEqual(ctrl.status().phase, 'done', '후속 스캔 done');
    assert.strictEqual(ctrl.status().scanId, a2.scanId, '활성 scanId는 후속 세대');

    // 3) 이제 버려진 1회차 scan이 뒤늦게 settle → finally 도달. 새 스캔(a2) 상태/락을 건드리면 안 됨.
    if (hangResolve) hangResolve({ counts: { projects: 99 }, projects: [] });
    await new Promise((r) => setTimeout(r, 50));
    assert.strictEqual(ctrl.running, false, '버려진 run의 finally가 새 스캔 락을 깨지 않음');
    assert.strictEqual(ctrl.status().phase, 'done', '버려진 run이 done 상태를 error로 못 덮음');
    assert.strictEqual(ctrl.status().scanId, a2.scanId, '활성 scanId 유지(오염 0)');
    // 버려진 run의 writeSnapshot/store.load가 새 스냅샷을 덮어쓰지 않았는지: load는 후속 1회만.
    assert.strictEqual(loads.length, 1, '버려진 run은 store.load 미실행(세대 가드)');
  } finally {
    scanner.scan = origScan;
  }
});
