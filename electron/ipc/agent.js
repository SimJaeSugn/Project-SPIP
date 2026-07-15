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
const mailAccountsIpc = require('./mailAccounts');
const mailArchiveIpc = require('./mailArchive');
const { runAgent, estimateTokens } = require('../../lib/ai/agent');

const MAX_MESSAGE_LEN = 2000;
// [멀티턴] 대화 컨텍스트 예산(토큰). 이 한도를 넘으면 오래된 턴부터 생략해 컨텍스트를 유지한다.
//   모델의 실제 컨텍스트 창은 config 에 없으므로, 로컬 모델에서 안전한 보수적 기본값을 제한 기준으로 쓴다.
const CONTEXT_LIMIT_TOKENS = 6000;
const MAX_HISTORY_TURNS = 20;      // 방어적 상한(정규화 시)
const MAX_HISTORY_CONTENT = 2000;  // 턴당 내용 길이 상한

// ReAct 시스템 프롬프트 — 도구 설명 + JSON 프로토콜. ```가 들어가지 않게 배열+join.
const AGENT_SYSTEM = [
  '너는 사용자의 요청을 "할 일(todo) 관리 도구"로 처리하는 에이전트다.',
  '매 단계마다 아래 형식의 JSON 객체를 **정확히 하나만** 출력한다(설명·머리말·코드펜스 없이):',
  '- 도구 호출: {"thought":"왜 이 도구를 쓰는지","tool":"도구이름","args":{...}}',
  '- 완료(최종 답변): {"thought":"요약","final":"사용자에게 보여줄 한국어 답변"}',
  '',
  '사용 가능한 도구 — 할 일:',
  '- list_todos: 현재 할 일 목록(id·내용·완료여부·마감)을 반환한다. args 는 {} 로 둔다.',
  '- add_todo: 새 할 일을 추가한다. args = {"text":"할 일 내용", "dueAt":"YYYY-MM-DD HH:mm"(선택)}.',
  '- complete_todo: 할 일을 완료로 표시한다. args = {"id":"..."} 또는 {"text":"내용 일부"}.',
  '- uncomplete_todo: 완료를 취소한다. args = {"id":"..."} 또는 {"text":"내용 일부"}.',
  '- delete_todo: 할 일을 삭제한다. args = {"id":"..."} 또는 {"text":"내용 일부"}.',
  '',
  '사용 가능한 도구 — 메일:',
  '- list_mail_accounts: 등록된 메일 계정 목록(id·라벨·주소, 비밀번호 제외)을 반환한다. args {}.',
  '- get_mail_summary: 계정별 안 읽은 메일 다이제스트(unseen 수 + 항목: accountId·uid·mailbox·제목·발신자·날짜)를 반환한다. args {}. 메일 확인·검색의 출발점.',
  '- read_mail: 메일 1통의 본문을 읽는다(서버에서 읽음 처리됨). args = {"accountId":"...","uid":123,"mailbox":"..."}. 값은 get_mail_summary/get_mail_archive 항목에서 가져온다.',
  '- get_mail_archive: 로컬 보관함(계정·메일함별 수집 메일 목록)을 반환한다. args {}.',
  '- sync_mail: 서버에서 메일 색인을 다시 수집해 보관함을 갱신한다. args {}. 느릴 수 있다.',
  '- delete_mail: 메일을 삭제한다(서버 휴지통으로 이동). args = {"accountId":"...","mailbox":"...","uid":123}.',
  '',
  '규칙:',
  '- 특정 항목(할 일·메일)을 지정하려면, 먼저 목록 도구(list_todos / get_mail_summary / get_mail_archive)로 id·uid 를 확인한 뒤 정확히 지정하는 것이 안전하다.',
  '- read_mail 은 서버 읽음 처리, delete_mail 은 서버 휴지통 이동으로 **되돌리기 어렵다** — 사용자가 명확히 요청한 경우에만, 어느 메일인지 애매하면 먼저 목록으로 확인한 뒤 수행하라. 추측으로 삭제하지 마라.',
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

/** [멀티턴] 렌더러가 보낸 이전 대화 방어 정규화 — {role:'user'|'assistant', content}. */
function normalizeHistory(input) {
  if (!Array.isArray(input)) return [];
  const out = [];
  for (const t of input) {
    if (!t || typeof t !== 'object') continue;
    const role = (t.role === 'user' || t.role === 'assistant') ? t.role : null;
    const content = (typeof t.content === 'string') ? t.content : '';
    if (role && content.trim()) out.push({ role, content: content.slice(0, MAX_HISTORY_CONTENT) });
  }
  return out.slice(-MAX_HISTORY_TURNS);
}

/** [멀티턴] 컨텍스트 예산 안으로 최근 턴 우선 유지. 초과분(오래된 턴)은 생략. */
function trimHistory(history, limitTokens) {
  let total = 0;
  const kept = [];
  for (let i = history.length - 1; i >= 0; i--) {
    const tk = estimateTokens(history[i].content) + 4; // 역할 라벨 여유
    if (total + tk > limitTokens && kept.length > 0) break;
    total += tk;
    kept.unshift(history[i]);
  }
  return { history: kept, trimmed: kept.length < history.length, historyTokens: total };
}

/** 'YYYY-MM-DD HH:mm'(또는 ISO) → ms epoch. 실패 시 null. */
function parseDue(v) {
  if (typeof v !== 'string' || !v.trim()) return null;
  const t = Date.parse(v.trim().replace(' ', 'T'));
  return (typeof t === 'number' && Number.isFinite(t) && t > 0) ? t : null;
}

/* ── 메일 도구용 관찰 요약(컨텍스트 절약: 큰 응답을 LLM 친화적 소형 뷰로) ── */
function clampStr(v, n) { const s = String(v == null ? '' : v); return s.length > n ? s.slice(0, n) + '…' : s; }

/** get_mail_summary 응답 → 계정별 unseen + 항목(계정당 최대 10). 자격증명·본문 없음. */
function summarizeMailSummary(r) {
  const accounts = (r && Array.isArray(r.accounts)) ? r.accounts : [];
  return {
    ok: true,
    accounts: accounts.map((a) => ({
      accountId: a.id, email: a.user || a.label || a.email || null,
      ok: a.ok !== false, unseen: (a.unseen == null ? null : a.unseen),
      items: (Array.isArray(a.items) ? a.items : []).slice(0, 10).map((m) => ({
        uid: m.uid, mailbox: m.mailbox || 'INBOX', subject: clampStr(m.subject, 140), from: clampStr(m.from, 80), date: m.date || null,
      })),
    })),
  };
}

/** get_mail_archive/sync 응답 → 계정·메일함 요약 + 최근 항목(메일함당 최대 5). */
function summarizeArchive(r) {
  const accounts = (r && Array.isArray(r.accounts)) ? r.accounts : [];
  return {
    ok: true,
    errors: (r && Array.isArray(r.errors) && r.errors.length) ? r.errors : undefined,
    accounts: accounts.map((a) => ({
      accountId: a.accountId, label: a.label || a.user || null,
      mailboxes: (Array.isArray(a.mailboxes) ? a.mailboxes : []).slice(0, 12).map((mb) => ({
        mailbox: mb.name, name: mb.displayName || mb.name, total: mb.total, unread: mb.unread,
        recent: (Array.isArray(mb.items) ? mb.items : []).slice(0, 5).map((it) => ({
          uid: it.uid, subject: clampStr(it.subject, 140), from: clampStr(it.from, 80), date: it.date || null, seen: !!it.seen,
        })),
      })),
    })),
  };
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

    /* ── 메일 위젯 제어 ── */
    list_mail_accounts: {
      desc: '메일 계정 목록(자격증명 제외)',
      run: async () => {
        const r = mailAccountsIpc.getMailAccounts(ctx);
        return { ok: true, accounts: (r && Array.isArray(r.accounts) ? r.accounts : []).map((a) => ({ accountId: a.id, label: a.label || null, email: a.user || null })) };
      },
    },
    get_mail_summary: {
      desc: '안 읽은 메일 다이제스트',
      run: async () => {
        try { return summarizeMailSummary(await mailAccountsIpc.getMailSummary(ctx)); }
        catch (_) { return { ok: false, error: 'mail_error' }; }
      },
    },
    read_mail: {
      desc: '메일 본문 열람(읽음 처리)',
      run: async (a) => {
        a = a || {};
        const r = await mailAccountsIpc.getMailMessage({ accountId: a.accountId, uid: Number(a.uid), mailbox: a.mailbox }, ctx);
        if (!r || !r.ok) return { ok: false, error: (r && r.code) || 'mail_error' };
        return { ok: true, subject: r.subject, from: r.from, date: r.date, text: clampStr(r.text, 1500) };
      },
    },
    get_mail_archive: {
      desc: '로컬 보관함 목록',
      run: async () => {
        try { return summarizeArchive(mailArchiveIpc.getMailArchive(ctx)); }
        catch (_) { return { ok: false, error: 'mail_error' }; }
      },
    },
    sync_mail: {
      desc: '서버에서 보관함 동기화',
      run: async () => {
        try { const r = await mailArchiveIpc.syncMailArchive(ctx); return summarizeArchive(r); }
        catch (_) { return { ok: false, error: 'mail_error' }; }
      },
    },
    delete_mail: {
      desc: '메일 삭제(서버 휴지통 이동)',
      run: async (a) => {
        a = a || {};
        if (!a.accountId || !a.mailbox || !(Number(a.uid) > 0)) return { ok: false, error: 'need_account_mailbox_uid' };
        const r = await mailArchiveIpc.deleteMailArchiveItem({ accountId: a.accountId, mailbox: a.mailbox, uid: Number(a.uid) }, ctx);
        return (r && r.ok) ? { ok: true, deleted: { uid: Number(a.uid), mailbox: a.mailbox } } : { ok: false, error: (r && r.code) || 'mail_error' };
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

  // [멀티턴] 이전 대화를 예산 안으로 다듬어 컨텍스트로 전달.
  const rawHistory = normalizeHistory(args && args.history);
  const trimmed = trimHistory(rawHistory, CONTEXT_LIMIT_TOKENS);

  const res = await runAgent({ llm, tools: buildTools(ctx), system: AGENT_SYSTEM, message, history: trimmed.history, maxSteps: 6 });

  // [컨텍스트 사용현황] 모델이 promptTokens 를 보고하면 그 값(정확), 아니면 프롬프트 char 수로 추정.
  const modelPrompt = res.usage && Number.isFinite(res.usage.promptTokens) ? res.usage.promptTokens : null;
  const contextTokens = (modelPrompt != null) ? modelPrompt : estimateTokens(res.promptChars || 0);
  return {
    ok: !!(res.ok && res.final),   // 최종 답까지 도달해야 성공(도구는 실행됐어도 요약 미도달이면 code 로 안내)
    code: res.code || (res.final ? undefined : 'NO_FINAL'),
    final: res.final || '',
    steps: Array.isArray(res.steps) ? res.steps : [],
    todos: currentTodos(ctx),       // 실행 후 최신 할 일(렌더러가 즉시 반영)
    // [컨텍스트 사용현황과 제한기준] 렌더러가 미터로 표시.
    context: {
      tokens: contextTokens,
      limit: CONTEXT_LIMIT_TOKENS,
      trimmed: trimmed.trimmed,           // 예산 초과로 오래된 턴을 생략했는가
      source: (modelPrompt != null) ? 'model' : 'estimate',
      completionTokens: (res.usage && Number.isFinite(res.usage.completionTokens)) ? res.usage.completionTokens : null,
    },
  };
}

module.exports = { run, buildTools, findTodo, parseDue, normalizeHistory, trimHistory, AGENT_SYSTEM, MAX_MESSAGE_LEN, CONTEXT_LIMIT_TOKENS };
