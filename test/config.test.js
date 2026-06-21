'use strict';
/**
 * config.test.js — 병합·폴백·scanRoots 정규화·excludes 상한 (S0 DoD ④)
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const config = require('../lib/common/config');
const { Logger } = require('../lib/common/logger');

function quietLogger() {
  return new Logger({ quiet: true });
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'spip-cfg-'));
}

test('파일 부재 시 기본값 적용', () => {
  const logger = quietLogger();
  const missing = path.join(os.tmpdir(), 'spip-no-such-' + Date.now(), 'spip.config.json');
  const { config: c, fileExisted } = config.loadConfig({ configPath: missing, logger });
  assert.strictEqual(fileExisted, false);
  assert.deepStrictEqual(c.scanRoots, []);
  assert.strictEqual(c.staleDays, 90);
  assert.strictEqual(c.port, 7421);
});

test('잘못된 값은 경고 후 기본값으로 폴백', () => {
  const logger = quietLogger();
  const dir = tmpDir();
  const cfgPath = path.join(dir, 'spip.config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({ staleDays: -5, port: 'oops', scanRoots: 'notarray' }));
  const { config: c } = config.loadConfig({ configPath: cfgPath, logger });
  assert.strictEqual(c.staleDays, 90);
  assert.strictEqual(c.port, 7421);
  assert.deepStrictEqual(c.scanRoots, []);
  assert.ok(logger.getWarnings().length >= 3);
});

test('손상된 JSON은 기본값으로 폴백', () => {
  const logger = quietLogger();
  const dir = tmpDir();
  const cfgPath = path.join(dir, 'spip.config.json');
  fs.writeFileSync(cfgPath, '{ this is not json ');
  const { config: c } = config.loadConfig({ configPath: cfgPath, logger });
  assert.strictEqual(c.staleDays, 90);
  assert.ok(logger.getWarnings().some((w) => /파싱/.test(w.reason)));
});

test('scanRoots realpath 정규화: 존재하는 디렉터리만, 중복 제거', () => {
  const logger = quietLogger();
  const dir = tmpDir(); // 실존 디렉터리
  const fakeFile = path.join(dir, 'afile.txt');
  fs.writeFileSync(fakeFile, 'x');
  const roots = config.normalizeScanRoots(
    [dir, dir, fakeFile, '/definitely/not/here/xyz', 123],
    logger
  );
  // 실존 디렉터리 1건만 채택(중복 제거), 파일/미존재/비문자열 제외
  const real = fs.realpathSync.native ? fs.realpathSync.native(dir) : fs.realpathSync(dir);
  assert.deepStrictEqual(roots, [real]);
});

test('excludes 길이·개수 상한(L-2)', () => {
  const logger = quietLogger();
  const longPattern = 'a'.repeat(config.LIMITS.maxExcludePatternLen + 1);
  const many = new Array(config.LIMITS.maxExcludes + 50).fill('node_modules');
  const ex1 = config.normalizeExcludes([longPattern, 'dist'], logger);
  assert.deepStrictEqual(ex1, ['dist']); // 너무 긴 패턴 제외
  const ex2 = config.normalizeExcludes(many, logger);
  assert.ok(ex2.length <= config.LIMITS.maxExcludes);
});

// ───── M4 신규 config 키 ─────
test('M4: 기본값 — depthLimit 24, allowAllDrives false, size.enabled false, scan 가드', () => {
  const logger = quietLogger();
  const missing = path.join(os.tmpdir(), 'spip-m4cfg-' + Date.now(), 'spip.config.json');
  const { config: c } = config.loadConfig({ configPath: missing, logger });
  assert.strictEqual(c.depthLimit, 24);
  assert.strictEqual(c.allowAllDrives, false);
  assert.strictEqual(c.size.enabled, false);
  assert.strictEqual(c.size.budgetMs, 1500);
  assert.strictEqual(c.size.maxDepth, 6);
  assert.strictEqual(c.size.maxEntries, 50000);
  assert.ok(c.scan.watchdogMs > 0);
  assert.ok(c.scan.maxDirs > 0);
});

test('M4: depthLimit 잘못된 값은 24로 폴백, 유효값은 채택', () => {
  const logger = quietLogger();
  const dir = tmpDir();
  const cfgPath = path.join(dir, 'spip.config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({ depthLimit: -3 }));
  const { config: c } = config.loadConfig({ configPath: cfgPath, logger });
  assert.strictEqual(c.depthLimit, 24);

  const cfgPath2 = path.join(dir, 'spip.config2.json');
  fs.writeFileSync(cfgPath2, JSON.stringify({ depthLimit: 8 }));
  const { config: c2 } = config.loadConfig({ configPath: cfgPath2, logger });
  assert.strictEqual(c2.depthLimit, 8);
});

test('M4: size/allowAllDrives 부분 지정 병합', () => {
  const logger = quietLogger();
  const dir = tmpDir();
  const cfgPath = path.join(dir, 'spip.config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({ allowAllDrives: true, size: { enabled: true, budgetMs: 500 } }));
  const { config: c } = config.loadConfig({ configPath: cfgPath, logger });
  assert.strictEqual(c.allowAllDrives, true);
  assert.strictEqual(c.size.enabled, true);
  assert.strictEqual(c.size.budgetMs, 500);
  assert.strictEqual(c.size.maxDepth, 6); // 미지정 기본 유지
});

test('CLI 인자가 파일보다 우선', () => {
  const logger = quietLogger();
  const dir = tmpDir();
  const cfgPath = path.join(dir, 'spip.config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({ port: 8000, staleDays: 30 }));
  const { config: c } = config.loadConfig({
    configPath: cfgPath,
    cliArgs: { port: 9999 },
    logger,
  });
  assert.strictEqual(c.port, 9999); // CLI 우선
  assert.strictEqual(c.staleDays, 30); // 파일 값 유지
});
