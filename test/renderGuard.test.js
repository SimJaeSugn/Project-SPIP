'use strict';
/**
 * renderGuard.test.js — lib/common/renderGuard.js 순수 판정 로직 (R-25/R-26, 헤드리스 F-3)
 *   RG-1: shouldDeferRender 6플래그 전수(단독 true→defer / 전부 false→통과 / 복합).
 *   RG-2: createCoalescer 동시성(발화 재검사·다중 보류 단일 발화·pending 단조).
 *   D-3 : 동형 계약 불변식(app.js _coalescer 가 정본과 동일 알고리즘임을 강제).
 *   R-26: IME 조합 시나리오(조합 중 render 보류 → compositionend 1회 반영, 영문 회귀 0).
 */
const { test } = require('node:test');
const assert = require('node:assert');

const { shouldDeferRender, createCoalescer } = require('../lib/common/renderGuard');

const FLAGS = ['composing', 'dragging', 'overlayOpen', 'busyMail', 'busyCommit', 'editing'];

// ── RG-1: shouldDeferRender ──────────────────────────────────────────────
test('R-25 RG-1 — 각 플래그 단독 true 면 defer=true(6종 전수)', () => {
  for (const flag of FLAGS) {
    const f = {};
    f[flag] = true;
    assert.strictEqual(shouldDeferRender(f), true, flag + ' 단독 true → defer');
  }
});

test('R-25 RG-1 — 모든 플래그 false 면 defer=false(통과)', () => {
  const f = {};
  for (const flag of FLAGS) f[flag] = false;
  assert.strictEqual(shouldDeferRender(f), false);
});

test('R-25 RG-1 — 인자 부재/빈 객체는 defer=false', () => {
  assert.strictEqual(shouldDeferRender(), false);
  assert.strictEqual(shouldDeferRender(null), false);
  assert.strictEqual(shouldDeferRender({}), false);
});

test('R-25 RG-1 — 복수 플래그 동시 true 면 defer=true', () => {
  assert.strictEqual(shouldDeferRender({ composing: true, dragging: true }), true);
  assert.strictEqual(shouldDeferRender({ busyMail: true, editing: true, overlayOpen: true }), true);
});

test('R-25 RG-1 — truthy(비-boolean)도 OR 로 보류 처리', () => {
  // overlayOpen 은 app.js 에서 selectedId(문자열) 같은 truthy 가 들어올 수 있다.
  assert.strictEqual(shouldDeferRender({ overlayOpen: 'someId' }), true);
});

// ── RG-2: createCoalescer 동시성 ─────────────────────────────────────────
// 수동 타이머 주입 헬퍼: 발화 시점을 테스트가 제어한다.
function manualTimer() {
  let queued = null;
  return {
    setTimer(fn) { queued = fn; return 1; },
    clearTimer() { queued = null; },
    fire() { const fn = queued; queued = null; if (fn) fn(); },
    pending() { return queued != null; },
  };
}

test('R-25 RG-2 — 비보류 request → 타이머 발화 시 flush 1회', () => {
  const mt = manualTimer();
  let flushes = 0;
  const c = createCoalescer({
    isDeferred: () => false,
    flush: () => { flushes++; },
    setTimer: mt.setTimer, clearTimer: mt.clearTimer,
  });
  c.request();
  assert.strictEqual(flushes, 0, '발화 전엔 flush 안 함');
  mt.fire();
  assert.strictEqual(flushes, 1, '발화 시 1회 flush');
  assert.strictEqual(c.hasPending(), false, 'flush 후 pending 소비');
});

test('R-25 RG-2 — 보류 중 request 는 flush 안 하고 pending 만 적재', () => {
  const mt = manualTimer();
  let flushes = 0;
  const c = createCoalescer({
    isDeferred: () => true,
    flush: () => { flushes++; },
    setTimer: mt.setTimer, clearTimer: mt.clearTimer,
  });
  c.request();
  c.request();
  c.request();
  assert.strictEqual(flushes, 0, '보류 중엔 발화 0');
  assert.strictEqual(mt.pending(), false, '보류 중엔 타이머 예약 안 함');
  assert.strictEqual(c.hasPending(), true, 'pending 적재됨');
});

