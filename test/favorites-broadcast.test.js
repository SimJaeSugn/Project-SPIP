'use strict';
/**
 * favorites-broadcast.test.js — register.js setFavorite broadcast (M7 §6.3 · SEC-M2, 헤드리스)
 *
 * setFavorite 성공 시 spip:favorites-changed를 메인 wc + 위젯 wc 양쪽에 push하고,
 * payload가 { favorites } 한정이며, 파괴된 wc로는 send하지 않음(isDestroyed 가드)을 검증한다.
 */
const { test } = require('node:test');
const assert = require('node:assert');

const { registerIpcHandlers } = require('../electron/ipc/register');
const { Logger } = require('../lib/common/logger');
const realStore = require('../lib/common/uiStateStore');

function fakeIpcMain() {
  const handlers = {};
  return {
    handlers,
    handle: (ch, fn) => { handlers[ch] = fn; },
    invoke: (ch, event, ...args) => handlers[ch](event, ...args),
  };
}

// uiStateStore를 인메모리 stub으로 ctx에 주입.
function memStore(initial) {
  let state = realStore.normalizeState(initial || {});
  return { read: () => state, write: (s) => { state = realStore.normalizeState(s); return state; } };
}
function fakeCtx(store) {
  return { uiStateStore: store, logger: new Logger({ quiet: true }) };
}

function fakeWc() {
  const sent = [];
  return {
    sent,
    _destroyed: false,
    isDestroyed() { return this._destroyed; },
    send(ch, p) { sent.push({ ch, p }); },
  };
}

const TRUSTED = { senderFrame: { url: 'app://favorites.html' } };

test('broadcast — setFavorite 성공 시 메인+위젯 wc 양쪽에 favorites-changed push', async () => {
  const ipcMain = fakeIpcMain();
  const mainWc = fakeWc();
  const widgetWc = fakeWc();
  registerIpcHandlers({
    ipcMain, dialog: {}, ctx: fakeCtx(memStore()), logger: new Logger({ quiet: true }),
    getWebContents: () => mainWc, getFavoritesWidgetWc: () => widgetWc, getWin: () => null,
  });
  const r = await ipcMain.invoke('spip:setFavorite', TRUSTED, { id: 'aa11', on: true });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.favorites, ['aa11']);
  // 양 창 모두 push 수신.
  assert.strictEqual(mainWc.sent.length, 1);
  assert.strictEqual(widgetWc.sent.length, 1);
  assert.strictEqual(mainWc.sent[0].ch, 'spip:favorites-changed');
  assert.strictEqual(widgetWc.sent[0].ch, 'spip:favorites-changed');
});

test('SEC-M2 — payload 스키마는 { favorites } 한정(경로/내부상태 없음)', async () => {
  const ipcMain = fakeIpcMain();
  const mainWc = fakeWc();
  registerIpcHandlers({
    ipcMain, dialog: {}, ctx: fakeCtx(memStore()), logger: new Logger({ quiet: true }),
    getWebContents: () => mainWc, getFavoritesWidgetWc: () => null, getWin: () => null,
  });
  await ipcMain.invoke('spip:setFavorite', TRUSTED, { id: 'bb22', on: true });
  const payload = mainWc.sent[0].p;
  assert.deepStrictEqual(Object.keys(payload), ['favorites']);
  assert.deepStrictEqual(payload.favorites, ['bb22']);
});

test('SEC-M2 — 파괴된 wc로는 send 안 함(isDestroyed 가드)', async () => {
  const ipcMain = fakeIpcMain();
  const mainWc = fakeWc();
  const widgetWc = fakeWc();
  widgetWc._destroyed = true; // 위젯 파괴 상태
  registerIpcHandlers({
    ipcMain, dialog: {}, ctx: fakeCtx(memStore()), logger: new Logger({ quiet: true }),
    getWebContents: () => mainWc, getFavoritesWidgetWc: () => widgetWc, getWin: () => null,
  });
  await ipcMain.invoke('spip:setFavorite', TRUSTED, { id: 'aa11', on: true });
  assert.strictEqual(mainWc.sent.length, 1, '생존 메인 wc는 수신');
  assert.strictEqual(widgetWc.sent.length, 0, '파괴 위젯 wc는 미수신');
});

test('broadcast — 위젯 wc가 null(위젯 미생성)이어도 메인만 push·throw 없음', async () => {
  const ipcMain = fakeIpcMain();
  const mainWc = fakeWc();
  registerIpcHandlers({
    ipcMain, dialog: {}, ctx: fakeCtx(memStore()), logger: new Logger({ quiet: true }),
    getWebContents: () => mainWc, getFavoritesWidgetWc: () => null, getWin: () => null,
  });
  await ipcMain.invoke('spip:setFavorite', TRUSTED, { id: 'aa11', on: true });
  assert.strictEqual(mainWc.sent.length, 1);
});

test('broadcast — setFavorite 실패(INVALID_ID) 시 push 안 함', async () => {
  const ipcMain = fakeIpcMain();
  const mainWc = fakeWc();
  registerIpcHandlers({
    ipcMain, dialog: {}, ctx: fakeCtx(memStore()), logger: new Logger({ quiet: true }),
    getWebContents: () => mainWc, getFavoritesWidgetWc: () => null, getWin: () => null,
  });
  const r = await ipcMain.invoke('spip:setFavorite', TRUSTED, { id: 'BAD!', on: true });
  assert.deepStrictEqual(r, { ok: false, code: 'INVALID_ID' });
  assert.strictEqual(mainWc.sent.length, 0, '실패 시 broadcast 없음');
});

test('broadcast — getFavoritesWidgetWc 미주입(레거시 호출)도 throw 없음', async () => {
  const ipcMain = fakeIpcMain();
  const mainWc = fakeWc();
  registerIpcHandlers({
    ipcMain, dialog: {}, ctx: fakeCtx(memStore()), logger: new Logger({ quiet: true }),
    getWebContents: () => mainWc, getWin: () => null, // getFavoritesWidgetWc 없음
  });
  const r = await ipcMain.invoke('spip:setFavorite', TRUSTED, { id: 'aa11', on: true });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(mainWc.sent.length, 1);
});

test('senderFrame — 위젯 app://favorites.html origin도 guard 통과', async () => {
  const ipcMain = fakeIpcMain();
  registerIpcHandlers({
    ipcMain, dialog: {}, ctx: fakeCtx(memStore()), logger: new Logger({ quiet: true }),
    getWebContents: () => null, getFavoritesWidgetWc: () => null, getWin: () => null,
  });
  const r = await ipcMain.invoke('spip:setFavorite', { senderFrame: { url: 'app://favorites.html' } }, { id: 'aa11', on: true });
  assert.strictEqual(r.ok, true);
});
