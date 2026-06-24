'use strict';
/**
 * stateWatcher.test.js — lib/server/stateWatcher.js (R-24 상태 주시, 헤드리스 F-3)
 *
 * 수집기·canonicalize·setInterval을 deps로 주입해 Electron/실 git 없이 검증한다:
 *   · normalizeGit/normalizeFreshness/stateChanged 순수 계약
 *   · tick: 변경분만 store 반영 + onUpdate, 무변경 시 호출 없음
 *   · H-1: canonicalize null(소멸) 경로 건너뜀
 *   · 스캔 중 tick 건너뜀(isScanning), 재진입(_busy) 가드, 빈 store graceful
 *   · start/stop 멱등 + interval clamp
 */
const { test } = require('node:test');
const assert = require('node:assert');

const {
  StateWatcher, normalizeGit, normalizeFreshness, stateChanged, DEFAULT_INTERVAL_MS, MIN_INTERVAL_MS,
} = require('../lib/server/stateWatcher');

const quiet = { error() {}, warn() {}, info() {} };

function proj(id, path, gitOver, freshOver) {
  return {
    id, path, name: id, language: { primary: 'Go' }, size: { status: 'ok', totalBytes: 1 },
    git: Object.assign({ status: 'ok', isRepo: true, branch: 'main', dirty: false, ahead: 0, behind: 0, changes: 0 }, gitOver),
    freshness: Object.assign({ lastModified: '2026-01-01T00:00:00.000Z', lastCommit: null, isStale: false }, freshOver),
  };
}

function makeStore(projects) {
  const byId = new Map(projects.map((p) => [p.id, p]));
  return {
    getProjects: () => projects.slice(),
    applyLiveState: (id, git, fresh) => {
      const p = byId.get(id); if (!p) return null;
      if (git) p.git = git; if (fresh) p.freshness = fresh; return p;
    },
  };
}

/** git 수집기 stub — dirtyByPath[path] 로 dirty 제어. */
function gitStub(dirtyByPath, aheadByPath) {
  return {
    collect: async (path) => ({
      status: 'ok',
      data: {
        status: 'ok', isRepo: true, branch: 'main',
        dirty: !!(dirtyByPath && dirtyByPath[path]),
        ahead: (aheadByPath && aheadByPath[path]) || 0,
        behind: 0, changes: (dirtyByPath && dirtyByPath[path]) ? 1 : 0, lastCommit: null,
      },
    }),
  };
}
const freshStub = {
  collect: () => ({ status: 'ok', data: { lastModified: '2026-01-01T00:00:00.000Z', lastCommit: null, isStale: false } }),
};
const idCanon = (p) => (p === 'GONE' ? null : p);

/* ───────────── 순수 계약 ───────────── */
test('normalizeGit — ok shape / na 폴백', () => {
  assert.deepStrictEqual(
    normalizeGit({ status: 'ok', isRepo: true, branch: 'm', dirty: true, ahead: 2, behind: 1, changes: 3 }),
    { status: 'ok', isRepo: true, branch: 'm', dirty: true, ahead: 2, behind: 1, changes: 3 });
  assert.deepStrictEqual(
    normalizeGit({ status: 'na' }),
    { status: 'na', isRepo: false, branch: null, dirty: null, ahead: null, behind: null, changes: null });
});

test('normalizeFreshness — shape + isStale 불리언화', () => {
  assert.deepStrictEqual(
    normalizeFreshness({ lastModified: 'x', lastCommit: 'y', isStale: 1 }),
    { lastModified: 'x', lastCommit: 'y', isStale: true });
  assert.deepStrictEqual(normalizeFreshness(null), { lastModified: null, lastCommit: null, isStale: false });
});

test('stateChanged — git/freshness 변동 감지, 동일 시 false', () => {
  const prev = proj('a', 'A');
  assert.strictEqual(stateChanged(prev, { git: normalizeGit(prev.git), freshness: normalizeFreshness(prev.freshness) }), false);
  assert.strictEqual(stateChanged(prev, { git: normalizeGit(Object.assign({}, prev.git, { dirty: true })), freshness: normalizeFreshness(prev.freshness) }), true);
  assert.strictEqual(stateChanged(prev, { git: normalizeGit(prev.git), freshness: normalizeFreshness({ lastModified: 'Z', isStale: true }) }), true);
});

/* ───────────── tick ───────────── */
test('tick — 변경된 항목만 store 반영 + onUpdate(변경분만)', async () => {
  const a = proj('a', 'A'); const b = proj('b', 'B');
  const store = makeStore([a, b]);
  const updates = [];
  const w = new StateWatcher({
    logger: quiet, gitCollector: gitStub({ A: true }), freshnessCollector: freshStub, canonicalize: idCanon,
  });
  w.start({ store, config: {}, onUpdate: (pl) => updates.push(pl), isScanning: () => false, setInterval: () => ({ unref() {} }) });
  const changed = await w.tick();
  assert.strictEqual(changed.length, 1, 'a만 변경');
  assert.strictEqual(changed[0].id, 'a');
  assert.strictEqual(a.git.dirty, true, 'store 객체 반영');
  assert.strictEqual(b.git.dirty, false, 'b 불변');
  assert.strictEqual(updates.length, 1);
  assert.deepStrictEqual(updates[0].projects.map((p) => p.id), ['a']);
});

