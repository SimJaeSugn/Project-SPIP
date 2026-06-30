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

// ── [메일 본문] fetchMessage 멀티바이트 리터럴 회귀(IMAP 리터럴 {N}은 바이트) ──
function bodySocket(rawMessage) {
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
      else if (/\bEXAMINE\b/i.test(data)) { s.feed('* OK [READ-ONLY] ok'); s.feed(tag + ' OK'); }
      else if (/UID\s+FETCH/i.test(data)) {
        // 리터럴 {N}은 **바이트** 길이 — 한글 본문이면 문자 길이보다 큼(이전 문자열 측정 버그 재현).
        const n = Buffer.byteLength(rawMessage, 'utf8');
        s.feedRaw('* 7 FETCH (UID 12521 BODY[]<0> {' + n + '}\r\n' + rawMessage + ')\r\n');
        s.feed(tag + ' OK FETCH completed');
      } else if (/\bLOGOUT\b/i.test(data)) { s.feed('* BYE'); s.feed(tag + ' OK'); }
    });
    return true;
  };
  return s;
}

test('[메일 본문] fetchMessage — 멀티바이트(한글) 리터럴 본문을 바이트 단위로 정확히 수신(타임아웃 회귀)', async () => {
  const raw = 'Subject: hello\r\nFrom: a@b.com\r\n\r\n안녕하세요 한글 본문입니다 — 멀티바이트 리터럴 테스트';
  assert.ok(Buffer.byteLength(raw, 'utf8') > raw.length, '한글 포함 — 바이트>문자(회귀 전제)');
  const sock = bodySocket(raw);
  // timeoutMs를 짧게: 이전 버그라면 문자 수만큼 못 받아 이 시간 안에 타임아웃 reject 됐다.
  const client = new ImapClient({ host: 'h', port: 993, user: 'u', pass: 'p', timeoutMs: 2000,
    connect: () => { process.nextTick(() => sock.feed('* OK ready')); return sock; } });
  const body = await client.fetchMessage(12521, 'INBOX');
  // [메일 인코딩] fetchMessage는 원시 바이트 보존(latin1)을 반환 — UTF-8로 디코드해 한글 검증(바이트 무손실).
  const decoded = Buffer.from(body, 'latin1').toString('utf8');
  assert.ok(decoded.includes('안녕하세요 한글 본문입니다'), '멀티바이트 본문 전체 수신(바이트 무손실)');
  assert.ok(decoded.includes('Subject: hello'), '헤더 포함');
});

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

// ── 전체 메일함 순회: listMailboxes + fetchUnseenDigestAll ──
function allFoldersSocket() {
  const s = new EventEmitter();
  s.written = [];
  s.setTimeout = () => {}; s.end = () => {}; s.destroy = () => {};
  s.feedRaw = (str) => s.emit('data', Buffer.from(str, 'utf8'));
  s.feed = (line) => s.feedRaw(line + '\r\n');
  let current = 'INBOX';
  const unseenByBox = { INBOX: 1, Work: 2 };           // 메일함별 안 읽은 수
  const searchByBox = { INBOX: '48', Work: '10' };     // 메일함별 UNSEEN UID
  const envByUid = {
    48: '("Mon, 01 Jan 2026 00:00:00 +0000" "Inbox msg" (("A" NIL "a" "ex.com")) NIL NIL NIL NIL NIL NIL NIL)',
    10: '("Wed, 03 Jan 2026 00:00:00 +0000" "Work msg" (("B" NIL "b" "ex.com")) NIL NIL NIL NIL NIL NIL NIL)',
  };
  const qname = (data) => { const m = String(data).match(/"([^"]*)"/); return (m && m[1]) ? m[1] : 'INBOX'; };
  s.write = (data) => {
    s.written.push(data);
    const tag = String(data).split(' ')[0];
    process.nextTick(() => {
      if (/\bLOGIN\b/i.test(data)) s.feed(tag + ' OK LOGIN');
      else if (/\bLIST\b/i.test(data)) {
        s.feed('* LIST (\\HasNoChildren) "/" "INBOX"');
        s.feed('* LIST (\\HasNoChildren) "/" "Work"');
        s.feed('* LIST (\\HasNoChildren \\Trash) "/" "[Gmail]/Trash"'); // 제외 대상
        s.feed(tag + ' OK LIST');
      }
      else if (/\bSTATUS\b/i.test(data)) { const nm = qname(data); s.feed('* STATUS "' + nm + '" (MESSAGES 5 UNSEEN ' + (unseenByBox[nm] || 0) + ' UIDNEXT 99)'); s.feed(tag + ' OK'); }
      else if (/\bEXAMINE\b/i.test(data)) { current = qname(data); s.feed('* OK [READ-ONLY]'); s.feed(tag + ' OK [READ-ONLY]'); }
      else if (/UID\s+SEARCH/i.test(data)) { s.feed('* SEARCH ' + (searchByBox[current] || '')); s.feed(tag + ' OK'); }
      else if (/UID\s+FETCH/i.test(data)) {
        const um = String(data).match(/UID FETCH ([\d,]+)/i);
        if (um) um[1].split(',').forEach((u, i) => { if (envByUid[u]) s.feed('* ' + (i + 1) + ' FETCH (UID ' + u + ' ENVELOPE ' + envByUid[u] + ')'); });
        s.feed(tag + ' OK');
      }
      else if (/\bLOGOUT\b/i.test(data)) { s.feed('* BYE'); s.feed(tag + ' OK'); }
    });
    return true;
  };
  return s;
}

