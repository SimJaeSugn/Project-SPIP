'use strict';
/**
 * test/ai/briefing-followup.test.js — M13 통합검증 후속 반영 검증
 *   P1: deriveSnapshot mail/disk 실신호 → policy 트리거 (M13-Q-1)
 *   P2: lastSnapshot 영속 라운드트립(과트리거 방지, code-review #1)
 *       스트림 절대 상한 abort+안전종료(security L-1)
 *       counters 증가(code-review #2 / N-10)
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { deriveSnapshot, buildUsageSummary } = require('../../electron/context');
const policy = require('../../lib/ai/briefingPolicy');
const items = require('../../lib/ai/briefingItems');
const { createLlmClient, CODE } = require('../../lib/ai/llmClient');
const { BriefingOrchestrator } = require('../../lib/ai/briefingOrchestrator');
const briefingIpc = require('../../electron/ipc/briefing');
const uiStateStore = require('../../lib/common/uiStateStore');
const C = require('../../lib/ai/briefingConst');
const { Logger } = require('../../lib/common/logger');

function quiet() { return new Logger({ quiet: true }); }
function tmpPath() {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'spip-bf-')));
  return path.join(dir, 'ui-state.json');
}

// ── P1: deriveSnapshot 실신호 ──

test('P1/M13-Q-1 — deriveSnapshot이 mail unseen(주입 getter)·disk(node_modules) 채움', () => {
  const ctx = {
    store: {
      hasSnapshot: true,
      getProjects: () => ([{ id: 'aa', git: { dirty: false, ahead: 0, behind: 0 }, size: { nodeModulesBytes: 2 * 1024 * 1024 * 1024 } }]),
      getGeneratedAt: () => '2026-06-25T00:00:00Z',
    },
  };
  const snap = deriveSnapshot(ctx, { mailState: () => ({ unseen: 5, latestUid: '42' }) });
  assert.strictEqual(snap.mail.unseen, 5);
  assert.strictEqual(snap.mail.latestUid, '42');
  assert.strictEqual(snap.disk.reclaimBytes, 2 * 1024 * 1024 * 1024);
});

test('[briefing name] deriveSnapshot이 프로젝트 name 보존(없으면 빈 문자열 graceful)', () => {
  const ctx = {
    store: {
      hasSnapshot: true,
      getProjects: () => ([
        { id: 'aa', name: 'My-Project', git: { dirty: true } },
        { id: 'bb', git: { dirty: true } },
      ]),
      getGeneratedAt: () => null,
    },
  };
  const snap = deriveSnapshot(ctx, {});
  assert.strictEqual(snap.projects[0].name, 'My-Project');
  assert.strictEqual(snap.projects[1].name, '', 'name 없으면 빈 문자열');
});

test('P1 — mail unseen 증가가 policy 트리거(이벤트형)', () => {
  const prev = deriveSnapshot({ store: { hasSnapshot: true, getProjects: () => [], getGeneratedAt: () => null } }, { mailState: () => ({ unseen: 0 }) });
  const cur = deriveSnapshot({ store: { hasSnapshot: true, getProjects: () => [], getGeneratedAt: () => null } }, { mailState: () => ({ unseen: 3, latestUid: 'u9' }) });
  const r = policy.evaluate(prev, cur, { now: 1000 });
  assert.strictEqual(r.signals.some((s) => s.type === 'mail'), true);
});

test('P1 — disk 1GB 신규가 policy 트리거(상태형)', () => {
  const mk = (nm) => deriveSnapshot({ store: { hasSnapshot: true, getProjects: () => [{ id: 'aa', git: {}, size: { nodeModulesBytes: nm } }], getGeneratedAt: () => null } }, {});
  const r = policy.evaluate(mk(0), mk(2 * 1024 * 1024 * 1024), { now: 1000 });
  assert.strictEqual(r.signals.some((s) => s.type === 'disk'), true);
});

// ── P2: lastSnapshot 영속 ──

test('P2/code-review#1 — lastSnapshot write→read 라운드트립(과트리거 방지)', () => {
  const p = tmpPath();
  const cstore = briefingIpc.makeCarryOverStore({ logger: quiet(), uiStatePath: p });
  const snap = policy.normalizeSnapshot({ projects: [{ id: 'ab', dirty: true }], mail: { unseen: 2, latestUid: 'u1' }, disk: { reclaimBytes: 0 } });
  cstore.saveItems({ items: [], lastSnapshot: snap });
  const back = cstore.loadItems();
  assert.ok(back.lastSnapshot, 'lastSnapshot 영속됨(null 아님)');
  assert.strictEqual(back.lastSnapshot.projects[0].id, 'ab');
  assert.strictEqual(back.lastSnapshot.mail.unseen, 2);
});

test('P2 — normalizeBriefingSnapshot: 키 형식·개수 상한·graceful', () => {
  assert.strictEqual(uiStateStore.normalizeBriefingSnapshot(null), null);
  const s = uiStateStore.normalizeBriefingSnapshot({ projects: [{ id: 'ZZ!', dirty: true }, { id: 'cd', dirty: true }] });
  assert.strictEqual(s.projects.length, 1, '잘못된 id 폐기');
  assert.strictEqual(s.projects[0].id, 'cd');
});

test('P2 — 영속된 lastSnapshot으로 재시작 후 동일 상태면 비트리거', () => {
  const p = tmpPath();
  const cstore = briefingIpc.makeCarryOverStore({ logger: quiet(), uiStatePath: p });
  const cur = { projects: [{ id: 'ab', dirty: true, ahead: 0, behind: 0, attention: false }], mail: { unseen: 0 }, disk: { reclaimBytes: 0 }, scan: { generatedAt: null } };
  cstore.saveItems({ items: [], lastSnapshot: policy.normalizeSnapshot(cur) });
  // 재시작 시뮬레이션 — loadItems의 lastSnapshot을 prev로 평가.
  const loaded = cstore.loadItems();
  const r = policy.evaluate(loaded.lastSnapshot, cur, { now: 1000 });
  assert.strictEqual(r.trigger, false, '동일 상태 — 과트리거 0');
});

// ── P2: 스트림 절대 상한 ──

test('P2/security L-1 — 누적 스트림 상한 초과 시 절단+안전종료(ok)', async () => {
  // 매 chunk 1KB씩 무한 생성하는 악성 스트림.
  let aborted = false;
  const client = createLlmClient({
    getConfig: () => ({ briefing: { baseURL: 'http://127.0.0.1:1/v1' } }),
    chatFactory: () => ({
      async stream(_m, opts) {
        return (async function* () {
          for (let i = 0; i < 1000000; i++) {
            if (opts.signal && opts.signal.aborted) { aborted = true; return; }
            yield { content: 'x'.repeat(1024) };
          }
        })();
      },
    }),
  });
  const r = await client.streamBriefing({ system: 's', user: 'u' });
  assert.strictEqual(r.ok, true, '안전 종료(done)');
  assert.ok(r.text.length <= C.MAX_STREAM_CHARS, '상한 이내로 절단');
  assert.strictEqual(r.text.length, C.MAX_STREAM_CHARS);
  assert.strictEqual(r.code, CODE.OK);
});

// ── P2: counters 증가 ──

test('P2/code-review#2 — saveItems counterDelta 누적(generated/done/dismiss)', () => {
  const p = tmpPath();
  const cstore = briefingIpc.makeCarryOverStore({ logger: quiet(), uiStatePath: p });
  cstore.saveItems({ items: [], counterDelta: { generated: 1 } });
  cstore.saveItems({ items: [], counterDelta: { generated: 1, done: 1 } });
  cstore.saveItems({ items: [], counterDelta: { dismiss: 1 } });
  const back = uiStateStore.read({ logger: quiet(), uiStatePath: p });
  assert.deepStrictEqual(back.briefing.counters, { generated: 2, done: 1, dismiss: 1 });
});

test('P2 — orchestrator resolveItem done/dismiss가 counters 증가', () => {
  const items = require('../../lib/ai/briefingItems');
  const open = items.itemsFromSignals([{ type: 'dirty', targetId: 'a' }], 1000);
  let store = { items: open, lastSnapshot: null };
  const deltas = [];
  const o = new BriefingOrchestrator({
    getConfig: () => ({ briefing: { enabled: true } }),
    llmClient: { async streamBriefing() { return { ok: true, text: '', code: 'OK' }; } },
    loadItems: () => ({ items: store.items, lastSnapshot: store.lastSnapshot }),
    saveItems: (v) => { store.items = v.items; if (v.counterDelta) deltas.push(v.counterDelta); },
    now: () => 1000,
  });
  o.resolveItem(open[0].key, 'done');
  assert.deepStrictEqual(deltas[0], { done: 1 });
});

test('P2 — _fire 성공 시 generated 카운터 delta', async () => {
  let store = { items: [], lastSnapshot: null };
  const deltas = [];
  const o = new BriefingOrchestrator({
    getConfig: () => ({ briefing: { enabled: true, advanced: { coalesceMs: 2000, deadlineH: 24 } } }),
    llmClient: { async streamBriefing(a) { if (a.onDelta) a.onDelta('hi'); return { ok: true, text: 'hi', code: 'OK' }; } },
    snapshotProvider: () => ({ projects: [{ id: 'a', behind: 1 }] }),
    loadItems: () => ({ items: store.items, lastSnapshot: store.lastSnapshot }),
    saveItems: (v) => { store.items = v.items; store.lastSnapshot = v.lastSnapshot; if (v.counterDelta) deltas.push(v.counterDelta); },
    pushState: () => {}, pushDelta: () => {}, pushDone: () => {}, pushError: () => {},
    now: () => 1000,
    makeAbort: () => ({ abort() { this.signal.aborted = true; }, signal: { aborted: false } }),
  });
  o.notify('state'); // behind fast-path
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(deltas[0], { generated: 1 });
  assert.ok(store.lastSnapshot, 'lastSnapshot 저장됨');
});

test('P3/security L-2 — getSettings baseURL 재정규화(불량이면 기본값)', () => {
  const r = briefingIpc.getSettings(null, { config: { briefing: { baseURL: 'http://localhost:5000/v1', model: 'm', apiKey: '' } } });
  assert.strictEqual(r.baseURL, 'http://localhost:5000/v1');
});

// ── [브리핑 일정] 할 일 마감(deadline) ──

test('[브리핑 일정] deadline 신호 — 임박/경과 context·URGENT, done은 무신호', () => {
  const now = 1700000000000;
  const cur = { deadlines: [
    { id: 't1abcde', name: '분기 보고서', dueAt: now + 3 * 3600000, done: false }, // 3시간 후(임박)
    { id: 't2abcde', name: '코드 리뷰', dueAt: now - 2 * 86400000, done: false },   // 2일 경과(미완료)
    { id: 't3abcde', name: '완료건', dueAt: now + 1000, done: true },               // done → 무시
    { id: 't4abcde', name: '먼훗날', dueAt: now + 10 * 86400000, done: false },      // 24h 밖 → 무시
  ] };
  const ds = policy.evaluate(null, cur, { now }).signals.filter((s) => s.type === 'deadline');
  assert.strictEqual(ds.length, 2, '임박 + 경과만 신호');
  const t1 = ds.find((s) => s.targetId === 't1abcde');
  const t2 = ds.find((s) => s.targetId === 't2abcde');
  assert.ok(/다가오는 마감/.test(t1.context), '임박 context');
  assert.ok(/마감 지남/.test(t2.context), '경과 context');
  assert.strictEqual(t1.category, 'urgent');
});

test('[브리핑 일정] itemsFromSignals가 deadline context를 항목으로 전파', () => {
  const out = items.itemsFromSignals([{ type: 'deadline', targetId: 't1abcde', category: 'urgent', targetLabel: '보고서', context: '다가오는 마감 — 약 3시간 후' }], 1000);
  assert.strictEqual(out[0].context, '다가오는 마감 — 약 3시간 후');
  assert.strictEqual(out[0].targetLabel, '보고서');
});

test('[브리핑 일정] deriveSnapshot이 ui-state 할 일 dueAt을 deadlines로 채움', () => {
  const p = tmpPath();
  uiStateStore.write({ todos: [
    { id: 't1abcde', text: '보고서 제출', done: false, dueAt: 1800000000000 },
    { id: 't2abcde', text: '마감없음', done: false }, // dueAt 없음 → 제외
  ] }, { logger: quiet(), uiStatePath: p });
  const ctx = { uiStatePath: p, logger: quiet(), store: { hasSnapshot: false, getProjects: () => [] } };
  const snap = deriveSnapshot(ctx, {});
  assert.strictEqual(snap.deadlines.length, 1, 'dueAt 보유 항목만');
  assert.strictEqual(snap.deadlines[0].id, 't1abcde');
  assert.strictEqual(snap.deadlines[0].dueAt, 1800000000000);
});

test('[브리핑 일정] normalizeBriefingSnapshot이 deadlines(id·dueAt·done) 영속', () => {
  const s = uiStateStore.normalizeBriefingSnapshot({ deadlines: [
    { id: 't1abcde', dueAt: 123, done: false },
    { id: 'BAD!', dueAt: 9, done: false }, // 잘못된 id → 폐기
  ] });
  assert.strictEqual(s.deadlines.length, 1);
  assert.strictEqual(s.deadlines[0].id, 't1abcde');
  assert.strictEqual(s.deadlines[0].dueAt, 123);
});

// ── [브리핑 토큰리포트] 토큰 사용량 ──

test('[브리핑 토큰리포트] buildUsageSummary — 연결 모델 + Claude 추이(증가세)', () => {
  const ai = { calls: 10, totalTokens: 1500000, lastModel: 'exaone3.5:32b' };
  const claude = { available: true, totals: { totalTokens: 8000000 }, today: { totalTokens: 45000 },
    daily: Array.from({ length: 14 }, (_, i) => ({ totalTokens: i < 7 ? 10000 : 30000 })) }; // 직전7=70k<최근7=210k
  const s = buildUsageSummary(ai, claude);
  assert.ok(/연결 모델/.test(s) && /10회/.test(s));
  assert.ok(/Claude Code/.test(s) && /증가세/.test(s));
  assert.strictEqual(buildUsageSummary({ calls: 0 }, null), null, '데이터 없으면 null');
});

test('[브리핑 토큰리포트] _fire가 usage 항목을 표시엔 포함·영속엔 제외', async () => {
  const usageKey = items.itemKey('usage', 'usage');
  let saved = null; const done = [];
  const o = new BriefingOrchestrator({
    getConfig: () => ({ briefing: { enabled: true, advanced: { coalesceMs: 2000, deadlineH: 24 } } }),
    llmClient: { async streamBriefing() { return { ok: true, text: JSON.stringify([{ key: usageKey, title: '토큰 리포트', reason: 'r', guide: 'g' }]), code: 'OK' }; } },
    snapshotProvider: () => ({ projects: [{ id: 'a', behind: 1 }] }),
    loadItems: () => ({ items: [], lastSnapshot: null }),
    saveItems: (v) => { saved = v; },
    pushState: () => {}, pushDelta: () => {}, pushError: () => {},
    pushDone: (p) => done.push(p),
    usageProvider: () => '[연결 모델] 누적 1.5M토큰·10회 호출',
    now: () => 1000,
    makeAbort: () => ({ abort() { this.signal.aborted = true; }, signal: { aborted: false } }),
  });
  o.notify('state'); // behind fast-path → _fire
  await new Promise((r) => setImmediate(r));
  assert.ok(done[0] && done[0].items.some((it) => it.key === usageKey), 'usage 카드 표시(pushDone)');
  assert.ok(saved && Array.isArray(saved.items) && !saved.items.some((it) => it.key === usageKey), 'usage는 비영속');
});
