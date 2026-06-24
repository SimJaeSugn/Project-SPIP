'use strict';
/**
 * imapProtocol.test.js — lib/mail/imapProtocol.js (순수 파서/인용, 헤드리스)
 */
const { test } = require('node:test');
const assert = require('node:assert');

const { imapQuote, parseTaggedLine, parseStatusItems } = require('../lib/mail/imapProtocol');

test('imapQuote — 따옴표/역슬래시 이스케이프', () => {
  assert.strictEqual(imapQuote('INBOX'), '"INBOX"');
  assert.strictEqual(imapQuote('a"b'), '"a\\"b"');
  assert.strictEqual(imapQuote('a\\b'), '"a\\\\b"');
  assert.strictEqual(imapQuote(null), '""');
});

test('parseTaggedLine — OK/NO/BAD 파싱 + 텍스트', () => {
  assert.deepStrictEqual(parseTaggedLine('A1 OK LOGIN completed'),
    { tag: 'A1', status: 'OK', text: 'LOGIN completed' });
  assert.deepStrictEqual(parseTaggedLine('A2 NO [AUTHENTICATIONFAILED] nope'),
    { tag: 'A2', status: 'NO', text: '[AUTHENTICATIONFAILED] nope' });
});

test('parseTaggedLine — 비태그드(*)·형식 불일치는 null', () => {
  assert.strictEqual(parseTaggedLine('* OK ready'), null, '* 는 비태그드');
  assert.strictEqual(parseTaggedLine('garbage'), null);
  assert.strictEqual(parseTaggedLine(null), null);
});

test('parseTaggedLine — tag 지정 시 불일치는 null', () => {
  assert.strictEqual(parseTaggedLine('A1 OK done', 'A2'), null);
  assert.ok(parseTaggedLine('A2 OK done', 'A2'));
});

test('parseStatusItems — STATUS 항목 추출(키 소문자화)', () => {
  assert.deepStrictEqual(
    parseStatusItems('* STATUS "INBOX" (MESSAGES 3 UNSEEN 1 UIDNEXT 5)'),
    { messages: 3, unseen: 1, uidnext: 5 });
});

test('parseStatusItems — 괄호/내용 부재 시 빈 객체', () => {
  assert.deepStrictEqual(parseStatusItems('* STATUS "INBOX"'), {});
  assert.deepStrictEqual(parseStatusItems('* STATUS "INBOX" ()'), {});
  assert.deepStrictEqual(parseStatusItems(null), {});
});

test('parseStatusItems — 숫자 아닌 값은 건너뜀', () => {
  assert.deepStrictEqual(parseStatusItems('* STATUS "X" (UIDNEXT 9 FOO bar)'), { uidnext: 9 });
});
