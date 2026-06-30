'use strict';
/**
 * ipc-mailArchive.test.js — electron/ipc/mailArchive.js (헤드리스, clientFactory/경로 주입)
 *   · getMailArchive: config 계정 표시(보관함 비어도), 라벨 결합, 비번 미노출
 *   · syncMailArchive: IMAP 인덱스 수집→병합→영속, 읽음/삭제 상태 동기화, 계정 실패 격리
 *   · deleteMailArchiveItem: 로컬 단건/메일함/계정 삭제(서버 미접촉), tombstone로 재수집 부활 방지
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ipc = require('../electron/ipc/mailArchive');

function tmpPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spip-mailarcipc-'));
  return path.join(dir, 'mail-archive.json');
}

const ACCT = { id: 'ab123456', label: '회사', host: 'imap.x.com', port: 993, user: 'me@x.com', pass: 'secret' };

function makeCtx(folders) {
  return {
    config: { mailAccounts: [ACCT] },
    logger: { error() {}, warn() {}, info() {} },
    mailArchivePath: tmpPath(),
    mailClientFactory: () => ({ fetchMailIndexAll: async () => folders }),
  };
}

const entry = (uid, seen) => ({ uid, subject: 's' + uid, from: 'a@b', date: 'Mon, 0' + uid + ' Jan 2026 00:00:00 +0000', seen: !!seen });

test('getMailArchive — 보관함 비어도 config 계정 표시(비번 미노출)', () => {
  const ctx = makeCtx([]);
  const res = ipc.getMailArchive(ctx);
  assert.ok(res.ok);
  assert.strictEqual(res.accounts.length, 1);
  assert.strictEqual(res.accounts[0].accountId, 'ab123456');
  assert.strictEqual(res.accounts[0].label, '회사');
  assert.deepStrictEqual(res.accounts[0].mailboxes, []);
  assert.ok(!('pass' in res.accounts[0]));
});

test('syncMailArchive — IMAP 인덱스 수집→병합→영속, 안읽음 집계', async () => {
  const ctx = makeCtx([
    { mailbox: 'INBOX', uidvalidity: 1, serverUids: [1, 2], entries: [entry(1, false), entry(2, true)] },
    { mailbox: '업무', uidvalidity: 1, serverUids: [10], entries: [entry(10, false)] },
  ]);
  const res = await ipc.syncMailArchive(ctx);
  assert.ok(res.ok);
  assert.deepStrictEqual(res.errors, []);
  const inbox = res.accounts[0].mailboxes.find((m) => m.name === 'INBOX');
  assert.strictEqual(inbox.total, 2);
  assert.strictEqual(inbox.unread, 1, 'uid1 안읽음 1건');
  // 영속됐는지 — 새 read로 확인.
  const again = ipc.getMailArchive(ctx);
  assert.ok(again.accounts[0].mailboxes.find((m) => m.name === '업무'));
});

test('syncMailArchive — 읽음상태가 서버와 동기화', async () => {
  const ctx = makeCtx([{ mailbox: 'INBOX', uidvalidity: 1, serverUids: [1], entries: [entry(1, false)] }]);
  await ipc.syncMailArchive(ctx);
  let inbox = ipc.getMailArchive(ctx).accounts[0].mailboxes.find((m) => m.name === 'INBOX');
  assert.strictEqual(inbox.unread, 1);
  // 서버에서 읽음 처리되어 재동기화.
  ctx.mailClientFactory = () => ({ fetchMailIndexAll: async () => [{ mailbox: 'INBOX', uidvalidity: 1, serverUids: [1], entries: [entry(1, true)] }] });
  await ipc.syncMailArchive(ctx);
  inbox = ipc.getMailArchive(ctx).accounts[0].mailboxes.find((m) => m.name === 'INBOX');
  assert.strictEqual(inbox.unread, 0, '서버 읽음 → 보관함도 읽음');
});

test('syncMailArchive — 서버에서 사라진 메일은 보관(onServer=false)', async () => {
  const ctx = makeCtx([{ mailbox: 'INBOX', uidvalidity: 1, serverUids: [1, 2], entries: [entry(1), entry(2)] }]);
  await ipc.syncMailArchive(ctx);
  ctx.mailClientFactory = () => ({ fetchMailIndexAll: async () => [{ mailbox: 'INBOX', uidvalidity: 1, serverUids: [1], entries: [entry(1)] }] });
  const res = await ipc.syncMailArchive(ctx);
  const items = res.accounts[0].mailboxes.find((m) => m.name === 'INBOX').items;
  const gone = items.find((it) => it.uid === 2);
  assert.ok(gone, '사라진 메일 보관 유지');
  assert.strictEqual(gone.onServer, false);
});

test('syncMailArchive — 계정 실패 격리(errors에 코드)', async () => {
  const ctx = makeCtx([]);
  ctx.mailClientFactory = () => ({ fetchMailIndexAll: async () => { const e = new Error('no'); e.authFailed = true; throw e; } });
  const res = await ipc.syncMailArchive(ctx);
  assert.ok(res.ok);
  assert.deepStrictEqual(res.errors, [{ accountId: 'ab123456', code: 'AUTH' }]);
});

test('deleteMailArchiveItem — 단건 삭제 후 재동기화해도 부활 안 함(tombstone)', async () => {
  const folders = [{ mailbox: 'INBOX', uidvalidity: 1, serverUids: [1, 2], entries: [entry(1), entry(2)] }];
  const ctx = makeCtx(folders);
  await ipc.syncMailArchive(ctx);
  const del = await ipc.deleteMailArchiveItem({ accountId: 'ab123456', mailbox: 'INBOX', uid: 1 }, ctx);
  assert.ok(del.ok);
  let items = del.accounts[0].mailboxes.find((m) => m.name === 'INBOX').items;
  assert.ok(!items.some((it) => it.uid === 1), '삭제됨');
  // 서버엔 uid1이 여전히 있어도 재수집 시 부활하지 않아야.
  const res = await ipc.syncMailArchive(ctx);
  items = res.accounts[0].mailboxes.find((m) => m.name === 'INBOX').items;
  assert.ok(!items.some((it) => it.uid === 1), 'tombstone로 부활 억제');
  assert.ok(items.some((it) => it.uid === 2));
});

test('deleteMailArchiveItem — 메일함 비우기 / 계정 초기화', async () => {
  const ctx = makeCtx([
    { mailbox: 'INBOX', uidvalidity: 1, serverUids: [1], entries: [entry(1)] },
    { mailbox: '업무', uidvalidity: 1, serverUids: [2], entries: [entry(2)] },
  ]);
  await ipc.syncMailArchive(ctx);
  // 메일함 비우기(uid 없음).
  let res = await ipc.deleteMailArchiveItem({ accountId: 'ab123456', mailbox: 'INBOX' }, ctx);
  const inbox = res.accounts[0].mailboxes.find((m) => m.name === 'INBOX');
  assert.strictEqual(inbox.total, 0, '메일함 비워짐');
  assert.ok(res.accounts[0].mailboxes.find((m) => m.name === '업무').total === 1, '다른 메일함 유지');
  // 계정 초기화(mailbox 없음).
  res = await ipc.deleteMailArchiveItem({ accountId: 'ab123456' }, ctx);
  assert.deepStrictEqual(res.accounts[0].mailboxes, [], '계정 보관함 초기화');
});

test('deleteMailArchiveItem — 잘못된 인자', async () => {
  const ctx = makeCtx([]);
  assert.strictEqual((await ipc.deleteMailArchiveItem({}, ctx)).code, 'INVALID');
  assert.strictEqual((await ipc.deleteMailArchiveItem({ accountId: 'ab123456', mailbox: 'INBOX', uid: 0 }, ctx)).code, 'INVALID');
});
