'use strict';
/**
 * mailBody.test.js — lib/mail/mailBody.js (MIME 본문 파서, 헤드리스)
 */
const { test } = require('node:test');
const assert = require('node:assert');
const mb = require('../lib/mail/mailBody');

const CRLF = '\r\n';
// [메일 인코딩] imapClient는 본문을 원시 바이트 보존(latin1 1바이트=1문자)으로 전달한다. 테스트도 같은 계약을
//   재현: 유니코드 원문을 UTF-8 바이트로 만든 뒤 latin1 문자열로(=바이트 캐리어) 변환해 parseMessage에 넣는다.
const toLatin1 = (s) => Buffer.from(s, 'utf8').toString('latin1');

test('parseMessage — 평문(UTF-8) + 헤더(RFC2047 제목)', () => {
  const raw = toLatin1('Subject: =?UTF-8?B?7JWI64WV?=' + CRLF + 'From: a@b.com' + CRLF
    + 'Content-Type: text/plain; charset=utf-8' + CRLF + CRLF + '안녕하세요' + CRLF + '본문');
  const r = mb.parseMessage(raw);
  assert.strictEqual(r.subject, '안녕');
  assert.strictEqual(r.from, 'a@b.com');
  assert.strictEqual(r.text, '안녕하세요\n본문');
});

test('parseMessage — base64 본문 디코드', () => {
  const b = Buffer.from('한글 base64 본문', 'utf8').toString('base64');
  const raw = 'Content-Type: text/plain; charset=UTF-8' + CRLF + 'Content-Transfer-Encoding: base64' + CRLF + CRLF + b;
  assert.strictEqual(mb.parseMessage(raw).text, '한글 base64 본문');
});

test('parseMessage — quoted-printable 디코드(soft break)', () => {
  const raw = 'Content-Type: text/plain; charset=utf-8' + CRLF + 'Content-Transfer-Encoding: quoted-printable' + CRLF + CRLF + 'hi=20there=' + CRLF + ' end';
  assert.strictEqual(mb.parseMessage(raw).text, 'hi there end');
});

test('[메일 인코딩] parseMessage — EUC-KR(ks_c_5601-1987) 8bit 본문 정확 디코드(한글 깨짐 회귀)', () => {
  // '한글'의 EUC-KR 바이트(0xC7D1 0xB1DB)를 latin1 캐리어로 — imapClient가 전달하는 형태.
  const eucHangul = String.fromCharCode(0xC7, 0xD1, 0xB1, 0xDB);
  const raw = 'Content-Type: text/html; charset=ks_c_5601-1987' + CRLF + CRLF + '<p>' + eucHangul + '</p>';
  assert.strictEqual(mb.parseMessage(raw).text, '한글', 'EUC-KR → 정확 디코드(이전엔 깨짐)');
});

test('parseMessage — multipart: text/plain 우선', () => {
  const raw = toLatin1(['Content-Type: multipart/alternative; boundary=XB', '', '--XB', 'Content-Type: text/plain; charset=utf-8', '', '평문 파트', '--XB', 'Content-Type: text/html; charset=utf-8', '', '<p>HTML 파트</p>', '--XB--'].join(CRLF));
  assert.strictEqual(mb.parseMessage(raw).text, '평문 파트');
});

test('parseMessage — multipart: text/plain 없으면 html→텍스트', () => {
  const raw = toLatin1(['Content-Type: multipart/alternative; boundary=YB', '', '--YB', 'Content-Type: text/html; charset=utf-8', '', '<p>안녕</p><br>줄바꿈', '--YB--'].join(CRLF));
  const t = mb.parseMessage(raw).text;
  assert.ok(t.indexOf('안녕') >= 0, 'HTML 텍스트 추출');
  assert.ok(!/[<>]/.test(t), '태그 제거됨');
});

test('htmlToText — 태그 제거·엔티티·줄바꿈', () => {
  assert.strictEqual(mb.htmlToText('A &amp; B<br>C'), 'A & B\nC');
  const t = mb.htmlToText('<p>안녕</p><div>본문</div>');
  assert.ok(!/[<>]/.test(t) && t.indexOf('안녕') >= 0 && t.indexOf('본문') >= 0);
});

test('sanitizeText — CRLF→LF·탭/개행·공백 보존·길이 절단', () => {
  assert.strictEqual(mb.sanitizeText('a\tb' + CRLF + 'c d'), 'a\tb\nc d');
  // 제어문자(NUL) 제거: 코드로 생성.
  assert.strictEqual(mb.sanitizeText('x' + String.fromCharCode(0) + 'y' + String.fromCharCode(7) + 'z'), 'xyz');
  assert.ok(mb.sanitizeText('x'.repeat(mb.MAX_TEXT + 100)).endsWith('…(이하 생략)'));
});
