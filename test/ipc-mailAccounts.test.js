'use strict';
/**
 * ipc-mailAccounts.test.js — electron/ipc/mailAccounts.js (헤드리스, persist/clientFactory/restart 주입)
 *   · get/add/update/remove: persist + 메모리 반영 + restartMailWatch 호출, 응답에 비밀번호 없음
 *   · testMailAccount: 성공/AUTH/NETWORK 매핑, 저장 비번 보충
 */
const { test } = require('node:test');
const assert = require('node:assert');

const ipc = require('../electron/ipc/mailAccounts');

function makeCtx(initial) {
  const persisted = [];
  let restarts = 0;
  const ctx = {
    config: { mailAccounts: initial ? initial.slice() : [] },
    logger: { error() {}, warn() {}, info() {} },
    persistConfigKeys: (patch) => { persisted.push(patch); },
    restartMailWatch: () => { restarts++; },
  };
  return { ctx, persisted, restarts: () => restarts };
}
const VALID = { label: '회사', host: 'imap.daum.net', port: 993, user: 'me@daum.net', pass: 'secretpass' };

test('addMailAccount — persist + 메모리 반영 + 재시작 + 비번 미노출', () => {
  const { ctx, persisted, restarts } = makeCtx();
  const res = ipc.addMailAccount(VALID, ctx);
  assert.ok(res.ok);
  assert.strictEqual(res.accounts.length, 1);
  assert.ok(!('pass' in res.account), '응답 account에 비밀번호 없음');
  assert.ok(res.accounts.every((a) => !('pass' in a)));
  // 메모리 config에는 비밀번호 보존(감시용).
  assert.strictEqual(ctx.config.mailAccounts[0].pass, 'secretpass');
  assert.strictEqual(persisted.length, 1);
  assert.ok(Array.isArray(persisted[0].mailAccounts));
  assert.strictEqual(restarts(), 1);
});

test('addMailAccount — 검증 실패는 persist/재시작 없음', () => {
  const { ctx, persisted, restarts } = makeCtx();
  const res = ipc.addMailAccount({ host: 'h', user: 'u', pass: '' }, ctx);
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.code, 'INVALID_PASS');
  assert.strictEqual(persisted.length, 0);
  assert.strictEqual(restarts(), 0);
});

test('getMailAccounts — 공개 뷰(비밀번호 제외)', () => {
  const { ctx } = makeCtx([{ id: 'abc123', label: 'L', host: 'h.com', port: 993, user: 'u', pass: 'p' }]);
  const res = ipc.getMailAccounts(ctx);
  assert.ok(res.ok);
  assert.strictEqual(res.accounts.length, 1);
  assert.ok(!('pass' in res.accounts[0]));
  assert.strictEqual(res.accounts[0].hasPassword, true);
});

test('updateMailAccount — 수정 + pass 미입력 시 기존 유지', () => {
  const { ctx } = makeCtx();
  const added = ipc.addMailAccount(VALID, ctx);
  const id = added.account.id;
  const res = ipc.updateMailAccount({ id, host: 'imap.naver.com', user: 'new', pass: '' }, ctx);
  assert.ok(res.ok);
  assert.strictEqual(res.account.host, 'imap.naver.com');
  assert.strictEqual(ctx.config.mailAccounts[0].pass, 'secretpass', '기존 비번 유지');
});

test('removeMailAccount — 삭제 + 없는 id', () => {
  const { ctx } = makeCtx();
  const added = ipc.addMailAccount(VALID, ctx);
  const res = ipc.removeMailAccount({ id: added.account.id }, ctx);
  assert.ok(res.ok);
  assert.strictEqual(res.accounts.length, 0);
  assert.strictEqual(ipc.removeMailAccount({ id: 'nope123' }, ctx).code, 'NOT_FOUND');
});

