'use strict';
/**
 * electron/ipc/briefing.js — 브리핑 AI IPC 핸들러 (L2, M13 R-34~R-41/N-08)
 *
 * 설계 ③. invoke 채널(getState·trigger·abort·resolveItem·getSettings·setSettings·testConnection).
 * **shape 검증은 각 핸들러 본체의 책임**(register.js guard는 senderFrame만 — rev P1-1).
 * 불량 인자는 { ok:false, code:'BAD_ARGS' }로 거부.
 *
 * 보안:
 *   · getSettings는 키 평문 미포함 — hasApiKey:boolean만(M-2).
 *   · setSettings/testConnection은 baseURL을 M-1(validateBriefingUrl)로 재검증.
 *   · apiKey 미전송 키는 기존 유지(메일 pass 패턴), null=해제. 0600 저장은 config.persistConfigKeys.
 *   · 에러는 고정 enum code만(message·url·key 비노출).
 *
 * carry-over 영속 어댑터(loadItems/saveItems)도 여기서 uiStateStore에 배선 — 오케스트레이터에 주입.
 * 외부 의존성 0(Electron API 미import) — 헤드리스 테스트 가능.
 */

const config = require('../../lib/common/config');
const uiStateStore = require('../../lib/common/uiStateStore');
const briefingPrompt = require('../../lib/ai/briefingPrompt');

/** ctx에서 orchestrator 해석. */
function orch(ctx) {
  return ctx && ctx.briefingOrchestrator;
}

/** spip:briefing:getState — 현재 생성 상태·open 항목·lastError. 인자 무시. */
function getState(_args, ctx) {
  const o = orch(ctx);
  if (!o) return { ok: true, enabled: false, status: 'disabled', items: [], lastError: null };
  const s = o.getState();
  return { ok: true, enabled: s.enabled, status: s.status, items: s.items, lastError: s.lastError || null };
}

/** spip:briefing:trigger — 수동 재생성. reason enum 'manual'만. */
function trigger(args, ctx) {
  const reason = (args && typeof args === 'object') ? args.reason : undefined;
  if (reason !== undefined && reason !== 'manual') return { ok: false, code: 'BAD_ARGS' };
  const o = orch(ctx);
  if (!o) return { ok: false, code: 'DISABLED' };
  try { o.triggerManual(); } catch (_) { return { ok: false, code: 'INTERNAL' }; }
  return { ok: true };
}

/** spip:briefing:abort — 진행 중 호출 취소. 인자 무시. */
function abort(_args, ctx) {
  const o = orch(ctx);
  if (o) { try { o.abort(); } catch (_) { /* noop */ } }
  return { ok: true };
}

/** spip:briefing:resolveItem — 항목 done/dismiss. key 형식·action enum 검증. */
function resolveItem(args, ctx) {
  args = (args && typeof args === 'object') ? args : {};
  const key = args.key;
  const action = args.action;
  if (typeof key !== 'string' || !uiStateStore.BRIEFING_KEY_RE.test(key)) return { ok: false, code: 'BAD_ARGS' };
  if (action !== 'done' && action !== 'dismiss') return { ok: false, code: 'BAD_ARGS' };
  const o = orch(ctx);
  if (!o || typeof o.resolveItem !== 'function') return { ok: false, code: 'INTERNAL' };
  try {
    const items = o.resolveItem(key, action);
    return { ok: true, items: Array.isArray(items) ? items : [] };
  } catch (_) {
    return { ok: false, code: 'INTERNAL' };
  }
}

/** spip:briefing:getSettings — 키 평문 미포함(hasApiKey:boolean만, M-2). 인자 무시. */
function getSettings(_args, ctx) {
  const cfg = (ctx && ctx.config) || {};
  const b = (cfg.briefing && typeof cfg.briefing === 'object') ? cfg.briefing : config.DEFAULTS.briefing;
  const urlCheck = config.validateBriefingUrl(b.baseURL);
  return {
    ok: true,
    enabled: !!b.enabled,
    // [security L-2] 회송 baseURL은 검증 통과값만(불량이면 기본값) — 자격증명 영속은 이미 차단됨.
    baseURL: urlCheck.ok ? urlCheck.value : config.DEFAULTS.briefing.baseURL,
    model: b.model,
    hasApiKey: typeof b.apiKey === 'string' && b.apiKey.length > 0,
    // 사용자 편집 System(지시) 텍스트. 빈 문자열이면 시드 미적용(기본값 사용) 상태 — 시크릿 아님(노출 가능).
    systemPrompt: typeof b.systemPrompt === 'string' ? b.systemPrompt : '',
    // 시드(기본값) — UI의 "기본값 복원"·placeholder용 읽기전용. 키/baseURL 등 비노출 원칙과 무관(노출 가능).
    defaultSystemPrompt: briefingPrompt.DEFAULT_SYSTEM_PROMPT,
    external: urlCheck.ok ? urlCheck.external : false, // 비-localhost 경고용(M-1)
    advanced: {
      coalesceMs: (b.advanced && b.advanced.coalesceMs) || config.DEFAULTS.briefing.advanced.coalesceMs,
      deadlineH: (b.advanced && b.advanced.deadlineH) || config.DEFAULTS.briefing.advanced.deadlineH,
    },
  };
}

