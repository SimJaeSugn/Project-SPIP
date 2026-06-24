'use strict';
/**
 * lib/common/elevationGuard.js — 권한 상승(elevated) 세션 판정 (M12 B안 b3)
 *
 * 자동 업데이트가 관리자(elevated) 컨텍스트로 앱을 재실행하면 그 세션의 %APPDATA%가
 *   관리자 프로필을 가리켜 빈 spip 폴더가 보이고(미표시), 그 세션에서 영속 write가 일어나면
 *   관리자 프로필에 새 0600 파일(설정·비밀번호 포함)이 떨어져 오염된다. 본 모듈은 현재
 *   세션이 elevated 인지 "판정만" 한다(부작용 없음 — write·재실행·경고 표시는 호출측 책임).
 *
 * 판정 원칙(설계 §B b3):
 *   · 최종 권위 = SID. whoami /groups 출력에서 High Mandatory Level SID(S-1-16-12288)가
 *     확인된 경우에만 elevated:true. (유일한 차단 근거)
 *   · 휴리스틱은 "검사 트리거"로만. 기대 %APPDATA%(os.homedir 기준) vs 실제 process.env.APPDATA
 *     불일치는 whoami 검사를 유발하는 신호일 뿐, 단독 차단하지 않는다(APPDATA 리다이렉트·
 *     로밍 프로필 false positive 방지).
 *   · 보수적 폴백. whoami 실행/파싱 실패 등 판정 불가 시 비상승(false)으로 간주한다 —
 *     정상 사용자의 가용성·write를 절대 막지 않는다(오탐으로 저장을 막는 쪽이 더 큰 피해).
 *   · win32 외 플랫폼은 항상 false.
 *
 * 보안(H-2, M12-S-01): whoami 는 PATH 검색 금지 — %SystemRoot%\System32\whoami.exe 고정
 *   절대경로를 resolveBin(absPath) 분기로 검증 후 shell:false·인자 ['/groups'] 고정 실행.
 *
 * 외부 의존성 0 — os, path(내장) + 내부(safeExec). detectElevation 은 동기 판정을 위해
 *   safeExec 의 동기 변형 대신 deps 로 주입된 동기 실행기를 쓴다(아래 deps.execGroups).
 */

const os = require('os');
const path = require('path');
const childProcess = require('child_process');
const { resolveBin } = require('./safeExec');

// High Mandatory Level(관리자/상승) integrity SID — 유일한 차단 근거.
const HIGH_ML_SID = 'S-1-16-12288';
// System Mandatory Level(SYSTEM) — High 보다 높음. 상승으로 함께 간주(보수적이지만 SYSTEM 세션도 비정상).
const SYSTEM_ML_SID = 'S-1-16-16384';

/**
 * whoami.exe 고정 절대경로를 해석한다(PATH 검색 금지, H-2/M12-S-01).
 *   %SystemRoot%(없으면 C:\Windows)\System32\whoami.exe 를 resolveBin(absPath) 분기로 검증.
 * @param {object} env process.env 류
 * @returns {string|null} 검증된 절대경로 또는 null
 */
function resolveWhoamiBin(env) {
  const sysRoot = (env && typeof env.SystemRoot === 'string' && env.SystemRoot.trim())
    ? env.SystemRoot
    : 'C:\\Windows';
  const abs = path.join(sysRoot, 'System32', 'whoami.exe');
  // 절대경로 분기(resolveBin): .exe·실존 파일만 통과. PATH 순회 안 함.
  return resolveBin(abs);
}

/**
 * whoami /groups 출력에서 High/SYSTEM Mandatory Level SID 포함 여부를 판정한다.
 * @param {string} stdout
 * @returns {boolean} High ML(또는 그 이상) SID 가 있으면 true
 */
function hasHighIntegritySid(stdout) {
  if (typeof stdout !== 'string' || !stdout) return false;
  return stdout.indexOf(HIGH_ML_SID) !== -1 || stdout.indexOf(SYSTEM_ML_SID) !== -1;
}

/**
 * 기대 %APPDATA%(os.homedir 기준 Roaming) vs 실제 env.APPDATA 불일치 여부 — "검사 트리거"용.
 *   단독 차단 금지(false positive 방지). 판정에 직접 쓰지 않고 whoami 검사를 유발할지에만 쓴다.
 * @param {object} deps { homedir, env }
 * @returns {boolean} 불일치(검사 유발 신호)면 true
 */
