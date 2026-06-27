'use strict';
/**
 * lib/shelf/ssrfGuard.js — SSRF 방어 게이트 (SH-3, 위협모델 D-SSRF-1~6 · D-URL-1~3)
 *
 * URL 1차 검증(scheme·자격·길이) + IP 분류표(루프백·사설·링크로컬·메타데이터·CGNAT·멀티캐스트/예약,
 * IPv4-mapped IPv6 해제, 비표준 표기는 WHATWG URL이 정규화) + DNS resolve 후 결과 IP 기준 판정
 * (호스트명 화이트리스트 불충분) + IP 핀(검증한 IP로 직접 연결 — DNS rebinding/TOCTOU 차단).
 *
 * IP 분류·정규화는 순수 함수(헤드리스 전수 테스트). DNS resolve·연결은 lookup 주입으로 모킹.
 * 외부 의존성 0 — Node 내장(net, dns) + 내부(config.validateHttpUrl 재사용)만.
 */

const net = require('net');
const dns = require('dns');
const config = require('../common/config');

const MAX_URL_LEN = 2048; // D-URL-3

/** 호스트 문자열 정돈 — 대괄호(IPv6)·후행점 제거. */
function stripHost(host) {
  let h = String(host == null ? '' : host).trim();
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  if (h.length > 1 && h.endsWith('.')) h = h.slice(0, -1);
  return h;
}

/** 점표기 IPv4 → uint32. */
function ipv4ToInt(ip) {
  const p = ip.split('.');
  return (((Number(p[0]) << 24) >>> 0) + (Number(p[1]) << 16) + (Number(p[2]) << 8) + Number(p[3])) >>> 0;
}

/** int가 CIDR(base/bits)에 속하는가. */
function inCidr(int, base, bits) {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (int & mask) === (ipv4ToInt(base) & mask);
}

// [D-SSRF-1] 차단 IPv4 CIDR 분류표.
const BLOCK_V4 = [
  ['0.0.0.0', 8],        // 현재 네트워크/unspecified
  ['10.0.0.0', 8],       // 사설
  ['100.64.0.0', 10],    // CGNAT(100.100.100.200 메타데이터 포함)
  ['127.0.0.0', 8],      // 루프백
  ['169.254.0.0', 16],   // 링크로컬(169.254.169.254 메타데이터 포함)
  ['172.16.0.0', 12],    // 사설
  ['192.0.0.0', 24],     // IETF 프로토콜 할당
  ['192.0.2.0', 24],     // TEST-NET-1
  ['192.168.0.0', 16],   // 사설
  ['198.18.0.0', 15],    // 벤치마킹
  ['224.0.0.0', 4],      // 멀티캐스트
  ['240.0.0.0', 4],      // 예약(255.255.255.255 포함)
];

/** IPv4(점표기) 분류 — 차단 대상이면 'blocked', 아니면 null(public). */
function classifyIpv4(ip) {
  if (!net.isIPv4(ip)) return 'blocked'; // 비정상 표기 보수적 차단
  const n = ipv4ToInt(ip);
  for (const [base, bits] of BLOCK_V4) if (inCidr(n, base, bits)) return 'blocked';
  return null;
}

/** IPv6 문자열 → 8×16bit 그룹 배열(또는 null). 내장 IPv4(::ffff:1.2.3.4)도 흡수. */
function expandIpv6(ip) {
  if (!net.isIPv6(ip)) return null;
  let s = ip;
  const v4m = s.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (v4m && net.isIPv4(v4m[1])) {
    const p = v4m[1].split('.').map(Number);
    const hex = (((p[0] << 8) | p[1]).toString(16)) + ':' + (((p[2] << 8) | p[3]).toString(16));
    s = s.slice(0, v4m.index) + hex;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  let groups;
  if (halves.length === 1) {
    groups = head;
  } else {
    const tail = halves[1] ? halves[1].split(':') : [];
    const missing = 8 - head.length - tail.length;
    if (missing < 0) return null;
    groups = head.concat(new Array(missing).fill('0'), tail);
  }
  if (groups.length !== 8) return null;
  const out = [];
  for (const g of groups) {
    if (g === '') return null;
    const v = parseInt(g, 16);
    if (!Number.isFinite(v) || v < 0 || v > 0xffff) return null;
    out.push(v);
  }
  return out;
}

/** IPv6 분류 — 차단 대상이면 'blocked', 아니면 null. IPv4-mapped는 IPv4로 풀어 재판정(D-SSRF-4). */
function classifyIpv6(ip) {
  const low = String(ip).toLowerCase();
  if (low === '::1' || low === '::') return 'blocked'; // 루프백·unspecified
  const g = expandIpv6(ip);
  if (!g) return 'blocked'; // 파싱 실패 보수적 차단
  // IPv4-mapped(::ffff:a.b.c.d) → 앞 80bit=0, 81~96bit=0xffff
  if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0xffff) {
    const v4 = ((g[6] >> 8) & 0xff) + '.' + (g[6] & 0xff) + '.' + ((g[7] >> 8) & 0xff) + '.' + (g[7] & 0xff);
    return classifyIpv4(v4);
  }
  // IPv4-compatible(::a.b.c.d, deprecated) — 앞 96bit 0
  if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0 && !(g[6] === 0 && g[7] <= 1)) {
    const v4 = ((g[6] >> 8) & 0xff) + '.' + (g[6] & 0xff) + '.' + ((g[7] >> 8) & 0xff) + '.' + (g[7] & 0xff);
    return classifyIpv4(v4);
  }
  const first = g[0];
  if ((first & 0xfe00) === 0xfc00) return 'blocked'; // fc00::/7 ULA(사설)
  if ((first & 0xffc0) === 0xfe80) return 'blocked'; // fe80::/10 링크로컬
  if ((first & 0xff00) === 0xff00) return 'blocked'; // ff00::/8 멀티캐스트
  return null;
}

