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
const briefingIpc = require('../../electron/ipc/briefing');
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

// ── [항목3] 연결된 LLM 모델 토큰 사용량 누적 ──

test('[항목3] defaultState/normalizeState에 aiUsage 기본값', () => {
  const d = uiStateStore.defaultState();
  assert.deepStrictEqual(d.aiUsage, { calls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, lastModel: '', lastAt: null });
  // 음수·비유한·비문자열은 정규화로 흡수.
  const n = uiStateStore.normalizeAiUsage({ calls: -3, promptTokens: 1.9, totalTokens: NaN, lastModel: 42 });
  assert.strictEqual(n.calls, 0);
  assert.strictEqual(n.promptTokens, 1);
  assert.strictEqual(n.totalTokens, 0);
  assert.strictEqual(n.lastModel, '');
});

test('[항목3] aiUsage write→read 라운드트립 보존(C-M-1 게이트)', () => {
  const p = tmpPath();
  const ctx = { logger: quiet(), uiStatePath: p };
  uiStateStore.write({ aiUsage: { calls: 2, promptTokens: 100, completionTokens: 40, totalTokens: 140, lastModel: 'm1', lastAt: 123 } }, ctx);
  const back = uiStateStore.read(ctx);
  assert.strictEqual(back.aiUsage.calls, 2);
  assert.strictEqual(back.aiUsage.totalTokens, 140);
  assert.strictEqual(back.aiUsage.lastModel, 'm1');
});

test('[항목3] getUiState 응답에 aiUsage 포함', () => {
  const p = tmpPath();
  uiStateStore.write({ aiUsage: { calls: 1, totalTokens: 50 } }, { logger: quiet(), uiStatePath: p });
  const res = uiStateIpc.getUiState({ logger: quiet(), uiStatePath: p });
  assert.ok(res.aiUsage, 'aiUsage 필드 존재');
  assert.strictEqual(res.aiUsage.totalTokens, 50);
});

test('[항목3] makeCarryOverStore.saveItems — usageDelta 누적(calls++ 합산)', () => {
  const p = tmpPath();
  const store = briefingIpc.makeCarryOverStore({ logger: quiet(), uiStatePath: p });
  store.saveItems({ items: [], usageDelta: { model: 'm1', promptTokens: 10, completionTokens: 4, totalTokens: 14 } });
  store.saveItems({ items: [], usageDelta: { model: 'm2', promptTokens: 6, completionTokens: 2, totalTokens: 8 } });
  const back = uiStateStore.read({ logger: quiet(), uiStatePath: p });
  assert.strictEqual(back.aiUsage.calls, 2);
  assert.strictEqual(back.aiUsage.promptTokens, 16);
  assert.strictEqual(back.aiUsage.totalTokens, 22);
  assert.strictEqual(back.aiUsage.lastModel, 'm2', '최근 모델 표시');
  // usageDelta 없이 저장하면 누적 변화 없음.
  store.saveItems({ items: [] });
  const back2 = uiStateStore.read({ logger: quiet(), uiStatePath: p });
  assert.strictEqual(back2.aiUsage.calls, 2, 'usageDelta 없으면 calls 불변');
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
