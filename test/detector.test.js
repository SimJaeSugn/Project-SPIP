'use strict';
/**
 * detector.test.js — 프로젝트 판별·중첩 최상위 1건 (R-01, N-05)
 */
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const walker = require('../lib/scan/walker');
const detector = require('../lib/scan/detector');
const pathGuard = require('../lib/common/pathGuard');
const { Logger } = require('../lib/common/logger');
const fx = require('./fixtures/build');

function quiet() { return new Logger({ quiet: true }); }

test('신호(.git/package.json/.vscode 등)로 프로젝트 판별(R-01)', () => {
  const root = fx.buildDetectionSet();
  const candidates = walker.walk([root], { logger: quiet() });
  const projects = Array.from(detector.detectStream(candidates, { logger: quiet() }));
  const names = projects.map((p) => path.basename(p.path).toLowerCase());

  assert.ok(names.includes('node-proj'), 'node-proj 탐지');
  assert.ok(names.includes('py-proj'), 'py-proj 탐지');
  assert.ok(names.includes('git-only'), 'git-only 탐지');
  assert.ok(names.includes('nested'), 'nested 탐지');
  assert.ok(!names.includes('plain'), 'plain은 비프로젝트');
});

test('중첩 프로젝트는 최상위 1건만 집계(R-01)', () => {
  const root = fx.buildDetectionSet();
  const candidates = walker.walk([root], { logger: quiet() });
  const projects = Array.from(detector.detectStream(candidates, { logger: quiet() }));
  const folded = projects.map((p) => pathGuard.foldForCompare(p.path));
  // nested는 잡히고 nested/inner는 스킵.
  assert.ok(folded.some((p) => p.endsWith('nested')), 'nested 최상위 1건');
  assert.ok(!folded.some((p) => p.endsWith(path.join('nested', 'inner').toLowerCase())), 'inner 스킵');
});

test('탐지 신호 배열 반환(signals)', () => {
  const root = fx.buildDetectionSet();
  const candidates = walker.walk([root], { logger: quiet() });
  const projects = Array.from(detector.detectStream(candidates, { logger: quiet() }));
  const py = projects.find((p) => path.basename(p.path) === 'py-proj');
  // 시그널 토큰은 이제 매칭된 패턴 문자열(설정 기반). py-proj 는 .git + pyproject.toml 보유.
  assert.ok(py && py.signals.includes('.git') && py.signals.includes('pyproject.toml'));
});
