'use strict';
/**
 * elevation-write-hold.test.js — M12 b3 write 보류 3경로 + rescan ELEVATED + 비상승 회귀
 *
 *   · elevated:true 면 serializer.writeSnapshot / uiStateStore.write / config.persistConfigKeys 가
 *     디스크 write no-op(파일 미생성). 메모리/정규화 결과는 그대로.
 *   · elevated:false 면 3경로 모두 정상 write(불변·회귀 0). 비밀번호 키가 디스크에 안 떨어짐 검증.
 *   · actions.rescan 이 elevated 시 {ok:false,code:'ELEVATED'} 반환 + controller.acquire 미호출.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const serializer = require('../lib/scan/serializer');
const uiStateStore = require('../lib/common/uiStateStore');
const config = require('../lib/common/config');
const actions = require('../electron/ipc/actions');
const elevationState = require('../lib/common/elevationState');
const { Logger } = require('../lib/common/logger');

function quiet() { return new Logger({ quiet: true }); }
function tmpFile(name) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'spip-m12-')));
  return path.join(dir, name);
}
// elevated 플래그를 주입하는 가짜 elevationState.
function elev(on) { return { isElevated: () => on === true }; }

// 중앙 모듈 상태가 테스트 간 새지 않도록 각 테스트 후 reset.
function withGlobalReset(fn) {
  try { fn(); } finally { elevationState.reset(); }
}

/* ── serializer.writeSnapshot ── */
test('writeSnapshot — elevated:true 면 디스크 write no-op(파일 미생성) (M12-2a)', () => {
  const cachePath = tmpFile('cache/projects.json');
  const res = serializer.writeSnapshot({ projects: [{ id: 'a' }] }, {
    cachePath, logger: quiet(), deps: { elevationState: elev(true) },
  });
  assert.strictEqual(res.written, false, 'written:false');
  assert.strictEqual(fs.existsSync(cachePath), false, '파일 미생성');
});

test('writeSnapshot — elevated:false 면 정상 write(회귀 불변) (M12-3)', () => {
  const cachePath = tmpFile('cache/projects.json');
  const res = serializer.writeSnapshot({ projects: [{ id: 'a' }] }, {
    cachePath, logger: quiet(), deps: { elevationState: elev(false) },
  });
  assert.strictEqual(res.written, true);
  assert.strictEqual(fs.existsSync(cachePath), true, '파일 생성');
});

/* ── uiStateStore.write ── */
test('uiStateStore.write — elevated:true 면 no-op(파일 미생성), 정규화 결과는 반환 (M12-2b)', () => {
  const uiStatePath = tmpFile('ui-state/ui-state.json');
  const out = uiStateStore.write({ favorites: ['abc'], theme: 'dark' }, {
    uiStatePath, logger: quiet(), deps: { elevationState: elev(true) },
  });
  assert.strictEqual(fs.existsSync(uiStatePath), false, '파일 미생성');
  assert.strictEqual(out.theme, 'dark', '정규화 메모리 결과 반환');
  assert.deepStrictEqual(out.favorites, ['abc']);
});

test('uiStateStore.write — elevated:false 면 정상 write(회귀 불변) (M12-3)', () => {
  const uiStatePath = tmpFile('ui-state/ui-state.json');
  uiStateStore.write({ favorites: ['abc'] }, {
    uiStatePath, logger: quiet(), deps: { elevationState: elev(false) },
  });
  assert.strictEqual(fs.existsSync(uiStatePath), true, '파일 생성');
  const saved = JSON.parse(fs.readFileSync(uiStatePath, 'utf8'));
  assert.deepStrictEqual(saved.favorites, ['abc']);
});

/* ── config.persistConfigKeys (가장 민감 — 비밀번호) ── */
test('persistConfigKeys — elevated:true 면 no-op(파일 미생성), 비밀번호 디스크 미기록 (M12-2c)', () => {
  const cfgPath = tmpFile('config/spip.config.json');
  config.persistConfigKeys(
    { mailAccounts: [{ id: 'm1', user: 'u', pass: 'SECRET-PW' }] },
    { configPath: cfgPath, logger: quiet(), deps: { elevationState: elev(true) } }
  );
  assert.strictEqual(fs.existsSync(cfgPath), false, '파일 미생성 — 비밀번호 디스크 미기록');
});

test('persistConfigKeys — elevated:false 면 정상 write(회귀 불변) (M12-3)', () => {
  const cfgPath = tmpFile('config/spip.config.json');
  config.persistConfigKeys(
    { scanRoots: ['/a'] },
    { configPath: cfgPath, logger: quiet(), deps: { elevationState: elev(false) } }
  );
  assert.strictEqual(fs.existsSync(cfgPath), true);
  const saved = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  assert.deepStrictEqual(saved.scanRoots, ['/a']);
});

test('persistConfigKeys — deps.elevationState 미주입(기본 중앙 모듈) + 미설정이면 정상 write(회귀)', () => {
  withGlobalReset(() => {
    elevationState.reset(); // 기본 false(비상승)
    const cfgPath = tmpFile('config/spip.config.json');
    config.persistConfigKeys({ scanRoots: ['/b'] }, { configPath: cfgPath, logger: quiet() });
    assert.strictEqual(fs.existsSync(cfgPath), true, '중앙 플래그 false면 정상 write');
  });
});

/* ── rescan ELEVATED ── */
function fakeController() {
  return {
    _acquired: false,
    status: () => ({ scanId: 'sid-current', phase: 'idle' }),
    acquire: function () { this._acquired = true; return { scanId: 'sid-new', startedAt: 'T0' }; },
    start: function (opts) { this._started = opts; },
  };
}

test('rescan — elevated 시 {ok:false,code:ELEVATED} + acquire 미호출 (M12-2b)', () => {
  const c = fakeController();
  const r = actions.rescan({}, {
    scanController: c,
    config: { scanRoots: ['/a'] },
    store: {},
    elevationState: elev(true),
  });
  assert.deepStrictEqual(r, { ok: false, code: 'ELEVATED' });
  assert.strictEqual(c._acquired, false, 'acquire/start 이전 조기 반환');
});

test('rescan — 비상승이면 기존 흐름 불변(SCAN_STARTED) (M12-3)', () => {
  const c = fakeController();
  const r = actions.rescan({}, {
    scanController: c,
    config: { scanRoots: ['/a'] },
    store: {},
    elevationState: elev(false),
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.code, 'SCAN_STARTED');
  assert.strictEqual(c._acquired, true);
});

test('rescan — elevationState 미주입(기본 중앙 모듈) + 미설정이면 정상 동작(회귀)', () => {
  withGlobalReset(() => {
    elevationState.reset();
    const c = fakeController();
    const r = actions.rescan({}, { scanController: c, config: { scanRoots: ['/a'] }, store: {} });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.code, 'SCAN_STARTED');
  });
});

/* ── 중앙 elevationState 모듈 단위 ── */
test('elevationState — set/isElevated/reset', () => {
  withGlobalReset(() => {
    assert.strictEqual(elevationState.isElevated(), false, '기본 false');
    elevationState.setElevated(true);
    assert.strictEqual(elevationState.isElevated(), true);
    elevationState.setElevated('truthy-but-not-true');
    assert.strictEqual(elevationState.isElevated(), false, 'Boolean === true 강제');
    elevationState.setElevated(true);
    elevationState.reset();
    assert.strictEqual(elevationState.isElevated(), false);
  });
});
