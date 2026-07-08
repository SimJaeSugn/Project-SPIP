'use strict';
/**
 * ipc-explorer.test.js — 폴더 탐색기 IPC 핸들러 (EXP-H-1 / EXP-H-2, 헤드리스 F-3)
 *
 * 되살린 열람 표면(folders.js 의 "browseDir 없음" 결정을 최소 완화)이 실제로 좁은지 검증한다:
 *   · 등록 루트 밖 경로는 list/open/reveal/openWith/mkdir/rename/trash 모두 PATH_NOT_ALLOWED
 *   · 루트 등록은 dialog 결과로만 — 렌더러가 문자열 루트를 주입하는 채널 없음(핸들러 표면 확인)
 *   · 드라이브 루트·시스템 폴더는 루트로 등록 불가(pathPolicy deny)
 *   · openWith 는 safeExec 로 절대경로·shell:false·인자 [real] 고정(EXP-H-2)
 *   · trash 는 shell.trashItem 만 호출(영구 삭제 경로 없음), 루트 자기 자신은 ROOT_PROTECTED
 *   · rename 은 기존 항목을 덮어쓰지 않는다(EXISTS)
 *
 * Electron 미설치 환경에서 동작 — dialog/shell/safeExec/resolveBin 은 ctx 주입 모킹.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const explorer = require('../electron/ipc/explorer');
const configMod = require('../lib/common/config');

const IS_WIN = process.platform === 'win32';

function realTmp(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return fs.realpathSync.native ? fs.realpathSync.native(d) : fs.realpathSync(d);
}

/**
 * persistConfigKeys 를 스텁해 실제 디스크 config 를 건드리지 않게 한다.
 *   fn 이 async 일 수 있으므로 반드시 await 후 복원한다 — 동기 finally 로 복원하면
 *   핸들러가 실제 persistConfigKeys 를 잡아 사용자 설정 파일에 쓴다(테스트 부작용).
 */
async function withPersistStub(fn) {
  const orig = configMod.persistConfigKeys;
  const writes = [];
  configMod.persistConfigKeys = (patch) => { writes.push(patch); };
  try {
    return await fn(writes);
  } finally {
    configMod.persistConfigKeys = orig;
  }
}

/** roots 를 가진 최소 ctx. shell/dialog/safeExec 은 호출 기록용 스파이. */
function makeCtx(roots, over) {
  const calls = { openPath: [], showItemInFolder: [], trashItem: [], exec: [] };
  const ctx = Object.assign({
    config: { explorerRoots: roots.slice(), tools: {} },
    logger: { warn() {}, error() {} },
    shell: {
      openPath: async (p) => { calls.openPath.push(p); return ''; },
      showItemInFolder: (p) => { calls.showItemInFolder.push(p); },
      trashItem: async (p) => { calls.trashItem.push(p); },
    },
    resolveBin: () => '/abs/bin/code',
    safeExec: async (bin, args, opts) => { calls.exec.push({ bin, args, opts }); },
  }, over || {});
  return { ctx, calls };
}

/* ───── 열람 루트 등록 ───── */

