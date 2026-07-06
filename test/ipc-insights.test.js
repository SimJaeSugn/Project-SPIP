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

// ── [로드맵 Phase 3·G] days 인자(커밋 히트맵 365일) ──
test('getCommitActivity — args.days 로 범위 조절(하위호환 14 / 클램프 [1,366]) + 수집기에 전달', async () => {
  // 기본(인자 없음) = 14일.
  assert.strictEqual(insights.normalizeDays(undefined), insights.DEFAULT_DAYS);
  // 클램프.
  assert.strictEqual(insights.normalizeDays(0), insights.DEFAULT_DAYS);
  assert.strictEqual(insights.normalizeDays(-3), insights.DEFAULT_DAYS);
  assert.strictEqual(insights.normalizeDays(365), 365);
  assert.strictEqual(insights.normalizeDays(9999), insights.MAX_DAYS);
  assert.strictEqual(insights.normalizeDays(30.9), 30);
  // days 가 수집기·일별 시리즈 길이에 반영.
  let seenDays = null;
  const ctx = {
    store: storeOf([{ id: 'a', path: 'A' }]),
    canonicalize: (p) => p,
    collectCommitActivity: async (p, days) => { seenDays = days; return { ok: true, dates: ['2026-01-10'] }; },
    nowMs: () => new Date(2026, 0, 10).getTime(),
  };
  const r = await insights.getCommitActivity(ctx, { days: 365 });
  assert.strictEqual(seenDays, 365, '수집기에 days 전달');
  assert.strictEqual(r.requestedDays, 365);
  assert.strictEqual(r.days.length, 365, '일별 시리즈 365칸');
});

// ── [로드맵 Phase 3·G] getSystemStatus ──
test('getSystemStatus — config.scanRoots 드라이브만 statfs + os/sleep 주입 통합', async () => {
  const fakeOs = {
    cpus: () => [{ model: 'CPU', times: { user: 5, nice: 0, sys: 5, idle: 90, irq: 0 } }],
    totalmem: () => 8e9, freemem: () => 2e9, homedir: () => 'C:\\Users\\x', uptime: () => 100, platform: () => 'win32',
  };
  let statfsPaths = [];
  const statfs = async (p) => { statfsPaths.push(p); return { bsize: 4096, blocks: 1000, bavail: 500, bfree: 500 }; };
  const r = await insights.getSystemStatus({
    config: { scanRoots: ['C:\\proj', 'c:\\other', 'D:\\repo'] },
    os: fakeOs, statfs, sleep: async () => {}, sampleMs: 0,
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.memory.usagePercent, 75);
  // 드라이브 중복 제거 → C:\, D:\ 두 번만 statfs(임의 경로 미허용).
  assert.deepStrictEqual(statfsPaths.slice().sort(), ['C:\\', 'D:\\']);
  assert.strictEqual(r.disks.length, 2);
});

test('getSystemStatus — 스캔 루트 없으면 홈 드라이브 폴백 + collect 예외 graceful', async () => {
  const fakeOs = { cpus: () => [], totalmem: () => 0, freemem: () => 0, homedir: () => 'E:\\home', uptime: () => 0, platform: () => 'win32' };
  const seen = [];
  const r = await insights.getSystemStatus({ config: {}, os: fakeOs, statfs: async (p) => { seen.push(p); return { bsize: 1, blocks: 10, bavail: 5, bfree: 5 }; }, sleep: async () => {}, sampleMs: 0 });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(seen, ['E:\\'], '루트 없으면 홈 드라이브');
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
