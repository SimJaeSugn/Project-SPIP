'use strict';
/**
 * shelf-ipc.test.js — electron/ipc/shelf.js (SH-2, 헤드리스: ctx 주입·임시 fixture)
 *   add/list/remove/reorder/open/refresh 검증·에러코드·영속. shell·resolveBin은 ctx로 모킹.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const shelf = require('../electron/ipc/shelf');
const store = require('../lib/common/uiStateStore');
const { Logger } = require('../lib/common/logger');

const IS_WIN = process.platform === 'win32';

function tmpUiStatePath() {
  const d = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'spip-shelf-')));
  return path.join(d, 'ui-state', 'ui-state.json');
}
function fixtureDir() {
  const d = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'spip-fx-')));
  fs.writeFileSync(path.join(d, 'a.txt'), 'hi');
  return d;
}
function mockShell() {
  const calls = { openPath: [], openExternal: [] };
  return {
    calls,
    openPath: async (p) => { calls.openPath.push(p); return ''; }, // ''=성공
    openExternal: async (u) => { calls.openExternal.push(u); return true; },
  };
}
const { Readable } = require('stream');
// url 크롤용 fetchRaw/lookup 주입(공개 IP·간단 페이지) — 실제 네트워크 미사용.
function urlDeps(body, ct) {
  return {
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    fetchRaw: async () => ({ statusCode: 200, headers: { 'content-type': ct || 'text/html' }, res: Readable.from([Buffer.from(body || '<meta property="og:title" content="Site">')]) }),
  };
}
function makeCtx(extra) {
  return Object.assign({
    uiStatePath: tmpUiStatePath(),
    logger: new Logger({ quiet: true }),
    config: {},
    resolveBin: () => null, // VS Code 미발견 → folder open은 openPath 폴백
    shell: mockShell(),
  }, extra || {});
}

test('SH-2 add(folder) — ok·뷰 shape·영속', async () => {
  const ctx = makeCtx();
  const dir = fixtureDir();
  const r = await shelf.add({ type: 'folder', ref: dir }, ctx);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.bookmark.type, 'folder');
  assert.ok(/^b[0-9a-f]{6,32}$/.test(r.bookmark.id));
  assert.strictEqual(r.bookmark.bannerImage, null);
  assert.ok(typeof r.bookmark.addedAt === 'number');
  const list = shelf.list(undefined, ctx);
  assert.strictEqual(list.bookmarks.length, 1);
  assert.strictEqual(list.bookmarks[0].id, r.bookmark.id);
});

test('SH-2 add(file) — ok·언어 메타', async () => {
  const ctx = makeCtx();
  const dir = fixtureDir();
  const r = await shelf.add({ type: 'file', ref: path.join(dir, 'a.txt') }, ctx);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.bookmark.type, 'file');
  assert.strictEqual(r.bookmark.cat, 'Text');
});

test('SH-3 add(url) — 크롤 성공 시 메타·영속(주입 모킹)', async () => {
  const ctx = makeCtx({ deps: urlDeps('<meta property="og:title" content="GitHub">'), imagesDir: fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'spip-img-'))) });
  const r = await shelf.add({ type: 'url', ref: 'https://github.com' }, ctx);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.bookmark.type, 'url');
  assert.strictEqual(r.bookmark.title, 'GitHub');
  assert.strictEqual(r.bookmark.bannerImage, null); // og:image 없음 → 폴백
  assert.strictEqual(shelf.list(undefined, ctx).bookmarks.length, 1);
});

test('SH-3 add(url) — 내부 IP는 BLOCKED_HOST(SSRF 게이트)', async () => {
  const ctx = makeCtx({ deps: { lookup: async () => [{ address: '127.0.0.1', family: 4 }], fetchRaw: async () => { throw new Error('should not connect'); } } });
  const r = await shelf.add({ type: 'url', ref: 'http://evil.example/' }, ctx);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 'BLOCKED_HOST');
});

test('SH-3 add(url) — 비http 스킴 BAD_INPUT', async () => {
  const ctx = makeCtx();
  // detectType이 url로 못 잡는 입력은 BAD_INPUT(또는 UNSUPPORTED). javascript:는 detectType null.
  const r = await shelf.add({ type: 'url', ref: 'ftp://a.com/x' }, ctx);
  assert.strictEqual(r.ok, false);
});

test('SH-2 add — 미지원 타입·불량 입력', async () => {
  const ctx = makeCtx();
  assert.strictEqual((await shelf.add({ type: 'bogus', ref: '/a/b' }, ctx)).code, 'UNSUPPORTED_TYPE');
  assert.strictEqual((await shelf.add({ type: 'folder', ref: '' }, ctx)).code, 'BAD_INPUT');
  assert.strictEqual((await shelf.add({ type: 'folder', ref: 'noslashtext' }, ctx)).code, 'BAD_INPUT');
});

test('SH-2 add — 민감/시스템 경로 PATH_DENIED', async () => {
  const ctx = makeCtx();
  const sys = IS_WIN ? (process.env.WINDIR || 'C:\\Windows') : '/etc';
  const r = await shelf.add({ type: 'folder', ref: sys }, ctx);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 'PATH_DENIED');
});

test('SH-2 add — 소멸 경로 PATH_GONE', async () => {
  const ctx = makeCtx();
  const dir = fixtureDir();
  const r = await shelf.add({ type: 'folder', ref: path.join(dir, 'ghost-xyz') }, ctx);
  assert.strictEqual(r.code, 'PATH_GONE');
});

test('SH-2 add — MAX_SHELF 상한 초과=LIMIT', async () => {
  const ctx = makeCtx();
  // 64개 사전 시드(정규화 통과 형식).
  const seed = [];
  for (let i = 0; i < store.MAX_SHELF; i++) {
    seed.push({ id: 'b' + i.toString(16).padStart(6, '0'), type: 'folder', ref: '/seed/' + i });
  }
  store.write({ schemaVersion: 2, shelfBookmarks: seed }, { uiStatePath: ctx.uiStatePath });
  const dir = fixtureDir();
  const r = await shelf.add({ type: 'folder', ref: dir }, ctx);
  assert.strictEqual(r.code, 'LIMIT');
});

test('SH-2 remove — ok / NOT_FOUND', async () => {
  const ctx = makeCtx();
  const dir = fixtureDir();
  const added = await shelf.add({ type: 'folder', ref: dir }, ctx);
  const r = shelf.remove({ id: added.bookmark.id }, ctx);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.bookmarks.length, 0);
  assert.strictEqual(shelf.remove({ id: 'b000000' }, ctx).code, 'NOT_FOUND');
  assert.strictEqual(shelf.remove({ id: 'BAD' }, ctx).code, 'BAD_INPUT');
});

test('SH-2 reorder — 현존 id 순열 채택·누락 보존', async () => {
  const ctx = makeCtx();
  const a = await shelf.add({ type: 'folder', ref: fixtureDir() }, ctx);
  const b = await shelf.add({ type: 'folder', ref: fixtureDir() }, ctx);
  const r = shelf.reorder({ ids: [b.bookmark.id, 'extern', a.bookmark.id] }, ctx);
  assert.strictEqual(r.ok, true);
  const list = shelf.list(undefined, ctx);
  assert.deepStrictEqual(list.bookmarks.map((x) => x.id), [b.bookmark.id, a.bookmark.id]);
});

test('SH-2 open(file) — shell.openPath 호출·OPENING', async () => {
  const ctx = makeCtx();
  const dir = fixtureDir();
  const added = await shelf.add({ type: 'file', ref: path.join(dir, 'a.txt') }, ctx);
  const r = await shelf.open({ id: added.bookmark.id }, ctx);
  assert.deepStrictEqual(r, { ok: true, code: 'OPENING' });
  assert.strictEqual(ctx.shell.calls.openPath.length, 1);
});

test('SH-2 open(folder) — VS Code 미발견 → openPath 폴백·OPENING', async () => {
  const ctx = makeCtx();
  const added = await shelf.add({ type: 'folder', ref: fixtureDir() }, ctx);
  const r = await shelf.open({ id: added.bookmark.id }, ctx);
  assert.deepStrictEqual(r, { ok: true, code: 'OPENING' });
  assert.strictEqual(ctx.shell.calls.openPath.length, 1);
});

test('SH-2 open(url) — http/https 재검증 후 openExternal', async () => {
  const ctx = makeCtx();
  // open은 크롤 무관(저장된 ref만 사용) — 결정적 검증 위해 url 항목 직접 시드.
  store.write({
    schemaVersion: 2,
    shelfBookmarks: [
      { id: 'bcafe01', type: 'url', ref: 'https://github.com' },
      { id: 'bdead01', type: 'url', ref: 'javascript:alert(1)' },
    ],
  }, { uiStatePath: ctx.uiStatePath });
  const ok = await shelf.open({ id: 'bcafe01' }, ctx);
  assert.deepStrictEqual(ok, { ok: true, code: 'OPENING' });
  assert.strictEqual(ctx.shell.calls.openExternal[0], 'https://github.com');
  // 임의 스킴 차단.
  const bad = await shelf.open({ id: 'bdead01' }, ctx);
  assert.strictEqual(bad.code, 'BAD_INPUT');
});

test('SH-2 open — NOT_FOUND / BAD_INPUT', async () => {
  const ctx = makeCtx();
  assert.strictEqual((await shelf.open({ id: 'b000000' }, ctx)).code, 'NOT_FOUND');
  assert.strictEqual((await shelf.open({ id: 'BAD' }, ctx)).code, 'BAD_INPUT');
});

test('SH-2 refresh — folder 메타·lastChecked 갱신', async () => {
  const ctx = makeCtx();
  const added = await shelf.add({ type: 'folder', ref: fixtureDir() }, ctx);
  const r = await shelf.refresh({ id: added.bookmark.id }, ctx);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(typeof r.bookmark.lastChecked, 'number');
});

test('SH-3 refresh(url) — 재크롤로 메타 갱신(주입 모킹)', async () => {
  const ctx = makeCtx({ deps: urlDeps('<meta property="og:title" content="Refreshed">') });
  store.write({ schemaVersion: 2, shelfBookmarks: [{ id: 'bcafe02', type: 'url', ref: 'https://a.com' }] }, { uiStatePath: ctx.uiStatePath });
  const r = await shelf.refresh({ id: 'bcafe02' }, ctx);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.bookmark.title, 'Refreshed');
  assert.strictEqual(typeof r.bookmark.lastChecked, 'number');
});

// ── SH-4: 자동 재크롤 토글 ──
test('SH-4 getSettings/setSettings — autoRefresh 토글·라이브 반영·영속', () => {
  const cfgDir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'spip-cfg-')));
  const ctx = makeCtx({ config: { shelfAutoRefresh: true }, configPath: path.join(cfgDir, 'spip.config.json') });
  assert.strictEqual(shelf.getSettings(undefined, ctx).autoRefresh, true);
  const r = shelf.setSettings({ autoRefresh: false }, ctx);
  assert.deepStrictEqual(r, { ok: true, autoRefresh: false });
  assert.strictEqual(ctx.config.shelfAutoRefresh, false, 'ctx.config 라이브 반영');
  assert.strictEqual(shelf.getSettings(undefined, ctx).autoRefresh, false);
  // 영속 확인(설정 파일에 기록).
  assert.ok(JSON.parse(fs.readFileSync(ctx.configPath, 'utf8')).shelfAutoRefresh === false);
  // 비boolean 거부.
  assert.strictEqual(shelf.setSettings({ autoRefresh: 'nope' }, ctx).code, 'BAD_INPUT');
});

test('SH-4 list — autoRefresh 동봉(기본 true / off 반영)', () => {
  assert.strictEqual(shelf.list(undefined, makeCtx()).autoRefresh, true, 'config 부재 기본 true');
  assert.strictEqual(shelf.list(undefined, makeCtx({ config: { shelfAutoRefresh: false } })).autoRefresh, false);
});

// ── [D-1] 동시 변이 원자성 회귀(code-review 결함) — 실파일 기반 ──
test('SH-3 [D-1] 동시 refresh — stale write 상호 클로버 없음(둘 다 갱신)', async () => {
  const ctx = makeCtx({ deps: urlDeps('<meta property="og:title" content="v2">') });
  store.write({ schemaVersion: 2, shelfBookmarks: [
    { id: 'bc00001', type: 'url', ref: 'https://a.com', title: 'v1' },
    { id: 'bc00002', type: 'url', ref: 'https://b.com', title: 'v1' },
  ] }, { uiStatePath: ctx.uiStatePath });
  const [r1, r2] = await Promise.all([
    shelf.refresh({ id: 'bc00001' }, ctx),
    shelf.refresh({ id: 'bc00002' }, ctx),
  ]);
  assert.strictEqual(r1.ok, true);
  assert.strictEqual(r2.ok, true);
  // 락+재read 머지가 없으면 한쪽이 stale 배열을 덮어써 v1으로 남는다(클로버).
  const titles = shelf.list(undefined, ctx).bookmarks.map((b) => b.title).sort();
  assert.deepStrictEqual(titles, ['v2', 'v2']);
});

test('SH-3 [D-1] refresh 도중 remove — 삭제 항목 부활 안 함', async () => {
  const ctx = makeCtx({ deps: urlDeps('<meta property="og:title" content="late">') });
  store.write({ schemaVersion: 2, shelfBookmarks: [{ id: 'bc00003', type: 'url', ref: 'https://a.com' }] }, { uiStatePath: ctx.uiStatePath });
  const p = shelf.refresh({ id: 'bc00003' }, ctx); // 크롤 대기(락 밖)
  const rem = shelf.remove({ id: 'bc00003' }, ctx);  // 동기 remove 먼저 커밋
  assert.strictEqual(rem.ok, true);
  const r = await p;
  // 락 안 재-read에서 사라졌으므로 부활시키지 않고 NOT_FOUND.
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 'NOT_FOUND');
  assert.strictEqual(shelf.list(undefined, ctx).bookmarks.length, 0);
});
