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

// ── M3: SEARCH / ENVELOPE / RFC2047 ──
test('parseSearchUids — UID 배열 / 미일치 빈 배열', () => {
  const { parseSearchUids } = require('../lib/mail/imapProtocol');
  assert.deepStrictEqual(parseSearchUids('* SEARCH 5 9 12'), [5, 9, 12]);
  assert.deepStrictEqual(parseSearchUids('* SEARCH'), []);
  assert.deepStrictEqual(parseSearchUids('* OK nope'), []);
});

test('parseSexp — 중첩/NIL/따옴표 이스케이프', () => {
  const { parseSexp } = require('../lib/mail/imapProtocol');
  assert.deepStrictEqual(parseSexp('("a" NIL ("b" "c"))'), ['a', null, ['b', 'c']]);
  assert.strictEqual(parseSexp('"he\\"llo"'), 'he"llo');
  assert.strictEqual(parseSexp('NIL'), null);
});

test('decodeMimeHeader — B/Q 인코딩 + 평문', () => {
  const { decodeMimeHeader } = require('../lib/mail/imapProtocol');
  assert.strictEqual(decodeMimeHeader('=?UTF-8?B?7JWI64WV?='), '안녕');
  assert.strictEqual(decodeMimeHeader('=?UTF-8?Q?hi=20there?='), 'hi there');
  assert.strictEqual(decodeMimeHeader('plain text'), 'plain text');
  assert.strictEqual(decodeMimeHeader(null), null);
});

test('parseFetchEnvelope — uid/subject(디코드)/from(이름 우선)', () => {
  const { parseFetchEnvelope } = require('../lib/mail/imapProtocol');
  const line = '* 1 FETCH (UID 34 ENVELOPE ("Wed, 01 Jan 2026" "=?UTF-8?B?7YWM7Iqk7Yq4?=" (("John Doe" NIL "john" "ex.com")) NIL NIL NIL NIL NIL NIL "<id>"))';
  assert.deepStrictEqual(parseFetchEnvelope(line), { uid: 34, date: 'Wed, 01 Jan 2026', subject: '테스트', from: 'John Doe' });
  // from 이름 없으면 mailbox@host
  const line2 = '* 2 FETCH (UID 7 ENVELOPE ("d" "s" ((NIL NIL "me" "ex.com")) NIL NIL NIL NIL NIL NIL NIL))';
  assert.strictEqual(parseFetchEnvelope(line2).from, 'me@ex.com');
  // ENVELOPE 부재 → null
  assert.strictEqual(parseFetchEnvelope('* 1 FETCH (UID 7 FLAGS (\Seen))'), null);
});
