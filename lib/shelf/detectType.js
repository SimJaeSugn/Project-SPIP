'use strict';
/**
 * lib/shelf/detectType.js — 셸프 입력 유형 감지·유효성 (SH-1, 순수)
 *
 * 입력 문자열(붙여넣은 URL·폴더·파일 경로)을 'url'|'folder'|'file'|null 로 감지하고,
 * 유형별 1차 유효성을 판정한다. 초안(docs/design/favorites-shelf-widget.dc.html)의
 * detectType/isValidInput/hasExt/hostOf 로직을 순수 함수로 이식했다.
 *
 * 이 모듈은 "힌트" 수준 1차 감지다 — 권위 있는 최종 검증·유형 보정은 main(localMeta/
 * pathPolicy의 fs.stat·canonicalize)이 수행한다(설계 §6 "렌더러는 힌트만, main이 재검증").
 *
 * 외부 의존성 0 — Node 내장(URL)만. fs/net 미접근(헤드리스 단위테스트).
 */

/** 경로의 마지막 세그먼트(파일/폴더명). 후행 구분자 제거 후 분리. */
function lastSeg(p) {
  return String(p || '').replace(/[/\\]+$/, '').split(/[/\\]/).pop() || '';
}

/** 마지막 세그먼트에 확장자(.xxx, 1~8자)가 있는가 — file/folder 분기 힌트. */
function hasExt(s) {
  return /\.[a-zA-Z0-9]{1,8}$/.test(lastSeg(s));
}

/**
 * 원시 입력에서 유형을 감지한다.
 *   - http(s):// 접두 → url
 *   - 절대/홈/상대/드라이브/UNC 경로 접두 → 후행 구분자면 folder, 확장자 있으면 file, 아니면 folder
 *   - host.tld(경로/쿼리/끝) 형태 → url(스킴 생략 도메인)
 *   - 그 외 → null(감지 불가)
 * @param {*} raw
 * @returns {'url'|'folder'|'file'|null}
 */
function detectType(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) return 'url';
  // 경로 접두: '/'(POSIX 절대) · '~'(홈) · './'·'../'(상대) · 'C:\'·'C:/'(드라이브) · '\\'(UNC)
  if (/^(\/|~|\.\.?[/\\]|[a-zA-Z]:[/\\]|\\\\)/.test(s)) {
    if (/[/\\]$/.test(s)) return 'folder';
    return hasExt(s) ? 'file' : 'folder';
  }
  // 스킴 생략 도메인(host.tld 뒤에 경로/쿼리/해시/끝).
  if (/^[\w.-]+\.[a-z]{2,}([/?#]|$)/i.test(s)) return 'url';
  return null;
}

/** raw에서 host를 추출(스킴 생략 시 https 가정). 실패 시 ''. www. 접두 제거. */
function hostOf(raw) {
  let s = String(raw == null ? '' : raw).trim();
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  try {
    return new URL(s).hostname.replace(/^www\./, '');
  } catch (_) {
    return '';
  }
}

/** url 1차 유효성 — host에 점이 있고 길이>3(실 도메인 근사). */
function isValidUrl(raw) {
  const h = hostOf(raw);
  return !!h && h.includes('.') && h.length > 3;
}

/**
 * 유형별 1차 유효성. url=isValidUrl, folder/file=경로 구분자 포함 + 길이>1.
 * @param {string} type
 * @param {*} raw
 * @returns {boolean}
 */
function isValidInput(type, raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (type === 'url') return isValidUrl(s);
  if (type === 'folder' || type === 'file') return s.length > 1 && /[/\\]/.test(s);
  return false;
}

module.exports = { detectType, isValidInput, isValidUrl, hasExt, lastSeg, hostOf };
