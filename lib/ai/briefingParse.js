'use strict';
/**
 * lib/ai/briefingParse.js — 모델 출력 파서 (L4 순수·외부 의존성 0)
 *
 * 설계 ⑥·⑦(R-37·L-1·M-3). 모델의 자유 출력을 관대하게 구조화한다:
 *   ① JSON 배열/객체 추출 시도(코드펜스·잡음 허용) → 항목별 title/reason/guide 추출.
 *   ② 실패 시 전체 텍스트를 평문 1항목으로 폴백(크래시 0).
 * 출력은 **표시 전용** — HTML/마크다운으로 변환하지 않는다(M-3). 어떤 문자열도 제어문자
 * 제거·길이 상한만 적용하고 평문 그대로 보존(<script> 등도 평문). 렌더는 textContent only.
 *
 * 파서는 표현 필드(title/reason/guide)만 채운다 — key로 신호 항목에 매핑하고, 분류·키는
 * 정책이 소유(모델이 바꿔도 무시). 매핑은 오케스트레이터가 수행(여기선 키 힌트만 반환).
 *
 * 순수 함수: DOM/타이머/IO/Electron 미접근.
 */

const C = require('./briefingConst');

/** 제어문자 제거(C0·DEL) + 길이 상한. 평문 보존(HTML 미변환). */
// 주: 여기 clean은 개행(\n)을 보존한다(평문 다단 표시용). 영속 저장 시점의 briefingItems.sanitizeText는
//   개행을 제거한다(carry-over 항목은 한 줄 표시) — 의도된 비대칭(파싱=표시, 영속=정규화).
function clean(v, max) {
  if (typeof v !== 'string') return '';
  const limit = (typeof max === 'number' && max > 0) ? max : C.PARSE_TITLE_MAX;
  const out = Array.from(v)
    .filter((ch) => { const c = ch.charCodeAt(0); return c >= 32 && c !== 127 || ch === '\n'; })
    .join('').trim();
  return out.length > limit ? out.slice(0, limit) : out;
}

/** 코드펜스/잡음을 허용하고 첫 JSON 배열/객체를 추출 시도. 실패 시 null. */
function extractJson(text) {
  if (typeof text !== 'string' || !text) return null;
  // 코드펜스 제거.
  let s = text.replace(/```[a-zA-Z]*\n?/g, '').replace(/```/g, '');
  // 첫 '[' ~ 마지막 ']' 또는 첫 '{' ~ 마지막 '}' 구간 추출(관대).
  const tryParse = (open, close) => {
    const start = s.indexOf(open);
    const end = s.lastIndexOf(close);
    if (start === -1 || end === -1 || end <= start) return null;
    try { return JSON.parse(s.slice(start, end + 1)); } catch (_) { return null; }
  };
  return tryParse('[', ']') || tryParse('{', '}');
}

/** 단일 객체 → 표현 항목(표현 필드만). key는 매핑 힌트(검증은 오케스트레이터). */
function toView(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const title = clean(obj.title || obj.제목, C.PARSE_TITLE_MAX);
  const reason = clean(obj.reason || obj.근거 || obj.summary, C.PARSE_REASON_MAX);
  const guide = clean(obj.guide || obj.가이드 || obj.howto || obj.how_to, C.PARSE_GUIDE_MAX);
  if (!title && !reason && !guide) return null;
  const key = (typeof obj.key === 'string') ? obj.key : null;
  return { key, title, reason, guide };
}

/**
 * 모델 출력을 관대하게 파싱한다(순수).
 * @param {string} text 모델의 전체 출력
 * @returns {{ ok:boolean, structured:boolean, items:Array<{key,title,reason,guide}>, raw:string }}
 *   structured=true면 JSON 구조화 성공, false면 평문 폴백.
 */
function parseOutput(text) {
  const raw = clean(text, C.PARSE_REASON_MAX * C.PARSE_MAX_ITEMS);
  const parsed = extractJson(text);

  if (parsed) {
    const arr = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.items) ? parsed.items : [parsed]);
    const items = [];
    for (const o of arr.slice(0, C.PARSE_MAX_ITEMS)) {
      const v = toView(o);
      if (v) items.push(v);
    }
    if (items.length > 0) return { ok: true, structured: true, items, raw };
  }

  // 평문 폴백 — 전체를 1항목 reason으로(크래시 0). 표시 전용.
  const fallbackReason = clean(text, C.PARSE_REASON_MAX);
  return {
    ok: true,
    structured: false,
    items: fallbackReason ? [{ key: null, title: '', reason: fallbackReason, guide: '' }] : [],
    raw,
  };
}

/**
 * 문자열/이스케이프를 인지해 균형 잡힌 최상위 {...} 객체들을 순서대로 추출·파싱한다.
 *   미완성(닫히지 않은) 꼬리 객체는 버린다. 스트리밍 부분 파싱용.
 * @param {string} s 코드펜스가 제거된 부분 텍스트
 * @returns {object[]} 파싱 성공한 완성 객체들(순서 보존)
 */
function extractCompleteObjects(s) {
  const out = [];
  let depth = 0, start = -1, inStr = false, esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '{') { if (depth === 0) start = i; depth++; }
    else if (c === '}') {
      if (depth > 0) {
        depth--;
        if (depth === 0 && start >= 0) {
          try { out.push(JSON.parse(s.slice(start, i + 1))); } catch (_) { /* 손상 객체 건너뜀 */ }
          start = -1;
        }
      }
    }
  }
  return out;
}

/**
 * 스트리밍 중 부분 출력을 관대하게 파싱한다(미완성 JSON 허용) — 가독성 위해 날 JSON 대신 항목 점진 표시.
 *   JSON 모드(첫 비공백이 '[' 또는 '{')면 지금까지 **완성된 객체만** 표현 항목으로 반환하고 미완성 꼬리는
 *   버린다. JSON 모드가 아니면 평문으로 간주해 원문 표시를 호출부에 위임한다(mode='text').
 * @param {string} text 누적된 부분 출력
 * @returns {{ mode:('json'|'text'), items:Array<{key,title,reason,guide}> }}
 */
function parseStreaming(text) {
  if (typeof text !== 'string' || !text) return { mode: 'text', items: [] };
  const s = text.replace(/```[a-zA-Z]*\n?/g, '').replace(/```/g, '');
  const first = s.replace(/^\s+/, '')[0];
  if (first !== '[' && first !== '{') return { mode: 'text', items: [] }; // 평문 스트리밍 — 원문 그대로 읽힘
  const items = [];
  for (const o of extractCompleteObjects(s).slice(0, C.PARSE_MAX_ITEMS)) {
    const v = toView(o);
    if (v) items.push(v);
  }
  return { mode: 'json', items };
}

module.exports = { parseOutput, extractJson, clean, parseStreaming, extractCompleteObjects };
