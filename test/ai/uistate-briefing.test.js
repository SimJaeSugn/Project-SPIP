'use strict';
/**
 * test/ai/uistate-briefing.test.js — briefing 3곳/2파일 라운드트립·상승 세션 write no-op (R-38·m12·P1-2)
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const uiStateStore = require('../../lib/common/uiStateStore');
const uiStateIpc = require('../../electron/ipc/uiState');
const { Logger } = require('../../lib/common/logger');
const elevationState = require('../../lib/common/elevationState');

function quiet() { return new Logger({ quiet: true }); }
function tmpPath() {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'spip-uib-')));
  return path.join(dir, 'ui-state.json');
}

function briefingItem(over) {
  return Object.assign({
    key: 'a'.repeat(32), signalType: 'dirty', targetId: 'p1', category: 'must',
    title: 'T', reason: 'R', guide: 'G', ref: '', status: 'open', createdAt: 1000, resolvedAt: null,
  }, over);
}

test('C-M-1 ① — defaultState에 briefing 기본값', () => {
  const d = uiStateStore.defaultState();
  assert.ok(d.briefing);
  assert.deepStrictEqual(d.briefing.items, []);
  assert.deepStrictEqual(d.briefing.counters, { generated: 0, done: 0, dismiss: 0 });
});

test('C-M-1 ② — normalizeState가 briefing 정규화', () => {
  const s = uiStateStore.normalizeState({ briefing: { items: [briefingItem()] } });
  assert.strictEqual(s.briefing.items.length, 1);
  assert.strictEqual(s.briefing.items[0].title, 'T');
});

test('C-M-1 — write→read 라운드트립(briefing 보존)', () => {
  const p = tmpPath();
  const ctx = { logger: quiet(), uiStatePath: p };
  uiStateStore.write({ briefing: { items: [briefingItem()], counters: { generated: 5, done: 1, dismiss: 0 } } }, ctx);
  const back = uiStateStore.read(ctx);
  assert.strictEqual(back.briefing.items.length, 1);
  assert.strictEqual(back.briefing.items[0].key, 'a'.repeat(32));
  assert.strictEqual(back.briefing.counters.generated, 5);
});

test('C-M-1 ③ — getUiState 응답에 briefing 포함(open 항목만, 별도 파일)', () => {
  const p = tmpPath();
  const open = briefingItem({ status: 'open' });
  const done = briefingItem({ key: 'b'.repeat(32), status: 'done' });
  uiStateStore.write({ briefing: { items: [open, done] } }, { logger: quiet(), uiStatePath: p });
  const res = uiStateIpc.getUiState({ logger: quiet(), uiStatePath: p });
  assert.strictEqual(res.ok, true);
  assert.ok(res.briefing, 'briefing 필드 존재');
  assert.strictEqual(res.briefing.items.length, 1, 'open만 노출');
  assert.strictEqual(res.briefing.items[0].status, 'open');
});

test('C-M-1 — 구버전 파일(briefing 키 부재) graceful 기본값(무손실)', () => {
  const p = tmpPath();
  fs.writeFileSync(p, JSON.stringify({ schemaVersion: 1, favorites: [], todos: [] }));
  const back = uiStateStore.read({ logger: quiet(), uiStatePath: p });
  assert.ok(back.briefing);
  assert.deepStrictEqual(back.briefing.items, []);
});

test('R-38 — 항목 키 형식·status/category 화이트리스트·개수 상한', () => {
  const b = uiStateStore.normalizeBriefing({ items: [
    { key: 'ZZZ', signalType: 'dirty' },            // 잘못된 키 → 폐기
    briefingItem({ status: 'weird', category: 'x' }), // status/category 폴백
  ] });
  assert.strictEqual(b.items.length, 1);
  assert.strictEqual(b.items[0].status, 'open');
  assert.strictEqual(b.items[0].category, 'good');
});

test('m12 — 상승 세션이면 write no-op(메모리 유지)', () => {
  const p = tmpPath();
  elevationState.setElevated(true);
  try {
    const r = uiStateStore.write({ briefing: { items: [briefingItem()] } }, { logger: quiet(), uiStatePath: p });
    assert.strictEqual(r.briefing.items.length, 1, '메모리 정규화 결과 반환');
    assert.strictEqual(fs.existsSync(p), false, '디스크 write 보류');
  } finally {
    elevationState.reset();
  }
});
