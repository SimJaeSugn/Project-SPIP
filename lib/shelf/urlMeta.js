'use strict';
/**
 * lib/shelf/urlMeta.js — URL 크롤 오케스트레이션 (SH-3, 위협모델 D-RDR-1~4 · D-RES-1~5 · D-IMG-1 · D-PRIV-1~3)
 *
 * 흐름: validateUrl(G1) → DNS+IP 게이트·IP 핀(G2) → GET(IP핀·8s·512KB·identity·쿠키/인증/Referer 없음·
 * 고정 UA) → 리다이렉트 ≤3 hop(각 hop G1+G2 재실행, D-RDR-1) → ogParse → og:image도 동일 게이트
 * 재진입(D-IMG-1) → imageCache. 모든 egress는 main 단독. net(fetchRaw)·lookup 주입으로 헤드리스 테스트.
 *
 * 외부 의존성 0 — Node 내장(http, https) + 내부(ssrfGuard, ogParse, imageCache, detectType)만.
 */

const http = require('http');
const https = require('https');
const ssrfGuard = require('./ssrfGuard');
const ogParse = require('./ogParse');
const imageCache = require('./imageCache');
const detectType = require('./detectType');

const MAX_REDIRECTS = 3;        // D-RDR-2
const TIMEOUT_MS = 8000;        // D-RES-2
const MAX_HTML_BYTES = 512 * 1024; // D-RES-1
const MAX_IMAGE_BYTES = 100 * 1024; // D-IMG-5
const FIXED_UA = 'spip-shelf/1.0'; // D-PRIV-3 고정 최소 UA

const PALETTE = ['#1c1917', '#4f46e5', '#0f766e', '#9333ea', '#b45309', '#0369a1', '#be123c', '#0e7490'];

// [D-RES-4] 동시 크롤 in-flight 상한 — 수동 add/refresh와 자동 재크롤(scheduler)이 공유하는 전역 세마포어.
//   폭주 방지(자동 배치 시 다수 url 동시 크롤 억제). 초과분은 거부가 아니라 대기(FIFO)한다.
const MAX_CONCURRENT_CRAWLS = 3;
let _activeCrawls = 0;
const _crawlQueue = [];

function _acquireCrawl() {
  if (_activeCrawls < MAX_CONCURRENT_CRAWLS) { _activeCrawls += 1; return Promise.resolve(); }
  return new Promise((resolve) => { _crawlQueue.push(resolve); }).then(() => { _activeCrawls += 1; });
}
function _releaseCrawl() {
  _activeCrawls -= 1;
  const next = _crawlQueue.shift();
  if (next) next();
}

/** 요청 옵션 구성(D-PRIV: 쿠키/인증/Referer 미포함, identity, 고정 UA, IP 핀). */
function buildReqOpts(u, chk, kind) {
  const accept = kind === 'image'
    ? 'image/png,image/jpeg,image/gif,image/webp'
    : 'text/html,application/xhtml+xml';
  return {
    protocol: u.protocol,
    hostname: u.hostname,
    port: u.port || (u.protocol === 'https:' ? 443 : 80),
    path: (u.pathname || '/') + (u.search || ''),
    method: 'GET', // D-RES-5
    headers: {
      Accept: accept,
      'Accept-Encoding': 'identity', // D-RES-3 압축 미요청
      'User-Agent': FIXED_UA,
      Host: u.host,
      // Cookie/Authorization/Referer 의도적 미포함(D-PRIV-1~3)
    },
    servername: u.hostname, // SNI(IP 핀과 함께 원래 host 제시)
    lookup: ssrfGuard.pinnedLookup(chk.ip, chk.family), // D-SSRF-3 연결 시 도메인 재해석 금지
    timeout: TIMEOUT_MS,
  };
}

