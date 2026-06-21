'use strict';
/**
 * lib/server/snapshotStore.js — 스냅샷 메모리 적재 + realpath 화이트리스트 (R-10, R-13, H-1, P2-5)
 *
 * 기동 시 cachePath의 projects.json을 1회 읽어 메모리에 적재한다(서빙은 읽기만, 스캔 안 함).
 *   · projects[]를 보유하고, id→project 역참조 Map을 구성한다(actionHandlers가 id로 역참조, R-12).
 *   · 화이트리스트 비교용 폴드 키 Set을 pathGuard.buildAllowedKeySet으로 1회 구성한다(H-1).
 *   · [P2-5] 파일 부재/손상/스키마 위반 시 throw하지 않고 hasSnapshot:false + 빈 상태로 graceful 적재.
 *     서버는 스냅샷이 없어도 크래시 0으로 기동한다(R-13).
 *
 * 외부 의존성 0 — fs(내장) + 내부(paths, pathGuard, logger).
 */

const fs = require('fs');
const paths = require('../common/paths');
const pathGuard = require('../common/pathGuard');
const { defaultLogger } = require('../common/logger');

class SnapshotStore {
  constructor() {
    this._reset();
  }

  _reset() {
    this.hasSnapshot = false;
    this.schemaVersion = 1;
    this.generatedAt = null;
    this.projects = [];
    // [M4 §4.3] 스냅샷 집계 통계(totalBytes). 없으면 null(MVP 캐시·미측정).
    this.stats = { totalBytes: null };
    this._byId = new Map();      // id -> project
    this._allowKeys = new Set(); // pathGuard 폴드 키 집합(H-1)
  }

  /**
   * 캐시 파일을 읽어 적재한다. 실패해도 throw하지 않고 빈 상태로 graceful 적재(P2-5).
   * @param {object} [opts] { cachePath, logger }
   * @returns {{ hasSnapshot:boolean, count:number }}
   */
  load(opts) {
    opts = opts || {};
    const logger = opts.logger || defaultLogger;
    const file = opts.cachePath || paths.cachePath();

    this._reset();

    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (err) {
      // 부재(ENOENT)는 정상적인 "아직 스캔 안 함" 상태(R-13).
      if (!err || err.code !== 'ENOENT') {
        logger.warn('스냅샷 파일을 읽지 못해 빈 상태로 기동합니다');
      }
      return { hasSnapshot: false, count: 0 };
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (_) {
      logger.warn('스냅샷 파일이 손상되어 빈 상태로 기동합니다');
      return { hasSnapshot: false, count: 0 };
    }

    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.projects)) {
      logger.warn('스냅샷 형식이 올바르지 않아 빈 상태로 기동합니다');
      return { hasSnapshot: false, count: 0 };
    }

    // 정상 적재. 항목 단위로 최소 검증해 손상 항목은 건너뛴다(N-05).
    const projects = [];
    const byId = new Map();
    const allowPaths = [];
    for (const p of parsed.projects) {
      if (!p || typeof p !== 'object') continue;
      if (typeof p.id !== 'string' || typeof p.path !== 'string') continue;
      projects.push(p);
      byId.set(p.id, p);
      allowPaths.push(p.path); // 스캐너가 이미 canonicalize한 실경로(H-1 원천)
    }

    this.hasSnapshot = true;
    this.schemaVersion = typeof parsed.schemaVersion === 'number' ? parsed.schemaVersion : 1;
    this.generatedAt = typeof parsed.generatedAt === 'string' ? parsed.generatedAt : null;
    // [M4 §4.3] stats.totalBytes 적재(없으면 null). getStats가 읽기만 한다(O(1)).
    this.stats = {
      totalBytes:
        parsed.stats && typeof parsed.stats === 'object' && typeof parsed.stats.totalBytes === 'number'
          ? parsed.stats.totalBytes
          : null,
    };
    this.projects = projects;
    this._byId = byId;
    // 화이트리스트 폴드 키 Set 1회 구성(H-1). isAllowed가 요청 경로를 canonicalize 후 대조.
    this._allowKeys = pathGuard.buildAllowedKeySet(allowPaths);

    return { hasSnapshot: true, count: projects.length };
  }

  /** id로 프로젝트를 역참조한다(R-12). 없으면 null. */
  getById(id) {
    if (typeof id !== 'string') return null;
    return this._byId.get(id) || null;
  }

  /** 화이트리스트 폴드 키 Set(H-1) — pathGuard.isAllowed의 두 번째 인자로 사용. */
  getAllowKeySet() {
    return this._allowKeys;
  }

  /** 적재된 프로젝트 배열(얕은 복사 — 외부 변형 방지). 항목 객체는 공유(읽기 전용 사용 전제). */
  getProjects() {
    return Array.isArray(this.projects) ? this.projects.slice() : [];
  }

  /**
   * [R-24 상태 주시] 적재된 프로젝트의 가변 신호(git·freshness)를 in-place 갱신한다.
   *   StateWatcher가 재스캔 없이 주기적으로 재수집한 결과를 메모리 스냅샷에 반영하는 단일 진입점.
   *   path·id·name·language·size 등 스캔이 확정한 식별/구조 필드는 건드리지 않는다(불변).
   *   디스크 영속은 하지 않는다 — 라이브 오버레이는 메모리 한정이며 영속은 재스캔만 담당.
   * @param {string} id
   * @param {object} git §8.1 project.git shape
   * @param {object} freshness §8.1 project.freshness shape
   * @returns {object|null} 갱신된 project(없는 id면 null)
   */
  applyLiveState(id, git, freshness) {
    if (typeof id !== 'string') return null;
    const p = this._byId.get(id);
    if (!p) return null;
    if (git && typeof git === 'object') p.git = git;
    if (freshness && typeof freshness === 'object') p.freshness = freshness;
    return p;
  }
}

module.exports = { SnapshotStore };
