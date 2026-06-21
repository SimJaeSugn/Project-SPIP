'use strict';
/**
 * config-persist.test.js — config.persistConfigKeys (M6 P2-1) + loadConfig tools 병합.
 * 부분 갱신 read-merge(타 키 보존)·0600 원자적 쓰기·normalizeTools 편입.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const config = require('../lib/common/config');
const { Logger } = require('../lib/common/logger');

function quiet() { return new Logger({ quiet: true }); }
function tmpCfg() {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'spip-cfg-')));
  return path.join(dir, 'config', 'spip.config.json');
}

test('persistConfigKeys — tools 부분 갱신 시 기존 scanRoots 보존(P2-1)', () => {
  const cfgPath = tmpCfg();
  fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
  fs.writeFileSync(cfgPath, JSON.stringify({ scanRoots: ['/keep/me'], port: 7421 }, null, 2));

  config.persistConfigKeys({ tools: { code: { path: '/abs/Code.exe', label: 'VS Code' } } }, { logger: quiet(), configPath: cfgPath });

  const saved = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  assert.deepStrictEqual(saved.scanRoots, ['/keep/me'], 'scanRoots 보존');
  assert.strictEqual(saved.port, 7421, '기타 키 보존');
  assert.deepStrictEqual(saved.tools.code, { path: '/abs/Code.exe', label: 'VS Code' });
});

test('persistConfigKeys — 부재 파일에서도 생성', () => {
  const cfgPath = tmpCfg();
  config.persistConfigKeys({ scanRoots: ['/a'] }, { logger: quiet(), configPath: cfgPath });
  const saved = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  assert.deepStrictEqual(saved.scanRoots, ['/a']);
});

test('persistConfigKeys — 0600 권한(POSIX)', () => {
  const cfgPath = tmpCfg();
  config.persistConfigKeys({ tools: {} }, { logger: quiet(), configPath: cfgPath });
  if (process.platform !== 'win32') {
    assert.strictEqual(fs.statSync(cfgPath).mode & 0o777, 0o600);
  }
});

test('persistConfigKeys — patch 비객체 → throw', () => {
  assert.throws(() => config.persistConfigKeys('x', { configPath: tmpCfg() }));
  assert.throws(() => config.persistConfigKeys([1], { configPath: tmpCfg() }));
});

test('loadConfig — tools 병합·정규화(args drop·known id 한정)', () => {
  const cfgPath = tmpCfg();
  fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
  fs.writeFileSync(cfgPath, JSON.stringify({
    scanRoots: [],
    tools: {
      code: { path: (process.platform === 'win32' ? 'C:\\x\\Code.exe' : '/abs/Code.exe'), label: 'VS Code', args: ['--evil'] },
      cursor: { path: '/abs/cur.exe' }, // 미등록 → drop
    },
  }, null, 2));
  const { config: cfg } = config.loadConfig({ logger: quiet(), configPath: cfgPath });
  assert.ok(cfg.tools.code, 'code 채택');
  assert.strictEqual(cfg.tools.code.args, undefined, 'args drop(M6-H-2)');
  assert.strictEqual(cfg.tools.cursor, undefined, '미등록 toolId drop(M6-M-1)');
});

test('loadConfig — tools 부재 시 빈 맵 폴백', () => {
  const cfgPath = tmpCfg();
  fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
  fs.writeFileSync(cfgPath, JSON.stringify({ scanRoots: [] }, null, 2));
  const { config: cfg } = config.loadConfig({ logger: quiet(), configPath: cfgPath });
  assert.deepStrictEqual(cfg.tools, {});
});
