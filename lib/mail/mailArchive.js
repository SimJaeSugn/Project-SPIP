'use strict';
/**
 * lib/mail/mailArchive.js — 메일 보관함 병합·정규화 (순수 로직, 헤드리스 단위테스트)
 *
 * 보관함 = 계정(메일서버)별 → 메일함(폴더)별 → 수집 메일 메타데이터 트리. 사용자가 로컬에서 삭제하기
 * 전까지 보관한다(서버에서 사라져도 유지). 본문은 저장하지 않고(클릭 시 IMAP 조회) 메타만 보관한다.
 *
 * 모델:
 *   archive = { schemaVersion, accounts: { [accountId]: { mailboxes: { [name]: Folder } } } }
 *   Folder  = { uidvalidity:(number|null), items: Item[], deletedUids: number[] }
 *   Item    = { uid:int, subject, from, date, seen:bool, onServer:bool }
 *
 * 동기화(mergeAccount): IMAP에서 가져온 신선한 인덱스(전체 uid + 최신 상세)를 직전 보관함과 병합한다.
 *   - 서버에 있는 메일(fresh.entries): 메타·읽음상태(seen)를 갱신하고 onServer=true.
 *   - 직전엔 있었는데 서버 uid 목록에 없는 메일: 보관하되 onServer=false(서버에서 삭제/이동됨).
 *   - 로컬 삭제 tombstone(deletedUids): 다시 수집해도 되살아나지 않게 억제. 서버에서도 사라지면 정리.
 *   - UIDVALIDITY가 바뀌면(메일함 재생성) 해당 폴더의 uid 네임스페이스를 재설정한다.
 *
 * 정규화(normalizeArchive): 디스크/렌더러 입력을 신뢰하지 않고 형식·상한·문자열을 전부 재검증한다.
 *
 * 외부 의존성 0 — 내부(logger.clampString)만.
 */

const { clampString } = require('../common/logger');

const SCHEMA_VERSION = 1;
const MAX_ACCOUNTS = 10;          // 계정 수 상한
const MAX_FOLDERS = 30;           // 계정당 메일함 수 상한
const MAX_ITEMS = 150;            // 메일함당 서버 보유 메일(onServer) 상한(최신 우선)
const MAX_GONE = 100;             // 메일함당 서버에서 사라진 보관 메일 상한(최신 우선)
const MAX_TOMB = 1000;            // 메일함당 로컬 삭제 tombstone 상한
const MAX_SUBJECT = 200;
const MAX_FROM = 120;
const MAX_DATE = 64;
const MAX_MAILBOX_NAME = 200;

const ACCOUNT_ID_RE = /^[a-z0-9]{6,32}$/; // mailAccounts.ID_RE와 동일

const DEFAULT_MERGE_OPTS = { maxItems: MAX_ITEMS, maxGone: MAX_GONE, maxTomb: MAX_TOMB };

/** 빈 보관함(graceful 기본값). */
function defaultArchive() {
  return { schemaVersion: SCHEMA_VERSION, accounts: {} };
}

