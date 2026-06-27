'use strict';
/**
 * shelf-ssrfGuard.test.js — lib/shelf/ssrfGuard.js (SH-3, D-SSRF-1~6 · D-URL-1~3)
 */
const { test } = require('node:test');
const assert = require('node:assert');
const ssrf = require('../lib/shelf/ssrfGuard');

// ── D-SSRF-1: IP 분류표 전수 + 경계값 ──
test('D-SSRF-1 — 차단 IPv4 분류표(루프백·사설·링크로컬·메타데이터·CGNAT·멀티캐스트/예약)', () => {
  const blocked = [
    '0.0.0.0', '0.1.2.3', '10.0.0.0', '10.255.255.255', '100.64.0.1', '100.100.100.200',
    '127.0.0.1', '127.255.255.255', '169.254.0.1', '169.254.169.254', '172.16.0.0', '172.31.255.255',
    '192.0.0.1', '192.0.2.5', '192.168.0.1', '198.18.0.1', '224.0.0.1', '240.0.0.1', '255.255.255.255',
  ];
  for (const ip of blocked) assert.strictEqual(ssrf.classifyIpv4(ip), 'blocked', '차단되어야: ' + ip);
});

test('D-SSRF-1 — 경계값 허용(public)', () => {
  const allowed = ['11.0.0.0', '9.255.255.255', '172.15.255.255', '172.32.0.0', '100.63.255.255', '8.8.8.8', '1.1.1.1', '126.255.255.255', '128.0.0.1'];
  for (const ip of allowed) assert.strictEqual(ssrf.classifyIpv4(ip), null, '허용되어야: ' + ip);
});

test('D-SSRF-1 — 차단 IPv6(루프백·ULA·링크로컬·멀티캐스트·메타데이터)', () => {
  for (const ip of ['::1', '::', 'fc00::1', 'fd00:ec2::254', 'fe80::1', 'ff02::1']) {
    assert.strictEqual(ssrf.classifyIpv6(ip), 'blocked', '차단되어야: ' + ip);
  }
  // public IPv6 허용
  assert.strictEqual(ssrf.classifyIpv6('2606:4700:4700::1111'), null);
});

// ── D-SSRF-4: IPv4-mapped IPv6 ──
test('D-SSRF-4 — IPv4-mapped IPv6는 IPv4로 풀어 재판정', () => {
  assert.strictEqual(ssrf.classifyIpv6('::ffff:127.0.0.1'), 'blocked');
  assert.strictEqual(ssrf.classifyIpv6('::ffff:169.254.169.254'), 'blocked');
  assert.strictEqual(ssrf.classifyIpv6('::ffff:8.8.8.8'), null);
});

// ── D-SSRF-5: 비표준 표기(WHATWG URL 정규화 경유) ──
test('D-SSRF-5 — 비표준 IPv4 표기 정규화 후 차단(validateUrl→host)', () => {
  for (const h of ['0x7f000001', '2130706433', '0177.0.0.1', '127.1', '0xA9FEA9FE']) {
    const v = ssrf.validateUrl('http://' + h + '/');
    assert.strictEqual(v.ok, true, 'URL 파싱: ' + h);
    assert.strictEqual(ssrf.classifyHost(v.host), 'blocked', '정규화 후 차단: ' + h + ' → ' + v.host);
  }
});

// ── D-SSRF-6: 엣지 호스트 ──
test('D-SSRF-6 — 엣지 호스트(빈/0.0.0.0/대괄호 IPv6/후행점) 차단', () => {
  assert.strictEqual(ssrf.classifyHost(''), 'blocked');
  assert.strictEqual(ssrf.classifyHost('0.0.0.0'), 'blocked');
  assert.strictEqual(ssrf.classifyHost('[::1]'), 'blocked');
  assert.strictEqual(ssrf.classifyHost('127.0.0.1.'), 'blocked'); // 후행점 제거 후 분류
});

// ── D-SSRF-2: DNS resolve 후 결과 IP 기준, 복수 중 하나라도 차단이면 거부 ──
test('D-SSRF-2 — DNS 결과 IP 기준 판정(복수 중 1개 차단 → BLOCKED_HOST)', async () => {
  const lookupBlocked = async () => [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.5', family: 4 }];
  const r = await ssrf.resolveAndCheck('example.com', { lookup: lookupBlocked });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 'BLOCKED_HOST');
});

test('D-SSRF-2 — 전부 public이면 통과 + 첫 IP 핀', async () => {
  const lookupOk = async () => [{ address: '93.184.216.34', family: 4 }];
  const r = await ssrf.resolveAndCheck('example.com', { lookup: lookupOk });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.ip, '93.184.216.34');
});

test('D-SSRF-2 — DNS 실패 → CRAWL_FAILED', async () => {
  const r = await ssrf.resolveAndCheck('nx.invalid', { lookup: async () => { throw new Error('ENOTFOUND'); } });
  assert.strictEqual(r.code, 'CRAWL_FAILED');
});

// ── D-SSRF-3: IP 핀(연결 시 도메인 재해석 0) ──
test('D-SSRF-3 — pinnedLookup은 검증 IP만 반환(재해석 없음)', () => {
  const lk = ssrf.pinnedLookup('93.184.216.34', 4);
  let got = null;
  lk('evil.example.com', {}, (err, addr, fam) => { got = { addr, fam }; });
  assert.deepStrictEqual(got, { addr: '93.184.216.34', fam: 4 });
  // all:true 형태
  let gotAll = null;
  lk('evil.example.com', { all: true }, (err, addrs) => { gotAll = addrs; });
  assert.deepStrictEqual(gotAll, [{ address: '93.184.216.34', family: 4 }]);
});

// ── D-URL-1~3 ──
test('D-URL-1 — scheme 화이트리스트(http/https만)', () => {
  assert.strictEqual(ssrf.validateUrl('https://a.com').ok, true);
  assert.strictEqual(ssrf.validateUrl('file:///etc/passwd').ok, false);
  assert.strictEqual(ssrf.validateUrl('javascript:alert(1)').ok, false);
  assert.strictEqual(ssrf.validateUrl('ftp://a.com').ok, false);
  assert.strictEqual(ssrf.validateUrl('data:text/html,x').ok, false);
});

test('D-URL-2 — 자격(user:pass@) 거부', () => {
  assert.strictEqual(ssrf.validateUrl('http://u:p@a.com/').ok, false);
  assert.strictEqual(ssrf.validateUrl('http://u@a.com/').ok, false);
});

test('D-URL-3 — 길이 상한·파싱 실패 → BAD_INPUT', () => {
  assert.strictEqual(ssrf.validateUrl('http://a.com/' + 'x'.repeat(3000)).code, 'BAD_INPUT');
  assert.strictEqual(ssrf.validateUrl('not a url').code, 'BAD_INPUT');
  assert.strictEqual(ssrf.validateUrl(42).code, 'BAD_INPUT');
});
