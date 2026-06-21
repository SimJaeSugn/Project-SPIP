'use strict';
/**
 * ipc-folders.test.js — electron/ipc/folders.js (헤드리스 검증, F-3/F-5)
 * addRootsResolve 채택/거부·시스템폴더 제외·removeRoot·persist·pickFolders(dialog 모킹).
 * 실제 tmp 디렉터리로 canonicalize/realpath를 검증한다.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const folders = require('../electron/ipc/folders');
const { Logger } = require('../lib/common/logger');
const pathGuard = require('../lib/common/pathGuard');

function quiet() { return new Logger({ quiet: true }); }
function tmpDir() { return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'spip-fld-'))); }

test('addRootsResolve — paths 배열 아니면 INVALID_PATH', () => {
  const r = folders.addRootsResolve('notarray', [], { logger: quiet(), configPath: path.join(tmpDir(), 'c.json') });
  assert.deepStrictEqual(r, { ok: false, code: 'INVALID_PATH' });
});

test('addRootsResolve — 유효 디렉터리 채택 + config 영속(0600)', () => {
  const base = tmpDir();
  const proj = path.join(base, 'proj');
  fs.mkdirSync(proj);
  const cfgPath = path.join(base, 'config', 'spip.config.json');

  const r = folders.addRootsResolve([proj], [], { logger: quiet(), configPath: cfgPath });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.added.length, 1);
  assert.strictEqual(r.rejected.length, 0);
  assert.ok(r.roots.some((x) => pathGuard.foldForCompare(x) === pathGuard.foldForCompare(proj)));

  // 영속 확인.
  const persisted = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  assert.ok(Array.isArray(persisted.scanRoots));
  assert.strictEqual(persisted.scanRoots.length, 1);
});

test('addRootsResolve — 존재하지 않는 경로 NOT_FOUND', () => {
  const base = tmpDir();
  const cfgPath = path.join(base, 'c.json');
  const r = folders.addRootsResolve([path.join(base, 'nope')], [], { logger: quiet(), configPath: cfgPath });
  assert.strictEqual(r.added.length, 0);
  assert.strictEqual(r.rejected[0].reason, 'NOT_FOUND');
});

test('addRootsResolve — 파일(디렉터리 아님)은 NOT_FOUND', () => {
  const base = tmpDir();
  const file = path.join(base, 'f.txt');
  fs.writeFileSync(file, 'x');
  const r = folders.addRootsResolve([file], [], { logger: quiet(), configPath: path.join(base, 'c.json') });
  assert.strictEqual(r.rejected[0].reason, 'NOT_FOUND');
});

test('addRootsResolve — 중복(현재 roots/입력 내) DUP', () => {
  const base = tmpDir();
  const proj = path.join(base, 'proj');
  fs.mkdirSync(proj);
  const real = pathGuard.canonicalize(proj);
  const r = folders.addRootsResolve([proj, proj], [real], { logger: quiet(), configPath: path.join(base, 'c.json') });
  assert.strictEqual(r.added.length, 0);
  assert.ok(r.rejected.every((x) => x.reason === 'DUP'));
});

test('addRootsResolve — 거부 reason은 고정 토큰만', () => {
  const base = tmpDir();
  const r = folders.addRootsResolve([path.join(base, 'nope'), 123], [], { logger: quiet(), configPath: path.join(base, 'c.json') });
  for (const rej of r.rejected) {
    assert.ok(['NOT_FOUND', 'NOT_DIR', 'SYSTEM_DIR', 'DUP'].includes(rej.reason));
  }
});

test('addRootsResolve — 개수 상한(MAX_ROOTS) 초과분 절단', () => {
  const base = tmpDir();
  const many = [];
  for (let i = 0; i < folders.MAX_ROOTS + 10; i++) many.push(path.join(base, 'd' + i));
  const r = folders.addRootsResolve(many, [], { logger: quiet(), configPath: path.join(base, 'c.json') });
  // 처리된 항목(added+rejected)이 MAX_ROOTS 이하.
  assert.ok(r.added.length + r.rejected.length <= folders.MAX_ROOTS);
});

test('isSystemDir — 드라이브 루트/POSIX 루트 제외', () => {
  assert.strictEqual(folders.isSystemDir('C:\\', { platform: 'win32', env: {} }), true);
  assert.strictEqual(folders.isSystemDir('C:', { platform: 'win32', env: {} }), true);
  assert.strictEqual(folders.isSystemDir('/', { platform: 'linux', env: {} }), true);
  assert.strictEqual(folders.isSystemDir('', { platform: 'linux', env: {} }), true);
});

test('isSystemDir — WINDIR/ProgramFiles 제외', () => {
  const env = { WINDIR: 'C:\\Windows', ProgramFiles: 'C:\\Program Files' };
  assert.strictEqual(folders.isSystemDir('C:\\Windows', { platform: 'win32', env }), true);
  assert.strictEqual(folders.isSystemDir('C:\\Program Files', { platform: 'win32', env }), true);
  assert.strictEqual(folders.isSystemDir('C:\\Users\\me\\proj', { platform: 'win32', env }), false);
});

test('isSystemDir — POSIX 시스템 경로 제외, 일반 경로 허용', () => {
  assert.strictEqual(folders.isSystemDir('/usr', { platform: 'linux', env: {} }), true);
  assert.strictEqual(folders.isSystemDir('/etc', { platform: 'linux', env: {} }), true);
  assert.strictEqual(folders.isSystemDir('/home/me/proj', { platform: 'linux', env: {} }), false);
});

test('removeRootResolve — 정확 일치 항목만 제거', () => {
  const base = tmpDir();
  const a = path.join(base, 'a'); const b = path.join(base, 'b');
  fs.mkdirSync(a); fs.mkdirSync(b);
  const ra = pathGuard.canonicalize(a); const rb = pathGuard.canonicalize(b);
  const cfgPath = path.join(base, 'c.json');
  const r = folders.removeRootResolve(a, [ra, rb], { logger: quiet(), configPath: cfgPath });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.roots.length, 1);
  assert.strictEqual(pathGuard.foldForCompare(r.roots[0]), pathGuard.foldForCompare(rb));
});

test('removeRootResolve — 일치 없음 NOT_FOUND', () => {
  const base = tmpDir();
  const a = path.join(base, 'a'); fs.mkdirSync(a);
  const ra = pathGuard.canonicalize(a);
  const r = folders.removeRootResolve(path.join(base, 'zzz'), [ra], { logger: quiet(), configPath: path.join(base, 'c.json') });
  assert.deepStrictEqual(r, { ok: false, code: 'NOT_FOUND' });
});

test('removeRootResolve — 빈/과대 path INVALID_PATH', () => {
  const r = folders.removeRootResolve('', [], { logger: quiet() });
  assert.deepStrictEqual(r, { ok: false, code: 'INVALID_PATH' });
  const r2 = folders.removeRootResolve('x'.repeat(5000), [], { logger: quiet() });
  assert.deepStrictEqual(r2, { ok: false, code: 'INVALID_PATH' });
});

test('persistScanRoots — 기존 설정 키 보존', () => {
  const base = tmpDir();
  const cfgPath = path.join(base, 'config', 'c.json');
  folders.persistScanRoots([], { logger: quiet(), configPath: cfgPath });
  // 기존 파일에 port 등 다른 키 추가.
  let cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  cfg.port = 7421; cfg.staleDays = 30;
  fs.writeFileSync(cfgPath, JSON.stringify(cfg));
  // scanRoots 갱신 시 다른 키 보존.
  folders.persistScanRoots(['/proj/x'], { logger: quiet(), configPath: cfgPath });
  const after = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  assert.deepStrictEqual(after.scanRoots, ['/proj/x']);
  assert.strictEqual(after.port, 7421);
  assert.strictEqual(after.staleDays, 30);
});

test('addRoots 핸들러 — ctx.config.scanRoots 메모리 동기화', () => {
  const base = tmpDir();
  const proj = path.join(base, 'p'); fs.mkdirSync(proj);
  const ctx = { config: { scanRoots: [] }, logger: quiet(), configPath: path.join(base, 'c.json') };
  const r = folders.addRoots({ paths: [proj] }, ctx);
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(ctx.config.scanRoots, r.roots);
});

test('pickFolders — dialog 취소 시 CANCELLED', async () => {
  const ctx = { config: { scanRoots: [] }, logger: quiet(), dialog: { showOpenDialog: () => Promise.resolve({ canceled: true, filePaths: [] }) } };
  const r = await folders.pickFolders(ctx);
  assert.deepStrictEqual(r, { ok: false, code: 'CANCELLED' });
});

test('pickFolders — dialog 결과를 addRootsResolve로 영속', async () => {
  const base = tmpDir();
  const proj = path.join(base, 'p'); fs.mkdirSync(proj);
  const ctx = {
    config: { scanRoots: [] }, logger: quiet(), configPath: path.join(base, 'c.json'),
    dialog: { showOpenDialog: () => Promise.resolve({ canceled: false, filePaths: [proj] }) },
  };
  const r = await folders.pickFolders(ctx);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.added.length, 1);
  assert.deepStrictEqual(ctx.config.scanRoots, r.roots);
});

test('pickFolders — dialog 미주입 시 CANCELLED(안전)', async () => {
  const r = await folders.pickFolders({ config: { scanRoots: [] } });
  assert.deepStrictEqual(r, { ok: false, code: 'CANCELLED' });
});
