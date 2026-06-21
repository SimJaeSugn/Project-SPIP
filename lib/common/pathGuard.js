'use strict';
/**
 * lib/common/pathGuard.js — 경로 화이트리스트 정규화·검증 (N-03, 보안 H-1)
 *
 * 설계 §5 pathGuard 계약을 구현한다. walker/scanner(등록 시점)와 server(검증 시점)가
 * 동일한 canonicalize() 규칙을 공유하도록 공용 유틸(lib/common/)에 둔다.
 * 도메인을 가로지르지 않고(상위 미참조) 양쪽이 require해서 재사용한다.
 *
 * [H-1 핵심] 등록·검증 양쪽 모두 동일한 canonicalize()(path.resolve + fs.realpath
 *   + 대소문자 폴드 + NFC + UNC/드라이브상대/확장경로 처리)로 만든 실경로를 기준으로
 *   대조한다. path.resolve만으로는 심링크/접합점이 해소되지 않아 화이트리스트 우회가
 *   가능하므로, realpath 정규화를 단일 진실의 원천으로 강제한다(TOCTOU 표면 축소).
 *
 * 외부 의존성 0 — fs, path, os만 사용.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const IS_WIN = process.platform === 'win32';
const IS_DARWIN = process.platform === 'darwin';
// 대소문자 비민감 FS: Windows·macOS. 비교용 폴드를 적용한다.
const CASE_INSENSITIVE_FS = IS_WIN || IS_DARWIN;

/**
 * 원시 경로를 실경로(realpath) 기준으로 정규화한다(설계 §5 canonicalize).
 *  1) path.resolve로 '../' 접기 + 절대경로화
 *  2) fs.realpathSync(.native)로 심링크/Windows 접합점(junction) 실경로 해소
 *  3) NFC 유니코드 정규화(NFC/NFD 차이 흡수)
 *  4) (반환은 원형 보존; 대소문자 폴드는 비교 키 전용 foldForCompare에서 적용)
 *  5) 드라이브 상대경로(C:foo)·확장경로(\\?\)·UNC는 resolve/realpath로 흡수하거나 거부
 *
 * @param {string} rawPath 원시 경로
 * @returns {string|null} 실경로(정규화된 절대경로) 또는 해소 실패 시 null
 */
function canonicalize(rawPath) {
  if (typeof rawPath !== 'string' || rawPath.length === 0) return null;

  // 확장경로 접두사(\\?\)는 정규화가 까다로워 보수적으로 벗겨낸 뒤 표준 경로로 처리.
  let p = rawPath;
  if (IS_WIN && p.startsWith('\\\\?\\')) {
    // \\?\UNC\server\share → \\server\share, \\?\C:\x → C:\x
    if (/^\\\\\?\\UNC\\/i.test(p)) p = '\\\\' + p.slice('\\\\?\\UNC\\'.length);
    else p = p.slice('\\\\?\\'.length);
  }

  // NFC 정규화(입력 단계). 비교 일관성을 위해 먼저 적용한다.
  try {
    p = p.normalize('NFC');
  } catch (_) {
    return null;
  }

  // path.resolve로 절대경로화 + '../' 접기. 드라이브 상대(C:foo)도 cwd 기준 흡수.
  let abs;
  try {
    abs = path.resolve(p);
  } catch (_) {
    return null;
  }

  // realpath로 심링크/junction 해소. 경로 소멸/접근 불가 → null(호출부가 PATH_GONE 처리).
  let real;
  try {
    real = fs.realpathSync.native ? fs.realpathSync.native(abs) : fs.realpathSync(abs);
  } catch (_) {
    return null;
  }

  try {
    real = real.normalize('NFC');
  } catch (_) {
    return null;
  }

  return real;
}

/**
 * 비교 전용 폴드 키를 만든다. 대소문자 비민감 FS는 소문자 폴드, 그 외는 원형.
 * 표시·실행에는 canonicalize() 원형을, 정확 일치 비교에는 이 키를 사용한다.
 * @param {string} canonical canonicalize() 결과
 * @returns {string|null}
 */
function foldForCompare(canonical) {
  if (typeof canonical !== 'string') return null;
  let s = canonical;
  // Windows는 후행 구분자 제거(루트 제외) — \\ vs 단일 일관화.
  if (IS_WIN) s = s.replace(/[\\/]+$/, '') || s;
  return CASE_INSENSITIVE_FS ? s.toLowerCase() : s;
}

/**
 * 화이트리스트(canonicalize된 실경로 집합)에 요청 경로가 정확 일치하는지 검사한다.
 * 요청 경로도 canonicalize() 후 폴드 키끼리 정확 일치만 허용한다(H-1).
 * '../' 순회·심링크/접합점 우회·접두사 부분일치를 모두 차단한다.
 *
 * @param {string} requestedPath 검증 대상 원시 경로
 * @param {Set<string>|string[]} whitelist canonicalize된 실경로(원형) 모음
 * @returns {boolean}
 */
function isAllowed(requestedPath, whitelist) {
  const real = canonicalize(requestedPath);
  if (real === null) return false; // 실경로 해소 실패 = 거부
  const reqKey = foldForCompare(real);

  const keys = buildAllowedKeySet(whitelist);
  return keys.has(reqKey);
}

/**
 * 화이트리스트 원형 경로 집합을 비교용 폴드 키 Set으로 변환한다.
 * 서버(snapshotStore)가 1회 구성해 재사용할 수 있다.
 * @param {Set<string>|string[]} whitelist
 * @returns {Set<string>}
 */
function buildAllowedKeySet(whitelist) {
  const out = new Set();
  const iter = whitelist instanceof Set ? whitelist : Array.isArray(whitelist) ? whitelist : [];
  for (const w of iter) {
    if (typeof w !== 'string') continue;
    const k = foldForCompare(w);
    if (k) out.add(k);
  }
  return out;
}

module.exports = {
  canonicalize,
  foldForCompare,
  isAllowed,
  buildAllowedKeySet,
  CASE_INSENSITIVE_FS,
};
