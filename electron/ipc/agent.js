'use strict';
/**
 * electron/ipc/agent.js — Agent 위젯 IPC (AG-1)
 *
 *   spip:agent:run → 사용자 요청을 ReAct 루프로 처리(POC: 할 일 위젯 제어 도구).
 *
 * 개념(docs/ref.md): Plan-and-Solve + ReAct + Reflection 중 **ReAct 루프**를 POC로 구현.
 *   도구는 이 프로젝트의 기존 할 일 핸들러(uiState.addTodo/toggleTodo/removeTodo)에 배선한다 —
 *   메인이 검증·영속을 이미 강제하므로 에이전트는 화이트리스트 도구만 호출할 수 있다(임의 코드·경로 0).
 *
 * 보안:
 *   · egress 는 메인 단독(llmClient 만 외부 통신). 렌더러는 텍스트만 주고받는다.
 *   · 연결 정보(baseURL/apiKey)는 응답·로그에 노출하지 않는다(고정 code 만).
 *   · 도구는 할 일 CRUD 로 한정 — 파일·경로·프로세스 접근 없음(POC 범위).
 */

const uiStateIpc = require('./uiState');
const { runAgent } = require('../../lib/ai/agent');

const MAX_MESSAGE_LEN = 2000;

// ReAct 시스템 프롬프트 — 도구 설명 + JSON 프로토콜. ```가 들어가지 않게 배열+join.
const AGENT_SYSTEM = [
  '너는 사용자의 요청을 "할 일(todo) 관리 도구"로 처리하는 에이전트다.',
  '매 단계마다 아래 형식의 JSON 객체를 **정확히 하나만** 출력한다(설명·머리말·코드펜스 없이):',
  '- 도구 호출: {"thought":"왜 이 도구를 쓰는지","tool":"도구이름","args":{...}}',
  '- 완료(최종 답변): {"thought":"요약","final":"사용자에게 보여줄 한국어 답변"}',
  '',
  '사용 가능한 도구:',
  '- list_todos: 현재 할 일 목록(id·내용·완료여부·마감)을 반환한다. args 는 {} 로 둔다.',
  '- add_todo: 새 할 일을 추가한다. args = {"text":"할 일 내용", "dueAt":"YYYY-MM-DD HH:mm"(선택)}.',
  '- complete_todo: 할 일을 완료로 표시한다. args = {"id":"..."} 또는 {"text":"내용 일부"}.',
  '- uncomplete_todo: 완료를 취소한다. args = {"id":"..."} 또는 {"text":"내용 일부"}.',
  '- delete_todo: 할 일을 삭제한다. args = {"id":"..."} 또는 {"text":"내용 일부"}.',
  '',
  '규칙:',
  '- 특정 할 일을 완료/삭제하려면, 먼저 list_todos 로 목록과 id 를 확인한 뒤 정확한 id 로 지정하는 것이 안전하다.',
  '- 요청과 무관한 작업은 하지 마라. 필요한 작업만 최소 단계로 수행한다.',
  '- 작업을 마쳤으면 final 로 무엇을 했는지 간결히 한국어로 요약한다.',
].join('\n');

/** 현재 할 일 목록(메인 상태). */
function currentTodos(ctx) {
  const r = uiStateIpc.getUiState(ctx);
  return (r && Array.isArray(r.todos)) ? r.todos : [];
}

/** args(id 또는 text)로 할 일 1건을 찾는다 — 정확 id > 정확 text > 부분 text. 없으면 null. */
function findTodo(ctx, args) {
  const todos = currentTodos(ctx);
  if (args && typeof args.id === 'string' && args.id) {
    const byId = todos.find((t) => t.id === args.id);
    if (byId) return byId;
  }
  if (args && typeof args.text === 'string' && args.text.trim()) {
    const q = args.text.trim();
    return todos.find((t) => t.text === q) || todos.find((t) => t.text.indexOf(q) >= 0) || null;
  }
  return null;
}

