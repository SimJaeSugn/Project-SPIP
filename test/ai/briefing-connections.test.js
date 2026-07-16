'use strict';
/**
 * test/ai/briefing-connections.test.js — 복수 AI 연결(추가·활성화·삭제) 전체 계약
 *   ① 레지스트리(lib/ai/briefingConnections.js) 순수 CRUD·미러 불변식·공개뷰
 *   ② config.loadConfig 레거시 이행(briefing → 첫 연결 승격, 무손실)
 *   ③ IPC(electron/ipc/briefingConnections.js) 목록/활성/추가/삭제 + persist(3키) + apiKey 미노출
 *   ④ briefing.setSettings 가 활성 연결을 편집(미러 불변식 유지)
 *   ⑤ 3계층 배선(preload 채널·register guard·app.js 핸들러/store·CSS)
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const reg = require('../../lib/ai/briefingConnections');
const config = require('../../lib/common/config');
const connIpc = require('../../electron/ipc/briefingConnections');
const briefing = require('../../electron/ipc/briefing');

const NORM = (inp) => config.normalizeBriefing(inp);
/** 결정적 id 생성기(레지스트리 단위테스트용). ID_RE(6~32 소문자·숫자) 충족. */
function idGen() { let n = 0; return () => 'id' + String(++n).padStart(4, '0'); }
function fakeFs() {
  return {
    readFileSync: () => { throw new Error('ENOENT'); },
    openSync: () => 1, writeFileSync: () => {}, fsyncSync: () => {}, closeSync: () => {},
    chmodSync: () => {}, renameSync: () => {}, existsSync: () => false, unlinkSync: () => {},
  };
}

/* ───── ① 레지스트리(순수) ───── */

test('AICONN-1 normalizeConnections — 불량 폐기·enabled 제거·id 부여', () => {
  const deps = { normalizeSettings: NORM, genId: idGen() };
  const out = reg.normalizeConnections([
    { label: 'A', baseURL: 'http://127.0.0.1:1/v1', model: 'm1', apiKey: 'k1', enabled: true },
    'garbage',
    { label: 'B', baseURL: 'http://127.0.0.1:2/v1', model: 'm2' },
  ], deps);
  assert.strictEqual(out.length, 2, '불량 엔트리 폐기');
  assert.ok(!('enabled' in out[0]), '연결 엔트리에 전역 enabled 없음');
  assert.match(out[0].id, /^id\d+$/);
  assert.strictEqual(out[0].label, 'A');
  assert.strictEqual(out[0].apiKey, 'k1', 'apiKey 평문 보존(메모리)');
});

test('AICONN-2 addConnection — 추가 + 개수 상한(LIMIT)', () => {
  const deps = { normalizeSettings: NORM, genId: idGen() };
  const r = reg.addConnection([], { label: 'X', baseURL: 'http://127.0.0.1:1/v1', model: 'm' }, deps);
  assert.ok(r.ok);
  assert.strictEqual(r.connections.length, 1);
  const many = Array.from({ length: reg.MAX_CONNECTIONS }, (_, i) => ({ label: 'c' + i, baseURL: 'http://127.0.0.1:1/v1', model: 'm' }));
  const lim = reg.addConnection(many, { label: 'over', baseURL: 'http://127.0.0.1:1/v1', model: 'm' }, deps);
  assert.strictEqual(lim.ok, false);
  assert.strictEqual(lim.code, 'LIMIT');
});

test('AICONN-3 updateConnection — apiKey/label 미전송 유지, NOT_FOUND', () => {
  const deps = { normalizeSettings: NORM, genId: idGen() };
  const added = reg.addConnection([], { label: 'X', baseURL: 'http://127.0.0.1:1/v1', model: 'm', apiKey: 'sk-1' }, deps);
  const id = added.connection.id;
  const upd = reg.updateConnection(added.connections, id, { model: 'm2' }, deps);
  assert.ok(upd.ok);
  assert.strictEqual(upd.connection.model, 'm2');
  assert.strictEqual(upd.connection.apiKey, 'sk-1', 'apiKey 유지');
  assert.strictEqual(upd.connection.label, 'X', 'label 유지');
  assert.strictEqual(reg.updateConnection(added.connections, 'nope', {}, deps).code, 'NOT_FOUND');
});

