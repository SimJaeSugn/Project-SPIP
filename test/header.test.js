'use strict';
/**
 * header.test.js — R-27 헤더 통일 검증(헤드리스 F-3).
 *   - headerViewConfig: 뷰별 차이가 검색 노출 하나로 최소화됐는지(순수 판정).
 *   - 구조 회귀(정적 소스): 헤더 '도움말' 버튼 제거(Q5), 공통 액션(설정·궤도맵·재스캔) 존재,
 *     검색 input 에 RG.composition.bind 유지(IME 회귀 0), home early-return 제거.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { headerViewConfig } = require('../public/app.js');
const APP_SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

// ── headerViewConfig (순수 뷰별 구성) ────────────────────────────────────
test('R-27 — headerViewConfig: 검색은 dashboard 에서만 노출, home 은 미니멀', () => {
  assert.deepStrictEqual(headerViewConfig('dashboard'), { showSearch: true });
  assert.deepStrictEqual(headerViewConfig('home'), { showSearch: false });
});

test('R-27 — headerViewConfig: 그 외 뷰는 검색 비노출(기본)', () => {
  assert.strictEqual(headerViewConfig('orbit').showSearch, false);
  assert.strictEqual(headerViewConfig('scanning').showSearch, false);
  assert.strictEqual(headerViewConfig(undefined).showSearch, false);
});

// ── 구조 회귀(정적 소스 검사) ────────────────────────────────────────────
// renderHeader 본문 범위를 잡아 그 안의 구조를 확인한다.
function renderHeaderBody() {
  const start = APP_SRC.indexOf('function renderHeader()');
  assert.ok(start >= 0, 'renderHeader 함수가 있어야 한다');
  // 다음 함수 정의 전까지를 본문으로 근사(주석/툴바 함수 시작 전).
  const after = APP_SRC.indexOf('function renderToolbar()', start);
  return APP_SRC.slice(start, after > start ? after : start + 4000);
}

test('R-27/Q5 — 헤더에서 도움말 버튼 제거(openHelp 직접 진입점 부재)', () => {
  const body = renderHeaderBody();
  assert.ok(!/text:\s*'도움말'/.test(body), "헤더에 '도움말' 버튼 텍스트가 없어야 한다");
  assert.ok(!/click:\s*openHelp/.test(body), '헤더에 openHelp 클릭 핸들러가 없어야 한다');
});

test('R-27 — 공통 액션(설정·궤도 맵·재스캔)이 헤더에 존재', () => {
  const body = renderHeaderBody();
  assert.ok(/text:\s*'설정'/.test(body), '설정 버튼');
  assert.ok(/text:\s*'궤도 맵'/.test(body), '궤도 맵 버튼');
  assert.ok(/'재스캔'/.test(body), '재스캔 버튼');
});

test('R-27 — home early-return 제거(공통 골격 공유)', () => {
  const body = renderHeaderBody();
  // 과거엔 home 분기에서 한 번, 함수 끝에서 한 번 — 총 2개의 'return header;'가 있었다.
  //   공통 골격 통일 후엔 함수 말미 단 1개만 남아야 한다(early-return 제거).
  const count = (body.match(/return header;/g) || []).length;
  assert.strictEqual(count, 1, "renderHeader 에 'return header;' 는 1개여야 한다(early-return 제거)");
});

test('R-26/R-27 — 검색 input 에 RG.composition.bind 유지(헤더 재구성 후 IME 회귀 0)', () => {
  const body = renderHeaderBody();
  assert.ok(/RG\.composition\.bind\(searchInput\)/.test(body), '검색 input 에 composition.bind 유지');
  assert.ok(/RG\.coalesce\.request\(\)/.test(body), '검색 입력 핸들러가 coalesce.request 경유');
});
