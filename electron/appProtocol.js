'use strict';
/**
 * electron/appProtocol.js — app:// 요청 URL → public/ 상대 경로 해석(순수)
 *
 * 'app'은 registerSchemesAsPrivileged({standard:true})로 등록된 standard scheme이라
 * `app://favorites.html` 같은 형태에서 **파일명이 hostname으로 파싱되고 pathname이 빈다**.
 * (예: app://favorites.html → host='favorites.html', pathname='' ; app://index.html 도 동일)
 * 따라서 pathname만 보고 폴백하면 모든 페이지가 index.html로 떨어진다(즐겨찾기 위젯이
 * 대시보드를 로드하던 버그의 원인). pathname이 비거나 루트면 hostname을 파일명으로 쓴다.
 * 상대 자산(app://favorites.html/favorites.css)은 pathname에 실리므로 그대로 사용된다.
 *
 * Electron 미의존 — 헤드리스 단위테스트 가능(이 버그가 샌 사각: 인라인이라 테스트 불가했음).
 */

/**
 * @param {string} requestUrl app:// 요청 URL
 * @returns {string|null} public/ 기준 상대 경로('/favorites.html' 등), 파싱 실패 시 null
 */
function resolveAppRelPath(requestUrl) {
  let u;
  try { u = new URL(requestUrl); } catch (_) { return null; }
  let p;
  try { p = decodeURIComponent(u.pathname || ''); } catch (_) { return null; }
  // 파일명이 host로 파싱된 형태(app://file.html): pathname이 비거나 '/'면 host를 파일명으로.
  if (u.hostname && (p === '' || p === '/')) p = '/' + u.hostname;
  if (!p || p === '/') p = '/index.html';
  // 항상 '/'로 시작하도록 정규화(path.join 안전).
  if (p[0] !== '/') p = '/' + p;
  return p;
}

module.exports = { resolveAppRelPath };
