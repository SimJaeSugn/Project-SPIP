'use strict';
/**
 * commitActivity.test.js — lib/scan/collectors/commitActivity.js (헤드리스, F-3)
 *   parseCommitDates / buildDailySeries(순수) + collect(deps 주입).
 */
const { test } = require('node:test');
const assert = require('node:assert');
const ca = require('../lib/scan/collectors/commitActivity');

test('parseCommitDates — YYYY-MM-DD만 추출', () => {
  assert.deepStrictEqual(ca.parseCommitDates('2026-01-01\n2026-01-01\n2026-01-03\ngarbage\n'),
    ['2026-01-01', '2026-01-01', '2026-01-03']);
  assert.deepStrictEqual(ca.parseCommitDates(''), []);
  assert.deepStrictEqual(ca.parseCommitDates(null), []);
});

test('buildDailySeries — N일 0채움·집계·오래된→최신', () => {
  const now = new Date(2026, 0, 10, 12, 0, 0).getTime();
  const s = ca.buildDailySeries(['2026-01-10', '2026-01-10', '2026-01-08'], 3, now);
  assert.deepStrictEqual(s.map((x) => x.date), ['2026-01-08', '2026-01-09', '2026-01-10']);
  assert.deepStrictEqual(s.map((x) => x.count), [1, 0, 2]);
});

test('buildDailySeries — 빈 입력은 전부 0', () => {
  const now = new Date(2026, 0, 10, 12).getTime();
  const s = ca.buildDailySeries([], 14, now);
  assert.strictEqual(s.length, 14);
  assert.ok(s.every((x) => x.count === 0));
});

test('collect — git 미설치 시 graceful', async () => {
  assert.deepStrictEqual(await ca.collect('/p', { resolveGit: () => null }), { ok: false, dates: [] });
});

test('collect — runGitLog 주입으로 dates 파싱', async () => {
  const ok = await ca.collect('/p', { resolveGit: () => 'git', runGitLog: async () => ({ ok: true, stdout: '2026-01-01\n2026-01-02\n' }) });
  assert.deepStrictEqual(ok, { ok: true, dates: ['2026-01-01', '2026-01-02'] });
  const fail = await ca.collect('/p', { resolveGit: () => 'git', runGitLog: async () => ({ ok: false, stdout: '' }) });
  assert.deepStrictEqual(fail, { ok: false, dates: [] });
});
