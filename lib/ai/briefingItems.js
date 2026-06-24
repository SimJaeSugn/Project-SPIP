'use strict';
/**
 * lib/ai/briefingItems.js — 항목 키·상태전이·carry-over·auto-resolve (L4 순수·외부 의존성 0)
 *
 * 설계 ⑤. BriefingItem 스키마:
 *   { key, signalType, targetId, targetLabel, category, title, reason, guide, ref,
 *     status:'open'|'done'|'dismissed', createdAt, resolvedAt }
 *   targetLabel: 사람이 읽는 라벨(프로젝트 name 등 — 신뢰 불가). 표시·프롬프트 호명용(해시 노출 방지).
 *
 * 책임:
 *   · 안정 키 산출(signalType + ':' + targetId 해시) — 같은 사안=같은 키로 carry-over.
 *   · open → done/dismissed 전이(사용자 R-41 액션이 "처리됨" 정의).
 *   · carry-over 선별: 신규 신호 항목 + status==='open' 이전 항목(done/dismissed 제외).
 *   · auto-resolve: 상태형 신호의 근본 조건 해소 시 open→resolved(carry-over에서 제외).
 *   · 만료·상한: items 개수 상한·dismissed N일 후 정리.
 *
 * 순수 함수: 외부 의존성 0. crypto는 Node 내장(해시는 안정 키 산출에만, IO 아님).
 * 텍스트는 sanitizeText로 제어문자 제거·길이 상한(L-1 표시 안전).
 */

const crypto = require('crypto');
const C = require('./briefingConst');

const STATUS = Object.freeze({ OPEN: 'open', DONE: 'done', DISMISSED: 'dismissed' });
const ACTIONS = new Set(['done', 'dismiss']);
const KEY_RE = /^[0-9a-f]{1,64}$/;

/** 상태형 신호유형(현재 스냅샷의 근본 조건 해소로 auto-resolve 가능). */
const STATE_SIGNALS = new Set(['dirty', 'ahead', 'behind', 'attention', 'disk', 'deadline']);
/** 이벤트형 신호유형(지속 조건 없음 — done/dismiss 또는 다음 재생성에서 자연 소멸). */
const EVENT_SIGNALS = new Set(['mail', 'scan']);

/** 안정 키 산출(순수) — signalType + ':' + targetId 의 sha256 16바이트(32 hex). */
function itemKey(signalType, targetId) {
  const h = crypto.createHash('sha256');
  h.update(String(signalType) + ':' + String(targetId));
  return h.digest('hex').slice(0, 32);
}

/** 제어문자 제거 + trim + 길이 상한(L-1 표시 안전). */
function sanitizeText(v, max) {
  if (typeof v !== 'string') return '';
  const limit = (typeof max === 'number' && max > 0) ? max : C.PARSE_TITLE_MAX;
  return Array.from(v)
    .filter((ch) => { const c = ch.charCodeAt(0); return c >= 32 && c !== 127; })
    .join('').trim().slice(0, limit);
}

/** 임의 입력을 BriefingItem으로 정규화(graceful). 키 형식 불량/누락은 signalType·targetId로 재산출. */
function normalizeItem(input) {
  if (!input || typeof input !== 'object') return null;
  const signalType = (typeof input.signalType === 'string' && input.signalType) ? input.signalType : null;
  const targetId = (typeof input.targetId === 'string') ? input.targetId : '';
  if (!signalType) return null;
  let key = (typeof input.key === 'string' && KEY_RE.test(input.key)) ? input.key : itemKey(signalType, targetId);
  const status = (input.status === STATUS.DONE || input.status === STATUS.DISMISSED) ? input.status : STATUS.OPEN;
  return {
    key,
    signalType,
    targetId,
    // [briefing name] 표시·프롬프트 호명용 라벨(신뢰 불가). sanitize+상한으로 라운드트립 보존.
    targetLabel: sanitizeText(input.targetLabel, C.PARSE_TITLE_MAX),
    category: (input.category === 'must' || input.category === 'good' || input.category === 'urgent') ? input.category : 'good',
    title: sanitizeText(input.title, C.PARSE_TITLE_MAX),
    reason: sanitizeText(input.reason, C.PARSE_REASON_MAX),
    guide: sanitizeText(input.guide, C.PARSE_GUIDE_MAX),
    ref: sanitizeText(input.ref, C.PARSE_TITLE_MAX),
    status,
    createdAt: numOrNull(input.createdAt),
    resolvedAt: numOrNull(input.resolvedAt),
  };
}

