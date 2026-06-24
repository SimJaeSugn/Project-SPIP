'use strict';
/**
 * lib/mail/imapProtocol.js — IMAP 응답 파싱·인용 (순수 함수, 헤드리스 단위테스트)
 *
 * 새 메일 감지에 필요한 최소 명령(LOGIN·STATUS·LOGOUT)의 응답만 다룬다. FETCH/literal은
 * 쓰지 않으므로 본 모듈도 단순 라인 파싱만 한다. 네트워크 I/O는 imapClient.js가 담당.
 *
 * 외부 의존성 0.
 */

/** 문자열을 IMAP quoted-string으로 인용한다(역슬래시·따옴표 이스케이프). LOGIN 인자 등에 사용. */
function imapQuote(s) {
  return '"' + String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

/**
 * 태그드 응답 라인 파싱: `A1 OK ...` → { tag, status, text }.
 *   비태그드(`*`)이거나 형식 불일치, (tag 지정 시) 태그 불일치면 null.
 */
function parseTaggedLine(line, tag) {
  if (typeof line !== 'string') return null;
  // 태그는 영숫자(A1 등)만 — 비태그드('*')·연속('+')은 의도적으로 제외.
  const m = line.match(/^([A-Za-z0-9]+)\s+(OK|NO|BAD)\b\s*(.*)$/i);
  if (!m) return null;
  if (tag && m[1] !== tag) return null;
  return { tag: m[1], status: m[2].toUpperCase(), text: m[3] || '' };
}

/**
 * STATUS 응답의 숫자 항목을 추출한다(키는 소문자화).
 *   `* STATUS "INBOX" (MESSAGES 3 UNSEEN 1 UIDNEXT 5)` → { messages:3, unseen:1, uidnext:5 }
 *   괄호/짝이 없으면 빈 객체.
 */
function parseStatusItems(line) {
  const out = {};
  if (typeof line !== 'string') return out;
  const open = line.indexOf('(');
  const close = line.lastIndexOf(')');
  if (open < 0 || close <= open) return out;
  const body = line.slice(open + 1, close).trim();
  if (!body) return out;
  const toks = body.split(/\s+/);
  for (let i = 0; i + 1 < toks.length; i += 2) {
    const key = toks[i].toLowerCase();
    const num = Number(toks[i + 1]);
    if (Number.isFinite(num)) out[key] = num;
  }
  return out;
}

/** UID SEARCH 응답 → UID 배열. `* SEARCH 1 2 3` → [1,2,3]. 미일치/빈 응답은 []. */
function parseSearchUids(line) {
  if (typeof line !== 'string') return [];
  const m = line.match(/^\*\s+SEARCH\b(.*)$/i);
  if (!m) return [];
  return m[1].trim().split(/\s+/).filter(Boolean).map((t) => Number(t)).filter((n) => Number.isInteger(n) && n > 0);
}

/**
 * IMAP S-expression 파서(순수). 따옴표문자열·NIL·원자·중첩 괄호를 JS 값/배열로.
 *   리터럴({n})은 리더 단계에서 이미 따옴표 문자열로 정규화됐다고 가정한다(imapClient._tryTakeLine).
 * @param {string} s '(' 로 시작하는(또는 단일 값) IMAP 식
 * @returns {*} 문자열 | null(NIL) | 배열(중첩)
 */
function parseSexp(s) {
  if (typeof s !== 'string') return null;
  let i = 0;
  const skipWs = () => { while (i < s.length && s[i] === ' ') i++; };
  function parseString() {
    i++; // 여는 따옴표
    let out = '';
    while (i < s.length) {
      const c = s[i++];
      if (c === '\\') { out += (i < s.length ? s[i++] : ''); }
      else if (c === '"') break;
      else out += c;
    }
    return out;
  }
  function parseList() {
    i++; // '('
    const arr = [];
    while (i < s.length) {
      skipWs();
      if (s[i] === ')') { i++; break; }
      arr.push(parseValue());
    }
    return arr;
  }
  function parseValue() {
    skipWs();
    const c = s[i];
    if (c === '(') return parseList();
    if (c === '"') return parseString();
    let start = i;
    while (i < s.length && s[i] !== ' ' && s[i] !== '(' && s[i] !== ')') i++;
    const atom = s.slice(start, i);
    return (atom === 'NIL' || atom === '') ? null : atom;
  }
  skipWs();
  return parseValue();
}

/** IANA charset → Node Buffer 인코딩(미지원은 utf8 best-effort). EUC-KR 등 멀티바이트 레거시는 미지원. */
function charsetToNode(cs) {
  const c = String(cs || '').toLowerCase();
  if (c === 'utf-8' || c === 'utf8') return 'utf8';
  if (c === 'us-ascii' || c === 'ascii') return 'ascii';
  if (c === 'iso-8859-1' || c === 'latin1') return 'latin1';
  return 'utf8';
}

/**
 * RFC2047 인코딩 헤더(=?charset?B/Q?text?=)를 디코드한다. 연속 인코딩워드 사이 공백은 제거.
 *   B=base64, Q=quoted-printable(_=공백). 미지원 charset은 utf8 best-effort. Buffer 사용(Node).
 */
function decodeMimeHeader(s) {
  if (typeof s !== 'string' || !s) return (typeof s === 'string') ? s : null;
  // 인접한 인코딩워드 사이의 공백류 제거(RFC2047 §6.2).
  const collapsed = s.replace(/\?=\s+=\?/g, '?==?');
  return collapsed.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (m, charset, enc, text) => {
    try {
      let bytes;
      if (enc.toUpperCase() === 'B') {
        bytes = Buffer.from(text, 'base64');
      } else {
        const q = text.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (mm, h) => String.fromCharCode(parseInt(h, 16)));
        bytes = Buffer.from(q, 'latin1');
      }
      return bytes.toString(charsetToNode(charset));
    } catch (_) {
      return m; // 디코드 실패 시 원문 유지
    }
  });
}

