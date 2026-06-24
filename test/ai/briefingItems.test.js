'use strict';
/**
 * test/ai/briefingItems.test.js — 항목 키·전이·carry-over·auto-resolve 매트릭스 (R-38)
 * 순수·헤드리스. 상태형 8유형·이벤트형·done/dismiss·만료.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const items = require('../../lib/ai/briefingItems');
const C = require('../../lib/ai/briefingConst');

const NOW = 1_700_000_000_000;

test('R-38 — 항목 키 안정성(같은 사안=같은 키)', () => {
  const k1 = items.itemKey('dirty', 'projA');
  const k2 = items.itemKey('dirty', 'projA');
  const k3 = items.itemKey('dirty', 'projB');
  assert.strictEqual(k1, k2);
  assert.notStrictEqual(k1, k3);
  assert.match(k1, items.KEY_RE);
});

test('R-38 — 신호→open 항목 변환(표현 비어있음)', () => {
  const sigs = [{ type: 'dirty', targetId: 'a', category: 'must' }];
  const its = items.itemsFromSignals(sigs, NOW);
  assert.strictEqual(its[0].status, 'open');
  assert.strictEqual(its[0].category, 'must');
  assert.strictEqual(its[0].title, '');
  assert.strictEqual(its[0].createdAt, NOW);
});

test('R-38 — done/dismiss 전이(applyResolution)', () => {
  const its = items.itemsFromSignals([{ type: 'dirty', targetId: 'a' }], NOW);
  const key = its[0].key;
  const d = items.applyResolution(its, key, 'done', NOW);
  assert.strictEqual(d.changed, true);
  assert.strictEqual(d.items[0].status, 'done');
  assert.strictEqual(d.items[0].resolvedAt, NOW);

  const dm = items.applyResolution(its, key, 'dismiss', NOW);
  assert.strictEqual(dm.items[0].status, 'dismissed');
});

test('R-38 — 잘못된 key/action은 변경 없음', () => {
  const its = items.itemsFromSignals([{ type: 'dirty', targetId: 'a' }], NOW);
  assert.strictEqual(items.applyResolution(its, 'ZZZ', 'done', NOW).changed, false);
  assert.strictEqual(items.applyResolution(its, its[0].key, 'evil', NOW).changed, false);
});

test('R-38 — carry-over: open 이전 항목 + 신규, done 제외', () => {
  const prev = items.itemsFromSignals([{ type: 'dirty', targetId: 'a' }, { type: 'ahead', targetId: 'b' }], NOW);
  // b를 done 처리
  const bKey = items.itemKey('ahead', 'b');
  const prevResolved = items.applyResolution(prev, bKey, 'done', NOW).items;
  const newItems = items.itemsFromSignals([{ type: 'mail', targetId: 'm1' }], NOW);
  // 현재 스냅샷: a 여전히 dirty(open 유지), b done
  const snap = { projects: [{ id: 'a', dirty: true }, { id: 'b', ahead: 0 }] };
  const sel = items.selectCarryOver(prevResolved, newItems, snap, { now: NOW });
  const keys = sel.items.map((i) => i.signalType);
  assert.ok(keys.includes('mail'), '신규 mail 포함');
  assert.ok(keys.includes('dirty'), 'open dirty carry-over');
  assert.ok(!keys.includes('ahead'), 'done ahead 제외');
});

// ── auto-resolve 매트릭스(상태형) ──
function openItem(type, targetId) {
  return items.itemsFromSignals([{ type, targetId }], NOW);
}

test('auto-resolve dirty — clean 전환 시 해소', () => {
  const it = openItem('dirty', 'a')[0];
  assert.strictEqual(items.isResolved(it, { projects: [{ id: 'a', dirty: false }] }, {}), true);
  assert.strictEqual(items.isResolved(it, { projects: [{ id: 'a', dirty: true }] }, {}), false);
});

test('auto-resolve ahead — push 완료(0) 시 해소', () => {
  const it = openItem('ahead', 'a')[0];
  assert.strictEqual(items.isResolved(it, { projects: [{ id: 'a', ahead: 0 }] }, {}), true);
  assert.strictEqual(items.isResolved(it, { projects: [{ id: 'a', ahead: 2 }] }, {}), false);
});

test('auto-resolve behind — pull 완료(0) 시 해소', () => {
  const it = openItem('behind', 'a')[0];
  assert.strictEqual(items.isResolved(it, { projects: [{ id: 'a', behind: 0 }] }, {}), true);
  assert.strictEqual(items.isResolved(it, { projects: [{ id: 'a', behind: 1 }] }, {}), false);
});

test('auto-resolve attention — 주의 집합 이탈 시 해소', () => {
  const it = openItem('attention', 'a')[0];
  assert.strictEqual(items.isResolved(it, { projects: [{ id: 'a', attention: false }] }, {}), true);
  assert.strictEqual(items.isResolved(it, { projects: [{ id: 'a', attention: true }] }, {}), false);
});

test('auto-resolve disk — 임계 미만 복귀 시 해소', () => {
  const it = openItem('disk', 'disk')[0];
  assert.strictEqual(items.isResolved(it, { disk: { reclaimBytes: 0 } }, { diskBytes: C.DISK_RECLAIM_BYTES }), true);
  assert.strictEqual(items.isResolved(it, { disk: { reclaimBytes: C.DISK_RECLAIM_BYTES } }, { diskBytes: C.DISK_RECLAIM_BYTES }), false);
});

test('auto-resolve deadline — done/삭제 시 해소', () => {
  const it = openItem('deadline', 't1')[0];
  assert.strictEqual(items.isResolved(it, { deadlines: [{ id: 't1', done: true, dueAt: NOW }] }, {}), true);
  assert.strictEqual(items.isResolved(it, { deadlines: [] }, {}), true); // 삭제
  assert.strictEqual(items.isResolved(it, { deadlines: [{ id: 't1', done: false, dueAt: NOW }] }, {}), false);
});

test('auto-resolve 이벤트형(mail/scan)은 자동 해소 안 함', () => {
  assert.strictEqual(items.isResolved(openItem('mail', 'm1')[0], { mail: { unseen: 0 } }, {}), false);
  assert.strictEqual(items.isResolved(openItem('scan', 's1')[0], {}, {}), false);
});

test('carry-over — auto-resolve된 항목은 제외 + resolvedKeys 보고', () => {
  const prev = openItem('dirty', 'a'); // open
  const snap = { projects: [{ id: 'a', dirty: false }] }; // clean → resolve
  const sel = items.selectCarryOver(prev, [], snap, { now: NOW });
  assert.strictEqual(sel.items.length, 0);
  assert.strictEqual(sel.resolvedKeys.length, 1);
});

test('R-38 — mergePersist: dismissed TTL 만료 정리', () => {
  const it = openItem('mail', 'm1');
  const dismissed = items.applyResolution(it, it[0].key, 'dismiss', NOW - C.DISMISS_TTL_MS - 1).items;
  // display는 비어있음(resolve된 게 아니라 dismissed). mergePersist에서 TTL 초과로 정리.
  const persist = items.mergePersist(dismissed, [], [], { now: NOW });
  assert.strictEqual(persist.length, 0, 'TTL 초과 dismissed 정리');
  // 아직 만료 전이면 보존.
  const fresh = items.applyResolution(it, it[0].key, 'dismiss', NOW).items;
  assert.strictEqual(items.mergePersist(fresh, [], [], { now: NOW }).length, 1);
});

test('R-38 — mergePersist: done 항목 보존', () => {
  const it = openItem('dirty', 'a');
  const done = items.applyResolution(it, it[0].key, 'done', NOW).items;
  const persist = items.mergePersist(done, [], [], { now: NOW });
  assert.strictEqual(persist.length, 1);
  assert.strictEqual(persist[0].status, 'done');
});

test('R-38 — normalizeItems: 키 중복 제거·개수 상한·텍스트 sanitize', () => {
  const dup = [{ signalType: 'dirty', targetId: 'a' }, { signalType: 'dirty', targetId: 'a' }];
  assert.strictEqual(items.normalizeItems(dup).length, 1);
  const evil = items.normalizeItem({ signalType: 'dirty', targetId: 'a', title: 'x' + String.fromCharCode(7) + 'y' });
  assert.strictEqual(evil.title, 'xy', '제어문자(BEL) 제거');
});
