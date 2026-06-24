'use strict';
/**
 * test/ai/briefingOrchestrator.test.js — coalesce·fast-path·단일 in-flight·인디케이터·에러 push (R-36·N-09·M-2)
 * 가짜 타이머·모킹 client — 네트워크 0.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const { BriefingOrchestrator, STATUS } = require('../../lib/ai/briefingOrchestrator');

/** 수동 제어 가짜 타이머. */
function fakeTimers() {
  let seq = 1;
  const pending = new Map();
  return {
    setTimeoutFn: (fn, ms) => { const id = seq++; pending.set(id, fn); return id; },
    clearTimeoutFn: (id) => { pending.delete(id); },
    flush: () => { for (const [id, fn] of Array.from(pending)) { pending.delete(id); fn(); } },
    count: () => pending.size,
  };
}

/** 즉시 완료 모킹 LLM. */
function okClient(text) {
  return {
    async streamBriefing(args) {
      if (args.onDelta) args.onDelta(text || 'hi');
      return { ok: true, text: text || 'hi', code: 'OK' };
    },
    async testConnection() { return { ok: true, code: 'OK' }; },
  };
}

function baseDeps(over) {
  const t = fakeTimers();
  const store = { items: [], lastSnapshot: null };
  const events = { state: [], delta: [], done: [], error: [] };
  const deps = Object.assign({
    getConfig: () => ({ briefing: { enabled: true, advanced: { coalesceMs: 2000, deadlineH: 24 } } }),
    llmClient: okClient(),
    snapshotProvider: () => ({ projects: [] }),
    loadItems: () => ({ items: store.items, lastSnapshot: store.lastSnapshot }),
    saveItems: (v) => { store.items = v.items; store.lastSnapshot = v.lastSnapshot; },
    pushState: (p) => events.state.push(p),
    pushDelta: (p) => events.delta.push(p),
    pushDone: (p) => events.done.push(p),
    pushError: (p) => events.error.push(p),
    isSuppressed: () => false,
    setTimeoutFn: t.setTimeoutFn,
    clearTimeoutFn: t.clearTimeoutFn,
    now: () => 1000,
    makeAbort: () => ({ abort() { this.signal.aborted = true; }, signal: { aborted: false } }),
  }, over);
  return { deps, t, events, store };
}

test('R-36 — disabled면 notify 무동작(status=disabled)', () => {
  const { deps, events } = baseDeps({ getConfig: () => ({ briefing: { enabled: false } }) });
  const o = new BriefingOrchestrator(deps);
  o.notify('state');
  assert.strictEqual(events.state.pop().status, STATUS.DISABLED);
  assert.strictEqual(events.done.length, 0);
});

test('N-09 — isSuppressed면 트리거 억제', () => {
  const { deps, events } = baseDeps({
    isSuppressed: () => true,
    snapshotProvider: () => ({ projects: [{ id: 'a', dirty: true }] }),
  });
  const o = new BriefingOrchestrator(deps);
  o.notify('state');
  assert.strictEqual(events.state.length, 0);
});

test('D3 — 인디케이터(generating) push가 LLM 호출 전(coalesce 대기 중)에 발사', () => {
  const { deps, events, t } = baseDeps({ snapshotProvider: () => ({ projects: [{ id: 'a', dirty: true }] }) });
  const o = new BriefingOrchestrator(deps);
  o.notify('state');
  // 일반 신호 → coalesce 대기. generating은 이미 push됨(LLM 호출 전).
  assert.strictEqual(events.state[0].status, STATUS.GENERATING);
  assert.strictEqual(events.done.length, 0, '아직 호출 안 됨');
  assert.strictEqual(t.count(), 1, 'coalesce 타이머 대기');
});

test('R-36 — coalesce: 일반 이벤트 다발이 1회 생성으로 병합', async () => {
  const { deps, events, t } = baseDeps({ snapshotProvider: () => ({ projects: [{ id: 'a', dirty: true }] }) });
  const o = new BriefingOrchestrator(deps);
  o.notify('state'); o.notify('state'); o.notify('state');
  assert.strictEqual(t.count(), 1, '타이머 1개(병합)');
  t.flush();
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(events.done.length, 1, '생성 1회');
});

test('R-36 — fast-path: 급함(behind) 신호는 디바운스 우회 즉시 생성', async () => {
  let snap = { projects: [{ id: 'a', behind: 0 }] };
  const { deps, events, t } = baseDeps({ snapshotProvider: () => snap });
  const o = new BriefingOrchestrator(deps);
  // prev 스냅샷 확보를 위해 첫 생성 후 behind 0→양수.
  snap = { projects: [{ id: 'a', behind: 2 }] };
  o.notify('state');
  assert.strictEqual(t.count(), 0, 'coalesce 우회');
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(events.done.length, 1, '즉시 생성');
});

test('N-09 — 단일 in-flight: 신규 트리거 시 세대++(이전 delta 무시)', async () => {
  let resolveFirst;
  const slowClient = {
    async streamBriefing(args) {
      args.onDelta('a');
      await new Promise((r) => { resolveFirst = r; });
      return { ok: true, text: 'a', code: 'OK' };
    },
  };
  const { deps, events } = baseDeps({
    llmClient: slowClient,
    snapshotProvider: () => ({ projects: [{ id: 'a', behind: 1 }] }),
  });
  const o = new BriefingOrchestrator(deps);
  o.notify('state'); // gen=1 시작(behind fast-path)
  await new Promise((r) => setImmediate(r));
  const gen1 = events.delta[0].gen;
  o.notify('state'); // gen=2 — 이전 abort
  if (resolveFirst) resolveFirst();
  await new Promise((r) => setImmediate(r));
  // gen1의 done은 무시됨(세대 불일치).
  const gen1Done = events.done.find((d) => d.gen === gen1);
  assert.strictEqual(gen1Done, undefined, '취소된 세대 done 폐기');
});

test('R-40/M-2 — 에러 시 error push payload = code만(message·url·key 0)', async () => {
  const failClient = { async streamBriefing() { return { ok: false, text: '', code: 'CONN_REFUSED' }; } };
  const { deps, events } = baseDeps({
    llmClient: failClient,
    snapshotProvider: () => ({ projects: [{ id: 'a', behind: 1 }] }),
  });
  const o = new BriefingOrchestrator(deps);
  o.notify('state');
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(events.error.length, 1);
  const payload = events.error[0];
  assert.deepStrictEqual(Object.keys(payload).sort(), ['code', 'gen']);
  assert.strictEqual(payload.code, 'CONN_REFUSED');
});

test('R-38 — resolveItem done 적용 후 open 항목 반환', () => {
  const items = require('../../lib/ai/briefingItems');
  const open = items.itemsFromSignals([{ type: 'dirty', targetId: 'a' }], 1000);
  const { deps, store } = baseDeps({ loadItems: () => ({ items: open, lastSnapshot: null }) });
  store.items = open;
  // loadItems가 store.items를 읽도록 재배선.
  deps.loadItems = () => ({ items: store.items, lastSnapshot: null });
  const o = new BriefingOrchestrator(deps);
  const remaining = o.resolveItem(open[0].key, 'done');
  assert.strictEqual(remaining.length, 0, 'done 후 open 0');
  assert.strictEqual(store.items[0].status, 'done');
});

test('getState — disabled 시 status=disabled', () => {
  const { deps } = baseDeps({ getConfig: () => ({ briefing: { enabled: false } }) });
  const o = new BriefingOrchestrator(deps);
  assert.strictEqual(o.getState().status, STATUS.DISABLED);
});
