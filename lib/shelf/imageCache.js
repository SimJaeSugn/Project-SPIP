'use strict';
/**
 * lib/shelf/imageCache.js — og:image 캐시 검증·저장·전달 (SH-3, 위협모델 D-IMG-2~5 · D-CACHE-1~3)
 *
 * og:image 바이트를 appData/shelf-images/ 아래 0600으로 저장하고, list/add/refresh 응답에서만
 * data:URI로 전달한다(저장본엔 bannerKey만 — ADR-SH-1/2). 검증:
 *   - content-type ∈ {png,jpeg,gif,webp}만(SVG 완전 제외, D-IMG-2/3)
 *   - 매직바이트 sniff로 선언 mime ↔ 실제 바이트 일치(D-IMG-4)
 *   - 크기 ≤ 100KB(D-IMG-5)
 *   - 파일명 = sha256 32hex 키 + 화이트리스트 확장자(경로탈출 차단, D-CACHE-1)
 *   - 0600 write·상승세션 보류·총량 상한 + 미참조 GC(D-CACHE-2)
 *   - toDataUri는 mime 화이트리스트·base64 검증(D-CACHE-3)
 *
 * 외부 의존성 0 — Node 내장(fs, path, crypto) + 내부(paths, elevationState)만.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const paths = require('../common/paths');
const elevationState = require('../common/elevationState');

const MAX_IMAGE_BYTES = 100 * 1024;          // D-IMG-5
const MAX_TOTAL_CACHE_BYTES = 16 * 1024 * 1024; // D-CACHE-2 총량 상한
const FILE_MODE = 0o600;
const KEY_RE = /^[0-9a-f]{32}$/;             // D-CACHE-1 — sha256 앞 32hex만(경로탈출 차단)
const MIME_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
const EXT_MIME = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };

/** 캐시 디렉토리(주입 가능 — 테스트). */
function imagesDir(ctx) {
  return (ctx && ctx.imagesDir) || path.join(paths.appDir(), 'shelf-images');
}

/** URL → 캐시 키(sha256 앞 32hex). */
function keyFor(url) {
  return crypto.createHash('sha256').update(String(url)).digest('hex').slice(0, 32);
}

/** 매직바이트로 실제 이미지 mime 판별(D-IMG-4). 미지/SVG는 null. */
function sniffMime(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  // PNG 89 50 4E 47 0D 0A 1A 0A
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47
    && buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a) return 'image/png';
  // JPEG FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  // GIF 'GIF8'
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return 'image/gif';
  // WEBP 'RIFF'....'WEBP'
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46
    && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'image/webp';
  return null;
}

/** 선언 content-type 정규화(파라미터 제거·소문자). */
function normalizeContentType(ct) {
  return String(ct || '').split(';')[0].trim().toLowerCase();
}

/**
 * 이미지 바이트 검증(D-IMG-2~5). content-type 화이트리스트(SVG 제외)·크기·매직바이트 일치.
 * @returns {{ok:true, mime, ext}|{ok:false, code}}
 */
function validateImage(buf, declaredCt) {
  if (!Buffer.isBuffer(buf) || buf.length === 0) return { ok: false, code: 'CRAWL_FAILED' };
  if (buf.length > MAX_IMAGE_BYTES) return { ok: false, code: 'CRAWL_FAILED' }; // D-IMG-5
  const ct = normalizeContentType(declaredCt);
  if (!Object.prototype.hasOwnProperty.call(MIME_EXT, ct)) return { ok: false, code: 'CRAWL_FAILED' }; // D-IMG-2/3(svg 거부)
  const sniffed = sniffMime(buf);
  if (sniffed !== ct) return { ok: false, code: 'CRAWL_FAILED' }; // D-IMG-4 위조 차단
  return { ok: true, mime: ct, ext: MIME_EXT[ct] };
}

/**
 * 검증된 이미지 바이트를 0600으로 저장하고 bannerKey 반환(D-CACHE-2). 상승세션이면 저장 보류→null.
 * @returns {string|null} bannerKey 또는 null(검증실패/상승세션/IO실패)
 */
