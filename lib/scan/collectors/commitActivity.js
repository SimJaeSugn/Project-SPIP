'use strict';
/**
 * lib/scan/collectors/commitActivity.js — 최근 커밋 빈도 수집(홈 생산성 차트용) (보안 H-1/H-2/M-4)
 *
 * `git -C <path> log --since="<N> days ago" --date=short --pretty=%cd`로 최근 N일 커밋 날짜를
 * 수집한다. 읽기 전용(§9.1 Won't). git 실행 파일은 resolveBin('git') 절대경로로 1회 고정(H-2),
 * 호출은 항상 `-C <path>`로 cwd 의존 제거(위장 git.exe 차단). safeExec 타임아웃·버퍼·in-flight 상한.
 *
 * 검증/집계 로직(parseCommitDates·buildDailySeries)은 순수 함수로 분리해 헤드리스 단위테스트한다.
 *
 * 외부 의존성 0 — 내부(safeExec) + 주입 가능 deps.
 */

const safeExec = require('../../common/safeExec');

const GIT_TIMEOUT_MS = 5000;
const GIT_MAX_BUFFER = 256 * 1024;
const GIT_MAX_INFLIGHT = 4;
const DEFAULT_DAYS = 14;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function resolveGit() { return safeExec.resolveBin('git'); }

/** 로컬 날짜 → 'YYYY-MM-DD'. */
function fmtLocalDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + day;
}

/** git log 출력(한 줄당 YYYY-MM-DD)에서 유효 날짜만 추출(순수). */
function parseCommitDates(stdout) {
  if (typeof stdout !== 'string') return [];
  const out = [];
  for (const line of stdout.split('\n')) {
    const t = line.trim();
    if (DATE_RE.test(t)) out.push(t);
  }
  return out;
}

/**
 * 날짜 배열을 최근 days일 달력에 0-채움 집계(순수). nowMs 기준 로컬 자정으로 N일.
 * @returns {Array<{date:string, count:number}>} 오래된→최신 순
 */
function buildDailySeries(dates, days, nowMs) {
  const n = (typeof days === 'number' && days > 0) ? Math.min(Math.floor(days), 366) : DEFAULT_DAYS;
  const counts = Object.create(null);
  if (Array.isArray(dates)) for (const d of dates) { if (DATE_RE.test(d)) counts[d] = (counts[d] || 0) + 1; }
  const base = new Date(typeof nowMs === 'number' ? nowMs : Date.now());
  base.setHours(0, 0, 0, 0);
  const series = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(base.getTime());
    d.setDate(d.getDate() - i);
    const key = fmtLocalDate(d);
    series.push({ date: key, count: counts[key] || 0 });
  }
  return series;
}

/** git log를 -C <path>로 실행(deps 주입 가능). */
async function runGitLog(gitBin, projectPath, days) {
  try {
    const res = await safeExec.safeExec(
      gitBin,
      ['-C', projectPath, 'log', '--since=' + days + ' days ago', '--date=short', '--pretty=%cd'],
      { timeoutMs: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER, inflightKey: 'git', maxInflight: GIT_MAX_INFLIGHT }
    );
    return { ok: res.code === 0 && !res.timedOut, stdout: res.stdout || '' };
  } catch (_) {
    return { ok: false, stdout: '' };
  }
}

/**
 * 단일 저장소의 최근 커밋 날짜를 수집. 미설치/비저장소/타임아웃은 {ok:false, dates:[]}(graceful).
 * @param {string} projectPath canonical 실경로
 * @param {object} [ctx] { days?, resolveGit?, runGitLog? } 테스트 주입
 * @returns {Promise<{ok:boolean, dates:string[]}>}
 */
async function collect(projectPath, ctx) {
  ctx = ctx || {};
  const gitBin = ctx.resolveGit ? ctx.resolveGit() : resolveGit();
  if (!gitBin) return { ok: false, dates: [] };
  const days = (typeof ctx.days === 'number' && ctx.days > 0) ? ctx.days : DEFAULT_DAYS;
  const run = ctx.runGitLog ? ctx.runGitLog : runGitLog;
  const res = await run(gitBin, projectPath, days);
  if (!res || !res.ok) return { ok: false, dates: [] };
  return { ok: true, dates: parseCommitDates(res.stdout) };
}

module.exports = {
  name: 'commitActivity',
  collect,
  parseCommitDates,
  buildDailySeries,
  resolveGit,
  fmtLocalDate,
  DEFAULT_DAYS,
  GIT_TIMEOUT_MS,
};