test('tick — 무변경이면 onUpdate 미호출 + 빈 배열', async () => {
  const store = makeStore([proj('a', 'A'), proj('b', 'B')]);
  const updates = [];
  const w = new StateWatcher({ logger: quiet, gitCollector: gitStub({}), freshnessCollector: freshStub, canonicalize: idCanon });
  w.start({ store, config: {}, onUpdate: (pl) => updates.push(pl), isScanning: () => false, setInterval: () => ({ unref() {} }) });
  const changed = await w.tick();
  assert.deepStrictEqual(changed, []);
  assert.strictEqual(updates.length, 0);
});

test('tick — H-1: canonicalize null(소멸) 경로는 건너뜀(수집 안 함)', async () => {
  const gone = proj('g', 'GONE'); const ok = proj('a', 'A');
  const store = makeStore([gone, ok]);
  let collectedPaths = [];
  const git = { collect: async (p) => { collectedPaths.push(p); return { status: 'ok', data: { status: 'ok', isRepo: true, branch: 'main', dirty: true, ahead: 0, behind: 0, lastCommit: null } }; } };
  const w = new StateWatcher({ logger: quiet, gitCollector: git, freshnessCollector: freshStub, canonicalize: idCanon });
  w.start({ store, config: {}, onUpdate: () => {}, isScanning: () => false, setInterval: () => ({ unref() {} }) });
  await w.tick();
  assert.ok(!collectedPaths.includes('GONE'), '소멸 경로는 수집 호출 안 함');
  assert.ok(collectedPaths.includes('A'), '정상 경로는 수집');
});

test('tick — 스캔 중(isScanning)이면 무동작', async () => {
  let collected = 0;
  const git = { collect: async () => { collected++; return { status: 'ok', data: { status: 'ok', isRepo: true, dirty: true } }; } };
  const store = makeStore([proj('a', 'A')]);
  const w = new StateWatcher({ logger: quiet, gitCollector: git, freshnessCollector: freshStub, canonicalize: idCanon });
  w.start({ store, config: {}, onUpdate: () => {}, isScanning: () => true, setInterval: () => ({ unref() {} }) });
  const changed = await w.tick();
  assert.deepStrictEqual(changed, []);
  assert.strictEqual(collected, 0, '스캔 중엔 수집기 호출 0');
});

test('tick — 재진입(_busy) 가드: 진행 중 두 번째 호출은 즉시 빈 배열', async () => {
  let resolveGit;
  const git = { collect: () => new Promise((r) => { resolveGit = () => r({ status: 'ok', data: { status: 'ok', isRepo: true, dirty: true } }); }) };
  const store = makeStore([proj('a', 'A')]);
  const w = new StateWatcher({ logger: quiet, gitCollector: git, freshnessCollector: freshStub, canonicalize: idCanon });
  w.start({ store, config: {}, onUpdate: () => {}, isScanning: () => false, setInterval: () => ({ unref() {} }) });
  const p1 = w.tick();             // 진행 시작(git collect pending)
  const r2 = await w.tick();        // _busy → 즉시 반환
  assert.deepStrictEqual(r2, [], '재진입은 빈 배열');
  resolveGit();
  await p1;
});

test('tick — 빈 store graceful', async () => {
  const w = new StateWatcher({ logger: quiet, gitCollector: gitStub({}), freshnessCollector: freshStub, canonicalize: idCanon });
  w.start({ store: makeStore([]), config: {}, onUpdate: () => {}, isScanning: () => false, setInterval: () => ({ unref() {} }) });
  assert.deepStrictEqual(await w.tick(), []);
});

/* ───────────── start/stop ───────────── */
test('start/stop — 멱등 + isRunning + interval clamp', () => {
  const w = new StateWatcher({ logger: quiet, intervalMs: 100 }); // MIN 미만 → clamp
  assert.strictEqual(w.intervalMs, MIN_INTERVAL_MS, 'MIN 미만은 clamp');
  let scheduled = 0;
  const fakeIv = (fn, ms) => { scheduled++; return { unref() {}, _ms: ms }; };
  assert.strictEqual(w.isRunning(), false);
  w.start({ store: makeStore([]), setInterval: fakeIv });
  assert.strictEqual(w.isRunning(), true);
  w.start({ store: makeStore([]), setInterval: fakeIv }); // 멱등 — 재스케줄 없음
  assert.strictEqual(scheduled, 1, 'start 멱등: 타이머 1회만');
  w.stop();
  assert.strictEqual(w.isRunning(), false);
  w.stop(); // 멱등
  assert.strictEqual(w.isRunning(), false);
});

test('intervalMs 기본값 = DEFAULT_INTERVAL_MS', () => {
  const w = new StateWatcher({ logger: quiet });
  assert.strictEqual(w.intervalMs, DEFAULT_INTERVAL_MS);
});