test('listMailboxes — LIST 응답을 메일함 목록으로 파싱', async () => {
  const sock = allFoldersSocket();
  const client = new ImapClient({ host: 'h', port: 993, user: 'u', pass: 'p',
    connect: () => { process.nextTick(() => sock.feed('* OK ready')); return sock; } });
  await client.connect();
  await client.login();
  const boxes = await client.listMailboxes();
  assert.strictEqual(boxes.length, 3);
  assert.deepStrictEqual(boxes.map((b) => b.name), ['INBOX', 'Work', '[Gmail]/Trash']);
});

test('fetchUnseenDigestAll — 전체 메일함 순회·합계·최신순 병합, 휴지통 제외', async () => {
  const sock = allFoldersSocket();
  const client = new ImapClient({ host: 'h', port: 993, user: 'u', pass: 'p',
    connect: () => { process.nextTick(() => sock.feed('* OK ready')); return sock; } });
  const d = await client.fetchUnseenDigestAll(5);
  assert.strictEqual(d.unseen, 3, 'INBOX(1)+Work(2) 합계');
  assert.strictEqual(d.items.length, 2);
  // 메일함을 가로질러 최신순: Work(01-03) > INBOX(01-01)
  assert.strictEqual(d.items[0].uid, 10);
  assert.strictEqual(d.items[0].mailbox, 'Work', '소속 메일함 포함');
  assert.strictEqual(d.items[1].uid, 48);
  assert.strictEqual(d.items[1].mailbox, 'INBOX');
  // 휴지통은 선택(EXAMINE)조차 하지 않는다.
  assert.ok(!sock.written.some((c) => /EXAMINE.*Trash/i.test(c)), '휴지통 EXAMINE 안 함(제외)');
  assert.ok(sock.written.some((c) => /EXAMINE\s+"Work"/i.test(c)), 'Work 메일함 EXAMINE');
});

test('fetchUnseenDigestAll — LIST 실패 시 INBOX 단독 폴백', async () => {
  const sock = allFoldersSocket();
  // LIST에 NO로 응답하도록 가로채기.
  const origWrite = sock.write;
  sock.write = (data) => {
    if (/\bLIST\b/i.test(data)) { sock.written.push(data); const tag = String(data).split(' ')[0]; process.nextTick(() => sock.feed(tag + ' NO not supported')); return true; }
    return origWrite(data);
  };
  const client = new ImapClient({ host: 'h', port: 993, user: 'u', pass: 'p',
    connect: () => { process.nextTick(() => sock.feed('* OK ready')); return sock; } });
  const d = await client.fetchUnseenDigestAll(5);
  assert.strictEqual(d.unseen, 1, 'INBOX만 조회');
  assert.strictEqual(d.items.length, 1);
  assert.strictEqual(d.items[0].mailbox, 'INBOX');
});

