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
  return out;
}

module.exports = { buildContext, deriveSnapshot };
