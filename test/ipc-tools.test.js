'use strict';
/**
 * ipc-tools.test.js — electron/ipc/tools.js (M6 R-18, 헤드리스 F-3)
 * getTools·setToolPath·pickToolExecutable. 보안항목 ②(캐시 무효화 실호출) 검증 포함.
 */
const { test } = require('node:test');
const assert = require('node:assert');

const tools = require('../electron/ipc/tools');

// 의존성 모킹 헬퍼: resolveBin/clearBinCache/persistConfigKeys 주입 ctx를 만든다.
function mkCtx(over) {
  const calls = { resolveBin: [], clearBinCache: 0, persisted: [] };
  const ctx = {
    config: { tools: {} },
    resolveBin: (name, opts) => { calls.resolveBin.push({ name, opts }); return (over && over.resolveBinImpl) ? over.resolveBinImpl(name, opts) : name; },
    clearBinCache: () => { calls.clearBinCache++; },
    persistConfigKeys: (patch) => { calls.persisted.push(patch); },
  };
  return { ctx: Object.assign(ctx, over && over.ctx), calls };
}

// ── getTools ──
test('getTools — known id 해석상태(args 없음)', () => {
  const { ctx } = mkCtx({ resolveBinImpl: () => null }); // 미해석
  const r = tools.getTools(ctx);
  assert.strictEqual(r.ok, true);
  assert.ok(Array.isArray(r.tools));
  const code = r.tools.find((t) => t.id === 'code');
  assert.ok(code);
  assert.deepStrictEqual(Object.keys(code).sort(), ['id', 'label', 'path', 'resolved', 'source']); // args 없음
  assert.strictEqual(code.resolved, false);
  assert.strictEqual(code.source, 'none');
});

test('getTools — 사용자 경로 해석 시 resolved=true,source=config', () => {
  const { ctx } = mkCtx();
  ctx.config.tools = { code: { path: '/abs/Code.exe', label: 'VS Code' } };
  const r = tools.getTools(ctx);
  const code = r.tools.find((t) => t.id === 'code');
  assert.strictEqual(code.resolved, true);
  assert.strictEqual(code.source, 'config');
  assert.strictEqual(code.path, '/abs/Code.exe');
  assert.strictEqual(code.label, 'VS Code');
});

// ── setToolPath ──
test('setToolPath — 미등록 toolId → INVALID_TOOL_ID (M6-M-1)', () => {
  const { ctx, calls } = mkCtx();
  assert.deepStrictEqual(tools.setToolPath({ id: 'cursor', path: '/abs/x.exe' }, ctx), { ok: false, code: 'INVALID_TOOL_ID' });
  assert.strictEqual(calls.persisted.length, 0);
});

test('setToolPath — 상대경로 → NOT_ABSOLUTE', () => {
  const { ctx } = mkCtx();
  const r = tools.setToolPath({ id: 'code', path: 'relative.exe' }, ctx);
  assert.deepStrictEqual(r, { ok: false, code: 'NOT_ABSOLUTE' });
});

test('setToolPath — resolveBin null(미존재/비.exe) → NOT_EXECUTABLE', () => {
  const abs = process.platform === 'win32' ? 'C:\\x\\nope.exe' : '/abs/nope.exe';
  const { ctx } = mkCtx({ resolveBinImpl: () => null });
  const r = tools.setToolPath({ id: 'code', path: abs }, ctx);
  assert.deepStrictEqual(r, { ok: false, code: 'NOT_EXECUTABLE' });
});

test('setToolPath — 성공 시 force 재검증·캐시 무효화·persist (보안항목 ①②⑤)', () => {
  const abs = process.platform === 'win32' ? 'C:\\x\\Code.exe' : '/abs/Code.exe';
  const { ctx, calls } = mkCtx({ resolveBinImpl: (name) => name }); // 절대경로 그대로 해석됨
  const r = tools.setToolPath({ id: 'code', path: abs }, ctx);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.tool.id, 'code');
  assert.strictEqual(r.tool.resolved, true);
  // ① force 재검증: resolveBin이 {force:true}로 호출됨.
  assert.ok(calls.resolveBin.some((c) => c.name === abs && c.opts && c.opts.force === true), 'force 재검증');
  // ② 캐시 무효화 실호출.
  assert.ok(calls.clearBinCache >= 1, '_clearBinCache 호출');
  // ⑤ persistConfigKeys({tools}) 영속.
  assert.strictEqual(calls.persisted.length, 1);
  assert.ok(calls.persisted[0].tools.code, 'tools 맵 persist');
  assert.strictEqual(calls.persisted[0].tools.code.args, undefined, 'args 없음(M6-H-2)');
});

test('setToolPath — path=null 지정 해제 시에도 캐시 무효화·persist', () => {
  const { ctx, calls } = mkCtx();
  ctx.config.tools = { code: { path: '/abs/old.exe', label: 'VS Code' } };
  const r = tools.setToolPath({ id: 'code', path: null }, ctx);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.tool.path, null);
  assert.ok(calls.clearBinCache >= 1);
  assert.strictEqual(calls.persisted.length, 1);
  assert.strictEqual(calls.persisted[0].tools.code.path, null);
});

// ── pickToolExecutable (M6-M-2) ──
test('pickToolExecutable — 미등록 id → INVALID_TOOL_ID', async () => {
  const { ctx } = mkCtx();
  const r = await tools.pickToolExecutable({ id: 'cursor' }, ctx);
  assert.deepStrictEqual(r, { ok: false, code: 'INVALID_TOOL_ID' });
});

test('pickToolExecutable — 취소 → CANCELLED', async () => {
  const { ctx } = mkCtx();
  ctx.dialog = { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) };
  const r = await tools.pickToolExecutable({ id: 'code' }, ctx);
  assert.deepStrictEqual(r, { ok: false, code: 'CANCELLED' });
});

test('pickToolExecutable — dialog 결과도 main 재검증(M6-M-2): 검증 실패 시 NOT_EXECUTABLE', async () => {
  const { ctx } = mkCtx({ resolveBinImpl: () => null }); // dialog가 골랐어도 재검증 실패
  const abs = process.platform === 'win32' ? 'C:\\x\\picked.exe' : '/abs/picked.exe';
  ctx.dialog = { showOpenDialog: async () => ({ canceled: false, filePaths: [abs] }) };
  const r = await tools.pickToolExecutable({ id: 'code' }, ctx);
  assert.deepStrictEqual(r, { ok: false, code: 'NOT_EXECUTABLE' });
});

test('pickToolExecutable — 성공 시 force 재검증·persist', async () => {
  const abs = process.platform === 'win32' ? 'C:\\x\\picked.exe' : '/abs/picked.exe';
  const { ctx, calls } = mkCtx({ resolveBinImpl: (name) => name });
  ctx.dialog = { showOpenDialog: async () => ({ canceled: false, filePaths: [abs] }) };
  const r = await tools.pickToolExecutable({ id: 'code' }, ctx);
  assert.strictEqual(r.ok, true);
  assert.ok(calls.resolveBin.some((c) => c.name === abs && c.opts.force === true));
  assert.ok(calls.clearBinCache >= 1);
  assert.strictEqual(calls.persisted.length, 1);
});
