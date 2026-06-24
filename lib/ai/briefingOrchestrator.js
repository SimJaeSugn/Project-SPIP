'use strict';
/**
 * lib/ai/briefingOrchestrator.js — 트리거·coalesce·단일 in-flight·push 상태머신 (L2)
 *
 * 설계 ④. 메인 데이터 변경을 받아 briefingPolicy로 필요성 판정 → 인디케이터 push(≤300ms,
 * LLM 호출 전) → coalesce(2000ms)/fast-path → carry-over 병합 → 프롬프트 조립 → llmClient
 * 스트림 → delta/done/error push. 단일 in-flight(신규 트리거 시 이전 abort + 세대++).
 *
 * 순수 코어(policy·items·prompt·parse)는 주입 없이 require(외부 의존성 0). 부수효과(타이머·
 * push·llm·store·config·snapshotProvider)는 deps로 주입 — 가짜 타이머·모킹 client로 헤드리스 테스트.
 *
 * 가시성/스캔 가드(N-09): isSuppressed()가 true면 트리거 억제. delta는 ~80ms 배치 flush(RK3).
 */

const policy = require('./briefingPolicy');
const items = require('./briefingItems');
const prompt = require('./briefingPrompt');
const parse = require('./briefingParse');
const C = require('./briefingConst');

const STATUS = Object.freeze({
  IDLE: 'idle', GENERATING: 'generating', STREAMING: 'streaming',
  DONE: 'done', ERROR: 'error', DISABLED: 'disabled',
});

class BriefingOrchestrator {
  /**
   * @param {object} deps {
   *   getConfig, logger?, llmClient, snapshotProvider,
   *   loadItems, saveItems,           // carry-over 영속(uiStateStore 어댑터)
   *   pushState, pushDelta, pushDone, pushError, // 단방향 push(메인→렌더러)
   *   isSuppressed?,                  // () => bool 가시성/스캔 가드
   *   setTimeoutFn?, clearTimeoutFn?, now?, makeAbort?,
   * }
   */
  constructor(deps) {
    deps = deps || {};
    this._getConfig = typeof deps.getConfig === 'function' ? deps.getConfig : () => ({});
    this._logger = deps.logger || null;
    this._llm = deps.llmClient;
    this._snapshot = typeof deps.snapshotProvider === 'function' ? deps.snapshotProvider : () => ({});
    this._loadItems = typeof deps.loadItems === 'function' ? deps.loadItems : () => ({ items: [], lastSnapshot: null });
    this._saveItems = typeof deps.saveItems === 'function' ? deps.saveItems : () => {};
    this._pushState = typeof deps.pushState === 'function' ? deps.pushState : () => {};
    this._pushDelta = typeof deps.pushDelta === 'function' ? deps.pushDelta : () => {};
    this._pushDone = typeof deps.pushDone === 'function' ? deps.pushDone : () => {};
    this._pushError = typeof deps.pushError === 'function' ? deps.pushError : () => {};
    this._isSuppressed = typeof deps.isSuppressed === 'function' ? deps.isSuppressed : () => false;
    this._setTimeout = deps.setTimeoutFn || ((fn, ms) => setTimeout(fn, ms));
    this._clearTimeout = deps.clearTimeoutFn || ((t) => clearTimeout(t));
    this._now = typeof deps.now === 'function' ? deps.now : () => Date.now();
    this._makeAbort = typeof deps.makeAbort === 'function' ? deps.makeAbort : () => new AbortController();
    // 연결 테스트용 일회성 클라이언트 팩토리(임시 briefing 설정 바인딩). 미주입 시 기본 클라이언트 사용.
    this._makeTestClient = typeof deps.makeTestClient === 'function' ? deps.makeTestClient : null;

    this._gen = 0;             // 세대 번호(취소된 이전 세대 무시용)
    this._coalesceTimer = null;
    this._controller = null;   // 현재 in-flight AbortController
    this._status = STATUS.IDLE;
    this._lastError = null;
    this._lastSnapshot = null; // 직전 생성 시점 스냅샷(필요성 판정 기준점)
    this._lastSignals = [];    // 직전 트리거의 신호(coalesce 동안 누적)
    this._lastUrgent = false;
  }

