'use strict';
/**
 * imapClient.test.js — lib/mail/imapClient.js (가짜 소켓 주입, 네트워크 없이 헤드리스)
 *   · fetchInboxStatus: connect→login→status→logout 흐름 + STATUS 파싱
 *   · LOGIN 실패(NO) 시 거절
 *   · 자격이 IMAP quoted-string으로 전송되는지(LOGIN 명령 검증)
 */
const { test } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');

const { ImapClient } = require('../lib/mail/imapClient');

/**
 * 가짜 IMAP 서버 소켓. connect 직후 그리팅을 보내고, write된 명령에 nextTick으로 응답한다.
 * @param {object} resp { loginOk?:bool, status?:string } — 시나리오 제어.
 */
function fakeSocket(resp) {
  resp = resp || {};
  const s = new EventEmitter();
  s.written = [];
  s.setTimeout = () => {};
  s.end = () => {};
  s.destroy = () => {};
  s.feed = (line) => s.emit('data', Buffer.from(line + '\r\n'));
  s.write = (data) => {
    s.written.push(data);
    const tag = String(data).split(' ')[0];
    process.nextTick(() => {
      if (/\bLOGIN\b/i.test(data)) {
        s.feed(resp.loginOk === false ? (tag + ' NO [AUTHENTICATIONFAILED] bad creds') : (tag + ' OK LOGIN completed'));
      } else if (/\bSTATUS\b/i.test(data)) {
        s.feed(resp.status || '* STATUS "INBOX" (MESSAGES 3 UNSEEN 2 UIDNEXT 10)');
        s.feed(tag + ' OK STATUS completed');
      } else if (/\bLOGOUT\b/i.test(data)) {
        s.feed('* BYE logging out');
        s.feed(tag + ' OK LOGOUT completed');
      }
    });
    return true;
  };
  return s;
}

function makeClient(sock, over) {
  return new ImapClient(Object.assign({
    host: 'imap.test', port: 993, user: 'u', pass: 'p',
    connect: () => { process.nextTick(() => sock.feed('* OK IMAP4 ready')); return sock; },
  }, over));
}

test('fetchInboxStatus — 전체 흐름 + STATUS 파싱', async () => {
  const sock = fakeSocket();
  const client = makeClient(sock);
  const st = await client.fetchInboxStatus('INBOX');
  assert.deepStrictEqual(st, { messages: 3, unseen: 2, uidnext: 10 });
  // LOGOUT까지 전송됐는지.
  assert.ok(sock.written.some((c) => /LOGOUT/.test(c)), 'LOGOUT 전송');
});

test('fetchInboxStatus — 자격은 IMAP quoted-string으로 전송', async () => {
  const sock = fakeSocket();
  const client = makeClient(sock, { user: 'me', pass: 'pa"ss' });
  await client.fetchInboxStatus('INBOX');
  const login = sock.written.find((c) => /LOGIN/.test(c));
  assert.ok(login.includes('"me"'), 'user quoted');
  assert.ok(login.includes('"pa\\"ss"'), 'pass quoted+escaped');
});

test('fetchInboxStatus — LOGIN 실패(NO) 시 거절 + authFailed 표식', async () => {
  const sock = fakeSocket({ loginOk: false });
  const client = makeClient(sock);
  await assert.rejects(
    () => client.fetchInboxStatus('INBOX'),
    (err) => err.authFailed === true && err.imapStatus === 'NO' && /IMAP NO/.test(err.message));
});

test('status — UIDNEXT 없는 응답은 빈 항목', async () => {
  const sock = fakeSocket({ status: '* STATUS "INBOX" (MESSAGES 1)' });
  const client = makeClient(sock);
  const st = await client.fetchInboxStatus('INBOX');
  assert.deepStrictEqual(st, { messages: 1 });
});

// ── M3: 리터럴 인지 리더 + fetchUnseenDigest ──
function digestSocket() {
  const s = new EventEmitter();
  s.written = [];
  s.setTimeout = () => {}; s.end = () => {}; s.destroy = () => {};
  s.feedRaw = (str) => s.emit('data', Buffer.from(str, 'utf8'));
  s.feed = (line) => s.feedRaw(line + '\r\n');
  s.write = (data) => {
    s.written.push(data);
    const tag = String(data).split(' ')[0];
    process.nextTick(() => {
      if (/\bLOGIN\b/i.test(data)) s.feed(tag + ' OK LOGIN');
      else if (/\bSTATUS\b/i.test(data)) { s.feed('* STATUS "INBOX" (MESSAGES 10 UNSEEN 2 UIDNEXT 50)'); s.feed(tag + ' OK'); }
      else if (/\bEXAMINE\b/i.test(data)) { s.feed('* OK [READ-ONLY] ok'); s.feed(tag + ' OK [READ-ONLY]'); }
      else if (/UID\s+SEARCH/i.test(data)) { s.feed('* SEARCH 48 49'); s.feed(tag + ' OK'); }
      else if (/UID\s+FETCH/i.test(data)) {
        s.feed('* 1 FETCH (UID 48 ENVELOPE ("Mon, 01 Jan 2026" "Hello" (("Sender One" NIL "s1" "ex.com")) NIL NIL NIL NIL NIL NIL NIL))');
        // UID 49: 제목을 리터럴({3})로 전송 — 리더가 따옴표로 정규화해야 파싱됨
        s.feedRaw('* 2 FETCH (UID 49 ENVELOPE ("Tue, 02 Jan 2026" {3}\r\nabc (("Sender Two" NIL "s2" "ex.com")) NIL NIL NIL NIL NIL NIL NIL))\r\n');
        s.feed(tag + ' OK');
      }
      else if (/\bLOGOUT\b/i.test(data)) { s.feed('* BYE'); s.feed(tag + ' OK'); }
    });
    return true;
  };
  return s;
}

test('fetchUnseenDigest — EXAMINE+SEARCH+ENVELOPE(리터럴 제목 포함) 파싱', async () => {
  const sock = digestSocket();
  const client = new ImapClient({ host: 'h', port: 993, user: 'u', pass: 'p',
    connect: () => { process.nextTick(() => sock.feed('* OK ready')); return sock; } });
  const d = await client.fetchUnseenDigest('INBOX', 5);
  assert.strictEqual(d.unseen, 2);
  assert.strictEqual(d.items.length, 2);
  // top = [49,48] (최신 우선)
  assert.strictEqual(d.items[0].uid, 49);
  assert.strictEqual(d.items[0].subject, 'abc', '리터럴 제목 정규화');
  assert.strictEqual(d.items[0].from, 'Sender Two');
  assert.strictEqual(d.items[1].uid, 48);
  assert.strictEqual(d.items[1].subject, 'Hello');
  assert.ok(sock.written.some((c) => /EXAMINE/.test(c)), 'EXAMINE(read-only) 사용');
});