test('AICONN-4 toPublicList — apiKey 평문 제거·hasApiKey', () => {
  const pub = reg.toPublicList([{ id: 'a1b2c3', label: 'L', baseURL: 'u', model: 'm', apiKey: 'sk-x' }]);
  assert.strictEqual(pub.length, 1);
  assert.ok(!('apiKey' in pub[0]), '공개뷰에 apiKey 없음');
  assert.strictEqual(pub[0].hasApiKey, true);
});

test('AICONN-5 resolveState — 빈 목록은 briefing에서 첫 연결 승격(무손실) + 미러', () => {
  const deps = { normalizeSettings: NORM, genId: idGen() };
  const briefingIn = { enabled: true, baseURL: 'http://127.0.0.1:9/v1', model: 'legacy', apiKey: 'sk-legacy' };
  const s = reg.resolveState(briefingIn, [], '', deps);
  assert.strictEqual(s.connections.length, 1);
  assert.strictEqual(s.connections[0].model, 'legacy');
  assert.strictEqual(s.connections[0].apiKey, 'sk-legacy');
  assert.strictEqual(s.activeId, s.connections[0].id);
  assert.strictEqual(s.briefing.model, 'legacy', 'briefing = 활성 연결 미러');
  assert.strictEqual(s.briefing.enabled, true, '전역 enabled 보존');
  assert.ok(!('id' in s.briefing) && !('label' in s.briefing), 'briefing엔 id/label 없음');
});

test('AICONN-6 resolveState — 잘못된/전환 activeId 미러', () => {
  const deps = { normalizeSettings: NORM, genId: idGen() };
  const conns = reg.normalizeConnections([
    { id: 'aaaaaa', label: 'A', baseURL: 'http://127.0.0.1:1/v1', model: 'ma', apiKey: 'ka' },
    { id: 'bbbbbb', label: 'B', baseURL: 'http://127.0.0.1:2/v1', model: 'mb' },
  ], deps);
  assert.strictEqual(reg.resolveState({ enabled: false }, conns, 'ghost', deps).activeId, 'aaaaaa', '없는 id는 첫 연결로');
  assert.strictEqual(reg.resolveState({ enabled: false }, conns, 'bbbbbb', deps).briefing.model, 'mb', '활성 전환 미러');
});

/* ───── ② config 이행(loadConfig) ───── */

test('AICONN-7 loadConfig — 레거시 briefing만 있어도 연결 목록·활성 이행(무손실)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spip-aiconn-'));
  const p = path.join(dir, 'config.json');
  fs.writeFileSync(p, JSON.stringify({ briefing: { enabled: true, baseURL: 'http://127.0.0.1:1234/v1', model: 'legacy-model', apiKey: 'sk-x' } }));
  const { config: cfg } = config.loadConfig({ configPath: p, logger: { warn() {}, error() {}, info() {} } });
  assert.ok(Array.isArray(cfg.briefingConnections));
  assert.strictEqual(cfg.briefingConnections.length, 1);
  assert.strictEqual(cfg.briefingConnections[0].model, 'legacy-model');
  assert.strictEqual(cfg.activeBriefingId, cfg.briefingConnections[0].id);
  assert.strictEqual(cfg.briefing.model, 'legacy-model', 'briefing은 활성 연결 미러');
  assert.strictEqual(cfg.briefing.apiKey, 'sk-x', 'apiKey 무손실 이행');
});

/* ───── ③ IPC ───── */