  /** push 콜백을 주입(메인이 webContents 바인딩 후 설정). */
  setPush(p) {
    p = p || {};
    if (typeof p.pushState === 'function') this._pushState = p.pushState;
    if (typeof p.pushDelta === 'function') this._pushDelta = p.pushDelta;
    if (typeof p.pushDone === 'function') this._pushDone = p.pushDone;
    if (typeof p.pushError === 'function') this._pushError = p.pushError;
    if (typeof p.isSuppressed === 'function') this._isSuppressed = p.isSuppressed;
    if (typeof p.snapshotProvider === 'function') this._snapshot = p.snapshotProvider;
  }

  /** enabled 여부(opt-in). */
  _enabled() {
    const cfg = this._getConfig() || {};
    return !!(cfg.briefing && cfg.briefing.enabled);
  }

  _advanced() {
    const cfg = this._getConfig() || {};
    const adv = (cfg.briefing && cfg.briefing.advanced) || {};
    return {
      coalesceMs: (typeof adv.coalesceMs === 'number') ? adv.coalesceMs : C.COALESCE_MS,
      deadlineH: (typeof adv.deadlineH === 'number') ? adv.deadlineH : C.DEADLINE_H,
    };
  }

  /** 현재 상태 스냅샷(getState IPC용). */
  getState() {
    const persisted = this._loadItems() || { items: [] };
    const openItems = items.normalizeItems(persisted.items).filter((i) => i.status === items.STATUS.OPEN);
    return {
      enabled: this._enabled(),
      status: this._enabled() ? this._status : STATUS.DISABLED,
      items: openItems,
      lastError: this._lastError,
    };
  }

  /**
   * 데이터 변경 통지(발신원 → 오케스트레이터). 필요성 판정 후 트리거.
   * @param {string} reason 발신원 식별(로그·디버그용)
   */
  notify(reason) {
    if (!this._enabled()) { this._setStatus(STATUS.DISABLED); return; }
    if (this._isSuppressed()) return; // 스캔 중·홈 이탈·비포커스 — 억제

    const persisted = this._loadItems() || { items: [], lastSnapshot: null };
    const cur = this._snapshot();
    const adv = this._advanced();
    const res = policy.evaluate(persisted.lastSnapshot || this._lastSnapshot, cur, {
      now: this._now(), deadlineH: adv.deadlineH,
    });
    if (!res.trigger) return; // 유의 변화 없음 — 호출 0(기존 유지)

    // 신호 누적(coalesce 동안 병합). 키로 중복 제거.
    this._mergeSignals(res.signals);
    this._lastUrgent = this._lastUrgent || res.urgent;

    // 인디케이터 즉시 노출(≤300ms·LLM 호출 전·D3).
    this._setStatus(STATUS.GENERATING);

    if (res.urgent) {
      // 급함 fast-path — 디바운스 우회(누적 신호로 즉시 생성).
      this._clearCoalesce();
      this._fire();
    } else {
      // 일반 — coalesce 2000ms 1회 병합.
      if (this._coalesceTimer) return; // 이미 대기 중 — 누적만(1회로 병합)
      this._coalesceTimer = this._setTimeout(() => {
        this._coalesceTimer = null;
        this._fire();
      }, adv.coalesceMs);
    }
  }

  /** 수동 재생성(R-36) — 즉시(현재 스냅샷의 모든 신호). */
  triggerManual() {
    if (!this._enabled()) { this._setStatus(STATUS.DISABLED); return { ok: true }; }
    const cur = this._snapshot();
    const adv = this._advanced();
    // 수동은 직전 스냅샷 없이 평가(현재 상태 전체를 신호로) — null prev.
    const res = policy.evaluate(null, cur, { now: this._now(), deadlineH: adv.deadlineH });
    this._mergeSignals(res.signals);
    this._setStatus(STATUS.GENERATING);
    this._clearCoalesce();
    this._fire();
    return { ok: true };
  }

