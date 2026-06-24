'use strict';
/**
 * lib/mail/mailWatcher.js — 새 메일 주기 감시(폴링) (StateWatcher 패턴 차용, ADR-M8-1 동형)
 *
 * 주기적으로 IMAP STATUS(INBOX)를 조회해 UIDNEXT 증가를 "새 메일 도착"으로 감지하고
 * onNewMail 콜백으로 통지한다(main이 트레이 풍선 알림으로 노출). 최초 1회 폴링은 기준선(baseline)
 * 만 설정하고 통지하지 않는다 — 앱 시작 시 과거 메일로 알림이 폭주하는 것을 막는다.
 *
 * UIDNEXT는 "다음에 부여될 UID"라 단조 증가하며, 증가분이 곧 새로 추가된 메시지 수다. SELECT 없이
 * STATUS만 쓰므로 읽음 상태를 바꾸지 않고(부작용 0) 저비용이다.
 *
 * 보안/가용성:
 *   · _busy 재진입 가드 — 직전 폴링이 끝나야 다음이 돈다(느린 네트워크에서 폴링 누적 방지).
 *   · setInterval 타이머 unref — 워처가 프로세스 종료를 막지 않는다.
 *   · 폴링 실패는 격리(로깅 후 다음 주기 재시도) — 자격/네트워크 오류로 앱이 죽지 않는다.
 *   · 자격(비밀번호)은 보관만 하고 로깅하지 않는다(L-3).
 *
 * [헤드리스 검증, F-3] clientFactory(creds→{fetchInboxStatus()})·setInterval 주입으로
 *   네트워크 없이 단위테스트한다. Electron API 미import.
 *
 * 외부 의존성 0 — 내부(imapClient, logger) + 주입 가능 deps.
 */

const { defaultLogger } = require('../common/logger');
const { ImapClient } = require('./imapClient');

const DEFAULT_INTERVAL_MS = 60000; // 1분
const MIN_INTERVAL_MS = 15000;     // 서버 부담·차단 방지 하한

class MailWatcher {
  constructor(opts) {
    opts = opts || {};
    this.logger = opts.logger || defaultLogger;
    const want = (typeof opts.intervalMs === 'number' && Number.isFinite(opts.intervalMs))
      ? opts.intervalMs : DEFAULT_INTERVAL_MS;
    this.intervalMs = Math.max(MIN_INTERVAL_MS, want);
    this.mailbox = opts.mailbox || 'INBOX';
    // 주입 가능 deps(테스트): 자격 → IMAP 클라이언트 팩토리.
    this._clientFactory = typeof opts.clientFactory === 'function'
      ? opts.clientFactory
      : ((creds) => new ImapClient(creds));
    this._timer = null;
    this._busy = false;
    this._credentials = null;
    this._onNewMail = null;
    this._onAuthError = null;
    this._lastUidnext = null;
    this._baselined = false;
    this._authFailed = false; // 인증 실패로 감시를 영구 중단한 상태(재시도 안 함).
  }

  isRunning() { return this._timer !== null; }

  /**
   * 감시 시작. 즉시 1회(기준선) 폴링한 뒤 intervalMs마다 주기 폴링한다.
   * @param {object} opts { credentials, onNewMail, onAuthError?, setInterval? }
   *   - credentials { host, port, user, pass } — 없으면 시작하지 않고 false 반환.
   *   - onNewMail({ newCount, unseen, uidnext }) — 새 메일 감지 시(기준선 이후)만 호출.
   *   - onAuthError(err) — 인증 실패로 감시를 중단할 때 1회 호출(자격 점검 안내용).
   * @returns {boolean} 시작 여부.
   */
  start(opts) {
    opts = opts || {};
    this._credentials = opts.credentials || null;
    this._onNewMail = typeof opts.onNewMail === 'function' ? opts.onNewMail : null;
    this._onAuthError = typeof opts.onAuthError === 'function' ? opts.onAuthError : null;
    if (!this._credentials) {
      if (this.logger && this.logger.warn) this.logger.warn('메일 감시: 자격 정보가 없어 시작하지 않습니다');
      return false;
    }
    if (this._timer) return true; // 멱등
    const setIv = (typeof opts.setInterval === 'function') ? opts.setInterval : setInterval;
    // 즉시 1회(기준선) — 실패해도 다음 주기에 재시도.
    this.tick();
    this._timer = setIv(() => { this.tick(); }, this.intervalMs);
    if (this._timer && typeof this._timer.unref === 'function') this._timer.unref();
    return true;
  }

  /** 감시 중지(멱등). */
  stop() {
    if (this._timer) {
      try { clearInterval(this._timer); } catch (_) { /* noop */ }
      this._timer = null;
    }
  }

  /**
   * 한 번의 폴링. INBOX STATUS의 UIDNEXT 증가를 감지해 onNewMail을 호출한다.
   * 직전 폴링 진행 중(_busy)이거나 자격이 없으면 즉시 반환. 실패는 격리(다음 주기 재시도).
   * @returns {Promise<{newCount,unseen,uidnext}|null>} 새 메일 통지 페이로드(없으면 null).
   */
  async tick() {
    if (this._authFailed) return null; // 인증 실패로 중단됨 — 더 시도하지 않음(계정 잠금 방지)
    if (this._busy) return null;
    if (!this._credentials) return null;
    this._busy = true;
    let payload = null;
    try {
      const client = this._clientFactory(this._credentials);
      const st = await client.fetchInboxStatus(this.mailbox);
      const uidnext = (st && Number.isFinite(st.uidnext)) ? st.uidnext : null;
      const unseen = (st && Number.isFinite(st.unseen)) ? st.unseen : null;
      if (uidnext === null) return null; // UIDNEXT 미제공 — 판단 보류

      if (!this._baselined) {
        // 최초 폴링: 기준선만 잡고 통지하지 않음.
        this._baselined = true;
        this._lastUidnext = uidnext;
        return null;
      }
      if (uidnext > this._lastUidnext) {
        const newCount = uidnext - this._lastUidnext;
        this._lastUidnext = uidnext;
        payload = { newCount, unseen, uidnext };
        if (this._onNewMail) {
          try { this._onNewMail(payload); } catch (_) { /* 구독자 예외 격리 */ }
        }
      } else if (uidnext < this._lastUidnext) {
        // 메일함 재생성 등으로 UIDNEXT가 줄면 기준선을 재설정(오탐 방지).
        this._lastUidnext = uidnext;
      }
    } catch (err) {
      if (err && err.authFailed) {
        // 인증 실패는 재시도로 풀리지 않음 — 감시를 중단하고 1회만 통지(계정 잠금·콘솔 폭주 방지).
        this._authFailed = true;
        this.stop();
        if (this.logger && this.logger.error) this.logger.error('메일 감시: 인증 실패로 감시를 중단합니다(자격 확인 필요)', err);
        if (this._onAuthError) { try { this._onAuthError(err); } catch (_) { /* 구독자 예외 격리 */ } }
      } else if (this.logger && this.logger.error) {
        // 일시적(네트워크 등) 오류는 격리하고 다음 주기에 재시도.
        this.logger.error('메일 감시 폴링 실패', err);
      }
    } finally {
      this._busy = false;
    }
    return payload;
  }
}

module.exports = { MailWatcher, DEFAULT_INTERVAL_MS, MIN_INTERVAL_MS };