function ipcCtx(initialBriefing) {
  const persisted = [];
  const b = initialBriefing || { enabled: false, baseURL: 'http://127.0.0.1:1234/v1', model: 'm0', apiKey: '' };
  const s = reg.resolveState(b, [], '', { normalizeSettings: NORM });
  const ctx = {
    config: { briefing: s.briefing, briefingConnections: s.connections, activeBriefingId: s.activeId },
    logger: { warn() {}, error() {}, info() {} },
    persistConfigKeys: (patch) => { persisted.push(patch); },
  };
  return { ctx, persisted };
}

test('AICONN-8 IPC getConnections — 목록+활성, apiKey 미노출', () => {
  const { ctx } = ipcCtx({ enabled: false, baseURL: 'http://127.0.0.1:1234/v1', model: 'm0', apiKey: 'sk-secret' });
  const r = connIpc.getConnections(null, ctx);
  assert.ok(r.ok);
  assert.strictEqual(r.connections.length, 1);
  assert.strictEqual(r.activeId, r.connections[0].id);
  assert.ok(!('apiKey' in r.connections[0]));
  assert.strictEqual(r.connections[0].hasApiKey, true);
  assert.ok(!JSON.stringify(r).includes('sk-secret'), 'apiKey 평문 미회송');
});

test('AICONN-9 IPC addConnection — 추가+즉시활성+persist(3키)+briefing 미러', () => {
  const { ctx, persisted } = ipcCtx();
  const r = connIpc.addConnection({ label: '두번째' }, ctx);
  assert.ok(r.ok);
  assert.strictEqual(r.connections.length, 2);
  const added = r.connections.find((c) => c.label === '두번째');
  assert.strictEqual(r.activeId, added.id, '추가 연결이 활성');
  assert.strictEqual(ctx.config.briefingConnections.length, 2);
  assert.strictEqual(ctx.config.activeBriefingId, added.id);
  assert.strictEqual(ctx.config.briefing.model, config.DEFAULTS.briefing.model, 'briefing 미러 = 새 활성(기본값)');
  const last = persisted[persisted.length - 1];
  assert.ok(last.briefing && Array.isArray(last.briefingConnections) && typeof last.activeBriefingId === 'string', 'persist 3키');
});

test('AICONN-10 IPC activateConnection — 활성 전환+미러, NOT_FOUND', () => {
  const { ctx } = ipcCtx();
  const firstId = ctx.config.briefingConnections[0].id;
  connIpc.addConnection({ label: 'B' }, ctx); // B 활성
  const r = connIpc.activateConnection({ id: firstId }, ctx);
  assert.ok(r.ok);
  assert.strictEqual(ctx.config.activeBriefingId, firstId);
  assert.strictEqual(connIpc.activateConnection({ id: 'ghostghost' }, ctx).code, 'NOT_FOUND');
});

test('AICONN-11 IPC removeConnection — 마지막 1개 LAST, 활성 삭제 시 재배정', () => {
  const { ctx } = ipcCtx();
  assert.strictEqual(connIpc.removeConnection({ id: ctx.config.briefingConnections[0].id }, ctx).code, 'LAST');
  connIpc.addConnection({ label: 'B' }, ctx); // B 활성
  const bId = ctx.config.activeBriefingId;
  const aId = ctx.config.briefingConnections.find((c) => c.id !== bId).id;
  const r = connIpc.removeConnection({ id: bId }, ctx);
  assert.ok(r.ok);
  assert.strictEqual(ctx.config.briefingConnections.length, 1);
  assert.strictEqual(ctx.config.activeBriefingId, aId, '남은 연결로 활성 이동');
});

/* ───── ④ setSettings 가 활성 연결을 편집(미러 불변식) ───── */

