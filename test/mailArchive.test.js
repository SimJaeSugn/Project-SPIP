'use strict';
/**
 * mailArchive.test.js — lib/mail/mailArchive.js (순수 병합·정규화, 헤드리스)
 *   · mergeFolder: 신규 수집/읽음상태 갱신/서버삭제 표시/tombstone 억제/UIDVALIDITY 재설정/상한
 *   · mergeAccount: 폴더별 병합 + 미동기화 폴더 보존
 *   · deleteItem/clearMailbox/removeAccount: 로컬 삭제 + tombstone
 *   · normalizeArchive: 형식·상한·문자열 재검증(신뢰 경계)
 */
const { test } = require('node:test');
const assert = require('node:assert');

const A = require('../lib/mail/mailArchive');

const entry = (uid, subject, seen) => ({ uid, subject: subject || ('s' + uid), from: 'a@b.com', date: 'Mon, 01 Jan 2026 00:00:00 +0000', seen: !!seen });
const fresh = (uidvalidity, serverUids, entries) => ({ uidvalidity, serverUids, entries });

test('mergeFolder — 신규 메일 수집(onServer=true, 읽음상태 반영)', () => {
  const f = A.mergeFolder(null, fresh(100, [1, 2], [entry(1, 'A', false), entry(2, 'B', true)]), A.DEFAULT_MERGE_OPTS);
  assert.strictEqual(f.uidvalidity, 100);
  assert.strictEqual(f.items.length, 2);
  const byUid = new Map(f.items.map((it) => [it.uid, it]));
  assert.strictEqual(byUid.get(1).onServer, true);
  assert.strictEqual(byUid.get(1).seen, false);
  assert.strictEqual(byUid.get(2).seen, true);
});

test('mergeFolder — 읽음상태가 서버와 동기화(안읽음 to 읽음)', () => {
  const prev = A.mergeFolder(null, fresh(100, [1], [entry(1, 'A', false)]), A.DEFAULT_MERGE_OPTS);
  assert.strictEqual(prev.items[0].seen, false);
  const next = A.mergeFolder(prev, fresh(100, [1], [entry(1, 'A', true)]), A.DEFAULT_MERGE_OPTS);
  assert.strictEqual(next.items[0].seen, true, '서버에서 읽음 처리되면 보관함도 읽음');
});

test('mergeFolder — 서버에서 사라진 메일은 보관하되 onServer=false', () => {
  const prev = A.mergeFolder(null, fresh(100, [1, 2], [entry(1), entry(2)]), A.DEFAULT_MERGE_OPTS);
  const next = A.mergeFolder(prev, fresh(100, [1], [entry(1)]), A.DEFAULT_MERGE_OPTS);
  const byUid = new Map(next.items.map((it) => [it.uid, it]));
  assert.strictEqual(byUid.get(1).onServer, true);
  assert.ok(byUid.get(2), '사라진 메일도 보관 유지');
  assert.strictEqual(byUid.get(2).onServer, false, '서버 삭제 상태 동기화');
});

test('mergeFolder — tombstone(로컬 삭제)는 재수집해도 부활하지 않음', () => {
  let f = A.mergeFolder(null, fresh(100, [1, 2], [entry(1), entry(2)]), A.DEFAULT_MERGE_OPTS);
  f = A.deleteItem({ accounts: { ab123456: { mailboxes: { INBOX: f } } } }, 'ab123456', 'INBOX', 1, A.DEFAULT_MERGE_OPTS).accounts.ab123456.mailboxes.INBOX;
  assert.ok(!f.items.some((it) => it.uid === 1), '삭제 직후 없음');
  assert.ok(f.deletedUids.includes(1), 'tombstone 기록');
  const next = A.mergeFolder(f, fresh(100, [1, 2], [entry(1), entry(2)]), A.DEFAULT_MERGE_OPTS);
  assert.ok(!next.items.some((it) => it.uid === 1), 'tombstone로 부활 억제');
  assert.ok(next.items.some((it) => it.uid === 2));
});

test('mergeFolder — tombstone는 서버에서도 사라지면 정리', () => {
  let f = A.mergeFolder(null, fresh(100, [1], [entry(1)]), A.DEFAULT_MERGE_OPTS);
  f = A.deleteItem({ accounts: { ab123456: { mailboxes: { INBOX: f } } } }, 'ab123456', 'INBOX', 1, A.DEFAULT_MERGE_OPTS).accounts.ab123456.mailboxes.INBOX;
  assert.ok(f.deletedUids.includes(1));
  const next = A.mergeFolder(f, fresh(100, [], []), A.DEFAULT_MERGE_OPTS);
  assert.ok(!next.deletedUids.includes(1), '서버에서 없어진 uid의 tombstone은 정리');
});

