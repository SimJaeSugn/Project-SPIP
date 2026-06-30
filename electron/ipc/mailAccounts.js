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
const mailBody = require('../../lib/mail/mailBody');
const { clampString } = require('../../lib/common/logger');

const MAIL_DIGEST_LIMIT = 5; // 계정당 미리보기 개수

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

/**
 * spip:getMailSummary — 계정별 안 읽은 메일 수 + 최근 미리보기(제목·발신자). 홈 브리핑용.
 *   계정마다 1회 IMAP 세션(EXAMINE read-only — 읽음표시 영향 없음). 병렬 수행, 실패는 계정 단위 격리.
 *   제목/발신자는 clampString으로 제어문자 제거·길이 절단(L-3) 후 노출(렌더는 textContent, L-1).
 * @returns {Promise<{ok:true, accounts:Array}>}
 */
async function getMailSummary(ctx) {
  const d = deps(ctx);
  const accounts = currentAccounts(ctx);
  const results = await Promise.all(accounts.map(async (a) => {
    const view = reg.toPublicView(a);
    try {
      const client = d.clientFactory({ host: a.host, port: a.port, user: a.user, pass: a.pass });
      // 모든 메일함(휴지통/스팸 제외)을 순회 — 폴더로 분류된 메일도 수집한다(INBOX 단독 한정 해제).
      const digest = await client.fetchUnseenDigestAll(MAIL_DIGEST_LIMIT);
      const items = (Array.isArray(digest.items) ? digest.items : []).map((m) => ({
        uid: Number.isInteger(m.uid) ? m.uid : null, // 본문 조회용
        subject: m.subject ? clampString(String(m.subject), 200) : null,
        from: m.from ? clampString(String(m.from), 120) : null,
        date: m.date ? clampString(String(m.date), 64) : null,
        mailbox: m.mailbox ? clampString(String(m.mailbox), 200) : null, // 본문 조회 시 소속 메일함(없으면 INBOX)
      }));
      return Object.assign({}, view, { ok: true, unseen: Number.isFinite(digest.unseen) ? digest.unseen : items.length, items });
    } catch (err) {
      return Object.assign({}, view, { ok: false, code: (err && err.authFailed) ? 'AUTH' : 'NETWORK', unseen: null, items: [] });
    }
  }));
  return { ok: true, accounts: results };
}

/**
 * spip:getMailMessage — 단건 메일 본문 조회(읽음표시 영향 없음, EXAMINE+BODY.PEEK 부분 fetch).
 * @param {object} args { accountId, uid }
 * @returns {Promise<{ok:true, subject, from, date, text} | {ok:false, code}>}
 */
async function getMailMessage(args, ctx) {
  const d = deps(ctx);
  args = (args && typeof args === 'object') ? args : {};
  const id = (typeof args.accountId === 'string' && args.accountId) ? args.accountId : '';
  const uid = Number(args.uid);
  if (!id || !Number.isInteger(uid) || uid <= 0) return { ok: false, code: 'INVALID' };
  // 메일이 속한 메일함(다이제스트 아이템이 전달). 제어문자(CRLF 인젝션) 제거 후 사용, 없으면 INBOX.
  const mailbox = (typeof args.mailbox === 'string' ? args.mailbox.replace(/[\x00-\x1F\x7F]/g, '') : '') || 'INBOX';
  const acct = currentAccounts(ctx).find((a) => a && a.id === id);
  if (!acct) return { ok: false, code: 'NOT_FOUND' };
  try {
    const client = d.clientFactory({ host: acct.host, port: acct.port, user: acct.user, pass: acct.pass });
    const raw = await client.fetchMessage(uid, mailbox);
    const msg = mailBody.parseMessage(raw);
    // [메일 뷰어] 정제 HTML을 메인에 보관 → 격리 문서(app://mailbody)가 서빙. 렌더러엔 hasHtml만(대용량 회송 회피).
    const html = (typeof msg.html === 'string') ? msg.html : '';
    if (ctx && typeof ctx.setMailViewHtml === 'function') { try { ctx.setMailViewHtml(html); } catch (_) { /* noop */ } }
    return {
      ok: true,
      subject: msg.subject ? clampString(String(msg.subject), 300) : null,
      from: msg.from ? clampString(String(msg.from), 200) : null,
      date: msg.date ? clampString(String(msg.date), 64) : null,
      text: typeof msg.text === 'string' ? msg.text : '', // mailBody가 이미 정제(개행 보존)
      hasHtml: html.length > 0, // 격리 iframe 렌더 가능 여부
    };
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
  getMailSummary,
  getMailMessage,
};
