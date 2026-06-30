'use strict';
/**
 * lib/mail/mailArchiveStore.js — 메일 보관함 영속 저장소 (mail-archive.json, 0600 원자적 쓰기)
 *
 * uiStateStore와 동일한 안전 메커니즘을 쓰되, 대용량 메일 메타를 ui-state.json과 분리한다.
 *   read():  크기 상한 → 안전 파싱(깊이 가드) → mailArchive.normalizeArchive 재검증 → graceful 기본값.
 *   write(): normalizeArchive 후 임시파일→fsync→rename→chmod 0600. 상승 세션이면 디스크 write 보류(no-op).
 *
 * 외부 의존성 0 — Node 내장(fs, path) + 내부(paths, elevationState, mailArchive).
 */

const fs = require('fs');
const path = require('path');
const paths = require('../common/paths');
const elevationState = require('../common/elevationState');
const mailArchive = require('./mailArchive');

const MAX_ARCHIVE_BYTES = 16 * 1024 * 1024; // 16MB 상한(메타 전용 — 계정·폴더·항목 상한으로 실질 제한)
const MAX_JSON_DEPTH = 32;
const FILE_MODE = 0o600;

/** 깊이 제한 JSON 파싱(과깊은 중첩 DoS 가드). 실패/초과 시 null. */
function safeParse(raw) {
  let depth = 0, max = 0;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c === '{' || c === '[') { depth++; if (depth > max) max = depth; if (max > MAX_JSON_DEPTH) return null; }
    else if (c === '}' || c === ']') { depth--; }
    else if (c === '"') { // 문자열 건너뛰기(escape 처리)
      i++;
      while (i < raw.length && raw[i] !== '"') { if (raw[i] === '\\') i++; i++; }
    }
  }
  try { return JSON.parse(raw); } catch (_) { return null; }
}

/**
 * mail-archive.json을 읽어 정규화된 보관함을 반환한다. 부재/손상/거대 모두 graceful 빈 보관함.
 * @param {object} [ctx] { logger, mailArchivePath?, deps?{fs,paths} }
 * @returns {{schemaVersion:number, accounts:object}}
 */
function read(ctx) {
  ctx = ctx || {};
  const _fs = (ctx.deps && ctx.deps.fs) || fs;
  const _paths = (ctx.deps && ctx.deps.paths) || paths;
  const file = ctx.mailArchivePath || _paths.mailArchivePath();
  try {
    const st = _fs.statSync(file);
    if (!st.isFile()) return mailArchive.defaultArchive();
    if (st.size > MAX_ARCHIVE_BYTES) return mailArchive.defaultArchive();
    const raw = _fs.readFileSync(file, 'utf8');
    if (typeof raw !== 'string' || raw.length > MAX_ARCHIVE_BYTES) return mailArchive.defaultArchive();
    const obj = safeParse(raw);
    return mailArchive.normalizeArchive(obj);
  } catch (_) {
    return mailArchive.defaultArchive();
  }
}

/**
 * 보관함을 정규화 후 0600 원자적 쓰기로 영속한다. 상승 세션이면 디스크 write 보류(메모리 결과만 반환).
 * @param {object} archive
 * @param {object} [ctx] { logger, mailArchivePath?, deps?{fs,paths,elevationState} }
 * @returns {{schemaVersion:number, accounts:object}} 영속된 정규화 보관함
 */
function write(archive, ctx) {
  ctx = ctx || {};
  const _fs = (ctx.deps && ctx.deps.fs) || fs;
  const _paths = (ctx.deps && ctx.deps.paths) || paths;
  const _elev = (ctx.deps && ctx.deps.elevationState) || elevationState;
  const file = ctx.mailArchivePath || _paths.mailArchivePath();
  const logger = ctx.logger;

  const normalized = mailArchive.normalizeArchive(archive);

  if (_elev.isElevated()) {
    if (logger && logger.warn) logger.warn('상승 세션 — 메일 보관함 디스크 저장 보류(메모리 유지)');
    return normalized;
  }

  const body = JSON.stringify(normalized, null, 2);
  const dir = _paths.ensureDirFor(file); // 0700 보장
  const tmp = path.join(dir, '.' + path.basename(file) + '.' + process.pid + '.' + Date.now() + '.tmp');

  let fd;
  try {
    fd = _fs.openSync(tmp, 'wx', FILE_MODE);
    _fs.writeFileSync(fd, body, { encoding: 'utf8' });
    try { _fs.fsyncSync(fd); } catch (_) { /* noop */ }
    _fs.closeSync(fd);
    fd = undefined;
    try { _fs.chmodSync(tmp, FILE_MODE); } catch (_) { /* noop */ }
    _fs.renameSync(tmp, file);
    try { _fs.chmodSync(file, FILE_MODE); } catch (_) { /* noop */ }
  } catch (err) {
    if (fd !== undefined) { try { _fs.closeSync(fd); } catch (_) { /* noop */ } }
    try { if (_fs.existsSync(tmp)) _fs.unlinkSync(tmp); } catch (_) { /* noop */ }
    if (logger && logger.error) logger.error('메일 보관함 저장 실패', err);
  }
  return normalized;
}

module.exports = { read, write, MAX_ARCHIVE_BYTES, FILE_MODE };
