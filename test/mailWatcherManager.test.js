'use strict';
/**
 * mailWatcherManager.test.js — lib/mail/mailWatcherManager.js (헤드리스, clientFactory/setInterval 주입)
 *   · apply: 계정별 워처 생성·시작, onNewMail에 account(공개 뷰) 동봉
 *   · checkNow: 전 계정 tick, stop: 전체 정지
 *   · 비밀번호는 콜백 account에 노출 안 됨
 */
const { test } = require('node:test');
const assert = require('node:assert');

const { MailWatcherManager } = require('../lib/mail/mailWatcherManager');

const quiet = { error() {}, warn() {}, info() {} };
const noIv = () => ({ unref() {} });
const flush = () => new Promise((r) => setImmediate(r));

function acc(id, host, user, uidnextSeq) {
  return { id, label: id + '-label', host, port: 993, user, pass: 'pw-' + id, _seq: uidnextSeq };
}

// 계정 host 기준으로 STATUS 시퀀스를 주는 가짜 클라이언트 팩토리.
function factory(seqByHost) {
  const idx = {};
  return (creds) => ({
    fetchInboxStatus: async () => {
      const seq = seqByHost[creds.host] || [{ uidnext: 1 }];
      const i = idx[creds.host] || 0;
      idx[creds.host] = i + 1;
      return seq[Math.min(i, seq.length - 1)];
    },
  });
}

test('apply — 계정별 감시 시작 + 새 메일 시 account 동봉(비번 제외)', async () => {
  const notes = [];
  const seq = {
    'imap.a.com': [{ uidnext: 5, unseen: 0 }, { uidnext: 7, unseen: 2 }],
    'imap.b.com': [{ uidnext: 10 }, { uidnext: 10 }],
  };
  const mgr = new MailWatcherManager({ logger: quiet, clientFactory: factory(seq), setInterval: noIv });
  mgr.apply([acc('a', 'imap.a.com', 'ua'), acc('b', 'imap.b.com', 'ub')], { onNewMail: (x) => notes.push(x) });
  assert.strictEqual(mgr.size(), 2);
  await flush();           // 기준선(각 계정 1회)
  mgr.checkNow();          // 2회차
  await flush();
  // a만 증가(5→7) → 통지 1건, account 포함.
  assert.strictEqual(notes.length, 1);
  assert.strictEqual(notes[0].newCount, 2);
  assert.strictEqual(notes[0].account.id, 'a');
  assert.strictEqual(notes[0].account.label, 'a-label');
  assert.strictEqual(notes[0].account.hasPassword, true);
  assert.ok(!('pass' in notes[0].account), 'account에 비밀번호 없음');
});

test('apply — 재호출 시 전체 재구성(이전 워처 정지)', async () => {
  const mgr = new MailWatcherManager({ logger: quiet, clientFactory: factory({}), setInterval: noIv });
  mgr.apply([acc('a', 'imap.a.com', 'ua')], {});
  assert.strictEqual(mgr.size(), 1);
  mgr.apply([acc('b', 'imap.b.com', 'ub'), acc('c', 'imap.c.com', 'uc')], {});
  assert.strictEqual(mgr.size(), 2);
  await flush();
});

test('apply — 빈 목록이면 감시 없음', () => {
  const mgr = new MailWatcherManager({ logger: quiet, clientFactory: factory({}), setInterval: noIv });
  mgr.apply([], {});
  assert.strictEqual(mgr.isRunning(), false);
  assert.strictEqual(mgr.size(), 0);
});

test('stop — 전체 정지(멱등)', async () => {
  const mgr = new MailWatcherManager({ logger: quiet, clientFactory: factory({}), setInterval: noIv });
  mgr.apply([acc('a', 'imap.a.com', 'ua')], {});
  mgr.stop();
  assert.strictEqual(mgr.size(), 0);
  assert.strictEqual(mgr.isRunning(), false);
  mgr.stop();
  await flush();
});
