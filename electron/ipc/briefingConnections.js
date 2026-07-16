'use strict';
/**
 * electron/ipc/briefingConnections.js — 복수 AI 연결 관리 IPC (mailAccounts.js 패턴 차용)
 *
 *   spip:briefing:getConnections           → { connections:[공개뷰], activeId }  (apiKey 평문 제외)
 *   spip:briefing:addConnection {label?}   → 기본값 시드로 새 연결 추가 + 즉시 활성화(사용자가 바로 편집)
 *   spip:briefing:removeConnection {id}     → 삭제(마지막 1개는 유지). 활성 삭제 시 첫 연결로 활성 이동
 *   spip:briefing:activateConnection {id}   → 활성 전환(→ briefing 미러 갱신, 라이브 리더가 즉시 반영)
 *
 * 연결의 세부 설정(baseURL·model·apiKey·systemPrompt·라벨) 편집은 기존 briefing:setSettings 가
 *   **활성 연결**을 대상으로 수행한다(미러 불변식 유지). 여기서는 목록/활성만 다룬다.
 *
 * 보안:
 *   · 응답에 apiKey 평문 미포함(toPublicList). getConfig(data.js)도 briefing/connections 미노출.
 *   · 변경은 persistConfigKeys({briefing, briefingConnections, activeBriefingId})로 0600 원자적 부분 갱신.
 *   · briefing 미러·검증은 config.normalizeBriefing 단일 경계에 위임(레지스트리 resolveState 경유).
 *
 * [헤드리스 검증] Electron API 미import. persistConfigKeys 는 ctx 주입 가능(기본 실제 모듈).
 */

const config = require('../../lib/common/config');
const reg = require('../../lib/ai/briefingConnections');

/** ctx 의존성 해석(주입 우선). */
function deps(ctx) {
  return {
    persistConfigKeys: (ctx && typeof ctx.persistConfigKeys === 'function') ? ctx.persistConfigKeys : config.persistConfigKeys,
    normalizeSettings: (inp) => config.normalizeBriefing(inp, ctx && ctx.logger),
  };
}

/** 현재 브리핑 연결 상태(메모리 config). */
function state(ctx) {
  const cfg = (ctx && ctx.config) || {};
  return {
    briefing: (cfg.briefing && typeof cfg.briefing === 'object') ? cfg.briefing : config.DEFAULTS.briefing,
    connections: Array.isArray(cfg.briefingConnections) ? cfg.briefingConnections : [],
    activeId: typeof cfg.activeBriefingId === 'string' ? cfg.activeBriefingId : '',
  };
}

/** 변경 반영 — resolveState 로 미러 불변식 재확립 후 메모리 갱신 + 0600 영속. */
function commit(next, ctx, d) {
  const resolved = reg.resolveState(next.briefing, next.connections, next.activeId, { normalizeSettings: d.normalizeSettings });
  const cfg = (ctx && ctx.config) || {};
  if (cfg && typeof cfg === 'object') {
    cfg.briefing = resolved.briefing;
    cfg.briefingConnections = resolved.connections;
    cfg.activeBriefingId = resolved.activeId;
  }
  d.persistConfigKeys(
    { briefing: resolved.briefing, briefingConnections: resolved.connections, activeBriefingId: resolved.activeId },
    { logger: ctx && ctx.logger, configPath: ctx && ctx.configPath, deps: ctx && ctx.configDeps },
  );
  return resolved;
}

/** spip:briefing:getConnections — 공개 목록(apiKey 제외) + 활성 id. */
function getConnections(_args, ctx) {
  const s = state(ctx);
  return { ok: true, connections: reg.toPublicList(s.connections), activeId: s.activeId };
}

/** spip:briefing:addConnection — 기본값 시드로 새 연결 추가 + 즉시 활성화. */
function addConnection(args, ctx) {
  const d = deps(ctx);
  const s = state(ctx);
  const label = (args && typeof args === 'object' && typeof args.label === 'string') ? args.label : '';
  // 새 연결은 앱 기본값(로컬 LM Studio 등)으로 시드하고 라벨만 입력값 사용.
  const seedInput = Object.assign({}, config.DEFAULTS.briefing, { label });
  const res = reg.addConnection(s.connections, seedInput, { normalizeSettings: d.normalizeSettings });
  if (!res.ok) return { ok: false, code: res.code };
  commit({ briefing: s.briefing, connections: res.connections, activeId: res.connection.id }, ctx, d);
  return getConnections(null, ctx);
}

/** spip:briefing:removeConnection — 삭제(마지막 1개 유지). 활성 삭제 시 첫 연결로 활성 이동. */
function removeConnection(args, ctx) {
  const d = deps(ctx);
  const s = state(ctx);
  const id = (args && typeof args === 'object') ? args.id : undefined;
  if (typeof id !== 'string' || !id) return { ok: false, code: 'NOT_FOUND' };
  const cur = reg.normalizeConnections(s.connections, { normalizeSettings: d.normalizeSettings });
  if (cur.length <= 1) return { ok: false, code: 'LAST' }; // 최소 1개 연결 유지
  const res = reg.removeConnection(s.connections, id, { normalizeSettings: d.normalizeSettings });
  if (!res.ok) return { ok: false, code: res.code };
  let activeId = s.activeId;
  if (activeId === id) activeId = (res.connections[0] && res.connections[0].id) || '';
  commit({ briefing: s.briefing, connections: res.connections, activeId }, ctx, d);
  return getConnections(null, ctx);
}

/** spip:briefing:activateConnection — 활성 전환(→ briefing 미러 갱신). */
function activateConnection(args, ctx) {
  const d = deps(ctx);
  const s = state(ctx);
  const id = (args && typeof args === 'object') ? args.id : undefined;
  if (typeof id !== 'string' || !id) return { ok: false, code: 'NOT_FOUND' };
  const cur = reg.normalizeConnections(s.connections, { normalizeSettings: d.normalizeSettings });
  if (!cur.find((c) => c.id === id)) return { ok: false, code: 'NOT_FOUND' };
  commit({ briefing: s.briefing, connections: cur, activeId: id }, ctx, d);
  return getConnections(null, ctx);
}

module.exports = {
  getConnections,
  addConnection,
  removeConnection,
  activateConnection,
};
