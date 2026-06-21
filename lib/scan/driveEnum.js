'use strict';
/**
 * lib/scan/driveEnum.js — OS별 드라이브/마운트 열거 (R-05) — M4
 *
 * all-drives 모드에서 스캔 루트로 삼을 드라이브/마운트 루트를 외부 명령 없이 fs만으로 열거한다
 * (ADR-001 정합 — 외부 의존성 0). 각 후보는 pathGuard.canonicalize로 실경로 정규화·디렉터리
 * 검증을 통과한 것만 반환한다(config.normalizeScanRoots와 동일 규칙).
 *
 *   · Windows: 드라이브 문자 A:\~Z:\를 statSync로 존재/디렉터리 검사(접근 가능한 것만).
 *   · POSIX(mac/Linux): '/' 기본 + /Volumes/*(mac)·/mnt/*·/media/*(Linux) 항목 열거.
 *     /proc·/sys·/dev 등은 호출부(walker)의 시스템 제외(M4-H-2)가 가지치기하므로 여기선
 *     마운트 루트만 모은다. 단, 명백히 의미 없는 가상 마운트는 디렉터리 검증으로 자연 배제.
 *
 * 외부 의존성 0 — fs, path만 + 내부(pathGuard).
 */

const fs = require('fs');
const path = require('path');
const pathGuard = require('../common/pathGuard');
const { defaultLogger } = require('../common/logger');

/** 후보 경로를 canonicalize + 디렉터리 검증 후 dedup 추가한다. */
function pushChecked(out, seen, raw) {
  const canonical = pathGuard.canonicalize(raw);
  if (canonical === null) return;
  let st;
  try {
    st = fs.statSync(canonical);
  } catch (_) {
    return;
  }
  if (!st.isDirectory()) return;
  const key = pathGuard.foldForCompare(canonical);
  if (key && !seen.has(key)) {
    seen.add(key);
    out.push(canonical);
  }
}

/** Windows 드라이브 문자 A:\~Z:\ 중 접근 가능한 것을 열거. */
function enumerateWindows(out, seen) {
  for (let c = 'A'.charCodeAt(0); c <= 'Z'.charCodeAt(0); c++) {
    const letter = String.fromCharCode(c);
    pushChecked(out, seen, letter + ':\\');
  }
}

/** POSIX: '/' + 표준 마운트 부모(/Volumes, /mnt, /media)의 직속 항목. */
function enumeratePosix(out, seen) {
  pushChecked(out, seen, '/');
  const mountParents = ['/Volumes', '/mnt', '/media'];
  for (const parent of mountParents) {
    let entries;
    try {
      entries = fs.readdirSync(parent, { withFileTypes: true });
    } catch (_) {
      continue; // 부모 부재는 정상
    }
    for (const ent of entries) {
      // 심링크 마운트는 미추적(루프 방지). canonicalize가 추가 흡수.
      if (ent.isSymbolicLink()) continue;
      if (!ent.isDirectory()) continue;
      pushChecked(out, seen, path.join(parent, ent.name));
    }
  }
}

/**
 * 접근 가능한 드라이브/마운트 루트(canonical 실경로 배열)를 반환한다.
 * @param {object} [opts] { platform, logger }
 * @returns {string[]} canonical 실경로 배열(중복 제거)
 */
function enumerateRoots(opts) {
  opts = opts || {};
  const logger = opts.logger || defaultLogger;
  const platform = opts.platform || process.platform;
  const out = [];
  const seen = new Set();
  try {
    if (platform === 'win32') enumerateWindows(out, seen);
    else enumeratePosix(out, seen);
  } catch (err) {
    logger.warn('드라이브 열거 중 오류가 발생해 일부만 사용합니다');
    logger.error('driveEnum failed', err);
  }
  return out;
}

module.exports = { enumerateRoots };
