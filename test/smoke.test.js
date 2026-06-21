'use strict';
/**
 * smoke.test.js — 모듈 로드 무오류 + 하니스 동작 확인 (S0 DoD ①⑤)
 * node:test 채택(test/README.md 참조).
 */
const { test } = require('node:test');
const assert = require('node:assert');

test('harness alive', () => {
  assert.strictEqual(1 + 1, 2);
});

test('공용 모듈이 오류 없이 로드된다 (DoD ①)', () => {
  assert.doesNotThrow(() => require('../lib/common/paths'));
  assert.doesNotThrow(() => require('../lib/common/config'));
  assert.doesNotThrow(() => require('../lib/common/logger'));
  assert.doesNotThrow(() => require('../lib/common/safeExec'));
  assert.doesNotThrow(() => require('../lib/scan/collectors'));
});
