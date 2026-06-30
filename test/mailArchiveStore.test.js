'use strict';
/**
 * mailArchiveStore.test.js — lib/mail/mailArchiveStore.js (임시 경로, 헤드리스)
 *   · write→read 라운드트립(정규화 보존)
 *   · 부재/손상 파일 graceful 빈 보관함
 *   · 상승 세션이면 디스크 write 보류(no-op)
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const store = require('../lib/mail/mailArchiveStore');

function tmpPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spip-mailarc-'));
  return path.join(dir, 'mail-archive.json');
}

const SAMPLE = {
  accounts: {
    ab123456: {
      mailboxes: {
        INBOX: { uidvalidity: 7, items: [{ uid: 5, subject: '제목', from: 'a@b', date: 'd', seen: false, onServer: true }], deletedUids: [9] },
      },
    },
  },
};

test('write→read 라운드트립 — 정규화된 보관함 보존', () => {
  const file = tmpPath();
  const saved = store.write(SAMPLE, { mailArchivePath: file });
  assert.strictEqual(saved.accounts.ab123456.mailboxes.INBOX.items[0].uid, 5);
  const read = store.read({ mailArchivePath: file });
  assert.deepStrictEqual(read, saved, '디스크에서 읽은 값이 저장값과 동일');
  assert.strictEqual(read.accounts.ab123456.mailboxes.INBOX.deletedUids[0], 9);
});

test('read — 부재 파일은 graceful 빈 보관함', () => {
  const read = store.read({ mailArchivePath: path.join(os.tmpdir(), 'spip-nope-' + process.pid, 'x.json') });
  assert.deepStrictEqual(read, { schemaVersion: 1, accounts: {} });
});

test('read — 손상 JSON은 graceful 빈 보관함', () => {
  const file = tmpPath();
  fs.writeFileSync(file, '{ this is not json', 'utf8');
  const read = store.read({ mailArchivePath: file });
  assert.deepStrictEqual(read, { schemaVersion: 1, accounts: {} });
});

test('write — 상승 세션이면 디스크 보류(no-op), 메모리 결과만 반환', () => {
  const file = tmpPath();
  const elevDeps = { elevationState: { isElevated: () => true } };
  const saved = store.write(SAMPLE, { mailArchivePath: file, deps: elevDeps });
  assert.ok(saved.accounts.ab123456, '정규화 메모리 결과는 반환');
  assert.ok(!fs.existsSync(file), '디스크에는 쓰지 않음(상승 세션)');
});
