'use strict';
/**
 * lib/common/safeExec.js — 외부 프로세스 안전 실행 (N-03, H-2, M-4, ADR-002)
 *
 * S0 범위: resolveBin(name)의 핵심 로직 + safeExec(absBin,args,opts)의 시그니처/
 *   구조(shell:false·인자배열·타임아웃·강제 kill·출력버퍼 상한·in-flight 상한).
 *   실제 git/code 호출 실측·검증은 S2/S5에서 한다.
 *
 * [H-2 핵심] 실행 파일은 기동/스캔 시작 시 절대경로로 "1회" 해석해 고정한다.
 *   - PATH의 각 디렉터리를 순회하며 실행 가능한 절대경로를 직접 찾는다(외부 명령
 *     의존 없이 fs로 탐색 → ADR-001 의존성 0).
 *   - Windows에서는 PATHEXT 중 ".exe"만 허용하고 .bat/.cmd 자동 확장을 차단한다
 *     (PATHEXT 기반 배치 스크립트 실행으로 인한 RCE 표면 제거).
 *   - 부분신뢰 cwd(projectPath) 내 위장 바이너리가 선택되지 않도록, 탐색 베이스는
 *     항상 신뢰 PATH이며 cwd(".")는 탐색 대상에서 제외한다.
 *
 * [M-4] safeExec은 timeout(초과 시 SIGKILL)·maxBuffer(출력 상한)를 강제하고,
 *   호출자 키 기준 in-flight 상한으로 중복 spawn을 차단한다.
 *
 * 외부 의존성 0 — child_process, fs, path, os만 사용.
 */

const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');

const IS_WIN = process.platform === 'win32';

// Windows에서 허용하는 실행 확장자. 배치(.bat/.cmd)·기타는 차단(H-2).
const ALLOWED_WIN_EXTS = ['.exe'];

// M-4 기본 한도.
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_MAX_BUFFER = 1024 * 1024; // 1MB
const DEFAULT_MAX_INFLIGHT = 4;

// resolveBin 결과 캐시(1회 해석·고정). name -> absPath|null
const _binCache = new Map();

// in-flight 카운터(키별). key -> count
const _inflight = new Map();

/**
 * 후보 파일이 실제 실행 가능한 일반 파일인지 검사한다.
 * @param {string} p 절대경로
 * @returns {boolean}
 */
function isExecutableFile(p) {
  try {
    const st = fs.statSync(p);
    return st.isFile();
  } catch (_) {
    return false;
  }
}

/**
 * Windows에서 name에 붙일 확장자 후보를 만든다.
 * 이미 .exe 등 허용 확장자가 붙어 있으면 그대로, 아니면 ALLOWED_WIN_EXTS만 시도.
 * .bat/.cmd는 의도적으로 제외한다(H-2).
 */
function winCandidates(name) {
  const ext = path.extname(name).toLowerCase();
  if (ext && ALLOWED_WIN_EXTS.includes(ext)) return [name];
  if (ext) return []; // .bat/.cmd 등 비허용 확장자가 명시되면 후보 없음
  return ALLOWED_WIN_EXTS.map((e) => name + e);
}

/**
 * 실행 파일명을 신뢰 PATH 기준 절대경로로 1회 해석해 고정한다(H-2).
 * @param {string} name 'git' | 'code' 등
 * @param {object} [opts] { force?:boolean } force=true면 캐시 무시 재해석
 * @returns {string|null} 절대경로 또는 미발견 시 null
 */
function resolveBin(name, opts) {
  opts = opts || {};
  if (!opts.force && _binCache.has(name)) return _binCache.get(name);

  let resolved = null;

  // name이 이미 절대경로면 직접 검증만 한다.
  if (path.isAbsolute(name)) {
    if (IS_WIN) {
      const ext = path.extname(name).toLowerCase();
      if (ALLOWED_WIN_EXTS.includes(ext) && isExecutableFile(name)) resolved = name;
    } else if (isExecutableFile(name)) {
      resolved = name;
    }
    _binCache.set(name, resolved);
    return resolved;
  }

  const pathEnv = process.env.PATH || process.env.Path || '';
  const dirs = pathEnv.split(path.delimiter).filter((d) => d && d.trim());

  outer: for (const dir of dirs) {
    // cwd(".")·빈 항목은 신뢰 PATH가 아니므로 제외(H-2: 위장 바이너리 차단).
    if (dir === '.' || dir === '') continue;
    const base = path.resolve(dir);

    const candidates = IS_WIN ? winCandidates(name) : [name];
    for (const cand of candidates) {
      const full = path.join(base, cand);
      if (isExecutableFile(full)) {
        resolved = full;
        break outer;
      }
    }
  }

  _binCache.set(name, resolved);
  return resolved;
}

/** 테스트/재기동용 캐시 초기화. */
function _clearBinCache() {
  _binCache.clear();
}