/** 'YYYY-MM-DD HH:mm'(또는 ISO) → ms epoch. 실패 시 null. */
function parseDue(v) {
  if (typeof v !== 'string' || !v.trim()) return null;
  const t = Date.parse(v.trim().replace(' ', 'T'));
  return (typeof t === 'number' && Number.isFinite(t) && t > 0) ? t : null;
}

/** 할 일 제어 도구 집합(기존 uiState 핸들러에 배선). 관찰 결과는 작고 안전한 요약만 반환. */
function buildTools(ctx) {
  return {
    list_todos: {
      desc: '현재 할 일 목록',
      run: async () => ({ ok: true, todos: currentTodos(ctx).map((t) => ({ id: t.id, text: t.text, done: t.done, dueAt: t.dueAt })) }),
    },
    add_todo: {
      desc: '할 일 추가',
      run: async (a) => {
        const r = uiStateIpc.addTodo({ text: (a && a.text), dueAt: parseDue(a && a.dueAt) }, ctx);
        return r.ok ? { ok: true, added: (a && a.text) || '' } : { ok: false, error: r.code };
      },
    },
    complete_todo: {
      desc: '완료 표시',
      run: async (a) => {
        const t = findTodo(ctx, a);
        if (!t) return { ok: false, error: 'not_found' };
        const r = uiStateIpc.toggleTodo({ id: t.id, done: true }, ctx);
        return r.ok ? { ok: true, id: t.id, text: t.text } : { ok: false, error: r.code };
      },
    },
    uncomplete_todo: {
      desc: '완료 취소',
      run: async (a) => {
        const t = findTodo(ctx, a);
        if (!t) return { ok: false, error: 'not_found' };
        const r = uiStateIpc.toggleTodo({ id: t.id, done: false }, ctx);
        return r.ok ? { ok: true, id: t.id, text: t.text } : { ok: false, error: r.code };
      },
    },
    delete_todo: {
      desc: '삭제',
      run: async (a) => {
        const t = findTodo(ctx, a);
        if (!t) return { ok: false, error: 'not_found' };
        const r = uiStateIpc.removeTodo({ id: t.id }, ctx);
        return r.ok ? { ok: true, id: t.id, text: t.text } : { ok: false, error: r.code };
      },
    },
  };
}

/**
 * spip:agent:run — 사용자 요청을 ReAct 루프로 처리. 성공 시 { ok, final, steps, todos }.
 *   연결 정보(config.briefing) 없으면 NO_CONN. LLM 실패는 고정 code.
 * @param {object} args { message }
 */
async function run(args, ctx) {
  const message = (args && typeof args === 'object' && typeof args.message === 'string') ? args.message.trim() : '';
  if (!message) return { ok: false, code: 'BAD_INPUT' };
  if (message.length > MAX_MESSAGE_LEN) return { ok: false, code: 'BAD_INPUT' };

  const cfg = (ctx && ctx.config) || {};
  const b = (cfg.briefing && typeof cfg.briefing === 'object') ? cfg.briefing : {};
  if (!b.baseURL || !b.model) return { ok: false, code: 'NO_CONN' };

  const client = ctx && ctx.llmClient;
  if (!client || typeof client.streamBriefing !== 'function') return { ok: false, code: 'INTERNAL' };

  const llm = async (system, user) => {
    try { return await client.streamBriefing({ system, user, temperature: 0, maxTokens: 1024 }); }
    catch (_) { return { ok: false, code: 'INTERNAL' }; }
  };

  const res = await runAgent({ llm, tools: buildTools(ctx), system: AGENT_SYSTEM, message, maxSteps: 6 });
  return {
    ok: !!(res.ok && res.final),   // 최종 답까지 도달해야 성공(도구는 실행됐어도 요약 미도달이면 code 로 안내)
    code: res.code || (res.final ? undefined : 'NO_FINAL'),
    final: res.final || '',
    steps: Array.isArray(res.steps) ? res.steps : [],
    todos: currentTodos(ctx),       // 실행 후 최신 할 일(렌더러가 즉시 반영)
  };
}

module.exports = { run, buildTools, findTodo, parseDue, AGENT_SYSTEM, MAX_MESSAGE_LEN };
