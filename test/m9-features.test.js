'use strict';
/**
 * m9-features.test.js — 사용자 요청 기능(#4 제외 항목 / #5 드라이브 선택) 백엔드 검증.
 *   · excludeRules: 이름형/절대경로형 분류 + buildExcludeSet + isUnderExcludedPath(세그먼트 매칭).
 *   · folders: addExcludesResolve/removeExcludeResolve(영속) + listDrivesResolve/addDrivesResolve.
 *   · actions.rescan: 드라이브 루트 포함 시 보호장치(allDrives) 자동 적용.
 * 실제 tmp 디렉터리로 canonicalize/realpath를 검증한다(F-3 헤드리스).
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const excludeRules = require('../lib/scan/excludeRules');
const folders = require('../electron/ipc/folders');
const actions = require('../electron/ipc/actions');
const pathGuard = require('../lib/common/pathGuard');
const { Logger } = require('../lib/common/logger');

function quiet() { return new Logger({ quiet: true }); }
function tmpDir() { return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'spip-m9-'))); }

/* ───── #4 excludeRules ───── */

test('isPathLikeExclude — 구분자/드라이브 접두면 경로형, 단순 토큰이면 이름형', () => {
  assert.strictEqual(excludeRules.isPathLikeExclude('temp'), false);
  assert.strictEqual(excludeRules.isPathLikeExclude('node_modules'), false);
  assert.strictEqual(excludeRules.isPathLikeExclude('E:\\projects\\old'), true);
  assert.strictEqual(excludeRules.isPathLikeExclude('/usr/local'), true);
  assert.strictEqual(excludeRules.isPathLikeExclude('a/b'), true);
  assert.strictEqual(excludeRules.isPathLikeExclude('C:'), true);
});

test('buildExcludeSet — 이름형은 set(소문자), 경로형은 pathKeys로 분리', () => {
  const r = excludeRules.buildExcludeSet(['Temp', 'E:\\old']);
  assert.ok(r.set.has('temp'));            // 이름형(소문자 폴드)
  assert.ok(r.set.has('node_modules'));    // 내장 규칙 유지
  assert.strictEqual(r.pathKeys.size, 1);  // 경로형 1건
});

test('isUnderExcludedPath — 세그먼트 단위 매칭(접두 부분일치 오판 차단)', () => {
  const base = tmpDir();
  const excl = path.join(base, 'old');
  const child = path.join(excl, 'sub');
  const sibling = path.join(base, 'older'); // 'old'의 접두 부분일치 함정
  fs.mkdirSync(child, { recursive: true });
  fs.mkdirSync(sibling, { recursive: true });

  const set = excludeRules.buildExcludeSet([excl]);
  assert.strictEqual(excludeRules.isUnderExcludedPath(pathGuard.canonicalize(excl), set), true);   // 자신
  assert.strictEqual(excludeRules.isUnderExcludedPath(pathGuard.canonicalize(child), set), true);  // 하위
  assert.strictEqual(excludeRules.isUnderExcludedPath(pathGuard.canonicalize(sibling), set), false); // 형제(older)
});

/* ───── #4 folders 제외 항목 IPC ───── */

test('addExcludesResolve — 이름+경로 채택, 중복 거부, config.excludes 영속', () => {
  const base = tmpDir();
  const cfgPath = path.join(base, 'config', 'spip.config.json');
  const r = folders.addExcludesResolve(['temp', 'E:\\old', 'temp'], [], { logger: quiet(), configPath: cfgPath });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.added, ['temp', 'E:\\old']); // 둘째 temp는 DUP
  assert.ok(r.rejected.some((x) => x.reason === 'DUP'));
  assert.deepStrictEqual(r.excludes, ['temp', 'E:\\old']);
  const persisted = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  assert.deepStrictEqual(persisted.excludes, ['temp', 'E:\\old']);
});

test('addExcludesResolve — 빈/비문자열 거부, 비배열 INVALID', () => {
  const base = tmpDir();
  const cfgPath = path.join(base, 'c.json');
  const r = folders.addExcludesResolve(['', '   ', 123], [], { logger: quiet(), configPath: cfgPath });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.added.length, 0);
  assert.deepStrictEqual(folders.addExcludesResolve('notarray', [], { logger: quiet() }), { ok: false, code: 'INVALID' });
});