  /**
   * 항목 done/dismiss 적용(R-38·R-41). 영속 반영 후 open 항목 반환.
   * @param {string} key 항목 키
   * @param {string} action 'done'|'dismiss'
   * @returns {Array} open 항목(표시용)
   */
  resolveItem(key, action) {
    const persisted = this._loadItems() || { items: [] };
    const res = items.applyResolution(persisted.items, key, action, this._now());
    if (res.changed) {
      // [code-review #2] done/dismiss 카운터 증가(N-10). lastSnapshot은 미변경(undefined로 기존 유지).
      const counterDelta = action === 'done' ? { done: 1 } : { dismiss: 1 };
      this._saveItems({ items: res.items, counterDelta });
    }
    return items.normalizeItems(res.items).filter((i) => i.status === items.STATUS.OPEN);
  }

  /**
   * 연결 테스트(R-39) — 임시 config로 llmClient 핑.
   * @param {object} tempBriefing 임시 briefing 설정(영속 안 함)
   */
  async testConnection(tempBriefing) {
    // 임시 설정 바인딩 일회성 클라이언트(makeTestClient 주입 시) — 영속 안 함. 없으면 기본 클라이언트.
    const client = this._makeTestClient ? this._makeTestClient(tempBriefing) : this._llm;
    return client.testConnection({});
  }

  /** 진행 중 호출 취소(R-35 중단 버튼). 부분 결과 유지. */
  abort() {
    this._abortInflight();
    if (this._status === STATUS.STREAMING || this._status === STATUS.GENERATING) {
      this._setStatus(STATUS.IDLE);
    }
    return { ok: true };
  }

  _mergeSignals(signals) {
    if (!Array.isArray(signals)) return;
    const seen = new Set(this._lastSignals.map((s) => s.type + ':' + s.targetId));
    for (const s of signals) {
      const k = s.type + ':' + s.targetId;
      if (seen.has(k)) continue;
      seen.add(k);
      this._lastSignals.push(s);
    }
  }

  _clearCoalesce() {
    if (this._coalesceTimer) { this._clearTimeout(this._coalesceTimer); this._coalesceTimer = null; }
  }

  _abortInflight() {
    if (this._controller) {
      try { this._controller.abort(); } catch (_) { /* noop */ }
      this._controller = null;
    }
    this._gen += 1; // 이전 세대 delta/done 무시
  }

