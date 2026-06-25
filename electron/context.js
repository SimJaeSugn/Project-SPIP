'use strict';
/**
 * electron/context.js — composition root (server.js 승계, electron-migration §7.1 단계 1)
 *
 * server.js의 createServer가 하던 "조립" 중 HTTP 무관 부분만 승계한다:
 *   config 로드 → snapshotStore 적재(P2-5 graceful) → 전역 단일 ScanController 생성.
 * HTTP 전용(http.createServer·listen·세션토큰·Host/Origin allowlist)은 전부 드롭(§6.1).
 *
 * [헤드리스 검증, F-3] Electron API 미import. buildContext는 ctx 형태
 *   { config, store, scanController, cachePath, logger }를 반환하며 단위테스트 가능.
 *
 * 외부 의존성 0 — 내부(config, logger, snapshotStore, scanController)만.
 */

const { loadConfig } = require('../lib/common/config');
const { Logger } = require('../lib/common/logger');
const { SnapshotStore } = require('../lib/server/snapshotStore');
const { ScanController } = require('../lib/server/scanController');
const { StateWatcher } = require('../lib/server/stateWatcher');
const { MailWatcherManager } = require('../lib/mail/mailWatcherManager');
const { BriefingOrchestrator } = require('../lib/ai/briefingOrchestrator');
const { createLlmClient } = require('../lib/ai/llmClient');
const briefingIpc = require('./ipc/briefing');
const uiStateStore = require('../lib/common/uiStateStore');
const claudeUsage = require('../lib/ai/claudeUsage');

/**
 * 앱 컨텍스트를 조립해 반환한다.
 * @param {object} [opts] { logger, cachePath, quiet }
 * @returns {{ config, store, scanController, cachePath, logger, loaded }}
 */
function buildContext(opts) {
  opts = opts || {};
  const logger = opts.logger || new Logger({ quiet: !!opts.quiet });

  const { config } = loadConfig({ logger });

  const store = new SnapshotStore();
  const loaded = store.load({ cachePath: opts.cachePath, logger });

  const scanController = new ScanController({ logger });
  // [R-24] 상태 주시 워처(재스캔 없이 git·freshness 주기 재수집). 시작/배선은 main이 담당.
  const stateWatcher = new StateWatcher({ logger, intervalMs: opts.watchIntervalMs });
  // 복수 계정 메일 주기 감시 관리자. 계정 적용·시작/배선·트레이 알림은 main이 담당(여기선 조립만).
  const mailManager = new MailWatcherManager({ logger, intervalMs: opts.mailIntervalMs });

  const ctx = {
    config,
    store,
    scanController,
    stateWatcher,
    mailManager,
    cachePath: opts.cachePath, // 미지정이면 lib가 기본 경로(paths.cachePath) 사용
    uiStatePath: opts.uiStatePath, // [브리핑 일정] deriveSnapshot이 할 일 마감을 읽을 ui-state 경로(미지정=기본)
    logger,
    loaded,
  };

  // [M13] 브리핑 오케스트레이터 조립(opt-in — enabled=false면 notify가 즉시 무동작).
  //   egress는 메인 단독(llmClient만 Langchain). push 콜백·snapshotProvider·isSuppressed는 main이 setPush로 주입.
  //   getConfig는 ctx.config를 읽어 설정 변경이 재시작 없이 다음 호출에 반영(R-34).
  const carryOverStore = briefingIpc.makeCarryOverStore({ logger, uiStatePath: opts.uiStatePath });
  const getConfig = () => ({ briefing: ctx.config.briefing });
  const llmClient = createLlmClient({ getConfig, logger });
  ctx.briefingOrchestrator = new BriefingOrchestrator({
    getConfig,
    logger,
    llmClient,
    loadItems: carryOverStore.loadItems,
    saveItems: carryOverStore.saveItems,
    // 임시 설정 연결 테스트용 일회성 클라이언트(영속 안 함) — getConfig가 임시 briefing 반환.
    makeTestClient: (tempBriefing) => createLlmClient({ getConfig: () => ({ briefing: tempBriefing }), logger }),
    // snapshotProvider·push·isSuppressed는 main.js가 setPush로 주입(webContents 바인딩 필요).
    snapshotProvider: () => deriveSnapshot(ctx),
    // [브리핑 토큰리포트] 토큰 사용량 요약 제공(연결 모델 누적 + Claude Code 추이). 생성 시점에 1회 호출.
    usageProvider: makeUsageProvider({ uiStatePath: opts.uiStatePath, logger }),
  });

  return ctx;
}