test('AICONN-12 setSettings — 활성 연결 편집(미러 유지) + apiKey 미노출', () => {
  const s = reg.resolveState({ enabled: false, baseURL: 'http://127.0.0.1:1234/v1', model: 'm0', apiKey: 'sk-old' }, [], '', { normalizeSettings: NORM });
  const ctx = {
    config: { briefing: s.briefing, briefingConnections: s.connections, activeBriefingId: s.activeId },
    configDeps: { fs: fakeFs(), paths: { configPath: () => '/x', ensureDirFor: () => '/x' }, elevationState: { isElevated: () => true } },
  };
  const r = briefing.setSettings({ model: 'edited', label: '내 연결' }, ctx);
  assert.strictEqual(r.ok, true);
  const active = ctx.config.briefingConnections.find((c) => c.id === ctx.config.activeBriefingId);
  assert.strictEqual(active.model, 'edited', '활성 연결 엔트리 반영');
  assert.strictEqual(active.label, '내 연결');
  assert.strictEqual(active.apiKey, 'sk-old', 'apiKey 유지');
  assert.strictEqual(ctx.config.briefing.model, 'edited', 'briefing 미러 유지');
  assert.strictEqual(r.apiKey, undefined, '응답 apiKey 평문 없음');
  assert.ok(Array.isArray(r.connections) && r.connections.some((c) => c.label === '내 연결'), 'getSettings에 연결 목록 포함');
});

/* ───── ⑤ 3계층 배선 ───── */

test('AICONN-13 배선 — preload 채널·register guard·app.js 핸들러/store·CSS', () => {
  const ROOT = path.join(__dirname, '..', '..');
  const PRELOAD = fs.readFileSync(path.join(ROOT, 'electron', 'preload.js'), 'utf8');
  const REGISTER = fs.readFileSync(path.join(ROOT, 'electron', 'ipc', 'register.js'), 'utf8');
  const APP = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  const CSS = fs.readFileSync(path.join(ROOT, 'public', 'styles.css'), 'utf8');
  for (const ch of ['getConnections', 'addConnection', 'removeConnection', 'activateConnection']) {
    assert.ok(new RegExp('spip:briefing:' + ch).test(PRELOAD), 'preload 채널 ' + ch);
    assert.ok(new RegExp("guard\\('spip:briefing:" + ch).test(REGISTER), 'register guard ' + ch);
  }
  assert.ok(/function onAddBriefingConnection/.test(APP) && /function onActivateBriefingConnection/.test(APP) && /function onRemoveBriefingConnection/.test(APP), 'app 핸들러');
  assert.ok(/store\.briefing\.connections/.test(APP) && /store\.briefing\.activeId/.test(APP), 'store 연결 상태');
  assert.ok(/briefing-conn__pick/.test(APP) && /\.briefing-conn__pick/.test(CSS), '연결 목록 UI/CSS');
});

test('AICONN-14 포커스 유실 방지 — 재렌더 시 close.focus 미강탈·업데이트 렌더 좁힘·data-fk 보존', () => {
  const ROOT = path.join(__dirname, '..', '..');
  const APP = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  // ① 모달 초기 포커스는 최초 열림(enter)에만 — 재렌더마다 close.focus() 로 입력 포커스 강탈 금지.
  assert.ok(APP.includes('if (opts.enter !== false) setTimeout(() => { try { close.focus('), 'buildModal close.focus 는 enter일 때만');
  // ② 업데이트 진행률 재렌더는 '업데이트' 탭일 때만(다른 설정 탭 편집 중 다운로드 진행률이 폼을 재렌더→포커스 강탈 방지).
  assert.ok((APP.match(/store\.showSettings && store\.settingsTab === 'update'/g) || []).length >= 2, '업데이트 렌더 좁힘(2곳)');
  // ③ 연결 입력에 안정 포커스 키(data-fk) — 같은 클래스 입력이 여럿이어도 정확한 칸으로 캐럿 복원.
  for (const fk of ['briefing.label', 'briefing.baseURL', 'briefing.model', 'briefing.systemPrompt', 'briefing.apiKey']) {
    assert.ok(APP.includes("'data-fk': '" + fk + "'"), 'data-fk ' + fk);
  }
  assert.ok(/ae\.dataset\.fk/.test(APP) && /\[data-fk="/.test(APP), 'preserve capture/restore 가 data-fk 처리');
});
