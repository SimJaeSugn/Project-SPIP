'use strict';
/**
 * lib/common/config.js — 설정 로드·병합·검증 (R-04, R-07, L-2, §8.2, ADR-003)
 *
 * 로드 순서(우선순위 높은 순): CLI 인자 → 설정 파일 → 내장 기본값.
 * 잘못된 값은 경고 후 기본값으로 폴백한다(견고성, N-05).
 *
 * [L-2] scanRoots는 화이트리스트 원천이므로 H-1과 일관되게 절대경로 realpath
 *   정규화·타입/존재 검증 후 채택한다. excludes는 패턴 길이·개수 상한을 적용한다.
 * [L-2] 설정 파일 경로 realpath 검증 골격을 둔다(심링크 경유 위장 차단 토대).
 *
 * scanRoots가 비면 자동 스캔하지 않고 안내 후 종료한다(확정 결정, R-04).
 * 본 모듈은 병합·검증만 책임지고, 안내 후 종료 흐름은 scan.js(S3)가 수행한다.
 *
 * 외부 의존성 0 — fs, path만 사용. paths/logger는 내부 모듈.
 */

const fs = require('fs');
const path = require('path');
const paths = require('./paths');
const { defaultLogger } = require('./logger');
const toolRegistry = require('./toolRegistry');

const FILE_MODE = 0o600;

// 내장 기본값 (§8.2)
const DEFAULTS = Object.freeze({
  scanRoots: [],
  excludes: [], // 내장 제외 규칙은 excludeRules(S1)가 보유. 여기는 사용자 추가분.
  // 프로젝트 인식 기준(시그널) — 디렉터리에 이 중 하나라도 있으면 프로젝트로 본다.
  //   항목은 정확한 이름(package.json), 확장자 글로브(*.csproj), 정규식(/.../) 중 하나.
  //   미설정(키 없음) 시 아래 기본값이 시드로 적용되고, 사용자가 추가/삭제/기본값 복원할 수 있다.
  detectSignals: Object.freeze([
    '.git', 'package.json', '.vscode', '*.code-workspace',
    'pyproject.toml', 'Cargo.toml', 'go.mod', 'pom.xml', 'build.gradle',
    'composer.json', 'Gemfile', '*.csproj', '*.sln',
  ]),
  staleDays: 90,
  port: 7421, // 127.0.0.1 고정, 자동 오픈 없음
  // [M4 R-03] depthLimit — walker 유효 깊이 = clamp(depthLimit ?? 24, 1, ABS_MAX_DEPTH=64).
  //   MVP 안전상한 24는 "기본값"으로 강등되고, 절대 안전 의미는 walker의 ABS_MAX_DEPTH가 승계한다.
  depthLimit: 24,
  // [M4 R-05] all-drives는 opt-in 게이트(기본 false). 본문만으로는 켤 수 없다(actionHandlers 강등).
  allowAllDrives: false,
  // [M4 R-09] size 수집(opt-in). enabled=false면 기본 스캔 성능 영향 0.
  size: Object.freeze({
    enabled: false,    // size 용량 측정 활성화(deps/devDeps는 enabled와 무관하게 항상 수집)
    budgetMs: 1500,    // 프로젝트당 측정 시간 상한(H-3) — 초과 시 partial
    maxDepth: 6,       // 측정 순회 깊이 상한 — 초과 절단 시 partial
    maxEntries: 50000, // 누계 stat 호출 상한 — 초과 시 partial
    deepNodeModules: false, // true면 node_modules 전체 순회(기본 top-level 근사)
  }),
  // [M4 R-16/R-03/R-05] 스캔 전역 자원/데드락 가드.
  scan: Object.freeze({
    watchdogMs: 10 * 60 * 1000, // 백그라운드 스캔 데드락 방지 절대 상한(M4-M-3)
    maxDirs: 2000000,           // walker 전역 순회 디렉터리 상한(M4-M-2)
    timeBudgetMs: 5 * 60 * 1000,// walker 전역 시간 예산(M4-M-2)
  }),
  // [M6 R-18] 외부 툴 레지스트리(tools:{<id>:{path,label}}). 기본 빈 맵. args 필드 없음(M6-H-2).
  tools: Object.freeze({}),
});

