'use strict';
/**
 * ipc-clipboard.test.js — electron/ipc/clipboard.js (M6 R-17, 헤드리스 F-3)
 * copyText: string·길이 검증·INVALID_TEXT 명시 거부·writeText만.
 */
const { test } = require('node:test');
const assert = require('node:assert');

const clip = require('../electron/ipc/clipboard');

function fakeClipboard() {
  const calls = [];
  return { calls, writeText: (t) => calls.push(t) };
}

test('copyText — 정상 텍스트 → clipboard.writeText, ok', () => {
  const cb = fakeClipboard();
  const r = clip.copyText({ text: 'E:\\proj\\path' }, { clipboard: cb });
  assert.deepStrictEqual(r, { ok: true });
  assert.deepStrictEqual(cb.calls, ['E:\\proj\\path']);
});

test('copyText — 비문자열 → INVALID_TEXT(writeText 미호출)', () => {
  const cb = fakeClipboard();
  assert.deepStrictEqual(clip.copyText({ text: 123 }, { clipboard: cb }), { ok: false, code: 'INVALID_TEXT' });
  assert.deepStrictEqual(clip.copyText({}, { clipboard: cb }), { ok: false, code: 'INVALID_TEXT' });
  assert.strictEqual(cb.calls.length, 0);
});

test('copyText — 길이 초과 → INVALID_TEXT (절단 안 함, L-1)', () => {
  const cb = fakeClipboard();
  const big = 'x'.repeat(clip.MAX_TEXT_LEN + 1);
  assert.deepStrictEqual(clip.copyText({ text: big }, { clipboard: cb }), { ok: false, code: 'INVALID_TEXT' });
  assert.strictEqual(cb.calls.length, 0, '절단 후 기록 금지');
});

test('copyText — 경계값(상한 정확히) 허용', () => {
  const cb = fakeClipboard();
  const exact = 'x'.repeat(clip.MAX_TEXT_LEN);
  assert.deepStrictEqual(clip.copyText({ text: exact }, { clipboard: cb }), { ok: true });
});

test('copyText — clipboard 미주입 → INTERNAL', () => {
  assert.deepStrictEqual(clip.copyText({ text: 'a' }, {}), { ok: false, code: 'INTERNAL' });
});
