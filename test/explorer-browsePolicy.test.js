'use strict';
/**
 * explorer-browsePolicy.test.js — 폴더 탐색기 위젯 경로 정책 (EXP-H-1)
 *
 * 검증 대상:
 *   · pathGuard.isWithinRoot / findContainingRoot — 구분자 경계 접두 매칭(형제 디렉터리 오탐 0)
 *   · browsePolicy.sanitizeName — 경로 이탈·예약명·제어문자 차단
 *   · browsePolicy.gate — 등록 루트 밖 / 민감 경로 거부, 루트 하위 허용
 *   · browsePolicy.listDir — 정렬·truncated·개별 stat 실패 graceful
 *   · browsePolicy.parentOf / isRootItself — 루트 경계에서 위로 못 올라감(루트 삭제 보호)
 *
 * 실제 FS(임시 디렉터리)를 쓴다 — canonicalize(realpath)가 실경로를 요구하기 때문.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const pathGuard = require('../lib/common/pathGuard');
const browsePolicy = require('../lib/explorer/browsePolicy');

const IS_WIN = process.platform === 'win32';
const SEP = path.sep;

/** 임시 디렉터리 트리 생성 후 realpath 반환(심링크 해소된 실경로 기준으로 비교해야 함). */
function mkTmp(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return fs.realpathSync.native ? fs.realpathSync.native(d) : fs.realpathSync(d);
}

test('EXP-H-1: isWithinRoot는 구분자 경계로 접두 매칭한다 (형제 디렉터리 오탐 0)', () => {
  const root = IS_WIN ? 'C:\\dev' : '/srv/dev';
  const sibling = IS_WIN ? 'C:\\dev-old' : '/srv/dev-old';
  const child = root + SEP + 'proj';

  assert.strictEqual(pathGuard.isWithinRoot(root, root), true, '루트 자기 자신은 포함');
  assert.strictEqual(pathGuard.isWithinRoot(child, root), true, '하위는 포함');
  assert.strictEqual(pathGuard.isWithinRoot(sibling, root), false, '접두 문자열이 겹치는 형제는 미포함');
  assert.strictEqual(pathGuard.isWithinRoot(root, child), false, '역방향 미포함');
  assert.strictEqual(pathGuard.isWithinRoot('', root), false);
  assert.strictEqual(pathGuard.isWithinRoot(child, ''), false);
});

test('EXP-H-1: isWithinRoot는 대소문자 비민감 FS에서 폴드 비교한다', () => {
  if (!pathGuard.CASE_INSENSITIVE_FS) return; // Linux 등에서는 스킵(대소문자 민감)
  const root = IS_WIN ? 'C:\\Dev' : '/Users/x';
  const child = (IS_WIN ? 'C:\\dev' : '/users/x') + SEP + 'a';
  assert.strictEqual(pathGuard.isWithinRoot(child, root), true);
});

test('EXP-H-1: isWithinRoot는 FS 루트를 경계로 다루어 이중 구분자를 만들지 않는다', () => {
  const root = IS_WIN ? 'C:\\' : '/';
  const child = IS_WIN ? 'C:\\anything' : '/anything';
  assert.strictEqual(pathGuard.isWithinRoot(child, root), true);
});

test('EXP-H-1: findContainingRoot는 포함하는 첫 루트를 돌려주고 없으면 null', () => {
  const a = IS_WIN ? 'C:\\a' : '/a';
  const b = IS_WIN ? 'C:\\b' : '/b';
  assert.strictEqual(pathGuard.findContainingRoot(a + SEP + 'x', [b, a]), a);
  assert.strictEqual(pathGuard.findContainingRoot(IS_WIN ? 'C:\\c' : '/c', [a, b]), null);
  assert.strictEqual(pathGuard.findContainingRoot(a, null), null);
});

