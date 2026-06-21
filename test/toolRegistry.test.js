'use strict';
/**
 * toolRegistry.test.js — lib/common/toolRegistry.js (M6 R-18, 헤드리스 F-3)
 * normalizeTools(args drop·known id 화이트리스트·label sanitize)·resolveTool(force 재검증·M6-H-1).
 */
const { test } = require('node:test');
const assert = require('node:assert');

const tr = require('../lib/common/toolRegistry');

// ── isKnownToolId (M6-M-1) ──
test('isKnownToolId — code만 known, 임의 id 거부', () => {
  assert.strictEqual(tr.isKnownToolId('code'), true);
  assert.strictEqual(tr.isKnownToolId('cursor'), false); // 미등록
  assert.strictEqual(tr.isKnownToolId('evil; rm -rf'), false);
  assert.strictEqual(tr.isKnownToolId('CODE'), false); // 대문자 형식 불일치
  assert.strictEqual(tr.isKnownToolId(123), false);
  assert.strictEqual(tr.isKnownToolId(null), false);
});

// ── normalizeTools ──
test('normalizeTools — 비객체 입력 → 빈 맵', () => {
  assert.deepStrictEqual(tr.normalizeTools(null), {});
  assert.deepStrictEqual(tr.normalizeTools('x'), {});
  assert.deepStrictEqual(tr.normalizeTools([1, 2]), {});
});

test('normalizeTools — args 키 drop (M6-H-2)', () => {
  const out = tr.normalizeTools({
    code: { path: '/abs/Code.exe', label: 'VS Code', args: ['--evil', '-flag'] },
  }, { isAbsolute: () => true });
  assert.deepStrictEqual(Object.keys(out.code).sort(), ['label', 'path']); // args 없음
  assert.strictEqual(out.code.path, '/abs/Code.exe');
  assert.strictEqual(out.code.label, 'VS Code');
});

test('normalizeTools — 미등록 toolId 거부 (M6-M-1)', () => {
  const out = tr.normalizeTools({
    code: { path: '/abs/c.exe' },
    cursor: { path: '/abs/cur.exe' }, // 화이트리스트 외 → drop
    'bad id!': { path: '/abs/x.exe' }, // 형식 불일치 → drop
  }, { isAbsolute: () => true });
  assert.deepStrictEqual(Object.keys(out), ['code']);
});

test('normalizeTools — 상대경로/과길이 path는 null(폴백)', () => {
  const out = tr.normalizeTools({
    code: { path: 'relative/code.exe', label: 'x' },
  }, { isAbsolute: (p) => p.startsWith('/') });
  assert.strictEqual(out.code.path, null);
});

test('normalizeTools — label 제어/방향문자 제거·≤64', () => {
  const RLO = String.fromCharCode(0x202E); // U+202E RIGHT-TO-LEFT OVERRIDE
  const NUL = String.fromCharCode(0x00);
  const evil = 'VS' + NUL + 'Code' + RLO + 'evil' + 'x'.repeat(100);
  const out = tr.normalizeTools({ code: { path: null, label: evil } }, { isAbsolute: () => true });
  assert.strictEqual(out.code.label.indexOf(RLO), -1, '방향제어문자 제거');
  assert.strictEqual(out.code.label.indexOf(NUL), -1, '제어문자 제거');
  assert.ok(out.code.label.length <= 65, 'clampString 절단(말줄임 포함 ≤65)');
});

test('normalizeTools — label 비문자열이면 toolId 기본값', () => {
  const out = tr.normalizeTools({ code: { path: null, label: 123 } }, { isAbsolute: () => true });
  assert.strictEqual(out.code.label, 'code');
});

// ── resolveTool (M6-H-1 force 재검증) ──
test('resolveTool — 미등록 toolId 즉시 거부(source none)', () => {
  let called = 0;
  const r = tr.resolveTool('cursor', { tools: {} }, { resolveBin: () => { called++; return '/x'; } });
  assert.deepStrictEqual(r, { bin: null, source: 'none' });
  assert.strictEqual(called, 0, 'resolveBin 호출 안 함(화이트리스트 외)');
});

test('resolveTool — 사용자 경로 우선 + force:true로 호출 (M6-H-1)', () => {
  const calls = [];
  const r = tr.resolveTool('code',
    { tools: { code: { path: '/abs/Code.exe' } } },
    { resolveBin: (name, opts) => { calls.push({ name, opts }); return name === '/abs/Code.exe' ? '/abs/Code.exe' : null; } });
  assert.deepStrictEqual(r, { bin: '/abs/Code.exe', source: 'config' });
  assert.strictEqual(calls[0].name, '/abs/Code.exe');
  assert.deepStrictEqual(calls[0].opts, { force: true }, '캐시 우회 강제 재검증');
});

test('resolveTool — 사용자 경로 미해석 시 PATH 폴백(force:true)', () => {
  const calls = [];
  const r = tr.resolveTool('code',
    { tools: { code: { path: '/gone/Code.exe' } } },
    { resolveBin: (name, opts) => { calls.push({ name, opts }); return name === 'code' ? '/usr/bin/code' : null; } });
  assert.deepStrictEqual(r, { bin: '/usr/bin/code', source: 'path' });
  // 마지막 호출이 PATH 폴백이며 force:true.
  assert.strictEqual(calls[calls.length - 1].name, 'code');
  assert.deepStrictEqual(calls[calls.length - 1].opts, { force: true });
});

test('resolveTool — 미해석 전부 → none', () => {
  const r = tr.resolveTool('code', { tools: {} }, { resolveBin: () => null });
  assert.deepStrictEqual(r, { bin: null, source: 'none' });
});

test('resolveTool — resolveBin 미주입 → none(throw 안 함)', () => {
  const r = tr.resolveTool('code', { tools: {} }, {});
  assert.deepStrictEqual(r, { bin: null, source: 'none' });
});
