'use strict';
/**
 * lib/shelf/scheduler.js — 셸프 자동 재크롤 스케줄러 (SH-4)
 *
 * 6시간 주기로 url 북마크를 재크롤한다(기본 ON + 끄기 토글, config.shelfAutoRefresh). 앱 실행 중에만
 * 동작(main 생명주기). 위협모델 게이트:
 *   - D-SCHED-1(높음): 토글 off면 tick 진입 즉시 return — 어떤 네트워크 호출도 없음(egress 0).
 *   - D-SCHED-2(중): elevated 세션이면 스킵(imageCache write 보류와 정합). 앱 시작 직후 즉시 tick 금지(첫 tick 지연).
 *   - D-RES-4(중): 실제 동시 크롤 상한은 urlMeta 전역 세마포어가 보장(수동/자동 공유). 본 모듈은 트리거만.
 *
 * 모든 의존(refresh·listBookmarks·broadcast·isEnabled·isElevated·getCtx)은 주입 — 헤드리스 단위테스트.
 * 외부 의존성 0 — 타이머만.
 */

const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6시간(PM #1)
const DEFAULT_FIRST_DELAY_MS = 5 * 60 * 1000;   // 앱 시작 직후 즉시 실행 금지 — 첫 tick 지연

/**
 * @param {object} opts
 *   - intervalMs, firstDelayMs
 *   - isEnabled():boolean   토글(config.shelfAutoRefresh) — false면 tick 무동작(D-SCHED-1)
 *   - isElevated():boolean  상승세션 — true면 스킵(D-SCHED-2)
 *   - getCtx():object       refresh/listBookmarks에 넘길 ctx(config·uiStatePath·deps 등)
 *   - listBookmarks(ctx):Array  현재 북마크(url만 추려 재크롤)
 *   - refresh(id, ctx):Promise<{ok}>  단건 재크롤·영속(shelfIpc.refresh)
 *   - broadcast():void      변경 발생 시 spip:shelf:changed push
 *   - logger
 */
function createShelfScheduler(opts) {
  opts = opts || {};
  const intervalMs = (typeof opts.intervalMs === 'number' && opts.intervalMs > 0) ? opts.intervalMs : DEFAULT_INTERVAL_MS;
  const firstDelayMs = (typeof opts.firstDelayMs === 'number' && opts.firstDelayMs >= 0) ? opts.firstDelayMs : DEFAULT_FIRST_DELAY_MS;
  const isEnabled = typeof opts.isEnabled === 'function' ? opts.isEnabled : () => true;
  const isElevated = typeof opts.isElevated === 'function' ? opts.isElevated : () => false;
  const getCtx = typeof opts.getCtx === 'function' ? opts.getCtx : () => ({});
  const listBookmarks = typeof opts.listBookmarks === 'function' ? opts.listBookmarks : () => [];
  const refresh = typeof opts.refresh === 'function' ? opts.refresh : null;
  const broadcast = typeof opts.broadcast === 'function' ? opts.broadcast : () => {};
  const logger = opts.logger;

  let interval = null;
  let firstTimer = null;
  let stopped = true;
  let running = false;

  /** url 북마크를 재크롤하고, 하나라도 갱신되면 broadcast. */
  async function runBatch() {
    const ctx = getCtx() || {};
    let bookmarks = [];
    try { bookmarks = listBookmarks(ctx) || []; } catch (_) { bookmarks = []; }
    const urlIds = bookmarks
      .filter((b) => b && b.type === 'url' && typeof b.id === 'string')
      .map((b) => b.id);
    if (urlIds.length === 0 || !refresh) return false;

    // 전부 트리거(동시 상한은 urlMeta 세마포어가 보장 — D-RES-4 공유).
    const results = await Promise.all(urlIds.map(async (id) => {
      try { const r = await refresh(id, ctx); return !!(r && r.ok); } catch (_) { return false; }
    }));
    const changed = results.some(Boolean);
    if (changed) { try { broadcast(); } catch (_) { /* noop */ } }
    return changed;
  }

  /** 한 tick. 게이트(정지/중복/토글/상승)를 통과해야만 네트워크 동작. */
  async function tick() {
    if (stopped) return false;        // 정지됨
    if (running) return false;        // 직전 tick 진행 중 — 중복 방지
    if (!isEnabled()) return false;   // D-SCHED-1: 토글 off → egress 0(네트워크 호출 0)
    if (isElevated()) return false;   // D-SCHED-2: 상승세션 스킵
    running = true;
    try {
      return await runBatch();
    } catch (err) {
      if (logger) logger.warn('셸프 자동 재크롤 tick 실패');
      return false;
    } finally {
      running = false;
    }
  }

  function start() {
    if (!stopped) return;
    stopped = false;
    // 첫 tick은 firstDelayMs 후(부팅 지연 회피), 이후 intervalMs 주기.
    firstTimer = setTimeout(() => {
      firstTimer = null;
      tick();
      interval = setInterval(tick, intervalMs);
      if (interval && typeof interval.unref === 'function') interval.unref();
    }, firstDelayMs);
    if (firstTimer && typeof firstTimer.unref === 'function') firstTimer.unref();
  }

  function stop() {
    stopped = true;
    if (firstTimer) { clearTimeout(firstTimer); firstTimer = null; }
    if (interval) { clearInterval(interval); interval = null; }
  }

  return { start, stop, tick, runBatch, isRunning: () => running, isStopped: () => stopped };
}

module.exports = { createShelfScheduler, DEFAULT_INTERVAL_MS, DEFAULT_FIRST_DELAY_MS };
