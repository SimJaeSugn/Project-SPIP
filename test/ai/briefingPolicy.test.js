'use strict';
/**
 * test/ai/briefingPolicy.test.js — 필요성 판정·분류·fast-path (R-36·N-09)
 * 순수·헤드리스. 경계 임계값(deadline 24h·dirty≥3·disk 1GB)·상태/이벤트 신호 검증.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const policy = require('../../lib/ai/briefingPolicy');
const C = require('../../lib/ai/briefingConst');

const NOW = 1_700_000_000_000;

test('R-36 — 유의 변화 없으면 trigger=false(노이즈 비트리거)', () => {
  const snap = { projects: [{ id: 'a', dirty: false, ahead: 0, behind: 0 }] };
  const r = policy.evaluate(snap, snap, { now: NOW });
  assert.strictEqual(r.trigger, false);
  assert.strictEqual(r.signals.length, 0);
});

test('R-36 — 신규 dirty 1건 트리거(must·디바운스)', () => {
  const prev = { projects: [{ id: 'a', dirty: false }] };
  const cur = { projects: [{ id: 'a', dirty: true }] };
  const r = policy.evaluate(prev, cur, { now: NOW });
  assert.strictEqual(r.trigger, true);
  assert.strictEqual(r.urgent, false);
  assert.strictEqual(r.signals[0].type, 'dirty');
  assert.strictEqual(r.signals[0].category, 'must');
});

test('[briefing name] normProject·normDeadline가 name 보존(없으면 빈 문자열)', () => {
  const n = policy.normalizeSnapshot({
    projects: [{ id: 'a', name: 'My-Project', dirty: true }, { id: 'b', dirty: true }],
    deadlines: [{ id: 'd1', name: '보고서 마감', dueAt: 1, done: false }],
  });
  assert.strictEqual(n.projects[0].name, 'My-Project');
  assert.strictEqual(n.projects[1].name, '', 'name 없으면 빈 문자열 graceful');
  assert.strictEqual(n.deadlines[0].name, '보고서 마감');
});

test('[briefing name] 신호에 targetLabel(name) 포함, targetId(해시 식별자)는 매칭용 유지', () => {
  const prev = { projects: [{ id: 'hash-a', name: 'My-Project', dirty: false }] };
  const cur = { projects: [{ id: 'hash-a', name: 'My-Project', dirty: true }] };
  const s = policy.evaluate(prev, cur, { now: NOW }).signals[0];
  assert.strictEqual(s.targetLabel, 'My-Project');
  assert.strictEqual(s.targetId, 'hash-a', 'targetId는 매칭·dedup용 유지');
});

test('[briefing name] deadline 신호도 라벨 포함(없으면 graceful 빈값)', () => {
  const cur = { deadlines: [{ id: 'd1', dueAt: NOW, done: false }] };
  const s = policy.evaluate(null, cur, { now: NOW }).signals.find((x) => x.type === 'deadline');
  assert.strictEqual(s.targetLabel, '');
});

test('R-36 — 대량 신규 dirty(≥3) fast-path 승격(urgent)', () => {
  const prev = { projects: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] };
  const cur = { projects: [{ id: 'a', dirty: true }, { id: 'b', dirty: true }, { id: 'c', dirty: true }] };
  const r = policy.evaluate(prev, cur, { now: NOW });
  assert.strictEqual(r.urgent, true);
  assert.ok(r.signals.every((s) => s.urgent && s.category === 'urgent'));
});

test('R-36 — dirty 2건은 fast-path 아님(경계 dirty<3)', () => {
  const prev = { projects: [{ id: 'a' }, { id: 'b' }] };
  const cur = { projects: [{ id: 'a', dirty: true }, { id: 'b', dirty: true }] };
  const r = policy.evaluate(prev, cur, { now: NOW });
  assert.strictEqual(r.urgent, false);
});

test('R-36 — behind 0→양수 급함 fast-path(urgent)', () => {
  const prev = { projects: [{ id: 'a', behind: 0 }] };
  const cur = { projects: [{ id: 'a', behind: 2 }] };
  const r = policy.evaluate(prev, cur, { now: NOW });
  assert.strictEqual(r.urgent, true);
  assert.strictEqual(r.signals[0].type, 'behind');
});

test('R-36 — ahead 0→양수 트리거(must·비급함)', () => {
  const prev = { projects: [{ id: 'a', ahead: 0 }] };
  const cur = { projects: [{ id: 'a', ahead: 3 }] };
  const r = policy.evaluate(prev, cur, { now: NOW });
  assert.strictEqual(r.signals[0].type, 'ahead');
  assert.strictEqual(r.urgent, false);
});

test('R-36 — 마감 24h 진입 fast-path(경계 within)', () => {
  const within = NOW + 23 * 60 * 60 * 1000; // 23h < 24h
  const beyond = NOW + 25 * 60 * 60 * 1000;
  const prev = { deadlines: [{ id: 't1', dueAt: beyond, done: false }] };
  const cur = { deadlines: [{ id: 't1', dueAt: within, done: false }] };
  const r = policy.evaluate(prev, cur, { now: NOW });
  assert.strictEqual(r.urgent, true);
  assert.strictEqual(r.signals[0].type, 'deadline');
});

test('R-36 — 마감 25h(경계 밖)는 비트리거', () => {
  const beyond = NOW + 25 * 60 * 60 * 1000;
  const cur = { deadlines: [{ id: 't1', dueAt: beyond, done: false }] };
  const r = policy.evaluate(null, cur, { now: NOW });
  assert.strictEqual(r.trigger, false);
});

test('R-36 — 새 메일(unseen 증가) 이벤트형 트리거(good)', () => {
  const prev = { mail: { unseen: 0 } };
  const cur = { mail: { unseen: 2, latestUid: 'u9' } };
  const r = policy.evaluate(prev, cur, { now: NOW });
  assert.strictEqual(r.signals[0].type, 'mail');
  assert.strictEqual(r.signals[0].category, 'good');
});

test('R-36 — 디스크 회수 1GB 경계(미만 비트리거·이상 트리거)', () => {
  const below = { disk: { reclaimBytes: C.DISK_RECLAIM_BYTES - 1 } };
  const at = { disk: { reclaimBytes: C.DISK_RECLAIM_BYTES } };
  assert.strictEqual(policy.evaluate(null, below, { now: NOW }).trigger, false);
  const r = policy.evaluate({ disk: { reclaimBytes: 0 } }, at, { now: NOW });
  assert.strictEqual(r.signals.some((s) => s.type === 'disk'), true);
});

test('R-36 — 첫 생성(prev null)은 scan만으로 트리거 안 함', () => {
  const cur = { scan: { generatedAt: '2026-06-25T00:00:00Z' } };
  const r = policy.evaluate(null, cur, { now: NOW });
  assert.strictEqual(r.trigger, false);
});

test('R-36 — scan generatedAt 변경(prev 존재) 트리거', () => {
  const prev = { scan: { generatedAt: 'A' } };
  const cur = { scan: { generatedAt: 'B' } };
  const r = policy.evaluate(prev, cur, { now: NOW });
  assert.strictEqual(r.signals.some((s) => s.type === 'scan'), true);
});

test('R-36 — 손상 입력 graceful(빈 신호)', () => {
  assert.strictEqual(policy.evaluate(null, null, { now: NOW }).trigger, false);
  assert.strictEqual(policy.evaluate(undefined, {}, { now: NOW }).trigger, false);
  assert.strictEqual(policy.evaluate('x', 42, { now: NOW }).trigger, false);
});
