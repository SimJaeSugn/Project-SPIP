'use strict';
/**
 * homeLayout-equivalence.test.js — R-32 동형 분리 동치 검증(R-25 교훈).
 *   프런트 applyHomeLayout(public/app.js)과 백엔드 normalizeHomeLayout(lib/common/uiStateStore.js)이
 *   동일 입력에 동일 출력을 내는지 *동작*으로 강제(텍스트 매칭이 못 잡는 알고리즘 분기 방지).
 */
const { test } = require('node:test');
const assert = require('node:assert');

const { applyHomeLayout, HOME_SECTION_IDS } = require('../public/app.js');
const { normalizeHomeLayout } = require('../lib/common/uiStateStore');

const CASES = [
  // [설명, 입력]
  ['유효 순열', ['mail', 'attention', 'disk', 'todos', 'activity', 'productivity', 'featureAdd']],
  ['기본 순서', HOME_SECTION_IDS.slice()],
  ['부분(2개)', ['mail', 'todos']],
  ['부분(1개)', ['featureAdd']],
  ['중복 포함', ['mail', 'mail', 'attention', 'attention']],
  ['오염(미지 id)', ['mail', 'bogus', 'evil', 'attention']],
  ['비문자열 혼입', ['mail', 123, null, undefined, {}, 'todos']],
  ['전부 미지', ['x', 'y', 'z']],
  ['빈 배열', []],
  ['비배열-null', null],
  ['비배열-undefined', undefined],
  ['비배열-문자열', 'mail'],
  ['비배열-객체', { 0: 'mail' }],
  ['역순', HOME_SECTION_IDS.slice().reverse()],
];

for (const [desc, input] of CASES) {
  test('R-32 동치 — ' + desc + ': applyHomeLayout ≡ normalizeHomeLayout', () => {
    const front = applyHomeLayout(input);
    const back = normalizeHomeLayout(input);
    assert.deepStrictEqual(front, back, '프런트·백엔드 정규화 출력이 동일해야 한다');
    // 두 결과 모두 항상 전체 섹션 순열(불변식)도 함께 확인.
    assert.strictEqual(front.length, HOME_SECTION_IDS.length);
    assert.strictEqual(new Set(front).size, HOME_SECTION_IDS.length);
  });
}

test('R-32 동치 — 무작위 입력 다수에 대해 출력 동치(퍼즈 근사)', () => {
  const pool = HOME_SECTION_IDS.concat(['bogus', 'x', '', '123']);
  for (let i = 0; i < 200; i++) {
    const len = Math.floor(Math.random() * 10);
    const input = [];
    for (let j = 0; j < len; j++) input.push(pool[Math.floor(Math.random() * pool.length)]);
    assert.deepStrictEqual(applyHomeLayout(input), normalizeHomeLayout(input),
      '입력=' + JSON.stringify(input));
  }
});
