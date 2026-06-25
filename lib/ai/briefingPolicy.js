'use strict';
/**
 * lib/ai/briefingPolicy.js — 브리핑 필요성 판정·분류·fast-path (L4 순수·외부 의존성 0)
 *
 * 설계 ④·⑥. 두 데이터 스냅샷(직전 생성 시점 vs 현재)을 비교해 "사용자에게 알릴 가치가 있는
 * 유의 변화"가 있는지 판정하고(R-36), 각 신호를 3분류(must/good/urgent)로 태깅한다.
 * **분류 소유권은 정책에 있다**(설계 ⑥ note·인젝션 ③ 방어) — 모델은 표현만 채운다.
 *
 * 순수 함수: DOM/타이머/IO/Electron 미접근. 스냅샷은 오케스트레이터가 주입한다(headless 테스트).
 *
 * ── 스냅샷 shape(오케스트레이터가 구성·정규화) ──
 *   {
 *     projects: [ { id, name:string, dirty:bool, ahead:int, behind:int, attention:bool } ],
 *     deadlines: [ { id, name:string, dueAt:number|null, done:bool } ],   // 할 일 마감
 *     mail: { unseen:int, latestUid?:string },               // 새 메일 신호
 *     disk: { reclaimBytes:int },                            // 회수 가능 용량
 *     scan: { generatedAt:string|null },                     // 재스캔 식별
 *   }
 * 모든 필드는 누락 graceful(없으면 빈/0). targetId는 항목 키 산출(briefingItems)이 사용,
 * targetLabel(name)은 사용자 호명·프롬프트 표시용(해시 노출 방지).
 */

const C = require('./briefingConst');

const CATEGORY = Object.freeze({ MUST: 'must', GOOD: 'good', URGENT: 'urgent' });

/** 스냅샷을 graceful 정규화(누락 필드 채움). 비교·테스트 결정성 보장. */
function normalizeSnapshot(s) {
  s = (s && typeof s === 'object') ? s : {};
  const projects = Array.isArray(s.projects) ? s.projects.map(normProject).filter(Boolean) : [];
  const deadlines = Array.isArray(s.deadlines) ? s.deadlines.map(normDeadline).filter(Boolean) : [];
  const mail = (s.mail && typeof s.mail === 'object') ? s.mail : {};
  const disk = (s.disk && typeof s.disk === 'object') ? s.disk : {};
  const scan = (s.scan && typeof s.scan === 'object') ? s.scan : {};
  return {
    projects,
    deadlines,
    mail: { unseen: numOr0(mail.unseen), latestUid: strOrNull(mail.latestUid) },
    disk: { reclaimBytes: numOr0(disk.reclaimBytes) },
    scan: { generatedAt: strOrNull(scan.generatedAt) },
  };
}

function normProject(p) {
  if (!p || typeof p !== 'object' || typeof p.id !== 'string') return null;
  return {
    id: p.id,
    // [briefing name] 사람이 읽는 프로젝트 이름(신뢰 불가·표시/프롬프트용). 없으면 빈 문자열 graceful.
    name: strOrEmpty(p.name),
    dirty: p.dirty === true,
    ahead: numOr0(p.ahead),
    behind: numOr0(p.behind),
    attention: p.attention === true,
  };
}

function normDeadline(d) {
  if (!d || typeof d !== 'object' || typeof d.id !== 'string') return null;
  return {
    id: d.id,
    // [briefing name] 마감 항목의 사람이 읽는 라벨(있으면 보존, 없으면 빈 문자열 graceful).
    name: strOrEmpty(d.name),
    dueAt: (typeof d.dueAt === 'number' && Number.isFinite(d.dueAt)) ? d.dueAt : null,
    done: d.done === true,
  };
}

function numOr0(v) { return (typeof v === 'number' && Number.isFinite(v)) ? v : 0; }
function strOrNull(v) { return (typeof v === 'string' && v) ? v : null; }
function strOrEmpty(v) { return (typeof v === 'string') ? v : ''; }

/** id→project 맵. */
function byId(arr) {
  const m = new Map();
  for (const p of arr) m.set(p.id, p);
  return m;
}

/**
 * 두 스냅샷을 비교해 유의 변화 신호를 산출한다(순수).
 * @param {object} prevSnap 직전 생성 시점 스냅샷(없으면 첫 생성 — null)
 * @param {object} curSnap 현재 스냅샷
 * @param {object} [opts] { now?:number, deadlineH?:number, massDirty?:number, diskBytes?:number }
 * @returns {{ trigger:boolean, urgent:boolean, signals:Array<{type,targetId,category,urgent,meta}> }}
 */
