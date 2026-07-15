'use strict';
/**
 * ipc-markdown.test.js — 마크다운 편집기 IPC (MD-1 / MD-H-1)
 *
 * 핸들러는 Electron API 를 import 하지 않고 dialog 를 ctx 로 주입받으므로 헤드리스로 전량 검증된다.
 * 핵심 보안 축(MD-H-1): 렌더러가 경로를 주입할 표면이 없다 · dialog 결과도 재검증한다 ·
 *   실패는 고정 코드만 반환한다(절대경로·errno 비노출).
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ipc = require('../electron/ipc/markdown');
const mdDocStore = require('../lib/common/mdDocStore');

let seq = 0;
function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'spip-mdipc-')); }

// [문서함 = 위젯 인스턴스] 모든 md IPC 는 box(편집기 iid)를 받는다. 기본 문서함 = 첫 편집기('mdedit').
const BOX = 'mdedit';
const BOX2 = 'w7';
/** 배치된 편집기 인스턴스(레거시 이행 대상 = 첫 mdedit)를 주입하는 uiState 스텁. */
function uiStateStub(widgets) {
  return { read: () => ({ homeWidgets: widgets || [{ iid: BOX, type: 'mdedit', name: '' }, { iid: BOX2, type: 'mdedit', name: '' }] }) };
}
/** 문서 저장 파일을 임시 경로로 격리한 ctx. now 는 고정 스탬프(결정적). */
function ctxWith(over) {
  const file = path.join(tmpDir(), 'md-docs-' + (seq++) + '.json');
  const base = { mdDocsPath: file, deps: { now: () => 1700000000000, uiState: uiStateStub() } };
  const o = over || {};
  // deps 를 덮어쓸 땐 uiState 스텁을 잃지 않게 병합(실제 ui-state.json 을 읽지 않도록).
  const deps = Object.assign({}, base.deps, o.deps || {});
  return Object.assign({}, base, o, { deps });
}
/** 문서 1건을 만들어 둔 ctx 를 돌려준다. */
function withDoc(ctx, title, body) {
  const r = ipc.create({ box: BOX, title: title, body: body == null ? '' : body }, ctx);
  assert.ok(r.ok, 'fixture create 성공');
  return r.doc;
}

/* ───── CRUD ───── */

test('MD-1 create/list/get — id·시각은 main 이 스탬프하고, 목록엔 본문이 없다', () => {
  const ctx = ctxWith();
  const doc = withDoc(ctx, '회의록', '# 회의록\n\n내용');

  assert.ok(mdDocStore.ID_RE.test(doc.id), 'main 이 발급한 id');
  assert.strictEqual(doc.createdAt, 1700000000000, 'main 스탬프');
  assert.strictEqual(doc.updatedAt, 1700000000000);

  const l = ipc.list({ box: BOX }, ctx);
  assert.ok(l.ok);
  assert.strictEqual(l.docs.length, 1);
  assert.strictEqual(l.docs[0].title, '회의록');
  assert.strictEqual(l.docs[0].body, undefined, '목록 응답에 본문 없음(대용량 회송 방지)');
  assert.strictEqual(l.docs[0].size, '# 회의록\n\n내용'.length, '크기는 문자수로');

  const g = ipc.get({ box: BOX, id: doc.id }, ctx);
  assert.ok(g.ok);
  assert.strictEqual(g.doc.body, '# 회의록\n\n내용', 'get 에서만 본문');
});

test('MD-1 create — 렌더러가 보낸 id 는 무시된다(새 id 발급)', () => {
  const ctx = ctxWith();
  const r = ipc.create({ box: BOX, id: 'dffffffffffff', title: 'x', body: '' }, ctx);
  assert.ok(r.ok);
  assert.notStrictEqual(r.doc.id, 'dffffffffffff', 'main 이 스스로 발급');
});

