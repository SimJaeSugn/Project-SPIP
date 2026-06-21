'use strict';
/**
 * lib/server/stateWatcher.js — 상태 주시(라이브 갱신) 워처 (R-24, ADR-M8-1)
 *
 * 한 번 스캔으로 발견된 프로젝트들의 *가변 신호*(git·freshness)를 재스캔(파일시스템 워크) 없이
 * 주기적으로 재수집해, 변경된 항목만 onUpdate 콜백으로 통지한다(main이 renderer에 push). 무거운
 * walker/detector/size 수집은 돌리지 않는다 — 이미 확정된 known project 경로에 git·freshness
 * 수집기만 적용한다(저비용·N-01 성능 보존). 다음 재스캔이 store.load()로 목록을 교체하면 워처는
 * 매 tick store.getProjects()를 다시 읽어 자동으로 새 목록을 주시한다.
 *
 * 보안:
 *   H-1: 각 프로젝트 경로를 pathGuard.canonicalize로 재해석한 뒤에만 수집한다. 소멸/이탈(null)은 건너뛴다.
 *        git 수집기는 resolveBin('git') 절대경로 + `git -C <path>`(H-2)라 위장 git.exe 미선택.
 *   L-3: onUpdate 페이로드는 이미 스냅샷이 노출하는 §8.1 project shape만 담는다(추가 경로·내부정보 비노출).
 *   재진입 방지: tick은 직전 tick이 끝나야 다음이 돈다(_busy 가드). 스캔 중(isScanning)이면 tick 건너뜀.
 *   가용성: setInterval 타이머는 unref — 워처가 프로세스 종료를 막지 않는다.
 *
 * [헤드리스 검증, F-3] Electron API 미import. 수집기·canonicalize를 deps로 주입해 단위테스트 가능.
 *
 * 외부 의존성 0 — 내부(collectors registry, pathGuard) + 주입 가능 deps.
 */

const pathGuard = require('../common/pathGuard');
const collectorsRegistry = require('../scan/collectors');
const { defaultLogger } = require('../common/logger');

const DEFAULT_INTERVAL_MS = 15000;
const MIN_INTERVAL_MS = 3000;

/** collected.git → §8.1 project.git shape(순수, scanner.buildProject와 동형). */
function normalizeGit(git) {
  git = (git && typeof git === 'object') ? git : {};
  const ok = git.status === 'ok';
  return {
    status: ok ? 'ok' : 'na',
    isRepo: !!git.isRepo,
    branch: ok ? (git.branch != null ? git.branch : null) : null,
    dirty: ok ? !!git.dirty : null,
    ahead: ok ? (typeof git.ahead === 'number' ? git.ahead : null) : null,
    behind: ok ? (typeof git.behind === 'number' ? git.behind : null) : null,
  };
}

/** collected.freshness → §8.1 project.freshness shape(순수, scanner.buildProject와 동형). */
function normalizeFreshness(fresh) {
  fresh = (fresh && typeof fresh === 'object') ? fresh : {};
  return {
    lastModified: fresh.lastModified != null ? fresh.lastModified : null,
    lastCommit: fresh.lastCommit != null ? fresh.lastCommit : null,
    isStale: !!fresh.isStale,
  };
}

/** 두 git/freshness 묶음이 다른지(순수). 표시에 영향을 주는 필드만 비교. */
function stateChanged(prev, next) {
  const pg = (prev && prev.git) || {};
  const ng = next.git;
  if (pg.status !== ng.status || pg.isRepo !== ng.isRepo || pg.branch !== ng.branch
    || pg.dirty !== ng.dirty || pg.ahead !== ng.ahead || pg.behind !== ng.behind) return true;
  const pf = (prev && prev.freshness) || {};
  const nf = next.freshness;
  if (pf.lastModified !== nf.lastModified || pf.lastCommit !== nf.lastCommit || pf.isStale !== nf.isStale) return true;
  return false;
}

class StateWatcher {
  constructor(opts) {
    opts = opts || {};
    this.logger = opts.logger || defaultLogger;
    const want = typeof opts.intervalMs === 'number' && Number.isFinite(opts.intervalMs)
      ? opts.intervalMs : DEFAULT_INTERVAL_MS;
    this.intervalMs = Math.max(MIN_INTERVAL_MS, want);
    // 주입 가능 deps(테스트): 수집기·canonicalize.
    this._git = opts.gitCollector || require('../scan/collectors/git');
    this._freshness = opts.freshnessCollector || require('../scan/collectors/freshness');
    this._canonicalize = opts.canonicalize || pathGuard.canonicalize;
    this._timer = null;
    this._busy = false;
    this._store = null;
    this._config = {};
    this._onUpdate = null;
    this._isScanning = () => false;
  }