test('mergeFolder — UIDVALIDITY 변경 시 폴더 재설정(uid 네임스페이스 무효)', () => {
  const prev = A.mergeFolder(null, fresh(100, [1, 2], [entry(1), entry(2)]), A.DEFAULT_MERGE_OPTS);
  const next = A.mergeFolder(prev, fresh(200, [1], [entry(1, 'NEW')]), A.DEFAULT_MERGE_OPTS);
  assert.strictEqual(next.uidvalidity, 200);
  assert.strictEqual(next.items.length, 1, '이전 uid 폐기');
  assert.strictEqual(next.items[0].subject, 'NEW');
});

test('mergeFolder — 메일함당 상한(최신 우선)', () => {
  const opts = { maxItems: 3, maxGone: 2, maxTomb: 10 };
  const uids = [1, 2, 3, 4, 5];
  const f = A.mergeFolder(null, fresh(1, uids, uids.map((u) => entry(u))), opts);
  assert.strictEqual(f.items.length, 3);
  assert.deepStrictEqual(f.items.map((it) => it.uid), [5, 4, 3], '최신(큰 uid) 우선');
});

test('mergeAccount — 폴더별 병합 + 미동기화 폴더 보존', () => {
  const prev = A.mergeAccount(null, [
    { mailbox: 'INBOX', uidvalidity: 1, serverUids: [1], entries: [entry(1)] },
    { mailbox: 'Work', uidvalidity: 1, serverUids: [9], entries: [entry(9)] },
  ], A.DEFAULT_MERGE_OPTS);
  const next = A.mergeAccount(prev, [
    { mailbox: 'INBOX', uidvalidity: 1, serverUids: [1, 2], entries: [entry(1), entry(2)] },
  ], A.DEFAULT_MERGE_OPTS);
  assert.strictEqual(next.mailboxes.INBOX.items.length, 2);
  assert.ok(next.mailboxes.Work, '미동기화 폴더 보존');
  assert.strictEqual(next.mailboxes.Work.items[0].uid, 9);
});

test('clearMailbox — 항목 제거 + 서버 보유분 tombstone', () => {
  const arc = { accounts: { ab123456: { mailboxes: { INBOX: A.mergeFolder(null, fresh(1, [1, 2], [entry(1), entry(2)]), A.DEFAULT_MERGE_OPTS) } } } };
  A.clearMailbox(arc, 'ab123456', 'INBOX', A.DEFAULT_MERGE_OPTS);
  assert.strictEqual(arc.accounts.ab123456.mailboxes.INBOX.items.length, 0);
  assert.deepStrictEqual(arc.accounts.ab123456.mailboxes.INBOX.deletedUids.slice().sort((a, b) => a - b), [1, 2]);
});

test('removeAccount — 계정 보관함 전체 제거', () => {
  const arc = { accounts: { ab123456: { mailboxes: {} }, cd789012: { mailboxes: {} } } };
  A.removeAccount(arc, 'ab123456');
  assert.ok(!arc.accounts.ab123456);
  assert.ok(arc.accounts.cd789012);
});

test('normalizeArchive — 잘못된 형식/계정id/중복uid graceful 재검증', () => {
  const dirty = {
    accounts: {
      'BAD ID!': { mailboxes: { INBOX: { items: [] } } },
      ab123456: {
        mailboxes: {
          INBOX: {
            uidvalidity: 5,
            items: [
              { uid: 1, subject: 'hi there', from: 'a@b', date: 'd', seen: true, onServer: true },
              { uid: 'x', subject: 'bad' },
              { uid: 1, subject: 'dup' },
            ],
            deletedUids: [3, 'y', 4],
          },
        },
      },
    },
  };
  const norm = A.normalizeArchive(dirty);
  assert.ok(!norm.accounts['BAD ID!'], '잘못된 계정id 제외');
  const inbox = norm.accounts.ab123456.mailboxes.INBOX;
  assert.strictEqual(inbox.items.length, 1, '유효 항목만');
  assert.strictEqual(inbox.items[0].subject, 'hi there', '유효 제목 보존');
  assert.deepStrictEqual(inbox.deletedUids, [3, 4], '정수 tombstone만');
  assert.strictEqual(norm.schemaVersion, A.SCHEMA_VERSION);
});

test('normalizeArchive — 비객체 입력은 빈 보관함', () => {
  assert.deepStrictEqual(A.normalizeArchive(null), { schemaVersion: A.SCHEMA_VERSION, accounts: {} });
  assert.deepStrictEqual(A.normalizeArchive('x'), { schemaVersion: A.SCHEMA_VERSION, accounts: {} });
});