test('MD-1 create — 제목이 비면 본문 첫 제목/첫 줄에서 파생(제목 없는 문서 방지)', () => {
  const ctx = ctxWith();
  assert.strictEqual(ipc.create({ box: BOX, title: '', body: '# 파생된 제목\n본문' }, ctx).doc.title, '파생된 제목');
  assert.strictEqual(ipc.create({ box: BOX, title: '', body: '그냥 첫 줄\n둘째 줄' }, ctx).doc.title, '그냥 첫 줄');
});

test('MD-1 update — 지정한 필드만 갱신하고 updatedAt 은 main 이 스탬프', () => {
  const ctx = ctxWith();
  const doc = withDoc(ctx, '원제목', '원본');

  const ctx2 = Object.assign({}, ctx, { deps: { now: () => 1700000009999 } });
  const r = ipc.update({ box: BOX, id: doc.id, body: '고친 본문' }, ctx2);
  assert.ok(r.ok);
  assert.strictEqual(r.doc.body, '고친 본문');
  assert.strictEqual(r.doc.title, '원제목', '제목 미지정 → 불변');
  assert.strictEqual(r.doc.createdAt, 1700000000000, 'createdAt 불변');
  assert.strictEqual(r.doc.updatedAt, 1700000009999, 'updatedAt 갱신');

  // 제목만 변경(본문 불변).
  const r2 = ipc.update({ box: BOX, id: doc.id, title: '새 제목' }, ctx);
  assert.strictEqual(r2.doc.title, '새 제목');
  assert.strictEqual(r2.doc.body, '고친 본문');
});

test('MD-1 remove — 정확 id 1건 삭제, 없으면 NOT_FOUND', () => {
  const ctx = ctxWith();
  const a = withDoc(ctx, 'A', '');
  withDoc(ctx, 'B', '');

  const r = ipc.remove({ box: BOX, id: a.id }, ctx);
  assert.ok(r.ok);
  assert.strictEqual(r.docs.length, 1);
  assert.strictEqual(r.docs[0].title, 'B');

  assert.deepStrictEqual(ipc.remove({ box: BOX, id: a.id }, ctx), { ok: false, code: 'NOT_FOUND' }, '두 번째 삭제는 NOT_FOUND');
});

test('MD-1 목록 정렬 — 최근 수정순', () => {
  const ctx = ctxWith();
  const older = ipc.create({ box: BOX, title: '옛것', body: '' }, Object.assign({}, ctx, { deps: { now: () => 1000 } })).doc;
  const newer = ipc.create({ box: BOX, title: '새것', body: '' }, Object.assign({}, ctx, { deps: { now: () => 9000 } })).doc;
  const l = ipc.list({ box: BOX }, ctx);
  assert.deepStrictEqual(l.docs.map((d) => d.id), [newer.id, older.id]);
});

/* ───── 입력 검증(L-3 고정 코드) ───── */

test('MD-H-1 잘못된 id — 경로 문자열을 넣어도 BAD_INPUT(경로로 해석되지 않는다)', () => {
  const ctx = ctxWith();
  for (const bad of ['../../etc/passwd', 'C:\\Windows\\System32\\config\\SAM', '', 'xyz']) {
    for (const fn of ['get', 'update', 'remove']) {
      const r = ipc[fn]({ id: bad }, ctx);
      assert.deepStrictEqual(r, { ok: false, code: 'BAD_INPUT' }, fn + '(' + bad + ')');
    }
  }
  // 인자 자체가 손상된 경우도 고정 코드.
  assert.strictEqual(ipc.get(null, ctx).code, 'BAD_INPUT');
  assert.strictEqual(ipc.get([1, 2], ctx).code, 'BAD_INPUT');
});

test('MD-1 상한 — 본문 초과는 조용히 자르지 않고 LIMIT_SIZE 로 거절', () => {
  const ctx = ctxWith();
  const huge = 'x'.repeat(mdDocStore.MAX_BODY + 1);
  assert.deepStrictEqual(ipc.create({ box: BOX, title: 't', body: huge }, ctx), { ok: false, code: 'LIMIT_SIZE' });

  const doc = withDoc(ctx, 't', 'ok');
  assert.deepStrictEqual(ipc.update({ box: BOX, id: doc.id, body: huge }, ctx), { ok: false, code: 'LIMIT_SIZE' });
  assert.strictEqual(ipc.get({ box: BOX, id: doc.id }, ctx).doc.body, 'ok', '거절 후 원본 불변');
});