  isRunning() { return this._timer !== null; }

  /**
   * 주시 시작(멱등). 주기 setInterval로 tick을 돈다.
   * @param {object} opts { store, config, onUpdate, isScanning, setInterval? }
   *   - onUpdate({ projects:[<§8.1 project>] }) — 변경된 항목만(없으면 호출 안 함).
   *   - isScanning() => boolean — true면 tick을 건너뛴다(재스캔과 경합 방지).
   */
  start(opts) {
    opts = opts || {};
    this._store = opts.store || null;
    this._config = opts.config || {};
    this._onUpdate = typeof opts.onUpdate === 'function' ? opts.onUpdate : null;
    this._isScanning = typeof opts.isScanning === 'function' ? opts.isScanning : (() => false);
    if (this._timer) return; // 이미 동작 중 — 멱등
    const setIv = (typeof opts.setInterval === 'function') ? opts.setInterval : setInterval;
    this._timer = setIv(() => { this.tick(); }, this.intervalMs);
    if (this._timer && typeof this._timer.unref === 'function') this._timer.unref();
  }

  /** 주시 중지(멱등). */
  stop() {
    if (this._timer) {
      try { clearInterval(this._timer); } catch (_) { /* noop */ }
      this._timer = null;
    }
  }

  /**
   * 한 번의 주시 패스. known project 경로마다 git·freshness 재수집 → 변경분만 store 반영 + onUpdate.
   * 직전 tick 진행 중(_busy)이거나 스캔 중이면 즉시 반환.
   * @returns {Promise<Array>} 이번 tick에 갱신된 project 배열(테스트용).
   */
  async tick() {
    if (this._busy) return [];
    if (this._isScanning && this._isScanning()) return [];
    const store = this._store;
    if (!store || typeof store.getProjects !== 'function') return [];
    const projects = store.getProjects();
    if (!Array.isArray(projects) || projects.length === 0) return [];

    this._busy = true;
    const updates = [];
    try {
      for (const p of projects) {
        if (this._isScanning && this._isScanning()) break; // 도중 스캔이 시작되면 중단(경합 방지)
        if (!p || typeof p.id !== 'string' || typeof p.path !== 'string') continue;
        const real = this._canonicalize(p.path);
        if (!real) continue; // 소멸/이탈 — 건너뜀(H-1)
        let next;
        try {
          next = await this._recollect(real);
        } catch (err) {
          if (this.logger && this.logger.error) this.logger.error('상태 재수집 실패', err);
          continue;
        }
        if (!next) continue;
        if (!stateChanged(p, next)) continue;
        const applied = (typeof store.applyLiveState === 'function')
          ? store.applyLiveState(p.id, next.git, next.freshness)
          : this._mutateInPlace(p, next);
        if (applied) updates.push(applied);
      }
      if (updates.length && this._onUpdate) {
        try { this._onUpdate({ projects: updates }); } catch (_) { /* 구독자 예외 격리 */ }
      }
    } catch (err) {
      if (this.logger && this.logger.error) this.logger.error('상태 주시 tick 실패', err);
    } finally {
      this._busy = false;
    }
    return updates;
  }

  /** 단일 경로에 git→freshness 수집기를 적용해 정규화된 { git, freshness } 산출. */
  async _recollect(realPath) {
    const baseCtx = { config: this._config, logger: this.logger, limits: collectorsRegistry.LIMITS };
    let gitData;
    try {
      const r = await this._git.collect(realPath, baseCtx);
      gitData = (r && r.data) || { status: 'na' };
    } catch (_) {
      gitData = { status: 'na' };
    }
    let freshData;
    try {
      const r = this._freshness.collect(realPath, Object.assign({}, baseCtx, { collected: { git: gitData } }));
      freshData = (r && r.data) || {};
    } catch (_) {
      freshData = {};
    }
    return { git: normalizeGit(gitData), freshness: normalizeFreshness(freshData) };
  }

  /** store가 applyLiveState를 제공하지 않는 경우의 폴백(객체 직접 변형). */
  _mutateInPlace(p, next) {
    p.git = next.git;
    p.freshness = next.freshness;
    return p;
  }
}

module.exports = { StateWatcher, normalizeGit, normalizeFreshness, stateChanged, DEFAULT_INTERVAL_MS, MIN_INTERVAL_MS };
