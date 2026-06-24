'use strict';
/**
 * test/ai/briefingParse.test.js — 출력 파서(구조화·평문 폴백·HTML 평문 보존) (R-37·L-1·M-3)
 */
const { test } = require('node:test');
const assert = require('node:assert');
const parse = require('../../lib/ai/briefingParse');

test('R-37 — JSON 배열 구조화 파싱', () => {
  const out = '[{"key":"k1","title":"미커밋","reason":"3개 변경","guide":"커밋하세요"}]';
  const r = parse.parseOutput(out);
  assert.strictEqual(r.structured, true);
  assert.strictEqual(r.items[0].title, '미커밋');
  assert.strictEqual(r.items[0].key, 'k1');
});

test('R-37 — 코드펜스 감싼 JSON도 추출', () => {
  const out = '```json\n[{"title":"a","reason":"b"}]\n```';
  const r = parse.parseOutput(out);
  assert.strictEqual(r.structured, true);
  assert.strictEqual(r.items[0].title, 'a');
});

test('R-37 — 잡음 섞인 JSON 관대 추출', () => {
  const out = '여기 결과입니다:\n[{"title":"x"}]\n이상입니다.';
  const r = parse.parseOutput(out);
  assert.strictEqual(r.structured, true);
});

test('R-37 — 비-JSON 자유 텍스트 → 평문 폴백(크래시 0)', () => {
  const out = '오늘은 미커밋 변경이 3개 있습니다. 커밋을 권장합니다.';
  const r = parse.parseOutput(out);
  assert.strictEqual(r.structured, false);
  assert.ok(r.items[0].reason.includes('미커밋'));
});

test('L-1/M-3 — HTML/script 문자열 평문 보존(변환 0)', () => {
  const out = '<script>alert(1)</script> <b>bold</b>';
  const r = parse.parseOutput(out);
  assert.strictEqual(r.structured, false);
  // 평문 그대로(HTML로 변환·이스케이프 디코드 안 함).
  assert.ok(r.items[0].reason.includes('<script>'));
  assert.ok(r.items[0].reason.includes('</script>'));
});

test('M-3 — JSON 항목 내 HTML도 평문 보존', () => {
  const out = '[{"title":"<img src=x onerror=evil>","reason":"r"}]';
  const r = parse.parseOutput(out);
  assert.strictEqual(r.items[0].title, '<img src=x onerror=evil>');
});

test('빈/널 입력 graceful', () => {
  assert.deepStrictEqual(parse.parseOutput('').items, []);
  assert.deepStrictEqual(parse.parseOutput(null).items, []);
  assert.strictEqual(parse.parseOutput(undefined).ok, true);
});

test('빈 항목(title/reason/guide 전부 없음)은 폐기', () => {
  const r = parse.parseOutput('[{"key":"k","x":1}]');
  // 표현 필드 없음 → 구조화 항목 0 → 평문 폴백.
  assert.strictEqual(r.structured, false);
});
