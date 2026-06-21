'use strict';
/**
 * lib/scan/collectors/size.js — 규모/의존성 (R-09) — M4
 *
 * 프로젝트 총 용량(totalBytes)·node_modules 용량(nodeModulesBytes)·의존성 개수(deps/devDeps)를
 * 수집한다. node_modules는 walker 순회 제외 대상이지만 크기는 재야 하므로 여기서 직접 stat한다.
 *
 * [N-01/H-3 성능 가드 — 약화 불가]
 *   · opt-in: 용량 측정은 config.size.enabled(또는 rescan withSize)일 때만. 기본은 skipped.
 *   · deps/devDeps: package.json을 가드 거쳐 읽어 키 개수만 센다 → enabled 무관 항상 수집(저비용).
 *   · 시간 상한(budgetMs)·깊이 상한(maxDepth)·entry 상한(maxEntries) 도달 시 측정 중단 +
 *     측정분까지 보고 + data.status='partial'.
 *   · node_modules: 기본 top-level 근사(직속 패키지 디렉터리 합산). deepNodeModules:true면 전체 순회.
 *   · 심링크 미추적(lstat) — 루프·이중계상 방지.
 *
 * [§4.1.1 2레이어 status 분리 — P2-3]
 *   · 계약 status(res.status): 'ok'|'na'|'error' — runCollectors의 N-05 격리/error 집계용.
 *       측정 성공/부분/미측정(skipped) → 'ok'(비활성은 'na'), 격리 오류만 'error'.
 *   · 도메인 status(res.data.status): 'ok'|'partial'|'skipped'|'error' — 프론트 표시 품질 신호.
 *   두 필드는 다른 값을 가질 수 있다(예: res.status='ok' + res.data.status='partial').
 *
 * collect(projectPath, ctx) -> { ok, data, status, note }
 *
 * 외부 의존성 0 — fs, path만 + 내부(_safeParse).
 */

const fs = require('fs');
const path = require('path');
const safeParse = require('./_safeParse');

/** dependencies/devDependencies 객체의 키 개수(항상 저비용). */
function countDeps(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return 0;
  let n = 0;
  for (const k in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, k)) n++;
  }
  return n;
}

/**
 * 디렉터리 트리의 파일 크기를 합산한다(예산·깊이·entry 상한, 심링크 미추적).
 * @param {string} rootDir 측정 시작 디렉터리(canonical)
 * @param {object} budget { deadlineTs, maxDepth, maxEntries, state:{ entries, truncated } }
 * @returns {number} 합산 바이트(측정분까지)
 */
function measureTree(rootDir, budget) {
  let total = 0;
  const stack = [{ dir: rootDir, depth: 0 }];

  while (stack.length > 0) {
    // 상한 도달 시 즉시 중단(측정분까지 유효, partial).
    if (budget.state.entries >= budget.maxEntries) { budget.state.truncated = true; break; }
    if (Date.now() > budget.deadlineTs) { budget.state.truncated = true; break; }

    const { dir, depth } = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      continue; // 권한 거부 등 격리(N-05)
    }
    for (const ent of entries) {
      if (budget.state.entries >= budget.maxEntries) { budget.state.truncated = true; break; }
      // [OBS-M4-02] 단일 디렉터리 내부 파일 루프에도 시간예산 점검(maxEntries 외 안전망).
      //   수만 파일이 한 디렉터리에 평면으로 있어도 시간 상한을 넘기면 즉시 절단(partial).
      if (Date.now() > budget.deadlineTs) { budget.state.truncated = true; break; }
      budget.state.entries++;
      if (ent.isSymbolicLink()) continue; // 미추적(루프·이중계상 방지)
      if (ent.isDirectory()) {
        if (depth >= budget.maxDepth) { budget.state.truncated = true; continue; }
        stack.push({ dir: path.join(dir, ent.name), depth: depth + 1 });
        continue;
      }
      if (!ent.isFile()) continue;
      try {
        const st = fs.lstatSync(path.join(dir, ent.name));
        if (st.isFile()) total += st.size;
      } catch (_) { /* 격리 */ }
    }
  }
  return total;
}

/**
 * node_modules 크기 측정. 기본 top-level 근사(직속 항목까지), deep이면 전체 순회.
 * @returns {number}
 */
function measureNodeModules(nmDir, budget, deep) {
  if (deep) {
    return measureTree(nmDir, budget);
  }
  // top-level 근사: node_modules 직속 항목만 한 단계 측정(maxDepth=1 효과).
  const localBudget = {
    deadlineTs: budget.deadlineTs,
    maxDepth: 1,
    maxEntries: budget.maxEntries,
    state: budget.state,
  };
  return measureTree(nmDir, localBudget);
}

