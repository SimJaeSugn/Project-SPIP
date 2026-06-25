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
const { imapQuote, parseTaggedLine, parseStatusItems, parseSearchUids, parseFetchEnvelope, parseSexp } = require('./imapProtocol');

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
    // [메일 본문] 수신 버퍼는 Buffer(바이트). IMAP 리터럴 {N}은 바이트 길이라, UTF-8 문자열로 측정하면
    //   멀티바이트(한글 등) 본문에서 길이가 어긋나 리터럴 수신 완료를 영원히 못 기다린다(타임아웃 버그).
    this._buf = Buffer.alloc(0);
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

  /** EXAMINE(read-only SELECT) — 메일함을 읽기전용으로 선택해 \Seen 변경 없이 조회. */
  async examine(mailbox) {
    return this.command('EXAMINE ' + imapQuote(mailbox || 'INBOX'));
  }

  /** UID SEARCH UNSEEN → 안 읽은 메시지 UID 배열. */
  async searchUnseen() {
    const { lines } = await this.command('UID SEARCH UNSEEN');
    const line = lines.find((l) => /^\*\s+SEARCH\b/i.test(l));
    return parseSearchUids(line || '');
  }

  /** UID FETCH (ENVELOPE) → [{uid,subject,from,date}]. */
  async fetchEnvelopes(uids) {
    if (!Array.isArray(uids) || uids.length === 0) return [];
    const { lines } = await this.command('UID FETCH ' + uids.join(',') + ' (ENVELOPE)');
    const out = [];
    for (const l of lines) {
      if (!/\bFETCH\b/i.test(l)) continue;
      const env = parseFetchEnvelope(l);
      if (env) out.push(env);
    }
    return out;
  }

  /**
   * 안 읽은 메일 다이제스트(읽음표시 영향 없음). connect→login→STATUS(unseen 수)→EXAMINE(read-only)
   * →UID SEARCH UNSEEN→최신 상위 limit개 ENVELOPE FETCH→logout.
   * @returns {Promise<{unseen:number, items:Array<{uid,subject,from,date}>}>}
   */
  async fetchUnseenDigest(mailbox, limit) {
    await this.connect();
    try {
      await this.login();
      let unseenCount = null;
      try { const st = await this.status(mailbox); unseenCount = Number.isFinite(st.unseen) ? st.unseen : null; } catch (_) { /* STATUS graceful */ }
      await this.examine(mailbox);
      const uids = await this.searchUnseen();
      const n = (typeof limit === 'number' && limit > 0) ? limit : 5;
      const top = uids.slice(-n).reverse(); // 최신(큰 UID) 우선
      const items = top.length ? await this.fetchEnvelopes(top) : [];
      const byUid = new Map(items.map((it) => [it.uid, it]));
      const ordered = top.map((u) => byUid.get(u)).filter(Boolean); // 요청 순서 보존
      return { unseen: (unseenCount != null ? unseenCount : uids.length), items: ordered };
    } finally {
      try { await this.logout(); } catch (_) { /* noop */ }
      this.close();
    }
  }

  /**
   * 단건 메시지 원문(부분, 기본 64KB)을 가져온다. 읽음표시 영향 없음(EXAMINE + BODY.PEEK).
   *   첨부로 인한 과대 응답 방지를 위해 BODY.PEEK[]<0.N> 부분 fetch. uid는 양의 정수만(인젝션 차단).
   * @returns {Promise<string>} RFC822 (부분) 원문. 미발견 시 ''.
   */
  async fetchMessage(uid, mailbox, maxBytes) {
    const u = Number(uid);
    if (!Number.isInteger(u) || u <= 0) return '';
    const n = (typeof maxBytes === 'number' && maxBytes > 0) ? Math.min(Math.floor(maxBytes), 524288) : 65536;
    await this.connect();
    try {
      await this.login();
      await this.examine(mailbox || 'INBOX');
      const { lines } = await this.command('UID FETCH ' + u + ' BODY.PEEK[]<0.' + n + '>');
      for (const l of lines) {
        if (!/\bFETCH\b/i.test(l)) continue;
        const open = l.indexOf('(');
        if (open < 0) continue;
        const arr = parseSexp(l.slice(open));
        if (!Array.isArray(arr)) continue;
        for (let i = 0; i + 1 < arr.length; i++) {
          if (typeof arr[i] === 'string' && /^BODY/i.test(arr[i]) && typeof arr[i + 1] === 'string') return arr[i + 1];
        }
      }
      return '';
    } finally {
      try { await this.logout(); } catch (_) { /* noop */ }
      this.close();
    }
  }

  // ── 내부 ──

  _onData(chunk) {
    // [메일 본문] 바이트 단위 누적(Buffer). 길이 비교·슬라이스를 바이트로 해야 리터럴 {N}을 정확히 센다.
    this._buf = (this._buf.length === 0) ? Buffer.from(chunk) : Buffer.concat([this._buf, chunk]);
    if (this._buf.length > MAX_BUFFER) {
      const e = new Error('IMAP 응답이 너무 큽니다');
      this._failAll(e);
      this.close();
      return;
    }
    let line;
    while ((line = this._tryTakeLine()) !== null) {
      this._dispatchLine(line);
    }
  }

  /**
   * 버퍼(Buffer)에서 논리 라인 1개를 추출한다(리터럴 {n} 인지). 리터럴은 따옴표 문자열로 정규화해 인라인
   * 함으로써 상위 파서(parseSexp)가 리터럴을 신경쓰지 않게 한다. 데이터 부족 시 null(다음 chunk 대기).
   *   [핵심] 리터럴 길이 n은 **바이트** 단위 — 버퍼 바이트 길이로 비교·슬라이스해야 멀티바이트 본문에서
   *   완료 판정이 어긋나지 않는다(이전 문자열 측정 버그로 한글 본문이 영원히 타임아웃됐다).
   */
  _tryTakeLine() {
    let out = '';
    while (true) {
      const nl = this._buf.indexOf('\r\n'); // Buffer.indexOf — CRLF 바이트(0x0D0A) 검색(멀티바이트 안전)
      if (nl < 0) return null; // CRLF 미도달 — 더 받기
      const head = this._buf.slice(0, nl).toString('utf8'); // 라인 텍스트(리터럴 마커 포함)
      const m = head.match(/\{(\d+)\}$/); // 끝이 리터럴 마커({n})?
      if (!m) {
        this._buf = this._buf.slice(nl + 2);
        return out + head; // 논리 라인 완성
      }
      const n = parseInt(m[1], 10); // 바이트 수
      const litStart = nl + 2;       // 바이트 오프셋
      if (this._buf.length < litStart + n) return null; // 리터럴 전체(바이트) 미수신
      const literal = this._buf.slice(litStart, litStart + n).toString('utf8'); // N 바이트 디코드
      out += head.slice(0, head.length - m[0].length) + imapQuote(literal); // {n} → "literal"
      this._buf = this._buf.slice(litStart + n); // 리터럴까지(바이트) 소비하고 같은 논리 라인 계속
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
