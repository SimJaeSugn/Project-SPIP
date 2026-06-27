'use strict';
/**
 * shelf-detectType.test.js — lib/shelf/detectType.js (SH-1, 순수 유형감지·유효성)
 */
const { test } = require('node:test');
const assert = require('node:assert');
const { detectType, isValidInput, isValidUrl, hasExt, lastSeg } = require('../lib/shelf/detectType');

test('SH-1 detectType — url(스킴 명시·생략)', () => {
  assert.strictEqual(detectType('https://github.com'), 'url');
  assert.strictEqual(detectType('http://example.com/path'), 'url');
  assert.strictEqual(detectType('github.com'), 'url');
  assert.strictEqual(detectType('sub.example.co.kr/a?b=1'), 'url');
});

test('SH-1 detectType — folder(절대/홈/드라이브/후행구분자/확장자없음)', () => {
  assert.strictEqual(detectType('/usr/local/projects'), 'folder');
  assert.strictEqual(detectType('~/code/app'), 'folder');
  assert.strictEqual(detectType('C:\\Users\\me\\proj'), 'folder');
  assert.strictEqual(detectType('C:/Users/me/proj'), 'folder');
  assert.strictEqual(detectType('/var/log/'), 'folder'); // 후행 구분자
  assert.strictEqual(detectType('\\\\server\\share'), 'folder'); // UNC
});

test('SH-1 detectType — file(경로 + 확장자)', () => {
  assert.strictEqual(detectType('/home/me/notes.md'), 'file');
  assert.strictEqual(detectType('C:\\src\\index.ts'), 'file');
  assert.strictEqual(detectType('./rel/app.js'), 'file');
});

test('SH-1 detectType — 감지불가는 null', () => {
  assert.strictEqual(detectType(''), null);
  assert.strictEqual(detectType('   '), null);
  assert.strictEqual(detectType('justtext'), null);
  assert.strictEqual(detectType(null), null);
  assert.strictEqual(detectType(undefined), null);
  assert.strictEqual(detectType(42), null);
});

test('SH-1 isValidInput — url 유효성(host·점·길이)', () => {
  assert.strictEqual(isValidInput('url', 'https://github.com'), true);
  assert.strictEqual(isValidInput('url', 'github.com'), true);
  assert.strictEqual(isValidInput('url', 'nope'), false);
  assert.strictEqual(isValidInput('url', 'a.b'), false); // 길이 ≤3
});

test('SH-1 isValidInput — folder/file 경로 구분자 필요', () => {
  assert.strictEqual(isValidInput('folder', '/a/b'), true);
  assert.strictEqual(isValidInput('file', 'C:\\x.txt'), true);
  assert.strictEqual(isValidInput('folder', 'noslash'), false);
  assert.strictEqual(isValidInput('bogus', '/a/b'), false);
});

test('SH-1 hasExt/lastSeg — 보조 함수', () => {
  assert.strictEqual(hasExt('/a/b/file.md'), true);
  assert.strictEqual(hasExt('/a/b/folder'), false);
  assert.strictEqual(hasExt('/a/b/'), false);
  assert.strictEqual(lastSeg('/a/b/c/'), 'c');
  assert.strictEqual(lastSeg('C:\\x\\y'), 'y');
});

test('SH-1 isValidUrl — 직접', () => {
  assert.strictEqual(isValidUrl('https://a.com'), true);
  assert.strictEqual(isValidUrl('localhost'), false);
});
