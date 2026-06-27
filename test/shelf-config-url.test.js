'use strict';
/**
 * shelf-config-url.test.js — config.validateHttpUrl 일반화 (SH-1)
 *   브리핑 검증 로직을 일반 http(s) URL 검증으로 일반화. validateBriefingUrl은 별칭 보존(회귀 0).
 */
const { test } = require('node:test');
const assert = require('node:assert');
const config = require('../lib/common/config');

test('SH-1 validateHttpUrl — scheme 화이트리스트(http/https만)', () => {
  assert.strictEqual(config.validateHttpUrl('https://github.com').ok, true);
  assert.strictEqual(config.validateHttpUrl('http://example.com/x').ok, true);
  assert.strictEqual(config.validateHttpUrl('file:///etc/passwd').ok, false);
  assert.strictEqual(config.validateHttpUrl('javascript:alert(1)').ok, false);
  assert.strictEqual(config.validateHttpUrl('ftp://h/x').ok, false);
});

test('SH-1 validateHttpUrl — 임베디드 자격증명 거부', () => {
  assert.strictEqual(config.validateHttpUrl('http://user:pass@host/x').ok, false);
  assert.strictEqual(config.validateHttpUrl('http://user@host/x').ok, false);
});

test('SH-1 validateHttpUrl — 길이 상한·비문자열', () => {
  assert.strictEqual(config.validateHttpUrl('http://h/' + 'a'.repeat(3000)).ok, false);
  assert.strictEqual(config.validateHttpUrl('https://h/' + 'a'.repeat(10), { maxLen: 12 }).ok, false);
  assert.strictEqual(config.validateHttpUrl(42).ok, false);
  assert.strictEqual(config.validateHttpUrl(null).ok, false);
  assert.strictEqual(config.validateHttpUrl('').ok, false);
});

test('SH-1 validateHttpUrl — external(비-localhost) 플래그', () => {
  assert.strictEqual(config.validateHttpUrl('http://127.0.0.1:1234/v1').external, false);
  assert.strictEqual(config.validateHttpUrl('http://localhost/x').external, false);
  assert.strictEqual(config.validateHttpUrl('https://github.com').external, true);
});

test('SH-1 validateBriefingUrl — 별칭 보존(반환형·동작 불변)', () => {
  const a = config.validateBriefingUrl('http://127.0.0.1:1234/v1');
  assert.deepStrictEqual(a, { ok: true, value: 'http://127.0.0.1:1234/v1', external: false });
  assert.strictEqual(config.validateBriefingUrl('file:///x').ok, false);
});
