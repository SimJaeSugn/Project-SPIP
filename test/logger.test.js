'use strict';
/**
 * logger.test.js — sanitizeForUser 경로 마스킹·제어문자 제거·warnings 누적 (L-3/H-3 토대)
 */
const { test } = require('node:test');
const assert = require('node:assert');

const { Logger, sanitizeForUser, clampString } = require('../lib/common/logger');

test('sanitizeForUser: Windows 절대경로 마스킹(L-3)', () => {
  const out = sanitizeForUser('실패: C:\\Users\\me\\secret\\proj 접근 불가');
  assert.ok(!out.includes('C:\\Users'), out);
  assert.ok(out.includes('<path>'), out);
});

test('sanitizeForUser: POSIX 절대경로 마스킹(L-3)', () => {
  const out = sanitizeForUser('cannot read /home/me/.ssh/id_rsa now');
  assert.ok(!out.includes('/home/me'), out);
  assert.ok(out.includes('<path>'), out);
});

test('clampString: 제어문자 제거 + 길이 절단(H-3)', () => {
  // 리터럴 제어문자를 소스에 두지 않기 위해 fromCharCode로 구성.
  const ctrlRe = new RegExp('[\\u0000-\\u001F\\u007F]');
  const dirty = 'na' + String.fromCharCode(0) + 'me' + String.fromCharCode(9) + 'x';
  const clean = clampString(dirty, 100);
  assert.ok(!ctrlRe.test(clean), JSON.stringify(clean));
  const long = clampString('z'.repeat(50), 10);
  assert.ok(long.length <= 11); // 10 + 말줄임표
});

test('Logger.warn: warnings[] 누적', () => {
  const logger = new Logger({ quiet: true });
  logger.warn('권한 없음', { path: 'C:\\x' });
  logger.warn('손상 파일');
  const ws = logger.getWarnings();
  assert.strictEqual(ws.length, 2);
  assert.strictEqual(ws[0].reason, '권한 없음');
  assert.strictEqual(ws[0].path, 'C:\\x');
});
