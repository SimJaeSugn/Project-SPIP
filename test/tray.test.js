'use strict';
/**
 * tray.test.js — electron/tray.js (M6 R-21, 헤드리스 F-3)
 * buildTrayMenuTemplate 구조·콜백 디스패치·action 화이트리스트·createTray(Electron stub 주입).
 */
const { test } = require('node:test');
const assert = require('node:assert');

const tray = require('../electron/tray');

test('TRAY_ACTIONS — dashboard|favorites 고정 화이트리스트 (M6-M-3)', () => {
  assert.deepStrictEqual([...tray.TRAY_ACTIONS], ['dashboard', 'favorites']);
});

test('buildTrayMenuTemplate — 대시보드/즐겨찾기/구분선/종료', () => {
  const t = tray.buildTrayMenuTemplate({});
  const labels = t.filter((x) => x.label).map((x) => x.label);
  assert.deepStrictEqual(labels, ['대시보드 열기', '즐겨찾기', '종료']);
  assert.ok(t.some((x) => x.type === 'separator'));
});

test('buildTrayMenuTemplate — click 콜백 디스패치', () => {
  const seen = [];
  const t = tray.buildTrayMenuTemplate({
    onShowDashboard: () => seen.push('dash'),
    onShowFavorites: () => seen.push('fav'),
    onQuit: () => seen.push('quit'),
  });
  for (const item of t) if (typeof item.click === 'function') item.click();
  assert.deepStrictEqual(seen, ['dash', 'fav', 'quit']);
});

test('buildTrayMenuTemplate — 콜백 미제공도 throw 안 함', () => {
  const t = tray.buildTrayMenuTemplate({});
  for (const item of t) if (typeof item.click === 'function') assert.doesNotThrow(() => item.click());
});

// ── createTray (Electron stub 주입) ──
function fakeElectron() {
  const events = {};
  const trayObj = {
    setToolTip() {},
    setContextMenu() {},
    on(ev, h) { events[ev] = h; },
    destroy() { trayObj._destroyed = true; },
    _destroyed: false,
    _events: events,
  };
  return {
    Tray: function () { return trayObj; },
    Menu: { buildFromTemplate: (tpl) => ({ tpl }) },
    nativeImage: { createFromPath: () => ({ isEmpty: () => true }), createEmpty: () => ({ empty: true }) },
    _trayObj: trayObj,
  };
}

test('createTray — Tray 생성·메뉴 설정·double-click 핸들러·destroy', () => {
  const el = fakeElectron();
  const { tray: t, destroy } = tray.createTray({
    deps: el,
    onShowDashboard: () => {},
    onShowFavorites: () => {},
    onQuit: () => {},
  });
  assert.strictEqual(t, el._trayObj);
  assert.strictEqual(typeof el._trayObj._events['double-click'], 'function');
  destroy();
  assert.strictEqual(el._trayObj._destroyed, true);
});

test('createTray — Tray/Menu 미가용 시 throw', () => {
  assert.throws(() => tray.createTray({ deps: {} }));
});
