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
  // [하이브리드] 계획 → 실행(도구) → 최종 → 검증 순으로 LLM 이 응답한다.
  const scripted = [
    '{"plan":["할 일을 추가한다"]}',
    '{"thought":"추가","tool":"add_todo","args":{"text":"우유 사기"}}',
    '{"thought":"끝","final":"‘우유 사기’를 추가했어요."}',
    '{"is_valid":true,"critique":""}',
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
    '{"plan":["장보기를 완료한다"]}',
    '{"tool":"complete_todo","args":{"text":"장보기"}}',
    '{"final":"장보기를 완료했어요."}',
    '{"is_valid":true,"critique":""}',
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
  const seenUsers = [];
  ctx.llmClient = { streamBriefing: async (a) => { seenUsers.push(a.user); return { ok: true, text: '{"final":"완료"}', usage: { promptTokens: 250, completionTokens: 10 } }; } };
  const history = [{ role: 'user', content: '장보기 추가' }, { role: 'assistant', content: '추가했어요.' }];
  const res = await agentIpc.run({ message: '완료해줘', history }, ctx);
  assert.strictEqual(res.ok, true);
  assert.ok(seenUsers.some((u) => /장보기 추가/.test(u)), '이전 대화가 컨텍스트로 전달(계획·실행 프롬프트)');
  assert.ok(res.context && res.context.tokens === 250, '모델 promptTokens 를 컨텍스트 사용량으로');
  assert.strictEqual(res.context.limit, agentIpc.CONTEXT_WINDOW_TOKENS, '제한 = 모델 컨텍스트 창(32768)');
  assert.strictEqual(agentIpc.CONTEXT_WINDOW_TOKENS, 32768, '컨텍스트 창 최대치');
  assert.ok(agentIpc.CONTEXT_HISTORY_BUDGET < agentIpc.CONTEXT_WINDOW_TOKENS, 'history 예산 < 창(여유 확보)');
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
    '{"plan":["안 읽은 메일을 확인한다"]}',
    '{"thought":"안 읽은 메일 확인","tool":"get_mail_summary","args":{}}',
    '{"final":"안 읽은 메일 2통이 있어요: 회의 안내, 영수증."}',
    '{"is_valid":true,"critique":""}',
  ];
  let n = 0;
  ctx.llmClient = { streamBriefing: async () => ({ ok: true, text: scripted[n++] }) };
  const res = await agentIpc.run({ message: '안 읽은 메일 알려줘' }, ctx);
  assert.strictEqual(res.ok, true);
  assert.ok(res.steps.some((s) => s.tool === 'get_mail_summary' && /회의 안내/.test(s.observation)), '메일 도구 실행·관찰');
});

/* ───── [메일 UI 액티브 이벤트] AG-4 — open_mailbox / open_mail ───── */

test('AG-4 — open_mailbox: uiAction 수집(계정·메일함 선택 옵션)', async () => {
  const ua = [];
  const tools = agentIpc.buildTools(ctxWithMail(), ua);
  const r = await tools.open_mailbox.run({ accountId: 'm1', mailbox: 'INBOX' });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(ua[0], { type: 'open_mailbox', accountId: 'm1', mailbox: 'INBOX' });
  await tools.open_mailbox.run({}); // 인자 없이도 열기
  assert.deepStrictEqual(ua[1], { type: 'open_mailbox' });
});

