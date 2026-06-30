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
const { imapQuote, parseTaggedLine, parseStatusItems, parseSearchUids, parseFetchEnvelope, parseFetchFlags, parseSexp, parseListMailbox, isCollectibleMailbox } = require('./imapProtocol');

const DEFAULT_TIMEOUT_MS = 15000;
const MAX_BUFFER = 1 << 20; // 1MB
const DEFAULT_MAX_FOLDERS = 25; // 전체 메일함 순회 시 성능 상한(메일함이 많은 계정 보호)

/** RFC2822 날짜 문자열 → epoch ms(파싱 실패 시 0). 메일함 가로지른 최신순 병합 정렬용. */
function mailDateMs(s) {
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : 0;
}

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
    this._rawCollector = null; // [메일 인코딩] 본문 raw 바이트 수집 중인 fetch({tag,resolve,reject})
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

  /** SELECT(read-write) — 플래그 변경(읽음/삭제 표시)·EXPUNGE가 가능한 쓰기 모드 선택. */
  async select(mailbox) {
    return this.command('SELECT ' + imapQuote(mailbox || 'INBOX'));
  }

  /** UID SEARCH UNSEEN → 안 읽은 메시지 UID 배열. */
  async searchUnseen() {
    const { lines } = await this.command('UID SEARCH UNSEEN');
    const line = lines.find((l) => /^\*\s+SEARCH\b/i.test(l));
    return parseSearchUids(line || '');
  }

  /** UID SEARCH ALL → 메일함의 모든 메시지 UID 배열(보관함 전체 수집용). */
  async searchAll() {
    const { lines } = await this.command('UID SEARCH ALL');
    const line = lines.find((l) => /^\*\s+SEARCH\b/i.test(l));
    return parseSearchUids(line || '');
  }

  /**
   * EXAMINE(read-only) 후 응답에서 UIDVALIDITY를 파싱한다(메일함 식별자 — 바뀌면 UID 네임스페이스 재설정).
   * @returns {Promise<number|null>}
   */
  async examineInfo(mailbox) {
    const { lines } = await this.examine(mailbox);
    for (const l of lines) {
      const m = l.match(/\[UIDVALIDITY\s+(\d+)\]/i);
      if (m) return Number(m[1]);
    }
    return null;
  }

  /**
   * UID FETCH (FLAGS ENVELOPE) → [{uid,subject,from,date,seen}]. 보관함 수집(메타+읽음상태)용.
   *   같은 라인에서 ENVELOPE(제목/발신/날짜)와 FLAGS(\Seen)를 함께 파싱해 uid로 병합한다.
   */
  async fetchEnvelopesWithFlags(uids) {
    if (!Array.isArray(uids) || uids.length === 0) return [];
    const { lines } = await this.command('UID FETCH ' + uids.join(',') + ' (FLAGS ENVELOPE)');
    const out = [];
    for (const l of lines) {
      if (!/\bFETCH\b/i.test(l)) continue;
      const env = parseFetchEnvelope(l);
      if (!env || !Number.isInteger(env.uid)) continue;
      const fl = parseFetchFlags(l);
      out.push({ uid: env.uid, subject: env.subject, from: env.from, date: env.date, seen: !!(fl && fl.seen) });
    }
    return out;
  }

  /**
   * LIST "" "*" → 전체 메일함 목록 [{flags, delimiter, name}].
   *   서버가 LIST를 지원하지 않거나 거부하면 호출부가 INBOX 단독으로 폴백한다.
   */
  async listMailboxes() {
    const { lines } = await this.command('LIST "" "*"');
    const out = [];
    for (const l of lines) {
      const mb = parseListMailbox(l);
      if (mb) out.push(mb);
    }
    return out;
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
      return await this._digestForMailbox(mailbox, limit);
    } finally {
      try { await this.logout(); } catch (_) { /* noop */ }
      this.close();
    }
  }

  /**
   * 단일 메일함의 안 읽은 다이제스트(연결·로그인 완료 상태 가정). STATUS(unseen 수)→EXAMINE(read-only)
   * →UID SEARCH UNSEEN→최신 상위 limit개 ENVELOPE FETCH. fetchUnseenDigest/fetchUnseenDigestAll 공용.
   * @returns {Promise<{unseen:number, items:Array<{uid,subject,from,date}>}>}
   */
  async _digestForMailbox(mailbox, limit) {
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
  }

  /**
   * 계정의 **모든 수집 대상 메일함**(휴지통/스팸/전체보관함/임시보관함 제외)을 한 연결로 순회하며 안 읽은
   *   메일을 모은다. 사용자가 메일함(폴더)으로 분류한 메일도 수집되도록 INBOX 단독 한정을 푼다.
   *   connect→login→LIST→(메일함별 STATUS+EXAMINE+SEARCH+ENVELOPE)→logout.
   *   · unseen: 모든 대상 메일함의 안 읽은 수 합계.
   *   · items: 메일함을 가로질러 최신순(ENVELOPE date) 상위 limit개. 각 아이템에 소속 mailbox 포함.
   *   · 메일함 단위 실패는 격리(한 폴더 오류가 전체를 막지 않음). LIST 미지원/실패 시 INBOX만 조회.
   *   · maxFolders(기본 25)로 순회 폴더 수를 제한해 메일함이 많은 계정의 지연을 막는다.
   * @returns {Promise<{unseen:number, items:Array<{uid,subject,from,date,mailbox}>, truncated?:boolean}>}
   */
  /**
   * 수집 대상 메일함 목록(연결·로그인 완료 가정). LIST→휴지통/스팸 등 제외→INBOX 보강·우선.
   *   LIST 미지원/거부 서버는 INBOX 단독으로 폴백한다. fetchUnseenDigestAll/fetchAllStatus 공용.
   * @returns {Promise<Array<{flags?,delimiter?,name}>>}
   */
  async _collectibleMailboxes() {
    let mailboxes;
    try {
      mailboxes = (await this.listMailboxes()).filter(isCollectibleMailbox);
    } catch (_) {
      mailboxes = []; // LIST 미지원/거부 → INBOX 단독 폴백
    }
    // INBOX는 항상 포함하고 맨 앞으로(대상 목록에서 빠졌거나 LIST 실패 시).
    if (!mailboxes.some((mb) => mb.name && mb.name.toLowerCase() === 'inbox')) {
      mailboxes.unshift({ name: 'INBOX', flags: [], delimiter: null });
    } else {
      mailboxes.sort((a, b) => (a.name.toLowerCase() === 'inbox' ? -1 : 0) - (b.name.toLowerCase() === 'inbox' ? -1 : 0));
    }
    return mailboxes;
  }

  async fetchUnseenDigestAll(limit, opts) {
    opts = opts || {};
    const maxFolders = (typeof opts.maxFolders === 'number' && opts.maxFolders > 0) ? Math.floor(opts.maxFolders) : DEFAULT_MAX_FOLDERS;
    const n = (typeof limit === 'number' && limit > 0) ? limit : 5;
    await this.connect();
    try {
      await this.login();
      const mailboxes = await this._collectibleMailboxes();
      const truncated = mailboxes.length > maxFolders;
      const targets = mailboxes.slice(0, maxFolders);
      let unseenTotal = 0;
      const all = [];
      for (const mb of targets) {
        try {
          const d = await this._digestForMailbox(mb.name, n);
          unseenTotal += Number.isFinite(d.unseen) ? d.unseen : 0;
          for (const it of d.items) all.push(Object.assign({}, it, { mailbox: mb.name }));
        } catch (_) { /* 메일함 단위 격리 — 한 폴더 실패가 전체를 막지 않음 */ }
      }
      // 메일함을 가로질러 최신순 정렬 후 상위 n개. date 파싱 실패는 0으로 뒤로 밀린다.
      all.sort((a, b) => mailDateMs(b.date) - mailDateMs(a.date));
      return { unseen: unseenTotal, items: all.slice(0, n), truncated };
    } finally {
      try { await this.logout(); } catch (_) { /* noop */ }
      this.close();
    }
  }

  /**
   * 모든 수집 대상 메일함(휴지통/스팸 등 제외)의 STATUS(UIDNEXT·UNSEEN)를 한 연결로 조회한다.
   *   새 메일 감시(MailWatcher)가 폴더별 UIDNEXT 증가를 감지하도록 INBOX 단독 폴링을 대체한다.
   *   SELECT 없이 STATUS만 쓰므로 읽음 상태를 바꾸지 않는다(부작용 0). 메일함 단위 실패는 격리.
   *   LIST 미지원/거부 서버는 INBOX만 조회한다.
   * @returns {Promise<Array<{name:string, uidnext:(number|null), unseen:(number|null)}>>}
   */
  async fetchAllStatus(opts) {
    opts = opts || {};
    const maxFolders = (typeof opts.maxFolders === 'number' && opts.maxFolders > 0) ? Math.floor(opts.maxFolders) : DEFAULT_MAX_FOLDERS;
    await this.connect();
    try {
      await this.login();
      const targets = (await this._collectibleMailboxes()).slice(0, maxFolders);
      const out = [];
      for (const mb of targets) {
        try {
          const st = await this.status(mb.name);
          out.push({
            name: mb.name,
            uidnext: Number.isFinite(st.uidnext) ? st.uidnext : null,
            unseen: Number.isFinite(st.unseen) ? st.unseen : null,
          });
        } catch (_) { /* 메일함 단위 격리 */ }
      }
      return out;
    } finally {
      try { await this.logout(); } catch (_) { /* noop */ }
      this.close();
    }
  }

  /**
   * 보관함 수집용 — 모든 수집 대상 메일함의 인덱스를 한 연결로 가져온다.
   *   메일함별: EXAMINE(UIDVALIDITY) → UID SEARCH ALL(전체 uid) → 최신 perFolder개만 ENVELOPE+FLAGS 상세 조회.
   *   읽음표시 영향 없음(EXAMINE read-only). 메일함 단위 실패는 격리. LIST 미지원 서버는 INBOX만.
   * @param {object} [opts] { maxFolders?, perFolder? }
   * @returns {Promise<Array<{mailbox:string, uidvalidity:(number|null), serverUids:number[], entries:Array<{uid,subject,from,date,seen}>}>>}
   */
  async fetchMailIndexAll(opts) {
    opts = opts || {};
    const maxFolders = (typeof opts.maxFolders === 'number' && opts.maxFolders > 0) ? Math.floor(opts.maxFolders) : DEFAULT_MAX_FOLDERS;
    const perFolder = (typeof opts.perFolder === 'number' && opts.perFolder > 0) ? Math.floor(opts.perFolder) : 150;
    await this.connect();
    try {
      await this.login();
      const targets = (await this._collectibleMailboxes()).slice(0, maxFolders);
      const out = [];
      for (const mb of targets) {
        try {
          const uidvalidity = await this.examineInfo(mb.name);
          const serverUids = await this.searchAll();
          const newest = serverUids.slice(-perFolder); // 최신(큰 UID) perFolder개만 상세 조회
          const entries = newest.length ? await this.fetchEnvelopesWithFlags(newest) : [];
          out.push({ mailbox: mb.name, uidvalidity, serverUids, entries });
        } catch (_) { /* 메일함 단위 격리 */ }
      }
      return out;
    } finally {
      try { await this.logout(); } catch (_) { /* noop */ }
      this.close();
    }
  }

  /**
   * 단건 메시지 원문(부분, 기본 64KB)을 가져온다.
   *   첨부로 인한 과대 응답 방지를 위해 BODY[]<0.N> 부분 fetch. uid는 양의 정수만(인젝션 차단).
   *   opts.markSeen=true면 SELECT(read-write)+비-PEEK BODY[]로 가져와 **서버에서 읽음(\Seen) 처리**한다
   *   (사용자가 메일을 열면 서버 읽음 동기화). 기본(false)은 EXAMINE+BODY.PEEK로 읽음표시 영향 없음.
   *
   * [메일 인코딩] 본문은 **원시 바이트를 보존**해 latin1 문자열(1바이트=1문자)로 반환한다. UTF-8로 강제
   *   디코드하면 EUC-KR 등 비-UTF8 본문이 손상되므로(한글 깨짐), charset 디코드는 상위(mailBody)가
   *   Buffer.from(.,'latin1') 후 TextDecoder로 수행한다. 엔벨로프(요약) 경로는 영향 없음(별도 raw 수집).
   * @param {object} [opts] { markSeen?:boolean }
   * @returns {Promise<string>} RFC822 (부분) 원문(latin1 바이트 보존). 미발견 시 ''.
   */
  async fetchMessage(uid, mailbox, maxBytes, opts) {
    opts = opts || {};
    const u = Number(uid);
    if (!Number.isInteger(u) || u <= 0) return '';
    const n = (typeof maxBytes === 'number' && maxBytes > 0) ? Math.min(Math.floor(maxBytes), 524288) : 65536;
    await this.connect();
    try {
      await this.login();
      if (opts.markSeen) await this.select(mailbox || 'INBOX'); // read-write → \Seen 설정 가능
      else await this.examine(mailbox || 'INBOX');
      const bytes = await this._fetchBodyRaw(u, n, !opts.markSeen); // markSeen이면 비-PEEK(서버가 \Seen 설정)
      return bytes.toString('latin1'); // 바이트 보존(charset 디코드는 mailBody가 담당)
    } finally {
      try { await this.logout(); } catch (_) { /* noop */ }
      this.close();
    }
  }

  /**
   * 지정 메일함의 메시지들을 서버에서 삭제한다(휴지통 이동 우선). connect→login→(LIST로 휴지통 탐지)
   *   →SELECT(rw)→UID MOVE 휴지통(미지원 시 COPY+\Deleted+UID EXPUNGE). opts.permanent면 휴지통 미경유
   *   STORE \Deleted+EXPUNGE. 원본이 곧 휴지통이거나 휴지통 미탐지 시에도 영구 삭제로 처리.
   * @param {string} mailbox 원본 메일함(IMAP 원본명)
   * @param {number[]} uids 삭제할 UID들
   * @param {object} [opts] { permanent?:boolean }
   * @returns {Promise<{deleted:number, method:string}>}
   */
  async deleteMessages(mailbox, uids, opts) {
    opts = opts || {};
    const set = (Array.isArray(uids) ? uids : []).filter((u) => Number.isInteger(u) && u > 0);
    if (!set.length) return { deleted: 0, method: 'none' };
    const list = set.join(',');
    await this.connect();
    try {
      await this.login();
      let trash = null;
      if (!opts.permanent) { try { trash = await this._findTrash(); } catch (_) { trash = null; } }
      await this.select(mailbox || 'INBOX'); // read-write
      // 휴지통이 있고 원본과 다르면 이동 시도.
      if (trash && trash !== mailbox) {
        try {
          await this.command('UID MOVE ' + list + ' ' + imapQuote(trash));
          return { deleted: set.length, method: 'move' };
        } catch (_) {
          // MOVE 미지원 → COPY 후 원본에서 제거.
          try { await this.command('UID COPY ' + list + ' ' + imapQuote(trash)); } catch (__) { /* 복사 실패 시 그대로 영구삭제 진행 */ }
        }
      }
      // 영구 삭제(또는 COPY 후 원본 제거): \Deleted 후 EXPUNGE(UID EXPUNGE 우선, 미지원 시 EXPUNGE).
      await this.command('UID STORE ' + list + ' +FLAGS (\\Deleted)');
      try { await this.command('UID EXPUNGE ' + list); }
      catch (_) { try { await this.command('EXPUNGE'); } catch (__) { /* noop */ } }
      return { deleted: set.length, method: (trash && trash !== mailbox) ? 'copy' : 'expunge' };
    } finally {
      try { await this.logout(); } catch (_) { /* noop */ }
      this.close();
    }
  }

  /** 휴지통 메일함명을 찾는다(연결·로그인 가정). \Trash 플래그 우선, 없으면 흔한 이름(잎). 없으면 null. */
  async _findTrash() {
    let boxes;
    try { boxes = await this.listMailboxes(); } catch (_) { return null; }
    for (const b of boxes) { if ((b.flags || []).some((f) => String(f).toLowerCase() === '\\trash')) return b.name; }
    const names = new Set(['trash', 'deleted', 'deleted messages', 'deleted items', 'bin', '휴지통', '지운편지함', '지운 편지함']);
    for (const b of boxes) {
      const delim = (typeof b.delimiter === 'string' && b.delimiter) ? b.delimiter : '/';
      const leaf = String(b.name).split(delim).pop().toLowerCase().trim();
      if (names.has(leaf)) return b.name;
    }
    return null;
  }

  /**
   * [메일 인코딩] BODY[]/BODY.PEEK[] 응답의 본문 리터럴을 **원시 바이트 Buffer**로 수집(UTF-8 디코드 안 함).
   *   _onData가 _rawCollector가 설정된 동안 바이트 누적·태그 완료 감지 후 리터럴 N바이트를 잘라 resolve.
   * @param {boolean} [peek=true] true면 BODY.PEEK[](읽음 영향 없음), false면 BODY[](서버가 \Seen 설정).
   */
  _fetchBodyRaw(uid, n, peek) {
    if (this._closed || !this._sock) return Promise.reject(new Error('IMAP 연결 없음'));
    const tag = 'A' + (++this._tagSeq);
    const body = (peek === false) ? 'BODY' : 'BODY.PEEK';
    return new Promise((resolve, reject) => {
      this._rawCollector = { tag, resolve, reject };
      this._buf = Buffer.alloc(0); // 직전 명령 잔여 소비됨 — raw 수집 시작점 초기화
      try {
        this._sock.write(tag + ' UID FETCH ' + uid + ' ' + body + '[]<0.' + n + '>\r\n');
      } catch (err) {
        this._rawCollector = null;
        reject(err);
      }
    });
  }

  /** raw 수집 모드: 태그드 완료 라인이 도착하면 본문 리터럴(N바이트)을 잘라 resolve(latin1 인덱스=바이트 인덱스). */
  _tryRawComplete() {
    const rc = this._rawCollector;
    const s = this._buf.toString('latin1'); // latin1: 1문자=1바이트 → 인덱스가 곧 바이트 오프셋
    const tm = s.match(new RegExp('(?:^|\\r\\n)' + rc.tag + ' (OK|NO|BAD)\\b[^\\r\\n]*\\r\\n'));
    if (!tm) return; // 완료 라인 미도달 — 더 받기
    this._rawCollector = null;
    if (tm[1] !== 'OK') {
      const err = new Error('IMAP ' + tm[1]);
      err.imapStatus = tm[1];
      this._buf = Buffer.alloc(0);
      rc.reject(err);
      return;
    }
    let body = Buffer.alloc(0);
    const lm = s.match(/\{(\d+)\}\r\n/);
    if (lm) {
      const bn = parseInt(lm[1], 10);
      const start = s.indexOf(lm[0]) + lm[0].length;
      body = this._buf.slice(start, start + bn);
    }
    this._buf = Buffer.alloc(0);
    rc.resolve(body);
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
    // [메일 인코딩] 본문 raw 수집 모드: 바이트를 디코드/라인분해하지 않고 그대로 모아 리터럴을 잘라낸다.
    if (this._rawCollector) { this._tryRawComplete(); return; }
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
    // [메일 인코딩] raw 본문 수집 중이면 함께 거절(타임아웃·소켓 종료 등).
    if (this._rawCollector) { const rc = this._rawCollector; this._rawCollector = null; try { rc.reject(err); } catch (_) { /* noop */ } }
  }
}

module.exports = { ImapClient, DEFAULT_TIMEOUT_MS, MAX_BUFFER };
