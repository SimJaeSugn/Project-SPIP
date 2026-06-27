'use strict';
/**
 * shelf-imageCache.test.js — lib/shelf/imageCache.js (SH-3, D-IMG-2~5 · D-CACHE-1~3)
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const ic = require('../lib/shelf/imageCache');

const IS_WIN = process.platform === 'win32';

function tmpImagesDir() {
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'spip-ic-')));
}
function pngBuf(size) {
  const head = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
  return Buffer.concat([head, Buffer.alloc(Math.max(0, (size || 32) - head.length), 1)]);
}
function jpegBuf() { return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(20, 2)]); }
function htmlBuf() { return Buffer.from('<html><body>not an image</body></html>'); }
function svgBuf() { return Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'); }

test('D-IMG-2/3 — content-type 화이트리스트(html·svg 거부)', () => {
  assert.strictEqual(ic.validateImage(pngBuf(), 'image/png').ok, true);
  assert.strictEqual(ic.validateImage(jpegBuf(), 'image/jpeg').ok, true);
  assert.strictEqual(ic.validateImage(htmlBuf(), 'text/html').ok, false);
  assert.strictEqual(ic.validateImage(svgBuf(), 'image/svg+xml').ok, false);
});

test('D-IMG-4 — 매직바이트 불일치 거부(PNG 선언 + HTML 바이트)', () => {
  assert.strictEqual(ic.validateImage(htmlBuf(), 'image/png').ok, false);
  assert.strictEqual(ic.sniffMime(pngBuf()), 'image/png');
  assert.strictEqual(ic.sniffMime(htmlBuf()), null);
});

test('D-IMG-5 — 100KB 초과 거부', () => {
  const big = pngBuf(ic.MAX_IMAGE_BYTES + 1);
  assert.strictEqual(ic.validateImage(big, 'image/png').ok, false);
});

test('D-CACHE-1/2 — store 0600·키 형식·roundtrip toDataUri', () => {
  const ctx = { imagesDir: tmpImagesDir() };
  const key = ic.store('https://cdn.example.com/x.png', pngBuf(64), 'image/png', ctx);
  assert.ok(/^[0-9a-f]{32}$/.test(key), '키는 32hex');
  const file = path.join(ctx.imagesDir, key + '.png');
  assert.ok(fs.existsSync(file));
  if (!IS_WIN) assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600, '0600 권한');
  const uri = ic.toDataUri(key, ctx);
  assert.ok(uri.startsWith('data:image/png;base64,'));
});

test('D-CACHE-1 — 잘못된 키(경로탈출·비정규식)는 toDataUri null', () => {
  const ctx = { imagesDir: tmpImagesDir() };
  assert.strictEqual(ic.toDataUri('../etc/passwd', ctx), null);
  assert.strictEqual(ic.toDataUri('xyz', ctx), null);
  assert.strictEqual(ic.toDataUri(null, ctx), null);
  assert.strictEqual(ic.toDataUri('deadbeef'.repeat(4), ctx), null, '존재하지 않는 키 → null');
});

test('D-CACHE-3 — toDataUri는 캐시 파일 변조 시 거부(매직 재검증)', () => {
  const ctx = { imagesDir: tmpImagesDir() };
  const key = ic.keyFor('https://x/y.png');
  fs.mkdirSync(ctx.imagesDir, { recursive: true });
  fs.writeFileSync(path.join(ctx.imagesDir, key + '.png'), htmlBuf()); // 변조: png 확장자에 html 바이트
  assert.strictEqual(ic.toDataUri(key, ctx), null);
});

test('D-CACHE-2 — gc: 미참조 파일 삭제, 참조 파일 보존', () => {
  const ctx = { imagesDir: tmpImagesDir() };
  const k1 = ic.store('https://a/1.png', pngBuf(40), 'image/png', ctx);
  const k2 = ic.store('https://a/2.png', jpegBuf(), 'image/jpeg', ctx);
  ic.gc([k1], ctx); // k2 미참조 → 삭제
  assert.ok(fs.existsSync(path.join(ctx.imagesDir, k1 + '.png')));
  assert.ok(!fs.existsSync(path.join(ctx.imagesDir, k2 + '.jpg')));
});

test('D-CACHE-1 — gc가 비정상 파일명 정리', () => {
  const ctx = { imagesDir: tmpImagesDir() };
  fs.mkdirSync(ctx.imagesDir, { recursive: true });
  fs.writeFileSync(path.join(ctx.imagesDir, 'evil.txt'), 'x');
  ic.gc([], ctx);
  assert.ok(!fs.existsSync(path.join(ctx.imagesDir, 'evil.txt')));
});