test('MD-1 상한 — 문서 수 초과는 LIMIT_DOCS', () => {
  const ctx = ctxWith();
  const docs = [];
  for (let i = 0; i < mdDocStore.MAX_DOCS; i++) docs.push({ id: mdDocStore.newId(), title: 't' + i, body: '', createdAt: 1, updatedAt: 1 });
  mdDocStore.write({ docs }, ctx);
  assert.deepStrictEqual(ipc.create({ box: BOX, title: '하나 더', body: '' }, ctx), { ok: false, code: 'LIMIT_DOCS' });
});

/* ───── 불러오기 (dialog 만이 경로를 만든다 — MD-H-1) ───── */

test('MD-H-1 import — 경로 인자를 받지 않는다(dialog 결과만 읽는다)', async () => {
  const dir = tmpDir();
  const file = path.join(dir, '읽을문서.md');
  fs.writeFileSync(file, '# 불러온 제목\n\n본문');

  let askedFor = null;
  const ctx = ctxWith({
    dialog: {
      showOpenDialog: async (win, opts) => { askedFor = opts; return { canceled: false, filePaths: [file] }; },
    },
  });

  // 렌더러가 임의 경로를 인자로 넣어도 무시된다 — dialog 가 고른 파일만 읽힌다(box 는 문서함일 뿐).
  const r = await ipc.importFile({ box: BOX, path: 'C:\\Windows\\System32\\drivers\\etc\\hosts' }, ctx);
  assert.ok(r.ok);
  assert.strictEqual(r.doc.body, '# 불러온 제목\n\n본문');
  assert.strictEqual(r.doc.title, '불러온 제목', '본문 첫 제목에서 파생');
  assert.deepStrictEqual(askedFor.properties, ['openFile'], 'openFile 다이얼로그');
  assert.deepStrictEqual(askedFor.filters[0].extensions, ipc.IMPORT_EXTS);
});

test('MD-H-1 import — dialog 취소는 CANCELLED(문서 생성 없음)', async () => {
  const ctx = ctxWith({ dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) } });
  assert.deepStrictEqual(await ipc.importFile({ box: BOX }, ctx), { ok: false, code: 'CANCELLED' });
  assert.strictEqual(ipc.list({ box: BOX }, ctx).docs.length, 0);
});

test('MD-H-1 import — dialog 결과도 신뢰하지 않는다: 디렉터리는 NOT_FILE, 과대 파일은 LIMIT_SIZE', async () => {
  const dir = tmpDir();

  // ① dialog 가 디렉터리를 돌려줘도 읽지 않는다.
  const c1 = ctxWith({ dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [dir] }) } });
  assert.deepStrictEqual(await ipc.importFile({ box: BOX }, c1), { ok: false, code: 'NOT_FILE' });

  // ② 바이트 상한 초과 파일은 거절(조용한 절단 없음).
  const big = path.join(dir, 'big.md');
  fs.writeFileSync(big, 'x'.repeat(ipc.MAX_IMPORT_BYTES + 10));
  const c2 = ctxWith({ dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [big] }) } });
  assert.deepStrictEqual(await ipc.importFile({ box: BOX }, c2), { ok: false, code: 'LIMIT_SIZE' });
});

test('MD-1 import — 읽기 실패는 고정 코드(READ_FAILED)로만 — errno·절대경로 비노출(L-3)', async () => {
  const ctx = ctxWith({
    dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: ['C:\\절대\\경로\\없음.md'] }) },
    deps: {
      now: () => 1,
      fs: {
        statSync: () => ({ isFile: () => true, size: 10 }),
        readFileSync: () => { const e = new Error('ENOENT: no such file, open C:\\절대\\경로\\없음.md'); e.code = 'ENOENT'; throw e; },
      },
    },
  });
  const r = await ipc.importFile({ box: BOX }, ctx);
  assert.deepStrictEqual(r, { ok: false, code: 'READ_FAILED' });
  assert.strictEqual(JSON.stringify(r).indexOf('절대'), -1, '응답에 경로 조각이 없다');
});