function store(url, buf, declaredCt, ctx) {
  ctx = ctx || {};
  const v = validateImage(buf, declaredCt);
  if (!v.ok) return null;
  const elev = (ctx.deps && ctx.deps.elevationState) || elevationState;
  if (elev.isElevated()) return null; // 상승세션 — 디스크 저장 보류(정합)
  const key = keyFor(url);
  const dir = imagesDir(ctx);
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, key + '.' + v.ext);
    const fd = fs.openSync(file, 'w', FILE_MODE);
    try { fs.writeFileSync(fd, buf); } finally { fs.closeSync(fd); }
    try { fs.chmodSync(file, FILE_MODE); } catch (_) { /* noop */ }
    return key;
  } catch (_) {
    return null;
  }
}

/** 키에 대응하는 캐시 파일 경로 탐색(화이트리스트 확장자). */
function findCacheFile(key, ctx) {
  const dir = imagesDir(ctx);
  for (const ext of Object.keys(EXT_MIME)) {
    const file = path.join(dir, key + '.' + ext);
    if (fs.existsSync(file)) return { file, ext };
  }
  return null;
}

/**
 * bannerKey → data:URI(D-CACHE-3). 키 정규식·mime 화이트리스트·base64. 실패 시 null.
 */
function toDataUri(bannerKey, ctx) {
  if (typeof bannerKey !== 'string' || !KEY_RE.test(bannerKey)) return null; // D-CACHE-1 경로탈출 차단
  const found = findCacheFile(bannerKey, ctx);
  if (!found) return null;
  const mime = EXT_MIME[found.ext];
  if (!mime) return null;
  let buf;
  try { buf = fs.readFileSync(found.file); } catch (_) { return null; }
  if (!Buffer.isBuffer(buf) || buf.length === 0 || buf.length > MAX_IMAGE_BYTES) return null;
  if (sniffMime(buf) !== mime) return null; // 재검증(파일 변조 방어)
  return 'data:' + mime + ';base64,' + buf.toString('base64');
}

/**
 * 미참조 캐시 GC + 총량 상한(D-CACHE-2). referencedKeys에 없는 파일 삭제, 초과 시 오래된 것부터 삭제.
 * @param {Set<string>|string[]} referencedKeys 현재 북마크가 참조하는 bannerKey 집합
 */
function gc(referencedKeys, ctx) {
  const dir = imagesDir(ctx);
  const refSet = referencedKeys instanceof Set ? referencedKeys : new Set(Array.isArray(referencedKeys) ? referencedKeys : []);
  let entries;
  try { entries = fs.readdirSync(dir); } catch (_) { return; }
  const files = [];
  for (const name of entries) {
    const dot = name.lastIndexOf('.');
    if (dot < 0) continue;
    const key = name.slice(0, dot);
    const ext = name.slice(dot + 1);
    if (!KEY_RE.test(key) || !EXT_MIME[ext]) { // 비정상 파일 정리
      try { fs.unlinkSync(path.join(dir, name)); } catch (_) { /* noop */ }
      continue;
    }
    const full = path.join(dir, name);
    if (!refSet.has(key)) {
      try { fs.unlinkSync(full); } catch (_) { /* noop */ }
      continue;
    }
    try { const st = fs.statSync(full); files.push({ full, size: st.size, mtime: st.mtimeMs }); } catch (_) { /* noop */ }
  }
  // 총량 상한 — 초과 시 오래된 것부터.
  let total = files.reduce((a, f) => a + f.size, 0);
  if (total > MAX_TOTAL_CACHE_BYTES) {
    files.sort((a, b) => a.mtime - b.mtime);
    for (const f of files) {
      if (total <= MAX_TOTAL_CACHE_BYTES) break;
      try { fs.unlinkSync(f.full); total -= f.size; } catch (_) { /* noop */ }
    }
  }
}

module.exports = {
  store,
  toDataUri,
  validateImage,
  sniffMime,
  keyFor,
  gc,
  imagesDir,
  MAX_IMAGE_BYTES,
  KEY_RE,
  MIME_EXT,
};
