'use strict';
/**
 * ipc-register.test.js — electron/ipc/register.js wiring + 공통 게이트 (헤드리스)
 * ipcMain 모킹으로 발신자 검증·INTERNAL 래핑·채널 등록을 검증.
 */
const { test } = require('node:test');
const assert = require('node:assert');

const { registerIpcHandlers } = require('../electron/ipc/register');
const { Logger } = require('../lib/common/logger');

function fakeIpcMain() {
  const handlers = {};
  return {
    handlers,
    handle: (ch, fn) => { handlers[ch] = fn; },
    invoke: (ch, event, ...args) => handlers[ch](event, ...args),
  };
}

function fakeCtx() {
  return {
    config: { scanRoots: [], size: {} },
    store: {
      schemaVersion: 1, generatedAt: null, hasSnapshot: false,
      stats: { totalBytes: null }, getProjects: () => [],
      getById: () => null, getAllowKeySet: () => new Set(),
    },
    scanController: { status: () => ({ phase: 'idle', scanId: null }) },
    logger: new Logger({ quiet: true }),
  };
}

const TRUSTED_EVENT = { senderFrame: { url: 'app://index.html' } };
const EVIL_EVENT = { senderFrame: { url: 'https://evil.example' } };

test('register — 전 채널 등록', () => {
  const ipcMain = fakeIpcMain();
  registerIpcHandlers({ ipcMain, dialog: {}, ctx: fakeCtx(), logger: new Logger({ quiet: true }), getWebContents: () => null, getWin: () => null });
  const expected = [
    'spip:getProjects', 'spip:getStats', 'spip:getHealth', 'spip:getConfig',
    'spip:getScanStatus', 'spip:openInVsCode', 'spip:rescan',
    'spip:addRoots', 'spip:removeRoot', 'spip:pickFolders',
  ];
  for (const ch of expected) assert.ok(typeof ipcMain.handlers[ch] === 'function', '미등록: ' + ch);
});

test('register — 신뢰 발신자: getProjects 정상 반환', async () => {
  const ipcMain = fakeIpcMain();
  registerIpcHandlers({ ipcMain, dialog: {}, ctx: fakeCtx(), logger: new Logger({ quiet: true }), getWebContents: () => null, getWin: () => null });
  const r = await ipcMain.invoke('spip:getProjects', TRUSTED_EVENT);
  assert.strictEqual(r.hasSnapshot, false);
  assert.ok(Array.isArray(r.projects));
});

test('register — 비신뢰 발신자: FORBIDDEN', async () => {
  const ipcMain = fakeIpcMain();
  registerIpcHandlers({ ipcMain, dialog: {}, ctx: fakeCtx(), logger: new Logger({ quiet: true }), getWebContents: () => null, getWin: () => null });
  const r = await ipcMain.invoke('spip:getProjects', EVIL_EVENT);
  assert.deepStrictEqual(r, { ok: false, code: 'FORBIDDEN' });
});

test('register — 핸들러 예외 시 INTERNAL로 래핑', async () => {
  const ipcMain = fakeIpcMain();
  const ctx = fakeCtx();
  ctx.store.getProjects = () => { throw new Error('boom /secret/path'); };
  registerIpcHandlers({ ipcMain, dialog: {}, ctx, logger: new Logger({ quiet: true }), getWebContents: () => null, getWin: () => null });
  const r = await ipcMain.invoke('spip:getProjects', TRUSTED_EVENT);
  assert.deepStrictEqual(r, { ok: false, code: 'INTERNAL' }); // 절대경로·스택 비노출(L-3)
});

test('register — rescan에 sendProgress 주입(webContents.send로 push)', async () => {
  const ipcMain = fakeIpcMain();
  const ctx = fakeCtx();
  ctx.config.scanRoots = ['/a'];
  let started = null;
  ctx.scanController = {
    status: () => ({ phase: 'idle', scanId: null }),
    acquire: () => ({ scanId: 's1', startedAt: 'T' }),
    start: (opts) => { started = opts; },
  };
  let sent = null;
  const wc = { isDestroyed: () => false, send: (ch, p) => { sent = { ch, p }; } };
  registerIpcHandlers({ ipcMain, dialog: {}, ctx, logger: new Logger({ quiet: true }), getWebContents: () => wc, getWin: () => null });
  const r = await ipcMain.invoke('spip:rescan', TRUSTED_EVENT, { withSize: false });
  assert.strictEqual(r.code, 'SCAN_STARTED');
  assert.strictEqual(typeof started.onProgress, 'function');
  started.onProgress({ phase: 'scanning' });
  assert.strictEqual(sent.ch, 'spip:scanProgress');
});