// ── 보관함 수집: fetchMailIndexAll(UIDVALIDITY + SEARCH ALL + FLAGS ENVELOPE) ──
function indexSocket() {
  const s = new EventEmitter();
  s.written = [];
  s.setTimeout = () => {}; s.end = () => {}; s.destroy = () => {};
  s.feedRaw = (str) => s.emit('data', Buffer.from(str, 'utf8'));
  s.feed = (line) => s.feedRaw(line + '\r\n');
  let current = 'INBOX';
  const uidvalByBox = { INBOX: 111, Work: 222 };
  const allUidsByBox = { INBOX: [1, 2], Work: [10] };
  // uid → "(FLAGS (..) ENVELOPE (..))" 본문
  const fetchByUid = {
    1: 'FLAGS (\\Seen) ENVELOPE ("Mon, 01 Jan 2026" "Inbox1" (("A" NIL "a" "ex.com")) NIL NIL NIL NIL NIL NIL NIL)',
    2: 'FLAGS () ENVELOPE ("Tue, 02 Jan 2026" "Inbox2" (("B" NIL "b" "ex.com")) NIL NIL NIL NIL NIL NIL NIL)',
    10: 'FLAGS (\\Seen) ENVELOPE ("Wed, 03 Jan 2026" "Work1" (("C" NIL "c" "ex.com")) NIL NIL NIL NIL NIL NIL NIL)',
  };
  const qname = (data) => { const m = String(data).match(/"([^"]*)"/); return (m && m[1]) ? m[1] : 'INBOX'; };
  s.write = (data) => {
    s.written.push(data);
    const tag = String(data).split(' ')[0];
    process.nextTick(() => {
      if (/\bLOGIN\b/i.test(data)) s.feed(tag + ' OK LOGIN');
      else if (/\bLIST\b/i.test(data)) {
        s.feed('* LIST (\\HasNoChildren) "/" "INBOX"');
        s.feed('* LIST (\\HasNoChildren) "/" "Work"');
        s.feed(tag + ' OK LIST');
      }
      else if (/\bEXAMINE\b/i.test(data)) { current = qname(data); s.feed('* OK [UIDVALIDITY ' + (uidvalByBox[current] || 0) + ']'); s.feed(tag + ' OK [READ-ONLY]'); }
      else if (/UID\s+SEARCH\s+ALL/i.test(data)) { s.feed('* SEARCH ' + (allUidsByBox[current] || []).join(' ')); s.feed(tag + ' OK'); }
      else if (/UID\s+FETCH/i.test(data)) {
        const um = String(data).match(/UID FETCH ([\d,]+)/i);
        if (um) um[1].split(',').forEach((u, i) => { if (fetchByUid[u]) s.feed('* ' + (i + 1) + ' FETCH (UID ' + u + ' ' + fetchByUid[u] + ')'); });
        s.feed(tag + ' OK');
      }
      else if (/\bLOGOUT\b/i.test(data)) { s.feed('* BYE'); s.feed(tag + ' OK'); }
    });
    return true;
  };
  return s;
}

test('fetchMailIndexAll — 전 메일함 UIDVALIDITY+전체uid+FLAGS/ENVELOPE 수집', async () => {
  const sock = indexSocket();
  const client = new ImapClient({ host: 'h', port: 993, user: 'u', pass: 'p',
    connect: () => { process.nextTick(() => sock.feed('* OK ready')); return sock; } });
  const idx = await client.fetchMailIndexAll({ perFolder: 10 });
  assert.strictEqual(idx.length, 2, 'INBOX + Work');
  const inbox = idx.find((f) => f.mailbox === 'INBOX');
  assert.strictEqual(inbox.uidvalidity, 111);
  assert.deepStrictEqual(inbox.serverUids, [1, 2]);
  const byUid = new Map(inbox.entries.map((e) => [e.uid, e]));
  assert.strictEqual(byUid.get(1).seen, true, 'uid1 \\Seen');
  assert.strictEqual(byUid.get(1).subject, 'Inbox1');
  assert.strictEqual(byUid.get(2).seen, false, 'uid2 안읽음');
  const work = idx.find((f) => f.mailbox === 'Work');
  assert.strictEqual(work.uidvalidity, 222);
  assert.strictEqual(work.entries[0].subject, 'Work1');
});

// ── 서버 삭제(휴지통 이동) + 읽음 처리(markSeen) ──
function deleteSocket(opts) {
  opts = opts || {};
  const s = new EventEmitter();
  s.written = [];
  s.setTimeout = () => {}; s.end = () => {}; s.destroy = () => {};
  s.feed = (line) => s.emit('data', Buffer.from(line + '\r\n', 'utf8'));
  s.write = (data) => {
    s.written.push(data);
    const tag = String(data).split(' ')[0];
    process.nextTick(() => {
      if (/\bLOGIN\b/i.test(data)) s.feed(tag + ' OK LOGIN');
      else if (/\bLIST\b/i.test(data)) {
        s.feed('* LIST (\\HasNoChildren) "/" "INBOX"');
        s.feed('* LIST (\\HasNoChildren \\Trash) "/" "Trash"');
        s.feed(tag + ' OK LIST');
      }
      else if (/\bSELECT\b/i.test(data)) { s.feed('* OK [READ-WRITE]'); s.feed(tag + ' OK [READ-WRITE]'); }
      else if (/UID\s+MOVE/i.test(data)) { s.feed(opts.moveFails ? (tag + ' BAD unknown command') : (tag + ' OK MOVE')); }
      else if (/UID\s+COPY/i.test(data)) { s.feed(tag + ' OK COPY'); }
      else if (/UID\s+STORE/i.test(data)) { s.feed(tag + ' OK STORE'); }
      else if (/UID\s+EXPUNGE/i.test(data)) { s.feed(tag + ' OK EXPUNGE'); }
      else if (/\bEXPUNGE\b/i.test(data)) { s.feed(tag + ' OK EXPUNGE'); }
      else if (/\bLOGOUT\b/i.test(data)) { s.feed('* BYE'); s.feed(tag + ' OK'); }
    });
    return true;
  };
  return s;
}