/* ───── 내보내기 ───── */

test('MD-H-1 export — 저장 경로는 dialog 가 정하고, 응답엔 파일명만 담는다(L-3)', async () => {
  const dir = tmpDir();
  const out = path.join(dir, '내보낸문서.md');
  const ctx = ctxWith();
  const doc = withDoc(ctx, '내보낼 제목', '# 내보낼 제목\n\n본문 내용');

  let askedFor = null;
  const ectx = Object.assign({}, ctx, {
    dialog: {
      showSaveDialog: async (win, opts) => { askedFor = opts; return { canceled: false, filePath: out }; },
    },
  });

  const r = await ipc.exportFile({ box: BOX, id: doc.id }, ectx);
  assert.ok(r.ok);
  assert.strictEqual(r.name, '내보낸문서.md', '파일명만');
  assert.strictEqual(JSON.stringify(r).indexOf(dir), -1, '절대경로 비노출');
  assert.strictEqual(fs.readFileSync(out, 'utf8'), '# 내보낼 제목\n\n본문 내용', '본문이 그대로 파일로');
  assert.strictEqual(askedFor.defaultPath, '내보낼 제목.md', '제목에서 파생한 기본 파일명 제안');
});

test('MD-H-1 export — 취소는 CANCELLED, 없는 문서는 NOT_FOUND(파일을 쓰지 않는다)', async () => {
  const ctx = ctxWith();
  const doc = withDoc(ctx, 't', 'body');
  const target = path.join(tmpDir(), '안써져야함.md');

  // 취소 — dialog 가 경로를 돌려주지 않으므로 아무것도 쓰지 않는다.
  const c1 = Object.assign({}, ctx, { dialog: { showSaveDialog: async () => ({ canceled: true, filePath: target }) } });
  assert.deepStrictEqual(await ipc.exportFile({ box: BOX, id: doc.id }, c1), { ok: false, code: 'CANCELLED' });
  assert.strictEqual(fs.existsSync(target), false, '취소 시 파일 생성 없음');

  // 없는 문서 — dialog 를 띄우기 전에 거절한다.
  let dialogShown = false;
  const c2 = Object.assign({}, ctx, {
    dialog: { showSaveDialog: async () => { dialogShown = true; return { canceled: false, filePath: target }; } },
  });
  assert.deepStrictEqual(await ipc.exportFile({ box: BOX, id: mdDocStore.newId() }, c2), { ok: false, code: 'NOT_FOUND' });
  assert.strictEqual(dialogShown, false, '없는 문서면 dialog 도 띄우지 않는다');
  assert.strictEqual(fs.existsSync(target), false);
});

test('MD-1 safeFileName — 경로 구분자·예약문자를 제거해 디렉터리 이탈을 만들 수 없다', () => {
  assert.strictEqual(ipc.safeFileName('../../etc/passwd'), '....etcpasswd.md');
  assert.strictEqual(ipc.safeFileName('a/b\\c:d*e?f"g<h>i|j'), 'abcdefghij.md');
  assert.strictEqual(ipc.safeFileName(''), '문서.md');
  assert.ok(ipc.safeFileName('x'.repeat(300)).length <= 83, '길이 상한');
});

test('MD-1 dialog 미주입(비-Electron) — import/export 는 CANCELLED 로 graceful', async () => {
  const ctx = ctxWith();
  const doc = withDoc(ctx, 't', 'b');
  assert.deepStrictEqual(await ipc.importFile({ box: BOX }, ctx), { ok: false, code: 'CANCELLED' });
  assert.deepStrictEqual(await ipc.exportFile({ box: BOX, id: doc.id }, ctx), { ok: false, code: 'CANCELLED' });
});

/* ───── [문서함 = 위젯 인스턴스] 편집기별 문서 격리 + v1 레거시 이행 ───── */

