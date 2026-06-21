'use strict';
/**
 * ipc-actions.test.js — electron/ipc/actions.js (헤드리스 검증, F-3)
 * openInVsCode·rescan 검증 체인·실패 code·옵션 게이트. safeExec/driveEnum 모킹.
 */
const { test } = require('node:test');
const assert = require('node:assert');

const actions = require('../electron/ipc/actions');

function fakeStore(byId, allowKeys) {
  return {
    getById: (id) => byId[id] || null,
    getAllowKeySet: () => new Set(allowKeys || []),
  };
}

// ── sanitize 단위 ──
test('sanitizeOpenId — 유효/무효 케이스', () => {
  assert.strictEqual(actions.sanitizeOpenId({ id: 'abc' }), 'abc');
  assert.strictEqual(actions.sanitizeOpenId({ id: '' }), null);
  assert.strictEqual(actions.sanitizeOpenId({ id: 123 }), null);
  assert.strictEqual(actions.sanitizeOpenId(null), null);
  assert.strictEqual(actions.sanitizeOpenId([]), null);
  assert.strictEqual(actions.sanitizeOpenId({ id: 'x'.repeat(513) }), null);
  assert.strictEqual(actions.sanitizeOpenId({ id: 'x'.repeat(512) }), 'x'.repeat(512));
});

test('sanitizeRescanOpts — 키 화이트리스트·Boolean 강제', () => {
  assert.deepStrictEqual(actions.sanitizeRescanOpts({ withSize: true, allDrives: 1, evil: 'x' }), { withSize: true, allDrives: true });
  assert.deepStrictEqual(actions.sanitizeRescanOpts('notobject'), { withSize: false, allDrives: false });
  assert.deepStrictEqual(actions.sanitizeRescanOpts([1, 2]), { withSize: false, allDrives: false });
  assert.deepStrictEqual(actions.sanitizeRescanOpts(undefined), { withSize: false, allDrives: false });
});

// ── openInVsCode ──
test('open — id 미존재 → ID_NOT_FOUND', async () => {
  const r = await actions.openInVsCode({ id: 'nope' }, { store: fakeStore({}) });
  assert.deepStrictEqual(r, { ok: false, code: 'ID_NOT_FOUND' });
});

test('open — 잘못된 인자 → ID_NOT_FOUND', async () => {
  const r = await actions.openInVsCode({ id: 123 }, { store: fakeStore({}) });
  assert.deepStrictEqual(r, { ok: false, code: 'ID_NOT_FOUND' });
});

test('open — canonicalize null → PATH_GONE', async () => {
  const r = await actions.openInVsCode({ id: 'p1' }, {
    store: fakeStore({ p1: { id: 'p1', path: '/gone' } }),
    pathGuard: { canonicalize: () => null, isAllowed: () => true },
  });
  assert.deepStrictEqual(r, { ok: false, code: 'PATH_GONE' });
});

test('open — isAllowed false → PATH_NOT_ALLOWED', async () => {
  const r = await actions.openInVsCode({ id: 'p1' }, {
    store: fakeStore({ p1: { id: 'p1', path: '/x' } }),
    pathGuard: { canonicalize: () => '/x/real', isAllowed: () => false },
  });
  assert.deepStrictEqual(r, { ok: false, code: 'PATH_NOT_ALLOWED' });
});

test('open — code CLI 미설치 → CODE_CLI_NOT_FOUND', async () => {
  const r = await actions.openInVsCode({ id: 'p1' }, {
    store: fakeStore({ p1: { id: 'p1', path: '/x' } }),
    pathGuard: { canonicalize: () => '/x/real', isAllowed: () => true },
    resolveBin: () => null,
  });
  assert.deepStrictEqual(r, { ok: false, code: 'CODE_CLI_NOT_FOUND' });
});

