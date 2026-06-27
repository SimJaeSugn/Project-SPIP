'use strict';
/**
 * shelf-scheduler.test.js — lib/shelf/scheduler.js (SH-4, D-SCHED-1~2)
 *   주입 모킹으로 토글 off=egress 0 · elevated 스킵 · 정상 tick(url만 재크롤·broadcast)을 증명.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const { createShelfScheduler } = require('../lib/shelf/scheduler');

function spyRefresh() {
  const calls = [];
  const fn = async (id) => { calls.push(id); return { ok: true }; };
  fn.calls = calls;
  return fn;
}
const URL_BM = [{ id: 'baaaaaa', type: 'url' }, { id: 'bbbbbbb', type: 'folder' }];

test('D-SCHED-1 — 토글 off면 tick 무동작(refresh 0·broadcast 0·egress 0)', async () => {
  const refresh = spyRefresh();
  let bc = 0;
  const s = createShelfScheduler({
    isEnabled: () => false, isElevated: () => false,
    getCtx: () => ({}), listBookmarks: () => URL_BM, refresh, broadcast: () => { bc += 1; },
  });
  s.start();
  const changed = await s.tick();
  assert.strictEqual(changed, false);
  assert.strictEqual(refresh.calls.length, 0, '네트워크 호출 0');
  assert.strictEqual(bc, 0);
  s.stop();
});

test('D-SCHED-2 — elevated 세션이면 tick 스킵', async () => {
  const refresh = spyRefresh();
  const s = createShelfScheduler({
    isEnabled: () => true, isElevated: () => true,
    getCtx: () => ({}), listBookmarks: () => URL_BM, refresh, broadcast: () => {},
  });
  s.start();
  assert.strictEqual(await s.tick(), false);
  assert.strictEqual(refresh.calls.length, 0);
  s.stop();
});

test('SH-4 — 정상 tick: url 북마크만 재크롤 + 변경 시 broadcast', async () => {
  const refresh = spyRefresh();
  let bc = 0;
  const s = createShelfScheduler({
    isEnabled: () => true, isElevated: () => false,
    getCtx: () => ({}), listBookmarks: () => URL_BM, refresh, broadcast: () => { bc += 1; },
  });
  s.start();
  const changed = await s.tick();
  assert.strictEqual(changed, true);
  assert.deepStrictEqual(refresh.calls, ['baaaaaa'], 'url만 재크롤(folder 제외)');
  assert.strictEqual(bc, 1, '변경 시 broadcast 1회');
  s.stop();
});

test('SH-4 — 정지(stopped) 상태면 tick 무동작', async () => {
  const refresh = spyRefresh();
  const s = createShelfScheduler({ isEnabled: () => true, isElevated: () => false, getCtx: () => ({}), listBookmarks: () => URL_BM, refresh, broadcast: () => {} });
  // start 안 함 → stopped=true.
  assert.strictEqual(await s.tick(), false);
  assert.strictEqual(refresh.calls.length, 0);
});

test('SH-4 — url 북마크 없으면 broadcast 안 함', async () => {
  const refresh = spyRefresh();
  let bc = 0;
  const s = createShelfScheduler({ isEnabled: () => true, isElevated: () => false, getCtx: () => ({}), listBookmarks: () => [{ id: 'bccccc1', type: 'folder' }], refresh, broadcast: () => { bc += 1; } });
  s.start();
  assert.strictEqual(await s.tick(), false);
  assert.strictEqual(refresh.calls.length, 0);
  assert.strictEqual(bc, 0);
  s.stop();
});

test('SH-4 — start/stop 멱등(중복 호출 안전)', () => {
  const s = createShelfScheduler({ isEnabled: () => true, getCtx: () => ({}), listBookmarks: () => [], refresh: spyRefresh(), broadcast: () => {} });
  s.start(); s.start(); // 중복 start 무해
  s.stop(); s.stop();    // 중복 stop 무해
  assert.strictEqual(s.isStopped(), true);
});

test('SH-4 — 동시 tick 중복 방지(running 가드)', async () => {
  let inFlight = 0; let maxInFlight = 0;
  const refresh = async () => { inFlight += 1; maxInFlight = Math.max(maxInFlight, inFlight); await new Promise((r) => setTimeout(r, 20)); inFlight -= 1; return { ok: true }; };
  const s = createShelfScheduler({ isEnabled: () => true, isElevated: () => false, getCtx: () => ({}), listBookmarks: () => [{ id: 'bddddd1', type: 'url' }], refresh, broadcast: () => {} });
  s.start();
  const [a, b] = await Promise.all([s.tick(), s.tick()]); // 두 번째는 running 가드로 무동작
  assert.ok(a === true || b === true);
  assert.ok(a === false || b === false, '동시 tick 중 하나는 running 가드로 false');
  s.stop();
});
