'use strict';
/**
 * lib/mail/mailBody.js — RFC822 메시지 본문 최소 파서(순수, 헤드리스 단위테스트)
 *
 * IMAP BODY.PEEK[]<0.N>로 받은 (부분) 원문에서 사람이 읽을 평문 본문을 추출한다.
 *   · 헤더/본문 분리, 헤더 unfold, Content-Type/Transfer-Encoding 파싱
 *   · multipart: 경계로 분할해 text/plain 우선(없으면 text/html→태그제거) 선택(중첩 1단계)
 *   · Content-Transfer-Encoding: base64 / quoted-printable / 7bit·8bit 디코드
 *   · charset: UTF-8/ASCII/Latin-1만(멀티바이트 레거시 EUC-KR 등은 best-effort, imapProtocol과 동일 한계)
 *   · 제어문자 제거(개행·탭 보존)·길이 절단. innerHTML 미사용(렌더러는 textContent, L-1).
 *
 * 외부 의존성 0 — 내부(imapProtocol) + Node Buffer.
 */

const { decodeMimeHeader, decodeCharset } = require('./imapProtocol');

const MAX_TEXT = 20000;
// 제어문자(C0·CR·DEL) 중 탭(09)·개행(0A)은 보존 — 소스에 리터럴 제어문자를 두지 않으려 문자열로 구성.
const CONTROL_KEEP_NL_RE = new RegExp('[\\u0000-\\u0008\\u000B\\u000C\\u000D\\u000E-\\u001F\\u007F]', 'g');

/** 헤더/본문 분리(첫 빈 줄 기준). */
function splitHeadersBody(raw) {
  const s = String(raw == null ? '' : raw);
  const m = s.match(/\r?\n\r?\n/);
  if (!m) return { head: s, body: '' };
  const at = s.indexOf(m[0]);
  return { head: s.slice(0, at), body: s.slice(at + m[0].length) };
}

/** 헤더 파싱(접힘 줄 unfold, 키 소문자). */
function parseHeaders(head) {
  const out = {};
  let cur = null;
  for (const line of String(head || '').split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && cur) { out[cur] += ' ' + line.trim(); continue; }
    const m = line.match(/^([!-9;-~]+):[ \t]?(.*)$/); // 헤더명: 값
    if (m) { cur = m[1].toLowerCase(); out[cur] = m[2]; }
  }
  return out;
}

/** "type; name=value; ..."에서 파라미터 추출(따옴표 허용). */
function getParam(val, name) {
  if (!val) return null;
  const m = String(val).match(new RegExp(name + '\\s*=\\s*"?([^";]+)"?', 'i'));
  return m ? m[1].trim() : null;
}

/** quoted-printable 디코드 → 바이트(latin1 문자열). */
function qpDecode(s) {
  return String(s || '')
    .replace(/=\r?\n/g, '')
    .replace(/=([0-9A-Fa-f]{2})/g, (m, h) => String.fromCharCode(parseInt(h, 16)));
}

/**
 * 본문 디코드: CTE(base64/quoted-printable/7bit·8bit) → 바이트 → charset(TextDecoder) → 유니코드.
 *   [메일 인코딩] body는 imapClient가 **원시 바이트 보존(latin1 문자열)** 으로 전달한다(UTF-8 강제 디코드 금지).
 *   따라서 latin1로 바이트를 복원한 뒤 charset(EUC-KR 등)으로 정확히 디코드한다.
 */
function decodeBody(body, cte, charset) {
  body = String(body == null ? '' : body);
  const enc = String(cte || '').toLowerCase().trim();
  let bytes;
  try {
    if (enc === 'base64') bytes = Buffer.from(body.replace(/\s+/g, ''), 'base64');
    else if (enc === 'quoted-printable') bytes = Buffer.from(qpDecode(body), 'latin1');
    else bytes = Buffer.from(body, 'latin1'); // 7bit/8bit/none: latin1로 원시 바이트 복원
  } catch (_) { bytes = Buffer.from(body, 'latin1'); }
  return decodeCharset(bytes, charset);
}

/** 매우 단순한 HTML→텍스트(태그 제거·기본 엔티티). innerHTML 미사용. */
function htmlToText(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6]|table)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;/gi, "'")
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
}

/** 제어문자 제거(개행·탭 보존) + 길이 절단. */
function sanitizeText(s, max) {
  if (typeof s !== 'string') return '';
  let out = s.replace(/\r\n?/g, '\n').replace(CONTROL_KEEP_NL_RE, '');
  const lim = (typeof max === 'number' && max > 0) ? max : MAX_TEXT;
  if (out.length > lim) out = out.slice(0, lim) + '\n…(이하 생략)';
  return out.trim();
}

/** multipart 본문에서 표시할 텍스트 추출(text/plain 우선, 없으면 text/html→텍스트). 중첩 1단계. */
function extractMultipart(body, boundary, depth) {
  if (!boundary) return '';
  const parts = String(body || '').split('--' + boundary);
  let plain = null, html = null;
  for (const raw of parts) {
    const part = raw.replace(/^\r?\n/, '');
    if (!part || part.replace(/[\r\n]/g, '') === '--' || part.replace(/[\r\n]/g, '') === '') continue;
    const { head, body: pb } = splitHeadersBody(part);
    const ph = parseHeaders(head);
    const pct = ph['content-type'] || '';
    const pcte = ph['content-transfer-encoding'] || '';
    if (/^multipart\//i.test(pct) && (depth || 0) < 2) {
      const nested = extractMultipart(pb, getParam(pct, 'boundary'), (depth || 0) + 1);
      if (nested && plain == null) plain = nested;
    } else if (/text\/plain/i.test(pct) && plain == null) {
      plain = decodeBody(pb, pcte, getParam(pct, 'charset'));
    } else if (/text\/html/i.test(pct) && html == null) {
      html = decodeBody(pb, pcte, getParam(pct, 'charset'));
    }
  }
  if (plain != null) return plain;
  if (html != null) return htmlToText(html);
  return '';
}

/**
 * RFC822 (부분) 원문 → { subject, from, date, text }(text는 표시용 평문).
 * @param {string} raw
 * @returns {{subject:string|null, from:string|null, date:string|null, text:string}}
 */
function parseMessage(raw) {
  const { head, body } = splitHeadersBody(String(raw == null ? '' : raw));
  const H = parseHeaders(head);
  const ct = H['content-type'] || 'text/plain';
  const cte = H['content-transfer-encoding'] || '';
  let text;
  if (/^multipart\//i.test(ct)) {
    text = extractMultipart(body, getParam(ct, 'boundary'), 0);
  } else if (/text\/html/i.test(ct)) {
    text = htmlToText(decodeBody(body, cte, getParam(ct, 'charset')));
  } else {
    text = decodeBody(body, cte, getParam(ct, 'charset'));
  }
  return {
    subject: H['subject'] ? decodeMimeHeader(H['subject']) : null,
    from: H['from'] ? decodeMimeHeader(H['from']) : null,
    date: H['date'] || null,
    text: sanitizeText(text, MAX_TEXT),
  };
}

module.exports = {
  parseMessage, splitHeadersBody, parseHeaders, getParam, qpDecode, decodeBody, htmlToText, sanitizeText, extractMultipart, MAX_TEXT,
};