/**
 * 규모/의존성 수집(R-09).
 * @param {string} projectPath canonical 실경로
 * @param {object} ctx { config, signals, logger, limits }
 * @returns {{ ok, data, status, note }}
 */
function collect(projectPath, ctx) {
  ctx = ctx || {};
  const cfg = (ctx.config && ctx.config.size) || {};
  const limits = ctx.limits || {};

  // 1) deps/devDeps — enabled 무관 항상 수집(package.json 가드 파싱).
  let deps = null;
  let devDeps = null;
  const pkgPath = path.join(projectPath, 'package.json');
  try {
    if (fs.existsSync(pkgPath)) {
      const parsed = safeParse.parseJsonGuarded(pkgPath, limits);
      if (parsed.ok && parsed.value && typeof parsed.value === 'object') {
        deps = countDeps(parsed.value.dependencies);
        devDeps = countDeps(parsed.value.devDependencies);
      }
    }
  } catch (_) { /* 격리(N-05) — deps null 유지 */ }

  // 2) 용량 측정 — opt-in(미활성이면 skipped로 자리만).
  const enabled = cfg.enabled === true;
  if (!enabled) {
    return {
      ok: true,
      // 계약 status: 비활성은 'na'(수집기가 의도적으로 측정 안 함).
      status: 'na',
      // 도메인 status: 'skipped'(MVP와 동일 — 프론트 "미측정").
      data: { status: 'skipped', totalBytes: null, nodeModulesBytes: null, deps, devDeps },
      note: 'size 용량 측정 비활성(opt-in)',
    };
  }

  const budgetMs = typeof cfg.budgetMs === 'number' && cfg.budgetMs > 0 ? cfg.budgetMs : 1500;
  const maxDepth = typeof cfg.maxDepth === 'number' && cfg.maxDepth > 0 ? cfg.maxDepth : 6;
  const maxEntries = typeof cfg.maxEntries === 'number' && cfg.maxEntries > 0 ? cfg.maxEntries : 50000;
  const deep = cfg.deepNodeModules === true;

  const budget = {
    deadlineTs: Date.now() + budgetMs,
    maxDepth,
    maxEntries,
    state: { entries: 0, truncated: false },
  };

  let totalBytes = null;
  let nodeModulesBytes = null;
  try {
    // 프로젝트 본문(node_modules 제외 측정) — node_modules는 별도 합산해 이중계상 방지.
    // measureTree는 node_modules도 포함하므로, 여기선 프로젝트 전체를 잰 뒤 node_modules 별도 표기.
    totalBytes = measureTree(projectPath, budget);

    const nmDir = path.join(projectPath, 'node_modules');
    let nmExists = false;
    try { nmExists = fs.statSync(nmDir).isDirectory(); } catch (_) { nmExists = false; }
    if (nmExists) {
      // [P2-1 주석 정정] nodeModulesBytes는 totalBytes에 **가산하지 않는다**(표시용 부분집합).
      //   measureTree(projectPath)가 node_modules를 이미 포함 측정하므로 totalBytes에 이미 반영됨.
      //   여기 nodeModulesBytes는 "그중 node_modules가 차지하는 부분"을 별도 표기할 뿐이다.
      //   entry 카운터(state)를 공유하므로 본문 측정이 maxEntries를 거의 소진하면 이 값은
      //   과소측정될 수 있다(그 경우 truncated=true로 도메인 status가 partial이 되어 신호됨).
      const nmBudget = {
        deadlineTs: budget.deadlineTs,
        maxDepth,
        maxEntries,
        state: budget.state, // 동일 entry 카운터 공유(전체 상한 준수)
      };
      nodeModulesBytes = measureNodeModules(nmDir, nmBudget, deep);
    }
  } catch (err) {
    if (ctx.logger) ctx.logger.error('size 측정 실패', err);
    return {
      ok: true,
      status: 'error', // 계약 status: 격리된 오류
      data: { status: 'error', totalBytes: null, nodeModulesBytes: null, deps, devDeps },
      note: 'size 측정 중 오류',
    };
  }

  const partial = budget.state.truncated === true;
  return {
    ok: true,
    // 계약 status: 측정 성공/부분 모두 'ok'(수집기는 정상 완주). partial은 도메인 status로만.
    status: 'ok',
    data: {
      status: partial ? 'partial' : 'ok',
      totalBytes,
      nodeModulesBytes,
      deps,
      devDeps,
    },
    note: partial ? '예산/상한 도달로 부분 측정' : null,
  };
}

module.exports = { name: 'size', mvp: false, collect, countDeps, measureTree };
