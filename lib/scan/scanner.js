'use strict';
/**
 * lib/scan/scanner.js — 스캔 오케스트레이션 (R-14, N-05, 보안 H-1)
 *
 * walker → detector → collectors 를 묶어 전체 스캔을 완주시킨다.
 *   1) walker로 후보 디렉터리(canonical 실경로) 스트리밍 (H-1 등록 정규화)
 *   2) detector로 프로젝트 확정(중첩 최상위 1건)
 *   3) 각 프로젝트에 활성 수집기 적용 — 항목 단위 try 격리(N-05) + H-3 가드는 수집기 내부
 *   4) 항목 실패는 throw가 아니라 warnings[]에 누적, counts 집계
 *   5) Snapshot 객체(직렬화는 serializer가 담당)를 반환. path는 canonicalize 실경로(H-1)
 *
 * id는 경로 해시 기반 안정 식별자(crypto, 내장) — API에서 경로 노출 최소화(R-12).
 *
 * 외부 의존성 0 — crypto(내장) + 내부 모듈.
 */

const crypto = require('crypto');
const path = require('path');
const walker = require('./walker');
const detector = require('./detector');
const collectorsRegistry = require('./collectors');
const pathGuard = require('../common/pathGuard'); // P2-3: 핫패스 인라인 require 제거(순환 없음)
const { defaultLogger } = require('../common/logger');

/** 경로 기반 안정 식별자(R-12). 폴드 키로 해시해 대소문자 일관. */
function projectId(canonicalPath) {
  const key = pathGuard.foldForCompare(canonicalPath) || canonicalPath;
  return crypto.createHash('sha1').update(key).digest('hex').slice(0, 16);
}

/**
 * 단일 프로젝트에 수집기들을 적용한다. 각 수집기를 try 격리(N-05).
 * git 수집 결과를 freshness가 쓸 수 있도록 collected에 누적 후 ctx로 전달한다.
 * @returns {Promise<{ collected:object, warnings:array, hadError:boolean }>}
 */
async function runCollectors(projectPath, signals, baseCtx, collectorModules) {
  const collected = {};
  const warnings = [];
  let hadError = false;

  for (const mod of collectorModules) {
    const ctx = Object.assign({}, baseCtx, { signals, collected });
    let res;
    try {
      // collect는 동기/비동기 모두 허용 — await가 동기 반환도 흡수.
      res = await mod.collect(projectPath, ctx);
    } catch (err) {
      // 수집기가 계약을 어기고 throw해도 전체 중단 금지(N-05).
      hadError = true;
      warnings.push({ reason: '수집기 실패: ' + mod.name });
      collected[mod.name] = { status: 'error' };
      if (baseCtx.logger) baseCtx.logger.error('collector ' + mod.name + ' threw', err);
      continue;
    }
    if (!res || typeof res !== 'object') {
      collected[mod.name] = { status: 'error' };
      hadError = true;
      continue;
    }
    collected[mod.name] = Object.assign({ status: res.status }, res.data || {});
    if (res.status === 'error') hadError = true;
    // na/skipped 메모(res.note)는 경고로 누적하지 않는다(정상 graceful). error만 위에서 처리.
  }
  return { collected, warnings, hadError };
}

/**
 * 수집 결과를 §8.1 Project 항목 shape으로 조립한다.
 */
function buildProject(projectPath, signals, collected) {
  const lang = collected.language || {};
  const fresh = collected.freshness || {};
  const git = collected.git || {};
  const size = collected.size || { status: 'skipped' };

  // 이름: package.json name > 폴더명.
  const name = (lang.name && typeof lang.name === 'string' && lang.name.trim())
    ? lang.name
    : path.basename(projectPath);

  return {
    id: projectId(projectPath),
    path: projectPath, // canonical 실경로(H-1 화이트리스트 원천)
    name,
    description: lang.description != null ? lang.description : null,
    signals: Array.isArray(signals) ? signals : [],
    language: {
      primary: lang.primary || 'Unknown',
      breakdown: lang.breakdown || {},
    },
    freshness: {
      lastModified: fresh.lastModified != null ? fresh.lastModified : null,
      lastCommit: fresh.lastCommit != null ? fresh.lastCommit : null,
      isStale: !!fresh.isStale,
    },
    git: {
      status: git.status === 'ok' ? 'ok' : 'na',
      isRepo: !!git.isRepo,
      branch: git.status === 'ok' ? (git.branch != null ? git.branch : null) : null,
      dirty: git.status === 'ok' ? !!git.dirty : null,
      ahead: git.status === 'ok' ? (typeof git.ahead === 'number' ? git.ahead : null) : null,
      behind: git.status === 'ok' ? (typeof git.behind === 'number' ? git.behind : null) : null,
    },
    size: {
      status: size.status || 'skipped',
      totalBytes: size.totalBytes != null ? size.totalBytes : null,
      nodeModulesBytes: size.nodeModulesBytes != null ? size.nodeModulesBytes : null,
      deps: size.deps != null ? size.deps : null,
      devDeps: size.devDeps != null ? size.devDeps : null,
    },
  };
}

