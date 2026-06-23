'use strict';
/**
 * lib/scan/excludeRules.js — 제외 폴더 규칙 (R-02)
 *
 * walker가 재귀 진입 여부를 판정할 때 쓰는 순수 판정 함수만 제공한다(순회 자체 안 함).
 * node_modules·.git 내부·dist/build/.cache·OS 시스템 폴더 등을 제외한다.
 * config.excludes(사용자 추가분)는 내장 규칙에 병합한다.
 *
 * [H-3 정합] 패턴 매칭은 정규식 백트래킹 폭발이 없도록 "정확 일치(Set 조회)"만
 *   사용한다(glob 미사용 → 선형시간). config.excludes는 폴더명(basename) 정확
 *   일치 또는 단순 접두/접미 비교만 허용해 ReDoS 표면을 만들지 않는다.
 *
 * 외부 의존성 0.
 */

const path = require('path');
const pathGuard = require('../common/pathGuard');

// 내장 제외 폴더명(basename 정확 일치, 소문자 비교). (R-02)
const BUILTIN_EXCLUDES = Object.freeze([
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  'dist',
  'build',
  'out',
  '.cache',
  '.next',
  '.nuxt',
  '.turbo',
  '.parcel-cache',
  'coverage',
  '.gradle',
  'target', // rust/java 빌드 산출물
  'bin',
  'obj', // .NET
  'vendor',
  '.venv',
  'venv',
  '__pycache__',
  '.idea',
  '.vs',
  // OS/시스템 폴더
  '$recycle.bin',
  'system volume information',
  '.trash',
  '.trashes',
]);

/**
 * [P2-4] 수집기 표본 순회 시 건너뛸 폴더(basename 소문자, 정확 일치).
 *   walker의 BUILTIN_EXCLUDES와 목적이 다르다:
 *     · BUILTIN_EXCLUDES = 프로젝트 "탐지 순회"에서 재귀 진입을 막는 제외 규칙(R-02).
 *     · SAMPLE_SKIP_DIRS = language/freshness 수집기가 확장자/ mtime "표본"을 모을 때
 *       잡음·비용을 줄이려 건너뛰는 폴더. 표본 단계에서 .git 메타는 mtime/확장자 의미가
 *       없으므로 포함한다.
 *   두 수집기에 중복 정의되어 있던 집합을 단일 원천으로 통일한다(언어/freshness 양쪽 require).
 */
const SAMPLE_SKIP_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn',
  'dist', 'build', 'out', 'coverage',
  '.next', '.nuxt', '.turbo', '.cache', '.parcel-cache',
  'vendor', '.venv', 'venv', '__pycache__',
  'target', '.idea', '.vs',
]);

/**
 * 사용자 제외 항목이 "절대경로형"인지("이름형"인지) 판정한다.
 *   · 경로 구분자(/ 또는 \)를 포함하거나 드라이브 접두(C:)로 시작 → 절대경로형(정확 경로 제외).
 *   · 그 외(단순 토큰) → 이름형(basename 정확 일치 제외).
 * @param {string} entry
 * @returns {boolean} true=절대경로형
 */
function isPathLikeExclude(entry) {
  if (typeof entry !== 'string' || !entry) return false;
  return /[\\/]/.test(entry) || /^[A-Za-z]:/.test(entry);
}

/** 정규식 형식(`/패턴/플래그`)인지 — 슬래시로 감싼 형태. */
function isRegexExclude(entry) {
  return typeof entry === 'string' && /^\/.+\/[gimsuy]*$/.test(entry);
}

/**
 * 정규식 제외 항목을 컴파일한다. 형식이 아니거나 컴파일 실패면 null.
 *   · g/y 플래그는 .test의 lastIndex 상태 문제를 피하려 제거(매칭 의미엔 영향 없음).
 *   · 폴더 이름(basename)에 매칭하므로 입력이 짧아 ReDoS 노출이 제한적(단일 사용자 로컬 도구).
 * @param {string} entry
 * @returns {RegExp|null}
 */
function compileExcludeRegex(entry) {
  if (!isRegexExclude(entry)) return null;
  const m = /^\/(.+)\/([gimsuy]*)$/.exec(entry);
  if (!m) return null;
  try { return new RegExp(m[1], m[2].replace(/[gy]/g, '')); } catch (_) { return null; }
}