test('open — 성공 → OPENING (safeExec에 실경로·shell:false·detached 전달)', async () => {
  let calledWith = null;
  const r = await actions.openInVsCode({ id: 'p1' }, {
    store: fakeStore({ p1: { id: 'p1', path: '/x' } }),
    pathGuard: { canonicalize: () => '/x/real', isAllowed: () => true },
    resolveBin: () => '/usr/bin/code',
    safeExec: (bin, args, opts) => { calledWith = { bin, args, opts }; return Promise.resolve({ spawned: true }); },
  });
  assert.deepStrictEqual(r, { ok: true, code: 'OPENING' });
  assert.strictEqual(calledWith.bin, '/usr/bin/code');
  assert.deepStrictEqual(calledWith.args, ['/x/real']);
  assert.strictEqual(calledWith.opts.shell, false);
  assert.strictEqual(calledWith.opts.detached, true);
  assert.strictEqual(calledWith.opts.inflightKey, 'open:code:p1'); // P3-1: 'open:'+toolId+':'+id
});

test('open — safeExec reject → OPEN_FAILED', async () => {
  const r = await actions.openInVsCode({ id: 'p1' }, {
    store: fakeStore({ p1: { id: 'p1', path: '/x' } }),
    pathGuard: { canonicalize: () => '/x/real', isAllowed: () => true },
    resolveBin: () => '/usr/bin/code',
    safeExec: () => Promise.reject(new Error('inflight')),
  });
  assert.deepStrictEqual(r, { ok: false, code: 'OPEN_FAILED' });
});

// ── rescan ──
function fakeController() {
  return {
    _acquired: false,
    _started: null,
    status: () => ({ scanId: 'sid-current', phase: 'idle' }),
    acquire: function () { if (this._acquired) return null; this._acquired = true; return { scanId: 'sid-new', startedAt: 'T0' }; },
    start: function (opts) { this._started = opts; },
  };
}

test('rescan — scanRoots 비면 NO_SCAN_ROOTS', () => {
  const r = actions.rescan({}, { scanController: fakeController(), config: { scanRoots: [] } });
  assert.deepStrictEqual(r, { ok: false, code: 'NO_SCAN_ROOTS' });
});

test('rescan — 컨트롤러 미주입 → INTERNAL', () => {
  const r = actions.rescan({}, { config: { scanRoots: ['/a'] } });
  assert.deepStrictEqual(r, { ok: false, code: 'INTERNAL' });
});

test('rescan — 성공 → SCAN_STARTED + start에 onProgress 전달', () => {
  const c = fakeController();
  let progressSent = null;
  const r = actions.rescan({ withSize: true }, {
    scanController: c,
    config: { scanRoots: ['/a'] },
    store: {},
    cachePath: '/cache',
    sendProgress: (s) => { progressSent = s; },
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.code, 'SCAN_STARTED');
  assert.strictEqual(r.scanId, 'sid-new');
  assert.strictEqual(c._started.withSize, true);
  assert.strictEqual(typeof c._started.onProgress, 'function');
  c._started.onProgress({ phase: 'scanning' });
  assert.deepStrictEqual(progressSent, { phase: 'scanning' });
});

test('rescan — 이미 진행 중 → SCAN_IN_PROGRESS(현 scanId 동봉)', () => {
  const c = fakeController();
  c._acquired = true;
  const r = actions.rescan({}, { scanController: c, config: { scanRoots: ['/a'] } });
  assert.deepStrictEqual(r, { ok: false, code: 'SCAN_IN_PROGRESS', scanId: 'sid-current' });
});

test('rescan — allDrives 게이트: 인자만으로는 못 켬(강등+note)', () => {
  const c = fakeController();
  actions.rescan({ allDrives: true }, {
    scanController: c,
    config: { scanRoots: ['/a'], allowAllDrives: false },
    store: {},
  });
  assert.strictEqual(c._started.allDrives, false); // 강등
});

test('rescan — allDrives 게이트: config 허용 시 enumerateRoots 사용', () => {
  const c = fakeController();
  actions.rescan({ allDrives: true }, {
    scanController: c,
    config: { scanRoots: ['/a'], allowAllDrives: true },
    store: {},
    driveEnum: { enumerateRoots: () => ['/mnt/c', '/mnt/d'] },
  });
  assert.strictEqual(c._started.allDrives, true);
  assert.deepStrictEqual(c._started.roots, ['/mnt/c', '/mnt/d']);
});
