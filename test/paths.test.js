'use strict';
/**
 * paths.test.js — appDir/configPath/cachePath OS 분기 단위 테스트 (S0 DoD ③)
 *
 * process.platform/env를 임시 치환해 3개 OS 분기를 검증한다.
 * paths.js는 호출 시점에 platform/env를 읽으므로 동적 치환이 가능.
 */
const { test, afterEach } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const paths = require('../lib/common/paths');

const origPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
const origEnv = { APPDATA: process.env.APPDATA, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };

function setPlatform(p) {
  Object.defineProperty(process, 'platform', { value: p, configurable: true });
}

afterEach(() => {
  Object.defineProperty(process, 'platform', origPlatform);
  process.env.APPDATA = origEnv.APPDATA;
  process.env.XDG_CONFIG_HOME = origEnv.XDG_CONFIG_HOME;
});

test('win32: %APPDATA% 하위 spip 폴더', () => {
  setPlatform('win32');
  process.env.APPDATA = 'C:\\Users\\me\\AppData\\Roaming';
  const dir = paths.appDir();
  assert.ok(dir.endsWith(path.join('Roaming', 'spip')), dir);
});

test('darwin: ~/Library/Application Support/spip', () => {
  setPlatform('darwin');
  const dir = paths.appDir();
  assert.ok(dir.includes(path.join('Library', 'Application Support', 'spip')), dir);
});

test('linux: XDG_CONFIG_HOME 우선', () => {
  setPlatform('linux');
  process.env.XDG_CONFIG_HOME = '/custom/xdg';
  const dir = paths.appDir();
  assert.strictEqual(dir, path.join('/custom/xdg', 'spip'));
});

test('linux: XDG 부재 시 ~/.config 폴백', () => {
  setPlatform('linux');
  delete process.env.XDG_CONFIG_HOME;
  const dir = paths.appDir();
  assert.ok(dir.endsWith(path.join('.config', 'spip')), dir);
});

test('configPath / cachePath 계약', () => {
  const cfg = paths.configPath();
  const cache = paths.cachePath();
  assert.ok(cfg.endsWith(path.join('config', 'spip.config.json')), cfg);
  assert.ok(cache.endsWith(path.join('cache', 'projects.json')), cache);
  assert.strictEqual(path.dirname(path.dirname(cfg)), paths.appDir());
});