function appdataMismatch(deps) {
  const home = (typeof deps.homedir === 'function') ? deps.homedir() : os.homedir();
  const env = deps.env || process.env;
  const actual = (typeof env.APPDATA === 'string' && env.APPDATA.trim()) ? env.APPDATA : null;
  if (!actual) return true; // APPDATA 부재도 검사 유발(비정상 신호)
  const expected = path.join(home, 'AppData', 'Roaming');
  // 대소문자·구분자 차이를 흡수해 비교(Windows 파일시스템 관행).
  const norm = (p) => path.normalize(String(p)).replace(/[\\/]+$/, '').toLowerCase();
  return norm(actual) !== norm(expected);
}

/**
 * whoami.exe /groups 를 동기 실행해 stdout 을 돌려준다(판정용). 실패 시 null(보수적 폴백).
 *   safeExec 규약 준수: 절대경로(resolveBin 검증)·shell:false·인자 ['/groups'] 고정·windowsHide.
 *   동기 실행(execFileSync)이 필요한 이유: onReady 의 1회 동기 판정에 쓰여 비동기 레이스를 피한다.
 * @param {string} bin 검증된 whoami 절대경로
 * @param {object} env
 * @returns {string|null}
 */
function execWhoamiGroups(bin, env) {
  try {
    const out = childProcess.execFileSync(bin, ['/groups'], {
      shell: false, // H-2 필수: 셸 해석 금지
      windowsHide: true,
      timeout: 5000,
      maxBuffer: 1024 * 1024,
      encoding: 'utf8',
      env: env || process.env,
    });
    return typeof out === 'string' ? out : (out ? String(out) : '');
  } catch (_) {
    return null; // 실행 실패 → 판정 불가 → 호출측에서 비상승 폴백
  }
}

/**
 * 현재 세션이 권한 상승(elevated)인지 판정한다. 부작용 없음(판정만).
 *
 * @param {object} [deps] 테스트 주입용:
 *   - platform?: string         (기본 process.platform)
 *   - env?: object              (기본 process.env)
 *   - homedir?: () => string    (기본 os.homedir)
 *   - resolveWhoami?: (env) => string|null   (기본 resolveWhoamiBin)
 *   - execGroups?: (bin, env) => string|null (기본 execWhoamiGroups — whoami /groups stdout|null)
 * @returns {{ elevated:boolean, reason:string }}
 *   reason 은 진단용 토큰만(경로·프로필명 등 민감값 비노출): 'non-win32' | 'no-trigger' |
 *   'whoami-unresolved' | 'whoami-failed' | 'high-integrity' | 'medium-or-below'.
 */
function detectElevation(deps) {
  deps = deps || {};
  const platform = deps.platform || process.platform;
  const env = deps.env || process.env;

  // win32 외에는 본 메커니즘(APPDATA 프로필 분기)이 무관 — 항상 비상승.
  if (platform !== 'win32') {
    return { elevated: false, reason: 'non-win32' };
  }

  // (트리거) APPDATA 불일치 등으로 whoami 검사를 유발할지 판단. 불일치가 없으면 검사 비용 0.
  //   불일치는 "검사 유발" 신호일 뿐 단독 차단 금지(아래 SID 가 유일 차단 근거).
  const mismatch = appdataMismatch({ homedir: deps.homedir, env });
  if (!mismatch) {
    return { elevated: false, reason: 'no-trigger' };
  }

  // (권위) whoami /groups 의 High ML SID 가 유일한 차단 근거.
  const resolveWhoami = (typeof deps.resolveWhoami === 'function') ? deps.resolveWhoami : resolveWhoamiBin;
  const bin = resolveWhoami(env);
  if (!bin) {
    // 고정경로 whoami.exe 미해석 — 판정 불가 → 보수적 비상승 폴백.
    return { elevated: false, reason: 'whoami-unresolved' };
  }

  const exec = (typeof deps.execGroups === 'function') ? deps.execGroups : execWhoamiGroups;
  const stdout = exec(bin, env);
  if (stdout == null) {
    // whoami 실행/파싱 실패 — 판정 불가 → 보수적 비상승 폴백(가용성 우선).
    return { elevated: false, reason: 'whoami-failed' };
  }

  if (hasHighIntegritySid(stdout)) {
    return { elevated: true, reason: 'high-integrity' };
  }
  return { elevated: false, reason: 'medium-or-below' };
}

module.exports = {
  detectElevation,
  resolveWhoamiBin,
  hasHighIntegritySid,
  appdataMismatch,
  execWhoamiGroups,
  HIGH_ML_SID,
  SYSTEM_ML_SID,
};
