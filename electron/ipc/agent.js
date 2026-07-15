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
const dataIpc = require('./data');
const insightsIpc = require('./insights');
const shelfIpc = require('./shelf');
const markdownIpc = require('./markdown');
const explorerIpc = require('./explorer');
const briefingIpc = require('./briefing');
const uiStateStore = require('../../lib/common/uiStateStore');
const { runHybrid, estimateTokens } = require('../../lib/ai/agent');

const MAX_MESSAGE_LEN = 2000;
// [컨텍스트 사용현황과 제한기준] 연결 모델의 컨텍스트 창(최대) = 32768 토큰. 미터는 사용량/이 값(=창 최대치)을
//   표시한다(사용량은 모델 promptTokens 또는 문자수 추정). 창을 config 로 조정 노출하기 전까지 이 상수를 쓴다.
const CONTEXT_WINDOW_TOKENS = 32768;
// [멀티턴] 대화 history 예산 = 창에서 시스템 프롬프트·도구 관찰·출력 여유(RESERVE)를 뺀 몫.
//   이 예산을 넘으면 오래된 턴부터 생략해 전체 컨텍스트가 창을 넘지 않게 한다.
const CONTEXT_RESERVE_TOKENS = 8192;
const CONTEXT_HISTORY_BUDGET = CONTEXT_WINDOW_TOKENS - CONTEXT_RESERVE_TOKENS; // = 24576
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
  '- open_mailbox: 화면에 메일함(보관함) 팝업을 연다. args {} 또는 특정 계정·메일함을 지정 {"accountId":"...","mailbox":"..."}.',
  '- open_mail: 화면에 메일 1통의 본문 뷰어를 연다. args = {"accountId":"...","uid":123,"mailbox":"..."}. read_mail 은 내용을 읽어 요약할 때, open_mail 은 사용자에게 화면으로 보여줄 때 쓴다.',
  '',
  '사용 가능한 도구 — 프로젝트/현황(읽기):',
  '- list_projects: 스캔된 프로젝트 목록(git 상태·방치 여부·최근 수정). args {}.',
  '- get_project_stats: 프로젝트 집계(총수·방치 수·언어별·용량). args {}.',
  '- get_commit_activity: 최근 커밋 활동. args {}.',
  '- get_system_status: 개발 머신 CPU·메모리·디스크. args {}.',
  '- get_token_usage: Claude Code·연결 모델 토큰 사용량. args {}.',
  '',
  '사용 가능한 도구 — 즐겨찾기(셸프):',
  '- list_bookmarks: 즐겨찾기 목록. args {}.',
  '- add_bookmark: 즐겨찾기 추가. args = {"type":"url|folder|file","url":"주소 또는 경로"}.',
  '- remove_bookmark: 즐겨찾기 삭제. args = {"id":"..."}.',
  '',
  '사용 가능한 도구 — 메모:',
  '- list_memos: 메모 목록(iid·미리보기). args {}.',
  '- get_memo: 메모 전체 내용 읽기. args = {"iid":"..."(선택, 없으면 첫 메모)}.',
  '- set_memo: 메모를 통째로 덮어쓰기. args = {"text":"...","iid":"..."(선택)}.',
  '- append_memo: 메모 끝에 줄 추가(기존 보존). args = {"text":"...","iid":"..."(선택)}.',
  '- clear_memo: 메모 비우기. args = {"iid":"..."(선택)}.',
  '',
  '사용 가능한 도구 — 마크다운 문서(첫 편집기):',
  '- list_documents: 문서 목록. args {}.',
  '- read_document: 문서 본문 읽기. args = {"id":"..."}.',
  '- create_document: 문서 새로 만들기. args = {"title":"...","body":"...(선택)"}.',
  '- update_document: 문서 수정. args = {"id":"...","title":"...(선택)","body":"...(선택)"}.',
  '- delete_document: 문서 삭제. args = {"id":"..."}.',
  '- correct_document: 문서의 마크다운 문법을 AI 로 보정(내용은 바꾸지 않음). args = {"id":"..."}.',
  '',
  '사용 가능한 도구 — 탐색기/브리핑:',
  '- list_explorer_roots: 탐색기 열람 루트 목록. args {}.',
  '- list_folder: 폴더 내용 나열(등록 루트 안에서만). args = {"path":"..."}.',
  '- refresh_briefing: AI 브리핑 재생성. args {}.',
  '',
  '규칙:',
  '- 특정 항목(할 일·메일)을 지정하려면, 먼저 목록 도구(list_todos / get_mail_summary / get_mail_archive)로 id·uid 를 확인한 뒤 정확히 지정하는 것이 안전하다.',
  '- read_mail 은 서버 읽음 처리, delete_mail 은 서버 휴지통 이동으로 **되돌리기 어렵다** — 사용자가 명확히 요청한 경우에만, 어느 메일인지 애매하면 먼저 목록으로 확인한 뒤 수행하라. 추측으로 삭제하지 마라.',
  '- 요청과 무관한 작업은 하지 마라. 필요한 작업만 최소 단계로 수행한다.',
  '- 작업을 마쳤으면 final 로 무엇을 했는지 간결히 한국어로 요약한다.',
].join('\n');

