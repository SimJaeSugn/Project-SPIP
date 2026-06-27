'use strict';
/**
 * shelf-urlMeta.test.js — lib/shelf/urlMeta.js (SH-3, D-RDR-1~4 · D-RES-1~5 · D-IMG-1 · D-PRIV-1~3)
 *   net(fetchRaw)·DNS(lookup) 주입 모킹으로 hop 재검증·자원상한·게이트 재진입·헤더 위생 검증.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const urlMeta = require('../lib/shelf/urlMeta');

function pngBuf() {
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]), Buffer.alloc(40, 1)]);
}
function resOf(body) { return Readable.from([Buffer.isBuffer(body) ? body : Buffer.from(String(body))]); }
// 순서대로 응답을 내보내는 fetchRaw 모킹.
function seqTransport(specs) {
  let i = 0;
  const calls = [];
  const fn = async (reqOpts) => {
    calls.push(reqOpts);
    const spec = specs[i++];
    if (!spec) throw new Error('no more responses');
    return { statusCode: spec.statusCode || 200, headers: spec.headers || {}, res: resOf(spec.body != null ? spec.body : '') };
  };
  fn.calls = calls;
  return fn;
}
const PUBLIC = async () => [{ address: '93.184.216.34', family: 4 }];
function hostLookup(map) {
  return async (host) => {
    const ip = map[host] || '93.184.216.34';
    return [{ address: ip, family: 4 }];
  };
}
function tmpImagesDir() { return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'spip-um-'))); }

// ── buildReqOpts: D-RES-3 / D-PRIV-1~3 ──
test('D-RES-3/D-PRIV — 요청 헤더 위생(identity·고정UA·쿠키/인증/Referer 부재)', () => {
  const u = new URL('https://example.com/page?a=1');
  const opts = urlMeta.buildReqOpts(u, { ip: '93.184.216.34', family: 4 }, 'html');
  assert.strictEqual(opts.headers['Accept-Encoding'], 'identity');
  assert.strictEqual(opts.headers['User-Agent'], urlMeta.FIXED_UA);
  assert.strictEqual(opts.headers.Host, 'example.com');
  assert.ok(!('Cookie' in opts.headers) && !('cookie' in opts.headers), '쿠키 미전송');
  assert.ok(!('Authorization' in opts.headers), '인증 미전송');
  assert.ok(!('Referer' in opts.headers), 'Referer 미전송');
  assert.strictEqual(opts.method, 'GET');
  assert.strictEqual(typeof opts.lookup, 'function', 'IP 핀 lookup 주입');
});

// ── 정상 크롤 ──
test('SH-3 crawl — 정상 페이지 메타 추출', async () => {
  const transport = seqTransport([
    { statusCode: 200, headers: { 'content-type': 'text/html' }, body: '<meta property="og:title" content="Hi"><meta property="og:description" content="D">' },
  ]);
  const r = await urlMeta.crawl('https://example.com', { deps: { fetchRaw: transport, lookup: PUBLIC } });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.meta.title, 'Hi');
  assert.strictEqual(r.meta.desc, 'D');
  assert.strictEqual(r.bannerKey, null);
});

test('SH-3 crawl — og:image 정상 다운로드→bannerKey', async () => {
  const transport = seqTransport([
    { statusCode: 200, headers: { 'content-type': 'text/html' }, body: '<meta property="og:image" content="https://example.com/i.png">' },
    { statusCode: 200, headers: { 'content-type': 'image/png' }, body: pngBuf() },
  ]);
  const r = await urlMeta.crawl('https://example.com', { deps: { fetchRaw: transport, lookup: PUBLIC }, imagesDir: tmpImagesDir() });
  assert.strictEqual(r.ok, true);
  assert.ok(/^[0-9a-f]{32}$/.test(r.bannerKey), 'bannerKey 32hex: ' + r.bannerKey);
});

// ── D-RDR-1: hop마다 SSRF 재검증 ──
test('D-RDR-1 — 리다이렉트 hop2가 내부 IP면 BLOCKED_HOST', async () => {
  const transport = seqTransport([
    { statusCode: 302, headers: { location: 'http://internal.example/' } },
  ]);
  const lookup = hostLookup({ 'example.com': '93.184.216.34', 'internal.example': '10.0.0.5' });
  const r = await urlMeta.crawl('https://example.com', { deps: { fetchRaw: transport, lookup } });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 'BLOCKED_HOST');
  assert.strictEqual(transport.calls.length, 1, '내부 IP는 연결 전 차단(transport 미호출)');
});

// ── D-RDR-2: hop 상한 ──
test('D-RDR-2 — 4 hop 초과 → CRAWL_FAILED', async () => {
  const r302 = { statusCode: 302, headers: { location: 'https://example.com/next' } };
  const transport = seqTransport([r302, r302, r302, r302, r302]);
  const r = await urlMeta.crawl('https://example.com', { deps: { fetchRaw: transport, lookup: PUBLIC } });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 'CRAWL_FAILED');
});

// ── D-RDR-3: 비http hop 거부 ──
test('D-RDR-3 — Location: file:/// 거부', async () => {
  const transport = seqTransport([{ statusCode: 301, headers: { location: 'file:///etc/passwd' } }]);
  const r = await urlMeta.crawl('https://example.com', { deps: { fetchRaw: transport, lookup: PUBLIC } });
  assert.strictEqual(r.ok, false);
  assert.ok(r.code === 'BAD_INPUT' || r.code === 'BLOCKED_HOST');
});

// ── D-IMG-1: og:image 동일 게이트 ──
test('D-IMG-1 — og:image 내부 IP면 fetch 안 함·bannerKey=null', async () => {
  const transport = seqTransport([
    { statusCode: 200, headers: { 'content-type': 'text/html' }, body: '<meta property="og:image" content="http://internal.example/x.png">' },
  ]);
  const lookup = hostLookup({ 'example.com': '93.184.216.34', 'internal.example': '169.254.169.254' });
  const r = await urlMeta.crawl('https://example.com', { deps: { fetchRaw: transport, lookup }, imagesDir: tmpImagesDir() });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.bannerKey, null);
  assert.strictEqual(transport.calls.length, 1, 'og:image는 게이트에서 차단 — 다운로드 안 함');
});

// ── D-RES-1: 512KB 상한·소켓 destroy ──
test('D-RES-1 — readCapped 상한 초과 시 destroy·부분만 보관', async () => {
  const r = new Readable({ read() {} });
  let destroyed = false;
  const orig = r.destroy.bind(r);
  r.destroy = () => { destroyed = true; return orig(); };
  process.nextTick(() => { r.push(Buffer.alloc(600 * 1024, 0x61)); });
  const out = await urlMeta.readCapped(r, 512 * 1024);
  assert.strictEqual(out.truncated, true);
  assert.ok(destroyed, '초과 시 소켓 destroy');
  assert.ok(out.buf.length <= 512 * 1024);
});

// ── D-RES-2: 타임아웃 ──
test('D-RES-2 — withTimeout 만료 시 onTimeout 호출·거부', async () => {
  let aborted = false;
  await assert.rejects(
    urlMeta.withTimeout(new Promise(() => {}), 20, () => { aborted = true; }),
    /timeout/,
  );
  assert.ok(aborted, '타임아웃 시 abort 콜백');
});

test('D-RES-2 — fetchRaw 거부(타임아웃 류) → CRAWL_FAILED', async () => {
  const transport = async () => { throw new Error('timeout'); };
  const r = await urlMeta.crawl('https://example.com', { deps: { fetchRaw: transport, lookup: PUBLIC } });
  assert.strictEqual(r.code, 'CRAWL_FAILED');
});

// ── D-RES-5: 비HTML content-type → 본문 미파싱(폴백) ──
test('D-RES-5 — 비HTML content-type은 본문 미파싱(폴백 메타)', async () => {
  const transport = seqTransport([{ statusCode: 200, headers: { 'content-type': 'application/json' }, body: '<meta property="og:title" content="X">' }]);
  const r = await urlMeta.crawl('https://example.com/api', { deps: { fetchRaw: transport, lookup: PUBLIC } });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.meta.title, 'example.com', '파싱 안 함 → host 폴백');
});

// ── D-URL-1: 진입 스킴 거부 ──
test('D-URL — 비http(s) 입력 거부(전처리)', async () => {
  const r = await urlMeta.crawl('file:///etc/passwd', { deps: { fetchRaw: seqTransport([]), lookup: PUBLIC } });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 'BAD_INPUT');
});

// ── D-RES-4: 동시 크롤 상한(전역 세마포어, 수동/자동 공유) ──
test('D-RES-4 — 동시 크롤이 MAX_CONCURRENT_CRAWLS를 넘지 않음', async () => {
  let active = 0;
  let maxActive = 0;
  const slow = async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((r) => setTimeout(r, 25));
    active -= 1;
    return { statusCode: 200, headers: { 'content-type': 'text/html' }, res: resOf('') };
  };
  const deps = { fetchRaw: slow, lookup: PUBLIC };
  await Promise.all(Array.from({ length: 9 }, () => urlMeta.crawl('https://example.com', { deps })));
  assert.ok(maxActive <= urlMeta.MAX_CONCURRENT_CRAWLS, '최대 동시 크롤 ' + maxActive + ' ≤ ' + urlMeta.MAX_CONCURRENT_CRAWLS);
  assert.ok(maxActive > 0);
});
