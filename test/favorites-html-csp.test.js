'use strict';
/**
 * favorites-html-csp.test.js — 위젯 페이지(public/favorites.html) CSP·인라인 위생 (M7 §5 · SEC-L2 · L-1 전제)
 *
 * 정적 파싱으로 검증(브라우저/Electron 불요):
 *   ① favorites.html 메타 CSP 가 index.html 메타 CSP 와 **문자열 동일**(SEC-L2 드리프트 금지).
 *   ② 인라인 <script>본문 0 · 인라인 이벤트 핸들러(onclick 등) 0(CSP script-src 'self' 정합).
 *   ③ 자산은 app:// 상대경로('self')만 — ./favorites.css · ./favorites.js 참조, 외부 출처 0.
 *   ④ favorites.js 가 강력 preload 채널을 직접 호출하지 않음(축소 6채널 한정·표면 위생).
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const FAV_HTML = fs.readFileSync(path.join(ROOT, 'public', 'favorites.html'), 'utf8');
const INDEX_HTML = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const FAV_JS = fs.readFileSync(path.join(ROOT, 'public', 'favorites.js'), 'utf8');

/** http-equiv="Content-Security-Policy" 의 content 속성 값을 추출. */
function extractCsp(html) {
  // content 는 큰따옴표로 감싸고 내부에 'none'/'self'(작은따옴표)를 포함하므로 [^"] 로만 종결.
  const m = html.match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/i);
  assert.ok(m, 'CSP 메타를 찾지 못함');
  return m[1].trim();
}

test('SEC-L2 — favorites.html 메타 CSP 가 index.html 과 문자열 동일', () => {
  assert.strictEqual(extractCsp(FAV_HTML), extractCsp(INDEX_HTML));
});

test('CSP — default-src none 기반 전 디렉티브 보존', () => {
  const csp = extractCsp(FAV_HTML);
  for (const d of ["default-src 'none'", "script-src 'self'", "style-src 'self'",
    "connect-src 'none'", "object-src 'none'", "base-uri 'none'", "frame-ancestors 'none'"]) {
    assert.ok(csp.includes(d), 'CSP 누락: ' + d);
  }
});

test('인라인 위생 — <script>본문 0(외부 src 만 허용)', () => {
  // <script ...>...</script> 중 본문이 비어있지 않은(인라인 코드) 태그가 없어야 한다.
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(FAV_HTML))) {
    const attrs = m[1];
    const body = m[2].trim();
    assert.strictEqual(body, '', '인라인 스크립트 본문 금지');
    assert.ok(/\bsrc\s*=/.test(attrs), 'script 는 외부 src 로만');
  }
});

test('인라인 위생 — on* 인라인 이벤트 핸들러 0', () => {
  assert.ok(!/\son\w+\s*=/.test(FAV_HTML), '인라인 이벤트 핸들러(onclick 등) 금지');
});

test('자산 — app:// 상대경로(./favorites.css · ./favorites.js), 외부 출처 0', () => {
  assert.ok(/href=["']\.\/favorites\.css["']/.test(FAV_HTML), './favorites.css 링크 필요');
  assert.ok(/src=["']\.\/favorites\.js["']/.test(FAV_HTML), './favorites.js 스크립트 필요');
  assert.ok(!/https?:\/\//.test(FAV_HTML.replace(/http-equiv|w3\.org/g, '')), '외부 http(s) 자산 금지');
});

test('표면 위생 — favorites.js 가 강력 preload 채널을 직접 호출하지 않음', () => {
  // 축소 preload(6채널)만 사용. 강력 채널명 문자열이 호출부에 등장하면 안 됨.
  for (const ch of ['setOrder', 'setSortMode', 'setToolPath', 'pickToolExecutable',
    'rescan', 'addRoots', 'removeRoot', 'pickFolders', 'getTools']) {
    assert.ok(!FAV_JS.includes(ch), 'favorites.js 가 강력 채널 참조: ' + ch);
  }
});

test('L-1 — favorites.js 가 innerHTML 데이터 결합을 사용하지 않음', () => {
  assert.ok(!/\.innerHTML\s*=/.test(FAV_JS), 'innerHTML 할당 금지(textContent 전수)');
});
