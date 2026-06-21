'use strict';
/**
 * electron/ipc/folders.js — 폴더 선택·루트 관리 IPC (electron-migration §4.1/§4.2/§5)
 *
 *   spip:pickFolders (invoke) → 네이티브 dialog.showOpenDialog(openDirectory,multiSelections)
 *   spip:addRoots    (invoke) → 경로 직접 입력(addRootsResolve)
 *   spip:removeRoot  (invoke) → canonicalize 정확 일치 제거
 *
 * 핵심 보안(§4.2 / EM-H-1):
 *   · browseDir 채널 없음 — 임의 디렉터리 열람 표면 제거.
 *   · 모든 경로(직접 입력·dialog 결과)는 main에서 canonicalize/realpath·존재·디렉터리·
 *     시스템 폴더 제외 검증을 통과한 것만 config.scanRoots에 영속(H-1/L-2).
 *   · 채택/거부는 addRootsResolve 단일 경로로 산출(rejected:[{path,reason}], reason은 고정 토큰).
 *   · 영속은 0600 원자적 쓰기(M-2) — serializer의 임시파일→rename 패턴 재사용.
 *
 * [F-5] config.normalizeScanRoots는 거부분을 안 돌려주므로(continue+로그), 얇은 래퍼가
 *   입력 대비 채택/거부를 직접 산출하고, 최종 영속은 normalizeScanRoots로 한 번 더
 *   통과시켜 단일 화이트리스트 원천을 유지한다.
 *
 * [헤드리스 검증, F-3] Electron API(dialog) 미import. fs/path/canonicalize는 deps로 주입 가능.
 *   addRootsResolve·removeRootResolve·isSystemDir는 fs 모킹으로 단위테스트.
 *
 * 외부 의존성 0 — fs, path, os + 내부(config, pathGuard, paths).
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const config = require('../../lib/common/config');
const pathGuard = require('../../lib/common/pathGuard');
const paths = require('../../lib/common/paths');

const MAX_ROOTS = config.LIMITS.maxScanRoots; // 64
const MAX_PATH_LEN = 4096;
const FILE_MODE = 0o600;

/**
 * 디렉터리 경로를 canonicalize(realpath)하고 디렉터리인지 확인한다.
 * @param {string} raw 원시 경로
 * @param {object} [deps] { fs, pathGuard } 테스트 주입용
 * @returns {string|null} 실경로(디렉터리) 또는 실패 시 null
 */
function canonicalizeDir(raw, deps) {
  const _fs = (deps && deps.fs) || fs;
  const _pg = (deps && deps.pathGuard) || pathGuard;
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_PATH_LEN) return null;
  const real = _pg.canonicalize(raw); // resolve→realpathSync.native→NFC
  if (real === null) return null;
  try {
    const st = _fs.statSync(real);
    if (!st.isDirectory()) return null;
  } catch (_) {
    return null;
  }
  return real;
}

/**
 * 시스템 폴더(드라이브 루트·%WINDIR%·%ProgramFiles%·홈 루트 등) 여부.
 * 화이트리스트에 시스템 디렉터리를 등록하면 광범위 스캔·정보노출 표면이 되므로 제외(§4.2).
 * @param {string} real canonicalize된 실경로
 * @param {object} [deps] { env, platform } 테스트 주입용
 * @returns {boolean}
 */
function isSystemDir(real, deps) {
  if (typeof real !== 'string' || !real) return true;
  const env = (deps && deps.env) || process.env;
  const platform = (deps && deps.platform) || process.platform;

  const fold = pathGuard.foldForCompare(real);

  // 드라이브 루트 / POSIX 루트 단독 제외.
  const stripped = real.replace(/[\\/]+$/, '');
  if (/^[A-Za-z]:$/.test(stripped)) return true;     // C:
  if (stripped === '' || stripped === '/') return true; // POSIX 루트

  const blocked = [];
  if (platform === 'win32') {
    const push = (v) => { if (v) blocked.push(v); };
    push(env.WINDIR);
    push(env.SystemRoot);
    push(env.ProgramFiles);
    push(env['ProgramFiles(x86)']);
    push(env.ProgramData);
    push(env.SystemDrive ? env.SystemDrive + '\\' : null);
  } else {
    blocked.push('/usr', '/bin', '/sbin', '/etc', '/var', '/boot', '/sys', '/proc', '/dev', '/Library', '/System', '/Applications');
  }

  for (const b of blocked) {
    const bk = pathGuard.foldForCompare(b);
    if (bk && fold === bk) return true;
  }
  return false;
}

