'use strict';
/**
 * deps-installed.test.js — 선언된 런타임 의존성이 실제로 설치·해석 가능한지 검증.
 *
 * 배경: package.json dependencies에 선언만 되고 node_modules에 설치되지 않으면,
 *   electron-builder가 번들하지 못해 배포된 앱에서 require가 즉시 실패한다(브리핑 연결 'INTERNAL').
 *   다른 단위 테스트는 chatFactory 목을 주입해 실제 모듈을 부르지 않으므로 이 누락을 못 잡는다.
 *   이 테스트는 모든 런타임 의존성을 require.resolve 해 빌드 전에 누락을 차단한다(릴리즈 게이트).
 */
const { test } = require('node:test');
const assert = require('node:assert');
const pkg = require('../package.json');

test('런타임 의존성(dependencies)이 모두 설치·해석 가능(번들 누락 방지)', () => {
  const deps = Object.keys(pkg.dependencies || {});
  assert.ok(deps.length > 0, 'dependencies가 비어 있지 않아야 한다');
  for (const dep of deps) {
    assert.doesNotThrow(
      () => require.resolve(dep),
      dep + ' 가 설치돼 있어야 한다 — 미설치 시 빌드에 번들되지 않아 배포 앱에서 require 실패',
    );
  }
});