test('AG-4 — open_mail: uiAction 수집 + 인자 검증(accountId·uid 필수)', async () => {
  const ua = [];
  const tools = agentIpc.buildTools(ctxWithMail(), ua);
  const r = await tools.open_mail.run({ accountId: 'm1', uid: 10, mailbox: 'INBOX', subject: '회의 안내' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(ua[0].type, 'open_mail');
  assert.strictEqual(ua[0].accountId, 'm1');
  assert.strictEqual(ua[0].uid, 10);
  const bad = await tools.open_mail.run({ uid: 10 });
  assert.strictEqual(bad.error, 'need_account_uid');
  assert.strictEqual(ua.length, 1, '검증 실패 시 UI 액션 미수집');
});

test('AG-4 — IPC run: 에이전트가 open_mailbox 하면 uiActions 로 반환', async () => {
  const ctx = ctxWithMail();
  const scripted = [
    '{"plan":["메일함을 연다"]}',
    '{"thought":"메일함 열기","tool":"open_mailbox","args":{}}',
    '{"final":"메일함을 열었어요."}',
    '{"is_valid":true,"critique":""}',
  ];
  let n = 0;
  ctx.llmClient = { streamBriefing: async () => ({ ok: true, text: scripted[n++] }) };
  const res = await agentIpc.run({ message: '메일함 열어줘' }, ctx);
  assert.strictEqual(res.ok, true);
  assert.ok(Array.isArray(res.uiActions) && res.uiActions.some((x) => x.type === 'open_mailbox'), 'uiActions 에 open_mailbox');
  // 프롬프트에 UI 도구 설명.
  assert.ok(/open_mailbox/.test(agentIpc.AGENT_SYSTEM) && /open_mail\b/.test(agentIpc.AGENT_SYSTEM), '프롬프트에 UI 열기 도구');
});

test('AG-4 — 렌더러: agentApplyUiActions 가 openMailbox/openMailMessage 실행 + agentRun 배선', () => {
  const ROOT = path.join(__dirname, '..');
  const APP = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  assert.ok(/function agentApplyUiActions\(actions\)/.test(APP), 'UI 액션 실행기 정의');
  assert.ok(/agentApplyUiActions\(res\.uiActions\)/.test(APP), 'agentRun 이 uiActions 실행');
  assert.ok(/'open_mailbox'[\s\S]{0,400}openMailbox\(\)/.test(APP), 'open_mailbox → openMailbox()');
  assert.ok(/'open_mail'[\s\S]{0,500}openMailMessage\(a\.accountId/.test(APP), 'open_mail → openMailMessage()');
});

/* ───── [전 위젯 제어 도구] AG-5 ───── */

function ctxAllWidgets() {
  const ctx = ctxWithTodos();
  ctx.store = { schemaVersion: 1, generatedAt: null, hasSnapshot: true, stats: { totalBytes: 1000 },
    getProjects: () => [
      { name: 'proj-a', path: '/x/proj-a', language: { primary: 'JavaScript' }, git: { dirty: true, ahead: 2, behind: 0 }, freshness: { isStale: false }, lastModified: '2026-07-15' },
      { name: 'proj-b', path: '/x/proj-b', language: { primary: 'Python' }, git: { dirty: false }, freshness: { isStale: true }, lastModified: '2026-01-01' },
    ] };
  return ctx;
}

test('AG-5 — 전 위젯 도구가 buildTools 에 배선(28개+)', () => {
  const tools = agentIpc.buildTools(ctxAllWidgets(), []);
  const need = ['list_projects', 'get_project_stats', 'get_commit_activity', 'get_system_status', 'get_token_usage',
    'list_bookmarks', 'add_bookmark', 'remove_bookmark', 'list_memos', 'set_memo',
    'list_documents', 'read_document', 'list_explorer_roots', 'list_folder', 'refresh_briefing'];
  for (const n of need) assert.strictEqual(typeof tools[n].run, 'function', '도구 배선: ' + n);
  assert.ok(Object.keys(tools).length >= 28, '총 28개 이상 도구');
  // 프롬프트가 새 위젯 도구를 설명.
  for (const n of ['list_projects', 'get_system_status', 'list_bookmarks', 'set_memo', 'refresh_briefing']) {
    assert.ok(new RegExp(n).test(agentIpc.AGENT_SYSTEM), '프롬프트에 ' + n);
  }
});

test('AG-5 — list_projects/get_project_stats: 스캔 store 를 소형 뷰로', async () => {
  const tools = agentIpc.buildTools(ctxAllWidgets(), []);
  const p = await tools.list_projects.run({});
  assert.strictEqual(p.ok, true);
  assert.strictEqual(p.count, 2);
  assert.strictEqual(p.projects[0].name, 'proj-a');
  assert.strictEqual(p.projects[0].dirty, true);
  assert.strictEqual(p.projects[1].isStale, true);
  const s = await tools.get_project_stats.run({});
  assert.strictEqual(s.total, 2);
  assert.strictEqual(s.staleCount, 1);
});

test('AG-5 — 인자 검증(추측 방지): set_memo/remove_bookmark/read_document/list_folder', async () => {
  const tools = agentIpc.buildTools(ctxAllWidgets(), []);
  assert.strictEqual((await tools.set_memo.run({})).error, 'need_text');
  assert.strictEqual((await tools.remove_bookmark.run({})).error, 'need_id');
  assert.strictEqual((await tools.list_folder.run({})).error, 'need_path');
  // 배치된 편집기/메모 위젯이 없으면 명확한 코드로 거부.
  assert.strictEqual((await tools.list_documents.run({})).error, 'no_editor_widget');
  assert.strictEqual((await tools.set_memo.run({ text: 'hi' })).error, 'no_memo_widget');
});

test('AG-5 — IPC run: 에이전트가 list_projects 도구로 현황을 조회', async () => {
  const ctx = ctxAllWidgets();
  const scripted = [
    '{"plan":["프로젝트 목록을 확인한다"]}',
    '{"tool":"list_projects","args":{}}',
    '{"final":"프로젝트 2개 중 1개가 방치 상태예요."}',
    '{"is_valid":true,"critique":""}',
  ];
  let n = 0;
  ctx.llmClient = { streamBriefing: async () => ({ ok: true, text: scripted[n++] }) };
  const res = await agentIpc.run({ message: '방치된 프로젝트 알려줘' }, ctx);
  assert.strictEqual(res.ok, true);
  assert.ok(res.steps.some((s) => s.tool === 'list_projects' && /proj-b/.test(s.observation)), 'list_projects 실행·관찰');
});

/* ───── [마크다운·메모 추가 기능] AG-6 ───── */

function ctxWithWidgets() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spip-agent-w-'));
  const uiPath = path.join(dir, 'ui.json');
  const mdPath = path.join(dir, 'md.json');
  // 편집기·메모 인스턴스를 배치한 상태를 시드(firstWidgetIid 가 해석).
  fs.writeFileSync(uiPath, JSON.stringify({
    schemaVersion: 6,
    homeWidgets: [{ iid: 'md1', type: 'mdedit', name: '' }, { iid: 'memo1', type: 'scratchpad', name: '' }],
    scratchpads: {},
  }), 'utf8');
  let idn = 0;
  return { uiStatePath: uiPath, mdDocsPath: mdPath, genTodoId: () => 't' + (++idn), nowMs: () => 1700000000000, config: { briefing: { baseURL: 'x', model: 'm' } } };
}

test('AG-6 메모 — set/get/append/clear 왕복', async () => {
  const tools = agentIpc.buildTools(ctxWithWidgets(), []);
  assert.strictEqual((await tools.set_memo.run({ text: '첫 줄' })).ok, true);
  assert.strictEqual((await tools.get_memo.run({})).text, '첫 줄');
  assert.strictEqual((await tools.append_memo.run({ text: '둘째 줄' })).ok, true);
  assert.strictEqual((await tools.get_memo.run({})).text, '첫 줄\n둘째 줄', '기존 보존하고 줄 추가');
  assert.strictEqual((await tools.clear_memo.run({})).ok, true);
  assert.strictEqual((await tools.get_memo.run({})).text, '', '비움');
});

test('AG-6 마크다운 — create/list/read/update/delete 왕복', async () => {
  const tools = agentIpc.buildTools(ctxWithWidgets(), []);
  const c = await tools.create_document.run({ title: '회의록', body: '# 회의록\n\n내용' });
  assert.strictEqual(c.ok, true, JSON.stringify(c));
  const id = c.id;
  const l = await tools.list_documents.run({});
  assert.ok(l.docs.some((d) => d.id === id), '목록에 새 문서');
  assert.match((await tools.read_document.run({ id })).body, /내용/);
  assert.strictEqual((await tools.update_document.run({ id, body: '# 회의록\n\n수정됨' })).ok, true);
  assert.match((await tools.read_document.run({ id })).body, /수정됨/);
  assert.strictEqual((await tools.delete_document.run({ id })).ok, true);
  assert.strictEqual((await tools.read_document.run({ id })).error, 'not_found', '삭제 후엔 없음');
});

test('AG-6 마크다운 — correct_document 가 문법 보정 후 저장', async () => {
  const ctx = ctxWithWidgets();
  ctx.llmClient = { streamBriefing: async () => ({ ok: true, text: '# 제목\n\n- 항목' }) }; // 보정된 마크다운
  const tools = agentIpc.buildTools(ctx, []);
  const c = await tools.create_document.run({ title: 't', body: '#제목\n\n-항목' });
  const r = await tools.correct_document.run({ id: c.id });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual((await tools.read_document.run({ id: c.id })).body, '# 제목\n\n- 항목', '보정 결과 저장');
});

test('AG-6 — 프롬프트에 신규 메모·문서 도구 설명', () => {
  for (const n of ['get_memo', 'append_memo', 'clear_memo', 'create_document', 'update_document', 'delete_document', 'correct_document']) {
    assert.ok(new RegExp(n).test(agentIpc.AGENT_SYSTEM), '프롬프트: ' + n);
  }
});

/* ───── [스크롤 위치 보존] AG-7 ───── */

test('AG-7 — 트랜스크립트 스크롤 위치 인스턴스별 보존 배선', () => {
  const ROOT = path.join(__dirname, '..');
  const APP = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  // wstate 에 스크롤 위치 필드.
  assert.ok(/_scroll:\s*0[\s\S]{0,80}트랜스크립트 스크롤/.test(APP) || /_scroll:\s*0,/.test(APP), 'wstate._scroll');
  // agent-body 스크롤 리스너가 위치 저장(복원 중엔 스킵).
  assert.ok(/on:\s*\{\s*scroll:[\s\S]{0,120}st\._scroll\s*=\s*e\.target\.scrollTop/.test(APP), '스크롤 저장 리스너');
  assert.ok(/!st\._restoring/.test(APP), '복원 중 저장 스킵 가드');
  // RG.widget 이 render 후 위치를 2-rAF 로 복원.
  assert.ok(/id:\s*'agentScroll'/.test(APP), 'agentScroll 위젯');
  assert.ok(/\.agent-body[\s\S]{0,600}scrollTop\s*=\s*t\.st\._scroll/.test(APP), 'agent-body 스크롤 복원');
  assert.ok(/requestAnimationFrame\([\s\S]{0,120}requestAnimationFrame/.test(APP), '레이아웃 앉은 뒤 2-rAF 복원');
});

/* ───── [Planner + Reflector 하이브리드] AG-8 ───── */

test('AG-8 runHybrid — 계획→실행→검증(통과) 흐름·트레이스 단계', async () => {
  const script = [
    '{"plan":["할 일 목록 확인"]}',
    '{"tool":"list_todos","args":{}}',
    '{"final":"할 일이 없어요."}',
    '{"is_valid":true,"critique":""}',
  ];
  let i = 0;
  const llm = async () => ({ ok: true, text: script[i++] });
  const tools = { list_todos: { run: async () => ({ ok: true, todos: [] }) } };
  const r = await agent.runHybrid({ llm, tools, system: 'S', plannerSystem: 'P', reflectorSystem: 'R', message: '할일?', maxSteps: 4, maxReplans: 1 });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.final, '할 일이 없어요.');
  assert.strictEqual(r.replans, 0, '검증 통과 → 재계획 없음');
  const phases = r.steps.map((s) => s.phase || (s.tool ? 'tool' : (s.final ? 'final' : '?')));
  assert.deepStrictEqual(phases, ['plan', 'tool', 'final', 'reflect'], '트레이스 단계 순서');
  assert.strictEqual(r.steps.find((s) => s.phase === 'reflect').is_valid, true);
});

test('AG-8 runHybrid — 검증 실패 시 재계획 후 재실행(최종은 2차 시도)', async () => {
  const script = [
    '{"plan":["대충"]}', '{"final":"대충 함"}', '{"is_valid":false,"critique":"도구 미사용"}',
    '{"plan":["도구로 확인"]}', '{"tool":"list_todos","args":{}}', '{"final":"제대로 확인"}', '{"is_valid":true,"critique":""}',
  ];
  let i = 0;
  const llm = async () => ({ ok: true, text: script[i++] });
  const tools = { list_todos: { run: async () => ({ ok: true, todos: [] }) } };
  const r = await agent.runHybrid({ llm, tools, system: 'S', plannerSystem: 'P', reflectorSystem: 'R', message: 'x', maxSteps: 4, maxReplans: 1 });
  assert.strictEqual(r.final, '제대로 확인', '2차 시도 결과 채택');
  assert.strictEqual(r.replans, 1, '1회 재계획');
  assert.ok(r.steps.filter((s) => s.phase === 'plan').length === 2, '계획 2회(초기+재계획)');
  assert.ok(r.steps.some((s) => s.phase === 'plan' && s.replan && /도구 미사용/.test(s.critique)), '재계획에 피드백 반영');
});

test('AG-8 runHybrid — maxReplans 도달 시 무한루프 없이 종료', async () => {
  // 항상 무효 판정 → maxReplans=1 이면 계획 2회로 멈춘다.
  const llm = async (_s, u) => ({ ok: true, text: /is_valid/.test('') ? '' : (/\[계획\]|검증/.test(u) ? '{"is_valid":false,"critique":"부족"}' : '{"plan":["p"]}') });
  // 더 단순하게: 스크립트로 항상 무효.
  const script = [
    '{"plan":["p1"]}', '{"final":"a1"}', '{"is_valid":false,"critique":"부족"}',
    '{"plan":["p2"]}', '{"final":"a2"}', '{"is_valid":false,"critique":"부족"}',
  ];
  let i = 0;
  const llm2 = async () => ({ ok: true, text: script[i++] || '{"final":"end"}' });
  const r = await agent.runHybrid({ llm: llm2, tools: {}, system: 'S', plannerSystem: 'P', reflectorSystem: 'R', message: 'x', maxSteps: 3, maxReplans: 1 });
  assert.strictEqual(r.replans, 1, 'maxReplans=1 에서 멈춤');
  assert.strictEqual(r.steps.filter((s) => s.phase === 'plan').length, 2, '계획 최대 2회');
});

test('AG-8 planStep/reflectStep — 유닛', async () => {
  const p = await agent.planStep(async () => ({ ok: true, text: '{"plan":["a","b"]}' }), { system: 'P', message: 'x' });
  assert.deepStrictEqual(p.plan, ['a', 'b']);
  assert.strictEqual(p.ok, true);
  const rf = await agent.reflectStep(async () => ({ ok: true, text: '{"is_valid":false,"critique":"c"}' }), { system: 'R', message: 'x', plan: [], final: 'f', steps: [] });
  assert.strictEqual(rf.is_valid, false);
  assert.strictEqual(rf.critique, 'c');
  // 검증 파싱 실패 → 안전하게 통과(무한루프 방지)
  const rf2 = await agent.reflectStep(async () => ({ ok: true, text: '검증 못함' }), { system: 'R', message: 'x' });
  assert.strictEqual(rf2.is_valid, true);
});

test('AG-8 IPC run — 응답 steps 에 plan·reflect 단계 포함', async () => {
  const ctx = ctxWithTodos();
  const script = ['{"plan":["할 일 확인"]}', '{"tool":"list_todos","args":{}}', '{"final":"없어요"}', '{"is_valid":true,"critique":""}'];
  let i = 0;
  ctx.llmClient = { streamBriefing: async () => ({ ok: true, text: script[i++] }) };
  const res = await agentIpc.run({ message: '할일?' }, ctx);
  assert.strictEqual(res.ok, true);
  assert.ok(res.steps.some((s) => s.phase === 'plan'), 'plan 단계');
  assert.ok(res.steps.some((s) => s.phase === 'reflect' && s.is_valid === true), 'reflect 단계');
});

test('AG-8 — 렌더러가 plan·reflect 단계를 표시', () => {
  const ROOT = path.join(__dirname, '..');
  const APP = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  const CSS = fs.readFileSync(path.join(ROOT, 'public', 'styles.css'), 'utf8');
  assert.ok(/st\.phase === 'plan'/.test(APP) && /agent-plan__list/.test(APP), '계획 단계 렌더');
  assert.ok(/st\.phase === 'reflect'/.test(APP) && /검증 통과|검증 실패/.test(APP), '검증 단계 렌더');
  assert.ok(/\.agent-plan\s*\{/.test(CSS) && /\.agent-reflect/.test(CSS), '계획·검증 CSS');
});

/* ───── [문서 Q&A — 여러 편집기·제목찾기·키워드발췌] AG-9 ───── */

function ctxWithSpipDoc() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spip-agent-doc-'));
  const uiPath = path.join(dir, 'ui.json');
  const mdPath = path.join(dir, 'md.json');
  // 편집기 2개 — Project-SPIP 문서는 '두 번째' 편집기(w5)에 둔다(첫 편집기만 보면 못 찾는 케이스).
  fs.writeFileSync(uiPath, JSON.stringify({
    schemaVersion: 6,
    homeWidgets: [{ iid: 'md1', type: 'mdedit', name: '' }, { iid: 'w5', type: 'mdedit', name: '' }],
    scratchpads: {},
  }), 'utf8');
  const ctx = { uiStatePath: uiPath, mdDocsPath: mdPath, nowMs: () => 1700000000000, config: { briefing: { baseURL: 'x', model: 'm' } } };
  const md = require('../electron/ipc/markdown');
  const body = '# Project-SPIP\n\n## 개요\n대시보드 앱.\n\n## 릴리즈 방법\n1. npm version 으로 버전 올리기\n2. git tag 후 push\n3. npm run release 로 GitHub 게시\n4. gh release edit 로 노트 작성\n\n## 기타\n끝.';
  const r = md.create({ box: 'w5', title: 'Project-SPIP', body }, ctx);
  return { ctx, docId: r.doc.id };
}

test('AG-9 — find/read/search_document 가 모든 편집기에 걸쳐 동작(제목·키워드)', async () => {
  const { ctx, docId } = ctxWithSpipDoc();
  const tools = agentIpc.buildTools(ctx, []);
  // 두 번째 편집기의 문서도 목록·검색에 포함.
  const list = await tools.list_documents.run({});
  assert.ok(list.docs.some((d) => d.title === 'Project-SPIP' && d.editor === 'w5'), '다중 편집기 목록');
  const f = await tools.find_document.run({ query: 'spip' });
  assert.strictEqual(f.matches[0].id, docId, '제목으로 찾기');
  const s = await tools.search_document.run({ id: docId, keyword: '릴리즈' });
  assert.ok(s.found >= 1 && /npm run release/.test(s.excerpts.join('\n')), '키워드 발췌에 릴리즈 절차');
  const rd = await tools.read_document.run({ id: docId });
  assert.ok(/릴리즈 방법/.test(rd.body), '본문 전체 읽기(첫 편집기 아님)');
});

test('AG-9 — IPC run: "SPIP 문서 찾아 릴리즈 방법 설명" 흐름(찾기→발췌→근거 답변)', async () => {
  const { ctx, docId } = ctxWithSpipDoc();
  const script = [
    '{"plan":["Project-SPIP 문서를 찾는다","릴리즈 관련 내용을 발췌한다","내용을 근거로 설명한다"]}',
    '{"thought":"제목으로 문서 찾기","tool":"find_document","args":{"query":"Project-SPIP"}}',
    '{"thought":"릴리즈 부분 발췌","tool":"search_document","args":{"id":"' + docId + '","keyword":"릴리즈"}}',
    '{"final":"Project-SPIP 문서의 릴리즈 방법: 1) npm version 으로 버전 올리고 2) git tag 후 push, 3) npm run release 로 GitHub 게시, 4) gh release edit 로 노트 작성."}',
    '{"is_valid":true,"critique":""}',
  ];
  let i = 0;
  ctx.llmClient = { streamBriefing: async () => ({ ok: true, text: script[i++] }) };
  const res = await agentIpc.run({ message: '마크다운 편집기에서 spip 관련 문서를 찾아 릴리즈 방법에 대해 설명해줘' }, ctx);
  assert.strictEqual(res.ok, true);
  assert.ok(res.steps.some((s) => s.tool === 'find_document'), 'find_document 실행');
  assert.ok(res.steps.some((s) => s.tool === 'search_document' && /npm run release/.test(s.observation)), 'search_document 로 릴리즈 내용 확보');
  assert.ok(/npm run release/.test(res.final) && /gh release/.test(res.final), '문서 내용을 근거로 릴리즈 방법 답변');
});

test('AG-9 — 프롬프트에 문서 Q&A 도구·지침', () => {
  assert.ok(/find_document/.test(agentIpc.AGENT_SYSTEM) && /search_document/.test(agentIpc.AGENT_SYSTEM), '문서 검색 도구');
  assert.ok(/지어내지 말고|근거로 답/.test(agentIpc.AGENT_SYSTEM), '문서 내용 근거 지침(환각 방지)');
});