/**
 * [F-5] 경로 입력 대비 채택/거부를 산출하고 config.scanRoots에 병합·영속한다.
 * @param {string[]} rawPaths 원시 경로 배열(dialog 결과 또는 직접 입력)
 * @param {string[]} currentRoots 현재 scanRoots(canonicalize된 실경로)
 * @param {object} ctx { logger, config, configPath?, deps? }
 * @returns {{ok:true,added:string[],rejected:Array<{path,reason}>,roots:string[]} | {ok:false,code:'INVALID_PATH'}}
 */
function addRootsResolve(rawPaths, currentRoots, ctx) {
  if (!Array.isArray(rawPaths)) return { ok: false, code: 'INVALID_PATH' };
  ctx = ctx || {};
  const logger = ctx.logger;
  const deps = ctx.deps;
  const current = Array.isArray(currentRoots) ? currentRoots.slice() : [];

  const added = [];
  const rejected = [];
  for (const raw of rawPaths.slice(0, MAX_ROOTS)) {
    if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_PATH_LEN) {
      rejected.push({ path: String(raw).slice(0, 256), reason: 'NOT_FOUND' });
      continue;
    }
    const real = canonicalizeDir(raw, deps);
    if (!real) { rejected.push({ path: raw, reason: 'NOT_FOUND' }); continue; }
    if (isSystemDir(real, deps)) { rejected.push({ path: raw, reason: 'SYSTEM_DIR' }); continue; }
    if (current.includes(real) || added.includes(real)) { rejected.push({ path: raw, reason: 'DUP' }); continue; }
    added.push(real);
  }

  // 최종 영속: normalizeScanRoots로 한 번 더 통과(단일 화이트리스트 원천 유지, F-5).
  const roots = config.normalizeScanRoots([...current, ...added], logger);
  persistScanRoots(roots, ctx);

  return { ok: true, added, rejected, roots };
}

/**
 * [§4.2] removeRoot — 입력 path를 canonicalize해 현재 scanRoots와 정확 일치하는 항목만 제거.
 * @param {string} rawPath
 * @param {string[]} currentRoots
 * @param {object} ctx { logger, config, configPath?, deps? }
 * @returns {{ok:true,roots:string[]} | {ok:false,code:'NOT_FOUND'|'INVALID_PATH'}}
 */
function removeRootResolve(rawPath, currentRoots, ctx) {
  ctx = ctx || {};
  if (typeof rawPath !== 'string' || rawPath.length === 0 || rawPath.length > MAX_PATH_LEN) {
    return { ok: false, code: 'INVALID_PATH' };
  }
  const current = Array.isArray(currentRoots) ? currentRoots.slice() : [];
  const _pg = (ctx.deps && ctx.deps.pathGuard) || pathGuard;

  // 입력을 canonicalize. 실패 시 폴드 키로 직접 비교(이미 소멸한 루트도 제거 가능하게).
  const real = _pg.canonicalize(rawPath);
  const reqKey = real ? _pg.foldForCompare(real) : _pg.foldForCompare(path.resolve(rawPath));

  let matched = false;
  const roots = [];
  for (const r of current) {
    if (!matched && _pg.foldForCompare(r) === reqKey) { matched = true; continue; }
    roots.push(r);
  }
  if (!matched) return { ok: false, code: 'NOT_FOUND' };

  persistScanRoots(roots, ctx);
  return { ok: true, roots };
}

/**
 * config.scanRoots를 spip.config.json에 원자적 0600 쓰기로 영속한다(M-2).
 * 기존 파일 내용을 보존하고 scanRoots만 갱신(다른 설정 키 유실 방지).
 * serializer의 임시파일→fsync→rename 패턴을 재사용한다.
 * @param {string[]} roots
 * @param {object} ctx { logger, configPath?, deps? }
 */