/**
 * 설정 patch shape 검증·정규화(setSettings·testConnection 공용).
 * apiKey: 문자열=설정, null=해제, 미전송(undefined)=기존 유지(메일 pass 패턴).
 * @returns {{ ok:boolean, patch?:object, code?:string }}
 */
function validateSettingsArgs(args) {
  args = (args && typeof args === 'object') ? args : {};
  const patch = {};

  if (args.enabled !== undefined) {
    if (typeof args.enabled !== 'boolean') return { ok: false, code: 'BAD_ARGS' };
    patch.enabled = args.enabled;
  }
  if (args.baseURL !== undefined) {
    const v = config.validateBriefingUrl(args.baseURL);
    if (!v.ok) return { ok: false, code: 'BAD_URL' };
    patch.baseURL = v.value;
  }
  if (args.model !== undefined) {
    if (typeof args.model !== 'string' || args.model.length > 200) return { ok: false, code: 'BAD_ARGS' };
    patch.model = args.model;
  }
  if (args.apiKey !== undefined) {
    if (args.apiKey === null) patch.apiKey = '';
    else if (typeof args.apiKey === 'string' && args.apiKey.length <= 4096) patch.apiKey = args.apiKey;
    else return { ok: false, code: 'BAD_ARGS' };
  }
  if (args.systemPrompt !== undefined) {
    // 문자열=설정, 빈 문자열=시드 복원. 길이 상한(여유분 — 정제·clamp는 normalizeBriefing이 강제).
    //   null도 빈 문자열(시드 복원)로 수용. 정제 후 0600 영속은 normalizeBriefing→persist 경로.
    if (args.systemPrompt === null) patch.systemPrompt = '';
    else if (typeof args.systemPrompt === 'string' && args.systemPrompt.length <= 16000) patch.systemPrompt = args.systemPrompt;
    else return { ok: false, code: 'BAD_ARGS' };
  }
  if (args.advanced !== undefined) {
    if (typeof args.advanced !== 'object' || args.advanced === null || Array.isArray(args.advanced)) return { ok: false, code: 'BAD_ARGS' };
    const adv = {};
    if (args.advanced.coalesceMs !== undefined) {
      const n = args.advanced.coalesceMs;
      if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 60000) return { ok: false, code: 'BAD_ARGS' };
      adv.coalesceMs = n;
    }
    if (args.advanced.deadlineH !== undefined) {
      const n = args.advanced.deadlineH;
      if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 24 * 30) return { ok: false, code: 'BAD_ARGS' };
      adv.deadlineH = n;
    }
    patch.advanced = adv;
  }
  return { ok: true, patch };
}

/**
 * spip:briefing:setSettings — 설정 갱신·검증·0600 영속.
 *   apiKey 미전송 키는 기존 유지. 상승 세션이면 persistConfigKeys가 디스크 write 보류(메모리 유지).
 */
function setSettings(args, ctx) {
  const v = validateSettingsArgs(args);
  if (!v.ok) return { ok: false, code: v.code };
  const cfg = (ctx && ctx.config) || {};
  const cur = (cfg.briefing && typeof cfg.briefing === 'object') ? cfg.briefing : Object.assign({}, config.DEFAULTS.briefing);

  // 병합(apiKey 미전송 = 기존 유지). advanced는 부분 병합.
  const mergedAdvanced = Object.assign({}, cur.advanced, v.patch.advanced || {});
  const merged = Object.assign({}, cur, v.patch, { advanced: mergedAdvanced });

  // 정규화(재검증) 후 ctx.config 갱신 + 0600 영속.
  const normalized = config.normalizeBriefing(merged, ctx && ctx.logger);
  if (cfg && typeof cfg === 'object') cfg.briefing = normalized;
  try {
    config.persistConfigKeys({ briefing: normalized }, {
      logger: ctx && ctx.logger,
      configPath: ctx && ctx.configPath,
      deps: ctx && ctx.configDeps,
    });
  } catch (_) {
    return { ok: false, code: 'PERSIST' };
  }
  // 키 평문 회송 0 — getSettings shape로 응답.
  return getSettings(null, ctx);
}

