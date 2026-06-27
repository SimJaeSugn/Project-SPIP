'use strict';
/**
 * shelf-localMeta.test.js — lib/shelf/localMeta.js (SH-2, 임시 디렉토리 fixture)
 *   folder: 파일 수·용량 status / file: 확장자→언어·mono·color·크기.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const localMeta = require('../lib/shelf/localMeta');

function fixtureDir() {
  const d = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'spip-lm-')));
  fs.writeFileSync(path.join(d, 'a.txt'), 'hello');
  fs.writeFileSync(path.join(d, 'b.js'), 'console.log(1)');
  fs.mkdirSync(path.join(d, 'sub'));
  fs.writeFileSync(path.join(d, 'sub', 'c.md'), '# x');
  return d;
}

test('SH-2 localMeta.collect(folder) — 파일 수·용량·필드', () => {
  const d = fixtureDir();
  const m = localMeta.collect(d, 'folder');
  assert.strictEqual(m.name, path.basename(d));
  assert.ok(/3개 파일/.test(m.status), '재귀 파일 수 집계: ' + m.status);
  assert.ok(/#[0-9a-f]{6}/i.test(m.color));
  assert.strictEqual(typeof m.sub, 'string');
  assert.strictEqual(typeof m.cat, 'string');
});

test('SH-2 localMeta.collect(file) — 확장자→언어/모노/색', () => {
  const d = fixtureDir();
  const m = localMeta.collect(path.join(d, 'b.js'), 'file');
  assert.strictEqual(m.name, 'b.js');
  assert.strictEqual(m.cat, 'JavaScript');
  assert.strictEqual(m.mono, 'JS');
  assert.strictEqual(m.color, '#a98a13');
  assert.ok(/B|KB/.test(m.status), '크기 표기: ' + m.status);
});

test('SH-2 localMeta.collect(file) — 미지 확장자 폴백', () => {
  const d = fixtureDir();
  fs.writeFileSync(path.join(d, 'x.zzz'), 'q');
  const m = localMeta.collect(path.join(d, 'x.zzz'), 'file');
  assert.strictEqual(m.cat, 'ZZZ');
  assert.strictEqual(m.mono, 'ZZZ');
});

test('SH-2 localMeta.humanBytes/fmtDate — 표기', () => {
  assert.strictEqual(localMeta.humanBytes(0), '0B');
  assert.strictEqual(localMeta.humanBytes(1536), '1.5KB');
  assert.strictEqual(localMeta.humanBytes(-1), '0B');
  assert.match(localMeta.fmtDate(Date.now()), /^\d{4}-\d{2}-\d{2}$/);
  assert.strictEqual(localMeta.fmtDate(NaN), '');
});

test('SH-2 localMeta.walkFolder — 심링크 미추적·예산 종료', () => {
  const d = fixtureDir();
  const r = localMeta.walkFolder(d);
  assert.strictEqual(r.files, 3);
  assert.ok(r.bytes > 0);
  assert.strictEqual(r.truncated, false);
});