function persistScanRoots(roots, ctx) {
  ctx = ctx || {};
  const _fs = (ctx.deps && ctx.deps.fs) || fs;
  const _paths = (ctx.deps && ctx.deps.paths) || paths;
  const cfgPath = ctx.configPath || _paths.configPath();
  const logger = ctx.logger;

  // 기존 설정 보존 병합. 읽기 실패/부재면 빈 객체에서 시작.
  let existing = {};
  try {
    const raw = _fs.readFileSync(cfgPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) existing = parsed;
  } catch (_) { /* 부재/손상 — 빈 객체로 시작 */ }

  existing.scanRoots = roots;
  const body = JSON.stringify(existing, null, 2);

  const dir = _paths.ensureDirFor(cfgPath); // 0700 보장(M-2)
  const tmp = path.join(dir, '.' + path.basename(cfgPath) + '.' + process.pid + '.' + Date.now() + '.tmp');

  let fd;
  try {
    fd = _fs.openSync(tmp, 'wx', FILE_MODE);
    _fs.writeFileSync(fd, body, { encoding: 'utf8' });
    try { _fs.fsyncSync(fd); } catch (_) { /* fsync 미지원 무시 */ }
    _fs.closeSync(fd);
    fd = undefined;
    try { _fs.chmodSync(tmp, FILE_MODE); } catch (_) { /* noop */ }
    _fs.renameSync(tmp, cfgPath);
    try { _fs.chmodSync(cfgPath, FILE_MODE); } catch (_) { /* noop */ }
  } catch (err) {
    if (fd !== undefined) { try { _fs.closeSync(fd); } catch (_) { /* noop */ } }
    try { if (_fs.existsSync(tmp)) _fs.unlinkSync(tmp); } catch (_) { /* noop */ }
    if (logger) logger.error('config 영속화 실패', err);
    throw err;
  }
}

// ───── IPC 핸들러(Electron API 사용 — register.js에서 dialog 주입) ─────

/**
 * spip:addRoots(paths) 핸들러. ctx에서 현재 roots를 읽어 addRootsResolve 위임.
 * @param {object} args { paths }
 * @param {object} ctx { config, logger, configPath? }
 */
function addRoots(args, ctx) {
  const paths_ = (args && typeof args === 'object') ? args.paths : undefined;
  const current = (ctx.config && Array.isArray(ctx.config.scanRoots)) ? ctx.config.scanRoots : [];
  const result = addRootsResolve(paths_, current, ctx);
  if (result.ok) syncConfig(ctx, result.roots);
  return result;
}

/**
 * spip:removeRoot(path) 핸들러.
 * @param {object} args { path }
 * @param {object} ctx { config, logger, configPath? }
 */
function removeRoot(args, ctx) {
  const p = (args && typeof args === 'object') ? args.path : undefined;
  const current = (ctx.config && Array.isArray(ctx.config.scanRoots)) ? ctx.config.scanRoots : [];
  const result = removeRootResolve(p, current, ctx);
  if (result.ok) syncConfig(ctx, result.roots);
  return result;
}

/**
 * spip:pickFolders 핸들러. dialog는 ctx.dialog/ctx.win으로 주입(헤드리스 테스트 가능).
 * @param {object} ctx { dialog, win, config, logger, configPath? }
 * @returns {Promise<{ok:true,added,roots} | {ok:false,code:'CANCELLED'}>}
 */
async function pickFolders(ctx) {
  const dialog = ctx && ctx.dialog;
  if (!dialog || typeof dialog.showOpenDialog !== 'function') {
    return { ok: false, code: 'CANCELLED' };
  }
  const res = await dialog.showOpenDialog(ctx.win, {
    title: '스캔할 프로젝트 폴더 선택',
    properties: ['openDirectory', 'multiSelections'],
  });
  if (!res || res.canceled || !Array.isArray(res.filePaths) || res.filePaths.length === 0) {
    return { ok: false, code: 'CANCELLED' };
  }
  const current = (ctx.config && Array.isArray(ctx.config.scanRoots)) ? ctx.config.scanRoots : [];
  const r = addRootsResolve(res.filePaths, current, ctx);
  if (r.ok) syncConfig(ctx, r.roots);
  return { ok: true, added: r.added, roots: r.roots };
}

/** ctx.config.scanRoots를 메모리에서도 갱신(다음 rescan/적재에 반영). */
function syncConfig(ctx, roots) {
  if (ctx && ctx.config && Array.isArray(roots)) ctx.config.scanRoots = roots;
}

module.exports = {
  addRoots,
  removeRoot,
  pickFolders,
  addRootsResolve,
  removeRootResolve,
  canonicalizeDir,
  isSystemDir,
  persistScanRoots,
  MAX_ROOTS,
  MAX_PATH_LEN,
};
