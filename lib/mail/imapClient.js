'use strict';
/**
 * lib/mail/imapClient.js — 최소 IMAP over TLS 클라이언트 (런타임 의존성 0: Node tls만)
 *
 * 새 메일 감지에 필요한 최소 명령만 구현한다: LOGIN → STATUS INBOX (MESSAGES UNSEEN UIDNEXT)
 * → LOGOUT. FETCH/literal({n})은 쓰지 않아 응답 파싱이 단순하고 공격 표면이 작다. 응답 해석은
 * imapProtocol.js 순수 함수에 위임한다.
 *
 * 보안:
 *   · 암묵 TLS(기본 993). rejectUnauthorized=true — 서버 인증서를 검증한다(중간자 차단).
 *   · 비밀번호·명령 원문을 로깅하지 않는다(L-3).
 *   · 모든 작업에 소켓 타임아웃(기본 15s) — 응답 없는 서버에 매달리지 않는다(가용성).
 *   · 응답 버퍼 상한(1MB) — 비정상 서버의 무한 응답으로 메모리가 폭주하지 않는다.
 *
 * [헤드리스 검증] connect를 deps로 주입 가능(가짜 소켓으로 단위테스트). 기본은 tls.connect.
 *
 * 외부 의존성 0 — Node 내장 tls + 내부 imapProtocol.
 */

const tls = require('tls');
const { imapQuote, parseTaggedLine, parseStatusItems } = require('./imapProtocol');

const DEFAULT_TIMEOUT_MS = 15000;
const MAX_BUFFER = 1 << 20; // 1MB

class ImapClient {
  /**
   * @param {object} opts { host, port?, user, pass, timeoutMs?, connect? }
   *   - connect(options) => Duplex : tls.connect 대체(테스트 주입). 기본 tls.connect.
   */
  constructor(opts) {
    opts = opts || {};
    this.host = opts.host;
    this.port = opts.port || 993;
    this.user = opts.user;
    this.pass = opts.pass;
    this.timeoutMs = (typeof opts.timeoutMs === 'number' && opts.timeoutMs > 0) ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
    this._connect = typeof opts.connect === 'function' ? opts.connect : ((o) => tls.connect(o));
    this._sock = null;
    this._buf = '';
    this._tagSeq = 0;
    this._waiters = [];   // [{ tag, lines, resolve, reject }]
    this._greeted = null; // 그리팅(* OK ...) 1회 콜백
    this._closed = false;
  }

  /** TLS 연결 후 서버 그리팅(`* OK ...`)을 받으면 resolve. */
  connect() {
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (fn, arg) => { if (!settled) { settled = true; fn(arg); } };
      this._greeted = (line) => done(resolve, line);

      let sock;
      try {
        sock = this._connect({ host: this.host, port: this.port, servername: this.host, rejectUnauthorized: true });
      } catch (err) {
        done(reject, err);
        return;
      }
      this._sock = sock;
      if (typeof sock.setTimeout === 'function') sock.setTimeout(this.timeoutMs);
      sock.on('data', (d) => this._onData(d));
      sock.on('error', (err) => { this._failAll(err); done(reject, err); });
      sock.on('timeout', () => {
        const e = new Error('IMAP 응답 타임아웃');
        try { sock.destroy(); } catch (_) { /* noop */ }
        this._failAll(e); done(reject, e);
      });
      sock.on('close', () => { this._closed = true; this._failAll(new Error('IMAP 연결이 종료되었습니다')); });
    });
  }

  /** 태그를 붙여 명령을 보내고, 태그드 응답까지의 비태그드 라인을 모아 resolve. */
  command(text) {
    if (this._closed || !this._sock) return Promise.reject(new Error('IMAP 연결 없음'));
    const tag = 'A' + (++this._tagSeq);
    return new Promise((resolve, reject) => {
      this._waiters.push({ tag, lines: [], resolve, reject });
      try {
        this._sock.write(tag + ' ' + text + '\r\n');
      } catch (err) {
        // 방금 push한 waiter 제거 후 거절.
        const idx = this._waiters.findIndex((w) => w.tag === tag);
        if (idx >= 0) this._waiters.splice(idx, 1);
        reject(err);
      }
    });
  }

  async login() {
    try {
      return await this.command('LOGIN ' + imapQuote(this.user) + ' ' + imapQuote(this.pass));
    } catch (err) {
      // 서버가 LOGIN을 거부(NO/BAD)했다면 자격·형식 오류 — 재시도해도 풀리지 않으므로 authFailed로 표식.
      //   (네트워크 오류는 imapStatus가 없어 일시 오류로 구분된다.)
      if (err && err.imapStatus) err.authFailed = true;
      throw err;
    }
  }

  /** STATUS <mailbox> (MESSAGES UNSEEN UIDNEXT) → { messages, unseen, uidnext }. */
  async status(mailbox) {
    const { lines } = await this.command('STATUS ' + imapQuote(mailbox || 'INBOX') + ' (MESSAGES UNSEEN UIDNEXT)');
    const statusLine = lines.find((l) => /^\*\s+STATUS\b/i.test(l));
    return parseStatusItems(statusLine || '');
  }

  /** LOGOUT 시도(실패 무시) 후 소켓 정리. */
  async logout() {
    try { await this.command('LOGOUT'); } catch (_) { /* 종료 직전 거절은 무시 */ }
    this.close();
  }

  close() {
    this._closed = true;
    if (this._sock) {
      try { this._sock.end(); } catch (_) { /* noop */ }
      try { this._sock.destroy(); } catch (_) { /* noop */ }
    }
  }

  /**
   * connect→login→status→logout를 한 번에 수행해 INBOX STATUS를 돌려준다(고수준 편의).
   * @returns {Promise<{messages?:number,unseen?:number,uidnext?:number}>}
   */
  async fetchInboxStatus(mailbox) {
    await this.connect();
    try {
      await this.login();
      return await this.status(mailbox);
    } finally {
      try { await this.logout(); } catch (_) { /* noop */ }
      this.close();
    }
  }

  // ── 내부 ──

  _onData(chunk) {
    this._buf += chunk.toString('utf8');
    if (this._buf.length > MAX_BUFFER) {
      const e = new Error('IMAP 응답이 너무 큽니다');
      this._failAll(e);
      this.close();
      return;
    }
    let idx;
    while ((idx = this._buf.indexOf('\r\n')) >= 0) {
      const line = this._buf.slice(0, idx);
      this._buf = this._buf.slice(idx + 2);
      this._dispatchLine(line);
    }
  }

  _dispatchLine(line) {
    // 그리팅 먼저 소비.
    if (this._greeted) {
      const g = this._greeted;
      this._greeted = null;
      g(line);
      return;
    }
    const w = this._waiters[0];
    if (!w) return; // 대기 중 명령 없음 — 비요청 응답 무시
    const tagged = parseTaggedLine(line, w.tag);
    if (tagged) {
      this._waiters.shift();
      if (tagged.status === 'OK') { w.resolve({ tagged, lines: w.lines }); return; }
      const err = new Error('IMAP ' + tagged.status + (tagged.text ? ': ' + tagged.text : ''));
      err.imapStatus = tagged.status; // 'NO' | 'BAD' — 서버가 명령을 거부(네트워크 오류와 구분)
      w.reject(err);
      return;
    }
    w.lines.push(line);
  }

  _failAll(err) {
    const ws = this._waiters;
    this._waiters = [];
    for (const w of ws) { try { w.reject(err); } catch (_) { /* noop */ } }
  }
}

module.exports = { ImapClient, DEFAULT_TIMEOUT_MS, MAX_BUFFER };
