'use strict';
/**
 * mailAccounts.test.js — lib/mail/mailAccounts.js (계정 레지스트리, 헤드리스)
 *   · 검증(host/user/pass/port, CRLF·제어문자 차단)
 *   · normalizeAccounts(잘못된 항목 폐기·id 보정·상한)
 *   · add/update/remove + toPublicView(비밀번호 제외)
 */
const { test } = require('node:test');
const assert = require('node:assert');

const reg = require('../lib/mail/mailAccounts');

// 결정적 id 생성기(테스트 주입).
function seqGen() {
  let n = 0;
  return { genId: () => 'id' + String(1000 + (n++)) }; // id1000, id1001 … (ID_RE 매칭)
}
const VALID = { label: '회사', host: 'imap.daum.net', port: 993, user: 'me@daum.net', pass: 'secretpass' };

test('validateAccountInput — 정상 입력 정규화', () => {
  const v = reg.validateAccountInput(VALID);
  assert.ok(v.ok);
  assert.deepStrictEqual(v.fields, { label: '회사', host: 'imap.daum.net', port: 993, user: 'me@daum.net', pass: 'secretpass' });
});

test('validateAccountInput — 포트 미지정 시 993, 라벨 미지정 시 user@host', () => {
  const v = reg.validateAccountInput({ host: 'h.com', user: 'u', pass: 'p' });
  assert.ok(v.ok);
  assert.strictEqual(v.fields.port, 993);
  assert.strictEqual(v.fields.label, 'u@h.com');
});

test('validateAccountInput — 필수 누락/형식 오류 코드', () => {
  assert.strictEqual(reg.validateAccountInput({ host: '', user: 'u', pass: 'p' }).code, 'INVALID_HOST');
  assert.strictEqual(reg.validateAccountInput({ host: 'h', user: '', pass: 'p' }).code, 'INVALID_USER');
  assert.strictEqual(reg.validateAccountInput({ host: 'h', user: 'u', pass: '' }).code, 'INVALID_PASS');
  assert.strictEqual(reg.validateAccountInput({ host: 'h', user: 'u', pass: 'p', port: 70000 }).code, 'INVALID_PORT');
});

test('validateAccountInput — CRLF/제어문자 인젝션 차단(보안)', () => {
  assert.strictEqual(reg.validateAccountInput({ host: 'h', user: 'u\r\nA LOGIN x', pass: 'p' }).code, 'INVALID_USER');
  assert.strictEqual(reg.validateAccountInput({ host: 'h', user: 'u', pass: 'p\r\nA NOOP' }).code, 'INVALID_PASS');
  assert.strictEqual(reg.validateAccountInput({ host: 'bad host', user: 'u', pass: 'p' }).code, 'INVALID_HOST');
});

test('normalizeAccounts — 잘못된 항목 폐기 + id 보정', () => {
  const out = reg.normalizeAccounts([
    VALID,                                   // id 없음 → 생성
    { host: 'h', user: 'u', pass: 'p', id: 'keepme9' }, // 유효 id 유지
    { host: '', user: 'u', pass: 'p' },      // 폐기(host)
    'nope',                                  // 폐기(비객체)
  ], seqGen());
  assert.strictEqual(out.length, 2);
  assert.ok(reg.ID_RE.test(out[0].id));
  assert.strictEqual(out[1].id, 'keepme9');
});

test('normalizeAccounts — 중복 id는 재생성', () => {
  const out = reg.normalizeAccounts([
    { host: 'h', user: 'a', pass: 'p', id: 'dupdup' },
    { host: 'h', user: 'b', pass: 'p', id: 'dupdup' },
  ], seqGen());
  assert.strictEqual(out.length, 2);
  assert.notStrictEqual(out[0].id, out[1].id);
});

test('normalizeAccounts — 개수 상한(MAX_ACCOUNTS)', () => {
  const many = Array.from({ length: reg.MAX_ACCOUNTS + 5 }, (_, i) => ({ host: 'h', user: 'u' + i, pass: 'p' }));
  const out = reg.normalizeAccounts(many, seqGen());
  assert.strictEqual(out.length, reg.MAX_ACCOUNTS);
});

test('addAccount — 추가 + 상한 거부', () => {
  const r1 = reg.addAccount([], VALID, seqGen());
  assert.ok(r1.ok);
  assert.strictEqual(r1.accounts.length, 1);
  assert.ok(reg.ID_RE.test(r1.account.id));

  const full = Array.from({ length: reg.MAX_ACCOUNTS }, (_, i) => ({ id: 'id' + (2000 + i), host: 'h', user: 'u' + i, pass: 'p' }));
  const r2 = reg.addAccount(full, VALID, seqGen());
  assert.strictEqual(r2.ok, false);
  assert.strictEqual(r2.code, 'LIMIT');
});

test('addAccount — 검증 실패 전파', () => {
  const r = reg.addAccount([], { host: 'h', user: 'u', pass: '' }, seqGen());
  assert.strictEqual(r.code, 'INVALID_PASS');
});

test('updateAccount — 필드 수정 + pass 미입력 시 기존 유지', () => {
  const added = reg.addAccount([], VALID, seqGen());
  const id = added.account.id;
  const r = reg.updateAccount(added.accounts, id, { host: 'imap.naver.com', user: 'new', pass: '' }, seqGen());
  assert.ok(r.ok);
  assert.strictEqual(r.account.host, 'imap.naver.com');
  assert.strictEqual(r.account.user, 'new');
  assert.strictEqual(r.account.pass, 'secretpass', 'pass 미입력 → 기존 유지');
});

test('updateAccount — 새 비밀번호 반영 / 없는 id', () => {
  const added = reg.addAccount([], VALID, seqGen());
  const id = added.account.id;
  const r = reg.updateAccount(added.accounts, id, { host: 'h', user: 'u', pass: 'changed' }, seqGen());
  assert.strictEqual(r.account.pass, 'changed');
  assert.strictEqual(reg.updateAccount(added.accounts, 'nope999', VALID, seqGen()).code, 'NOT_FOUND');
});

test('removeAccount — 삭제 + 없는 id', () => {
  const added = reg.addAccount([], VALID, seqGen());
  const id = added.account.id;
  const r = reg.removeAccount(added.accounts, id, seqGen());
  assert.ok(r.ok);
  assert.strictEqual(r.accounts.length, 0);
  assert.strictEqual(reg.removeAccount([], 'x123456', seqGen()).code, 'NOT_FOUND');
});

test('toPublicView/toPublicList — 비밀번호 제외, hasPassword만', () => {
  const added = reg.addAccount([], VALID, seqGen());
  const view = reg.toPublicView(added.account);
  assert.deepStrictEqual(Object.keys(view).sort(), ['hasPassword', 'host', 'id', 'label', 'port', 'user']);
  assert.strictEqual(view.hasPassword, true);
  assert.ok(!('pass' in view), '공개 뷰에 pass 없음');
  const list = reg.toPublicList(added.accounts);
  assert.ok(list.every((v) => !('pass' in v)));
});