function isPlainObject(v) {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

/** 문자열 필드 정제(제어문자 제거·길이 절단). null/비문자열은 null. */
function cleanStr(s, max) {
  if (typeof s !== 'string' || !s) return null;
  return clampString(s, max);
}

/** 정제된 Item 생성. */
function mkItem(uid, subject, from, date, seen, onServer) {
  return {
    uid: uid,
    subject: cleanStr(subject, MAX_SUBJECT),
    from: cleanStr(from, MAX_FROM),
    date: cleanStr(date, MAX_DATE),
    seen: !!seen,
    onServer: !!onServer,
  };
}

/** uid 내림차순 정렬 + uid 중복 제거(앞선 것 우선) + 상한. */
function sortDedupeCap(items, max) {
  const sorted = items.slice().sort((a, b) => b.uid - a.uid);
  const seen = new Set();
  const out = [];
  for (const it of sorted) {
    if (seen.has(it.uid)) continue;
    seen.add(it.uid);
    out.push(it);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * 한 메일함의 신선 인덱스를 직전 폴더와 병합한다.
 * @param {object|null} prevFolder 직전 Folder
 * @param {{uidvalidity:(number|null), serverUids:(number[]|Set), entries:Array}} fresh IMAP 인덱스
 * @param {object} opts { maxItems, maxGone, maxTomb }
 * @returns {{uidvalidity:(number|null), items:Item[], deletedUids:number[]}}
 */
function mergeFolder(prevFolder, fresh, opts) {
  opts = opts || DEFAULT_MERGE_OPTS;
  const prev = isPlainObject(prevFolder) ? prevFolder : { uidvalidity: null, items: [], deletedUids: [] };
  const freshUv = Number.isFinite(fresh && fresh.uidvalidity) ? fresh.uidvalidity : null;
  const prevUv = Number.isFinite(prev.uidvalidity) ? prev.uidvalidity : null;
  const reset = prevUv != null && freshUv != null && prevUv !== freshUv; // 메일함 재생성 → uid 재설정

  const prevItems = (reset || !Array.isArray(prev.items)) ? [] : prev.items;
  const prevTomb = (reset || !Array.isArray(prev.deletedUids)) ? [] : prev.deletedUids.filter(Number.isInteger);
  const tombSet = new Set(prevTomb);

  const serverArr = (fresh && fresh.serverUids instanceof Set)
    ? Array.from(fresh.serverUids)
    : (Array.isArray(fresh && fresh.serverUids) ? fresh.serverUids : []);
  const serverSet = new Set(serverArr.filter(Number.isInteger));

  // 서버 보유(live): 신선 상세 항목, 로컬 삭제(tombstone) 제외.
  const live = [];
  for (const e of (Array.isArray(fresh && fresh.entries) ? fresh.entries : [])) {
    if (!e || !Number.isInteger(e.uid) || tombSet.has(e.uid)) continue;
    live.push(mkItem(e.uid, e.subject, e.from, e.date, e.seen, true));
  }
  // 서버에서 사라진(gone): 직전엔 있었으나 서버 uid 목록에 없고 tombstone도 아닌 항목.
  const gone = [];
  for (const it of prevItems) {
    if (!it || !Number.isInteger(it.uid)) continue;
    if (serverSet.has(it.uid) || tombSet.has(it.uid)) continue;
    gone.push(mkItem(it.uid, it.subject, it.from, it.date, it.seen, false));
  }

  const items = sortDedupeCap(live, opts.maxItems).concat(sortDedupeCap(gone, opts.maxGone));
  // tombstone 정리: 서버에 아직 있는 것만 유지(재수집 억제). 서버에서도 사라졌으면 더 억제할 필요 없음.
  const deletedUids = prevTomb.filter((u) => serverSet.has(u)).slice(-opts.maxTomb);
  return { uidvalidity: (freshUv != null ? freshUv : prevUv), items: items, deletedUids: deletedUids };
}

/**
 * 한 계정의 신선 폴더 인덱스 배열을 직전 계정 보관함과 병합한다.
 *   이번 동기화에 없는 폴더는 직전 상태를 그대로 유지한다(서버 상태를 알 수 없으므로).
 * @param {object|null} prevAccount { mailboxes }
 * @param {Array} freshFolders [{mailbox, uidvalidity, serverUids, entries}]
 * @param {object} [opts]
 * @returns {{mailboxes:object}}
 */
function mergeAccount(prevAccount, freshFolders, opts) {
  opts = opts || DEFAULT_MERGE_OPTS;
  const prevMb = (isPlainObject(prevAccount) && isPlainObject(prevAccount.mailboxes)) ? prevAccount.mailboxes : {};
  const mailboxes = {};
  for (const name of Object.keys(prevMb)) mailboxes[name] = prevMb[name]; // 미동기화 폴더 보존
  for (const f of (Array.isArray(freshFolders) ? freshFolders : [])) {
    if (!f || typeof f.mailbox !== 'string' || !f.mailbox) continue;
    mailboxes[f.mailbox] = mergeFolder(prevMb[f.mailbox], f, opts);
  }
  return { mailboxes: mailboxes };
}

// ── 로컬 삭제 연산(서버 미접촉) ──

/** 단건 삭제: 항목 제거 + tombstone 추가(재수집 시 부활 방지). */
function deleteItem(archive, accountId, mailbox, uid, opts) {
  opts = opts || DEFAULT_MERGE_OPTS;
  const a = archive && archive.accounts && archive.accounts[accountId];
  const mb = a && a.mailboxes && a.mailboxes[mailbox];
  if (!mb || !Number.isInteger(uid)) return archive;
  mb.items = (Array.isArray(mb.items) ? mb.items : []).filter((it) => it.uid !== uid);
  const tomb = new Set(Array.isArray(mb.deletedUids) ? mb.deletedUids : []);
  tomb.add(uid);
  mb.deletedUids = Array.from(tomb).slice(-opts.maxTomb);
  return archive;
}

/** 메일함 비우기: 모든 항목 제거 + 서버 보유 항목 uid를 tombstone(재수집 부활 방지). */
function clearMailbox(archive, accountId, mailbox, opts) {
  opts = opts || DEFAULT_MERGE_OPTS;
  const a = archive && archive.accounts && archive.accounts[accountId];
  const mb = a && a.mailboxes && a.mailboxes[mailbox];
  if (!mb) return archive;
  const tomb = new Set(Array.isArray(mb.deletedUids) ? mb.deletedUids : []);
  for (const it of (Array.isArray(mb.items) ? mb.items : [])) { if (it.onServer) tomb.add(it.uid); }
  mb.deletedUids = Array.from(tomb).slice(-opts.maxTomb);
  mb.items = [];
  return archive;
}

/** 계정 보관함 전체 제거(완전 초기화 — tombstone도 함께 사라짐). */
function removeAccount(archive, accountId) {
  if (archive && archive.accounts && Object.prototype.hasOwnProperty.call(archive.accounts, accountId)) {
    delete archive.accounts[accountId];
  }
  return archive;
}

// ── 정규화(신뢰 경계: 디스크/렌더러 입력 재검증) ──

/** 한 폴더를 정규화(형식·상한·문자열). */
function normalizeFolder(obj) {
  if (!isPlainObject(obj)) return { uidvalidity: null, items: [], deletedUids: [] };
  const uidvalidity = Number.isFinite(obj.uidvalidity) ? obj.uidvalidity : null;
  const rawItems = Array.isArray(obj.items) ? obj.items : [];
  const live = [];
  const gone = [];
  const seen = new Set();
  for (const it of rawItems) {
    if (!isPlainObject(it) || !Number.isInteger(it.uid) || it.uid <= 0 || seen.has(it.uid)) continue;
    seen.add(it.uid);
    const item = mkItem(it.uid, it.subject, it.from, it.date, it.seen, it.onServer);
    (item.onServer ? live : gone).push(item);
  }
  const items = sortDedupeCap(live, MAX_ITEMS).concat(sortDedupeCap(gone, MAX_GONE));
  const deletedUids = (Array.isArray(obj.deletedUids) ? obj.deletedUids : [])
    .filter((u) => Number.isInteger(u) && u > 0).slice(-MAX_TOMB);
  return { uidvalidity: uidvalidity, items: items, deletedUids: deletedUids };
}

/** 보관함 전체 정규화(graceful). 어떤 입력이든 안전한 구조를 반환. */
function normalizeArchive(obj) {
  const out = defaultArchive();
  if (!isPlainObject(obj) || !isPlainObject(obj.accounts)) return out;
  let acctCount = 0;
  for (const accountId of Object.keys(obj.accounts)) {
    if (acctCount >= MAX_ACCOUNTS) break;
    if (!ACCOUNT_ID_RE.test(accountId)) continue;
    const acct = obj.accounts[accountId];
    if (!isPlainObject(acct) || !isPlainObject(acct.mailboxes)) continue;
    const mailboxes = {};
    let folderCount = 0;
    for (const rawName of Object.keys(acct.mailboxes)) {
      if (folderCount >= MAX_FOLDERS) break;
      const name = cleanStr(rawName, MAX_MAILBOX_NAME);
      if (!name) continue;
      mailboxes[name] = normalizeFolder(acct.mailboxes[rawName]);
      folderCount++;
    }
    out.accounts[accountId] = { mailboxes: mailboxes };
    acctCount++;
  }
  return out;
}

module.exports = {
  SCHEMA_VERSION, MAX_ACCOUNTS, MAX_FOLDERS, MAX_ITEMS, MAX_GONE, MAX_TOMB, DEFAULT_MERGE_OPTS,
  defaultArchive, normalizeArchive, normalizeFolder,
  mergeFolder, mergeAccount,
  deleteItem, clearMailbox, removeAccount,
};
