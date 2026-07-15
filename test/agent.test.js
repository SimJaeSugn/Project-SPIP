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

  assert.ok(/agent:\s*\{[\s\S]*?run:\s*\(message,\s*history\)/.test(PRELOAD), 'preload agent.run(message, history) 노출');
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

/* ───── [멀티턴 + 컨텍스트 사용현황] ───── */

test('AG-2 runAgent — history(이전 대화)가 프롬프트에 포함되고 usage/promptChars 반환', async () => {
  const seen = [];
  const llm = async (_s, user) => { seen.push(user); return { ok: true, text: '{"final":"네"}', usage: { promptTokens: 123, completionTokens: 7, totalTokens: 130 } }; };
  const history = [{ role: 'user', content: '우유 추가해줘' }, { role: 'assistant', content: '우유를 추가했어요.' }];
  const r = await agent.runAgent({ llm, tools: {}, system: 'S', message: '그거 완료', history, maxSteps: 3 });
  assert.strictEqual(r.ok, true);
  assert.ok(/\[이전 대화\]/.test(seen[0]) && /우유 추가해줘/.test(seen[0]) && /우유를 추가했어요/.test(seen[0]), '이전 대화가 컨텍스트에 포함');
  assert.deepStrictEqual(r.usage, { promptTokens: 123, completionTokens: 7, totalTokens: 130 }, 'usage 반환');
  assert.ok(r.promptChars > 0, '프롬프트 char 수 반환(추정 폴백용)');
});

test('AG-2 estimateTokens — 문자수/토큰 추정(숫자·문자열)', () => {
  assert.strictEqual(agent.estimateTokens(35), 10);
  assert.strictEqual(agent.estimateTokens('1234567'), 2);
});

test('AG-2 IPC — normalizeHistory/trimHistory: 방어 정규화 + 예산 초과 시 오래된 턴 생략', () => {
  const h = agentIpc.normalizeHistory([
    { role: 'user', content: 'a' }, { role: 'bad', content: 'x' }, null,
    { role: 'assistant', content: 'b' }, { role: 'user', content: '   ' },
  ]);
  assert.deepStrictEqual(h, [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }], '역할·빈내용 필터');
  // 예산 20토큰: 큰 오래된 턴은 생략되고 최근 턴 유지.
  const big = { role: 'user', content: 'x'.repeat(200) };     // ~57토큰
  const small = { role: 'assistant', content: '짧게' };
  const t = agentIpc.trimHistory([big, small], 20);
  assert.strictEqual(t.trimmed, true, '예산 초과 → 생략 표시');
  assert.ok(t.history.length < 2 && t.history[t.history.length - 1] === small, '최근 턴 우선 유지');
});

test('AG-2 IPC run — 멀티턴: history 전달 + context 사용현황/제한 반환', async () => {
  const ctx = ctxWithTodos();
  let seenUser = '';
  ctx.llmClient = { streamBriefing: async (a) => { seenUser = a.user; return { ok: true, text: '{"final":"완료"}', usage: { promptTokens: 250, completionTokens: 10 } }; } };
  const history = [{ role: 'user', content: '장보기 추가' }, { role: 'assistant', content: '추가했어요.' }];
  const res = await agentIpc.run({ message: '완료해줘', history }, ctx);
  assert.strictEqual(res.ok, true);
  assert.ok(/장보기 추가/.test(seenUser), '이전 대화가 컨텍스트로 전달');
  assert.ok(res.context && res.context.tokens === 250, '모델 promptTokens 를 컨텍스트 사용량으로');
  assert.strictEqual(res.context.limit, agentIpc.CONTEXT_LIMIT_TOKENS, '제한 기준 반환');
  assert.strictEqual(res.context.source, 'model', 'usage 있으면 정확값');
});

test('AG-2 IPC run — usage 미보고 시 char 추정으로 context.tokens 계산', async () => {
  const ctx = ctxWithTodos();
  ctx.llmClient = { streamBriefing: async () => ({ ok: true, text: '{"final":"ok"}' }) }; // usage 없음
  const res = await agentIpc.run({ message: '할일 목록 보여줘' }, ctx);
  assert.strictEqual(res.ok, true);
  assert.ok(res.context.tokens > 0 && res.context.source === 'estimate', '추정 토큰(>0)');
});