test('MD-BOX — 편집기마다 자기 문서함: A 의 문서는 B 의 목록에 없다', () => {
  const ctx = ctxWith();
  const a = ipc.create({ box: BOX, title: 'A 문서', body: 'a' }, ctx).doc;
  const b = ipc.create({ box: BOX2, title: 'B 문서', body: 'b' }, ctx).doc;

  assert.deepStrictEqual(ipc.list({ box: BOX }, ctx).docs.map((d) => d.title), ['A 문서']);
  assert.deepStrictEqual(ipc.list({ box: BOX2 }, ctx).docs.map((d) => d.title), ['B 문서']);
  assert.notStrictEqual(a.id, b.id);
});

test('MD-BOX — 남의 문서함 문서는 읽기·수정·삭제·내보내기 모두 NOT_FOUND(메인이 격리를 강제)', async () => {
  const ctx = ctxWith();
  const a = ipc.create({ box: BOX, title: 'A 문서', body: 'a' }, ctx).doc;

  assert.strictEqual(ipc.get({ box: BOX2, id: a.id }, ctx).code, 'NOT_FOUND');
  assert.strictEqual(ipc.update({ box: BOX2, id: a.id, body: '침범' }, ctx).code, 'NOT_FOUND');
  assert.strictEqual(ipc.remove({ box: BOX2, id: a.id }, ctx).code, 'NOT_FOUND');
  const ex = await ipc.exportFile({ box: BOX2, id: a.id }, Object.assign({}, ctx, {
    dialog: { showSaveDialog: async () => ({ canceled: false, filePath: path.join(tmpDir(), 'x.md') }) },
  }));
  assert.strictEqual(ex.code, 'NOT_FOUND');
  assert.strictEqual(ipc.get({ box: BOX, id: a.id }, ctx).doc.body, 'a', '원본은 그대로');
});

test('MD-BOX — box 없음/형식 불량은 BAD_INPUT(모든 채널)', async () => {
  const ctx = ctxWith();
  const doc = withDoc(ctx, 't', 'b');
  const bad = [{}, { box: '' }, { box: 'BAD!' }, { box: '../x' }, { box: 1 }];
  for (const args of bad) {
    assert.strictEqual(ipc.list(args, ctx).code, 'BAD_INPUT');
    assert.strictEqual(ipc.create(Object.assign({ title: 'x' }, args), ctx).code, 'BAD_INPUT');
    assert.strictEqual(ipc.get(Object.assign({ id: doc.id }, args), ctx).code, 'BAD_INPUT');
    assert.strictEqual(ipc.update(Object.assign({ id: doc.id, body: 'x' }, args), ctx).code, 'BAD_INPUT');
    assert.strictEqual(ipc.remove(Object.assign({ id: doc.id }, args), ctx).code, 'BAD_INPUT');
    assert.strictEqual((await ipc.importFile(args, ctx)).code, 'BAD_INPUT');
    assert.strictEqual((await ipc.exportFile(Object.assign({ id: doc.id }, args), ctx)).code, 'BAD_INPUT');
  }
});

test('MD-BOX — 상한(문서 수)은 문서함마다 따로 적용된다', () => {
  const ctx = ctxWith();
  for (let i = 0; i < mdDocStore.MAX_DOCS; i++) ipc.create({ box: BOX, title: 't' + i, body: '' }, ctx);
  assert.strictEqual(ipc.create({ box: BOX, title: '초과', body: '' }, ctx).code, 'LIMIT_DOCS');
  assert.ok(ipc.create({ box: BOX2, title: '다른 문서함은 여유', body: '' }, ctx).ok, '다른 편집기는 영향 없음');
});