/** ENVELOPE 주소 구조 [[name, adl, mailbox, host], ...] → 표시 문자열(이름 우선, 없으면 mailbox@host). */
function formatEnvelopeAddr(addrList) {
  if (!Array.isArray(addrList) || addrList.length === 0) return null;
  const a = addrList[0];
  if (!Array.isArray(a)) return null;
  const name = a[0], mailbox = a[2], host = a[3];
  if (typeof name === 'string' && name) return decodeMimeHeader(name);
  if (mailbox && host) return mailbox + '@' + host;
  return (typeof mailbox === 'string' && mailbox) ? mailbox : null;
}

/**
 * FETCH 응답 라인에서 ENVELOPE를 추출한다(리터럴은 리더가 따옴표로 정규화한 뒤 호출).
 *   ENVELOPE 필드 순서: [date, subject, from, sender, reply-to, to, cc, bcc, in-reply-to, message-id]
 * @returns {{uid:number|null, date:string|null, subject:string|null, from:string|null}|null}
 */
function parseFetchEnvelope(line) {
  if (typeof line !== 'string') return null;
  const idx = line.search(/ENVELOPE\s*\(/i);
  if (idx < 0) return null;
  const open = line.indexOf('(', idx);
  if (open < 0) return null;
  const env = parseSexp(line.slice(open));
  if (!Array.isArray(env)) return null;
  const um = line.match(/\bUID\s+(\d+)/i);
  return {
    uid: um ? Number(um[1]) : null,
    date: (typeof env[0] === 'string') ? env[0] : null,
    subject: decodeMimeHeader(env[1]),
    from: formatEnvelopeAddr(env[2]),
  };
}

module.exports = {
  imapQuote, parseTaggedLine, parseStatusItems,
  parseSearchUids, parseSexp, decodeMimeHeader, formatEnvelopeAddr, parseFetchEnvelope, charsetToNode,
};
