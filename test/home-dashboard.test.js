'use strict';
/**
 * home-dashboard.test.js — public/app.js 홈(브리핑) 순수 뷰모델 (M1, 헤드리스)
 *   homeGreeting / isAttentionVm / homeKpis / homeAttention / homeRecentActivity
 */
const { test } = require('node:test');
const assert = require('node:assert');

const {
  homeGreeting, isAttentionVm, homeKpis, homeAttention, homeRecentActivity,
} = require('../public/app.js');

function vm(over) {
  return Object.assign(
    { id: 'x', name: 'X', path: '/p', language: 'JS', gitStatus: 'clean', isStale: false, ahead: 0, behind: 0, lastModified: null },
    over);
}

test('homeGreeting — 시간대 분기', () => {
  assert.strictEqual(homeGreeting(new Date(2026, 0, 1, 8, 0)).greeting, '좋은 아침이에요');
  assert.strictEqual(homeGreeting(new Date(2026, 0, 1, 14, 0)).greeting, '좋은 오후예요');
  assert.strictEqual(homeGreeting(new Date(2026, 0, 1, 20, 0)).greeting, '좋은 저녁이에요');
  assert.strictEqual(homeGreeting(new Date(2026, 0, 1, 2, 0)).greeting, '늦은 밤이에요');
  // 잘못된 입력도 throw 없이 동작(현재 시각 폴백).
  assert.ok(typeof homeGreeting(null).greeting === 'string');
});

test('isAttentionVm — dirty/stale/ahead/behind 중 하나라도', () => {
  assert.ok(isAttentionVm(vm({ gitStatus: 'dirty' })));
  assert.ok(isAttentionVm(vm({ isStale: true })));
  assert.ok(isAttentionVm(vm({ ahead: 2 })));
  assert.ok(isAttentionVm(vm({ behind: 1 })));
  assert.ok(!isAttentionVm(vm({})));
  assert.ok(!isAttentionVm(null));
});

test('homeKpis — total/attention/stale/dirty 집계', () => {
  const list = [vm({ gitStatus: 'dirty' }), vm({ isStale: true }), vm({ gitStatus: 'dirty', isStale: true }), vm({})];
  const k = homeKpis(list);
  assert.strictEqual(k.total, 4);
  assert.strictEqual(k.dirty, 2);
  assert.strictEqual(k.stale, 2);
  assert.strictEqual(k.attention, 3);
  assert.deepStrictEqual(homeKpis(null), { total: 0, attention: 0, stale: 0, dirty: 0 });
});

test('homeAttention — dirty 우선·동점은 최근 수정순·limit', () => {
  const list = [
    vm({ id: 'a', isStale: true, lastModified: '2026-01-01T00:00:00Z' }),
    vm({ id: 'b', gitStatus: 'dirty', lastModified: '2026-01-02T00:00:00Z' }),
    vm({ id: 'c', gitStatus: 'clean' }), // 미flag → 제외
    vm({ id: 'd', gitStatus: 'dirty', lastModified: '2026-01-03T00:00:00Z' }),
  ];
  assert.deepStrictEqual(homeAttention(list, 6).map((v) => v.id), ['d', 'b', 'a']);
  assert.strictEqual(homeAttention(list, 1).length, 1);
  assert.deepStrictEqual(homeAttention(null), []);
});

test('homeRecentActivity — lastModified 내림차순·무효 제외·limit', () => {
  const list = [
    vm({ id: 'a', name: 'A', lastModified: '2026-01-01T00:00:00Z' }),
    vm({ id: 'b', name: 'B', lastModified: '2026-01-03T00:00:00Z' }),
    vm({ id: 'c', name: 'C', lastModified: null }), // 제외
    vm({ id: 'd', name: 'D', lastModified: '2026-01-02T00:00:00Z' }),
  ];
  assert.deepStrictEqual(homeRecentActivity(list, 8).map((e) => e.id), ['b', 'd', 'a']);
  assert.strictEqual(homeRecentActivity(list, 2).length, 2);
  assert.deepStrictEqual(homeRecentActivity(null), []);
});
