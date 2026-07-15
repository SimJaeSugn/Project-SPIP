'use strict';
/**
 * lib/ai/agent.js — 미니 ReAct 에이전트 루프 (AG-1, 헤드리스·주입식)
 *
 * docs/ref.md 의 [Plan-and-Solve + ReAct + Reflection] 개념 중 **POC로 ReAct 루프**를 구현한다.
 *   매 스텝: LLM 이 JSON 한 개를 낸다 → 도구 호출({tool,args}) 또는 종료({final}).
 *   도구를 실행해 Observation 을 스크래치패드에 누적하고, final 이 나오거나 maxSteps 도달까지 반복한다.
 *
 * 순수·주입식: llm(system,user)·tools 를 인자로 받는다(네트워크·Electron 의존 0). 실제 LLM/툴 배선은
 *   호출측(electron/ipc/agent.js)이 담당 → 이 모듈은 node --test 로 전량 검증된다.
 *   확장 여지: planner/reflector 노드를 앞뒤에 얹으면 ref.md 의 전체 하이브리드로 확장된다.
 */

const MAX_STEPS_DEFAULT = 6;
// 도구 관찰(observation) 최대 길이(char). 문서 본문처럼 큰 결과를 LLM 이 실제로 참조할 수 있게 넉넉히 —
//   너무 작으면 문서를 읽고도 앞부분만 보여 "내용 없음"으로 오판·환각한다. 32768 토큰 창에 안전한 상한.
const MAX_OBSERVATION_CHARS = 24000;

/** 모델 출력에서 첫 번째 '균형 잡힌' JSON 객체를 추출한다(코드펜스·잡설이 섞여도). 실패 시 null. */
function extractJson(text) {
  if (typeof text !== 'string') return null;
  let s = text.trim();
  const fence = /```[a-zA-Z]*\s*\n([\s\S]*?)\n```/.exec(s);
  if (fence) s = fence[1].trim();
  const start = s.indexOf('{');
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) { try { return JSON.parse(s.slice(start, i + 1)); } catch (_) { return null; } } }
  }
  return null;
}

/** 대략적 토큰 추정(모델 usage 미보고 시 폴백) — 한글·영문 혼합 기준 ~3.5자/토큰. */
function estimateTokens(charsOrText) {
  const n = (typeof charsOrText === 'number') ? charsOrText : String(charsOrText || '').length;
  return Math.ceil(n / 3.5);
}

/** 이전 대화(멀티턴) → 프롬프트용 텍스트. role: 'user'|'assistant'. 없으면 ''. */
function renderHistory(history) {
  if (!Array.isArray(history) || !history.length) return '';
  const lines = history.map(function (h) {
    const who = (h && h.role === 'assistant') ? '에이전트' : '사용자';
    return who + ': ' + String((h && h.content) || '');
  });
  return '[이전 대화]\n' + lines.join('\n') + '\n\n';
}

/** 스크래치패드(누적 스텝) → LLM 다음 호출용 텍스트. */
function renderScratchpad(steps) {
  if (!steps || !steps.length) return '(아직 실행한 단계 없음)';
  return steps.map(function (st, i) {
    if (st.tool) {
      return '단계 ' + (i + 1) + '\nThought: ' + (st.thought || '') +
        '\nAction: ' + st.tool + '(' + JSON.stringify(st.args || {}) + ')' +
        '\nObservation: ' + st.observation;
    }
    return '단계 ' + (i + 1) + '\nThought: ' + (st.thought || '') + '\n(관찰: ' + (st.observation || '') + ')';
  }).join('\n\n');
}

/**
 * ReAct 루프 실행.
 * @param {object} deps
 *   - llm(system, user) => Promise<{ok:boolean, text:string, code?:string}>  (LLM 1회 호출)
 *   - tools: { name: { desc?:string, run(args)=>Promise<any> } }
 *   - system: string   시스템 프롬프트(도구 설명·JSON 프로토콜 포함)
 *   - message: string  사용자 요청
 *   - maxSteps?: number
 * @returns {Promise<{ok:boolean, final:string, steps:Array, code?:string}>}
 */
