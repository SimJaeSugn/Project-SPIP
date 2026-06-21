'use strict';
/**
 * electron-context.test.js — electron/context.js buildContext (헤드리스, 단계 1 [자동])
 * ctx 형태 { config, store, scanController, cachePath, logger } 검증.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { buildContext } = require('../electron/context');
const { Logger } = require('../lib/common/logger');

test('buildContext — ctx 형태 반환(스냅샷 부재 graceful)', () => {
  const missing = path.join(os.tmpdir(), 'spip-ctx-' + Date.now(), 'projects.json');
  const ctx = buildContext({ logger: new Logger({ quiet: true }), cachePath: missing });
  assert.ok(ctx.config && typeof ctx.config === 'object');
  assert.ok(ctx.store && typeof ctx.store.getProjects === 'function');
  assert.ok(ctx.scanController && typeof ctx.scanController.status === 'function');
  assert.strictEqual(ctx.cachePath, missing);
  assert.ok(ctx.logger);
  // 스냅샷 부재 → hasSnapshot false, 빈 projects.
  assert.strictEqual(ctx.store.hasSnapshot, false);
  assert.deepStrictEqual(ctx.store.getProjects(), []);
  assert.strictEqual(ctx.scanController.status().phase, 'idle');
});

test('buildContext — 스냅샷 적재(정상 캐시)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spip-ctx-'));
  const cachePath = path.join(dir, 'projects.json');
  fs.writeFileSync(cachePath, JSON.stringify({
    schemaVersion: 1, generatedAt: '2026-01-01T00:00:00.000Z',
    projects: [{ id: 'a', path: dir, name: 'A' }],
  }));
  const ctx = buildContext({ logger: new Logger({ quiet: true }), cachePath });
  assert.strictEqual(ctx.store.hasSnapshot, true);
  assert.strictEqual(ctx.store.getProjects().length, 1);
});
