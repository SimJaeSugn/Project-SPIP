'use strict';
/**
 * electron/ipc/insights.js — 홈 브리핑 인사이트 IPC
 *
 *   spip:getCommitActivity → 등록 프로젝트(스냅샷)들의 최근 14일 커밋 빈도를 합산한 일별 시계열.
 *
 * 보안:
 *   · 각 프로젝트 경로를 pathGuard.canonicalize로 재해석(H-1) 후에만 수집. 소멸/이탈(null) 건너뜀.
 *   · 수집은 commitActivity(safeExec 절대경로 git -C <path>, H-2) — 읽기 전용.
 *   · 저장소 수 상한(MAX_REPOS)으로 과도 git 호출 방지.
 *
 * [헤드리스 검증, F-3] Electron API 미import. store·canonicalize·collect·nowMs를 ctx로 주입 가능.
 *
 * 외부 의존성 0 — 내부(commitActivity, pathGuard).
 */

const commitActivity = require('../../lib/scan/collectors/commitActivity');
const pathGuard = require('../../lib/common/pathGuard');

const MAX_REPOS = 100;
const DEFAULT_DAYS = 14;

/**
 * spip:getCommitActivity — 스냅샷 프로젝트들의 최근 N일 커밋 빈도 합산.
 * @param {object} ctx { store, config, logger, canonicalize?, collectCommitActivity?, nowMs? }
 * @returns {Promise<{ok:true, days:Array<{date,count}>, total:number, repos:number, scanned:number}>}
 */
async function getCommitActivity(ctx) {
  ctx = ctx || {};
  const store = ctx.store;
  const projects = (store && typeof store.getProjects === 'function') ? store.getProjects() : [];
  const canonicalize = (typeof ctx.canonicalize === 'function') ? ctx.canonicalize : pathGuard.canonicalize;
  const collect = (typeof ctx.collectCommitActivity === 'function')
    ? ctx.collectCommitActivity
    : ((p) => commitActivity.collect(p, { config: ctx.config, logger: ctx.logger, days: DEFAULT_DAYS }));
  const nowMs = (typeof ctx.nowMs === 'function') ? ctx.nowMs() : Date.now();

  const allDates = [];
  let repos = 0;
  let scanned = 0;
  for (const p of (Array.isArray(projects) ? projects.slice(0, MAX_REPOS) : [])) {
    if (!p || typeof p.path !== 'string') continue;
    const real = canonicalize(p.path);
    if (!real) continue; // 소멸/이탈(H-1)
    scanned += 1;
    let res;
    try { res = await collect(real); } catch (_) { continue; }
    if (res && res.ok && Array.isArray(res.dates) && res.dates.length) {
      repos += 1;
      for (const d of res.dates) allDates.push(d);
    }
  }
  return {
    ok: true,
    days: commitActivity.buildDailySeries(allDates, DEFAULT_DAYS, nowMs),
    total: allDates.length,
    repos,
    scanned,
  };
}

module.exports = { getCommitActivity, MAX_REPOS, DEFAULT_DAYS };
