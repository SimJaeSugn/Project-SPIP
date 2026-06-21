#!/usr/bin/env node
'use strict';
/**
 * server.js — 로컬 웹서버 진입점 (npm start) (R-10, N-02, M-1)
 *
 * 서빙 페이즈(설계 §4):
 *   1) 설정 로드(config.js) — port 등.
 *   2) snapshotStore 적재(projects.json 읽기, P2-5 graceful — 스냅샷 없어도 기동).
 *   3) 세션 토큰 1회 생성(M-1) + Host/Origin allowlist 구성.
 *   4) http 서버를 listen(port, '127.0.0.1')로 루프백 전용 바인딩(N-02). 자동 오픈 없음.
 *   5) 콘솔에 접속 URL + 세션 안내 출력.
 *
 * 포트 점유 시 명확한 에러로 종료(내부정보 비노출, L-3).
 *
 * 외부 의존성 0 — http(내장) + 내부 모듈.
 */

const http = require('http');
const { loadConfig } = require('./lib/common/config');
const { Logger } = require('./lib/common/logger');
const { SnapshotStore } = require('./lib/server/snapshotStore');
const security = require('./lib/server/security');
const router = require('./lib/server/router');
const { ScanController } = require('./lib/server/scanController');

/**
 * 서버를 구성해 반환한다(테스트에서 listen 없이 핸들러만 쓸 수 있게 분리).
 * @param {object} [opts] { logger, cachePath, port }
 * @returns {{ server, ctx, config, store, token }}
 */
function createServer(opts) {
  opts = opts || {};
  const logger = opts.logger || new Logger({ quiet: !!opts.quiet });

  const { config } = loadConfig({ logger });
  const port = typeof opts.port === 'number' ? opts.port : config.port;

  // 스냅샷 적재(P2-5 graceful).
  const store = new SnapshotStore();
  const loaded = store.load({ cachePath: opts.cachePath, logger });

  // 세션 토큰 1회 생성 + allowlist 구성(M-1).
  const token = security.generateSessionToken();
  // [M4 R-16] 전역 단일 ScanController(기동 시 1회 생성, ctx로 핸들러 공유).
  const scanController = new ScanController({ logger });
  const ctx = {
    store,
    token,
    config,           // [M4] rescan이 scanRoots/excludes/depthLimit/size 등 서버 config 사용(H-1)
    scanController,   // [M4] actionHandlers.rescan·apiHandlers.getScanStatus 공유
    cachePath: opts.cachePath, // [P2-2] 재스캔 finalizing write/load에 동일 경로 전파(커스텀 경로 일관)
    logger,
    hostAllow: security.buildHostAllowlist(port),
    originAllow: security.buildOriginAllowlist(port),
  };

  const server = http.createServer(router.createHandler(ctx));
  return { server, ctx, config, store, token, port, loaded, scanController };
}

async function main() {
  const logger = new Logger();
  const { server, port, loaded } = createServer({ logger });

  await new Promise((resolve, reject) => {
    server.once('error', (err) => {
      if (err && err.code === 'EADDRINUSE') {
        console.error('포트 ' + port + '이(가) 이미 사용 중입니다. 다른 프로세스를 종료하거나 설정에서 port를 변경하세요.');
      } else {
        console.error('서버를 시작하지 못했습니다.');
      }
      reject(err);
    });
    // [N-02] 루프백 전용 바인딩. 0.0.0.0 금지.
    server.listen(port, '127.0.0.1', resolve);
  });

  const url = 'http://127.0.0.1:' + port + '/';
  console.log('');
  console.log('SPIP 대시보드 서버가 시작되었습니다.');
  console.log('  접속 URL: ' + url + '  (자동으로 열리지 않습니다 — 브라우저에서 직접 여세요)');
  if (loaded.hasSnapshot) {
    console.log('  로드된 프로젝트: ' + loaded.count + '개');
  } else {
    console.log('  스냅샷이 없습니다. 먼저 "npm run scan"으로 스캔하세요(빈 상태로 동작 중).');
  }
  console.log('  세션 토큰: index.html에 자동 주입됩니다(상태변경 POST는 X-SPIP-Token 헤더 필요).');
  console.log('  종료: Ctrl+C');
  console.log('');

  // 토큰은 콘솔에 평문 노출하지 않는다(L-3) — 의도적으로 출력하지 않으며 index.html에만 주입된다.
  return server;
}

if (require.main === module) {
  main().catch((err) => {
    if (process.env.SPIP_DEBUG && err && err.stack) console.error(err.stack);
    process.exit(1);
  });
}

module.exports = { createServer, main };
