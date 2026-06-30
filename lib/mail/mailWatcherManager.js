'use strict';
/**
 * lib/mail/mailWatcherManager.js — 복수 계정 메일 감시 관리자
 *
 * 계정마다 독립 MailWatcher를 띄워 각자 폴링하게 하고, 콜백에 어떤 계정인지(공개 뷰)를 실어
 * 상위(main의 트레이 알림)로 올린다. 단일 MailWatcher 로직(기준선·인증실패 중단·재진입 가드)을
 * 그대로 재사용한다(추가 상태 없음).
 *
 * apply(accounts)는 전체 재구성(기존 전부 stop 후 새로 start) — 계정 편집은 드문 이벤트라
 * 단순·안전한 재구성을 택한다(부분 reconcile 버그 회피). 재구성 시 각 워처는 기준선부터
 * 다시 잡으므로, 편집 직후 폴링은 통지 없이 기준선만 설정한다(중복 알림 방지).
 *
 * [헤드리스 검증] clientFactory(creds→{fetchAllStatus})·setInterval은 자식 MailWatcher로 주입.
 *
 * 외부 의존성 0 — 내부(mailWatcher, mailAccounts, logger).
 */

const { defaultLogger } = require('../common/logger');
const { MailWatcher } = require('./mailWatcher');
const { toPublicView } = require('./mailAccounts');

class MailWatcherManager {
  constructor(opts) {
    opts = opts || {};
    this.logger = opts.logger || defaultLogger;
    this.intervalMs = opts.intervalMs; // MailWatcher가 clamp(기본/하한)
    this._clientFactory = opts.clientFactory || null; // 자식에 전달(미지정 시 실제 ImapClient)
    this._setInterval = (typeof opts.setInterval === 'function') ? opts.setInterval : null;
    this._watchers = new Map(); // id -> MailWatcher
  }

  isRunning() { return this._watchers.size > 0; }
  size() { return this._watchers.size; }

  /**
   * 계정 목록으로 감시를 재구성한다(기존 전부 정지 후 새로 시작).
   * @param {Array} accounts 정규화된 계정 배열({id,label,host,port,user,pass})
   * @param {object} cbs { onNewMail({account,newCount,unseen,uidnext}), onAuthError({account,err}) }
   */
  apply(accounts, cbs) {
    cbs = cbs || {};
    const onNewMail = typeof cbs.onNewMail === 'function' ? cbs.onNewMail : null;
    const onAuthError = typeof cbs.onAuthError === 'function' ? cbs.onAuthError : null;
    this.stop();
    const list = Array.isArray(accounts) ? accounts : [];
    for (const account of list) {
      if (!account || typeof account.id !== 'string') continue;
      const w = new MailWatcher({
        logger: this.logger,
        intervalMs: this.intervalMs,
        clientFactory: this._clientFactory || undefined,
      });
      const view = toPublicView(account);
      const started = w.start({
        credentials: account, // {host,port,user,pass} (+id/label 무시됨)
        onNewMail: onNewMail ? (payload) => onNewMail(Object.assign({ account: view }, payload)) : undefined,
        onAuthError: onAuthError ? (err) => onAuthError({ account: view, err }) : undefined,
        setInterval: this._setInterval || undefined,
      });
      if (started) this._watchers.set(account.id, w);
    }
  }

  /** 모든 계정 즉시 1회 폴링(트레이 '메일 지금 확인'). */
  checkNow() {
    for (const w of this._watchers.values()) {
      try { w.tick(); } catch (_) { /* 개별 워처 예외 격리 */ }
    }
  }

  /** 전체 정지(멱등). */
  stop() {
    for (const w of this._watchers.values()) {
      try { w.stop(); } catch (_) { /* noop */ }
    }
    this._watchers.clear();
  }
}

module.exports = { MailWatcherManager };