async function runAgent(deps) {
  deps = deps || {};
  const llm = deps.llm;
  const tools = deps.tools || {};
  const maxSteps = (typeof deps.maxSteps === 'number' && deps.maxSteps > 0) ? Math.floor(deps.maxSteps) : MAX_STEPS_DEFAULT;
  const historyBlock = renderHistory(deps.history); // 멀티턴: 이전 대화(있으면)
  const steps = [];
  let lastUsage = null;      // 모델이 보고한 마지막 usage(promptTokens 등)
  let lastPromptChars = 0;   // 마지막으로 보낸 프롬프트 char 수(컨텍스트 크기 추정 프록시)
  if (typeof llm !== 'function') return { ok: false, code: 'NO_LLM', final: '', steps, usage: null, promptChars: 0 };

  const planBlock = (Array.isArray(deps.plan) && deps.plan.length)
    ? '[계획]\n' + deps.plan.map((s, i) => (i + 1) + '. ' + String(s)).join('\n') + '\n(이 계획을 따라 도구로 수행하라. 계획이 이미 이뤄졌으면 final 로 마무리하라.)\n\n'
    : '';
  for (let i = 0; i < maxSteps; i++) {
    const user = historyBlock + planBlock + '[요청]\n' + String(deps.message || '') +
      '\n\n[스크래치패드]\n' + renderScratchpad(steps) +
      '\n\n이제 다음 한 단계를 JSON 하나로만 출력하라(설명·코드펜스 없이).';
    lastPromptChars = (String(deps.system || '').length) + user.length;
    let r;
    try { r = await llm(deps.system, user); } catch (_) { r = null; }
    if (!r || !r.ok) return { ok: false, code: (r && r.code) || 'LLM_ERROR', final: '', steps, usage: lastUsage, promptChars: lastPromptChars };
    if (r.usage && typeof r.usage === 'object') lastUsage = r.usage;

    const parsed = extractJson(r.text);
    if (!parsed || typeof parsed !== 'object') {
      steps.push({ thought: '', tool: null, observation: '출력이 JSON 형식이 아님 — 반드시 JSON 하나만 출력하라.' });
      continue; // 스크래치패드에 실패를 남기고 재시도(maxSteps 로 무한루프 방지)
    }
    if (typeof parsed.final === 'string') {
      return { ok: true, final: parsed.final, steps: steps.concat([{ thought: parsed.thought || '', final: parsed.final }]), usage: lastUsage, promptChars: lastPromptChars };
    }
    const toolName = (typeof parsed.tool === 'string') ? parsed.tool : '';
    const tool = tools[toolName];
    if (!tool || typeof tool.run !== 'function') {
      steps.push({ thought: parsed.thought || '', tool: toolName || '(없음)', args: parsed.args || {},
        observation: '알 수 없는 도구. 사용 가능: ' + Object.keys(tools).join(', ') });
      continue;
    }
    let obs;
    try { obs = await tool.run(parsed.args || {}); } catch (_) { obs = { ok: false, error: 'tool_error' }; }
    steps.push({ thought: parsed.thought || '', tool: toolName, args: parsed.args || {}, observation: safeStringify(obs) });
  }
  return { ok: true, final: '', code: 'MAX_STEPS', steps, usage: lastUsage, promptChars: lastPromptChars }; // 스텝 소진 — 부분 결과·트레이스 반환
}

/** 관찰 결과를 안전하게 문자열화(순환·과대 방지). 문서 등 큰 결과도 LLM 이 참조하도록 넉넉히 클램프. */
function safeStringify(v) {
  try { const s = JSON.stringify(v); return (typeof s === 'string') ? s.slice(0, MAX_OBSERVATION_CHARS) : String(v); }
  catch (_) { return String(v); }
}

/* ── [Plan-and-Solve] 플래너: 요청(+피드백) → 하위 작업 계획 목록 ── */
async function planStep(llm, args) {
  args = args || {};
  const hist = renderHistory(args.history);
  let user = hist + '[요청]\n' + String(args.message || '') + '\n';
  if (args.critique) {
    user += '\n[이전 시도 피드백]\n' + String(args.critique) + '\n(이 피드백을 반영해 계획을 수정하라)\n';
    if (Array.isArray(args.prevPlan) && args.prevPlan.length) user += '\n[이전 계획]\n' + args.prevPlan.map((s, i) => (i + 1) + '. ' + s).join('\n') + '\n';
  }
  user += '\n하위 작업 계획을 JSON 하나로만 출력하라: {"plan":["1단계 ...","2단계 ..."]} (3~6개 이내, 도구로 수행 가능한 단위로).';
  let r;
  try { r = await llm(String(args.system || ''), user); } catch (_) { r = null; }
  if (!r || !r.ok) return { ok: false, plan: [], usage: r && r.usage, code: (r && r.code) || 'LLM_ERROR' };
  const parsed = extractJson(r.text);
  const plan = (parsed && Array.isArray(parsed.plan)) ? parsed.plan.filter((x) => typeof x === 'string' && x.trim()).slice(0, 8) : [];
  return { ok: plan.length > 0, plan, usage: r.usage };
}