/** 기본 저수준 요청(주입 가능). resolve({statusCode,headers,res:Readable}). */
function defaultFetchRaw(reqOpts) {
  const mod = reqOpts.protocol === 'http:' ? http : https;
  return new Promise((resolve, reject) => {
    let req;
    try {
      req = mod.request(reqOpts, (res) => {
        // [D-2] 버려진 응답 스트림(상위 withTimeout이 먼저 settle한 경우)의 미처리 'error' 방어 —
        //   소켓 타임아웃 destroy 시 리스너 없는 'error' 가 throw 되어 메인이 죽는 것을 차단.
        res.on('error', () => { /* swallow — readCapped가 별도로 처리하거나 폐기 */ });
        resolve({ statusCode: res.statusCode, headers: res.headers || {}, res });
      });
    } catch (err) { reject(err); return; }
    req.on('error', reject);
    req.on('timeout', () => { try { req.destroy(new Error('timeout')); } catch (_) { /* noop */ } });
    if (reqOpts.timeout) req.setTimeout(reqOpts.timeout);
    req.end();
  });
}

/** 응답 스트림을 limit까지 누적, 초과 시 즉시 destroy(D-RES-1/D-IMG-5). */
function readCapped(res, limit) {
  return new Promise((resolve) => {
    let total = 0;
    let truncated = false;
    const chunks = [];
    let done = false;
    const finish = () => { if (done) return; done = true; resolve({ buf: Buffer.concat(chunks), truncated }); };
    res.on('data', (c) => {
      const chunk = Buffer.isBuffer(c) ? c : Buffer.from(c);
      total += chunk.length;
      if (total <= limit) chunks.push(chunk);
      else { truncated = true; try { res.destroy(); } catch (_) { /* noop */ } finish(); }
    });
    res.on('end', finish);
    res.on('close', finish);
    res.on('error', finish);
  });
}

/** Promise에 전체 타임아웃 적용(D-RES-2). 만료 시 onTimeout 호출 후 거부. */
function withTimeout(promise, ms, onTimeout) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const t = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { if (onTimeout) onTimeout(); } catch (_) { /* noop */ }
      reject(new Error('timeout'));
    }, ms);
    promise.then((v) => { if (settled) return; settled = true; clearTimeout(t); resolve(v); },
      (e) => { if (settled) return; settled = true; clearTimeout(t); reject(e); });
  });
}

/**
 * 게이트를 거쳐 한 리소스를 가져온다(리다이렉트 hop마다 G1+G2 재실행).
 * @param {string} startUrl
 * @param {'html'|'image'} kind
 * @param {object} deps { fetchRaw, lookup }
 * @returns {Promise<{ok:true, statusCode, headers, res, value}|{ok:false, code}>}
 */
async function fetchWithGate(startUrl, kind, deps) {
  deps = deps || {};
  const fetchRaw = deps.fetchRaw || defaultFetchRaw;
  let current = startUrl;
  let redirects = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    // G1: scheme/자격/길이(D-URL-*, D-RDR-3).
    const v = ssrfGuard.validateUrl(current);
    if (!v.ok) return { ok: false, code: v.code || 'BAD_INPUT' };
    // G2: DNS resolve + IP 분류 + 핀(D-SSRF-*).
    const chk = await ssrfGuard.resolveAndCheck(v.host, { lookup: deps.lookup });
    if (!chk.ok) return { ok: false, code: chk.code };

    const reqOpts = buildReqOpts(v.url, chk, kind);
    let resp;
    try {
      resp = await withTimeout(fetchRaw(reqOpts), TIMEOUT_MS, null);
    } catch (_) {
      return { ok: false, code: 'CRAWL_FAILED' };
    }
    const statusCode = resp.statusCode || 0;
    const headers = resp.headers || {};

    if (statusCode >= 300 && statusCode < 400 && headers.location) {
      redirects += 1;
      try { if (resp.res && resp.res.destroy) resp.res.destroy(); } catch (_) { /* noop */ }
      if (redirects > MAX_REDIRECTS) return { ok: false, code: 'CRAWL_FAILED' }; // D-RDR-2
      let next;
      try { next = new URL(headers.location, v.value).toString(); } catch (_) { return { ok: false, code: 'CRAWL_FAILED' }; }
      current = next; // 루프 상단에서 G1+G2 재실행(D-RDR-1)
      continue;
    }
    return { ok: true, statusCode, headers, res: resp.res, value: v.value };
  }
}

