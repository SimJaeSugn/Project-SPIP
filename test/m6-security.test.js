'use strict';
/**
 * m6-security.test.js — M6 6개 보안 게이트 + 신규 채널 register 정합 (헤드리스 F-3)
 *
 * 코드리뷰가 실측할 6개 항목을 테스트로 고정한다:
 *   ① resolveTool 매 open force 재검증     → toolRegistry.test.js + 본 파일 actions 경유
 *   ② setToolPath 성공 시 캐시 무효화 실호출 → ipc-tools.test.js (clearBinCache) + 본 파일 register
 *   ③ normalizeTools args drop              → toolRegistry.test.js
 *   ④ ui-state 1MB 가드                     → uiStateStore.test.js
 *   ⑤ second-instance argv 미파싱           → 본 파일 main.js 정적 분석
 *   ⑥ doFinalQuit 멱등                      → 본 파일 main.js 정적 분석
 * + register.js가 신규 8채널을 guard로 등록하는지 fake ipcMain으로 검증.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { registerIpcHandlers } = require('../electron/ipc/register');
const actions = require('../electron/ipc/actions');
const { Logger } = require('../lib/common/logger');

const ROOT = path.join(__dirname, '..');
const MAIN_SRC = fs.readFileSync(path.join(ROOT, 'electron', 'main.js'), 'utf8');
const PRELOAD_SRC = fs.readFileSync(path.join(ROOT, 'electron', 'preload.js'), 'utf8');

function fakeIpcMain() {
  const handlers = {};
  return { handlers, handle: (ch, fn) => { handlers[ch] = fn; }, invoke: (ch, ev, ...a) => handlers[ch](ev, ...a) };
}
function fakeCtx() {
  return {
    config: { scanRoots: [], size: {}, tools: {} },
    store: { getProjects: () => [], getById: () => null, getAllowKeySet: () => new Set(), hasSnapshot: false, stats: {} },
    scanController: { status: () => ({ phase: 'idle', scanId: null }) },
    logger: new Logger({ quiet: true }),
  };
}
const TRUSTED = { senderFrame: { url: 'app://index.html' } };

// ── register: 신규 8채널 등록 ──
test('register — M6 신규 8채널 guard 등록', () => {
  const ipcMain = fakeIpcMain();
  registerIpcHandlers({ ipcMain, dialog: {}, clipboard: {}, ctx: fakeCtx(), logger: new Logger({ quiet: true }), getWebContents: () => null, getWin: () => null });
  const expected = ['spip:copyText', 'spip:getTools', 'spip:setToolPath', 'spip:pickToolExecutable',
    'spip:getUiState', 'spip:setFavorite', 'spip:setOrder', 'spip:setSortMode'];
  for (const ch of expected) assert.ok(typeof ipcMain.handlers[ch] === 'function', '미등록: ' + ch);
});

test('register — 신규 채널도 공통 게이트(비신뢰 발신자 FORBIDDEN)', async () => {
  const ipcMain = fakeIpcMain();
  registerIpcHandlers({ ipcMain, dialog: {}, clipboard: { writeText() {} }, ctx: fakeCtx(), logger: new Logger({ quiet: true }), getWebContents: () => null, getWin: () => null });
  const evil = { senderFrame: { url: 'https://evil.example' } };
  const r = await ipcMain.invoke('spip:copyText', evil, { text: 'x' });
  assert.deepStrictEqual(r, { ok: false, code: 'FORBIDDEN' });
});

test('register — copyText guard로 clipboard 주입 동작', async () => {
  const ipcMain = fakeIpcMain();
  const calls = [];
  registerIpcHandlers({ ipcMain, dialog: {}, clipboard: { writeText: (t) => calls.push(t) }, ctx: fakeCtx(), logger: new Logger({ quiet: true }), getWebContents: () => null, getWin: () => null });
  const r = await ipcMain.invoke('spip:copyText', TRUSTED, { text: 'hello' });
  assert.deepStrictEqual(r, { ok: true });
  assert.deepStrictEqual(calls, ['hello']);
});

// ── ① open이 resolveTool를 통해 force 재검증(actions 경유) ──
test('① open — toolId 미지정 시 code 폴백·resolveBin force:true 호출 (M6-H-1)', async () => {
  const calls = [];
  const r = await actions.openInVsCode({ id: 'p1' }, {
    store: { getById: () => ({ id: 'p1', path: '/x' }), getAllowKeySet: () => new Set() },
    config: { tools: {} },
    pathGuard: { canonicalize: () => '/x/real', isAllowed: () => true },
    resolveBin: (name, opts) => { calls.push({ name, opts }); return name === 'code' ? '/usr/bin/code' : null; },
    safeExec: () => Promise.resolve({ spawned: true }),
  });
  assert.deepStrictEqual(r, { ok: true, code: 'OPENING' });
  assert.ok(calls.every((c) => c.opts && c.opts.force === true), '모든 resolveBin 호출이 force:true');
});

test('① open — 미등록 toolId → TOOL_NOT_FOUND (M6-M-1)', async () => {
  const r = await actions.openInVsCode({ id: 'p1', toolId: 'cursor' }, {
    store: { getById: () => ({ id: 'p1', path: '/x' }), getAllowKeySet: () => new Set() },
    config: { tools: {} },
    pathGuard: { canonicalize: () => '/x/real', isAllowed: () => true },
    resolveBin: () => '/x',
    safeExec: () => Promise.resolve({ spawned: true }),
  });
  assert.deepStrictEqual(r, { ok: false, code: 'TOOL_NOT_FOUND' });
});

test('① open — 사용자 config 경로 우선(source config)·인자 [real] 고정 (M6-H-2)', async () => {
  let execArgs = null;
  const abs = '/abs/Code.exe';
  await actions.openInVsCode({ id: 'p1' }, {
    store: { getById: () => ({ id: 'p1', path: '/x' }), getAllowKeySet: () => new Set() },
    config: { tools: { code: { path: abs, label: 'VS Code' } } },
    pathGuard: { canonicalize: () => '/x/real', isAllowed: () => true },
    resolveBin: (name) => (name === abs ? abs : null),
    safeExec: (bin, args) => { execArgs = { bin, args }; return Promise.resolve({ spawned: true }); },
  });
  assert.strictEqual(execArgs.bin, abs);
  assert.deepStrictEqual(execArgs.args, ['/x/real'], '실행 인자 [real] 고정(사용자 args 없음)');
});

// ── ⑤ second-instance argv 미파싱 ──
test('⑤ main.js — second-instance가 argv/cwd를 파싱·사용하지 않음', () => {
  const m = MAIN_SRC.match(/second-instance['"]\s*,\s*\(([^)]*)\)\s*=>\s*\{([\s\S]*?)\n\s{2}\}\)/);
  assert.ok(m, 'second-instance 핸들러를 찾지 못함');
  const params = m[1];
  const body = m[2];
  // 파라미터는 비신뢰 표시(_argv,_cwd) — body에서 argv/cwd를 참조하지 않아야 한다.
  assert.ok(!/\bargv\b|\bcwd\b/.test(body.replace(/_argv|_cwd/g, '')), 'argv/cwd 파싱·사용 흔적 없음');
  // win.show/focus 트리거만 사용.
  assert.ok(/win\.show\(\)/.test(body) && /win\.focus\(\)/.test(body), 'win.show/focus 트리거');
});

// ── ⑥ doFinalQuit 멱등 ──
test('⑥ main.js — doFinalQuit 단일 종료 경로 + disposeResources 멱등 가드', () => {
  assert.ok(/function doFinalQuit\s*\(\)/.test(MAIN_SRC), 'doFinalQuit 정의 존재');
  // disposeResources에 _disposed 멱등 가드.
  assert.ok(/_disposed/.test(MAIN_SRC), '_disposed 멱등 가드 존재');
  assert.ok(/if\s*\(\s*_disposed\s*\)\s*return/.test(MAIN_SRC), 'disposeResources 멱등 early-return');
  // window-all-closed는 quit 안 함(no-op).
  assert.ok(/window-all-closed['"]\s*,\s*\(\)\s*=>\s*\{[^}]*no-op/.test(MAIN_SRC), 'window-all-closed no-op(트레이 상주)');
  // before-quit은 dispose 직접 호출 안 하고 isQuitting 가드만.
  assert.ok(/before-quit['"]\s*,\s*\(\)\s*=>\s*\{\s*isQuitting\s*=\s*true/.test(MAIN_SRC), 'before-quit isQuitting 가드만');
  // close 핸들러: !isQuitting이면 preventDefault+hide(close-to-tray).
  assert.ok(/!isQuitting/.test(MAIN_SRC) && /win\.hide\(\)/.test(MAIN_SRC), 'close-to-tray hide');
});

// ── preload 신규 채널 노출 ──
test('preload — M6 신규 함수 노출(copyText/getTools/setToolPath/pickToolExecutable/getUiState/setFavorite/setOrder/setSortMode/onTray)', () => {
  for (const fn of ['copyText', 'getTools', 'setToolPath', 'pickToolExecutable', 'getUiState', 'setFavorite', 'setOrder', 'setSortMode', 'onTray']) {
    assert.ok(new RegExp('\\b' + fn + '\\s*:').test(PRELOAD_SRC), 'preload 미노출: ' + fn);
  }
  // generic invoke 비노출 유지(채널명 하드코딩).
  assert.ok(!/invoke\s*:\s*\(/.test(PRELOAD_SRC), 'generic invoke 비노출');
  // onTray는 spip:tray: 채널·removeListener(unsubscribe) 사용.
  assert.ok(/spip:tray:/.test(PRELOAD_SRC), 'onTray spip:tray: 채널');
});