test('EXP-H-1: pickRoot 는 dialog 결과만 등록한다(렌더러 경로 주입 표면 없음)', async () => {
  const root = realTmp('spip-ipcx-pick-');
  try {
    await withPersistStub(async (writes) => {
      const { ctx } = makeCtx([], {
        dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [root] }) },
      });
      const r = await explorer.pickRoot({}, ctx);
      assert.strictEqual(r.ok, true);
      assert.deepStrictEqual(r.roots, [root]);
      assert.deepStrictEqual(writes, [{ explorerRoots: [root] }], '0600 원자적 영속 위임');
      assert.deepStrictEqual(ctx.config.explorerRoots, [root], '메모리 config 동기화');
    });

    // pickRoot 는 args 를 쓰지 않는다 — 렌더러가 경로를 밀어넣어도 dialog 결과가 이긴다.
    await withPersistStub(async () => {
      const { ctx } = makeCtx([], {
        dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [root] }) },
      });
      const r = await explorer.pickRoot({ path: 'C:\\Windows', paths: ['/etc'] }, ctx);
      assert.deepStrictEqual(r.roots, [root], '인자 경로는 무시됨');
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('EXP-H-1: pickRoot — 취소/시스템폴더/드라이브루트/파일/상한 거부', async () => {
  const root = realTmp('spip-ipcx-rej-');
  const file = path.join(root, 'f.txt');
  fs.writeFileSync(file, 'x');
  try {
    await withPersistStub(async () => {
      const cancel = makeCtx([], { dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) } });
      assert.deepStrictEqual(await explorer.pickRoot({}, cancel.ctx), { ok: false, code: 'CANCELLED' });

      const fsRoot = IS_WIN ? path.parse(root).root : '/';
      const drive = makeCtx([], { dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [fsRoot] }) } });
      const rd = await explorer.pickRoot({}, drive.ctx);
      assert.strictEqual(rd.ok, false, '드라이브/FS 루트는 등록 불가(하위 시스템 폴더 우회 차단)');
      assert.strictEqual(rd.code, 'PATH_DENIED');

      const asFile = makeCtx([], { dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [file] }) } });
      assert.deepStrictEqual(await explorer.pickRoot({}, asFile.ctx), { ok: false, code: 'NOT_DIR' });

      // 상한 — MAX_ROOTS 만큼 이미 등록돼 있으면 dialog 를 열지도 않는다.
      const full = makeCtx(Array.from({ length: explorer.MAX_ROOTS }, (_, i) => root + '-' + i), {
        dialog: { showOpenDialog: async () => { throw new Error('dialog 를 열면 안 된다'); } },
      });
      assert.deepStrictEqual(await explorer.pickRoot({}, full.ctx), { ok: false, code: 'LIMIT' });
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('EXP-H-1: pickRoot — 이미 등록된 폴더 재선택은 중복 추가하지 않는다', async () => {
  const root = realTmp('spip-ipcx-dup-');
  try {
    await withPersistStub(async (writes) => {
      const { ctx } = makeCtx([root], { dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [root] }) } });
      const r = await explorer.pickRoot({}, ctx);
      assert.strictEqual(r.ok, true);
      assert.deepStrictEqual(r.roots, [root]);
      assert.strictEqual(writes.length, 0, '변화 없으면 디스크 write 없음');
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('EXP-H-1: removeRoot — 정확 일치 1건 제거, 미등록은 NOT_FOUND', async () => {
  const a = realTmp('spip-ipcx-ra-');
  const b = realTmp('spip-ipcx-rb-');
  try {
    await withPersistStub(async (writes) => {
      const { ctx } = makeCtx([a, b]);
      const r = explorer.removeRoot({ path: a }, ctx);
      assert.strictEqual(r.ok, true);
      assert.deepStrictEqual(r.roots, [b]);
      assert.deepStrictEqual(writes, [{ explorerRoots: [b] }]);

      assert.deepStrictEqual(explorer.removeRoot({ path: a }, ctx).code, 'NOT_FOUND');
      assert.deepStrictEqual(explorer.removeRoot({ path: '' }, ctx).code, 'BAD_INPUT');
      assert.deepStrictEqual(explorer.removeRoot({}, ctx).code, 'BAD_INPUT');
    });
  } finally {
    fs.rmSync(a, { recursive: true, force: true });
    fs.rmSync(b, { recursive: true, force: true });
  }
});

/* ───── 열람 ───── */

test('EXP-H-1: list — 루트 하위만 허용, 밖은 PATH_NOT_ALLOWED, 루트에서는 parent=null', () => {
  const root = realTmp('spip-ipcx-list-');
  const outside = realTmp('spip-ipcx-out-');
  const sub = path.join(root, 'sub');
  fs.mkdirSync(sub);
  fs.writeFileSync(path.join(root, 'a.txt'), 'hi');
  try {
    const { ctx } = makeCtx([root]);

    const atRoot = explorer.list({ path: root }, ctx);
    assert.strictEqual(atRoot.ok, true);
    assert.strictEqual(atRoot.path, root);
    assert.strictEqual(atRoot.parent, null, '루트에서 상위 이동 불가');
    assert.deepStrictEqual(atRoot.entries.map((e) => e.name), ['sub', 'a.txt']);

    const atSub = explorer.list({ path: sub }, ctx);
    assert.strictEqual(atSub.ok, true);
    assert.strictEqual(atSub.parent, root);

    assert.deepStrictEqual(explorer.list({ path: outside }, ctx), { ok: false, code: 'PATH_NOT_ALLOWED' });
    // path 미지정 → 첫 루트 폴백. 루트 자체가 없으면 NO_ROOTS.
    assert.strictEqual(explorer.list({}, ctx).path, root);
    assert.deepStrictEqual(explorer.list({}, makeCtx([]).ctx), { ok: false, code: 'NO_ROOTS' });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('EXP-H-1: list — 루트 안의 심링크가 밖을 가리키면 진입 거부(canonicalize 우선)', (t) => {
  const root = realTmp('spip-ipcx-sym-');
  const outside = realTmp('spip-ipcx-symout-');
  const link = path.join(root, 'escape');
  try {
    try {
      fs.symlinkSync(outside, link, 'junction');
    } catch (_) {
      return t.skip('심링크/junction 생성 권한 없음');
    }
    const { ctx } = makeCtx([root]);
    // 링크 자체는 목록에 보이지만(kind=symlink) 진입하면 실경로가 루트 밖 → 거부.
    const listed = explorer.list({ path: root }, ctx);
    assert.strictEqual(listed.ok, true);
    assert.deepStrictEqual(explorer.list({ path: link }, ctx), { ok: false, code: 'PATH_NOT_ALLOWED' });
  } finally {
    try { fs.unlinkSync(link); } catch (_) { /* noop */ }
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('EXP-H-1: list — 경로 순회(../)로 루트를 탈출할 수 없다', () => {
  const root = realTmp('spip-ipcx-trav-');
  const sub = path.join(root, 'sub');
  fs.mkdirSync(sub);
  try {
    const { ctx } = makeCtx([sub]); // 루트를 sub 로 좁게 등록
    const escape = path.join(sub, '..');
    assert.deepStrictEqual(explorer.list({ path: escape }, ctx), { ok: false, code: 'PATH_NOT_ALLOWED' });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/* ───── 열기 액션 ───── */

test('EXP-H-1/H-2: open/reveal/openWith — 루트 밖 거부, 통과 시 실경로만 전달', async () => {
  const root = realTmp('spip-ipcx-open-');
  const outside = realTmp('spip-ipcx-openout-');
  const file = path.join(root, 'a.txt');
  fs.writeFileSync(file, 'x');
  try {
    const { ctx, calls } = makeCtx([root]);

    assert.strictEqual((await explorer.open({ path: file }, ctx)).ok, true);
    assert.deepStrictEqual(calls.openPath, [file]);

    assert.strictEqual(explorer.reveal({ path: file }, ctx).ok, true);
    assert.deepStrictEqual(calls.showItemInFolder, [file]);

    assert.strictEqual((await explorer.openWith({ path: file, toolId: 'code' }, ctx)).ok, true);
    assert.strictEqual(calls.exec.length, 1);
    assert.strictEqual(calls.exec[0].bin, '/abs/bin/code', '절대경로 바이너리');
    assert.deepStrictEqual(calls.exec[0].args, [file], 'EXP-H-2: 인자는 [real] 고정(사용자 args 없음)');
    assert.strictEqual(calls.exec[0].opts.shell, false, 'EXP-H-2: shell:false');
    assert.ok(calls.exec[0].opts.maxInflight > 0, 'in-flight 상한(M-4)');

    // 루트 밖은 셸/실행에 도달하지 않는다.
    const outFile = path.join(outside, 'b.txt');
    fs.writeFileSync(outFile, 'x');
    assert.deepStrictEqual(await explorer.open({ path: outFile }, ctx), { ok: false, code: 'PATH_NOT_ALLOWED' });
    assert.deepStrictEqual(explorer.reveal({ path: outFile }, ctx), { ok: false, code: 'PATH_NOT_ALLOWED' });
    assert.deepStrictEqual(await explorer.openWith({ path: outFile }, ctx), { ok: false, code: 'PATH_NOT_ALLOWED' });
    assert.deepStrictEqual(calls.openPath, [file], '루트 밖 호출은 shell 에 도달하지 않음');
    assert.strictEqual(calls.exec.length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('EXP-H-2: openWith — 화이트리스트 외 toolId 거부(실행 0)', async () => {
  const root = realTmp('spip-ipcx-tool-');
  const file = path.join(root, 'a.txt');
  fs.writeFileSync(file, 'x');
  try {
    const { ctx, calls } = makeCtx([root]);
    assert.deepStrictEqual(await explorer.openWith({ path: file, toolId: 'rm -rf' }, ctx), { ok: false, code: 'TOOL_NOT_FOUND' });
    assert.strictEqual(calls.exec.length, 0);

    // resolveBin 실패(툴 미설치) → 고정 코드, 실행 0.
    const noBin = makeCtx([root], { resolveBin: () => null });
    assert.deepStrictEqual(await explorer.openWith({ path: file }, noBin.ctx), { ok: false, code: 'CODE_CLI_NOT_FOUND' });
    assert.strictEqual(noBin.calls.exec.length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/* ───── 쓰기 액션 ───── */

test('EXP-H-1: mkdir — 루트 하위·단일 세그먼트만, 덮어쓰기 없음', () => {
  const root = realTmp('spip-ipcx-mkdir-');
  const outside = realTmp('spip-ipcx-mkdirout-');
  try {
    const { ctx } = makeCtx([root]);

    const r = explorer.mkdir({ path: root, name: '새 폴더' }, ctx);
    assert.strictEqual(r.ok, true);
    assert.ok(fs.existsSync(path.join(root, '새 폴더')));

    assert.deepStrictEqual(explorer.mkdir({ path: root, name: '새 폴더' }, ctx), { ok: false, code: 'EXISTS' });

    // 이름으로 부모 밖을 겨냥할 수 없다(sanitizeName 이 구분자·'..' 차단).
    for (const bad of ['..', '../pwn', 'a/b', 'a\\b', '', 'con']) {
      assert.deepStrictEqual(explorer.mkdir({ path: root, name: bad }, ctx), { ok: false, code: 'BAD_NAME' }, JSON.stringify(bad));
    }
    assert.strictEqual(fs.existsSync(path.join(path.dirname(root), 'pwn')), false);

    // 루트 밖 부모 거부.
    assert.deepStrictEqual(explorer.mkdir({ path: outside, name: 'x' }, ctx), { ok: false, code: 'PATH_NOT_ALLOWED' });
    assert.strictEqual(fs.existsSync(path.join(outside, 'x')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('EXP-H-1: rename — 기존 항목을 덮어쓰지 않는다(EXISTS)', () => {
  const root = realTmp('spip-ipcx-ren-');
  const a = path.join(root, 'a.txt');
  const b = path.join(root, 'b.txt');
  fs.writeFileSync(a, 'AAA');
  fs.writeFileSync(b, 'BBB');
  try {
    const { ctx } = makeCtx([root]);
    assert.deepStrictEqual(explorer.rename({ path: a, name: 'b.txt' }, ctx), { ok: false, code: 'EXISTS' });
    assert.strictEqual(fs.readFileSync(b, 'utf8'), 'BBB', '대상 파일 내용 보존(덮어쓰기 금지)');

    const r = explorer.rename({ path: a, name: 'c.txt' }, ctx);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(fs.existsSync(a), false);
    assert.strictEqual(fs.readFileSync(path.join(root, 'c.txt'), 'utf8'), 'AAA');

    assert.deepStrictEqual(explorer.rename({ path: b, name: '../escape' }, ctx), { ok: false, code: 'BAD_NAME' });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('EXP-H-1: rename/trash — 등록 루트 자기 자신은 ROOT_PROTECTED', async () => {
  const root = realTmp('spip-ipcx-prot-');
  try {
    const { ctx, calls } = makeCtx([root]);
    assert.deepStrictEqual(explorer.rename({ path: root, name: 'renamed' }, ctx), { ok: false, code: 'ROOT_PROTECTED' });
    assert.deepStrictEqual(await explorer.trash({ path: root }, ctx), { ok: false, code: 'ROOT_PROTECTED' });
    assert.strictEqual(calls.trashItem.length, 0, '루트는 휴지통 호출에 도달하지 않음');
    assert.ok(fs.existsSync(root), '루트 보존');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('EXP-H-1: trash — shell.trashItem 만 호출한다(영구 삭제 경로 없음)', async () => {
  const root = realTmp('spip-ipcx-trash-');
  const outside = realTmp('spip-ipcx-trashout-');
  const victim = path.join(root, 'v.txt');
  fs.writeFileSync(victim, 'x');
  try {
    const { ctx, calls } = makeCtx([root]);
    const r = await explorer.trash({ path: victim }, ctx);
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(calls.trashItem, [victim]);
    assert.ok(fs.existsSync(victim), 'trashItem 은 모킹 — 핸들러가 직접 unlink 하지 않는다');

    // 루트 밖은 휴지통 호출에 도달하지 않는다.
    const outVictim = path.join(outside, 'v.txt');
    fs.writeFileSync(outVictim, 'x');
    assert.deepStrictEqual(await explorer.trash({ path: outVictim }, ctx), { ok: false, code: 'PATH_NOT_ALLOWED' });
    assert.deepStrictEqual(calls.trashItem, [victim]);

    // shell.trashItem 부재(구버전 Electron) → INTERNAL, 파일 무사.
    const noShell = makeCtx([root], { shell: {} });
    assert.deepStrictEqual(await explorer.trash({ path: victim }, noShell.ctx), { ok: false, code: 'INTERNAL' });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('EXP-H-1: getRoots — 등록 루트 스냅샷 + 상한 노출', () => {
  const { ctx } = makeCtx(['/a', '/b']);
  const r = explorer.getRoots({}, ctx);
  assert.deepStrictEqual(r, { ok: true, roots: ['/a', '/b'], max: explorer.MAX_ROOTS });
  r.roots.push('/c');
  assert.strictEqual(ctx.config.explorerRoots.length, 2, '응답 배열 변조가 내부 상태를 오염시키지 않음');
});