/** 페이지를 크롤해 메타 추출(본문 ≤512KB, content-type text/html만 파싱, D-RES-5). */
async function fetchPage(startUrl, deps) {
  const r = await fetchWithGate(startUrl, 'html', deps);
  if (!r.ok) return r;
  const ct = String((r.headers['content-type'] || '')).toLowerCase();
  let meta = { title: '', desc: '', image: '', siteName: '' };
  if (/text\/html|application\/xhtml/.test(ct)) {
    let body;
    try { body = await withTimeout(readCapped(r.res, MAX_HTML_BYTES), TIMEOUT_MS, () => { try { r.res.destroy(); } catch (_) { /* noop */ } }); }
    catch (_) { return { ok: false, code: 'CRAWL_FAILED' }; }
    meta = ogParse.extract(body.buf.toString('utf8'));
  } else {
    try { if (r.res && r.res.destroy) r.res.destroy(); } catch (_) { /* noop */ }
  }
  return { ok: true, statusCode: r.statusCode, value: r.value, meta };
}

/** og:image를 동일 게이트로 가져와 검증·캐시(D-IMG-1). 실패 시 bannerKey=null. */
async function fetchImage(imgUrl, ctx) {
  const deps = (ctx && ctx.deps) || {};
  const r = await fetchWithGate(imgUrl, 'image', deps); // D-IMG-1 동일 게이트 재진입
  if (!r.ok) return null;
  let body;
  try { body = await withTimeout(readCapped(r.res, MAX_IMAGE_BYTES), TIMEOUT_MS, () => { try { r.res.destroy(); } catch (_) { /* noop */ } }); }
  catch (_) { return null; }
  if (body.truncated) return null; // 100KB 초과 → 폴백(D-IMG-5)
  const ct = r.headers['content-type'];
  return imageCache.store(imgUrl, body.buf, ct, ctx); // 검증(mime/매직/크기)·0600 저장
}

/** host → 결정적 색(팔레트). */
function colorForHost(host) {
  let h = 0;
  for (let i = 0; i < host.length; i++) h = (h * 31 + host.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

/** 메타 → ShelfBookmarkView 표시 필드(정규화는 영속 경계가 최종 적용). */
function buildView(meta, finalUrl, statusCode) {
  const host = detectType.hostOf(finalUrl) || finalUrl;
  const name = meta.siteName || host;
  const title = meta.title || host;
  const mono = (name.charAt(0) || 'W').toUpperCase();
  return {
    name,
    title,
    sub: host,
    desc: meta.desc || '',
    color: colorForHost(host),
    mono,
    cat: '웹',
    status: String(statusCode || 200) + ' · ' + host,
  };
}

async function _crawl(rawUrl, ctx) {
  ctx = ctx || {};
  const page = await fetchPage(rawUrl, (ctx.deps) || {});
  if (!page.ok) return { ok: false, code: page.code };

  const view = buildView(page.meta, page.value, page.statusCode);

  let bannerKey = null;
  if (page.meta.image) {
    let imgUrl = null;
    try { imgUrl = new URL(page.meta.image, page.value).toString(); } catch (_) { imgUrl = null; }
    if (imgUrl) {
      try { bannerKey = await fetchImage(imgUrl, ctx); } catch (_) { bannerKey = null; }
    }
  }
  return { ok: true, meta: view, bannerKey };
}

/**
 * URL 크롤 진입점. 페이지 메타 + og:image 캐시.
 *   [D-RES-4] 전역 동시 크롤 세마포어를 통과한다(수동 add/refresh·자동 재크롤 공유 — 폭주 방지).
 * @param {string} rawUrl
 * @param {object} ctx { deps?{fetchRaw,lookup,elevationState}, imagesDir? }
 * @returns {Promise<{ok:true, meta, bannerKey}|{ok:false, code}>}
 */
async function crawl(rawUrl, ctx) {
  await _acquireCrawl();
  try {
    return await _crawl(rawUrl, ctx);
  } finally {
    _releaseCrawl();
  }
}

module.exports = {
  crawl,
  fetchPage,
  fetchImage,
  fetchWithGate,
  buildReqOpts,
  readCapped,
  withTimeout,
  buildView,
  colorForHost,
  MAX_REDIRECTS,
  TIMEOUT_MS,
  MAX_HTML_BYTES,
  MAX_CONCURRENT_CRAWLS,
  FIXED_UA,
};