/**
 * 절대경로 실행 파일을 안전하게 실행한다(spawn shell:false). (N-03·H-2·M-4)
 *
 * S0에서는 인터페이스·구조를 확정한다. 실제 git/code 실측은 S2/S5.
 *
 * @param {string} absBin 실행 파일 절대경로(resolveBin 결과). 상대경로면 거부.
 * @param {string[]} args 인자 배열(셸 문자열 연결 금지).
 * @param {object} [opts] { cwd, timeoutMs, maxBuffer, inflightKey, maxInflight, env, detached }
 *   detached=true: "fire-and-forget" 모드(P2-3). child 'spawn' 이벤트(또는 즉시)에서
 *     {spawned:true}로 resolve하고 프로세스 종료(close)를 기다리지 않는다. 자식을 unref하여
 *     부모(서버) 이벤트 루프를 잡지 않게 분리하고, stdout/stderr는 수집하지 않는다(파이프 미연결).
 *     spawn 실패(ENOENT 등)는 'error'로 reject되어 호출자가 CODE_CLI_NOT_FOUND/OPEN_FAILED로 구분.
 *     /api/open(R-12·2초 피드백)처럼 시작 성공만 확인하면 되는 경로용. git collector 등
 *     출력이 필요한 경로는 기본(detached=false) close-기반 동작을 그대로 사용한다.
 * @returns {Promise<{code:number|null, stdout:string, stderr:string, timedOut:boolean}|{spawned:true, pid:number|undefined}>}
 */
function safeExec(absBin, args, opts) {
  opts = opts || {};
  args = Array.isArray(args) ? args : [];

  return new Promise((resolve, reject) => {
    // 절대경로 강제(H-2): resolveBin을 거치지 않은 상대경로 실행을 거부.
    if (typeof absBin !== 'string' || !path.isAbsolute(absBin)) {
      reject(new Error('safeExec: absBin must be an absolute path (use resolveBin)'));
      return;
    }
    if (IS_WIN) {
      const ext = path.extname(absBin).toLowerCase();
      if (!ALLOWED_WIN_EXTS.includes(ext)) {
        reject(new Error('safeExec: only .exe is allowed on Windows (no .bat/.cmd)'));
        return;
      }
    }

    // 인자는 반드시 문자열 배열.
    if (!args.every((a) => typeof a === 'string')) {
      reject(new Error('safeExec: all args must be strings'));
      return;
    }

    const timeoutMs = typeof opts.timeoutMs === 'number' ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
    const maxBuffer = typeof opts.maxBuffer === 'number' ? opts.maxBuffer : DEFAULT_MAX_BUFFER;
    const maxInflight = typeof opts.maxInflight === 'number' ? opts.maxInflight : DEFAULT_MAX_INFLIGHT;
    const inflightKey = opts.inflightKey || absBin;
    const detached = !!opts.detached; // P2-3: spawn 시작 성공만 확인하는 fire-and-forget 모드

    // M-4: id/키별 in-flight 상한으로 중복 spawn 차단.
    const current = _inflight.get(inflightKey) || 0;
    if (current >= maxInflight) {
      reject(new Error('safeExec: in-flight limit reached for ' + inflightKey));
      return;
    }
    _inflight.set(inflightKey, current + 1);

    const release = () => {
      const c = (_inflight.get(inflightKey) || 1) - 1;
      if (c <= 0) _inflight.delete(inflightKey);
      else _inflight.set(inflightKey, c);
    };

    let child;
    try {
      child = childProcess.spawn(absBin, args, {
        cwd: opts.cwd,
        env: opts.env || process.env,
        shell: false, // N-03 필수: 셸 해석 금지
        windowsHide: true,
        // detached 모드: 자식을 부모 프로세스 그룹에서 분리해 서버 종료와 독립 실행.
        // stdio는 'ignore'로 파이프를 만들지 않아 출력 버퍼·핸들 누수가 없다.
        detached: detached,
        stdio: detached ? 'ignore' : 'pipe',
      });
    } catch (err) {
      release();
      reject(err);
      return;
    }

    let settled = false;

    // detached(fire-and-forget) 모드: spawn 시작 성공만 확인하고 즉시 정산(P2-3).
    //   - 'spawn' 이벤트(성공)에서 resolve, 'error'(ENOENT 등 spawn 실패)에서 reject.
    //   - 프로세스 종료(close)를 기다리지 않으며, 자식을 unref해 부모 이벤트 루프를 잡지 않는다.
    //   - in-flight 카운터는 정산 시점에 즉시 해제(시작만 확인하므로 점유 지속 불필요).
    if (detached) {
      const finishDetached = (result, err) => {
        if (settled) return;
        settled = true;
        release();
        if (err) reject(err);
        else resolve(result);
      };
      child.on('error', (err) => finishDetached(null, err));
      child.on('spawn', () => {
        try { child.unref(); } catch (_) { /* noop */ }
        finishDetached({ spawned: true, pid: child.pid });
      });
      return;
    }

    let stdout = '';
    let stderr = '';
    let outBytes = 0;
    let errBytes = 0;
    let timedOut = false;

    const killTimer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch (_) { /* noop */ }
    }, timeoutMs);

    const finish = (result, err) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      release();
      if (err) reject(err);
      else resolve(result);
    };

    if (child.stdout) {
      child.stdout.on('data', (chunk) => {
        outBytes += chunk.length;
        if (outBytes <= maxBuffer) stdout += chunk.toString('utf8');
        else { try { child.kill('SIGKILL'); } catch (_) { /* noop */ } }
      });
    }
    if (child.stderr) {
      child.stderr.on('data', (chunk) => {
        errBytes += chunk.length;
        // P2-2: stderr도 stdout과 대칭으로 상한 초과 시 kill(메모리·자원 누수 방지).
        if (errBytes <= maxBuffer) stderr += chunk.toString('utf8');
        else { try { child.kill('SIGKILL'); } catch (_) { /* noop */ } }
      });
    }

    child.on('error', (err) => finish(null, err));
    child.on('close', (code) => finish({ code, stdout, stderr, timedOut }));
  });
}

module.exports = {
  resolveBin,
  safeExec,
  _clearBinCache,
  isExecutableFile,
  ALLOWED_WIN_EXTS,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_BUFFER,
  DEFAULT_MAX_INFLIGHT,
};