test('testMailAccount — 성공 시 status 반환', async () => {
  const { ctx } = makeCtx();
  ctx.mailClientFactory = () => ({ fetchInboxStatus: async () => ({ messages: 3, unseen: 1, uidnext: 9 }) });
  const res = await ipc.testMailAccount(VALID, ctx);
  assert.ok(res.ok);
  assert.deepStrictEqual(res.status, { messages: 3, unseen: 1, uidnext: 9 });
});

test('testMailAccount — 인증 실패 → AUTH, 네트워크 → NETWORK', async () => {
  const { ctx } = makeCtx();
  ctx.mailClientFactory = () => ({ fetchInboxStatus: async () => { const e = new Error('no'); e.authFailed = true; throw e; } });
  assert.strictEqual((await ipc.testMailAccount(VALID, ctx)).code, 'AUTH');
  ctx.mailClientFactory = () => ({ fetchInboxStatus: async () => { throw new Error('ECONNREFUSED'); } });
  assert.strictEqual((await ipc.testMailAccount(VALID, ctx)).code, 'NETWORK');
});

test('testMailAccount — 저장 계정 비번 보충(id로 조회)', async () => {
  const { ctx } = makeCtx();
  const added = ipc.addMailAccount(VALID, ctx);
  let usedPass = null;
  ctx.mailClientFactory = (creds) => ({ fetchInboxStatus: async () => { usedPass = creds.pass; return { uidnext: 1 }; } });
  // 비번 없이 id만(공개 뷰 기반 테스트) → 저장된 secretpass 사용.
  const res = await ipc.testMailAccount({ id: added.account.id, host: VALID.host, port: VALID.port, user: VALID.user }, ctx);
  assert.ok(res.ok);
  assert.strictEqual(usedPass, 'secretpass');
});

test('testMailAccount — 검증 실패 코드', async () => {
  const { ctx } = makeCtx();
  const res = await ipc.testMailAccount({ host: 'h', user: 'u', pass: '' }, ctx);
  assert.strictEqual(res.code, 'INVALID_PASS');
});

// ── M3: getMailSummary ──
test('getMailSummary — 계정별 unseen+items, 비번 미노출', async () => {
  const { ctx } = makeCtx();
  ipc.addMailAccount(VALID, ctx);
  ctx.mailClientFactory = () => ({ fetchUnseenDigest: async () => ({ unseen: 3, items: [{ uid: 9, subject: '제목', from: '보낸이', date: 'd' }] }) });
  const res = await ipc.getMailSummary(ctx);
  assert.ok(res.ok);
  assert.strictEqual(res.accounts.length, 1);
  assert.strictEqual(res.accounts[0].ok, true);
  assert.strictEqual(res.accounts[0].unseen, 3);
  assert.strictEqual(res.accounts[0].items[0].subject, '제목');
  assert.strictEqual(res.accounts[0].items[0].from, '보낸이');
  assert.ok(!('pass' in res.accounts[0]));
});

test('getMailSummary — 계정 실패 격리(AUTH/NETWORK)', async () => {
  const { ctx } = makeCtx();
  ipc.addMailAccount(VALID, ctx);
  ctx.mailClientFactory = () => ({ fetchUnseenDigest: async () => { const e = new Error('no'); e.authFailed = true; throw e; } });
  let res = await ipc.getMailSummary(ctx);
  assert.strictEqual(res.accounts[0].ok, false);
  assert.strictEqual(res.accounts[0].code, 'AUTH');
  ctx.mailClientFactory = () => ({ fetchUnseenDigest: async () => { throw new Error('ECONNREFUSED'); } });
  res = await ipc.getMailSummary(ctx);
  assert.strictEqual(res.accounts[0].code, 'NETWORK');
});

test('getMailSummary — 계정 없으면 빈 목록', async () => {
  const { ctx } = makeCtx();
  const res = await ipc.getMailSummary(ctx);
  assert.deepStrictEqual(res, { ok: true, accounts: [] });
});
