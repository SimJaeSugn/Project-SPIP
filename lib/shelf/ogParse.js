'use strict';
/**
 * lib/shelf/ogParse.js — 경량 HTML 메타 추출 (SH-3, 위협모델 D-PARSE-1~4)
 *
 * HTML 바이트(urlMeta가 ≤512KB 선행 상한 보장) → { title, desc, image, siteName }.
 * cheerio 미도입(ADR-SH-5) — 정규식 기반. ReDoS 방어를 위해:
 *   - 모든 정규식은 비탐욕·앵커·문자클래스가 구분자를 배제(역참조 없음)·{0,N} 상한.
 *   - meta 태그 스캔 매치 횟수 상한(MAX_META).
 * 엔티티 디코드는 화이트리스트(amp/lt/gt/quot/apos + 숫자 범위검증), 추출 문자열은 sanitize·길이상한.
 *
 * 순수 — 외부 의존성 0(Node 내장도 불요).
 */

const MAX_META = 200;           // D-PARSE-2 meta 스캔 매치 상한
const MAX_TITLE = 200;
const MAX_DESC = 500;
const MAX_SITE = 120;
const MAX_IMG_URL = 2048;
const ATTR_CAP = 4096;          // 단일 meta 태그 속성 길이 상한(비탐욕 보조)

// 엔티티 화이트리스트(명명) — 그 외는 디코드 안 함(원문 보존). 숫자 엔티티는 범위 검증.
const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** 화이트리스트 엔티티만 디코드(D-PARSE-3). 숫자는 C0/DEL·범위 검증. */
function decodeEntities(s) {
  if (typeof s !== 'string') return '';
  return s.replace(/&(#x[0-9a-fA-F]{1,6}|#\d{1,7}|[a-zA-Z]{2,8});/g, function (full, body) {
    if (body[0] !== '#') {
      if (body === 'amp' || body === 'lt' || body === 'gt' || body === 'quot' || body === 'apos') return NAMED[body];
      return full; // 미지 명명 엔티티 — 원문 보존
    }
    let code;
    if (body[1] === 'x' || body[1] === 'X') code = parseInt(body.slice(2), 16);
    else code = parseInt(body.slice(1), 10);
    if (!Number.isFinite(code) || code < 32 || code === 127 || code > 0x10ffff) return '';
    if (code >= 0xd800 && code <= 0xdfff) return ''; // 서로게이트 제거
    try { return String.fromCodePoint(code); } catch (_) { return ''; }
  });
}

/** 제어문자·방향성 제어 제거 + 공백 정규화 + trim(D-PARSE-4, L-1 표시 안전). */
function sanitize(s) {
  if (typeof s !== 'string') return '';
  let out = '';
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (c < 32 || c === 127) continue;             // C0·DEL
    if (c >= 0x202a && c <= 0x202e) continue;       // 방향성 제어
    if (c >= 0x2066 && c <= 0x2069) continue;       // isolate
    out += ch;
  }
  return out.replace(/\s+/g, ' ').trim();
}

/** meta 속성 문자열에서 name= 값 추출(비탐욕·상한, ReDoS 안전). */
function attrValue(attrs, name) {
  // 따옴표/비따옴표 모두. 문자클래스가 구분자를 배제해 백트래킹 폭발 없음.
  const re = new RegExp(name + '\\s*=\\s*(?:"([^"]{0,' + ATTR_CAP + '})"|\'([^\']{0,' + ATTR_CAP + '})\'|([^\\s"\'>]{0,' + ATTR_CAP + '}))', 'i');
  const m = re.exec(attrs);
  if (!m) return null;
  return m[1] != null ? m[1] : (m[2] != null ? m[2] : (m[3] != null ? m[3] : ''));
}

/**
 * HTML에서 메타 추출.
 * @param {string} html
 * @returns {{title:string, desc:string, image:string, siteName:string}}
 */
function extract(html) {
  const s = typeof html === 'string' ? html : '';
  const metas = Object.create(null);

  // <meta ...> 스캔(매치 횟수 상한). 속성 길이 비탐욕 상한으로 ReDoS 차단.
  const re = /<meta\b([^>]{0,4096})>/gi;
  let m;
  let count = 0;
  while ((m = re.exec(s)) !== null) {
    if (++count > MAX_META) break;
    if (re.lastIndex === m.index) re.lastIndex++; // 빈 매치 방어(무한루프 차단)
    const attrs = m[1];
    const key = (attrValue(attrs, 'property') || attrValue(attrs, 'name') || '').toLowerCase().trim();
    if (!key) continue;
    if (key in metas) continue; // 첫 값 우선
    const content = attrValue(attrs, 'content');
    if (content == null) continue;
    metas[key] = content;
  }

  // <title> (비탐욕·길이 상한)
  let titleTag = '';
  const tm = /<title\b[^>]{0,200}>([^<]{0,400})<\/title>/i.exec(s);
  if (tm) titleTag = tm[1];

  const ogTitle = metas['og:title'];
  const ogDesc = metas['og:description'] || metas['description'];
  const ogImage = metas['og:image'] || metas['og:image:url'] || metas['og:image:secure_url'] || metas['twitter:image'];
  const ogSite = metas['og:site_name'];

  const title = sanitize(decodeEntities(ogTitle != null ? ogTitle : titleTag)).slice(0, MAX_TITLE);
  const desc = sanitize(decodeEntities(ogDesc != null ? ogDesc : '')).slice(0, MAX_DESC);
  const siteName = sanitize(decodeEntities(ogSite != null ? ogSite : '')).slice(0, MAX_SITE);
  // 이미지 URL은 sanitize(제어문자 제거)만 — 절대화·SSRF 게이트는 urlMeta가 수행.
  const image = sanitize(decodeEntities(ogImage != null ? ogImage : '')).slice(0, MAX_IMG_URL);

  return { title, desc, image, siteName };
}

module.exports = { extract, decodeEntities, sanitize, attrValue, MAX_META, MAX_TITLE, MAX_DESC };