/**
 * 스캔을 수행하고 Snapshot 객체(직렬화 전)를 반환한다(R-14).
 * @param {object} options {
 *   roots:string[], excludes:string[], staleDays, logger,
 *   withSize:boolean,      // [R-09] size 용량 측정 opt-in(=config.size.enabled 덮어쓰기)
 *   size:object,           // size 수집기 예산(budgetMs/maxDepth/maxEntries/deepNodeModules)
 *   allDrives:boolean,     // [R-05] 시스템 제외 + 더 낮은 깊이 상한
 *   depthLimit:number,     // [R-03] 유효 깊이(walker가 clamp 강제)
 *   maxDirs:number, timeBudgetMs:number, // [M4-M-2] 전역 자원 상한
 *   onProgress:(ScanProgress)=>void,     // [R-15] 진행 콜백(throttled)
 * }
 * @returns {Promise<object>} Snapshot (serializer가 파일로 기록)
 */
async function scan(options) {
  options = options || {};
  const logger = options.logger || defaultLogger;
  const withSize = options.withSize === true || (options.size && options.size.enabled === true);
  const config = {
    staleDays: options.staleDays || 90,
    scanRoots: options.roots || [],
    // [M4 R-09] size 수집기가 ctx.config.size를 읽는다. withSize는 enabled를 덮어쓴다.
    size: Object.assign({}, options.size, withSize ? { enabled: true } : {}),
  };
  const roots = Array.isArray(options.roots) ? options.roots : [];
  const excludes = Array.isArray(options.excludes) ? options.excludes : [];
  // 프로젝트 인식 시그널(설정). 미지정이면 detector가 기본값으로 폴백.
  const detectSignals = Array.isArray(options.detectSignals) ? options.detectSignals : undefined;

  // [M4 R-09 / BUG-M4-01] size 수집기는 항상 로드한다(deps/devDeps는 enabled 무관 항상 수집 —
  //   계약 §8.1). 용량 측정(totalBytes 등)만 config.size.enabled(=withSize)로 게이트되어,
  //   비활성이면 size.collect가 skipped+totalBytes:null을 반환(MVP 회귀 0·N-01 성능 보존).
  const collectorModules = collectorsRegistry.loadActiveCollectors();
  const baseCtx = { config, logger, limits: collectorsRegistry.LIMITS };

  const startedAt = Date.now();
  const projects = [];
  let staleCount = 0;
  let errorCount = 0;

  // [M4 R-09/§4.3] totalBytes 집계.
  let totalBytesSum = 0;
  let anyMeasured = false;

  // [M4 R-15/P1-1] walker onDir로 dirs/currentPath 집계 → onProgress(ScanProgress 객체).
  let dirs = 0;
  let currentPath = null;
  let lastEmit = 0;
  const emitProgress = () => {
    if (typeof options.onProgress !== 'function') return;
    const now = Date.now();
    if (now - lastEmit < 250) return; // ≥250ms 스로틀(호출 빈도 제한)
    lastEmit = now;
    try {
      options.onProgress({ phase: 'scanning', dirs, found: projects.length, currentPath });
    } catch (_) { /* noop */ }
  };

  const candidateStream = walker.walk(roots, {
    excludes,
    logger,
    // [M4 R-03] depthLimit(미지정이면 walker 기본 24/all-drives 12).
    depthLimit: options.depthLimit,
    // [M4 R-05] all-drives — 시스템 제외(M4-H-2) + 더 낮은 깊이 상한.
    allDrives: options.allDrives === true,
    // [M4-M-2] 전역 자원 상한.
    maxDirs: options.maxDirs,
    timeBudgetMs: options.timeBudgetMs,
    // [P1-1] 디렉터리 진행 콜백.
    onDir(dir) {
      dirs++;
      currentPath = dir; // canonical 절대 실경로 — 응답 노출 전 ScanController가 축약(M4-H-1)
      emitProgress();
    },
  });
  const projectStream = detector.detectStream(candidateStream, { logger, signals: detectSignals });

  for (const { path: projectPath, signals } of projectStream) {
    // 항목 단위 격리(N-05): 한 프로젝트 처리 실패가 전체를 죽이지 않음.
    try {
      const { collected, hadError } = await runCollectors(projectPath, signals, baseCtx, collectorModules);
      const project = buildProject(projectPath, signals, collected);
      if (project.freshness.isStale) staleCount++;
      if (hadError) errorCount++;
      // [§4.3] size.status ok/partial이고 totalBytes가 number면 합산(skipped/error/null 제외).
      if (
        (project.size.status === 'ok' || project.size.status === 'partial') &&
        typeof project.size.totalBytes === 'number'
      ) {
        totalBytesSum += project.size.totalBytes;
        anyMeasured = true;
      }
      projects.push(project);
      // [P1-1] 프로젝트 확정 시에도 ScanProgress 객체로 통일(number 시그니처 폐기).
      if (typeof options.onProgress === 'function') {
        try {
          options.onProgress({ phase: 'scanning', dirs, found: projects.length, currentPath });
        } catch (_) { /* noop */ }
      }
    } catch (err) {
      errorCount++;
      logger.warn('프로젝트 처리 중 오류로 건너뜁니다');
      logger.error('project processing failed', err);
    }
  }

  const durationMs = Date.now() - startedAt;

  return {
    schemaVersion: 1,
    generatedAt: new Date(startedAt).toISOString(),
    scanRoots: roots.slice(),
    durationMs,
    counts: {
      projects: projects.length,
      stale: staleCount,
      errors: errorCount,
    },
    // [§4.3] 스냅샷에 합계 저장(getStats는 읽기만). 미측정이면 null 유지.
    stats: { totalBytes: anyMeasured ? totalBytesSum : null },
    warnings: logger.getWarnings ? logger.getWarnings() : [],
    projects,
  };
}

module.exports = { scan, projectId, buildProject };
