'use strict';
/**
 * electron/ipc/mailArchive.js — 메일 보관함 IPC (계정별·메일함별 수집 메일 영속 보관)
 *
 *   spip:getMailArchive            → 보관함 뷰(계정→메일함→메일 트리). 디스크에서 읽어 라벨 결합.
 *   spip:syncMailArchive  (async)  → 계정마다 IMAP 전체 메일 인덱스 수집 → 직전 보관함과 병합·영속.
 *                                     읽음/삭제 상태를 서버와 동기화(읽음표시 영향 없음 — EXAMINE read-only).
 *   spip:deleteMailArchiveItem     → 로컬 보관함에서만 삭제(서버 미접촉). 단건/메일함비우기/계정초기화.
 *
 * 보안·정합:
 *   · 본문은 저장하지 않는다(메타만). 본문 조회는 기존 spip:getMailMessage(EXAMINE+BODY.PEEK) 사용.
 *   · 영속은 mailArchiveStore(0600·정규화·상한). read-modify-write는 withWriteLock으로 직렬화(느린
 *     IMAP 수집은 락 밖에서 끝낸 뒤, 최신 보관함을 락 안에서 재-read해 병합·write — 동시 sync/delete 보호).
 *   · 비밀번호는 응답에 싣지 않는다(라벨/호스트/유저만 뷰에 포함).
 *
 * [헤드리스 검증] mailClientFactory·mailArchivePath를 ctx로 주입 가능(네트워크·디스크 없이 단위테스트).
 *
 * 외부 의존성 0 — 내부(mailArchive, mailArchiveStore, imapClient).
 */

const archiveStore = require('../../lib/mail/mailArchiveStore');
const mailArchive = require('../../lib/mail/mailArchive');
const { ImapClient } = require('../../lib/mail/imapClient');
const { decodeModifiedUtf7 } = require('../../lib/mail/imapProtocol');

const SYNC_MAX_FOLDERS = mailArchive.MAX_FOLDERS;
const SYNC_PER_FOLDER = mailArchive.MAX_ITEMS;

/** ctx 의존성 해석(주입 우선). */
function deps(ctx) {
  return {
    clientFactory: (ctx && typeof ctx.mailClientFactory === 'function') ? ctx.mailClientFactory : ((creds) => new ImapClient(creds)),
  };
}

/** 영속 저장소 ctx(주입 경로 우선). */
function storeCtx(ctx) {
  return { logger: ctx && ctx.logger, mailArchivePath: ctx && ctx.mailArchivePath, deps: ctx && ctx.mailArchiveDeps };
}

function currentAccounts(ctx) {
  return (ctx && ctx.config && Array.isArray(ctx.config.mailAccounts)) ? ctx.config.mailAccounts : [];
}

// 보관함 변이 직렬화 큐(같은 파일 read-modify-write 순차화) — shelf.withWriteLock 패턴.
const _writeChains = new Map();
function withWriteLock(ctx, fn) {
  const key = (ctx && ctx.mailArchivePath) || '__default__';
  const prev = _writeChains.get(key) || Promise.resolve();
  const run = prev.then(() => fn());
  _writeChains.set(key, run.then(() => {}, () => {}));
  return run;
}

/** RFC2822 날짜 → epoch ms(실패 0). 메일 정렬용. */
function dateMs(s) { const t = Date.parse(s); return Number.isFinite(t) ? t : 0; }

/** INBOX 우선, 그 외 이름 오름차순 비교자. */
function mailboxOrder(a, b) {
  const ai = a.toLowerCase() === 'inbox' ? 0 : 1;
  const bi = b.toLowerCase() === 'inbox' ? 0 : 1;
  if (ai !== bi) return ai - bi;
  return a < b ? -1 : (a > b ? 1 : 0);
}

/**
 * 영속 보관함 + 현재 계정 목록 → 렌더러 뷰.
 *   config에 있는 계정은 보관함이 비어도 표시(서버 목록 노출). 보관함에만 있고 config엔 없는 계정도 표시.
 */
function toView(archive, accounts) {
  const metaById = new Map();
  for (const a of accounts) { if (a && typeof a.id === 'string') metaById.set(a.id, a); }
  const ids = new Set();
  for (const a of accounts) { if (a && typeof a.id === 'string') ids.add(a.id); }
  for (const id of Object.keys(archive.accounts || {})) ids.add(id);

  const out = [];
  for (const id of ids) {
    const meta = metaById.get(id);
    const acct = archive.accounts[id];
    const mailboxesObj = (acct && acct.mailboxes) ? acct.mailboxes : {};
    const names = Object.keys(mailboxesObj).sort(mailboxOrder);
    const mailboxes = names.map((name) => {
      const items = (Array.isArray(mailboxesObj[name].items) ? mailboxesObj[name].items : [])
        .slice()
        .sort((x, y) => (dateMs(y.date) - dateMs(x.date)) || (y.uid - x.uid));
      const unread = items.filter((it) => it.onServer && !it.seen).length;
      // name은 IMAP 원본(EXAMINE/조회용 — 인코딩 그대로), displayName은 한글 등 표시용(modified UTF-7 디코드).
      return { name, displayName: decodeModifiedUtf7(name), total: items.length, unread, items };
    });
    out.push({
      accountId: id,
      label: meta ? meta.label : null,
      host: meta ? meta.host : null,
      user: meta ? meta.user : null,
      inConfig: !!meta,
      mailboxes,
    });
  }
  // 라벨 기준 정렬(없으면 host/id).
  out.sort((a, b) => {
    const ka = (a.label || a.host || a.accountId || '').toLowerCase();
    const kb = (b.label || b.host || b.accountId || '').toLowerCase();
    return ka < kb ? -1 : (ka > kb ? 1 : 0);
  });
  return out;
}

