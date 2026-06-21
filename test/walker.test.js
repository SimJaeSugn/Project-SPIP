'use strict';
/**
 * walker.test.js — DFS 순회·제외·심링크 루프·깊이 상한 (R-02, N-05, H-1, M-3)
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const walker = require('../lib/scan/walker');
const pathGuard = require('../lib/common/pathGuard');
const { Logger } = require('../lib/common/logger');
const fx = require('./fixtures/build');

function quiet() { return new Logger({ quiet: true }); }

test('제외 폴더(node_modules/dist) 하위 재귀 미진입(R-02)', () => {
  const root = fx.buildDetectionSet();
  const dirs = Array.from(walker.walk([root], { logger: quiet() }));
  const joined = dirs.map((d) => pathGuard.foldForCompare(d));
  // node_modules 경로가 후보에 없어야 한다.
  assert.ok(!joined.some((d) => d.includes('node_modules')), 'node_modules는 순회 제외');
  // dist도 제외.
  assert.ok(!joined.some((d) => d.endsWith(path.sep + 'dist') || d.includes(path.sep + 'dist' + path.sep)), 'dist 제외');
});

test('등록 경로가 realpath(canonical)로 정규화됨(H-1)', () => {
  const root = fx.buildDetectionSet();
  const dirs = Array.from(walker.walk([root], { logger: quiet() }));
  for (const d of dirs) {
    assert.ok(path.isAbsolute(d), '후보는 절대 실경로');
    // 다시 canonicalize해도 동일(이미 실경로).
    assert.strictEqual(pathGuard.foldForCompare(pathGuard.canonicalize(d)), pathGuard.foldForCompare(d));
  }
});

test('심링크 루프(a→b→a)에서 무한루프 없이 종료(M-3)', () => {
  const root = fx.mkRoot('spip-loop-');
  fx.mkdir(path.join(root, 'a'));
  fx.mkdir(path.join(root, 'b'));
  // a/toB → b, b/toA → a (루프)
  const m1 = fx.trySymlink(path.join(root, 'b'), path.join(root, 'a', 'toB'));
  const m2 = fx.trySymlink(path.join(root, 'a'), path.join(root, 'b', 'toA'));
  // 심링크 권한이 없으면(또는 미생성) 일반 디렉터리만으로도 종료 확인.
  const dirs = Array.from(walker.walk([root], { logger: quiet() }));
  assert.ok(dirs.length > 0 && dirs.length < 1000, '유한 종료');
  // 심링크는 기본 미추적이므로 toB/toA는 후보에 없어야 한다.
  if (m1 || m2) {
    const folded = dirs.map((d) => pathGuard.foldForCompare(d));
    assert.ok(!folded.some((d) => d.endsWith('tob') || d.endsWith('toa')), '심링크 미추적');
  }
});

test('안전 깊이 상한 초과 시 하위 중단(M-3)', () => {
  const root = fx.mkRoot('spip-depth-');
  // SAFE_MAX_DEPTH+5 깊이 생성.
  let p = root;
  for (let i = 0; i < walker.SAFE_MAX_DEPTH + 5; i++) p = path.join(p, 'd' + i);
  fx.mkdir(p);
  const logger = quiet();
  const dirs = Array.from(walker.walk([root], { logger }));
  // 깊이 상한 경고가 누적되어야 한다.
  assert.ok(logger.getWarnings().some((w) => /깊이 상한/.test(w.reason)), '깊이 상한 경고');
  // 최대 깊이를 넘는 디렉터리는 방출되지 않음.
  const maxObserved = Math.max(...dirs.map((d) => d.split(path.sep).length));
  assert.ok(maxObserved <= root.split(path.sep).length + walker.SAFE_MAX_DEPTH + 1);
});

test('읽기 실패 폴더는 격리하고 전체 순회 계속(N-05)', () => {
  const root = fx.buildDetectionSet();
  // 존재하지 않는 루트를 섞어도 다른 루트는 순회됨.
  const logger = quiet();
  const dirs = Array.from(walker.walk(['/no/such/root/xyz123', root], { logger }));
  assert.ok(dirs.length > 0);
  assert.ok(logger.getWarnings().length >= 1);
});