// [Plan-and-Solve] 플래너 시스템 프롬프트(도구 이름 목록은 run 에서 덧붙인다).
const PLANNER_SYSTEM = [
  '너는 사용자 요청을 해결할 실행 계획을 세우는 플래너다.',
  '아래 도구들로 수행 가능한 하위 작업 목록(계획)을 만든다. 각 단계는 한 문장으로 간결히, 도구 한 번으로 수행 가능한 단위로.',
  '이전 시도의 피드백(critique)이 주어지면 그 문제를 해결하도록 계획을 수정한다.',
  '출력은 {"plan":["...","..."]} JSON 하나만(설명·코드펜스 없이).',
].join('\n');

// [Reflection] 리플렉터 시스템 프롬프트.
const REFLECTOR_SYSTEM = [
  '너는 에이전트의 실행 결과를 검증하는 엄격한 검증자다.',
  '요청·계획·실행 트레이스·최종 답변을 보고 요청이 실제로 충족됐는지 판단한다.',
  '도구 관찰에 실패(ok:false)나 누락이 있거나, 최종 답변이 관찰과 어긋나면(환각) is_valid=false 로 하고, 무엇을 어떻게 고쳐야 하는지 critique 에 구체적으로 적는다.',
  '요청이 확실히 충족됐으면 is_valid=true(사소한 표현 차이로 무효 처리하지 마라).',
  '출력은 {"is_valid":true|false,"critique":"..."} JSON 하나만.',
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

/* ── 관찰 요약(컨텍스트 절약: 큰 응답을 LLM 친화적 소형 뷰로) ── */
function clampStr(v, n) { const s = String(v == null ? '' : v); return s.length > n ? s.slice(0, n) + '…' : s; }
/** 배치된 위젯 인스턴스 목록(homeWidgets) — 인스턴스별 위젯(메모·편집기)의 iid 해석용. */
function homeWidgets(ctx) {
  try {
    const ui = uiStateStore.read({ logger: ctx && ctx.logger, uiStatePath: ctx && ctx.uiStatePath, deps: ctx && ctx.deps });
    return Array.isArray(ui.homeWidgets) ? ui.homeWidgets : [];
  } catch (_) { return []; }
}
/** 첫 번째 해당 타입 위젯 인스턴스의 iid(없으면 null). */
function firstWidgetIid(ctx, type) {
  const w = homeWidgets(ctx).find((x) => x && x.type === type);
  return (w && typeof w.iid === 'string') ? w.iid : null;
}
/** 프로젝트 1건 → 소형 뷰(스캔 store 원본 필드 방어적 매핑). */
function projectBrief(p) {
  if (!p || typeof p !== 'object') return null;
  const git = p.git || {};
  const fr = p.freshness || {};
  return {
    name: p.name || null,
    path: clampStr(p.path, 200) || null,
    language: (p.language && p.language.primary) || null,
    dirty: git.dirty === true || (Number(git.dirtyCount) > 0) || null,
    ahead: Number.isFinite(git.ahead) ? git.ahead : null,
    behind: Number.isFinite(git.behind) ? git.behind : null,
    isStale: fr.isStale === true || null,
    lastModified: p.lastModified || p.mtime || (fr && fr.lastModified) || null,
  };
}

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

/** 도구 집합(할 일·메일 데이터 + 렌더러 UI 열기). uiActions 는 렌더러가 실행할 UI 액션 수집 배열(메인은
 *   렌더러 UI 를 직접 못 여므로, open_* 도구는 액션을 쌓고 응답으로 돌려준다). 관찰은 작은 요약만. */
function buildTools(ctx, uiActions) {
  uiActions = Array.isArray(uiActions) ? uiActions : [];
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

    /* ── 메일 위젯 UI 액티브 이벤트(렌더러가 실행) ── */
    open_mailbox: {
      desc: '메일함 팝업 열기(UI)',
      run: async (a) => {
        a = a || {};
        const act = { type: 'open_mailbox' };
        if (typeof a.accountId === 'string' && a.accountId) act.accountId = a.accountId;
        if (typeof a.mailbox === 'string' && a.mailbox) act.mailbox = a.mailbox;
        uiActions.push(act);
        return { ok: true, opened: 'mailbox', accountId: act.accountId || null, mailbox: act.mailbox || null };
      },
    },
    open_mail: {
      desc: '메일 본문 뷰어 열기(UI)',
      run: async (a) => {
        a = a || {};
        const uid = Number(a.uid);
        if (!a.accountId || !(uid > 0)) return { ok: false, error: 'need_account_uid' };
        uiActions.push({
          type: 'open_mail', accountId: String(a.accountId), uid,
          mailbox: (typeof a.mailbox === 'string' && a.mailbox) ? a.mailbox : undefined,
          subject: (a.subject != null) ? clampStr(a.subject, 200) : undefined,
          from: (a.from != null) ? clampStr(a.from, 120) : undefined,
          date: (a.date != null) ? clampStr(a.date, 64) : undefined,
        });
        return { ok: true, opened: 'mail', accountId: String(a.accountId), uid };
      },
    },

    /* ── 프로젝트(주의 필요·최근 활동·요약·디스크 회수 위젯) ── */
    list_projects: {
      desc: '스캔된 프로젝트 목록(git 상태·방치 여부·최근 수정)',
      run: async () => {
        try {
          const r = dataIpc.getProjects(ctx);
          const projects = (r && Array.isArray(r.projects)) ? r.projects : [];
          return { ok: true, count: projects.length, projects: projects.slice(0, 40).map(projectBrief).filter(Boolean) };
        } catch (_) { return { ok: false, error: 'scan_unavailable' }; }
      },
    },
    get_project_stats: {
      desc: '프로젝트 집계(총수·방치 수·언어별·용량)',
      run: async () => {
        try { const s = dataIpc.getStats(ctx); return { ok: true, total: s.total, staleCount: s.staleCount, byLanguage: s.byLanguage, totalBytes: s.totalBytes }; }
        catch (_) { return { ok: false, error: 'scan_unavailable' }; }
      },
    },
    /* ── 주간 생산성·커밋 히트맵 위젯 ── */
    get_commit_activity: {
      desc: '최근 커밋 활동(빈도)',
      run: async () => {
        try { const r = await insightsIpc.getCommitActivity(ctx, {}); return r && r.ok !== false ? { ok: true, activity: r } : { ok: false, error: (r && r.code) || 'unavailable' }; }
        catch (_) { return { ok: false, error: 'unavailable' }; }
      },
    },
    /* ── 시스템 상태 위젯 ── */
    get_system_status: {
      desc: '개발 머신 CPU·메모리·디스크',
      run: async () => {
        try { const r = await insightsIpc.getSystemStatus(ctx); return r && r.ok !== false ? { ok: true, status: r } : { ok: false, error: 'unavailable' }; }
        catch (_) { return { ok: false, error: 'unavailable' }; }
      },
    },
    /* ── 토큰 사용량 위젯 ── */
    get_token_usage: {
      desc: 'Claude Code·연결 모델 토큰 사용량',
      run: async () => {
        try { const r = insightsIpc.getClaudeUsage(ctx); return r && r.ok !== false ? { ok: true, usage: r } : { ok: false, error: 'unavailable' }; }
        catch (_) { return { ok: false, error: 'unavailable' }; }
      },
    },
    /* ── 즐겨찾기 셸프 위젯 ── */
    list_bookmarks: {
      desc: '즐겨찾기(사이트·폴더·파일) 목록',
      run: async () => {
        try { const r = shelfIpc.list(undefined, ctx); return { ok: true, items: (r && Array.isArray(r.items)) ? r.items : [] }; }
        catch (_) { return { ok: false, error: 'unavailable' }; }
      },
    },
    add_bookmark: {
      desc: '즐겨찾기 추가',
      run: async (a) => {
        a = a || {};
        // shelf.add 는 {type, ref} 를 받는다 — LLM 이 준 url/path 를 ref 로 매핑.
        const ref = (typeof a.ref === 'string' && a.ref) ? a.ref : ((typeof a.url === 'string' && a.url) ? a.url : (typeof a.path === 'string' ? a.path : ''));
        if (!ref) return { ok: false, error: 'need_url_or_path' };
        try { const r = await shelfIpc.add({ type: a.type, ref }, ctx); return (r && r.ok !== false) ? { ok: true, added: ref } : { ok: false, error: (r && r.code) || 'failed' }; }
        catch (_) { return { ok: false, error: 'failed' }; }
      },
    },
    remove_bookmark: {
      desc: '즐겨찾기 삭제. args = {"id":"..."}',
      run: async (a) => {
        a = a || {};
        if (!a.id) return { ok: false, error: 'need_id' };
        try { const r = shelfIpc.remove({ id: a.id }, ctx); return (r && r.ok !== false) ? { ok: true, id: a.id } : { ok: false, error: (r && r.code) || 'failed' }; }
        catch (_) { return { ok: false, error: 'failed' }; }
      },
    },
    /* ── 메모(스크래치패드) 위젯 — 인스턴스별 ── */
    list_memos: {
      desc: '메모 목록(iid·미리보기)',
      run: async () => {
        try {
          const ui = uiStateIpc.getUiState(ctx);
          const sp = (ui && ui.scratchpads && typeof ui.scratchpads === 'object') ? ui.scratchpads : {};
          return { ok: true, memos: Object.keys(sp).map((iid) => ({ iid, preview: clampStr((sp[iid] && sp[iid].text) || '', 120) })) };
        } catch (_) { return { ok: false, error: 'unavailable' }; }
      },
    },
    get_memo: {
      desc: '메모 전체 내용 읽기. args = {"iid":"..."(선택, 없으면 첫 메모)}',
      run: async (a) => {
        a = a || {};
        const iid = (typeof a.iid === 'string' && a.iid) ? a.iid : firstWidgetIid(ctx, 'scratchpad');
        if (!iid) return { ok: false, error: 'no_memo_widget' };
        try {
          const sp = (uiStateIpc.getUiState(ctx).scratchpads || {})[iid];
          return { ok: true, iid, text: clampStr((sp && sp.text) || '', 1800) };
        } catch (_) { return { ok: false, error: 'failed' }; }
      },
    },
    set_memo: {
      desc: '메모 내용을 통째로 설정(덮어쓰기). args = {"text":"...", "iid":"..."(선택, 없으면 첫 메모)}',
      run: async (a) => {
        a = a || {};
        if (typeof a.text !== 'string') return { ok: false, error: 'need_text' };
        const iid = (typeof a.iid === 'string' && a.iid) ? a.iid : firstWidgetIid(ctx, 'scratchpad');
        if (!iid) return { ok: false, error: 'no_memo_widget' };
        try { const r = uiStateIpc.setScratchpad({ iid, text: a.text }, ctx); return (r && r.ok !== false) ? { ok: true, iid } : { ok: false, error: (r && r.code) || 'failed' }; }
        catch (_) { return { ok: false, error: 'failed' }; }
      },
    },
    append_memo: {
      desc: '메모 끝에 줄 추가(기존 내용 보존). args = {"text":"...", "iid":"..."(선택)}',
      run: async (a) => {
        a = a || {};
        if (typeof a.text !== 'string' || !a.text) return { ok: false, error: 'need_text' };
        const iid = (typeof a.iid === 'string' && a.iid) ? a.iid : firstWidgetIid(ctx, 'scratchpad');
        if (!iid) return { ok: false, error: 'no_memo_widget' };
        try {
          const cur = (((uiStateIpc.getUiState(ctx).scratchpads || {})[iid]) || {}).text || '';
          const next = cur ? (cur.replace(/\s+$/, '') + '\n' + a.text) : a.text;
          const r = uiStateIpc.setScratchpad({ iid, text: next }, ctx);
          return (r && r.ok !== false) ? { ok: true, iid } : { ok: false, error: (r && r.code) || 'failed' };
        } catch (_) { return { ok: false, error: 'failed' }; }
      },
    },
    clear_memo: {
      desc: '메모 비우기. args = {"iid":"..."(선택, 없으면 첫 메모)}',
      run: async (a) => {
        a = a || {};
        const iid = (typeof a.iid === 'string' && a.iid) ? a.iid : firstWidgetIid(ctx, 'scratchpad');
        if (!iid) return { ok: false, error: 'no_memo_widget' };
        try { const r = uiStateIpc.setScratchpad({ iid, text: '' }, ctx); return (r && r.ok !== false) ? { ok: true, iid } : { ok: false, error: (r && r.code) || 'failed' }; }
        catch (_) { return { ok: false, error: 'failed' }; }
      },
    },
    /* ── 마크다운 편집기 위젯 — 인스턴스별(첫 편집기) ── */
    list_documents: {
      desc: '마크다운 문서 목록(첫 편집기)',
      run: async () => {
        const box = firstWidgetIid(ctx, 'mdedit');
        if (!box) return { ok: false, error: 'no_editor_widget' };
        try { const r = markdownIpc.list({ box }, ctx); return (r && r.ok !== false) ? { ok: true, docs: (r.docs || []).map((d) => ({ id: d.id, title: d.title, size: d.size })) } : { ok: false, error: (r && r.code) || 'failed' }; }
        catch (_) { return { ok: false, error: 'failed' }; }
      },
    },
    read_document: {
      desc: '마크다운 문서 본문 읽기. args = {"id":"..."}',
      run: async (a) => {
        a = a || {};
        const box = firstWidgetIid(ctx, 'mdedit');
        if (!box) return { ok: false, error: 'no_editor_widget' };
        if (!a.id) return { ok: false, error: 'need_id' };
        try { const r = markdownIpc.get({ box, id: a.id }, ctx); return (r && r.ok && r.doc) ? { ok: true, title: r.doc.title, body: clampStr(r.doc.body, 1500) } : { ok: false, error: (r && r.code) || 'not_found' }; }
        catch (_) { return { ok: false, error: 'failed' }; }
      },
    },
    create_document: {
      desc: '마크다운 문서 새로 만들기(첫 편집기). args = {"title":"...", "body":"...(선택)"}',
      run: async (a) => {
        a = a || {};
        const box = firstWidgetIid(ctx, 'mdedit');
        if (!box) return { ok: false, error: 'no_editor_widget' };
        try { const r = markdownIpc.create({ box, title: a.title, body: (typeof a.body === 'string') ? a.body : '' }, ctx); return (r && r.ok && r.doc) ? { ok: true, id: r.doc.id, title: r.doc.title } : { ok: false, error: (r && r.code) || 'failed' }; }
        catch (_) { return { ok: false, error: 'failed' }; }
      },
    },
    update_document: {
      desc: '마크다운 문서 수정. args = {"id":"...", "title":"...(선택)", "body":"...(선택)"}',
      run: async (a) => {
        a = a || {};
        const box = firstWidgetIid(ctx, 'mdedit');
        if (!box) return { ok: false, error: 'no_editor_widget' };
        if (!a.id) return { ok: false, error: 'need_id' };
        const patch = { box, id: a.id };
        if (typeof a.title === 'string') patch.title = a.title;
        if (typeof a.body === 'string') patch.body = a.body;
        if (patch.title === undefined && patch.body === undefined) return { ok: false, error: 'need_title_or_body' };
        try { const r = markdownIpc.update(patch, ctx); return (r && r.ok) ? { ok: true, id: a.id } : { ok: false, error: (r && r.code) || 'failed' }; }
        catch (_) { return { ok: false, error: 'failed' }; }
      },
    },
    delete_document: {
      desc: '마크다운 문서 삭제. args = {"id":"..."}',
      run: async (a) => {
        a = a || {};
        const box = firstWidgetIid(ctx, 'mdedit');
        if (!box) return { ok: false, error: 'no_editor_widget' };
        if (!a.id) return { ok: false, error: 'need_id' };
        try { const r = markdownIpc.remove({ box, id: a.id }, ctx); return (r && r.ok) ? { ok: true, id: a.id } : { ok: false, error: (r && r.code) || 'not_found' }; }
        catch (_) { return { ok: false, error: 'failed' }; }
      },
    },
    correct_document: {
      desc: '문서의 마크다운 문법을 AI 로 보정(내용 첨삭 없이). args = {"id":"..."}',
      run: async (a) => {
        a = a || {};
        const box = firstWidgetIid(ctx, 'mdedit');
        if (!box) return { ok: false, error: 'no_editor_widget' };
        if (!a.id) return { ok: false, error: 'need_id' };
        try {
          const g = markdownIpc.get({ box, id: a.id }, ctx);
          if (!g || !g.ok || !g.doc) return { ok: false, error: (g && g.code) || 'not_found' };
          const c = await markdownIpc.correct({ text: g.doc.body }, ctx);
          if (!c || !c.ok) return { ok: false, error: (c && c.code) || 'correct_failed' };
          const u = markdownIpc.update({ box, id: a.id, body: c.text }, ctx);
          return (u && u.ok) ? { ok: true, id: a.id, corrected: true } : { ok: false, error: (u && u.code) || 'failed' };
        } catch (_) { return { ok: false, error: 'failed' }; }
      },
    },
    /* ── 폴더 탐색기 위젯 — 등록 루트 내 읽기 전용 ── */
    list_explorer_roots: {
      desc: '탐색기 열람 루트 목록',
      run: async () => {
        try { const r = explorerIpc.getRoots(undefined, ctx); return { ok: true, roots: (r && Array.isArray(r.roots)) ? r.roots : [] }; }
        catch (_) { return { ok: false, error: 'unavailable' }; }
      },
    },
    list_folder: {
      desc: '폴더 내용 나열(등록 루트 안에서만). args = {"path":"..."}',
      run: async (a) => {
        a = a || {};
        if (!a.path) return { ok: false, error: 'need_path' };
        try {
          const r = explorerIpc.list({ path: String(a.path) }, ctx);
          if (!r || r.ok === false) return { ok: false, error: (r && r.code) || 'denied' };
          return { ok: true, path: r.path, entries: (Array.isArray(r.entries) ? r.entries : []).slice(0, 60).map((e) => ({ name: e.name, dir: !!e.isDir })) };
        } catch (_) { return { ok: false, error: 'failed' }; }
      },
    },
    /* ── 오늘의 브리핑 위젯 ── */
    refresh_briefing: {
      desc: 'AI 브리핑 재생성 트리거',
      run: async () => {
        try { const r = briefingIpc.trigger({ reason: 'manual' }, ctx); return (r && r.ok !== false) ? { ok: true } : { ok: false, error: (r && r.code) || 'disabled' }; }
        catch (_) { return { ok: false, error: 'failed' }; }
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

  // [멀티턴] 이전 대화를 history 예산 안으로 다듬어 컨텍스트로 전달(창 - 여유).
  const rawHistory = normalizeHistory(args && args.history);
  const trimmed = trimHistory(rawHistory, CONTEXT_HISTORY_BUDGET);

  // [UI 액티브 이벤트] open_* 도구가 쌓는 렌더러 실행용 액션(메일함/메일 열기 등).
  const uiActions = [];
  const tools = buildTools(ctx, uiActions);
  // [Plan-and-Solve + ReAct + Reflection] 계획 → 실행 → 검증 → (무효면) 재계획.
  const plannerSystem = PLANNER_SYSTEM + '\n사용 가능한 도구: ' + Object.keys(tools).join(', ');
  const res = await runHybrid({
    llm, tools, system: AGENT_SYSTEM, plannerSystem, reflectorSystem: REFLECTOR_SYSTEM,
    message, history: trimmed.history, maxSteps: 6, maxReplans: 30,
  });

  // [컨텍스트 사용현황] 모델이 promptTokens 를 보고하면 그 값(정확), 아니면 프롬프트 char 수로 추정.
  const modelPrompt = res.usage && Number.isFinite(res.usage.promptTokens) ? res.usage.promptTokens : null;
  const contextTokens = (modelPrompt != null) ? modelPrompt : estimateTokens(res.promptChars || 0);
  return {
    ok: !!(res.ok && res.final),   // 최종 답까지 도달해야 성공(도구는 실행됐어도 요약 미도달이면 code 로 안내)
    code: res.code || (res.final ? undefined : 'NO_FINAL'),
    final: res.final || '',
    steps: Array.isArray(res.steps) ? res.steps : [],
    todos: currentTodos(ctx),       // 실행 후 최신 할 일(렌더러가 즉시 반영)
    uiActions: uiActions,           // [UI 액티브 이벤트] 렌더러가 실행할 열기 동작(메일함/메일)
    // [컨텍스트 사용현황과 제한기준] 렌더러가 미터로 표시 — 제한 = 모델 컨텍스트 창 최대치.
    context: {
      tokens: contextTokens,
      limit: CONTEXT_WINDOW_TOKENS,        // 창 최대치(32768) — 사용량/이 값 = 창 사용률
      budget: CONTEXT_HISTORY_BUDGET,      // 대화 history 정리 예산(참고)
      trimmed: trimmed.trimmed,            // 예산 초과로 오래된 턴을 생략했는가
      source: (modelPrompt != null) ? 'model' : 'estimate',
      completionTokens: (res.usage && Number.isFinite(res.usage.completionTokens)) ? res.usage.completionTokens : null,
    },
  };
}

module.exports = { run, buildTools, findTodo, parseDue, normalizeHistory, trimHistory, AGENT_SYSTEM, MAX_MESSAGE_LEN, CONTEXT_WINDOW_TOKENS, CONTEXT_HISTORY_BUDGET };
