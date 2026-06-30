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

test('[메일 인코딩] decodeCharset/normalizeCharset — EUC-KR 등 레거시 정확 디코드', () => {
  const { decodeCharset, normalizeCharset } = require('../lib/mail/imapProtocol');
  assert.strictEqual(normalizeCharset('ks_c_5601-1987'), 'euc-kr');
  assert.strictEqual(normalizeCharset('CP949'), 'euc-kr');
  assert.strictEqual(normalizeCharset(''), 'utf-8');
  // '한글'의 EUC-KR 바이트 → 정확 디코드.
  assert.strictEqual(decodeCharset(Buffer.from([0xC7, 0xD1, 0xB1, 0xDB]), 'ks_c_5601-1987'), '한글');
  // UTF-8 경로.
  assert.strictEqual(decodeCharset(Buffer.from('안녕', 'utf8'), 'utf-8'), '안녕');
  // 미지원 라벨 → utf-8 best-effort(throw 없음).
  assert.strictEqual(decodeCharset(Buffer.from('hi', 'utf8'), 'x-bogus-charset'), 'hi');
});

test('[메일 인코딩] decodeMimeHeader — EUC-KR 인코딩워드 제목 디코드', () => {
  const { decodeMimeHeader } = require('../lib/mail/imapProtocol');
  const enc = '=?ks_c_5601-1987?B?' + Buffer.from([0xC7, 0xD1, 0xB1, 0xDB]).toString('base64') + '?=';
  assert.strictEqual(decodeMimeHeader(enc), '한글');
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

test('parseListMailbox — flags/delimiter/name 파싱(따옴표·경로·특수플래그)', () => {
  const { parseListMailbox } = require('../lib/mail/imapProtocol');
  assert.deepStrictEqual(
    parseListMailbox('* LIST (\\HasNoChildren) "/" "INBOX"'),
    { flags: ['\\HasNoChildren'], delimiter: '/', name: 'INBOX' });
  assert.deepStrictEqual(
    parseListMailbox('* LIST (\\HasNoChildren \\Trash) "/" "[Gmail]/Trash"'),
    { flags: ['\\HasNoChildren', '\\Trash'], delimiter: '/', name: '[Gmail]/Trash' });
  // delimiter NIL(평면 계층)
  assert.deepStrictEqual(
    parseListMailbox('* LIST () NIL "Work"'),
    { flags: [], delimiter: null, name: 'Work' });
  // LSUB도 동일 파싱
  assert.strictEqual(parseListMailbox('* LSUB () "/" "Sent"').name, 'Sent');
  // 비-LIST 라인 → null
  assert.strictEqual(parseListMailbox('* STATUS "INBOX" (MESSAGES 1)'), null);
  assert.strictEqual(parseListMailbox('A1 OK done'), null);
});

test('isCollectibleMailbox — 휴지통/스팸/전체보관함/선택불가 제외, 일반/하위폴더 수집', () => {
  const { isCollectibleMailbox } = require('../lib/mail/imapProtocol');
  // 수집 대상
  assert.ok(isCollectibleMailbox({ flags: [], delimiter: '/', name: 'INBOX' }));
  assert.ok(isCollectibleMailbox({ flags: ['\\HasNoChildren'], delimiter: '/', name: '업무/2026' }), '사용자 폴더(하위) 수집');
  assert.ok(isCollectibleMailbox({ flags: ['\\Sent'], delimiter: '/', name: 'Sent' }), '보낸편지함은 수집 대상');
  // 플래그 기반 제외
  assert.ok(!isCollectibleMailbox({ flags: ['\\Trash'], delimiter: '/', name: 'X' }), '\\Trash 제외');
  assert.ok(!isCollectibleMailbox({ flags: ['\\Junk'], delimiter: '/', name: 'X' }), '\\Junk 제외');
  assert.ok(!isCollectibleMailbox({ flags: ['\\All'], delimiter: '/', name: '[Gmail]/All Mail' }), '\\All(전체보관함) 제외');
  assert.ok(!isCollectibleMailbox({ flags: ['\\Drafts'], delimiter: '/', name: 'X' }), '\\Drafts 제외');
  assert.ok(!isCollectibleMailbox({ flags: ['\\Noselect'], delimiter: '/', name: '[Gmail]' }), '\\Noselect 제외');
  // 이름 기반 제외(플래그 미제공 서버)
  assert.ok(!isCollectibleMailbox({ flags: [], delimiter: '/', name: '[Gmail]/Trash' }), '이름 Trash 제외');
  assert.ok(!isCollectibleMailbox({ flags: [], delimiter: '/', name: 'Spam' }), '이름 Spam 제외');
  assert.ok(!isCollectibleMailbox({ flags: [], delimiter: '/', name: '받은편지함/휴지통' }), '한글 휴지통 제외');
  assert.ok(!isCollectibleMailbox({ flags: [], delimiter: '/', name: '스팸편지함' }), '한글 스팸 제외');
  // 잘못된 입력
  assert.ok(!isCollectibleMailbox(null));
  assert.ok(!isCollectibleMailbox({ name: '' }));
});

test('parseFetchFlags — FLAGS에서 uid/seen/deleted 추출', () => {
  const { parseFetchFlags } = require('../lib/mail/imapProtocol');
  assert.deepStrictEqual(parseFetchFlags('* 3 FETCH (UID 12 FLAGS (\\Seen \\Answered))'), { uid: 12, seen: true, deleted: false });
  assert.deepStrictEqual(parseFetchFlags('* 4 FETCH (UID 13 FLAGS ())'), { uid: 13, seen: false, deleted: false });
  assert.strictEqual(parseFetchFlags('* 5 FETCH (UID 9 FLAGS (\\Deleted))').deleted, true);
  // FLAGS 부재 → null
  assert.strictEqual(parseFetchFlags('* 1 FETCH (UID 7 ENVELOPE ("d" "s" NIL NIL NIL NIL NIL NIL NIL NIL))'), null);
});

test('decodeModifiedUtf7 — 한글 메일함명(modified UTF-7) 디코드', () => {
  const { decodeModifiedUtf7 } = require('../lib/mail/imapProtocol');
  assert.strictEqual(decodeModifiedUtf7('&vBvHQNO4ycDVaA-'), '받은편지함');
  assert.strictEqual(decodeModifiedUtf7('&vPSwuNO4ycDVaA-'), '보낸편지함');
  assert.strictEqual(decodeModifiedUtf7('[Gmail]/&yATMtLz0rQDVaA-'), '[Gmail]/전체보관함'); // ASCII 경로 + 한글 혼합
  assert.strictEqual(decodeModifiedUtf7('INBOX'), 'INBOX'); // ASCII는 그대로
  assert.strictEqual(decodeModifiedUtf7('Tom &- Jerry'), 'Tom & Jerry'); // '&-' → '&'
  // 손상/비문자열 graceful
  assert.strictEqual(decodeModifiedUtf7('&abc'), '&abc'); // 닫힘 없음 → 원문 보존
  assert.strictEqual(decodeModifiedUtf7(null), '');
});
