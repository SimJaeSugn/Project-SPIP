'use strict';
/**
 * lib/scan/collectors/freshness.js — 신선도/stale 판정 (R-07)
 *
 * 프로젝트의 최종 수정 시각을 산출하고, (가능 시) git 수집기가 제공한 최근 커밋 시각을
 * 결합한다. config.staleDays(기본 90일) 초과 시 isStale=true.
 *
 * 최종 수정 시각은 루트 + 얕은 표본 파일의 mtime 최댓값으로 근사한다(자원 상한 적용).
 * 표본은 선형 순회(정규식 없음, ReDoS 무관)이며 거대 트리 방어를 위해 상한을 둔다.
 *
 * collect(projectPath, ctx) -> { ok, data, status, note }
 *   data: { lastModified:ISO|null, lastCommit:ISO|null, isStale:boolean }
 *
 * 외부 의존성 0 — fs, path만.
 */

const fs = require('fs');
const path = require('path');
const { SAMPLE_SKIP_DIRS } = require('../excludeRules'); // P2-4: 표본 스킵 폴더 단일 원천

const MAX_FILES_SAMPLED = 2000;
const SKIP_DIRS = SAMPLE_SKIP_DIRS;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 프로젝트 하위 파일 mtime 최댓값(ms)을 얕게 표본 집계한다.
 * @returns {number} epoch ms, 표본 없으면 0
 */
function latestMtimeMs(projectPath) {
  let maxMs = 0;
  let sampled = 0;
  const queue = [{ dir: projectPath, depth: 0 }];

  while (queue.length > 0 && sampled < MAX_FILES_SAMPLED) {
    const { dir, depth } = queue.shift();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      continue;
    }
    for (const ent of entries) {
      if (sampled >= MAX_FILES_SAMPLED) break;
      if (ent.isSymbolicLink()) continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        const lower = ent.name.toLowerCase();
        if (SKIP_DIRS.has(lower)) continue;
        if (depth < 2) queue.push({ dir: full, depth: depth + 1 });
        continue;
      }
      if (!ent.isFile()) continue;
      try {
        const st = fs.statSync(full);
        const ms = st.mtimeMs || (st.mtime && st.mtime.getTime()) || 0;
        if (ms > maxMs) maxMs = ms;
        sampled++;
      } catch (_) {
        // 격리
      }
    }
  }
  return maxMs;
}

/**
 * 신선도 수집(R-07).
 * @param {string} projectPath canonical 실경로
 * @param {object} ctx { config, signals, logger, collected? }
 *   ctx.collected.git.lastCommit 가 있으면 lastCommit으로 사용(스캐너가 주입).
 * @returns {{ ok, data, status, note }}
 */
function collect(projectPath, ctx) {
  ctx = ctx || {};
  const staleDays = (ctx.config && ctx.config.staleDays) || 90;

  let lastModifiedMs = 0;
  try {
    // 루트 자체 mtime + 표본 파일 mtime 최댓값.
    const rootSt = fs.statSync(projectPath);
    lastModifiedMs = rootSt.mtimeMs || 0;
  } catch (_) {
    // 격리
  }
  try {
    const sampleMs = latestMtimeMs(projectPath);
    if (sampleMs > lastModifiedMs) lastModifiedMs = sampleMs;
  } catch (_) {
    // 격리
  }

  // git 커밋 시각(스캐너가 git 수집 결과를 주입했으면 사용).
  let lastCommitMs = 0;
  const gitData = ctx.collected && ctx.collected.git;
  if (gitData && gitData.lastCommit) {
    const t = Date.parse(gitData.lastCommit);
    if (!Number.isNaN(t)) lastCommitMs = t;
  }

  // stale 기준: 가장 최근 활동 시각(파일 mtime 또는 커밋) 기준 staleDays 초과.
  const mostRecent = Math.max(lastModifiedMs, lastCommitMs);
  let isStale = false;
  if (mostRecent > 0) {
    isStale = Date.now() - mostRecent > staleDays * DAY_MS;
  }

  return {
    ok: true,
    data: {
      lastModified: lastModifiedMs > 0 ? new Date(lastModifiedMs).toISOString() : null,
      lastCommit: lastCommitMs > 0 ? new Date(lastCommitMs).toISOString() : null,
      isStale,
    },
    status: 'ok',
    note: null,
  };
}

module.exports = { name: 'freshness', mvp: true, collect };
