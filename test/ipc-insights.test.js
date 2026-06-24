'use strict';
/**
 * ipc-insights.test.js — electron/ipc/insights.js (헤드리스, store/canonicalize/collect/nowMs 주입)
 */
const { test } = require('node:test');
const assert = require('node:assert');
const insights = require('../electron/ipc/insights');

const storeOf = (projects) => ({ getProjects: () => projects.slice() });

test('getCommitActivity — 합산·canonicalize 건너뜀·일별 집계', async () => {
  const now = new Date(2026, 0, 10, 12).getTime();
  const ctx = {
    store: storeOf([{ id: 'a', path: 'A' }, { id: 'b', path: 'B' }, { id: 'g', path: 'GONE' }]),
    canonicalize: (p) => (p === 'GONE' ? null : p),
    collectCommitActivity: async (p) => (p === 'A' ? { ok: true, dates: ['2026-01-10', '2026-01-09'] }
      : (p === 'B' ? { ok: true, dates: ['2026-01-10'] } : { ok: false, dates: [] })),
    nowMs: () => now,
  };
  const r = await insights.getCommitActivity(ctx);
  assert.ok(r.ok);
  assert.strictEqual(r.scanned, 2, 'GONE(canonicalize null)은 미집계');
  assert.strictEqual(r.repos, 2);
  assert.strictEqual(r.total, 3);
  assert.strictEqual(r.days.length, insights.DEFAULT_DAYS);
  const byDate = Object.fromEntries(r.days.map((d) => [d.date, d.count]));
  assert.strictEqual(byDate['2026-01-10'], 2);
  assert.strictEqual(byDate['2026-01-09'], 1);
});

test('getCommitActivity — 수집 예외는 계정 단위 격리', async () => {
  const ctx = {
    store: storeOf([{ id: 'a', path: 'A' }, { id: 'b', path: 'B' }]),
    canonicalize: (p) => p,
    collectCommitActivity: async (p) => { if (p === 'A') throw new Error('boom'); return { ok: true, dates: ['2026-01-05'] }; },
    nowMs: () => new Date(2026, 0, 10).getTime(),
  };
  const r = await insights.getCommitActivity(ctx);
  assert.strictEqual(r.repos, 1, 'A 예외 격리, B만 기여');
  assert.strictEqual(r.total, 1);
});

test('getCommitActivity — 빈 스냅샷 graceful', async () => {
  const r = await insights.getCommitActivity({ store: storeOf([]), nowMs: () => 0 });
  assert.deepStrictEqual({ ok: r.ok, repos: r.repos, total: r.total }, { ok: true, repos: 0, total: 0 });
});