test('R-25 RG-2 — request×N(보류) 후 flushIfPending 은 정확히 1회만', () => {
  let deferred = true;
  let flushes = 0;
  const c = createCoalescer({
    isDeferred: () => deferred,
    flush: () => { flushes++; },
    setTimer: () => 1, clearTimer: () => {},
  });
  c.request(); c.request(); c.request(); // 보류 중 3회 누적(단조 boolean)
  deferred = false;                      // 보류 해제
  c.flushIfPending();
  assert.strictEqual(flushes, 1, '누적 3회여도 flush 1회');
  c.flushIfPending();                    // 재호출
  assert.strictEqual(flushes, 1, '소비 후 재호출은 발화 0');
});

test('R-25 RG-2 — 발화 콜백이 deferred 재검사: 발화 직전 보류 시작이면 mark 유지·발화 취소', () => {
  const mt = manualTimer();
  let deferred = false;
  let flushes = 0;
  const c = createCoalescer({
    isDeferred: () => deferred,
    flush: () => { flushes++; },
    setTimer: mt.setTimer, clearTimer: mt.clearTimer,
  });
  c.request();          // 비보류로 타이머 예약
  deferred = true;      // 발화 직전 보류 시작(IME 조합 등)
  mt.fire();            // 타이머 발화 → 재검사로 발화 취소
  assert.strictEqual(flushes, 0, '발화 시점 보류면 flush 안 함');
  assert.strictEqual(c.hasPending(), true, 'pending 유지(나중에 반영)');
  deferred = false;     // 보류 해제
  c.flushIfPending();
  assert.strictEqual(flushes, 1, '해제 후 1회 반영');
});

test('R-25 RG-2 — 다중 보류 동시: 하나 풀려도 다른 사유 남으면 발화 안 함(마지막 해제자만 1회)', () => {
  // 두 보류 사유 A·B 를 모사. deferred = A || B.
  let A = true, B = true;
  let flushes = 0;
  const c = createCoalescer({
    isDeferred: () => (A || B),
    flush: () => { flushes++; },
    setTimer: () => 1, clearTimer: () => {},
  });
  c.request();            // 보류 중 갱신 도착
  A = false;              // A 해제 — 그러나 B 가 남음
  c.flushIfPending();
  assert.strictEqual(flushes, 0, 'B 가 남아 발화 안 함');
  B = false;              // B 도 해제(마지막 해제자)
  c.flushIfPending();
  assert.strictEqual(flushes, 1, '모든 보류 해제 시 1회 발화');
});

test('R-25 RG-2 — 중복 request 는 타이머 재예약하지 않음(단일 타이머)', () => {
  let setCalls = 0;
  const c = createCoalescer({
    isDeferred: () => false,
    flush: () => {},
    setTimer: () => { setCalls++; return 1; },
    clearTimer: () => {},
  });
  c.request();
  c.request();
  c.request();
  assert.strictEqual(setCalls, 1, '예약 중엔 재예약 안 함');
});

test('R-25 RG-2 — pending 없으면 flushIfPending 은 무발화', () => {
  let flushes = 0;
  const c = createCoalescer({
    isDeferred: () => false,
    flush: () => { flushes++; },
    setTimer: () => 1, clearTimer: () => {},
  });
  c.flushIfPending();
  assert.strictEqual(flushes, 0);
});

// ── D-3: 동형 계약 불변식 ─────────────────────────────────────────────────
// renderGuard.js(정본)와 public/app.js 의 _coalescer 는 require 불가(번들러/nodeIntegration 부재,
//   ADR-M9-1)라 동형 복제다. 아래는 app.js _coalescer 도 반드시 만족해야 하는 불변식을 명문화한
//   "동치 계약" — 정본이 이 불변식을 통과하면 app.js 도 같은 알고리즘이어야 한다(코드리뷰 체크리스트).
test('R-25 D-3 동치계약 — pending 단조성: 보류 중 N회 request 는 누적이 아니라 boolean(해제 후 1회만)', () => {
  let deferred = true, flushes = 0;
  const c = createCoalescer({
    isDeferred: () => deferred, flush: () => { flushes++; },
    setTimer: () => 1, clearTimer: () => {},
  });
  for (let i = 0; i < 10; i++) c.request(); // 10회 누적
  deferred = false;
  c.flushIfPending();
  assert.strictEqual(flushes, 1, 'pending 은 단조 boolean → 정확히 1회');
});

