'use strict';
/**
 * lib/scan/collectors/language.js — 주 언어/스택 추정 (R-06, 보안 H-3·L-1)
 *
 * package.json 의존성 + 파일 확장자 비율로 주 언어/스택을 추정한다. 불명 시 "Unknown".
 *
 * [H-3] 파싱 앞단 가드(_safeParse): ① 파일 크기 상한·② 바이트 한도·③ JSON 깊이 가드.
 *   ④ 모든 매칭은 정확 일치(Set/문자열 비교)·확장자 비교만 사용 → 선형시간(ReDoS-free,
 *   정규식 백트래킹 없음). ⑤ name/description은 길이 절단 + 제어문자 제거 후 반환.
 *
 * 수집기 공통 계약: collect(projectPath, ctx) -> { ok, data, status, note }
 *
 * 외부 의존성 0 — fs, path만 + 내부(_safeParse).
 */

const fs = require('fs');
const path = require('path');
const safeParse = require('./_safeParse');
const { SAMPLE_SKIP_DIRS } = require('../excludeRules'); // P2-4: 표본 스킵 폴더 단일 원천

// 확장자 → 언어 매핑(정확 일치, ReDoS 없음).
const EXT_LANG = Object.freeze({
  '.js': 'JavaScript', '.mjs': 'JavaScript', '.cjs': 'JavaScript', '.jsx': 'JavaScript',
  '.ts': 'TypeScript', '.tsx': 'TypeScript',
  '.py': 'Python',
  '.rs': 'Rust',
  '.go': 'Go',
  '.java': 'Java', '.kt': 'Kotlin',
  '.rb': 'Ruby',
  '.php': 'PHP',
  '.cs': 'C#',
  '.cpp': 'C++', '.cc': 'C++', '.cxx': 'C++', '.hpp': 'C++',
  '.c': 'C', '.h': 'C',
  '.swift': 'Swift',
  '.dart': 'Dart',
  '.vue': 'Vue', '.svelte': 'Svelte',
  '.sh': 'Shell',
  '.html': 'HTML', '.css': 'CSS', '.scss': 'CSS',
});

// package.json deps → 스택 라벨(정확 일치 Set). 우선순위 순.
const DEP_STACK = Object.freeze([
  { dep: 'next', label: 'Next.js' },
  { dep: 'nuxt', label: 'Nuxt' },
  { dep: '@angular/core', label: 'Angular' },
  { dep: 'react', label: 'React' },
  { dep: 'vue', label: 'Vue' },
  { dep: 'svelte', label: 'Svelte' },
  { dep: 'express', label: 'Express' },
  { dep: 'fastify', label: 'Fastify' },
  { dep: 'electron', label: 'Electron' },
]);

// 확장자 카운팅에서 무시할 디렉터리(P2-4: excludeRules.SAMPLE_SKIP_DIRS 단일 원천 사용).
const SKIP_DIRS = SAMPLE_SKIP_DIRS;

// 확장자 집계 시 순회할 최대 엔트리 수(자원 통제 — 거대 트리 방어).
const MAX_FILES_SAMPLED = 4000;
const MAX_SUBDIRS = 64; // 1단계만 얕게 표본(주언어 추정엔 충분)

/**
 * 프로젝트 루트의 확장자 비율을 얕게 표본 집계한다(선형, 자원 상한).
 * @returns {Object<string, number>} 언어 -> 파일수
 */
function sampleExtensions(projectPath) {
  const counts = Object.create(null);
  let sampled = 0;
  // 너비 우선 얕은 표본: 루트 + 직속 하위 디렉터리 1단계.
  const queue = [{ dir: projectPath, depth: 0 }];
  let subdirsSeen = 0;

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
      if (ent.isDirectory()) {
        const lower = ent.name.toLowerCase();
        if (SKIP_DIRS.has(lower) || lower.startsWith('.')) continue;
        if (depth < 1 && subdirsSeen < MAX_SUBDIRS) {
          subdirsSeen++;
          queue.push({ dir: path.join(dir, ent.name), depth: depth + 1 });
        }
        continue;
      }
      if (!ent.isFile()) continue;
      const ext = path.extname(ent.name).toLowerCase();
      const lang = EXT_LANG[ext];
      if (lang) {
        counts[lang] = (counts[lang] || 0) + 1;
        sampled++;
      }
    }
  }
  return counts;
}