/** spip:getMailArchive — 디스크 보관함을 읽어 뷰로 반환. */
function getMailArchive(ctx) {
  const archive = archiveStore.read(storeCtx(ctx));
  return { ok: true, accounts: toView(archive, currentAccounts(ctx)) };
}

/**
 * spip:syncMailArchive — 모든 계정의 IMAP 전체 메일 인덱스를 수집해 보관함과 병합·영속한다.
 *   느린 IMAP 수집은 락 밖에서 계정별로 수행(실패 격리)하고, 병합·write만 락 안에서 한다.
 * @returns {Promise<{ok:true, accounts:Array, errors:Array<{accountId,code}>}>}
 */
async function syncMailArchive(ctx) {
  const d = deps(ctx);
  const accounts = currentAccounts(ctx);
  const fresh = [];   // { accountId, folders }
  const errors = [];
  await Promise.all(accounts.map(async (a) => {
    if (!a || typeof a.id !== 'string') return;
    try {
      const client = d.clientFactory({ host: a.host, port: a.port, user: a.user, pass: a.pass });
      const folders = await client.fetchMailIndexAll({ maxFolders: SYNC_MAX_FOLDERS, perFolder: SYNC_PER_FOLDER });
      fresh.push({ accountId: a.id, folders });
    } catch (err) {
      errors.push({ accountId: a.id, code: (err && err.authFailed) ? 'AUTH' : 'NETWORK' });
    }
  }));

  const saved = await withWriteLock(ctx, () => {
    const cur = archiveStore.read(storeCtx(ctx)); // 락 안에서 최신 재-read(동시 변이 보호)
    for (const f of fresh) {
      cur.accounts[f.accountId] = mailArchive.mergeAccount(cur.accounts[f.accountId], f.folders, mailArchive.DEFAULT_MERGE_OPTS);
    }
    return archiveStore.write(cur, storeCtx(ctx));
  });
  return { ok: true, accounts: toView(saved, accounts), errors };
}

/**
 * spip:deleteMailArchiveItem — 메일을 삭제한다. 단건/메일함비우기는 **서버에서도 삭제**(휴지통 이동),
 *   계정 초기화는 로컬 보관함만 정리(서버 미접촉).
 *   args: { accountId, mailbox?, uid? }
 *     - uid 지정     → 단건: 서버 휴지통 이동 + 로컬 제거(tombstone)
 *     - mailbox만    → 메일함 비우기: 그 폴더의 서버 메일 일괄 휴지통 이동 + 로컬 제거
 *     - accountId만  → 계정 보관함 초기화(로컬만)
 *   느린 IMAP 삭제는 락 밖에서 먼저 수행하고, 성공 시에만 로컬을 갱신한다(서버 실패 시 로컬 보존).
 * @returns {Promise<{ok:true, accounts:Array} | {ok:false, code}>}
 */
async function deleteMailArchiveItem(args, ctx) {
  args = (args && typeof args === 'object') ? args : {};
  const accountId = (typeof args.accountId === 'string') ? args.accountId : '';
  if (!accountId) return { ok: false, code: 'INVALID' };
  const mailbox = (typeof args.mailbox === 'string' && args.mailbox) ? args.mailbox : null;
  const hasUid = args.uid !== undefined && args.uid !== null && args.uid !== '';
  const uid = hasUid ? Number(args.uid) : null;
  if (hasUid && (!Number.isInteger(uid) || uid <= 0)) return { ok: false, code: 'INVALID' };

  const d = deps(ctx);
  const accounts = currentAccounts(ctx);
  const acct = accounts.find((a) => a && a.id === accountId);

  // 서버에서 삭제할 uid 목록 결정(계정 초기화는 서버 미접촉).
  let serverUids = [];
  if (mailbox && hasUid) {
    serverUids = [uid];
  } else if (mailbox && !hasUid) {
    // 메일함 비우기 — 현재 보관함에서 서버 보유(onServer) 메일 uid 수집.
    const cur0 = archiveStore.read(storeCtx(ctx));
    const acc0 = cur0.accounts[accountId];
    const mb0 = acc0 && acc0.mailboxes && acc0.mailboxes[mailbox];
    serverUids = (mb0 && Array.isArray(mb0.items)) ? mb0.items.filter((it) => it.onServer).map((it) => it.uid) : [];
  }

  // 서버 삭제(휴지통 이동) — 락 밖에서. 계정 자격이 있어야 가능. 실패 시 로컬도 건드리지 않음.
  if (serverUids.length && acct) {
    try {
      const client = d.clientFactory({ host: acct.host, port: acct.port, user: acct.user, pass: acct.pass });
      await client.deleteMessages(mailbox, serverUids, { permanent: false });
    } catch (err) {
      return { ok: false, code: (err && err.authFailed) ? 'AUTH' : 'NETWORK' };
    }
  }

  const saved = await withWriteLock(ctx, () => {
    const cur = archiveStore.read(storeCtx(ctx));
    if (hasUid) {
      if (!mailbox) return cur; // uid엔 mailbox 필수
      mailArchive.deleteItem(cur, accountId, mailbox, uid, mailArchive.DEFAULT_MERGE_OPTS);
    } else if (mailbox) {
      mailArchive.clearMailbox(cur, accountId, mailbox, mailArchive.DEFAULT_MERGE_OPTS);
    } else {
      mailArchive.removeAccount(cur, accountId);
    }
    return archiveStore.write(cur, storeCtx(ctx));
  });
  return { ok: true, accounts: toView(saved, accounts) };
}

module.exports = {
  getMailArchive,
  syncMailArchive,
  deleteMailArchiveItem,
};