/**
 * spip:briefing:testConnection — 임시값으로 연결 핑. setSettings와 동일 필드 검증.
 *   임시값을 영속하지 않고 일회성 config로 llmClient 호출.
 * @returns {Promise<{ok,model?,latencyMs?,code?}>}
 */
async function testConnection(args, ctx) {
  const v = validateSettingsArgs(args);
  if (!v.ok) return { ok: false, code: v.code };
  const cfg = (ctx && ctx.config) || {};
  const cur = (cfg.briefing && typeof cfg.briefing === 'object') ? cfg.briefing : config.DEFAULTS.briefing;
  const temp = Object.assign({}, cur, v.patch);
  const o = orch(ctx);
  if (!o || typeof o.testConnection !== 'function') return { ok: false, code: 'INTERNAL' };
  try {
    return await o.testConnection(temp);
  } catch (_) {
    return { ok: false, code: 'INTERNAL' };
  }
}

/**
 * carry-over 영속 어댑터 — uiStateStore의 briefing 키 read/write.
 *   상승 세션이면 write가 no-op(메모리 폴백) — 오케스트레이터는 반환 정규화 결과를 진실로 삼는다.
 * @param {object} ctx { logger, uiStatePath?, uiStateDeps? }
 * @returns {{ loadItems, saveItems }}
 */
function makeCarryOverStore(ctx) {
  const storeCtx = () => ({ logger: ctx && ctx.logger, uiStatePath: ctx && ctx.uiStatePath, deps: ctx && ctx.uiStateDeps });
  const store = (ctx && ctx.uiStateStore) || uiStateStore;
  return {
    loadItems() {
      const state = store.read(storeCtx());
      const b = state.briefing || uiStateStore.defaultBriefing();
      // [code-review #1] lastSnapshot 영속값을 반환 — 재시작 후 prev=null 과트리거 방지.
      return { items: b.items, lastSnapshot: b.lastSnapshot || null, counters: b.counters };
    },
    saveItems(next) {
      next = next || {};
      const state = store.read(storeCtx());
      const prevB = state.briefing || uiStateStore.defaultBriefing();
      // [code-review #2] counters 증가(N-10) — delta가 오면 누적.
      const d = (next.counterDelta && typeof next.counterDelta === 'object') ? next.counterDelta : {};
      const counters = {
        generated: (prevB.counters.generated || 0) + (Number(d.generated) > 0 ? Math.floor(d.generated) : 0),
        done: (prevB.counters.done || 0) + (Number(d.done) > 0 ? Math.floor(d.done) : 0),
        dismiss: (prevB.counters.dismiss || 0) + (Number(d.dismiss) > 0 ? Math.floor(d.dismiss) : 0),
      };
      const briefing = {
        items: Array.isArray(next.items) ? next.items : prevB.items,
        lastGenAt: Date.now(),
        lastSnapshotHash: prevB.lastSnapshotHash,
        // [code-review #1] 필요성 판정 기준점 영속(undefined면 기존 유지).
        lastSnapshot: (next.lastSnapshot !== undefined) ? next.lastSnapshot : prevB.lastSnapshot,
        counters,
      };
      // [항목3] LLM 토큰 사용량 누적(usageDelta가 오면 더한다). 표시·집계 전용 수치만.
      const patch = { briefing };
      const ud = (next.usageDelta && typeof next.usageDelta === 'object') ? next.usageDelta : null;
      if (ud) {
        const prevU = state.aiUsage || uiStateStore.defaultAiUsage();
        const add = (a, b) => (a || 0) + (Number(b) > 0 ? Math.floor(b) : 0);
        patch.aiUsage = {
          calls: (prevU.calls || 0) + 1,
          promptTokens: add(prevU.promptTokens, ud.promptTokens),
          completionTokens: add(prevU.completionTokens, ud.completionTokens),
          totalTokens: add(prevU.totalTokens, ud.totalTokens),
          lastModel: (typeof ud.model === 'string' && ud.model) ? ud.model : (prevU.lastModel || ''),
          lastAt: Date.now(),
        };
      }
      const written = store.write(Object.assign({}, state, patch), storeCtx());
      return written.briefing;
    },
  };
}

module.exports = {
  getState,
  trigger,
  abort,
  resolveItem,
  getSettings,
  setSettings,
  testConnection,
  validateSettingsArgs,
  makeCarryOverStore,
};
