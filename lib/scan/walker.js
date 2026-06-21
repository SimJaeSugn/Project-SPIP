'use strict';
/**
 * lib/scan/walker.js — DFS 디렉터리 순회 (R-02, N-05, 보안 H-1·M-3)
 *
 * scanRoots부터 깊이 우선(DFS)으로 후보 디렉터리를 스트리밍한다(순회만 — 판별/수집 안 함).
 *
 * [H-1 등록 정규화] 진입하는 각 디렉터리를 pathGuard.canonicalize(realpath)로 해소해
 *   화이트리스트의 원천이 되는 실경로를 산출한다. yield하는 후보는 canonical 실경로다.
 * [M-3 무한재귀/심링크 루프 차단]
 *   · 내장 안전 깊이 상한(하드코딩 SAFE_MAX_DEPTH) — 사용자 설정과 무관하게 항상 강제.
 *   · 방문 실경로(realpath) 집합 추적 → 재방문 가지치기(심링크 루프 a→b→a 차단).
 *   · 심링크/junction은 기본 미추적(lstat로 판별). 따라가지 않음(MVP). R-03(정책 정교화)은 M4.
 * [N-05] 한 디렉터리 읽기 실패가 전체 순회를 죽이지 않도록 try 격리 + warnings 누적.
 *
 * 동기 제너레이터로 후보를 스트리밍한다(AsyncIterable 계약과 호환되도록 단순 동기 채택 —
 * 단일 사용자 CLI 배치라 동기 fs가 가장 단순·견고. 설계 §6.1 "스트리밍" 의도 충족).
 *
 * 외부 의존성 0 — fs, path만 + 내부 모듈(pathGuard, excludeRules).
 */

const fs = require('fs');
const path = require('path');
const pathGuard = require('../common/pathGuard');
const excludeRules = require('./excludeRules');
const { defaultLogger } = require('../common/logger'); // P2-3: 인라인 require 제거(순환 없음)

// [M-3] 내장 안전 깊이 기본값. M4: config.depthLimit의 "기본값"으로 강등(약화 금지).
const SAFE_MAX_DEPTH = 24;
// [M4 R-03] 절대 안전 상한. 사용자가 더 큰 depthLimit을 줘도 이 위로는 못 넘는다(M-3 승계).
const ABS_MAX_DEPTH = 64;
// [M4 R-03/M4-M-2] all-drives 전용 더 낮은 상한·기본값(디스크 전체 결합 시 순회 폭발 추가 억제).
const ABS_MAX_DEPTH_ALL_DRIVES = 24;
const DEFAULT_DEPTH_ALL_DRIVES = 12;

function clamp(n, lo, hi) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, Math.floor(n)));
}

/**
 * 단일 루트 하위를 DFS 순회하며 후보 디렉터리(canonical 실경로)를 yield한다.
 * @param {string} rootCanonical canonicalize된 루트 실경로
 * @param {object} ctx { excludeSet, visited:Set, logger, depthLimit, onDir, allDrives,
 *                        systemKeySet, maxDirs, deadlineTs, counters }
 */
function* walkRoot(rootCanonical, ctx) {
  // 스택: { dir(canonical 실경로), depth }
  const stack = [{ dir: rootCanonical, depth: 0 }];

  while (stack.length > 0) {
    // [M4-M-2] walker 전역 자원 상한(깊이와 독립) — 얕고 넓은 거대 트리도 안전 중단.
    if (ctx.counters.dirs >= ctx.maxDirs) {
      if (!ctx.counters.limitHit) {
        ctx.counters.limitHit = true;
        ctx.logger.warn('순회 디렉터리 상한에 도달해 일부만 스캔합니다');
      }
      return;
    }
    if (ctx.deadlineTs && Date.now() > ctx.deadlineTs) {
      if (!ctx.counters.limitHit) {
        ctx.counters.limitHit = true;
        ctx.logger.warn('스캔 시간 예산에 도달해 일부만 스캔합니다');
      }
      return;
    }

    const { dir, depth } = stack.pop();

    // 재방문 가지치기(심링크 루프 차단, M-3). 실경로 기준.
    const visitKey = pathGuard.foldForCompare(dir);
    if (ctx.visited.has(visitKey)) continue;
    ctx.visited.add(visitKey);

    ctx.counters.dirs++;

    // [P1-1 진행 산출] yield 직전 onDir 1회 호출. 신호 실패는 순회를 막지 않음(N-05).
    if (typeof ctx.onDir === 'function') {
      try { ctx.onDir(dir); } catch (_) { /* noop */ }
    }

    // 후보로 방출(루트 포함 — detector가 프로젝트 여부 판정).
    yield dir;

    // 깊이 안전 상한(M-3, M4 R-03: config 기반 + 절대 상한). 초과 시 더 내려가지 않음.
    if (depth >= ctx.effectiveDepth) {
      ctx.logger.warn('안전 깊이 상한에 도달해 하위 순회를 중단합니다', { path: dir });
      continue;
    }

    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      // 권한 없음·소멸 등 — 항목 격리(N-05).
      ctx.logger.warn('디렉터리를 읽지 못해 건너뜁니다', { path: dir });
      continue;
    }

    // DFS: 자식을 역순으로 push해 알파벳 순회 비슷하게 유지(결정성).
    const childDirs = [];
    for (const ent of entries) {
      const name = ent.name;
      // 심링크/junction은 기본 미추적(M-3). lstat 결과 링크면 진입 안 함.
      const isLink = ent.isSymbolicLink();
      if (isLink) continue;

      if (!ent.isDirectory()) continue;
      if (excludeRules.isExcludedName(name, ctx.excludeSet)) continue;

      const childRaw = path.join(dir, name);
      // 등록 정규화(H-1): 자식도 realpath로 해소. 해소 실패 시 건너뜀.
      const childCanonical = pathGuard.canonicalize(childRaw);
      if (childCanonical === null) {
        ctx.logger.warn('실경로 해소에 실패해 건너뜁니다', { path: childRaw });
        continue;
      }
      // [M4-H-2] all-drives 활성 시 시스템 디렉터리 제외 — canonicalize 직후·push(진입) 전
      //   세그먼트 단위 가지치기(8.3/UNC/junction/대소문자 흡수). visited보다 앞단(H-3).
      if (ctx.allDrives && excludeRules.isUnderSystemDir(childCanonical, ctx.systemKeySet)) {
        continue;
      }
      // 추가 방어: junction을 readdir이 디렉터리로 보고하더라도, realpath가 이미
      // 방문한 경로면 visited에서 가지치기된다(루프 차단).
      childDirs.push({ dir: childCanonical, depth: depth + 1 });
    }
    // 역순 push로 자연 순서 유지.
    for (let i = childDirs.length - 1; i >= 0; i--) stack.push(childDirs[i]);
  }
}

