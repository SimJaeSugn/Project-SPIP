'use strict';
/**
 * scanner.test.js — 오케스트레이션·직렬화·격리·스키마 (R-14, N-05, N-06, M-2)
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const scanner = require('../lib/scan/scanner');
const serializer = require('../lib/scan/serializer');
const { Logger } = require('../lib/common/logger');
const fx = require('./fixtures/build');

function quiet() { return new Logger({ quiet: true }); }

test('scan: 탐지 픽스처에서 프로젝트 수집 + 스키마 형태(§8.1)', async () => {
  const root = fx.buildDetectionSet();
  const snap = await scanner.scan({ roots: [root], excludes: [], staleDays: 90, logger: quiet() });

  assert.strictEqual(snap.schemaVersion, 1);
  assert.ok(typeof snap.generatedAt === 'string');
  assert.ok(Array.isArray(snap.scanRoots));
  assert.ok(typeof snap.durationMs === 'number');
  assert.ok(snap.counts && typeof snap.counts.projects === 'number');
  assert.ok(Array.isArray(snap.warnings));
  assert.ok(Array.isArray(snap.projects));
  assert.ok(snap.counts.projects >= 4, '4개 이상 프로젝트');

  const p = snap.projects.find((x) => x.name === 'my-node-app');
  assert.ok(p, 'package.json name 사용');
  // Project 항목 필드 형태 검증.
  assert.ok(typeof p.id === 'string' && p.id.length > 0);
  assert.ok(path.isAbsolute(p.path));
  assert.ok(Array.isArray(p.signals));
  assert.ok(p.language && typeof p.language.primary === 'string');
  assert.ok(p.freshness && typeof p.freshness.isStale === 'boolean');
  assert.ok(p.git && (p.git.status === 'ok' || p.git.status === 'na'));
  assert.strictEqual(p.size.status, 'skipped'); // M4 자리
});

test('N-05 격리: 손상/적대적 입력 섞여도 전체 스캔 완주', async () => {
  const detectRoot = fx.buildDetectionSet();
  const advRoot = fx.buildAdversarialSet();
  const logger = quiet();
  // 두 루트 + 미존재 루트를 함께.
  const snap = await scanner.scan({
    roots: [detectRoot, advRoot, path.join(os.tmpdir(), 'spip-missing-' + Date.now())],
    excludes: [],
    staleDays: 90,
    logger,
  });
  // 죽지 않고 스냅샷이 나온다.
  assert.ok(snap.counts.projects >= 4);
  // 적대적 입력(bigpkg/ctrlpkg 등)도 항목으로 포함되되 크래시 없음.
  assert.ok(snap.projects.length >= 4);
});

test('N-05: collect가 throw하는 악성 수집기도 격리(전체 완주)', async () => {
  // buildProject/runCollectors가 throw를 흡수하는지 직접 검증.
  const root = fx.buildDetectionSet();
  // language 모듈을 임시로 throw하게 monkeypatch.
  const language = require('../lib/scan/collectors/language');
  const orig = language.collect;
  language.collect = () => { throw new Error('boom'); };
  try {
    const snap = await scanner.scan({ roots: [root], logger: quiet() });
    assert.ok(snap.counts.projects >= 1, '수집기 throw에도 프로젝트 집계');
    assert.ok(snap.counts.errors >= 1, '오류 격리 카운트');
  } finally {
    language.collect = orig;
  }
});

test('serializer: 원자적 쓰기 + 스키마 정합 + 0600 권한(N-06, M-2)', () => {
  const root = fx.buildDetectionSet();
  const cacheDir = fx.mkRoot('spip-cache-');
  const cachePath = path.join(cacheDir, 'projects.json');

  const snap = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    scanRoots: [root],
    durationMs: 10,
    counts: { projects: 1, stale: 0, errors: 0 },
    warnings: [{ path: 'x', reason: 'test' }],
    projects: [{ id: 'a', path: root, name: 'p', signals: [], language: { primary: 'Unknown', breakdown: {} } }],
  };
  const out = serializer.writeSnapshot(snap, { cachePath, logger: quiet() });
  assert.strictEqual(out.path, cachePath);
  assert.ok(fs.existsSync(cachePath));

  const parsed = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  assert.strictEqual(parsed.schemaVersion, 1);
  assert.strictEqual(parsed.counts.projects, 1);

  // 권한 확인(POSIX). Windows는 mode가 무시될 수 있어 0600 단언 생략.
  if (process.platform !== 'win32') {
    const mode = fs.statSync(cachePath).mode & 0o777;
    assert.strictEqual(mode, 0o600, '0600 권한');
  }
  // 임시 파일이 남지 않음.
  const leftovers = fs.readdirSync(cacheDir).filter((f) => f.endsWith('.tmp'));
  assert.strictEqual(leftovers.length, 0, '임시 파일 정리됨');
});

test('serializer: 누락 필드 normalize로 보정', () => {
  const n = serializer.normalizeSnapshot({});
  assert.strictEqual(n.schemaVersion, 1);
  assert.deepStrictEqual(n.counts, { projects: 0, stale: 0, errors: 0 });
  assert.deepStrictEqual(n.projects, []);
});