test('deleteMessages — 휴지통으로 UID MOVE(휴지통 탐지)', async () => {
  const sock = deleteSocket();
  const client = new ImapClient({ host: 'h', port: 993, user: 'u', pass: 'p',
    connect: () => { process.nextTick(() => sock.feed('* OK ready')); return sock; } });
  const r = await client.deleteMessages('INBOX', [3, 4], { permanent: false });
  assert.strictEqual(r.method, 'move');
  assert.ok(sock.written.some((c) => /SELECT "INBOX"/i.test(c)), 'read-write SELECT');
  assert.ok(sock.written.some((c) => /UID MOVE 3,4 "Trash"/i.test(c)), '휴지통으로 이동');
});

test('deleteMessages — MOVE 미지원 시 COPY+\Deleted+EXPUNGE 폴백', async () => {
  const sock = deleteSocket({ moveFails: true });
  const client = new ImapClient({ host: 'h', port: 993, user: 'u', pass: 'p',
    connect: () => { process.nextTick(() => sock.feed('* OK ready')); return sock; } });
  const r = await client.deleteMessages('INBOX', [5], { permanent: false });
  assert.ok(sock.written.some((c) => /UID COPY 5 "Trash"/i.test(c)), 'COPY 폴백');
  assert.ok(sock.written.some((c) => /UID STORE 5 \+FLAGS \(\\Deleted\)/i.test(c)), '\\Deleted 표시');
  assert.ok(sock.written.some((c) => /UID EXPUNGE 5/i.test(c)), 'UID EXPUNGE');
  assert.strictEqual(r.method, 'copy');
});

function markSeenSocket() {
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
      else if (/\bSELECT\b/i.test(data)) { s.feed('* OK [READ-WRITE]'); s.feed(tag + ' OK'); }
      else if (/\bEXAMINE\b/i.test(data)) { s.feed('* OK [READ-ONLY]'); s.feed(tag + ' OK'); }
      else if (/UID\s+FETCH/i.test(data)) {
        const body = 'Subject: hi\r\n\r\nbody';
        s.feedRaw('* 1 FETCH (UID 9 BODY[]<0> {' + Buffer.byteLength(body, 'utf8') + '}\r\n' + body + ')\r\n');
        s.feed(tag + ' OK FETCH');
      }
      else if (/\bLOGOUT\b/i.test(data)) { s.feed('* BYE'); s.feed(tag + ' OK'); }
    });
    return true;
  };
  return s;
}

test('fetchMessage markSeen — SELECT(read-write) + 비-PEEK BODY[](서버 읽음 처리)', async () => {
  const sock = markSeenSocket();
  const client = new ImapClient({ host: 'h', port: 993, user: 'u', pass: 'p',
    connect: () => { process.nextTick(() => sock.feed('* OK ready')); return sock; } });
  const body = await client.fetchMessage(9, 'INBOX', undefined, { markSeen: true });
  assert.ok(body.includes('body'), '본문 수신');
  assert.ok(sock.written.some((c) => /SELECT "INBOX"/i.test(c)), 'read-write SELECT 사용');
  assert.ok(sock.written.some((c) => /UID FETCH 9 BODY\[\]/i.test(c) && !/PEEK/i.test(c)), '비-PEEK BODY[](읽음 설정)');
  assert.ok(!sock.written.some((c) => /EXAMINE/i.test(c)), 'EXAMINE 미사용');
});

test('fetchMessage 기본 — EXAMINE + BODY.PEEK(읽음 영향 없음)', async () => {
  const sock = markSeenSocket();
  const client = new ImapClient({ host: 'h', port: 993, user: 'u', pass: 'p',
    connect: () => { process.nextTick(() => sock.feed('* OK ready')); return sock; } });
  await client.fetchMessage(9, 'INBOX');
  assert.ok(sock.written.some((c) => /EXAMINE "INBOX"/i.test(c)), 'EXAMINE 사용');
  assert.ok(sock.written.some((c) => /BODY\.PEEK\[\]/i.test(c)), 'BODY.PEEK(읽음 영향 없음)');
});