/* ── [Reflection] 리플렉터: 실행 결과 검증 → is_valid + critique ── */
async function reflectStep(llm, args) {
  args = args || {};
  const trace = renderScratchpad((args.steps || []).filter((s) => s.tool || s.final));
  const user = '[요청]\n' + String(args.message || '') +
    '\n\n[계획]\n' + ((args.plan || []).map((s, i) => (i + 1) + '. ' + s).join('\n') || '(없음)') +
    '\n\n[실행 트레이스]\n' + trace +
    '\n\n[최종 답변]\n' + (String(args.final || '') || '(없음)') +
    '\n\n요청이 실제로 충족됐는지, 도구 관찰에 실패(ok:false)·누락이 있는지, 최종 답변이 관찰과 어긋나는(환각) 부분이 있는지 검증하라.' +
    '\n검증 결과를 JSON 하나로만 출력하라: {"is_valid":true|false,"critique":"무효면 무엇을 어떻게 고쳐야 하는지 구체적으로"}';
  let r;
  try { r = await llm(String(args.system || ''), user); } catch (_) { r = null; }
  // 검증 자체가 실패하면 통과로 간주(무한 루프 방지 — 안전 기본값).
  if (!r || !r.ok) return { ok: false, is_valid: true, critique: '', usage: r && r.usage };
  const parsed = extractJson(r.text);
  if (!parsed || typeof parsed.is_valid !== 'boolean') return { ok: false, is_valid: true, critique: '', usage: r.usage };
  return { ok: true, is_valid: parsed.is_valid, critique: (typeof parsed.critique === 'string') ? parsed.critique : '', usage: r.usage };
}

/**
 * [Plan-and-Solve + ReAct + Reflection 하이브리드] 오케스트레이터.
 *   plan_node → execute_node(ReAct) → reflect_node → (is_valid ? END : plan_node 재계획).
 * @param {object} deps runAgent deps + { plannerSystem, reflectorSystem, maxReplans? }
 * @returns {Promise<{ok, final, steps, usage, promptChars, code, isValid, replans}>}
 */
async function runHybrid(deps) {
  deps = deps || {};
  const llm = deps.llm;
  if (typeof llm !== 'function') return { ok: false, code: 'NO_LLM', final: '', steps: [], usage: null, promptChars: 0 };
  const maxReplans = (typeof deps.maxReplans === 'number' && deps.maxReplans >= 0) ? Math.floor(deps.maxReplans) : 1;
  const allSteps = [];
  let usage = null, promptChars = 0, critique = '', prevPlan = null, last = null, isValid = false, replans = 0;

  for (let iter = 0; iter <= maxReplans; iter++) {
    // 1) Plan(재계획이면 critique 반영)
    const p = await planStep(llm, { system: deps.plannerSystem, message: deps.message, history: deps.history, critique, prevPlan });
    if (p.usage) usage = p.usage;
    const plan = p.plan || [];
    allSteps.push({ phase: 'plan', plan, replan: iter > 0, critique: iter > 0 ? critique : '' });
    prevPlan = plan;

    // 2) Execute(ReAct 루프 — 계획을 컨텍스트로)
    const ex = await runAgent({ llm, tools: deps.tools, system: deps.system, message: deps.message, history: deps.history, plan, maxSteps: deps.maxSteps });
    if (ex.usage) usage = ex.usage;
    if (ex.promptChars) promptChars = ex.promptChars;
    (ex.steps || []).forEach((s) => allSteps.push(s));
    last = ex;
    if (!ex.ok) break; // LLM 오류 → 중단

    // 3) Reflect(검증)
    const rf = await reflectStep(llm, { system: deps.reflectorSystem, message: deps.message, plan, final: ex.final, steps: ex.steps });
    if (rf.usage) usage = rf.usage;
    allSteps.push({ phase: 'reflect', is_valid: rf.is_valid, critique: rf.critique });
    isValid = rf.is_valid;
    if (rf.is_valid || !rf.ok) break; // 통과 또는 검증 실패(안전 통과) → 종료
    if (iter >= maxReplans) break;    // 재계획 예산 소진 → 현재 결과로 종료(무한루프 방지)
    critique = rf.critique || '결과가 요청을 충족하지 못했다. 다시 계획하라.';
    replans += 1;
    // 루프 → 재계획
  }
  return {
    ok: !!(last && last.ok && last.final), final: (last && last.final) || '',
    steps: allSteps, usage, promptChars, code: last && last.code, isValid, replans,
  };
}

module.exports = { runAgent, runHybrid, planStep, reflectStep, extractJson, renderScratchpad, renderHistory, estimateTokens, safeStringify, MAX_STEPS_DEFAULT };
