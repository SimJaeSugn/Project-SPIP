'use strict';
/**
 * agent.test.js — 미니 ReAct 에이전트 (AG-1)
 *   ① lib/ai/agent.js 순수 루프: JSON 추출·도구 호출·Observation 누적·final 종료·maxSteps.
 *   ② electron/ipc/agent.js: 할 일 도구 배선(추가/완료/삭제) + 연결/입력 검증 + 트레이스 반환.
 *   모두 llm/tools/ctx 주입으로 네트워크·Electron 없이 헤드리스 검증.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const agent = require('../lib/ai/agent');
const agentIpc = require('../electron/ipc/agent');

/* ───── ① 순수 루프 ───── */

test('AG-1 extractJson — 코드펜스·잡설 속 균형 JSON 추출', () => {
  assert.deepStrictEqual(agent.extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepStrictEqual(agent.extractJson('설명... {"tool":"x","args":{"k":"v"}} 끝'), { tool: 'x', args: { k: 'v' } });
  assert.strictEqual(agent.extractJson('no json here'), null);
  assert.strictEqual(agent.extractJson('{"broken": '), null);
});

test('AG-1 runAgent — 도구 호출 → Observation → final 로 종료', async () => {
  const calls = [];
  // 1번째 호출: list_todos, 2번째: final.
  const scripted = [
    '{"thought":"목록 확인","tool":"list_todos","args":{}}',
    '{"thought":"끝","final":"할 일이 2개 있어요."}',
  ];
  let n = 0;
  const llm = async (_s, _u) => ({ ok: true, text: scripted[n++] });
  const tools = { list_todos: { run: async (a) => { calls.push(a); return { ok: true, todos: [] }; } } };
  const r = await agent.runAgent({ llm, tools, system: 'S', message: '할 일 몇 개야?', maxSteps: 5 });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.final, '할 일이 2개 있어요.');
  assert.strictEqual(calls.length, 1, 'list_todos 1회 실행');
  // 트레이스: 도구 스텝 + 최종 스텝.
  assert.ok(r.steps.some((s) => s.tool === 'list_todos' && /todos/.test(s.observation)), '관찰 누적');
  assert.ok(r.steps.some((s) => s.final), '최종 스텝 기록');
});

test('AG-1 runAgent — 알 수 없는 도구는 관찰로 안내하고 계속', async () => {
  const scripted = ['{"tool":"nope","args":{}}', '{"final":"완료"}'];
  let n = 0;
  const llm = async () => ({ ok: true, text: scripted[n++] });
  const r = await agent.runAgent({ llm, tools: { list_todos: { run: async () => ({}) } }, system: 'S', message: 'x', maxSteps: 4 });
  assert.strictEqual(r.final, '완료');
  assert.ok(r.steps.some((s) => /알 수 없는 도구/.test(s.observation)), '미지 도구 안내');
});

test('AG-1 runAgent — 비JSON 출력은 재시도, maxSteps 초과 시 MAX_STEPS', async () => {
  const llm = async () => ({ ok: true, text: '나는 JSON 을 안 낼래' });
  const r = await agent.runAgent({ llm, tools: {}, system: 'S', message: 'x', maxSteps: 3 });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.code, 'MAX_STEPS');
  assert.strictEqual(r.final, '');
  assert.strictEqual(r.steps.length, 3, '3번 재시도 후 중단');
});

test('AG-1 runAgent — LLM 실패는 즉시 종료(code 전달)', async () => {
  const llm = async () => ({ ok: false, code: 'CONN_REFUSED' });
  const r = await agent.runAgent({ llm, tools: {}, system: 'S', message: 'x' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 'CONN_REFUSED');
});

/* ───── ② 할 일 도구 배선(electron/ipc/agent.js) ───── */

let seq = 0;
function ctxWithTodos() {
  // uiState 핸들러가 쓰는 임시 상태 파일 + 결정적 id/시각 + AI 연결 + 스크립트 LLM.
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'spip-agent-')), 'ui.json');
  let idn = 0;
  return {
    uiStatePath: file,
    genTodoId: () => 't' + (++idn).toString().padStart(12, '0'),
    nowMs: () => 1700000000000,
    config: { briefing: { baseURL: 'http://127.0.0.1:1234/v1', model: 'm' } },
    // llmClient 는 테스트별로 주입.
  };
}

test('AG-1 IPC run — add_todo 도구가 실제로 할 일을 추가하고 todos 를 반환', async () => {
  const ctx = ctxWithTodos();
  const scripted = [
    '{"thought":"추가","tool":"add_todo","args":{"text":"우유 사기"}}',
    '{"thought":"끝","final":"‘우유 사기’를 추가했어요."}',
  ];
  let n = 0;
  ctx.llmClient = { streamBriefing: async () => ({ ok: true, text: scripted[n++] }) };
  const res = await agentIpc.run({ message: '우유 사기 할일 추가' }, ctx);
  assert.strictEqual(res.ok, true, '최종답까지 도달');
  assert.match(res.final, /우유 사기/);
  assert.strictEqual(res.todos.length, 1, '할 일 1개 추가됨');
  assert.strictEqual(res.todos[0].text, '우유 사기');
  assert.ok(res.steps.some((s) => s.tool === 'add_todo'), '트레이스에 add_todo');
});

