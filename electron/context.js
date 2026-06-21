'use strict';
/**
 * electron/context.js — composition root (server.js 승계, electron-migration §7.1 단계 1)
 *
 * server.js의 createServer가 하던 "조립" 중 HTTP 무관 부분만 승계한다:
 *   config 로드 → snapshotStore 적재(P2-5 graceful) → 전역 단일 ScanController 생성.
 * HTTP 전용(http.createServer·listen·세션토큰·Host/Origin allowlist)은 전부 드롭(§6.1).
 *
 * [헤드리스 검증, F-3] Electron API 미import. buildContext는 ctx 형태
 *   { config, store, scanController, cachePath, logger }를 반환하며 단위테스트 가능.
 *
 * 외부 의존성 0 — 내부(config, logger, snapshotStore, scanController)만.
 */

const { loadConfig } = require('../lib/common/config');
const { Logger } = require('../lib/common/logger');
const { SnapshotStore } = require('../lib/server/snapshotStore');
const { ScanController } = require('../lib/server/scanController');

/**
 * 앱 컨텍스트를 조립해 반환한다.
 * @param {object} [opts] { logger, cachePath, quiet }
 * @returns {{ config, store, scanController, cachePath, logger, loaded }}
 */
function buildContext(opts) {
  opts = opts || {};
  const logger = opts.logger || new Logger({ quiet: !!opts.quiet });

  const { config } = loadConfig({ logger });

  const store = new SnapshotStore();
  const loaded = store.load({ cachePath: opts.cachePath, logger });

  const scanController = new ScanController({ logger });

  return {
    config,
    store,
    scanController,
    cachePath: opts.cachePath, // 미지정이면 lib가 기본 경로(paths.cachePath) 사용
    logger,
    loaded,
  };
}

module.exports = { buildContext };
