'use strict';
/**
 * preload-favorites-contract.test.js — electron/preload-favorites.js 노출 표면 (M7 §5·§6.2 · SEC-M3)
 *
 * 위젯 전용 축소 preload가 6채널만 노출하고, ipcRenderer 원본·generic invoke를 노출하지 않으며,
 * 강력 채널을 단 하나도 노출하지 않는지 정적 파싱으로 검증한다(Electron 미설치 동작).
 *
 * 추가로 contextBridge 호출(런타임 노출 형태)을 모킹으로 실측해 6개 함수가 실제로 노출되고
 * 각 채널명이 하드코딩 채널로 invoke되는지 검증한다.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const ROOT = path.join(__dirname, '..');
const SRC_PATH = path.join(ROOT, 'electron', 'preload-favorites.js');
const SRC = fs.readFileSync(SRC_PATH, 'utf8');

const ALLOWED = ['getUiState', 'getProjects', 'open', 'copyText', 'setFavorite', 'onFavoritesChanged', 'openDashboard'];
// 위젯에 절대 노출되면 안 되는 강력 채널(체크리스트 §11.1).
const FORBIDDEN = [
  'setToolPath', 'pickToolExecutable', 'setOrder', 'setSortMode',
  'rescan', 'addRoots', 'removeRoot', 'pickFolders',
  'getStats', 'getHealth', 'getConfig', 'getScanStatus', 'getTools',
  'onScanProgress', 'onMenu', 'onTray',
];

/** electron 모킹으로 preload-favorites를 로드해 실제 노출 객체를 캡처. */
function loadExposed() {
  const calls = [];
  const listeners = {};
  const fakeElectron = {
    contextBridge: {
      exposeInMainWorld: (key, api) => { fakeElectron._exposed = { key, api }; },
    },
    ipcRenderer: {
      invoke: (channel, payload) => { calls.push({ channel, payload }); return Promise.resolve({ ok: true }); },
      on: (channel, h) => { listeners[channel] = h; },
      removeListener: () => {},
    },
  };
  // require('electron')을 모킹.
  const origResolve = Module._resolveFilename;
  const origLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') return fakeElectron;
    return origLoad.apply(this, [request, parent, isMain]);
  };
  try {
    delete require.cache[require.resolve('../electron/preload-favorites')];
    require('../electron/preload-favorites');
  } finally {
    Module._load = origLoad;
    Module._resolveFilename = origResolve;
    delete require.cache[require.resolve('../electron/preload-favorites')];
  }
  return { exposed: fakeElectron._exposed, calls, listeners };
}

test('preload-favorites — exposeInMainWorld(spip) 7개 함수만 노출', () => {
  const { exposed } = loadExposed();
  assert.ok(exposed, 'exposeInMainWorld 호출되어야 함');
  assert.strictEqual(exposed.key, 'spip');
  const keys = Object.keys(exposed.api).sort();
  assert.deepStrictEqual(keys, [...ALLOWED].sort(), '정확히 7개 함수만 노출: ' + JSON.stringify(keys));
  for (const fn of ALLOWED) assert.strictEqual(typeof exposed.api[fn], 'function');
});

test('SEC-M3 — 강력 채널 단 하나도 노출 안 함(체크리스트 §11.1)', () => {
  const { exposed } = loadExposed();
  for (const fn of FORBIDDEN) {
    assert.strictEqual(exposed.api[fn], undefined, '강력 채널 노출 금지: ' + fn);
  }
});

test('SEC-M3 MUST — ipcRenderer 원본 비노출 · generic invoke 비노출', () => {
  const { exposed } = loadExposed();
  // ipcRenderer 자체나 invoke를 노출하지 않음.
  assert.strictEqual(exposed.api.ipcRenderer, undefined);
  assert.strictEqual(exposed.api.invoke, undefined);
  assert.strictEqual(exposed.api.send, undefined);
  assert.strictEqual(exposed.api.on, undefined);
  // 소스에 generic invoke 노출 패턴(invoke: ... ipcRenderer.invoke(channel))이 없어야 함.
  assert.ok(!/\binvoke\s*:/.test(SRC), 'generic invoke 키 노출 금지');
});

test('SEC-M3 — 각 액션이 하드코딩 채널로 invoke(인자 형태 1차 고정)', () => {
  const { exposed, calls } = loadExposed();
  exposed.api.getUiState();
  exposed.api.getProjects();
  exposed.api.open('aa11', 'code');
  exposed.api.copyText('x');
  exposed.api.setFavorite('bb22', true);
  exposed.api.openDashboard();
  const byCh = calls.reduce((m, c) => { m[c.channel] = c.payload; return m; }, {});
  assert.ok('spip:getUiState' in byCh);
  assert.ok('spip:getProjects' in byCh);
  assert.deepStrictEqual(byCh['spip:openInVsCode'], { id: 'aa11', toolId: 'code' });
  assert.deepStrictEqual(byCh['spip:copyText'], { text: 'x' });
  assert.deepStrictEqual(byCh['spip:setFavorite'], { id: 'bb22', on: true });
  assert.ok('spip:openDashboard' in byCh);
});

test('onFavoritesChanged — spip:favorites-changed 구독 + payload 중계 + unsubscribe', () => {
  const { exposed, listeners } = loadExposed();
  let received = null;
  const off = exposed.api.onFavoritesChanged((p) => { received = p; });
  assert.strictEqual(typeof off, 'function');
  assert.strictEqual(typeof listeners['spip:favorites-changed'], 'function');
  listeners['spip:favorites-changed']({}, { favorites: ['aa11'] });
  assert.deepStrictEqual(received, { favorites: ['aa11'] });
  // 비함수 콜백은 no-op unsubscribe 반환(throw 없음).
  assert.strictEqual(typeof exposed.api.onFavoritesChanged(null), 'function');
});

test('정적 — exposeInMainWorld(spip) 단일 호출 + 채널명 하드코딩', () => {
  assert.ok(/exposeInMainWorld\(\s*'spip'/.test(SRC));
  for (const ch of ['spip:getUiState', 'spip:getProjects', 'spip:openInVsCode', 'spip:copyText', 'spip:setFavorite', 'spip:openDashboard', 'spip:favorites-changed']) {
    assert.ok(SRC.includes("'" + ch + "'"), '하드코딩 채널 누락: ' + ch);
  }
});