  /** 실제 생성 — carry-over 병합 → 프롬프트 → 스트림 → done/error. 단일 in-flight. */
  async _fire() {
    // 신규 트리거: 이전 abort + 세대++ (단일 in-flight·N-09).
    this._abortInflight();
    const gen = this._gen;
    const controller = this._makeAbort();
    this._controller = controller;

    const now = this._now();
    const persisted = this._loadItems() || { items: [], lastSnapshot: null };
    const cur = this._snapshot();
    const signals = this._lastSignals.slice();
    this._lastSignals = [];
    const urgent = this._lastUrgent;
    this._lastUrgent = false;

    const adv = this._advanced();
    const newItems = items.itemsFromSignals(signals, now);
    const sel = items.selectCarryOver(persisted.items, newItems, policy.normalizeSnapshot(cur), {
      now, diskBytes: C.DISK_RECLAIM_BYTES,
    });

    // System 프롬프트 override(사용자 편집 — 빈 값이면 시드 사용). 신뢰 영역이나 buildPrompt가 정제.
    const cfg = this._getConfig() || {};
    const systemPrompt = (cfg.briefing && typeof cfg.briefing.systemPrompt === 'string') ? cfg.briefing.systemPrompt : '';
    const { system, user } = prompt.buildPrompt({ items: sel.items, carryOver: [] }, { systemPrompt });

    let r;
    try {
      r = await this._llm.streamBriefing({
        system, user, signal: controller.signal,
        onDelta: (token) => {
          if (gen !== this._gen) return; // 취소된 이전 세대 무시
          if (this._status !== STATUS.STREAMING) this._setStatus(STATUS.STREAMING);
          this._pushDelta({ gen, chunk: token });
        },
      });
    } catch (err) {
      r = { ok: false, text: '', code: 'INTERNAL' };
      if (this._logger) this._logger.warn('브리핑 생성 예외', { code: 'INTERNAL' });
    }

    if (gen !== this._gen) return; // 도중 새 트리거로 취소됨 — 결과 폐기
    this._controller = null;

    if (!r.ok) {
      if (r.code === 'ABORTED') { this._setStatus(STATUS.IDLE); return; }
      this._lastError = r.code;
      this._setStatus(STATUS.ERROR, r.code);
      this._pushError({ gen, code: r.code });
      return;
    }

    // 파싱(관대한 구조화·평문 폴백) → 표현 필드를 신호 항목에 매핑(분류·키는 정책 소유).
    const parsed = parse.parseOutput(r.text);
    const finalItems = this._mapViews(sel.items, parsed);

    // 영속 병합(carry-over 기준 갱신) — 상승 세션이면 saveItems가 메모리 폴백.
    //   [code-review #1] lastSnapshot 영속(재시작 과트리거 방지). [code-review #2] generated++(N-10).
    const persistItems = items.mergePersist(persisted.items, finalItems, sel.resolvedKeys, { now });
    const snap = policy.normalizeSnapshot(cur);
    // [항목3] LLM 토큰 사용량 누적(usage가 실린 경우만). 모델명은 표시용으로 함께 전달.
    const usageDelta = (r.usage && typeof r.usage === 'object')
      ? Object.assign({ model: (cfg.briefing && typeof cfg.briefing.model === 'string') ? cfg.briefing.model : '' }, r.usage)
      : undefined;
    this._saveItems({ items: persistItems, lastSnapshot: snap, counterDelta: { generated: 1 }, usageDelta });
    this._lastSnapshot = snap;
    this._lastError = null;

    this._setStatus(STATUS.DONE);
    this._pushDone({ gen, items: finalItems.map(toDonePayload) });
  }

  /** 파싱된 표현(view)을 신호 항목에 매핑. key 일치 우선, 없으면 순서대로. */
  _mapViews(signalItems, parsed) {
    const views = (parsed && Array.isArray(parsed.items)) ? parsed.items : [];
    const byKey = new Map();
    for (const v of views) if (v && v.key) byKey.set(v.key, v);
    const out = [];
    let i = 0;
    for (const it of signalItems) {
      const v = byKey.get(it.key) || views[i] || null;
      i += 1;
      out.push(Object.assign({}, it, {
        title: items.sanitizeText((v && v.title) || it.title || it.targetLabel || it.signalType, C.PARSE_TITLE_MAX),
        reason: items.sanitizeText((v && v.reason) || it.reason, C.PARSE_REASON_MAX),
        guide: items.sanitizeText((v && v.guide) || it.guide, C.PARSE_GUIDE_MAX),
      }));
    }
    return out;
  }

  _setStatus(status, code) {
    this._status = status;
    this._pushState({ status, code: code || undefined });
  }

  /** 타이머·in-flight 정리(dispose). */
  dispose() {
    this._clearCoalesce();
    this._abortInflight();
  }
}

/** done payload 항목 shape(설계 ③). 표시 전용 필드만. */
function toDonePayload(it) {
  return {
    key: it.key,
    category: it.category,
    title: it.title,
    reason: it.reason,
    guide: it.guide,
    ref: it.ref || '',
  };
}

module.exports = { BriefingOrchestrator, STATUS, toDonePayload };