/** IP 문자열 차단 여부(IPv4/IPv6 판별 후 분류). 비IP는 보수적 차단. */
function isBlockedIp(ip) {
  const s = stripHost(ip);
  if (net.isIPv4(s)) return classifyIpv4(s) === 'blocked';
  if (net.isIPv6(s)) return classifyIpv6(s) === 'blocked';
  return true;
}

/**
 * 호스트 분류 — 'blocked'(차단 IP) · null(public IP) · 'name'(도메인 → DNS 필요).
 * WHATWG URL이 비표준 IPv4 표기를 정규화하므로(0x7f000001→127.0.0.1) 여기선 정규화된 host를 받는다.
 */
function classifyHost(host) {
  const h = stripHost(host);
  if (!h) return 'blocked';
  if (net.isIPv4(h)) return classifyIpv4(h);
  if (net.isIPv6(h)) return classifyIpv6(h);
  return 'name';
}

/**
 * URL 1차 검증(D-URL-1~3) — scheme(http/https)·자격거부·길이. config.validateHttpUrl 재사용.
 * @returns {{ok:true,value,url,host}|{ok:false,code}}
 */
function validateUrl(input, opts) {
  opts = opts || {};
  const v = config.validateHttpUrl(input, { maxLen: opts.maxLen || MAX_URL_LEN });
  if (!v.ok) return { ok: false, code: 'BAD_INPUT' };
  let u;
  try { u = new URL(v.value); } catch (_) { return { ok: false, code: 'BAD_INPUT' }; }
  return { ok: true, value: v.value, url: u, host: u.hostname };
}

/** dns.lookup(all:true) 래퍼(주입 가능). [{address,family}] 반환. */
function defaultLookupAll(host) {
  return new Promise((resolve, reject) => {
    dns.lookup(host, { all: true, verbatim: true }, (err, addrs) => (err ? reject(err) : resolve(addrs)));
  });
}

/**
 * 호스트를 DNS resolve해 결과 IP를 전수 분류하고(D-SSRF-2: 하나라도 차단이면 거부) 연결용 IP를 핀한다(D-SSRF-3).
 * @param {string} host 정규화된 hostname
 * @param {object} [opts] { lookup } — (host)=>Promise<[{address,family}]>
 * @returns {Promise<{ok:true,ip,family}|{ok:false,code}>}
 */
async function resolveAndCheck(host, opts) {
  opts = opts || {};
  const lookup = opts.lookup || defaultLookupAll;
  const direct = classifyHost(host);
  if (direct === 'blocked') return { ok: false, code: 'BLOCKED_HOST' };
  if (direct === null) {
    const h = stripHost(host);
    return { ok: true, ip: h, family: net.isIPv6(h) ? 6 : 4 };
  }
  // 도메인 → DNS resolve 후 결과 IP 기준 판정.
  let addrs;
  try { addrs = await lookup(host); } catch (_) { return { ok: false, code: 'CRAWL_FAILED' }; }
  if (!Array.isArray(addrs) || addrs.length === 0) return { ok: false, code: 'CRAWL_FAILED' };
  for (const a of addrs) {
    if (!a || typeof a.address !== 'string') return { ok: false, code: 'BLOCKED_HOST' };
    if (isBlockedIp(a.address)) return { ok: false, code: 'BLOCKED_HOST' }; // D-SSRF-2
  }
  const first = addrs[0];
  return { ok: true, ip: first.address, family: first.family || (net.isIPv6(first.address) ? 6 : 4) };
}

/**
 * IP 핀 lookup 콜백 생성 — http(s) 연결 시 항상 검증 IP만 반환(연결 시점 도메인 재해석 금지, D-SSRF-3).
 * @param {string} verifiedIp 검증·핀된 IP
 * @param {number} family 4|6
 * @returns {function} (hostname, options, cb) => void
 */
function pinnedLookup(verifiedIp, family) {
  return function (_hostname, options, cb) {
    if (typeof options === 'function') { cb = options; }
    const fam = family || (net.isIPv6(verifiedIp) ? 6 : 4);
    // all:true 요청 형태 지원.
    if (options && typeof options === 'object' && options.all) {
      cb(null, [{ address: verifiedIp, family: fam }]);
      return;
    }
    cb(null, verifiedIp, fam);
  };
}

module.exports = {
  validateUrl,
  classifyHost,
  classifyIpv4,
  classifyIpv6,
  isBlockedIp,
  expandIpv6,
  resolveAndCheck,
  pinnedLookup,
  stripHost,
  defaultLookupAll,
  MAX_URL_LEN,
};