function numOrNull(v) { return (typeof v === 'number' && Number.isFinite(v)) ? v : null; }

/** items 배열 정규화 — 키 중복 제거·개수 상한. */
function normalizeItems(input) {
  if (!Array.isArray(input)) return [];
  const out = [];
  const seen = new Set();
  for (const it of input) {
    if (out.length >= C.MAX_ITEMS) break;
    const n = normalizeItem(it);
    if (!n || seen.has(n.key)) continue;
    seen.add(n.key);
    out.push(n);
  }
  return out;
}

/**
 * 신호 배열(briefingPolicy.evaluate().signals)을 신규 open 항목으로 변환(표현 필드는 비어 있음 — 모델이 채움).
 * @param {Array} signals
 * @param {number} now
 * @returns {Array<BriefingItem>}
 */
function itemsFromSignals(signals, now) {
  const ts = (typeof now === 'number') ? now : Date.now();
  if (!Array.isArray(signals)) return [];
  const out = [];
  const seen = new Set();
  for (const s of signals) {
    if (!s || typeof s.type !== 'string') continue;
    const targetId = (typeof s.targetId === 'string') ? s.targetId : '';
    const key = itemKey(s.type, targetId);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      key,
      signalType: s.type,
      targetId,
      // [briefing name] 신호의 라벨(name) 전파 — 표시·프롬프트 호명용(해시 미노출).
      targetLabel: sanitizeText(s.targetLabel, C.PARSE_TITLE_MAX),
      category: (s.category === 'must' || s.category === 'good' || s.category === 'urgent') ? s.category : 'good',
      title: '', reason: '', guide: '', ref: '',
      status: STATUS.OPEN,
      createdAt: ts,
      resolvedAt: null,
    });
  }
  return out;
}

/**
 * 현재 스냅샷 기준 open 항목의 근본 조건 해소 판정(auto-resolve, 순수).
 * 상태형만 결정적으로 해소 판정. 이벤트형은 해소하지 않는다(done/dismiss로 종결).
 * @param {BriefingItem} item open 항목
 * @param {object} snap normalizeSnapshot 형태 현재 스냅샷
 * @param {object} [opts] { now, deadlineH, diskBytes }
 * @returns {boolean} true=조건 해소(carry-over에서 제외)
 */
function isResolved(item, snap, opts) {
  opts = opts || {};
  if (!item || item.status !== STATUS.OPEN) return false;
  if (!STATE_SIGNALS.has(item.signalType)) return false; // 이벤트형은 auto-resolve 안 함
  const s = snap || {};
  const projects = Array.isArray(s.projects) ? s.projects : [];
  const find = (id) => projects.find((p) => p && p.id === id) || null;

  switch (item.signalType) {
    case 'dirty': {
      const p = find(item.targetId);
      return !p || p.dirty !== true; // clean 전환 또는 소멸
    }
    case 'ahead': {
      const p = find(item.targetId);
      return !p || !(p.ahead > 0); // push 완료
    }
    case 'behind': {
      const p = find(item.targetId);
      return !p || !(p.behind > 0); // pull 완료
    }
    case 'attention': {
      const p = find(item.targetId);
      return !p || p.attention !== true; // 주의 집합 이탈
    }
    case 'disk': {
      const diskBytes = (typeof opts.diskBytes === 'number') ? opts.diskBytes : C.DISK_RECLAIM_BYTES;
      const reclaim = (s.disk && typeof s.disk.reclaimBytes === 'number') ? s.disk.reclaimBytes : 0;
      return reclaim < diskBytes; // 임계 미만 복귀
    }
    case 'deadline': {
      const deadlines = Array.isArray(s.deadlines) ? s.deadlines : [];
      const d = deadlines.find((x) => x && x.id === item.targetId) || null;
      return !d || d.done === true || d.dueAt == null; // done/삭제/마감 소멸
    }
    default:
      return false;
  }
}

/**
 * carry-over 병합(순수) — 신규 신호 항목 + 아직 open인 이전 항목(auto-resolve 통과분).
 *   done/dismissed 제외. auto-resolve된 상태형 항목 제외. 같은 키는 신규가 우선(표현 갱신).
 * @param {Array} prevItems 이전 영속 items
 * @param {Array} newItems itemsFromSignals 산출
 * @param {object} curSnap 현재 스냅샷(normalizeSnapshot)
 * @param {object} [opts] { now, diskBytes }
 * @returns {{ items:Array<BriefingItem>, carriedKeys:string[], resolvedKeys:string[] }}
 *   items = 이번 프롬프트·표시 대상(open만). prevItems의 done/dismissed는 영속용으로 별도 보존(applyResolution에서).
 */