/**
 * 현재 데이터에서 브리핑 스냅샷을 도출한다(메인 측, M13-Q-1 — 실제 신호 발화).
 *   · git(dirty/ahead/behind)·attention: store 프로젝트.
 *   · disk.reclaimBytes: 프로젝트 node_modules 용량 합(회수 후보 근사).
 *   · mail.unseen/latestUid: main이 주입한 동기 mailState getter(MailWatcher onNewMail로 갱신).
 *   · deadlines: 현재 todo 스키마에 dueAt 부재 → 빈 배열(스키마 확장 시 활성. policy/auto-resolve는 이미 구현).
 * @param {object} ctx
 * @param {object} [extra] { mailState?:()=>{unseen,latestUid} }
 */
function deriveSnapshot(ctx, extra) {
  extra = extra || {};
  const out = { projects: [], deadlines: [], mail: { unseen: 0, latestUid: null }, disk: { reclaimBytes: 0 }, scan: { generatedAt: null } };
  try {
    const store = ctx && ctx.store;
    if (store && typeof store.getProjects === 'function' && store.hasSnapshot) {
      let reclaim = 0;
      for (const p of store.getProjects()) {
        if (!p || typeof p.id !== 'string') continue;
        const g = p.git || {};
        out.projects.push({
          id: p.id,
          // [briefing name] 사용자 호명용 표시 이름(신뢰 불가·스캔 유래). 없으면 빈 문자열 graceful.
          name: (typeof p.name === 'string') ? p.name : '',
          dirty: g.dirty === true,
          ahead: (typeof g.ahead === 'number') ? g.ahead : 0,
          behind: (typeof g.behind === 'number') ? g.behind : 0,
          attention: !!(p.freshness && p.freshness.isStale),
        });
        const nm = (p.size && typeof p.size.nodeModulesBytes === 'number') ? p.size.nodeModulesBytes : 0;
        if (nm > 0) reclaim += nm;
      }
      out.disk.reclaimBytes = reclaim;
      const gen = (typeof store.getGeneratedAt === 'function') ? store.getGeneratedAt() : null;
      out.scan.generatedAt = (typeof gen === 'string') ? gen : null;
    }
  } catch (_) { /* graceful — 빈 스냅샷 */ }
  // 새 메일 신호(이벤트형) — main이 주입한 동기 mailState getter(IMAP 재호출 없이 캐시값).
  try {
    if (typeof extra.mailState === 'function') {
      const ms = extra.mailState() || {};
      out.mail.unseen = (typeof ms.unseen === 'number' && ms.unseen >= 0) ? ms.unseen : 0;
      out.mail.latestUid = (typeof ms.latestUid === 'string' && ms.latestUid) ? ms.latestUid : null;
    }
  } catch (_) { /* graceful */ }
  // [브리핑 일정] 할 일 마감(dueAt) → deadlines 신호 입력. ui-state에서 읽어 매핑(dueAt 보유 항목만).
  //   정책(briefingPolicy)이 임박(24h 이내)·경과 미완료를 URGENT deadline 신호로 발화한다. 미완료만 의미 있으나
  //   done도 그대로 전달(정책이 필터·auto-resolve). 읽기는 작은 로컬 JSON — graceful(실패 시 빈 deadlines).
  try {
    const ui = uiStateStore.read({ uiStatePath: ctx && ctx.uiStatePath, logger: ctx && ctx.logger });
    const todos = Array.isArray(ui.todos) ? ui.todos : [];
    for (const t of todos) {
      if (!t || typeof t.id !== 'string' || typeof t.dueAt !== 'number' || !Number.isFinite(t.dueAt)) continue;
      out.deadlines.push({ id: t.id, name: (typeof t.text === 'string') ? t.text : '', dueAt: t.dueAt, done: t.done === true });
    }
  } catch (_) { /* graceful — 빈 deadlines */ }
  return out;
}

