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
const claudeUsage = require('../../lib/ai/claudeUsage');

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

/**
 * [항목2] spip:getClaudeUsage — Claude Code 로컬 로그(~/.claude/projects/**.jsonl)의 토큰 사용량 집계.
 *   읽기 전용·집계 수치/모델명만 반환(메시지 본문 비노출). 무거운 디스크 스캔이라 렌더러가 수동/지연 호출.
 *   claudeUsage 모듈이 파일수·바이트·줄길이 상한과 줄/파일 단위 오류 격리를 담당. summarize는 throw 안 함.
 * @param {object} ctx { logger, homeDir?, nowMs? }  (테스트용 주입)
 * @returns {{ok:true, available, totals, today, byModel, lastAt, scannedFiles}}
 */
function getClaudeUsage(ctx) {
  ctx = ctx || {};
  const opts = { logger: ctx.logger };
  if (ctx.homeDir) opts.homeDir = ctx.homeDir;
  if (typeof ctx.nowMs === 'function') opts.now = ctx.nowMs;
  let res;
  try {
    res = claudeUsage.summarizeClaudeUsage(opts);
  } catch (_) {
    // 방어적 — summarize는 자체 격리하지만 만일을 대비해 graceful 빈 집계.
    res = { available: false, totals: null, today: null, byModel: [], lastAt: null, scannedFiles: 0 };
  }
  return Object.assign({ ok: true }, res);
}

module.exports = { getCommitActivity, getClaudeUsage, MAX_REPOS, DEFAULT_DAYS };