test('MD-BOX 이행 — v1(전역 docs)의 문서는 첫 편집기 인스턴스의 문서함으로 흡수된다(무손실)', () => {
  const ctx = ctxWith();
  // v1 스키마 파일을 직접 심는다(옛 설치본 상태).
  fs.writeFileSync(ctx.mdDocsPath, JSON.stringify({
    schemaVersion: 1,
    docs: [
      { id: 'd000000000001', title: '옛 문서 1', body: '본문1', createdAt: 1000, updatedAt: 2000 },
      { id: 'd000000000002', title: '옛 문서 2', body: '본문2', createdAt: 1000, updatedAt: 3000 },
    ],
  }), 'utf8');

  const l = ipc.list({ box: BOX }, ctx); // 첫 편집기가 물어보는 순간 흡수
  assert.deepStrictEqual(l.docs.map((d) => d.title), ['옛 문서 2', '옛 문서 1'], '최근 수정순으로 그대로');
  assert.strictEqual(ipc.get({ box: BOX, id: 'd000000000001' }, ctx).doc.body, '본문1', '본문 보존');

  // 둘째 편집기는 빈 문서함에서 시작한다(옛 문서를 나눠 갖지 않는다).
  assert.strictEqual(ipc.list({ box: BOX2 }, ctx).docs.length, 0);

  // 흡수는 1회 — 파일에 legacy 가 남지 않는다.
  const raw = JSON.parse(fs.readFileSync(ctx.mdDocsPath, 'utf8'));
  assert.strictEqual(raw.schemaVersion, 2);
  assert.deepStrictEqual(raw.legacy, []);
  assert.strictEqual(raw.boxes[BOX].length, 2);
});

test('MD-BOX 이행 — 첫 편집기가 아닌 인스턴스가 먼저 물어봐도 흡수하지 않는다(문서 오배치 방지)', () => {
  const ctx = ctxWith();
  fs.writeFileSync(ctx.mdDocsPath, JSON.stringify({
    schemaVersion: 1,
    docs: [{ id: 'd000000000001', title: '옛 문서', body: '본문', createdAt: 1000, updatedAt: 2000 }],
  }), 'utf8');

  assert.strictEqual(ipc.list({ box: BOX2 }, ctx).docs.length, 0, '둘째 편집기는 빈 문서함');
  assert.strictEqual(ipc.list({ box: BOX }, ctx).docs.length, 1, '첫 편집기가 흡수');
});

test('MD-BOX 이행 — 편집기가 아직 배치되지 않았으면 레거시 문서는 보존된다(유실 0)', () => {
  const ctx = ctxWith({ deps: { uiState: uiStateStub([{ iid: 'mail', type: 'mail', name: '' }]) } });
  fs.writeFileSync(ctx.mdDocsPath, JSON.stringify({
    schemaVersion: 1,
    docs: [{ id: 'd000000000001', title: '옛 문서', body: '본문', createdAt: 1000, updatedAt: 2000 }],
  }), 'utf8');

  assert.strictEqual(ipc.list({ box: 'w9' }, ctx).docs.length, 0, '아무나 흡수하지 않는다');
  const raw = mdDocStore.read({ mdDocsPath: ctx.mdDocsPath });
  assert.strictEqual(raw.legacy.length, 1, '레거시는 그대로 보존');
});

/* ───── AI 마크다운 보정 (MD-AI-1) ───── */

/** 마지막 호출 인자를 기록하는 llmClient 목(네트워크 0). reply 로 응답을 지정. */
function stubLlm(reply) {
  const calls = [];
  return {
    calls,
    streamBriefing: async (a) => { calls.push(a); return reply || { ok: true, text: '# 제목\n\n본문', code: 'OK' }; },
  };
}
/** config.briefing 연결이 있는 ctx(보정용). */
function aiCtx(over, reply) {
  const ctx = ctxWith(over);
  ctx.config = { briefing: { baseURL: 'http://127.0.0.1:1234/v1', model: 'local-model', apiKey: '' } };
  ctx.llmClient = stubLlm(reply);
  return ctx;
}

