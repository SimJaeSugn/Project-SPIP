'use strict';
/**
 * test/ai/ipc-briefing.test.js — IPC 핸들러 shape 검증·키 비노출 (N-08·P1-1·M-2)
 * 핸들러 본체가 shape를 검증(register guard는 senderFrame만).
 */
const { test } = require('node:test');
const assert = require('node:assert');
const briefing = require('../../electron/ipc/briefing');

function baseCtx(over) {
  return Object.assign({
    config: { briefing: { enabled: true, baseURL: 'http://127.0.0.1:1234/v1', model: 'm', apiKey: 'sk-secret', advanced: { coalesceMs: 2000, deadlineH: 24 } } },
    briefingOrchestrator: {
      getState: () => ({ enabled: true, status: 'idle', items: [], lastError: null }),
      triggerManual: () => ({ ok: true }),
      abort: () => ({ ok: true }),
      resolveItem: () => [],
      testConnection: async () => ({ ok: true, model: 'm', latencyMs: 10, code: 'OK' }),
    },
  }, over);
}

test('M-2 — getSettings 키 평문 미포함(hasApiKey만)', () => {
  const r = briefing.getSettings(null, baseCtx());
  assert.strictEqual(r.hasApiKey, true);
  assert.strictEqual(r.apiKey, undefined, 'apiKey 평문 미포함');
  assert.ok(!JSON.stringify(r).includes('sk-secret'));
});

test('M-1 — getSettings external 플래그(localhost=false)', () => {
  const r = briefing.getSettings(null, baseCtx());
  assert.strictEqual(r.external, false);
  const ext = briefing.getSettings(null, baseCtx({ config: { briefing: { baseURL: 'http://10.0.0.1/v1', model: 'm', apiKey: '' } } }));
  assert.strictEqual(ext.external, true);
});

test('P1-1 — trigger reason enum: manual만, 그 외 BAD_ARGS', () => {
  assert.strictEqual(briefing.trigger({ reason: 'manual' }, baseCtx()).ok, true);
  assert.strictEqual(briefing.trigger({ reason: 'evil' }, baseCtx()).code, 'BAD_ARGS');
  assert.strictEqual(briefing.trigger({}, baseCtx()).ok, true); // 미지정 허용
});

test('P1-1 — resolveItem key 형식·action enum 검증', () => {
  const good = 'a'.repeat(32);
  assert.strictEqual(briefing.resolveItem({ key: good, action: 'done' }, baseCtx()).ok, true);
  assert.strictEqual(briefing.resolveItem({ key: good, action: 'dismiss' }, baseCtx()).ok, true);
  assert.strictEqual(briefing.resolveItem({ key: 'ZZ!', action: 'done' }, baseCtx()).code, 'BAD_ARGS');
  assert.strictEqual(briefing.resolveItem({ key: good, action: 'delete' }, baseCtx()).code, 'BAD_ARGS');
  assert.strictEqual(briefing.resolveItem({}, baseCtx()).code, 'BAD_ARGS');
});

test('P1-1/M-1 — validateSettingsArgs: 필드 타입·URL 검증·apiKey 패턴', () => {
  // enabled 비불리언 거부
  assert.strictEqual(briefing.validateSettingsArgs({ enabled: 'yes' }).code, 'BAD_ARGS');
  // baseURL M-1 위배(자격증명) 거부
  assert.strictEqual(briefing.validateSettingsArgs({ baseURL: 'http://u:p@h/v1' }).code, 'BAD_URL');
  // file scheme 거부
  assert.strictEqual(briefing.validateSettingsArgs({ baseURL: 'file:///x' }).code, 'BAD_URL');
  // apiKey null=해제(빈 문자열)
  assert.strictEqual(briefing.validateSettingsArgs({ apiKey: null }).patch.apiKey, '');
  // apiKey 미전송=patch 없음(기존 유지)
  assert.strictEqual('apiKey' in briefing.validateSettingsArgs({ model: 'x' }).patch, false);
  // 유효
  const ok = briefing.validateSettingsArgs({ enabled: true, baseURL: 'http://localhost/v1', model: 'm', apiKey: 'k' });
  assert.strictEqual(ok.ok, true);
  assert.strictEqual(ok.patch.baseURL, 'http://localhost/v1');
});

test('setSettings — apiKey 미전송 시 기존 키 유지', () => {
  const ctx = baseCtx();
  // persist는 elevationState로 인해 실제 디스크 건드리지 않게 configDeps로 모킹.
  ctx.configDeps = { fs: fakeFs(), paths: { configPath: () => '/x', ensureDirFor: () => '/x' }, elevationState: { isElevated: () => true } };
  const r = briefing.setSettings({ model: 'new-model' }, ctx);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(ctx.config.briefing.model, 'new-model');
  assert.strictEqual(ctx.config.briefing.apiKey, 'sk-secret', 'apiKey 유지');
  assert.strictEqual(r.hasApiKey, true);
  assert.strictEqual(r.apiKey, undefined);
});

test('setSettings — 불량 baseURL 거부(BAD_URL)', () => {
  const r = briefing.setSettings({ baseURL: 'ftp://x/y' }, baseCtx());
  assert.strictEqual(r.code, 'BAD_URL');
});

test('R-39 — testConnection 위임(임시값 영속 안 함)', async () => {
  const ctx = baseCtx();
  const r = await briefing.testConnection({ baseURL: 'http://localhost:9999/v1' }, ctx);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.model, 'm');
});

test('R-39 — testConnection 불량 인자 거부', async () => {
  assert.strictEqual((await briefing.testConnection({ baseURL: 'file:///x' }, baseCtx())).code, 'BAD_URL');
});

function fakeFs() {
  return {
    readFileSync: () => { throw new Error('ENOENT'); },
    openSync: () => 1, writeFileSync: () => {}, fsyncSync: () => {}, closeSync: () => {},
    chmodSync: () => {}, renameSync: () => {}, existsSync: () => false, unlinkSync: () => {},
  };
}