/**
 * deps 객체에서 스택 라벨을 추정한다(정확 일치, ReDoS 없음).
 * @returns {string|null}
 */
function stackFromDeps(deps) {
  if (!deps || typeof deps !== 'object') return null;
  for (const { dep, label } of DEP_STACK) {
    if (Object.prototype.hasOwnProperty.call(deps, dep)) return label;
  }
  return null;
}

/**
 * 언어/스택 수집(R-06).
 * @param {string} projectPath canonical 실경로
 * @param {object} ctx { config, signals, logger, limits }
 * @returns {{ ok, data, status, note }}
 */
function collect(projectPath, ctx) {
  ctx = ctx || {};
  const limits = ctx.limits || {};
  const result = {
    primary: 'Unknown',
    breakdown: {}, // 언어 -> 비율(0~1)
    name: null,
    description: null,
  };

  // 1) package.json (있으면) — 가드 거쳐 파싱.
  const pkgPath = path.join(projectPath, 'package.json');
  let pkgStack = null;
  let isNode = false;
  try {
    if (fs.existsSync(pkgPath)) {
      const parsed = safeParse.parseJsonGuarded(pkgPath, limits);
      if (parsed.ok && parsed.value && typeof parsed.value === 'object') {
        isNode = true;
        const pkg = parsed.value;
        result.name = safeParse.sanitizeField(pkg.name, limits.maxStringField);
        result.description = safeParse.sanitizeField(pkg.description, limits.maxStringField);
        const allDeps = Object.assign({}, pkg.dependencies, pkg.devDependencies);
        pkgStack = stackFromDeps(allDeps);
      } else if (ctx.logger && parsed.reason && parsed.reason !== 'PARSE_FAIL') {
        ctx.logger.warn('package.json 입력 가드로 건너뜀: ' + parsed.reason, { path: pkgPath });
      }
    }
  } catch (_) {
    // 격리(N-05) — 전체 수집은 계속.
  }

  // 2) 확장자 비율 표본.
  let extCounts = {};
  try {
    extCounts = sampleExtensions(projectPath);
  } catch (_) {
    extCounts = {};
  }

  const total = Object.values(extCounts).reduce((a, b) => a + b, 0);
  if (total > 0) {
    for (const [lang, n] of Object.entries(extCounts)) {
      result.breakdown[lang] = Math.round((n / total) * 1000) / 1000;
    }
  }

  // 3) primary 결정: 스택 라벨 우선 → 확장자 최다 → Node.js → Unknown.
  if (pkgStack) {
    result.primary = pkgStack;
  } else if (total > 0) {
    let topLang = 'Unknown';
    let topN = -1;
    for (const [lang, n] of Object.entries(extCounts)) {
      if (n > topN) { topN = n; topLang = lang; }
    }
    // TS/JS 위주이고 package.json 있으면 Node.js로 라벨.
    if (isNode && (topLang === 'JavaScript' || topLang === 'TypeScript')) {
      result.primary = topLang === 'TypeScript' ? 'TypeScript (Node.js)' : 'Node.js';
    } else {
      result.primary = topLang;
    }
  } else if (isNode) {
    result.primary = 'Node.js';
  }

  return {
    ok: true,
    data: { primary: result.primary, breakdown: result.breakdown, name: result.name, description: result.description },
    status: 'ok',
    note: null,
  };
}

module.exports = { name: 'language', mvp: true, collect, EXT_LANG, DEP_STACK };
