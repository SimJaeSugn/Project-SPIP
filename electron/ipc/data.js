'use strict';
/**
 * electron/ipc/data.js — 데이터 조회 IPC 핸들러 (electron-migration §4.1/§4.2 data 채널)
 *
 *   spip:getProjects → { schemaVersion, generatedAt, hasSnapshot, projects[] }
 *   spip:getStats    → { total, byLanguage, staleCount, totalBytes, generatedAt }
 *   spip:getHealth   → { ok:true, hasSnapshot, codeCli, git }
 *   spip:getConfig   → { scanRoots, staleDays, allowAllDrives, size:{enabled,maxBytes,maxEntries} }
 *
 * apiHandlers.js의 집계 로직을 (ctx) → result 순수 함수로 이식한다.
 * HTTP 결합(sendJson·res.writeHead)은 절단 — 객체를 그대로 반환한다(F-2).
 *
 * [헤드리스 검증, F-3] 본 모듈은 Electron API를 import하지 않는다. ctx 주입만으로
 *   단위테스트 가능. ipcMain 등록은 register.js가 발신자 검증과 함께 담당한다.
 *
 * 외부 의존성 0 — 내부(safeExec resolveBin)만.
 */

const { resolveBin } = require('../../lib/common/safeExec');

/** getProjects — 적재 스냅샷 그대로(계약 shape). 인자 무시. */
function getProjects(ctx) {
  const store = ctx.store;
  return {
    schemaVersion: store.schemaVersion,
    generatedAt: store.generatedAt,
    hasSnapshot: store.hasSnapshot,
    projects: store.getProjects(),
  };
}

/** getStats — total·byLanguage·staleCount·totalBytes·generatedAt(apiHandlers 이식). */
function getStats(ctx) {
  const store = ctx.store;
  const projects = store.getProjects();

  const byLanguage = {};
  let staleCount = 0;
  for (const p of projects) {
    const lang =
      p && p.language && typeof p.language.primary === 'string' && p.language.primary
        ? p.language.primary
        : 'Unknown';
    byLanguage[lang] = (byLanguage[lang] || 0) + 1;
    if (p && p.freshness && p.freshness.isStale) staleCount++;
  }

  return {
    total: projects.length,
    byLanguage,
    staleCount,
    totalBytes: store.stats && typeof store.stats.totalBytes === 'number' ? store.stats.totalBytes : null,
    generatedAt: store.generatedAt,
  };
}

/**
 * getHealth — codeCli/git는 실행 파일 절대경로 해석 가능 여부(resolveBin, H-2)로 판정.
 * @param {object} ctx { store, resolveBin? } resolveBin은 테스트 주입용(기본 실제 모듈).
 */
function getHealth(ctx) {
  const store = ctx.store;
  const rb = (ctx && typeof ctx.resolveBin === 'function') ? ctx.resolveBin : resolveBin;
  return {
    ok: true,
    hasSnapshot: store.hasSnapshot,
    codeCli: !!rb('code'),
    git: !!rb('git'),
  };
}

/**
 * getConfig — 민감하지 않은 설정 뷰(electron-migration §4.1 P3/F-8 명시 shape).
 * size 하위는 { enabled, maxBytes, maxEntries }를 노출. 경로 외 시크릿·캐시 메타 비노출.
 *
 *   [P3-5] 주석↔코드 정합: 실제 config.size는 normalizeSize 결과로 { enabled?, budgetMs,
 *   maxDepth, maxEntries }만 가지며 **maxBytes 필드가 없다**. 따라서 maxBytes는 계약 shape를
 *   유지하기 위한 자리(placeholder)로 항상 null로 노출된다(typeof 가드는 향후 config에 maxBytes가
 *   추가될 경우에만 값이 실린다 — 현재는 사실상 상시 null). scanRoots는 화이트리스트라 노출 허용.
 * @param {object} ctx { config }
 */
function getConfig(ctx) {
  const config = (ctx && ctx.config) || {};
  const size = (config.size && typeof config.size === 'object') ? config.size : {};
  return {
    scanRoots: Array.isArray(config.scanRoots) ? config.scanRoots.slice() : [],
    staleDays: typeof config.staleDays === 'number' ? config.staleDays : null,
    allowAllDrives: config.allowAllDrives === true,
    size: {
      enabled: size.enabled === true,
      // 현 config.size에 maxBytes 필드 없음 → 상시 null(계약 shape 유지용 자리).
      maxBytes: typeof size.maxBytes === 'number' ? size.maxBytes : null,
      maxEntries: typeof size.maxEntries === 'number' ? size.maxEntries : null,
    },
  };
}

module.exports = { getProjects, getStats, getHealth, getConfig };
