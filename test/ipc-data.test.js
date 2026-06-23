'use strict';
/**
 * ipc-data.test.js — electron/ipc/data.js 순수 함수 (헤드리스 검증, F-3)
 * getProjects·getStats·getHealth·getConfig 반환 shape·집계 로직.
 */
const { test } = require('node:test');
const assert = require('node:assert');

const data = require('../electron/ipc/data');

function fakeStore(opts) {
  opts = opts || {};
  return {
    schemaVersion: opts.schemaVersion || 1,
    generatedAt: opts.generatedAt || '2026-01-01T00:00:00.000Z',
    hasSnapshot: opts.hasSnapshot !== false,
    stats: { totalBytes: opts.totalBytes === undefined ? null : opts.totalBytes },
    getProjects: () => opts.projects || [],
  };
}

test('getProjects — 스냅샷 shape 그대로 반환', () => {
  const projects = [{ id: 'a', path: '/x', name: 'A' }];
  const r = data.getProjects({ store: fakeStore({ projects }) });
  assert.deepStrictEqual(Object.keys(r).sort(), ['generatedAt', 'hasSnapshot', 'projects', 'schemaVersion']);
  assert.strictEqual(r.projects.length, 1);
  assert.strictEqual(r.hasSnapshot, true);
});

test('getStats — byLanguage·staleCount 집계', () => {
  const projects = [
    { id: '1', path: '/a', language: { primary: 'JavaScript' }, freshness: { isStale: true } },
    { id: '2', path: '/b', language: { primary: 'JavaScript' }, freshness: { isStale: false } },
    { id: '3', path: '/c', language: { primary: 'Python' } },
    { id: '4', path: '/d' }, // language 없음 → Unknown
  ];
  const r = data.getStats({ store: fakeStore({ projects, totalBytes: 1234 }) });
  assert.strictEqual(r.total, 4);
  assert.strictEqual(r.byLanguage.JavaScript, 2);
  assert.strictEqual(r.byLanguage.Python, 1);
  assert.strictEqual(r.byLanguage.Unknown, 1);
  assert.strictEqual(r.staleCount, 1);
  assert.strictEqual(r.totalBytes, 1234);
});

test('getStats — totalBytes 미측정이면 null', () => {
  const r = data.getStats({ store: fakeStore({ projects: [], totalBytes: null }) });
  assert.strictEqual(r.totalBytes, null);
});

test('getHealth — resolveBin 주입으로 codeCli/git 판정', () => {
  const r = data.getHealth({
    store: fakeStore({}),
    resolveBin: (name) => (name === 'code' ? '/usr/bin/code' : null),
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.codeCli, true);
  assert.strictEqual(r.git, false);
  assert.strictEqual(r.hasSnapshot, true);
});

test('getConfig — 명시 shape만 노출(size:{enabled,maxBytes,maxEntries})', () => {
  const r = data.getConfig({
    config: {
      scanRoots: ['/proj/a'],
      staleDays: 90,
      allowAllDrives: true,
      size: { enabled: true, maxEntries: 50000, budgetMs: 1500, deepNodeModules: true },
      port: 7421, // 비노출 키
    },
  });
  assert.deepStrictEqual(Object.keys(r).sort(), ['allowAllDrives', 'excludes', 'scanRoots', 'size', 'staleDays']);
  assert.deepStrictEqual(r.scanRoots, ['/proj/a']);
  assert.strictEqual(r.allowAllDrives, true);
  assert.deepStrictEqual(Object.keys(r.size).sort(), ['enabled', 'maxBytes', 'maxEntries']);
  assert.strictEqual(r.size.enabled, true);
  assert.strictEqual(r.size.maxEntries, 50000);
  // port·budgetMs·deepNodeModules는 비노출.
  assert.strictEqual(r.port, undefined);
  assert.strictEqual(r.size.budgetMs, undefined);
});

test('getConfig — config 부재 시 안전 기본', () => {
  const r = data.getConfig({});
  assert.deepStrictEqual(r.scanRoots, []);
  assert.strictEqual(r.allowAllDrives, false);
  assert.strictEqual(r.size.enabled, false);
});
