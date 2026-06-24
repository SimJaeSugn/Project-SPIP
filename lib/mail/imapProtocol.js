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

module.exports = { imapQuote, parseTaggedLine, parseStatusItems };