test('EXP-H-1: sanitizeName은 경로 이탈·예약명·제어문자를 거부한다', () => {
  const ok = ['ok.txt', '한글 이름.md', 'a-b_c.1', '.hidden'];
  for (const n of ok) assert.strictEqual(browsePolicy.sanitizeName(n), n, n + ' 는 허용');

  const bad = [
    '', '.', '..', '../etc', 'a/b', 'a\\b', 'C:x', 'a*b', 'a?b', 'a"b', 'a<b', 'a>b', 'a|b',
    'con', 'CON.txt', 'nul', 'com1', 'lpt9',
    'trailing.', 'x'.repeat(256),
    null, undefined, 42, {},
  ];
  for (const n of bad) assert.strictEqual(browsePolicy.sanitizeName(n), null, JSON.stringify(n) + ' 는 거부');

  // 제어문자(NUL·개행 등) 거부.
  assert.strictEqual(browsePolicy.sanitizeName('a\u0000b'), null);
  assert.strictEqual(browsePolicy.sanitizeName('a\nb'), null);
  // trim 후 판정 — 앞뒤 공백은 제거되고 남은 이름이 유효하면 허용.
  assert.strictEqual(browsePolicy.sanitizeName('  ok  '), 'ok');
});

test('EXP-H-1: gate는 등록 루트 하위만 허용하고 밖/미등록은 PATH_NOT_ALLOWED', () => {
  const root = mkTmp('spip-exp-root-');
  const outside = mkTmp('spip-exp-out-');
  const child = path.join(root, 'sub');
  fs.mkdirSync(child);

  try {
    const inside = browsePolicy.gate(child, [root]);
    assert.strictEqual(inside.ok, true);
    assert.strictEqual(inside.real, child);
    assert.strictEqual(inside.root, root);

    assert.deepStrictEqual(browsePolicy.gate(outside, [root]), { ok: false, code: 'PATH_NOT_ALLOWED' });
    assert.deepStrictEqual(browsePolicy.gate(root, []), { ok: false, code: 'PATH_NOT_ALLOWED' });

    // 존재하지 않는 경로 → canonicalize 실패 → PATH_GONE
    assert.deepStrictEqual(browsePolicy.gate(path.join(root, 'nope'), [root]), { ok: false, code: 'PATH_GONE' });

    // 입력 형태 방어.
    assert.deepStrictEqual(browsePolicy.gate('', [root]), { ok: false, code: 'BAD_INPUT' });
    assert.deepStrictEqual(browsePolicy.gate(null, [root]), { ok: false, code: 'BAD_INPUT' });
    assert.deepStrictEqual(browsePolicy.gate('x'.repeat(5000), [root]), { ok: false, code: 'BAD_INPUT' });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('EXP-H-1: gate는 루트 안이라도 민감/시스템 경로는 PATH_DENIED (deny 게이트 우선)', () => {
  // 홈 디렉터리를 루트로 등록했다고 가정하면, ~/.ssh 는 등록 루트 하위이지만 거부돼야 한다.
  const home = pathGuard.canonicalize(os.homedir());
  if (!home) return; // 홈 해소 불가 환경 스킵
  const ssh = path.join(home, '.ssh');
  if (!fs.existsSync(ssh)) return; // .ssh 없는 환경 스킵(정책 자체는 pathPolicy 테스트가 커버)
  const r = browsePolicy.gate(ssh, [home]);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 'PATH_DENIED');
});

test('EXP-H-1: gateRoot는 파일/부재 경로를 거부하고 디렉터리만 통과', () => {
  const root = mkTmp('spip-exp-groot-');
  const file = path.join(root, 'f.txt');
  fs.writeFileSync(file, 'x');
  try {
    const okRoot = browsePolicy.gateRoot(root);
    assert.strictEqual(okRoot.ok, true);
    assert.strictEqual(okRoot.real, root);

    assert.deepStrictEqual(browsePolicy.gateRoot(file), { ok: false, code: 'NOT_DIR' });
    assert.deepStrictEqual(browsePolicy.gateRoot(path.join(root, 'nope')), { ok: false, code: 'PATH_GONE' });
    assert.deepStrictEqual(browsePolicy.gateRoot(123), { ok: false, code: 'BAD_INPUT' });

    // 드라이브/FS 루트는 pathPolicy deny — 열람 루트로 등록 불가(하위 시스템 폴더 우회 차단).
    const fsRoot = IS_WIN ? path.parse(root).root : '/';
    assert.strictEqual(browsePolicy.gateRoot(fsRoot).ok, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('EXP-H-1: isRootItself / parentOf — 루트 경계에서 위로 못 올라간다', () => {
  const root = mkTmp('spip-exp-parent-');
  const child = path.join(root, 'a');
  fs.mkdirSync(child);
  try {
    assert.strictEqual(browsePolicy.isRootItself(root, [root]), true);
    assert.strictEqual(browsePolicy.isRootItself(child, [root]), false);
    assert.strictEqual(browsePolicy.parentOf(root, [root]), null, '루트에서는 상위 이동 불가');
    assert.strictEqual(browsePolicy.parentOf(child, [root]), root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('EXP-H-1: listDir — 폴더 우선 정렬 + 메타 수집 + 에러 코드', () => {
  const root = mkTmp('spip-exp-list-');
  fs.mkdirSync(path.join(root, 'zdir'));
  fs.mkdirSync(path.join(root, 'adir'));
  fs.writeFileSync(path.join(root, 'b.txt'), 'hello');
  fs.writeFileSync(path.join(root, 'a.txt'), 'hi');
  try {
    const r = browsePolicy.listDir(root);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.truncated, false);
    assert.strictEqual(r.total, 4);
    assert.deepStrictEqual(r.entries.map((e) => e.name), ['adir', 'zdir', 'a.txt', 'b.txt']);
    assert.deepStrictEqual(r.entries.map((e) => e.kind), ['dir', 'dir', 'file', 'file']);
    const b = r.entries.find((e) => e.name === 'b.txt');
    assert.strictEqual(b.size, 5);
    assert.ok(typeof b.mtime === 'number' && b.mtime > 0);
    assert.strictEqual(r.entries.find((e) => e.name === 'adir').size, null, '디렉터리 size는 null');

    // 파일을 나열하면 NOT_DIR, 부재는 PATH_GONE.
    assert.deepStrictEqual(browsePolicy.listDir(path.join(root, 'a.txt')).code, 'NOT_DIR');
    assert.deepStrictEqual(browsePolicy.listDir(path.join(root, 'nope')).code, 'PATH_GONE');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('EXP-H-1: listDir — MAX_ENTRIES 초과 시 잘라내고 truncated로 알린다(조용한 절단 금지)', () => {
  const N = browsePolicy.MAX_ENTRIES + 5;
  const dirents = [];
  for (let i = 0; i < N; i++) {
    dirents.push({ name: 'f' + String(i).padStart(5, '0'), isSymbolicLink: () => false, isDirectory: () => false, isFile: () => true });
  }
  const fakeFs = {
    readdirSync: () => dirents,
    lstatSync: () => { throw new Error('stat 실패 — 개별 무시되어야 함'); },
  };
  const r = browsePolicy.listDir('/fake', { fs: fakeFs });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.truncated, true);
  assert.strictEqual(r.total, N);
  assert.strictEqual(r.entries.length, browsePolicy.MAX_ENTRIES);
  assert.strictEqual(r.entries[0].size, null, 'stat 실패 항목은 메타 null(항목 자체는 유지)');
});

test('EXP-H-1: listDir — 심링크는 따라가지 않고 kind=symlink 로 표시', () => {
  const fakeFs = {
    readdirSync: () => [{ name: 'link', isSymbolicLink: () => true, isDirectory: () => true, isFile: () => false }],
    lstatSync: () => ({ size: 0, mtimeMs: 1 }),
  };
  const r = browsePolicy.listDir('/fake', { fs: fakeFs });
  assert.strictEqual(r.entries[0].kind, 'symlink');
});

test('EXP-H-1: listDir — 권한 오류는 내부정보 없이 READ_FAILED (L-3)', () => {
  const fakeFs = {
    readdirSync: () => { const e = new Error('EACCES: permission denied, scandir /secret'); e.code = 'EACCES'; throw e; },
  };
  assert.deepStrictEqual(browsePolicy.listDir('/secret', { fs: fakeFs }), { ok: false, code: 'READ_FAILED' });
});