/** [브리핑 토큰리포트] 토큰 수 압축 표기(1.2k·3.4M). */
function fmtTok(n) {
  n = (typeof n === 'number' && Number.isFinite(n) && n > 0) ? Math.floor(n) : 0;
  if (n < 1000) return String(n);
  if (n < 1000000) return (n / 1000).toFixed(1) + 'k';
  return (n / 1000000).toFixed(2) + 'M';
}

/**
 * [브리핑 토큰리포트] 사용량 요약 문자열 — 연결 모델 누적(aiUsage) + Claude Code 추이(최근7일 vs 직전7일).
 *   수치만(본문 비노출). 데이터 없으면 null.
 */
function buildUsageSummary(aiUsage, claude) {
  const parts = [];
  if (aiUsage && aiUsage.calls > 0) {
    parts.push('[연결 모델] 누적 ' + fmtTok(aiUsage.totalTokens) + '토큰·' + aiUsage.calls + '회 호출'
      + (aiUsage.lastModel ? ('(' + aiUsage.lastModel + ')') : ''));
  }
  if (claude && claude.available && claude.totals) {
    const daily = Array.isArray(claude.daily) ? claude.daily : [];
    const n = daily.length;
    let r7 = 0; let p7 = 0;
    for (let i = 0; i < n; i++) {
      const v = (daily[i] && daily[i].totalTokens) || 0;
      if (i >= n - 7) r7 += v; else if (i >= n - 14) p7 += v;
    }
    const trend = r7 > p7 * 1.1 ? '증가세' : (r7 < p7 * 0.9 ? '감소세' : '비슷');
    const today = (claude.today && claude.today.totalTokens) || 0;
    parts.push('[Claude Code] 오늘 ' + fmtTok(today) + '토큰, 최근7일 ' + fmtTok(r7)
      + '(직전7일 ' + fmtTok(p7) + ', 추세 ' + trend + '), 누적 ' + fmtTok(claude.totals.totalTokens));
  }
  return parts.length ? parts.join(' / ') : null;
}

/**
 * [브리핑 토큰리포트] usageProvider 팩토리 — 생성 시점에 호출되어 요약 문자열을 반환.
 *   연결 모델 aiUsage는 ui-state에서 매번 읽고(싸다), Claude Code 집계는 무거운 스캔이라 10분 캐시.
 * @param {object} deps { uiStatePath?, logger? }
 * @returns {() => (string|null)}
 */
function makeUsageProvider(deps) {
  deps = deps || {};
  let claudeCache = null;
  let claudeAt = 0;
  const TTL = 10 * 60 * 1000;
  return function usageProvider() {
    let aiUsage = null;
    try { aiUsage = uiStateStore.read({ uiStatePath: deps.uiStatePath, logger: deps.logger }).aiUsage; } catch (_) { /* graceful */ }
    const nowMs = Date.now();
    if (!claudeCache || (nowMs - claudeAt) > TTL) {
      try { claudeCache = claudeUsage.summarizeClaudeUsage({ logger: deps.logger }); claudeAt = nowMs; } catch (_) { /* graceful */ }
    }
    return buildUsageSummary(aiUsage, claudeCache);
  };
}

module.exports = { buildContext, deriveSnapshot, buildUsageSummary, makeUsageProvider };