/**
 * 내장 + 사용자 제외 집합을 만든다.
 *   · names: 폴더명(basename) 정확 일치 제외(소문자 폴드 Set) — 내장 규칙 + 이름형 사용자 항목.
 *   · pathKeys: 절대경로형 사용자 항목을 canonicalize→foldForCompare 폴드 키로(세그먼트 비교용 Set).
 *     canonicalize 실패(부재 경로)는 path.resolve 폴드로 폴백(실 자식과는 매칭 안 되지만 안전).
 * @param {string[]} [userExcludes] config.excludes (이미 길이·개수 상한 검증된 값)
 * @returns {{ set: Set<string>, pathKeys: Set<string> }}
 */
function buildExcludeSet(userExcludes) {
  const set = new Set(BUILTIN_EXCLUDES.map((s) => s.toLowerCase()));
  const pathKeys = new Set();
  const regexes = [];
  if (Array.isArray(userExcludes)) {
    for (const u of userExcludes) {
      if (typeof u !== 'string' || !u) continue;
      // 정규식 형식(`/.../`)을 가장 먼저 판정(슬래시 포함이라 경로형보다 우선).
      const re = compileExcludeRegex(u);
      if (re) { regexes.push(re); continue; }
      if (isPathLikeExclude(u)) {
        // 절대경로형: 실경로 해소 후 폴드 키. 부재면 resolve 폴드로 폴백.
        const canonical = pathGuard.canonicalize(u);
        const key = canonical !== null
          ? pathGuard.foldForCompare(canonical)
          : pathGuard.foldForCompare(path.resolve(u.replace(/[\\/]+$/, '')));
        if (key) pathKeys.add(key);
      } else {
        // 이름형: 폴더명(basename) 정확 일치.
        const base = path.basename(u.replace(/[\\/]+$/, '')).toLowerCase();
        if (base) set.add(base);
      }
    }
  }
  return { set, pathKeys, regexes };
}

/**
 * 디렉터리 이름(basename)이 제외 대상인지 판정한다(R-02).
 * 정확 일치(Set 조회) → 선형시간, ReDoS 없음.
 * @param {string} dirName basename
 * @param {{ set: Set<string> }} excludeSet buildExcludeSet 결과
 * @returns {boolean}
 */
function isExcludedName(dirName, excludeSet) {
  if (typeof dirName !== 'string' || !dirName) return false;
  const name = dirName.toLowerCase();
  if (excludeSet && excludeSet.set && excludeSet.set.has(name)) return true;
  return false;
}

/**
 * 사용자 정규식 제외 — 후보 디렉터리의 **전체 경로**(canonical)에 매칭(앵커 없이 substring 탐색).
 *   "앞뒤 임의의 경로 + 가운데 패턴"을 표현하려면 비앵커 패턴을 쓴다(예: `/temp/`, `/[\\/]\.cache[\\/]/`).
 *   컴파일은 buildExcludeSet에서 1회. 입력은 경로(길이 제한적)라 단일 사용자 로컬 도구로서 위험 수용.
 * @param {string} canonicalPath pathGuard.canonicalize 결과(또는 임의 경로 문자열)
 * @param {{ regexes: RegExp[] }} excludeSet
 * @returns {boolean}
 */
function matchesExcludeRegex(canonicalPath, excludeSet) {
  if (typeof canonicalPath !== 'string' || !canonicalPath) return false;
  const regexes = excludeSet && excludeSet.regexes;
  if (!Array.isArray(regexes) || regexes.length === 0) return false;
  // 경로 구분자를 '/'로 정규화 — 사용자가 `/a/b/`처럼 forward slash로 쓴 정규식이 Windows
  //   역슬래시 경로(C:\a\b)에도 매칭되도록(직관적). 정규식엔 '/' 기준으로 적으면 된다.
  const p = canonicalPath.replace(/\\/g, '/');
  for (const re of regexes) { if (re.test(p)) return true; }
  return false;
}

/**
 * [M4 R-05, M4-H-2] all-drives 전용 시스템 디렉터리 제외 — 원형 절대경로 목록.
 * 비교는 raw prefix가 아니라 canonicalize→foldForCompare 세그먼트 단위로 수행한다(아래).
 * 여기 정의된 "원형" 경로는 buildSystemExcludeKeySet에서 실경로로 해소 후 폴드 키로 변환된다.
 */