test('AG-1 IPC run — complete/delete 는 text 부분일치로 대상 지정', async () => {
  const ctx = ctxWithTodos();
  // 선행: 할 일 2개를 직접 추가(도구 배선과 무관하게 fixture).
  const ui = require('../electron/ipc/uiState');
  ui.addTodo({ text: '장보기' }, ctx);
  ui.addTodo({ text: '운동하기' }, ctx);
  const scripted = [
    '{"tool":"complete_todo","args":{"text":"장보기"}}',
    '{"final":"장보기를 완료했어요."}',
  ];
  let n = 0;
  ctx.llmClient = { streamBriefing: async () => ({ ok: true, text: scripted[n++] }) };
  const res = await agentIpc.run({ message: '장보기 완료' }, ctx);
  assert.strictEqual(res.ok, true);
  const done = res.todos.find((t) => t.text === '장보기');
  assert.strictEqual(done.done, true, 'text 부분일치로 완료 처리');
});

test('AG-1 IPC run — 연결 없으면 NO_CONN, 빈 입력은 BAD_INPUT(LLM 미호출)', async () => {
  const ctx = ctxWithTodos();
  let called = 0;
  ctx.llmClient = { streamBriefing: async () => { called++; return { ok: true, text: '{"final":"x"}' }; } };
  assert.deepStrictEqual((await agentIpc.run({ message: '   ' }, ctx)).code, 'BAD_INPUT');
  const noConn = Object.assign({}, ctx, { config: { briefing: { baseURL: '', model: '' } } });
  assert.strictEqual((await agentIpc.run({ message: '할일 추가', ...{} }, noConn)).code, 'NO_CONN');
  assert.strictEqual(called, 0, '검증 실패 시 LLM 미호출');
});

test('AG-1 IPC — findTodo/parseDue 유닛', () => {
  assert.strictEqual(agentIpc.parseDue('2026-07-20 09:30') > 0, true);
  assert.strictEqual(agentIpc.parseDue(''), null);
  assert.strictEqual(agentIpc.parseDue('아무거나'), null);
});

/* ───── ③ 배선(preload·register·enum·위젯) ───── */

test('AG-1 — 3계층 배선(preload agent.run · register 채널 · enum·메타·디스패치)', () => {
  const ROOT = path.join(__dirname, '..');
  const APP = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  const PRELOAD = fs.readFileSync(path.join(ROOT, 'electron', 'preload.js'), 'utf8');
  const REGISTER = fs.readFileSync(path.join(ROOT, 'electron', 'ipc', 'register.js'), 'utf8');
  const STORE = fs.readFileSync(path.join(ROOT, 'lib', 'common', 'uiStateStore.js'), 'utf8');

  assert.ok(/agent:\s*\{[\s\S]*?run:\s*\(message\)/.test(PRELOAD), 'preload agent.run 노출');
  assert.ok(/spip:agent:run/.test(PRELOAD) && /guard\('spip:agent:run'/.test(REGISTER), 'register 채널 배선');

  const { HOME_SECTION_IDS } = require('../public/app.js');
  assert.ok(HOME_SECTION_IDS.includes('agent'), '렌더러 enum');
  const m = STORE.match(/HOME_SECTION_IDS\s*=\s*\[([^\]]*)\]/);
  const mainIds = (m[1].match(/'([a-zA-Z]+)'/g) || []).map((s) => s.replace(/'/g, ''));
  assert.deepStrictEqual(mainIds, HOME_SECTION_IDS, '메인·렌더러 enum 동형(드리프트 0)');

  assert.ok(/agent:\s*\{\s*name:\s*'AI 에이전트'/.test(APP), 'WIDGET_META.agent');
  assert.ok(/case 'agent':\s*return renderHomeAgent\(inst\)/.test(APP), 'renderHomeSection 디스패치');
  assert.ok(/function renderHomeAgent\(inst\)/.test(APP), 'renderHomeAgent 정의');
  assert.ok(/function agentRun\(iid\)/.test(APP), '실행 핸들러');
  // 기본 미배치(갤러리 opt-in).
  const S = require('../lib/common/uiStateStore');
  assert.ok(S.DEFAULT_HIDDEN_WIDGETS.includes('agent') && !S.defaultHomeWidgets().some((w) => w.type === 'agent'), '기본 미배치');
  // L-1: 렌더 innerHTML 미사용.
  assert.ok(!/renderHomeAgent[\s\S]{0,1500}innerHTML/.test(APP), 'agent 렌더 innerHTML 미사용(L-1)');
});
