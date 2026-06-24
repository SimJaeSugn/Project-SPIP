'use strict';
/**
 * lib/scan/collectors/git.js — git 상태 수집 (R-08, R-13, 보안 H-2·M-4, ADR-002)
 *
 * git CLI를 safeExec로 호출해 저장소 여부·브랜치·미커밋 변경·ahead/behind를 수집한다.
 * 읽기 전용 — 커밋/푸시 등 쓰기는 절대 하지 않는다(§9.1 Won't).
 *
 * [H-2] git 실행 파일은 resolveBin('git')으로 신뢰 PATH 기준 절대경로를 1회 해석해 고정한다.
 *   호출은 항상 `git -C <projectPath> ...` 형태로 cwd 의존을 제거한다 → 부분신뢰 폴더(TB-B)
 *   내에 심어진 위장 git.exe/git.bat가 선택되어 RCE로 이어지는 경로를 차단한다.
 *   Windows .bat/.cmd 자동 확장은 safeExec가 차단(.exe만 허용).
 * [M-4] safeExec의 타임아웃(초과 시 SIGKILL)·출력 버퍼 상한·in-flight 상한을 적용한다.
 * [R-13] git 미설치/비저장소/타임아웃 → status:'na'로 graceful 반환(크래시 0).
 *
 * collect는 비동기다(safeExec가 Promise). 수집기 계약의 collect()를 async로 구현한다.
 *
 * 외부 의존성 0 — 내부(safeExec, logger) + path만.
 */

const path = require('path');
const safeExec = require('../../common/safeExec');
const { clampString } = require('../../common/logger'); // P2-3: 핫패스 인라인 require 제거(순환 없음)

const GIT_TIMEOUT_MS = 5000;
const GIT_MAX_BUFFER = 512 * 1024;
const GIT_MAX_INFLIGHT = 4;

/**
 * git 실행 파일 절대경로를 1회 해석해 고정한다(H-2). 미설치면 null.
 * @returns {string|null}
 */
function resolveGit() {
  return safeExec.resolveBin('git');
}

/**
 * git 하위명령을 -C <path>로 실행한다(cwd 의존 제거, H-2).
 * @returns {Promise<{ok:boolean, stdout:string, timedOut:boolean}>}
 */
async function runGit(gitBin, projectPath, args) {
  const fullArgs = ['-C', projectPath].concat(args);
  try {
    const res = await safeExec.safeExec(gitBin, fullArgs, {
      timeoutMs: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
      inflightKey: 'git',
      maxInflight: GIT_MAX_INFLIGHT,
      // cwd 미지정(혹은 projectPath여도 절대경로 git이라 위장 미선택). -C로 대상 고정.
    });
    return {
      ok: res.code === 0 && !res.timedOut,
      stdout: res.stdout || '',
      timedOut: !!res.timedOut,
    };
  } catch (_) {
    return { ok: false, stdout: '', timedOut: false };
  }
}

/**
 * `git status -b --porcelain=v1` 출력에서 브랜치·dirty·ahead/behind를 파싱한다.
 * 정규식은 선형(고정 패턴)으로 ReDoS 없음. 입력은 safeExec maxBuffer로 이미 상한.
 * @param {string} stdout
 * @returns {{ branch:string|null, dirty:boolean, ahead:number, behind:number }}
 */
function parseStatus(stdout) {
  const out = { branch: null, dirty: false, ahead: 0, behind: 0, changes: 0 };
  const lines = stdout.split('\n');
  let fileChangeLines = 0;
  for (const line of lines) {
    if (line.startsWith('## ')) {
      // 예: "## main...origin/main [ahead 1, behind 2]"
      const header = line.slice(3);
      // 브랜치명: '...' 또는 공백 전까지.
      const branchPart = header.split(' ')[0];
      const branch = branchPart.split('...')[0];
      if (branch && branch !== 'HEAD' && !branch.startsWith('(no')) out.branch = branch;
      const aheadM = header.match(/ahead (\d+)/);
      const behindM = header.match(/behind (\d+)/);
      if (aheadM) out.ahead = parseInt(aheadM[1], 10) || 0;
      if (behindM) out.behind = parseInt(behindM[1], 10) || 0;
    } else if (line.trim().length > 0) {
      fileChangeLines++;
    }
  }
  out.dirty = fileChangeLines > 0;
  out.changes = fileChangeLines; // 미커밋 변경 파일 수(badge "미커밋 N"용)
  return out;
}

/**
 * git 상태 수집(R-08). 미설치/비저장소/타임아웃은 status:'na'(R-13).
 * @param {string} projectPath canonical 실경로
 * @param {object} ctx { config, signals, logger, limits }
 * @returns {Promise<{ ok, data, status, note }>}
 */
async function collect(projectPath, ctx) {
  ctx = ctx || {};
  const naResult = (note) => ({
    ok: true,
    data: { status: 'na', isRepo: false, branch: null, dirty: null, ahead: null, behind: null, lastCommit: null },
    status: 'na',
    note: note || null,
  });

  const gitBin = resolveGit();
  if (!gitBin) {
    return naResult('git 미설치');
  }

  // 저장소 여부 확인(-C로 대상 고정, cwd 의존 제거).
  const isRepoRes = await runGit(gitBin, projectPath, ['rev-parse', '--is-inside-work-tree']);
  if (!isRepoRes.ok || isRepoRes.stdout.trim() !== 'true') {
    return naResult(isRepoRes.timedOut ? 'git 응답 시간 초과' : '비저장소');
  }

  // 상태 + 최근 커밋 시각.
  const statusRes = await runGit(gitBin, projectPath, ['status', '-b', '--porcelain=v1']);
  if (!statusRes.ok) {
    return naResult(statusRes.timedOut ? 'git 응답 시간 초과' : 'git status 실패');
  }
  const parsed = parseStatus(statusRes.stdout);

  // 최근 커밋 시각(ISO). 커밋이 없으면 빈 출력.
  let lastCommit = null;
  const logRes = await runGit(gitBin, projectPath, ['log', '-1', '--format=%cI']);
  if (logRes.ok) {
    const t = logRes.stdout.trim();
    if (t && !Number.isNaN(Date.parse(t))) lastCommit = new Date(t).toISOString();
  }

  // 브랜치명 문자열 정제(L-1: 제어문자 제거·길이 절단).
  let branch = parsed.branch;
  if (typeof branch === 'string') {
    const max = (ctx.limits && ctx.limits.maxStringField) || 1000;
    branch = clampString(branch, max);
  }

  return {
    ok: true,
    data: {
      status: 'ok',
      isRepo: true,
      branch: branch || null,
      dirty: parsed.dirty,
      ahead: parsed.ahead,
      behind: parsed.behind,
      changes: parsed.changes,
      lastCommit,
    },
    status: 'ok',
    note: null,
  };
}

module.exports = { name: 'git', mvp: true, collect, parseStatus, resolveGit, GIT_TIMEOUT_MS };