test('MD-AI-1 correct — 선택/전체 텍스트를 교정해 돌려준다(system+user 로 LLM 호출)', async () => {
  const ctx = aiCtx(undefined, { ok: true, text: '# 제목\n\n- 항목', code: 'OK' });
  const r = await ipc.correct({ text: '#제목\n\n-항목' }, ctx);
  assert.ok(r.ok);
  assert.strictEqual(r.text, '# 제목\n\n- 항목', '교정된 마크다운 반환');
  assert.strictEqual(ctx.llmClient.calls.length, 1);
  assert.strictEqual(ctx.llmClient.calls[0].user, '#제목\n\n-항목', '원문이 user 로 전달');
  assert.ok(/마크다운/.test(ctx.llmClient.calls[0].system), 'system 은 마크다운 교정 지시');
});

test('MD-AI-1 correct — 연결 정보(baseURL·model) 없으면 NO_CONN(호출 0)', async () => {
  const ctx = aiCtx();
  ctx.config = { briefing: { baseURL: '', model: '' } };
  const r = await ipc.correct({ text: '# x' }, ctx);
  assert.deepStrictEqual(r, { ok: false, code: 'NO_CONN' });
  assert.strictEqual(ctx.llmClient.calls.length, 0, '연결 없으면 LLM 미호출');
});

test('MD-AI-1 correct — 빈/공백 입력은 BAD_INPUT, 상한 초과는 LIMIT_SIZE', async () => {
  const ctx = aiCtx();
  assert.deepStrictEqual(await ipc.correct({ text: '   \n ' }, ctx), { ok: false, code: 'BAD_INPUT' });
  assert.deepStrictEqual(await ipc.correct({}, ctx), { ok: false, code: 'BAD_INPUT' });
  const big = 'a'.repeat(mdDocStore.MAX_BODY + 1);
  assert.deepStrictEqual(await ipc.correct({ text: big }, ctx), { ok: false, code: 'LIMIT_SIZE' });
});

test('MD-AI-1 correct — 결과 전체를 감싼 코드펜스는 한 겹 벗긴다(내부 펜스 보존)', async () => {
  const ctx = aiCtx(undefined, { ok: true, text: '```markdown\n# 제목\n\n```js\ncode\n```\n```', code: 'OK' });
  const r = await ipc.correct({ text: '# 제목' }, ctx);
  assert.ok(r.ok);
  assert.strictEqual(r.text, '# 제목\n\n```js\ncode\n```', '바깥 한 겹만 제거, 내부 펜스 유지');
});

test('MD-AI-1 correct — LLM 실패 code 는 그대로 전달, 빈 결과는 EMPTY', async () => {
  const ctxErr = aiCtx(undefined, { ok: false, text: '', code: 'CONN_REFUSED' });
  assert.deepStrictEqual(await ipc.correct({ text: '# x' }, ctxErr), { ok: false, code: 'CONN_REFUSED' });
  const ctxEmpty = aiCtx(undefined, { ok: true, text: '   \n  ', code: 'OK' });
  assert.deepStrictEqual(await ipc.correct({ text: '# x' }, ctxEmpty), { ok: false, code: 'EMPTY' });
});

test('MD-AI-1 correct — llmClient 부재/예외는 고정 INTERNAL(스택·URL 비노출)', async () => {
  const ctx = aiCtx();
  ctx.llmClient = null;
  assert.deepStrictEqual(await ipc.correct({ text: '# x' }, ctx), { ok: false, code: 'INTERNAL' });
  const ctxThrow = aiCtx();
  ctxThrow.llmClient = { streamBriefing: async () => { throw new Error('boom http://secret/key'); } };
  assert.deepStrictEqual(await ipc.correct({ text: '# x' }, ctxThrow), { ok: false, code: 'INTERNAL' });
});

test('MD-AI-1 stripWrappingFence — 감싼 펜스만 제거, 아니면 원문 유지', () => {
  assert.strictEqual(ipc.stripWrappingFence('```\nhi\n```'), 'hi');
  assert.strictEqual(ipc.stripWrappingFence('# 제목\n본문'), '# 제목\n본문', '펜스 없으면 그대로');
  assert.strictEqual(ipc.stripWrappingFence('앞\n```\nhi\n```'), '앞\n```\nhi\n```', '전체를 감싼 게 아니면 유지');
});
