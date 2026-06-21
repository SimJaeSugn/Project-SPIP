'use strict';
/**
 * electron/ipc/clipboard.js — 클립보드 IPC (R-17, ADR-M6-1)
 *
 *   spip:copyText { text } → main clipboard.writeText(text)
 *
 * [보안] 입력 text는 string·길이 검증 후 "그대로 클립보드에만" 기록(실행·경로 해석 없음).
 *   길이 초과 시 명시 거부(절단 안 함, L-1 단일화). clipboard는 main에서 주입(헤드리스 테스트).
 *
 * 외부 의존성 0 — Electron API 미import(clipboard는 register.js에서 주입).
 */

// 클립보드 텍스트 길이 상한(§4.1). 초과 시 INVALID_TEXT 거부.
const MAX_TEXT_LEN = 8192;

/**
 * spip:copyText — 텍스트를 클립보드에 기록.
 * @param {object} args { text }
 * @param {object} deps { clipboard } main의 Electron clipboard 주입
 * @returns {{ok:true} | {ok:false, code:'INVALID_TEXT'|'INTERNAL'}}
 */
function copyText(args, deps) {
  const text = args && typeof args === 'object' ? args.text : undefined;
  if (typeof text !== 'string' || text.length > MAX_TEXT_LEN) {
    return { ok: false, code: 'INVALID_TEXT' }; // 절단 안 함(L-1)
  }
  const clipboard = deps && deps.clipboard;
  if (!clipboard || typeof clipboard.writeText !== 'function') {
    return { ok: false, code: 'INTERNAL' };
  }
  clipboard.writeText(text); // 텍스트만(읽기·이미지·기타 포맷 미사용)
  return { ok: true };
}

module.exports = { copyText, MAX_TEXT_LEN };