function selectCarryOver(prevItems, newItems, curSnap, opts) {
  opts = opts || {};
  const prev = normalizeItems(prevItems);
  const fresh = Array.isArray(newItems) ? newItems : [];
  const freshKeys = new Set(fresh.map((i) => i.key));

  const carried = [];
  const carriedKeys = [];
  const resolvedKeys = [];
  for (const it of prev) {
    if (it.status !== STATUS.OPEN) continue;       // done/dismissed 제외
    if (freshKeys.has(it.key)) continue;            // 신규가 대체(중복 방지)
    if (isResolved(it, curSnap, opts)) { resolvedKeys.push(it.key); continue; } // auto-resolve
    carried.push(it);
    carriedKeys.push(it.key);
  }
  // 신규 + carry-over(open). 상한 적용.
  const merged = fresh.concat(carried).slice(0, C.MAX_ITEMS);
  return { items: merged, carriedKeys, resolvedKeys };
}

/**
 * 사용자 액션(done/dismiss)을 영속 items에 적용(순수).
 * @param {Array} items 현재 영속 items
 * @param {string} key 대상 키
 * @param {string} action 'done'|'dismiss'
 * @param {number} now
 * @returns {{ items:Array, changed:boolean }}
 */
function applyResolution(items, key, action, now) {
  const ts = (typeof now === 'number') ? now : Date.now();
  const list = normalizeItems(items);
  if (typeof key !== 'string' || !KEY_RE.test(key) || !ACTIONS.has(action)) {
    return { items: list, changed: false };
  }
  const status = action === 'done' ? STATUS.DONE : STATUS.DISMISSED;
  let changed = false;
  const next = list.map((it) => {
    if (it.key === key && it.status !== status) {
      changed = true;
      return Object.assign({}, it, { status, resolvedAt: ts });
    }
    return it;
  });
  return { items: next, changed };
}

/**
 * 영속용 항목 병합(순수) — 표시 대상(open 신규+carry-over) + 이전 done/dismissed 보존 + 만료 정리.
 *   다음 재생성의 carry-over 기준이 되는 "전체 영속 상태"를 산출한다.
 * @param {Array} prevItems 이전 영속 items
 * @param {Array} displayItems selectCarryOver().items (open)
 * @param {string[]} resolvedKeys auto-resolve된 키(영속에서 제거)
 * @param {object} [opts] { now, dismissTtlMs }
 * @returns {Array<BriefingItem>} 영속 items
 */
function mergePersist(prevItems, displayItems, resolvedKeys, opts) {
  opts = opts || {};
  const now = (typeof opts.now === 'number') ? opts.now : Date.now();
  const ttl = (typeof opts.dismissTtlMs === 'number') ? opts.dismissTtlMs : C.DISMISS_TTL_MS;
  const prev = normalizeItems(prevItems);
  const display = normalizeItems(displayItems);
  const resolved = new Set(Array.isArray(resolvedKeys) ? resolvedKeys : []);
  const displayKeys = new Set(display.map((i) => i.key));

  const out = display.slice();
  for (const it of prev) {
    if (displayKeys.has(it.key)) continue;          // 이미 표시 목록에 반영됨
    if (resolved.has(it.key)) continue;             // auto-resolve — 영속에서 제거
    if (it.status === STATUS.OPEN) continue;        // open인데 표시에 없으면 resolve된 것 — 제거
    if (it.status === STATUS.DISMISSED) {
      // dismissed는 TTL 만료 시 정리.
      if (it.resolvedAt != null && (now - it.resolvedAt) > ttl) continue;
    }
    out.push(it); // done/유효 dismissed 보존
  }
  return out.slice(0, C.MAX_ITEMS);
}

module.exports = {
  itemKey,
  sanitizeText,
  normalizeItem,
  normalizeItems,
  itemsFromSignals,
  isResolved,
  selectCarryOver,
  applyResolution,
  mergePersist,
  STATUS,
  ACTIONS,
  KEY_RE,
  STATE_SIGNALS,
  EVENT_SIGNALS,
};
