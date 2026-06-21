'use strict';
/**
 * app-protocol.test.js — app:// URL → public/ 상대 경로 해석 회귀 테스트.
 *
 * [버그 회귀] 'app://favorites.html'은 standard scheme에서 파일명이 host로 파싱되고
 * pathname이 비어, 이전엔 핸들러가 무조건 index.html로 폴백 → 즐겨찾기 위젯이 대시보드를
 * 로드했다. 이 테스트는 그 해석을 직접 검증한다(수정 전이면 favorites.html 케이스가 FAIL).
 */

const test = require('node:test');
const assert = require('node:assert');
const { resolveAppRelPath } = require('../electron/appProtocol');

test('app://favorites.html → /favorites.html (대시보드로 폴백 안 함)', () => {
  assert.strictEqual(resolveAppRelPath('app://favorites.html'), '/favorites.html');
});

test('app://index.html → /index.html', () => {
  assert.strictEqual(resolveAppRelPath('app://index.html'), '/index.html');
});

test('루트/빈 경로 → /index.html', () => {
  assert.strictEqual(resolveAppRelPath('app://'), '/index.html');
});

test('상대 자산은 pathname을 사용(host로 파싱돼도)', () => {
  assert.strictEqual(resolveAppRelPath('app://favorites.html/favorites.css'), '/favorites.css');
  assert.strictEqual(resolveAppRelPath('app://index.html/styles.css'), '/styles.css');
  assert.strictEqual(resolveAppRelPath('app://favorites.html/favorites.js'), '/favorites.js');
});

test('파싱 실패 → null', () => {
  assert.strictEqual(resolveAppRelPath('::::not a url'), null);
});
