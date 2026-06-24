'use strict';
/**
 * ipc-insights.test.js — electron/ipc/insights.js (헤드리스, store/canonicalize/collect/nowMs 주입)
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
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

// ── [항목2] Claude Code 로컬 로그 토큰 사용량 ──

test('getClaudeUsage — .claude 부재 homeDir → ok:true·available:false(graceful)', () => {
  const homeDir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'spip-cu-')));
  try {
    const r = insights.getClaudeUsage({ homeDir });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.available, false);
    assert.deepStrictEqual(r.byModel, []);
    assert.strictEqual(r.scannedFiles, 0);
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test('getClaudeUsage — 집계 응답에 ok 래핑 + 표준 필드 노출', () => {
  const homeDir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'spip-cu2-')));
  try {
    const dir = path.join(homeDir, '.claude', 'projects', 'proj');
    fs.mkdirSync(dir, { recursive: true });
    const line = JSON.stringify({
      type: 'assistant', timestamp: '2026-06-25T01:00:00.000Z', requestId: 'req_1',
      message: { id: 'msg_1', model: 'claude-opus-4-8', usage: { input_tokens: 100, output_tokens: 30, cache_read_input_tokens: 5 } },
    });
    fs.writeFileSync(path.join(dir, 's1.jsonl'), line + '\n');
    const r = insights.getClaudeUsage({ homeDir, nowMs: () => Date.parse('2026-06-25T05:00:00.000Z') });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.available, true);
    assert.strictEqual(r.totals.totalTokens, 135); // input100 + output30 + cacheRead5
    assert.ok(Array.isArray(r.byModel) && r.byModel.length >= 1);
    assert.strictEqual(r.byModel[0].model, 'claude-opus-4-8');
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});
