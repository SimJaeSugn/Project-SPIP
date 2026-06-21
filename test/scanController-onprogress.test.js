'use strict';
/**
 * scanController-onprogress.test.js — start(opts).onProgress 파라미터 추가 검증 (F-1)
 *
 * scanner.scan을 모킹해(require 캐시 주입은 불가하므로 onProgress 동작을 간접 검증)
 * onProgress 콜백이 status()를 받고, 기존 _merge 동작이 보존되며, 세대 가드를 지키는지 확인.
 *
 * 회귀 방지: onProgress 미지정(기존 호출 형태)에서도 정상 동작.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const Module = require('module');
const path = require('path');

const { Logger } = require('../lib/common/logger');

/**
 * scanner/serializer를 모킹한 ScanController를 새로 로드한다(require 캐시 격리).
 * scanner.scan은 onProgress를 여러 번 호출한 뒤 스냅샷을 반환한다.
 */
function loadControllerWithMockScanner(scanImpl) {
  const scannerPath = require.resolve('../lib/scan/scanner');
  const serializerPath = require.resolve('../lib/scan/serializer');
  const controllerPath = require.resolve('../lib/server/scanController');

  const origLoad = Module._load;
  const restore = () => { Module._load = origLoad; };

  Module._load = function (request, parent, isMain) {
    const resolved = (() => { try { return Module._resolveFilename(request, parent); } catch (_) { return request; } })();
    if (resolved === scannerPath) return { scan: scanImpl };
    if (resolved === serializerPath) return { writeSnapshot: () => ({ path: 'x', bytes: 0 }), normalizeSnapshot: (s) => s };
    return origLoad.apply(this, arguments);
  };

  delete require.cache[controllerPath];
  let mod;
  try {
    mod = require(controllerPath);
  } finally {
    restore();
    delete require.cache[controllerPath]; // 후속 테스트에 실제 모듈 복원
  }
  return mod;
}

test('start(opts).onProgress — status()로 진행을 받는다 + _merge 보존', async () => {
  const progressCalls = [];
  const scanImpl = async (opts) => {
    // scanner가 onProgress(ScanProgress)를 호출 → 컨트롤러 내부 _merge + 사용자 콜백.
    opts.onProgress({ dirs: 3, found: 1, currentPath: '/abs/proj/a' });
    opts.onProgress({ dirs: 10, found: 2, currentPath: '/abs/proj/b' });
    return { counts: { projects: 2, stale: 0, errors: 0 }, projects: [] };
  };
  const { ScanController } = loadControllerWithMockScanner(scanImpl);
  const c = new ScanController({ logger: new Logger({ quiet: true }) });

  c.acquire();
  c.start({
    config: { scanRoots: ['/abs/proj'] },
    store: { load: () => {} },
    logger: new Logger({ quiet: true }),
    onProgress: (snap) => progressCalls.push(snap),
  });

  // 백그라운드 run이 settle할 때까지 대기.
  await new Promise((r) => setTimeout(r, 30));

  // scanning(2) + finalizing(1) + done(1) = 4회 push. (이전엔 scanning 2회만 push되어
  //   renderer가 done을 못 받아 scanning 뷰에 갇혔다 — 무한 로딩 버그.)
  const phases = progressCalls.map((p) => p.phase);
  assert.deepStrictEqual(phases, ['scanning', 'scanning', 'finalizing', 'done']);
  // status() 형태(shortenPath 축약된 currentPath)로 전달.
  assert.strictEqual(progressCalls[0].dirs, 3);
  assert.strictEqual(progressCalls[1].dirs, 10);
  assert.strictEqual(progressCalls[1].currentPath, 'proj/b'); // shortenPath(M4-H-1) — 절대경로 미노출
  // 내부 _merge 동작 보존: 최종 state도 갱신됨.
  assert.strictEqual(c.status().found, 2);
});

test('[회귀] start.onProgress — done phase가 반드시 push된다(무한 로딩 방지)', async () => {
  // 근본 원인: finalizing→done 전이가 onProgress로 push되지 않으면 push 모델(R-15)엔
  //   폴링이 없어 renderer가 done을 영영 못 받고 scanning 뷰에 갇힌다(무한 로딩).
  //   done push 1건이 반드시 발생해야 한다(scanId 일치 + phase==='done').
  const progressCalls = [];
  const scanImpl = async (opts) => {
    opts.onProgress({ dirs: 7, found: 3, currentPath: '/abs/proj/x' });
    return { counts: { projects: 3, stale: 0, errors: 0 }, projects: [] };
  };
  const { ScanController } = loadControllerWithMockScanner(scanImpl);
  const c = new ScanController({ logger: new Logger({ quiet: true }) });

  const acq = c.acquire();
  c.start({
    config: { scanRoots: ['/abs/proj'] },
    store: { load: () => {} },
    logger: new Logger({ quiet: true }),
    onProgress: (snap) => progressCalls.push(snap),
  });
  await new Promise((r) => setTimeout(r, 30));

  const donePush = progressCalls.find((p) => p.phase === 'done');
  assert.ok(donePush, 'done phase가 onProgress로 최소 1회 push되어야 한다');
  // scanId 대조(M4-L-1): push된 scanId가 acquire가 발급한 것과 일치해야 renderer가 refetch.
  assert.strictEqual(donePush.scanId, acq.scanId, 'done push의 scanId == acquire scanId');
  // finalizing도 push되어 마무리 표시가 가능해야 한다.
  assert.ok(progressCalls.some((p) => p.phase === 'finalizing'), 'finalizing phase도 push');
});

test('[회귀] start.onProgress — error phase도 push된다(오류 화면 전환)', async () => {
  const progressCalls = [];
  const scanImpl = async () => { throw new Error('scan blew up'); };
  const { ScanController } = loadControllerWithMockScanner(scanImpl);
  const c = new ScanController({ logger: new Logger({ quiet: true }) });
  c.acquire();
  c.start({
    config: {}, store: { load: () => {} }, logger: new Logger({ quiet: true }),
    onProgress: (snap) => progressCalls.push(snap),
  });
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(progressCalls.some((p) => p.phase === 'error'), 'error phase가 push되어야 한다');
});

test('start — onProgress 미지정(기존 호출 형태)도 정상 동작(회귀 0)', async () => {
  const scanImpl = async (opts) => {
    opts.onProgress({ dirs: 5, found: 1 });
    return { counts: { projects: 1 }, projects: [] };
  };
  const { ScanController } = loadControllerWithMockScanner(scanImpl);
  const c = new ScanController({ logger: new Logger({ quiet: true }) });
  c.acquire();
  assert.doesNotThrow(() => c.start({ config: {}, store: { load: () => {} }, logger: new Logger({ quiet: true }) }));
  await new Promise((r) => setTimeout(r, 30));
  assert.strictEqual(c.status().dirs, 5);
});

test('start — onProgress 콜백 예외는 격리(스캔 진행 무영향)', async () => {
  const scanImpl = async (opts) => {
    opts.onProgress({ dirs: 1 });
    return { counts: {}, projects: [] };
  };
  const { ScanController } = loadControllerWithMockScanner(scanImpl);
  const c = new ScanController({ logger: new Logger({ quiet: true }) });
  c.acquire();
  c.start({
    config: {}, store: { load: () => {} }, logger: new Logger({ quiet: true }),
    onProgress: () => { throw new Error('subscriber boom'); },
  });
  await new Promise((r) => setTimeout(r, 30));
  assert.strictEqual(c.status().phase, 'done'); // 예외에도 정상 완료
});