const SYSTEM_EXCLUDE_RAW = Object.freeze({
  win32: [
    'C:\\Windows',
    'C:\\$Recycle.Bin',
    'C:\\System Volume Information',
    'C:\\Program Files',
    'C:\\Program Files (x86)',
    'C:\\ProgramData',
    'C:\\Recovery',
    'C:\\PerfLogs',
  ],
  posix: [
    '/proc',
    '/sys',
    '/dev',
    '/run',
    '/private/var',
    '/System',
    '/Library',
    '/var/run',
  ],
});

/**
 * 플랫폼별 시스템 제외 목록을 canonicalize→foldForCompare 폴드 키 Set으로 1회 구성한다.
 * 해소 실패(부재) 항목은 스킵한다. canonicalize가 8.3 단축명·UNC·확장경로·심링크·대소문자를
 * 모두 흡수하므로, 어떤 표기로 들어와도 동일 폴드 키로 정규화된다(M4-H-2).
 * @param {string} [platform] process.platform 호환 값(테스트 주입용)
 * @returns {Set<string>} 폴드 키(세그먼트 비교용)
 */
function buildSystemExcludeKeySet(platform) {
  const plat = platform || process.platform;
  const raw = plat === 'win32' ? SYSTEM_EXCLUDE_RAW.win32 : SYSTEM_EXCLUDE_RAW.posix;
  const keys = new Set();
  for (const r of raw) {
    const canonical = pathGuard.canonicalize(r);
    if (canonical === null) continue; // 부재 항목 스킵
    const key = pathGuard.foldForCompare(canonical);
    if (key) keys.add(key);
  }
  return keys;
}

/**
 * [M4-H-2] canonicalDir(이미 canonicalize된 실경로)이 시스템 제외 디렉터리 하위(또는 자신)인지
 * 세그먼트 단위로 판정한다. prefix 부분일치 우회(C:\WindowsApps가 C:\Windows에 걸리는 등)를 차단.
 * @param {string} canonicalDir pathGuard.canonicalize 결과
 * @param {Set<string>} systemKeySet buildSystemExcludeKeySet 결과
 * @returns {boolean}
 */
function isUnderSystemDir(canonicalDir, systemKeySet) {
  if (typeof canonicalDir !== 'string' || !systemKeySet || systemKeySet.size === 0) return false;
  const folded = pathGuard.foldForCompare(canonicalDir);
  if (typeof folded !== 'string') return false;
  const segs = folded.split(/[\\/]+/).filter(Boolean);
  for (const excludeKey of systemKeySet) {
    const ex = excludeKey.split(/[\\/]+/).filter(Boolean);
    if (ex.length === 0) continue;
    // canonicalDir의 선두 세그먼트가 excludeKey 세그먼트열과 정확히 일치하면 제외.
    if (segs.length >= ex.length && ex.every((s, i) => s === segs[i])) return true;
  }
  return false;
}

/**
 * canonicalDir(이미 canonicalize된 실경로)이 사용자 절대경로 제외(또는 그 하위)인지
 * 세그먼트 단위로 판정한다(isUnderSystemDir와 동일 전략 — prefix 부분일치 우회 차단).
 * @param {string} canonicalDir pathGuard.canonicalize 결과
 * @param {{ pathKeys: Set<string> }} excludeSet buildExcludeSet 결과
 * @returns {boolean}
 */
function isUnderExcludedPath(canonicalDir, excludeSet) {
  const pathKeys = excludeSet && excludeSet.pathKeys;
  if (typeof canonicalDir !== 'string' || !pathKeys || pathKeys.size === 0) return false;
  const folded = pathGuard.foldForCompare(canonicalDir);
  if (typeof folded !== 'string') return false;
  const segs = folded.split(/[\\/]+/).filter(Boolean);
  for (const excludeKey of pathKeys) {
    const ex = excludeKey.split(/[\\/]+/).filter(Boolean);
    if (ex.length === 0) continue;
    if (segs.length >= ex.length && ex.every((s, i) => s === segs[i])) return true;
  }
  return false;
}

module.exports = {
  BUILTIN_EXCLUDES,
  SAMPLE_SKIP_DIRS,
  SYSTEM_EXCLUDE_RAW,
  buildExcludeSet,
  isExcludedName,
  isPathLikeExclude,
  isRegexExclude,
  compileExcludeRegex,
  matchesExcludeRegex,
  isUnderExcludedPath,
  buildSystemExcludeKeySet,
  isUnderSystemDir,
};
