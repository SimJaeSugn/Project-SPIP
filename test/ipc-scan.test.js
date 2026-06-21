'use strict';
/**
 * ipc-scan.test.js — electron/ipc/scan.js (헤드리스 검증, F-3)
 * getScanStatus·makeProgressSender(webContents 모킹).
 */
const { test } = require('node:test');
const assert = require('node:assert');

const scanIpc = require('../electron/ipc/scan');

test('getScanStatus — 컨트롤러 status() 위임', () => {
  const status = { phase: 'scanning', scanId: 'x', dirs: 5, found: 2, currentPath: 'a/b' };
  const r = scanIpc.getScanStatus({ scanController: { status: () => status } });
  assert.deepStrictEqual(r, status);
});

test('getScanStatus — 컨트롤러 미주입 → idle 안전 응답', () => {
  const r = scanIpc.getScanStatus({});
  assert.strictEqual(r.phase, 'idle');
  assert.strictEqual(r.scanId, null);
  assert.strictEqual(r.currentPath, null);
});

test('makeProgressSender — webContents.send 호출', () => {
  let sent = null;
  const wc = { isDestroyed: () => false, send: (ch, payload) => { sent = { ch, payload }; } };
  const send = scanIpc.makeProgressSender(() => wc);
  send({ phase: 'scanning', dirs: 3 });
  assert.strictEqual(sent.ch, 'spip:scanProgress');
  assert.deepStrictEqual(sent.payload, { phase: 'scanning', dirs: 3 });
});

test('makeProgressSender — 파괴된 webContents면 무시(예외 없음)', () => {
  const wc = { isDestroyed: () => true, send: () => { throw new Error('should not send'); } };
  const send = scanIpc.makeProgressSender(() => wc);
  assert.doesNotThrow(() => send({ phase: 'done' }));
});

test('makeProgressSender — null webContents면 무시', () => {
  const send = scanIpc.makeProgressSender(() => null);
  assert.doesNotThrow(() => send({ phase: 'done' }));
});
