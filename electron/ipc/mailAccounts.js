'use strict';
/**
 * electron/ipc/mailAccounts.js — 메일 계정 관리 IPC (folders/tools 패턴 차용)
 *
 *   spip:getMailAccounts            → config.mailAccounts 공개 뷰(비밀번호 제외)
 *   spip:addMailAccount {label,host,port,user,pass}        → 검증·id 생성·persist·감시 재시작
 *   spip:updateMailAccount {id,label,host,port,user,pass?} → 수정(pass 비우면 기존 유지)·persist·재시작
 *   spip:removeMailAccount {id}     → 삭제·persist·재시작
 *   spip:testMailAccount {id?,host,port,user,pass?} (async) → 실제 IMAP 로그인·STATUS 1회 시도
 *
 * 보안:
 *   · 응답에는 비밀번호를 절대 싣지 않는다(toPublicList/toPublicView). config는 getConfig가
 *     mailAccounts를 노출하지 않으므로 비밀번호는 렌더러로 새지 않는다.
 *   · 입력 검증(host/user/pass의 CRLF·제어문자 금지)은 mailAccounts 레지스트리가 담당(인젝션 차단).
 *   · 변경은 persistConfigKeys({mailAccounts})로 0600 원자적 부분 갱신(다른 키 보존).
 *
 * [헤드리스 검증, F-3] Electron API 미import. persistConfigKeys·clientFactory·restartMailWatch는
 *   ctx로 주입 가능(기본 실제 모듈). 검증 체인·persist·재시작 호출을 모킹으로 단위테스트.
 *
 * 외부 의존성 0 — 내부(mailAccounts, config, imapClient).
 */

const reg = require('../../lib/mail/mailAccounts');
const config = require('../../lib/common/config');
const { ImapClient } = require('../../lib/mail/imapClient');

/** ctx 의존성 해석(주입 우선). */
function deps(ctx) {
  return {
    persistConfigKeys: (ctx && typeof ctx.persistConfigKeys === 'function') ? ctx.persistConfigKeys : config.persistConfigKeys,
    clientFactory: (ctx && typeof ctx.mailClientFactory === 'function') ? ctx.mailClientFactory : ((creds) => new ImapClient(creds)),
  };
}

/** 현재 계정 배열(정규화 원천은 메모리 config). */
function currentAccounts(ctx) {
  return (ctx && ctx.config && Array.isArray(ctx.config.mailAccounts)) ? ctx.config.mailAccounts : [];
}

/** 변경 결과를 메모리 반영·영속·감시 재시작까지 일괄 처리. */
function commit(accounts, ctx, d) {
  if (ctx && ctx.config) ctx.config.mailAccounts = accounts;
  d.persistConfigKeys({ mailAccounts: accounts }, { logger: ctx && ctx.logger, configPath: ctx && ctx.configPath });
  // 계정 변경 → 감시 재구성(main이 주입한 훅). 미주입 환경(테스트)에선 무동작.
  try { if (ctx && typeof ctx.restartMailWatch === 'function') ctx.restartMailWatch(); } catch (_) { /* noop */ }
}

/** spip:getMailAccounts — 공개 뷰 목록(비밀번호 제외). */
function getMailAccounts(ctx) {
  return { ok: true, accounts: reg.toPublicList(currentAccounts(ctx)) };
}

/** spip:addMailAccount — 검증·추가·persist·재시작. */
function addMailAccount(args, ctx) {
  const d = deps(ctx);
  const res = reg.addAccount(currentAccounts(ctx), args, undefined);
  if (!res.ok) return res;
  commit(res.accounts, ctx, d);
  return { ok: true, accounts: reg.toPublicList(res.accounts), account: reg.toPublicView(res.account) };
}

/** spip:updateMailAccount — 검증·수정(pass 미입력 시 기존 유지)·persist·재시작. */
function updateMailAccount(args, ctx) {
  const id = (args && typeof args === 'object') ? args.id : undefined;
  if (typeof id !== 'string' || !id) return { ok: false, code: 'NOT_FOUND' };
  const d = deps(ctx);
  const res = reg.updateAccount(currentAccounts(ctx), id, args, undefined);
  if (!res.ok) return res;
  commit(res.accounts, ctx, d);
  return { ok: true, accounts: reg.toPublicList(res.accounts), account: reg.toPublicView(res.account) };
}

/** spip:removeMailAccount — 삭제·persist·재시작. */
function removeMailAccount(args, ctx) {
  const id = (args && typeof args === 'object') ? args.id : undefined;
  if (typeof id !== 'string' || !id) return { ok: false, code: 'NOT_FOUND' };
  const d = deps(ctx);
  const res = reg.removeAccount(currentAccounts(ctx), id, undefined);
  if (!res.ok) return res;
  commit(res.accounts, ctx, d);
  return { ok: true, accounts: reg.toPublicList(res.accounts) };
}

/**
 * spip:testMailAccount — 실제 IMAP 로그인·STATUS를 1회 시도해 자격/연결을 검증한다.
 *   pass 미입력 + id 지정이면 저장된 비밀번호로 시험(저장 계정 점검). 그 외엔 입력 자격으로 시험.
 * @returns {Promise<{ok:true,status:{messages?,unseen?,uidnext?}} | {ok:false,code:'INVALID_*'|'AUTH'|'NETWORK'}>}
 */
async function testMailAccount(args, ctx) {
  const d = deps(ctx);
  args = (args && typeof args === 'object') ? args : {};
  // 저장 계정의 비밀번호 보충(렌더러는 비번을 다시 보내지 않을 수 있음).
  const merged = Object.assign({}, args);
  if ((merged.pass === undefined || merged.pass === null || merged.pass === '') && typeof merged.id === 'string') {
    const found = currentAccounts(ctx).find((a) => a && a.id === merged.id);
    if (found && typeof found.pass === 'string') merged.pass = found.pass;
  }
  const v = reg.validateAccountInput(merged);
  if (!v.ok) return v; // INVALID_HOST | INVALID_USER | INVALID_PASS | INVALID_PORT
  const { host, port, user, pass } = v.fields;
  try {
    const client = d.clientFactory({ host, port, user, pass });
    const st = await client.fetchInboxStatus('INBOX');
    return { ok: true, status: { messages: st.messages, unseen: st.unseen, uidnext: st.uidnext } };
  } catch (err) {
    return { ok: false, code: (err && err.authFailed) ? 'AUTH' : 'NETWORK' };
  }
}

module.exports = {
  getMailAccounts,
  addMailAccount,
  updateMailAccount,
  removeMailAccount,
  testMailAccount,
};