function evaluate(prevSnap, curSnap, opts) {
  opts = opts || {};
  const now = (typeof opts.now === 'number') ? opts.now : Date.now();
  const deadlineMs = (typeof opts.deadlineH === 'number' ? opts.deadlineH : C.DEADLINE_H) * 60 * 60 * 1000;
  const massDirty = (typeof opts.massDirty === 'number') ? opts.massDirty : C.MASS_DIRTY;
  const diskBytes = (typeof opts.diskBytes === 'number') ? opts.diskBytes : C.DISK_RECLAIM_BYTES;

  const cur = normalizeSnapshot(curSnap);
  const prev = prevSnap == null ? null : normalizeSnapshot(prevSnap);
  const prevById = prev ? byId(prev.projects) : new Map();
  const prevDeadlineById = new Map();
  if (prev) for (const d of prev.deadlines) prevDeadlineById.set(d.id, d);

  const signals = [];
  let newDirtyCount = 0;

  // ── 프로젝트 git 신호(상태형) ──
  for (const p of cur.projects) {
    const was = prevById.get(p.id);
    // 신규 dirty: 이전 clean(또는 미존재) → 현재 dirty
    if (p.dirty && (!was || !was.dirty)) {
      newDirtyCount += 1;
      signals.push(mk('dirty', p.id, CATEGORY.MUST, false, p.name));
    }
    // 미푸시(ahead): 0→양수 또는 증가
    if (p.ahead > 0 && (!was || p.ahead > was.ahead)) {
      signals.push(mk('ahead', p.id, CATEGORY.MUST, false, p.name));
    }
    // 받을 커밋(behind): 0→양수 (급함·fast-path)
    if (p.behind > 0 && (!was || was.behind === 0)) {
      signals.push(mk('behind', p.id, CATEGORY.URGENT, true, p.name));
    }
    // 주의 필요 집합 새 진입(상태형)
    if (p.attention && (!was || !was.attention)) {
      signals.push(mk('attention', p.id, CATEGORY.GOOD, false, p.name));
    }
  }

  // 대량 신규 dirty → fast-path 승격(개별 dirty 신호의 urgent 플래그를 올림)
  if (newDirtyCount >= massDirty) {
    for (const s of signals) if (s.type === 'dirty') { s.urgent = true; s.category = CATEGORY.URGENT; }
  }

  // ── 마감 임박 할 일(상태형·급함) ──
  for (const d of cur.deadlines) {
    if (d.done || d.dueAt == null) continue;
    const within = (d.dueAt - now) <= deadlineMs; // 이미 경과(<0)도 포함
    if (!within) continue;
    const was = prevDeadlineById.get(d.id);
    const wasWithin = was && was.dueAt != null && !was.done && (was.dueAt - now) <= deadlineMs;
    if (!wasWithin) {
      // 임박/경과 구분 + 대략 시간차를 context로 전달(AI가 '다가오는' vs '지난 미완료'를 구분해 안내).
      const overdue = d.dueAt < now;
      const hrs = Math.max(0, Math.round(Math.abs(d.dueAt - now) / 3600000));
      const when = hrs >= 48 ? (Math.round(hrs / 24) + '일') : (hrs + '시간');
      const ctx = overdue ? ('마감 지남(미완료) — 약 ' + when + ' 경과') : ('다가오는 마감 — 약 ' + when + ' 후');
      signals.push(mk('deadline', d.id, CATEGORY.URGENT, true, d.name, ctx));
    }
  }

  // ── 새 메일(이벤트형) ──
  if (cur.mail.unseen > 0) {
    const prevUnseen = prev ? prev.mail.unseen : 0;
    const prevUid = prev ? prev.mail.latestUid : null;
    const arrived = cur.mail.unseen > prevUnseen || (cur.mail.latestUid && cur.mail.latestUid !== prevUid);
    if (arrived) signals.push(mk('mail', cur.mail.latestUid || 'mail', CATEGORY.GOOD, false));
  }

  // ── 디스크 회수 후보(상태형) ──
  if (cur.disk.reclaimBytes >= diskBytes) {
    const prevReclaim = prev ? prev.disk.reclaimBytes : 0;
    if (prevReclaim < diskBytes) signals.push(mk('disk', 'disk', CATEGORY.GOOD, false));
  }

  // ── 스캔 구성 변동(이벤트형·1회성) ──
  if (cur.scan.generatedAt && (!prev || prev.scan.generatedAt !== cur.scan.generatedAt)) {
    // 첫 생성(prev 없음)은 스캔만으로 트리거하지 않는다(노이즈) — prev 존재 시에만.
    if (prev) signals.push(mk('scan', cur.scan.generatedAt, CATEGORY.GOOD, false));
  }

  return {
    trigger: signals.length > 0,
    urgent: signals.some((s) => s.urgent),
    signals,
  };
}

function mk(type, targetId, category, urgent, targetLabel, context) {
  // targetLabel: 사람이 읽는 라벨(프로젝트 name 등). 표시·프롬프트에 사용. 없으면 빈 문자열 graceful.
  //   targetId(해시·식별자)는 매칭·dedup·키 산출용으로 유지하되 사용자에겐 노출하지 않는다.
  //   context: 선택 부가정보(마감 시각 등 — 신뢰 영역, 정책이 산출). itemsFromSignals가 항목으로 전파.
  return {
    type,
    targetId: String(targetId),
    targetLabel: (typeof targetLabel === 'string') ? targetLabel : '',
    category,
    urgent: urgent === true,
    context: (typeof context === 'string') ? context : '',
    meta: {},
  };
}

module.exports = { evaluate, normalizeSnapshot, CATEGORY };