test('AG-2 — 렌더러 멀티턴·미터 배선(turns·history·reset·meter)', () => {
  const ROOT = path.join(__dirname, '..');
  const APP = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  assert.ok(/turns:\s*\[\]/.test(APP), 'wstate.turns(멀티턴 대화)');
  assert.ok(/function agentHistory\(st\)/.test(APP) && /b\.run\(msg,\s*history\)/.test(APP), '이전 대화를 history 로 전달');
  assert.ok(/function agentReset\(iid\)/.test(APP), '새 대화 리셋');
  assert.ok(/function renderAgentMeter\(/.test(APP) && /agent-meter__fill/.test(APP), '컨텍스트 미터 렌더');
  assert.ok(/컨텍스트 .*토큰/.test(APP) && /제한|limit/.test(APP), '사용량/제한 표시');
});

/* ───── [메일 위젯 제어 도구] AG-3 ───── */

function mockMailClient() {
  return {
    async fetchUnseenDigestAll() {
      return { unseen: 2, items: [
        { uid: 10, subject: '회의 안내', from: 'boss@x.com', date: '2026-07-15', mailbox: 'INBOX' },
        { uid: 11, subject: '영수증', from: 'shop@y.com', date: '2026-07-14', mailbox: 'INBOX' },
      ] };
    },
    // 본문은 ASCII(테스트 fixture — charset 헤더 없는 한글은 파서가 깨뜨림). 실제 메일은 Content-Type charset 보유.
    async fetchMessage() { return 'Subject: 회의 안내\r\nFrom: boss@x.com\r\nDate: Tue, 15 Jul 2026 09:00:00 +0900\r\n\r\nPlease prepare for the meeting tomorrow morning.'; },
    async fetchMailIndexAll() { return {}; },
    async deleteMessages() { return; },
  };
}
function ctxWithMail() {
  const ctx = ctxWithTodos();
  ctx.config.mailAccounts = [{ id: 'm1', host: 'imap.x.com', port: 993, secure: true, user: 'me@x.com', pass: 'secret', label: '내 메일' }];
  ctx.mailClientFactory = () => mockMailClient();
  ctx.mailArchivePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'spip-agent-arch-')), 'archive.json');
  return ctx;
}

test('AG-3 — 메일 도구 6종이 buildTools 에 배선', () => {
  const ctx = ctxWithMail();
  const tools = agentIpc.buildTools(ctx);
  for (const name of ['list_mail_accounts', 'get_mail_summary', 'read_mail', 'get_mail_archive', 'sync_mail', 'delete_mail']) {
    assert.strictEqual(typeof tools[name].run, 'function', '도구 배선: ' + name);
  }
  // 시스템 프롬프트가 메일 도구를 설명한다.
  assert.ok(/get_mail_summary/.test(agentIpc.AGENT_SYSTEM) && /delete_mail/.test(agentIpc.AGENT_SYSTEM), '프롬프트에 메일 도구');
  assert.ok(/되돌리기 어렵다|휴지통/.test(agentIpc.AGENT_SYSTEM), '삭제·읽음 신중 지침');
});

test('AG-3 — list_mail_accounts: 자격증명 없이 계정 목록', async () => {
  const tools = agentIpc.buildTools(ctxWithMail());
  const r = await tools.list_mail_accounts.run({});
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.accounts.length, 1);
  assert.strictEqual(r.accounts[0].accountId, 'm1');
  assert.strictEqual(r.accounts[0].email, 'me@x.com');
  assert.ok(!/secret/.test(JSON.stringify(r)), '비밀번호 미노출');
});

test('AG-3 — get_mail_summary: 안 읽은 다이제스트 요약(uid·제목·발신자)', async () => {
  const tools = agentIpc.buildTools(ctxWithMail());
  const r = await tools.get_mail_summary.run({});
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.accounts[0].unseen, 2);
  assert.strictEqual(r.accounts[0].items.length, 2);
  assert.strictEqual(r.accounts[0].items[0].uid, 10);
  assert.strictEqual(r.accounts[0].items[0].subject, '회의 안내');
});

test('AG-3 — read_mail: 본문 열람(요약 반환)', async () => {
  const tools = agentIpc.buildTools(ctxWithMail());
  const r = await tools.read_mail.run({ accountId: 'm1', uid: 10, mailbox: 'INBOX' });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(r.subject, '회의 안내', '제목 파싱');
  assert.ok(/meeting/.test(r.text), '본문 텍스트 반환');
});

test('AG-3 — get_mail_archive: 로컬 보관함 요약(빈 보관함도 계정 구조)', async () => {
  const tools = agentIpc.buildTools(ctxWithMail());
  const r = await tools.get_mail_archive.run({});
  assert.strictEqual(r.ok, true);
  assert.ok(Array.isArray(r.accounts), '계정 배열');
});

test('AG-3 — delete_mail: accountId·mailbox·uid 없으면 거부(추측 삭제 방지)', async () => {
  const tools = agentIpc.buildTools(ctxWithMail());
  assert.strictEqual((await tools.delete_mail.run({})).error, 'need_account_mailbox_uid');
  assert.strictEqual((await tools.delete_mail.run({ accountId: 'm1', uid: 10 })).error, 'need_account_mailbox_uid');
});

test('AG-3 — IPC run: 에이전트가 get_mail_summary 도구로 메일을 확인', async () => {
  const ctx = ctxWithMail();
  const scripted = [
    '{"thought":"안 읽은 메일 확인","tool":"get_mail_summary","args":{}}',
    '{"final":"안 읽은 메일 2통이 있어요: 회의 안내, 영수증."}',
  ];
  let n = 0;
  ctx.llmClient = { streamBriefing: async () => ({ ok: true, text: scripted[n++] }) };
  const res = await agentIpc.run({ message: '안 읽은 메일 알려줘' }, ctx);
  assert.strictEqual(res.ok, true);
  assert.ok(res.steps.some((s) => s.tool === 'get_mail_summary' && /회의 안내/.test(s.observation)), '메일 도구 실행·관찰');
});
