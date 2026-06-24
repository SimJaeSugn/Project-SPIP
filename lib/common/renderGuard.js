'use strict';
/**
 * lib/common/renderGuard.js — 부분 갱신/재렌더 가드의 순수 판정 로직 (R-25, RG-1·RG-2)
 *
 * 전체 재렌더(render()=app.replaceChildren()) 아키텍처에서 라이브 갱신이
 *   입력(IME)·드래그·모달·진행 중 fetch 를 파괴하지 않도록 "지금 재렌더를 보류할지"와
 *   "보류 중 누적된 갱신을 정확히 1회 병합"하는 순수 상태기를 제공한다.
 *
 * DOM·타이머·store 미접근(순수). 헤드리스 node:test 로 검증한다.
 *   - 이 파일이 알고리즘 단일 출처(ADR-M9-1, §3.6 안 B). public/app.js 의 RG 는
 *     이 OR식/상태전이를 얇게 동형 복제하는 어댑터일 뿐, 로직은 여기를 정본으로 본다.
 *
 * 마커: RG-1(shouldDeferRender 보류 판정) · RG-2(createCoalescer 동시성 상태기).
 */

/**
 * [RG-1] 현재 상태에서 라이브 갱신/재렌더를 보류해야 하면 true. DOM 미접근.
 *   설계 §3.2 매핑표의 6플래그(composing·dragging·overlayOpen·busyMail·busyCommit·editing)를 OR.
 *   하나라도 true 면 true, 전부 false(또는 인자 부재)면 false.
 * @param {object} f 보류 플래그 모음(각 boolean)
 * @returns {boolean}
 */
function shouldDeferRender(f) {
  return !!(f && (f.composing || f.dragging || f.overlayOpen
              || f.busyMail || f.busyCommit || f.editing));
}

/**
 * [RG-2] 라이브 갱신 coalesce 순수 상태기 + 디바운스/보류 재검사 동시성 계약(§3.5 3규칙).
 *
 * 동시성 계약:
 *   ① request(): pending=true 로 표시하고 타이머 예약(이미 예약돼 있으면 재예약하지 않음).
 *   ② 타이머 발화 시 isDeferred() 재검사 — true 면 flush 하지 않고 보류(pending 유지, 타이머 해제).
 *   ③ flushIfPending(): 보류 해제 지점에서 호출. pending && !isDeferred 면 정확히 1회 flush.
 *      pending 은 단조 boolean(누적 횟수 무관) → 다중 보류 사유가 동시에 풀려도
 *      마지막으로 보류를 모두 해제하는 호출자만 1회 발화(앞선 호출은 isDeferred 재검사로 무시).
 *
 * 타이머는 주입 가능(테스트). 미주입 시 setTimeout/clearTimeout(Node·브라우저 공통) 사용.
 *
 * @param {object} opts
 * @param {number}   [opts.delay=120]      디바운스 창(ms)
 * @param {function} opts.isDeferred       () => boolean. 보류 여부 판정(주입: store 어댑터/테스트).
 * @param {function} opts.flush            () => void. 실제 1회 반영(render 등).
 * @param {function} [opts.setTimer]       (fn, ms) => handle. 테스트용 타이머 주입.
 * @param {function} [opts.clearTimer]     (handle) => void.   테스트용 타이머 해제 주입.
 */
function createCoalescer(opts) {
  opts = opts || {};
  const delay = (typeof opts.delay === 'number' && opts.delay >= 0) ? opts.delay : 120;
  const isDeferred = (typeof opts.isDeferred === 'function') ? opts.isDeferred : function () { return false; };
  const doFlush = (typeof opts.flush === 'function') ? opts.flush : function () {};
  const setTimer = (typeof opts.setTimer === 'function')
    ? opts.setTimer
    : function (fn, ms) { return setTimeout(fn, ms); };
  const clearTimer = (typeof opts.clearTimer === 'function')
    ? opts.clearTimer
    : function (h) { try { clearTimeout(h); } catch (_) { /* ignore */ } };

  let pending = false;   // 단조 boolean: 보류 중 N번 갱신이 와도 true 유지(규칙 ③)
  let timer = null;      // 디바운스 타이머 핸들(중복 예약 방지)

  function cancelTimer() {
    if (timer != null) { clearTimer(timer); timer = null; }
  }

  // 타이머 발화: 보류 중이면 flush 하지 않고 보류 유지(규칙 ②), 아니면 1회 소비 flush.
  function onFire() {
    timer = null;
    if (isDeferred()) return;          // [R2] 발화 직전 보류 시작 → pending 유지, 발화 취소
    if (!pending) return;
    pending = false;                   // 1회 소비
    doFlush();
  }

  return {
    /** 라이브 트리거 진입점. 보류면 큐(pending)만, 비보류면 디바운스 1회 예약(발화 시 재검사). */
    request() {
      pending = true;                  // 어느 경우든 갱신 도착을 기록(보류 해제 시 반영 위해)
      if (isDeferred()) { cancelTimer(); return; } // 보류: 큐에만 적재, 타이머 불요
      if (timer == null) timer = setTimer(onFire, delay); // 이미 예약돼 있으면 재예약 안 함
    },
    /** 보류 해제 지점에서 호출. pending && !isDeferred 면 정확히 1회 flush. */
    flushIfPending() {
      if (!pending) return;
      if (isDeferred()) return;        // [R2] 다른 보류 사유가 남음 → 마지막 해제자만 발화
      cancelTimer();
      pending = false;                 // 1회 소비(단조)
      doFlush();
    },
    /** 현재 보류 누적 여부(테스트/관측용). */
    hasPending() { return pending; },
    /** 진행 중 디바운스 타이머 정리(teardown 등). pending 은 보존. */
    cancel() { cancelTimer(); },
  };
}

module.exports = { shouldDeferRender, createCoalescer };