test('R-25 D-3 동치계약 — 발화 순서: request(보류)는 즉시 flush 금지, 해제 지점에서만 flush', () => {
  const order = [];
  let deferred = true;
  const c = createCoalescer({
    isDeferred: () => deferred,
    flush: () => { order.push('flush'); },
    setTimer: () => 1, clearTimer: () => {},
  });
  c.request(); order.push('request');
  assert.deepStrictEqual(order, ['request'], '보류 중 request 는 flush 선행 금지');
  deferred = false;
  c.flushIfPending();
  assert.deepStrictEqual(order, ['request', 'flush'], '해제 후에야 flush');
});

test('R-25 D-3 동치계약 — 다중 보류 단일 발화 책임: 마지막 해제자만 flush(앞선 해제는 no-op)', () => {
  let A = true, B = true, flushes = 0;
  const c = createCoalescer({
    isDeferred: () => (A || B), flush: () => { flushes++; },
    setTimer: () => 1, clearTimer: () => {},
  });
  c.request();
  A = false; c.flushIfPending(); // B 남음
  assert.strictEqual(flushes, 0);
  B = false; c.flushIfPending(); // 마지막 해제자
  assert.strictEqual(flushes, 1, '단일 발화 책임 — 마지막 해제자만');
});

// ── R-26: IME 조합 시나리오(자모 분리 차단)를 coalescer 레벨로 모델링 ──────────
// 프로젝트 대시보드 검색창: composing=true 동안 input 마다 request() 가 와도 render(=노드 교체)가
//   일어나지 않아야 조합이 안 깨진다. compositionend(composing=false) 에서 정확히 1회 반영.
//   isDeferred 를 store._composing 미러로 주입해 실제 app.js 게이트와 동형 검증.
test('R-26 — 한글 조합 중(composing) 입력은 render 보류, compositionend 시 1회만 반영', () => {
  let composing = false;
  let renders = 0;
  const c = createCoalescer({
    isDeferred: () => composing,          // app.js: deferred() 의 composing 플래그에 해당
    flush: () => { renders++; },          // app.js: render()
    setTimer: () => 1, clearTimer: () => {}, // 타이머 무력화 — 발화는 flushIfPending 으로만
  });
  // compositionstart
  composing = true;
  // "ㅍ"→"프"→"로"… 조합 중 input 이벤트 5회(매번 store.state.search 갱신 + request)
  for (let i = 0; i < 5; i++) c.request();
  assert.strictEqual(renders, 0, '조합 중에는 render 0회(노드 교체 없음 → 자모 안 깨짐)');
  // compositionend → composing=false + flushIfPending
  composing = false;
  c.flushIfPending();
  assert.strictEqual(renders, 1, 'compositionend 에서 정확히 1회 반영');
});

test('R-26 — 영문 입력(조합 없음)은 보류 없이 디바운스 1회 발화(회귀 0)', () => {
  const mt = manualTimer();
  let renders = 0;
  const c = createCoalescer({
    isDeferred: () => false,              // 영문은 composing 안 뜸 → deferred=false
    flush: () => { renders++; },
    setTimer: mt.setTimer, clearTimer: mt.clearTimer,
  });
  c.request(); c.request(); c.request();  // 빠른 타이핑 3타 — 단일 타이머로 합쳐짐
  assert.strictEqual(renders, 0, '디바운스 창 안에서는 발화 0');
  mt.fire();                              // 120ms 경과
  assert.strictEqual(renders, 1, '영문은 기존과 동일하게 디바운스 1회 render');
});

test('R-26 — 라이브 push 가 조합 중 도착해도 보류(input 노드 교체 0), 조합 종료 후 1회 반영', () => {
  let composing = true;                   // 사용자가 한글 조합 중
  let renders = 0;
  const c = createCoalescer({
    isDeferred: () => composing,
    flush: () => { renders++; },
    setTimer: () => 1, clearTimer: () => {},
  });
  c.request();                            // applyProjectsUpdate → coalesce.request()
  assert.strictEqual(renders, 0, '조합 중 push 는 render 안 함 → 검색 input 안 깨짐');
  composing = false;                      // compositionend
  c.flushIfPending();
  assert.strictEqual(renders, 1, '조합 종료 후 누적 push 1회 반영');
});