test('removeExcludeResolve — 정확 일치 1건 제거, 미존재는 NOT_FOUND', () => {
  const base = tmpDir();
  const cfgPath = path.join(base, 'c.json');
  const r = folders.removeExcludeResolve('temp', ['temp', 'E:\\old'], { logger: quiet(), configPath: cfgPath });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.excludes, ['E:\\old']);
  const r2 = folders.removeExcludeResolve('nope', ['E:\\old'], { logger: quiet(), configPath: cfgPath });
  assert.deepStrictEqual(r2, { ok: false, code: 'NOT_FOUND' });
});

/* ───── #5 폴더 선택에서 드라이브 루트 허용 (별도 기능 아님) ───── */

test('isSystemDir — 명명된 시스템 폴더는 계속 차단', () => {
  const env = { WINDIR: 'C:\\Windows', ProgramFiles: 'C:\\Program Files' };
  assert.strictEqual(folders.isSystemDir('C:\\Windows', { platform: 'win32', env }), true);
  assert.strictEqual(folders.isSystemDir('/usr', { platform: 'linux', env: {} }), true);
});

test('addRootsResolve — 명명된 시스템 폴더(C:\\Windows)는 SYSTEM_DIR로 거부', () => {
  const base = tmpDir();
  // 실존하는 "시스템 폴더처럼 취급될" 경로를 deps.env로 주입해 검증(실제 Windows 불요).
  const sys = path.join(base, 'sysish');
  fs.mkdirSync(sys);
  const real = pathGuard.canonicalize(sys);
  const r = folders.addRootsResolve([sys], [], {
    logger: quiet(), configPath: path.join(base, 'c.json'),
    deps: { env: { WINDIR: real }, platform: 'win32' }, // 결정적: WINDIR로 주입한 경로를 시스템 폴더로 취급
  });
  assert.strictEqual(r.added.length, 0);
  assert.strictEqual(r.rejected[0].reason, 'SYSTEM_DIR'); // 드라이브 루트 아님 → 여전히 차단
});

// 드라이브 루트는 폴더 선택에서 그대로 채택된다(실 드라이브가 있는 win32에서 검증).
test('addRootsResolve — 드라이브 루트(C:\\)는 폴더 선택에서 채택(win32)', { skip: process.platform !== 'win32' }, () => {
  const base = tmpDir();
  const real = pathGuard.canonicalize('C:\\');
  const r = folders.addRootsResolve(['C:\\'], [], { logger: quiet(), configPath: path.join(base, 'c.json') });
  assert.strictEqual(r.added.length, 1); // isSystemDir(C:)=true 지만 isDriveRoot 예외로 채택
  assert.ok(r.roots.some((x) => pathGuard.foldForCompare(x) === pathGuard.foldForCompare(real)));
});

test('isDriveRoot — 드라이브/ POSIX 루트만 true', () => {
  assert.strictEqual(folders.isDriveRoot('C:\\'), true);
  assert.strictEqual(folders.isDriveRoot('C:'), true);
  assert.strictEqual(folders.isDriveRoot('/'), true);
  assert.strictEqual(folders.isDriveRoot('C:\\Users'), false);
  assert.strictEqual(folders.isDriveRoot('/home/me'), false);
});

/* ───── #5 actions.rescan 보호장치 ───── */

function fakeController() {
  return {
    _started: null,
    status: () => ({ scanId: 'sid', phase: 'idle' }),
    acquire: () => ({ scanId: 's', startedAt: 'T' }),
    start: function (o) { this._started = o; },
  };
}

test('rescan — 스캔 루트에 드라이브 루트(C:\\) 포함 시 allDrives 보호 자동 적용', () => {
  const c = fakeController();
  const r = actions.rescan({}, {
    scanController: c,
    config: { scanRoots: ['C:\\'], allowAllDrives: false }, // all-drives 게이트는 꺼져 있어도
    store: {},
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(c._started.allDrives, true);            // 드라이브 루트 → 보호 켜짐
  assert.deepStrictEqual(c._started.roots, ['C:\\']);        // 전체 드라이브 열거는 하지 않음
});

test('rescan — 일반 폴더 루트만이면 보호 미적용(allDrives=false)', () => {
  const c = fakeController();
  actions.rescan({}, { scanController: c, config: { scanRoots: ['/a/b'] }, store: {} });
  assert.strictEqual(c._started.allDrives, false);
});
