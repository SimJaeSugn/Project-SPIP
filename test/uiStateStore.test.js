'use strict';
/**
 * uiStateStore.test.js — lib/common/uiStateStore.js (M6 R-19/R-20/M6-M-4, 헤드리스 F-3)
 * 1MB DoS 가드·_safeParse·normalizeState·graceful 폴백·0600 원자적 쓰기.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const store = require('../lib/common/uiStateStore');

function tmpFile() {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'spip-ui-')));
  return path.join(dir, 'ui-state', 'ui-state.json');
}

// ── normalizeState (순수 검증) ──
test('normalizeState — id 형식·중복 제거·sortMode 화이트리스트', () => {
  const r = store.normalizeState({
    favorites: ['abc123', 'abc123', 'ZZZ', 'deadbeef', 1],
    order: ['deadbeef', 'abc123', 'nothex!'],
    sortMode: 'weird',
  });
  assert.deepStrictEqual(r.favorites, ['abc123', 'deadbeef']); // 중복·형식불일치 제거
  assert.deepStrictEqual(r.order, ['deadbeef', 'abc123']);
  assert.strictEqual(r.sortMode, 'auto'); // 화이트리스트 외 → auto
  assert.strictEqual(r.schemaVersion, store.SCHEMA_VERSION);
});

test('normalizeState — 비객체 → 기본 빈 상태', () => {
  assert.deepStrictEqual(store.normalizeState(null), store.defaultState());
  assert.deepStrictEqual(store.normalizeState([1]), store.defaultState());
});

test('normalizeIdArray — 개수 상한 강제', () => {
  const many = Array.from({ length: 1000 }, (_, i) => i.toString(16).padStart(8, '0'));
  const r = store.normalizeIdArray(many, 512);
  assert.strictEqual(r.length, 512);
});

// ── _safeParse (M6-M-4 ③ 깊이 가드) ──
test('_safeParse — 잘못된 JSON → null', () => {
  assert.strictEqual(store._safeParse('{not json'), null);
});

test('_safeParse — 과도 깊이 → null (JSON 폭탄)', () => {
  let deep = '1';
  for (let i = 0; i < 100; i++) deep = '[' + deep + ']';
  assert.strictEqual(store._safeParse(deep), null);
});

test('_safeParse — 정상 JSON 통과', () => {
  assert.deepStrictEqual(store._safeParse('{"a":1}'), { a: 1 });
});

// ── read graceful 폴백 ──
test('read — 부재 파일 → 빈 상태(graceful)', () => {
  const file = tmpFile();
  assert.deepStrictEqual(store.read({ uiStatePath: file }), store.defaultState());
});

test('read — 손상 JSON → 빈 상태', () => {
  const file = tmpFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{broken');
  assert.deepStrictEqual(store.read({ uiStatePath: file }), store.defaultState());
});

test('read — 1MB 초과 파일 → 빈 상태 (M6-M-4 ①)', () => {
  const file = tmpFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // 1MB + 1바이트의 유효해 보이는(그러나 거대) 내용.
  const big = '{"favorites":[' + '"deadbeef",'.repeat(120000) + '"deadbeef"]}';
  assert.ok(Buffer.byteLength(big) > store.MAX_UISTATE_BYTES, '테스트 데이터가 1MB 초과여야 함');
  fs.writeFileSync(file, big);
  assert.deepStrictEqual(store.read({ uiStatePath: file }), store.defaultState());
});

// ── write 0600 + roundtrip ──
test('write/read — roundtrip + 0600 권한', () => {
  const file = tmpFile();
  const written = store.write({ favorites: ['aa11', 'bb22'], order: ['bb22', 'aa11'], sortMode: 'manual' }, { uiStatePath: file });
  assert.deepStrictEqual(written.favorites, ['aa11', 'bb22']);
  assert.strictEqual(written.sortMode, 'manual');
  const back = store.read({ uiStatePath: file });
  assert.deepStrictEqual(back.favorites, ['aa11', 'bb22']);
  assert.deepStrictEqual(back.order, ['bb22', 'aa11']);
  assert.strictEqual(back.sortMode, 'manual');
  if (process.platform !== 'win32') {
    const mode = fs.statSync(file).mode & 0o777;
    assert.strictEqual(mode, 0o600);
  }
});

test('write — 정규화 적용(잘못된 id/sortMode 제거)', () => {
  const file = tmpFile();
  const written = store.write({ favorites: ['abc123', 'BAD!'], sortMode: 'nope' }, { uiStatePath: file });
  assert.deepStrictEqual(written.favorites, ['abc123']); // 'BAD!'·비hex 제거
  assert.strictEqual(written.sortMode, 'auto');
});
