'use strict';
/**
 * lib/scan/collectors/index.js — 수집기 레지스트리 (S0 골격, 실제 구현 S2)
 *
 * 수집기 공통 계약: collect(project, ctx) -> { ok, data, status, note }
 *   계약 status(res.status): 'ok' | 'na' | 'error' (§4.1.1 — runCollectors N-05 격리·error 집계용)
 *   도메인 status(res.data.status): 'ok' | 'partial' | 'skipped' | 'error' (프론트 표시 신호; size 도입분)
 *
 * MVP/M4 플래그로 활성 수집기를 관리한다. S0에서는 자리만 확보하고,
 * language/freshness/git(MVP)·size(M4)는 S2에서 채운다.
 *
 * limits: 부분신뢰 입력 방어 공통 기본값(H-3) — S2에서 각 수집기가 사용.
 *
 * 외부 의존성 0.
 */

const LIMITS = Object.freeze({
  maxFileBytes: 1024 * 1024, // package.json 등 1MB 상한(H-3)
  maxReadBytes: 1024 * 1024,
  maxJsonDepth: 64,
  maxStringField: 1000, // name/description/branch 절단 길이(H-3/L-1)
});

// S2: 수집기 등록. 파일 1개=수집기 1개(변화 격리). git은 async collect.
const registry = [
  { name: 'language', mvp: true, load: () => require('./language') },
  { name: 'git', mvp: true, load: () => require('./git') },
  { name: 'freshness', mvp: true, load: () => require('./freshness') }, // git 결과(lastCommit) 활용 위해 뒤
  { name: 'size', mvp: false, load: () => require('./size') },
];

/**
 * 활성 수집기 디스크립터 목록을 반환.
 *   · 기본(MVP): mvp:true 수집기(language·git·freshness). MVP 회귀 유지.
 *   · [M4 R-09 / BUG-M4-01] size 수집기는 **항상 로드**한다. 설계(§8.1·§396·§429)가
 *     "deps/devDeps는 size.enabled와 무관하게 항상 저비용 수집"을 약속하므로, 수집기를
 *     opt-in일 때만 로드하면 기본 스캔에서 deps/devDeps가 영영 null이 되는 계약 위반이 된다.
 *     - 용량 측정(totalBytes/nodeModulesBytes)은 size.collect 내부에서 config.size.enabled
 *       (또는 rescan withSize)로 게이트된다 → 비활성이면 status='na'/data.status='skipped'로
 *       totalBytes=null을 그대로 반환(MVP 회귀 0·성능 N-01 보존). deps/devDeps만 항상 채운다.
 *   · includeSize 인자는 후방호환을 위해 남기되, size 로드 여부에는 더 이상 영향을 주지 않는다
 *     (용량 측정 게이트는 ctx.config.size.enabled가 단일 출처).
 * @param {object} [opts] (미사용 — 후방호환 시그니처 유지)
 */
function activeCollectors(opts) {
  opts = opts || {};
  // size 포함 전체 활성 수집기. 용량 측정 opt-in은 size.collect 내부 enabled 게이트가 담당.
  return registry.slice();
}

/** 활성 수집기 모듈을 로드해 반환(scanner가 사용). */
function loadActiveCollectors(opts) {
  return activeCollectors(opts).map((d) => d.load());
}

module.exports = { LIMITS, registry, activeCollectors, loadActiveCollectors };