/**
 * 여러 scanRoots를 순회하며 후보 디렉터리(canonical 실경로)를 yield한다.
 * @param {string[]} roots config.scanRoots (이미 realpath 정규화된 절대경로)
 * @param {object} [opts] {
 *   excludes:string[], logger,
 *   depthLimit:number,         // [R-03] 유효 깊이 = clamp(depthLimit ?? 기본, 1, 절대상한)
 *   onDir:(dir)=>void,         // [R-15/P1-1] yield 직전 1회 호출(진행 산출). 미지정 시 동작 불변.
 *   allDrives:boolean,         // [R-05] true면 시스템 제외(M4-H-2) 가지치기 + 더 낮은 깊이 상한
 *   maxDirs:number,            // [M4-M-2] 전역 순회 디렉터리 상한
 *   timeBudgetMs:number,       // [M4-M-2] 전역 시간 예산
 *   platform:string,          // 테스트 주입(시스템 제외 키셋 플랫폼)
 * }
 * @returns {Generator<string>} canonical 실경로 스트림
 */
function* walk(roots, opts) {
  opts = opts || {};
  const logger = opts.logger || defaultLogger;
  const excludeSet = excludeRules.buildExcludeSet(opts.excludes || []);
  const visited = new Set(); // 전역 방문 실경로(여러 루트가 겹쳐도 1회 방문)

  const allDrives = opts.allDrives === true;
  // [R-03] 유효 깊이 산출. depthLimit 미지정 호출부(CLI 기존)는 24로 동작 → 행동 불변.
  const cap = allDrives ? ABS_MAX_DEPTH_ALL_DRIVES : ABS_MAX_DEPTH;
  const dflt = allDrives ? DEFAULT_DEPTH_ALL_DRIVES : SAFE_MAX_DEPTH;
  const requested = opts.depthLimit != null ? opts.depthLimit : dflt;
  const effectiveDepth = clamp(requested, 1, cap);

  // [M4-H-2] all-drives 활성 시에만 시스템 제외 키셋 1회 구성(canonicalize 폴드 키).
  //   opts.systemKeySet은 테스트 주입 전용 시드(미지정 시 플랫폼 목록으로 구성). 통제 약화 아님 —
  //   실서버 경로(server/scanController→scanner→walker)는 systemKeySet을 넘기지 않으므로
  //   항상 buildSystemExcludeKeySet(플랫폼 고정 목록)만 쓴다.
  const systemKeySet = allDrives
    ? (opts.systemKeySet instanceof Set ? opts.systemKeySet : excludeRules.buildSystemExcludeKeySet(opts.platform))
    : null;

  // [M4-M-2] 전역 자원 상한.
  const maxDirs = typeof opts.maxDirs === 'number' && opts.maxDirs > 0 ? opts.maxDirs : Infinity;
  const deadlineTs = typeof opts.timeBudgetMs === 'number' && opts.timeBudgetMs > 0
    ? Date.now() + opts.timeBudgetMs
    : 0;
  const counters = { dirs: 0, limitHit: false };

  const ctx = {
    excludeSet, visited, logger,
    onDir: opts.onDir,
    allDrives, systemKeySet,
    effectiveDepth, maxDirs, deadlineTs, counters,
  };

  const list = Array.isArray(roots) ? roots : [];
  for (const root of list) {
    // 루트도 등록 정규화(H-1). config가 이미 realpath를 주지만 동일 규칙 재적용으로 일관.
    const rootCanonical = pathGuard.canonicalize(root);
    if (rootCanonical === null) {
      logger.warn('루트 실경로 해소에 실패해 건너뜁니다', { path: root });
      continue;
    }
    // [P2-4] all-drives 시 루트 레벨에도 시스템 제외를 적용한다(기존엔 자식만 가지치기).
    //   루트 자체가 시스템 경로(예: posix '/System')면 진입 전 통째로 건너뛴다 — §5.3 앞단 가지치기 일관.
    if (allDrives && systemKeySet && excludeRules.isUnderSystemDir(rootCanonical, systemKeySet)) {
      logger.warn('시스템 디렉터리 루트를 건너뜁니다', { path: rootCanonical });
      continue;
    }
    yield* walkRoot(rootCanonical, ctx);
  }
}

module.exports = {
  walk,
  SAFE_MAX_DEPTH,
  ABS_MAX_DEPTH,
  ABS_MAX_DEPTH_ALL_DRIVES,
  DEFAULT_DEPTH_ALL_DRIVES,
};
