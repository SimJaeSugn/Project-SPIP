'use strict';
/**
 * lib/scan/serializer.js — Snapshot 직렬화·원자적 쓰기 (N-06, 보안 M-2)
 *
 * Snapshot(§8.1)을 JSON으로 직렬화해 앱 폴더 cache/projects.json에 기록한다.
 *   · 원자적 쓰기: 같은 디렉터리에 임시 파일 작성 → fsync → rename(원자성 보장).
 *   · 권한(M-2): 임시·최종 파일 모두 소유자 전용(POSIX 0600). 디렉터리는 paths가 0700.
 *     Windows는 mode가 무시될 수 있으나 동일 정책으로 생성한다(사용자 ACL은 OS 기본).
 *   · 실패 시 임시 파일 정리.
 *
 * 외부 의존성 0 — fs, path, os + 내부(paths).
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const paths = require('../common/paths');
const elevationState = require('../common/elevationState');

const FILE_MODE = 0o600;

/**
 * Snapshot이 §8.1 스키마 형태를 갖췄는지 최소 정규화한다(누락 필드 보정).
 * @param {object} snapshot
 * @returns {object}
 */
function normalizeSnapshot(snapshot) {
  const s = snapshot && typeof snapshot === 'object' ? snapshot : {};
  return {
    schemaVersion: typeof s.schemaVersion === 'number' ? s.schemaVersion : 1,
    generatedAt: typeof s.generatedAt === 'string' ? s.generatedAt : new Date().toISOString(),
    scanRoots: Array.isArray(s.scanRoots) ? s.scanRoots : [],
    durationMs: typeof s.durationMs === 'number' ? s.durationMs : 0,
    counts: s.counts && typeof s.counts === 'object'
      ? {
          projects: s.counts.projects || 0,
          stale: s.counts.stale || 0,
          errors: s.counts.errors || 0,
        }
      : { projects: 0, stale: 0, errors: 0 },
    // [M4 §4.3] totalBytes 집계(size.enabled 스냅샷이면 number, 아니면 null).
    stats: {
      totalBytes:
        s.stats && typeof s.stats === 'object' && typeof s.stats.totalBytes === 'number'
          ? s.stats.totalBytes
          : null,
    },
    warnings: Array.isArray(s.warnings) ? s.warnings : [],
    projects: Array.isArray(s.projects) ? s.projects : [],
  };
}

/**
 * Snapshot을 지정 경로(기본 cachePath)에 원자적·0600으로 기록한다(N-06, M-2).
 * [M12 b3] 중앙 elevated 플래그(상승 세션)면 디스크 write 를 no-op 한다 — 관리자 프로필에
 *   새 0600 스냅샷 파일을 만들지 않는다. 정규화 결과는 그대로 반환하되 written:false 로 표시한다.
 *   (rescan 조기거부와 이중 안전. 메모리/기존 데이터는 무손상.) deps.elevationState 주입 가능(테스트).
 *
 * @param {object} snapshot
 * @param {object} [opts] { cachePath, logger, deps?{fs,elevationState} }
 * @returns {{ path:string, bytes:number, written?:boolean }}
 */
function writeSnapshot(snapshot, opts) {
  opts = opts || {};
  const target = opts.cachePath || paths.cachePath();

  const normalized = normalizeSnapshot(snapshot);
  const body = JSON.stringify(normalized, null, 2);

  // [M12 b3] 상승 세션이면 디스크 write 보류(no-op). 디렉터리 생성·임시파일·rename 일절 안 함.
  const _elev = (opts.deps && opts.deps.elevationState) || elevationState;
  if (_elev.isElevated()) {
    if (opts.logger) opts.logger.warn('상승 세션 — 스냅샷 디스크 저장 보류(메모리 유지)');
    return { path: target, bytes: Buffer.byteLength(body, 'utf8'), written: false };
  }

  const dir = paths.ensureDirFor(target); // 디렉터리 0700 보장(M-2)

  // 같은 디렉터리에 임시 파일(원자적 rename 보장 — 동일 파일시스템).
  const tmp = path.join(
    dir,
    '.' + path.basename(target) + '.' + process.pid + '.' + Date.now() + '.tmp'
  );

  let fd;
  try {
    // wx: 임시 파일이 이미 있으면 실패(충돌 방지). 0600 권한으로 생성.
    fd = fs.openSync(tmp, 'wx', FILE_MODE);
    fs.writeFileSync(fd, body, { encoding: 'utf8' });
    try { fs.fsyncSync(fd); } catch (_) { /* fsync 미지원 FS는 무시 */ }
    fs.closeSync(fd);
    fd = undefined;

    // 권한 재확정(umask 영향 제거 시도). Windows는 무시될 수 있음.
    try { fs.chmodSync(tmp, FILE_MODE); } catch (_) { /* noop */ }

    // 원자적 교체.
    fs.renameSync(tmp, target);
    try { fs.chmodSync(target, FILE_MODE); } catch (_) { /* noop */ }

    return { path: target, bytes: Buffer.byteLength(body, 'utf8'), written: true };
  } catch (err) {
    // 실패 시 임시 파일 정리.
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch (_) { /* noop */ }
    }
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (_) { /* noop */ }
    if (opts.logger) opts.logger.error('스냅샷 쓰기 실패', err);
    throw err;
  }
}

module.exports = { writeSnapshot, normalizeSnapshot, FILE_MODE };
