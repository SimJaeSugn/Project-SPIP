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
  const steps = [];
  if (typeof llm !== 'function') return { ok: false, code: 'NO_LLM', final: '', steps };

  for (let i = 0; i < maxSteps; i++) {
    const user = '[요청]\n' + String(deps.message || '') +
      '\n\n[스크래치패드]\n' + renderScratchpad(steps) +
      '\n\n이제 다음 한 단계를 JSON 하나로만 출력하라(설명·코드펜스 없이).';
    let r;
    try { r = await llm(deps.system, user); } catch (_) { r = null; }
    if (!r || !r.ok) return { ok: false, code: (r && r.code) || 'LLM_ERROR', final: '', steps };

    const parsed = extractJson(r.text);
    if (!parsed || typeof parsed !== 'object') {
      steps.push({ thought: '', tool: null, observation: '출력이 JSON 형식이 아님 — 반드시 JSON 하나만 출력하라.' });
      continue; // 스크래치패드에 실패를 남기고 재시도(maxSteps 로 무한루프 방지)
    }
    if (typeof parsed.final === 'string') {
      return { ok: true, final: parsed.final, steps: steps.concat([{ thought: parsed.thought || '', final: parsed.final }]) };
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
  return { ok: true, final: '', code: 'MAX_STEPS', steps }; // 스텝 소진(최종 답 미도달) — 부분 결과·트레이스는 반환
}

/** 관찰 결과를 안전하게 문자열화(순환·과대 방지). */
function safeStringify(v) {
  try { const s = JSON.stringify(v); return (typeof s === 'string') ? s.slice(0, 2000) : String(v); }
  catch (_) { return String(v); }
}

module.exports = { runAgent, extractJson, renderScratchpad, safeStringify, MAX_STEPS_DEFAULT };