// L-2 상한값(거대/악성 glob·경로 폭발 방어)
const LIMITS = Object.freeze({
  maxExcludes: 200,
  maxExcludePatternLen: 256,
  maxDetectSignals: 100,
  maxScanRoots: 64,
  // [M6 R-18] 툴 레지스트리 항목 수 상한(toolRegistry와 동일 값 — 단일 원천은 toolRegistry).
  maxTools: toolRegistry.MAX_TOOLS,
});

/**
 * 설정 파일을 읽어 파싱한다. 부재/손상 시 null + 경고(폴백 신호).
 * @param {string} cfgPath 설정 파일 절대경로
 * @param {object} logger
 * @returns {object|null}
 */
function readConfigFile(cfgPath, logger) {
  let raw;
  try {
    raw = fs.readFileSync(cfgPath, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return null; // 부재는 정상(기본값 사용)
    logger.warn('설정 파일을 읽지 못해 기본값을 사용합니다', { path: cfgPath });
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    logger.warn('설정 파일 형식이 올바르지 않아 기본값을 사용합니다', { path: cfgPath });
    return null;
  } catch (_) {
    logger.warn('설정 파일 JSON 파싱에 실패해 기본값을 사용합니다', { path: cfgPath });
    return null;
  }
}

/**
 * scanRoots를 검증·정규화한다(L-2 / H-1 일관).
 * - 배열·문자열 항목만 채택
 * - 절대경로로 resolve 후 realpath 정규화(심링크 해소)
 * - 존재하지 않거나 디렉터리 아님 → 경고 후 제외
 * @returns {string[]} 정규화된 절대 realpath 배열(중복 제거)
 */
function normalizeScanRoots(input, logger) {
  if (!Array.isArray(input)) {
    if (input !== undefined) logger.warn('scanRoots가 배열이 아니어서 무시합니다');
    return [];
  }
  const out = [];
  const seen = new Set();
  for (const item of input.slice(0, LIMITS.maxScanRoots)) {
    if (typeof item !== 'string' || !item.trim()) {
      logger.warn('scanRoots 항목이 문자열이 아니어서 건너뜁니다');
      continue;
    }
    const abs = path.resolve(item);
    let real;
    try {
      real = fs.realpathSync.native ? fs.realpathSync.native(abs) : fs.realpathSync(abs);
    } catch (_) {
      logger.warn('scanRoots 경로가 존재하지 않아 건너뜁니다', { path: abs });
      continue;
    }
    let st;
    try {
      st = fs.statSync(real);
    } catch (_) {
      logger.warn('scanRoots 경로 상태 확인 실패로 건너뜁니다', { path: real });
      continue;
    }
    if (!st.isDirectory()) {
      logger.warn('scanRoots 항목이 디렉터리가 아니어서 건너뜁니다', { path: real });
      continue;
    }
    if (!seen.has(real)) {
      seen.add(real);
      out.push(real);
    }
  }
  return out;
}

/** excludes 검증(L-2: 길이·개수 상한). */
function normalizeExcludes(input, logger) {
  if (input === undefined) return [];
  if (!Array.isArray(input)) {
    logger.warn('excludes가 배열이 아니어서 무시합니다');
    return [];
  }
  const out = [];
  for (const p of input.slice(0, LIMITS.maxExcludes)) {
    if (typeof p !== 'string') continue;
    if (p.length > LIMITS.maxExcludePatternLen) {
      logger.warn('excludes 패턴이 너무 길어 건너뜁니다');
      continue;
    }
    out.push(p);
  }
  if (Array.isArray(input) && input.length > LIMITS.maxExcludes) {
    logger.warn('excludes 항목 수가 상한을 초과해 일부를 무시합니다');
  }
  return out;
}

/**
 * detectSignals 검증(L-2: 길이·개수 상한, 중복 제거, trim).
 *   미설정(undefined)·비배열 → 기본값 시드. 명시적 빈 배열([])은 그대로 유지(사용자가 전부 삭제).
 */
function normalizeDetectSignals(input, logger) {
  if (input === undefined) return DEFAULTS.detectSignals.slice();
  if (!Array.isArray(input)) {
    logger.warn('detectSignals가 배열이 아니어서 기본값을 사용합니다');
    return DEFAULTS.detectSignals.slice();
  }
  const out = [];
  for (const p of input.slice(0, LIMITS.maxDetectSignals)) {
    if (typeof p !== 'string') continue;
    const v = p.trim();
    if (!v || v.length > LIMITS.maxExcludePatternLen) continue;
    if (!out.includes(v)) out.push(v);
  }
  return out;
}

/** 양의 정수 검증 후 폴백. */
function validatePositiveNumber(val, fallback, label, logger) {
  if (val === undefined) return fallback;
  if (typeof val === 'number' && Number.isFinite(val) && val > 0) return val;
  logger.warn(label + ' 값이 올바르지 않아 기본값을 사용합니다');
  return fallback;
}

/** boolean 검증 후 폴백(M4). */
function validateBoolean(val, fallback) {
  return typeof val === 'boolean' ? val : fallback;
}

/**
 * [M4 R-09] size 설정 병합·검증. 부분 지정도 허용(미지정 키는 기본값).
 * 잘못된 값은 경고 없이 기본값으로 폴백(N-05) — opt-in 옵션이라 견고성 우선.
 */
function normalizeSize(input, logger) {
  const d = DEFAULTS.size;
  const src = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  if (input !== undefined && (typeof input !== 'object' || Array.isArray(input))) {
    logger.warn('size 설정이 객체가 아니어서 기본값을 사용합니다');
  }
  return {
    enabled: validateBoolean(src.enabled, d.enabled),
    budgetMs: validatePositiveNumber(src.budgetMs, d.budgetMs, 'size.budgetMs', logger),
    maxDepth: validatePositiveNumber(src.maxDepth, d.maxDepth, 'size.maxDepth', logger),
    maxEntries: validatePositiveNumber(src.maxEntries, d.maxEntries, 'size.maxEntries', logger),
    deepNodeModules: validateBoolean(src.deepNodeModules, d.deepNodeModules),
  };
}

/** [M4] scan(전역 자원/데드락 가드) 설정 병합·검증. */
function normalizeScan(input, logger) {
  const d = DEFAULTS.scan;
  const src = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  return {
    watchdogMs: validatePositiveNumber(src.watchdogMs, d.watchdogMs, 'scan.watchdogMs', logger),
    maxDirs: validatePositiveNumber(src.maxDirs, d.maxDirs, 'scan.maxDirs', logger),
    timeBudgetMs: validatePositiveNumber(src.timeBudgetMs, d.timeBudgetMs, 'scan.timeBudgetMs', logger),
  };
}

/**
 * 설정을 로드·병합·검증한다.
 * @param {object} [options]
 *   - cliArgs: object  CLI에서 파싱된 부분 설정(최우선)
 *   - configPath: string  설정 파일 경로(기본 paths.configPath())
 *   - logger: Logger
 * @returns {{ config: object, sourcePath: string, fileExisted: boolean }}
 */
function loadConfig(options) {
  options = options || {};
  const logger = options.logger || defaultLogger;
  const cfgPath = options.configPath || paths.configPath();
  const cliArgs = options.cliArgs && typeof options.cliArgs === 'object' ? options.cliArgs : {};

  const fileCfg = readConfigFile(cfgPath, logger) || {};
  const fileExisted = fs.existsSync(cfgPath);

  // 병합: 기본값 ← 파일 ← CLI (뒤가 우선)
  const merged = Object.assign({}, DEFAULTS, fileCfg, cliArgs);

  const config = {
    scanRoots: normalizeScanRoots(merged.scanRoots, logger),
    excludes: normalizeExcludes(merged.excludes, logger),
    detectSignals: normalizeDetectSignals(merged.detectSignals, logger),
    staleDays: validatePositiveNumber(merged.staleDays, DEFAULTS.staleDays, 'staleDays', logger),
    port: validatePositiveNumber(merged.port, DEFAULTS.port, 'port', logger),
    // [M4 R-03] depthLimit — 양의 정수만, 기본 24. 절대 상한 clamp는 walker가 강제(약화 금지).
    depthLimit: validatePositiveNumber(merged.depthLimit, DEFAULTS.depthLimit, 'depthLimit', logger),
    // [M4 R-05] all-drives opt-in 게이트(기본 false).
    allowAllDrives: validateBoolean(merged.allowAllDrives, DEFAULTS.allowAllDrives),
    // [M4 R-09] size 수집 설정.
    size: normalizeSize(merged.size, logger),
    // [M4] 스캔 전역 가드.
    scan: normalizeScan(merged.scan, logger),
    // [M6 R-18] 툴 레지스트리 — toolRegistry.normalizeTools(args drop·known id 화이트리스트·label sanitize).
    tools: toolRegistry.normalizeTools(merged.tools),
  };

  return { config, sourcePath: cfgPath, fileExisted };
}

/**
 * config의 일부 키만 부분 갱신해 0600 원자적 쓰기로 영속한다(P2-1).
 * 기존 파일 내용을 read-merge로 보존하고 patch 키만 덮어쓴다(타 키 유실 방지).
 * 임시파일→fsync→rename→0600 패턴(folders.persistScanRoots에서 일반화).
 *
 * @param {object} patch 갱신할 키만(예 {tools}, {scanRoots})
 * @param {object} [ctx] { logger, configPath?, deps?{fs,paths} }
 */
function persistConfigKeys(patch, ctx) {
  ctx = ctx || {};
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new Error('persistConfigKeys: patch must be a plain object');
  }
  const _fs = (ctx.deps && ctx.deps.fs) || fs;
  const _paths = (ctx.deps && ctx.deps.paths) || paths;
  const cfgPath = ctx.configPath || _paths.configPath();
  const logger = ctx.logger;

  // 기존 설정 read-merge(부재/손상 → 빈 객체).
  let existing = {};
  try {
    const raw = _fs.readFileSync(cfgPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) existing = parsed;
  } catch (_) { /* 부재/손상 — 빈 객체로 시작 */ }

  Object.assign(existing, patch); // 기존 키 보존 병합
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
    if (logger) logger.error('config 부분 갱신 영속화 실패', err);
    throw err;
  }
}

/**
 * 기본 설정 파일을 생성한다(부재 시 안내용 스캐폴드).
 * 디렉터리는 paths.ensureDirFor로 소유자 전용 권한 생성(M-2 토대).
 * 파일 권한 0600은 serializer(S3)와 동일 정책으로 적용.
 * @param {string} [cfgPath]
 * @returns {string} 생성된 경로
 */
function writeDefaultConfig(cfgPath) {
  cfgPath = cfgPath || paths.configPath();
  paths.ensureDirFor(cfgPath);
  const body = JSON.stringify(
    {
      scanRoots: [],
      excludes: [],
      staleDays: DEFAULTS.staleDays,
      port: DEFAULTS.port,
    },
    null,
    2
  );
  fs.writeFileSync(cfgPath, body, { mode: 0o600 });
  return cfgPath;
}

module.exports = {
  loadConfig,
  writeDefaultConfig,
  persistConfigKeys,
  normalizeScanRoots,
  normalizeExcludes,
  normalizeDetectSignals,
  normalizeSize,
  normalizeScan,
  validateBoolean,
  readConfigFile,
  DEFAULTS,
  LIMITS,
  FILE_MODE,
};
