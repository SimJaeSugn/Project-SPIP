'use strict';
/**
 * electron/ipc/notify.js — OS 토스트 알림 IPC (백로그2-4)
 *
 *   spip:notify { title, body } → 윈도우 우측 하단 토스트(Electron Notification).
 *
 * 보안/안전:
 *   · Electron API 미import — 실제 표시는 main이 주입한 ctx.showNotification 위임(헤드리스 테스트 가능).
 *   · title/body는 문자열 강제 + 길이 상한 + 제어문자 제거(L-1 표시 안전). 본문은 사용자 소유 할 일 텍스트뿐.
 *   · 알림 비가용/실패는 graceful({ok:false,code}) — 호출처는 무시 가능.
 */

const MAX_TITLE = 120;
const MAX_BODY = 300;

/** 제어문자 제거 + 길이 상한(표시 안전). */
function clean(v, max) {
  if (typeof v !== 'string') return '';
  return Array.from(v)
    .filter((ch) => { const c = ch.charCodeAt(0); return c >= 32 && c !== 127; })
    .join('').trim().slice(0, max);
}

/**
 * spip:notify — 토스트 표시. 실제 표시는 ctx.showNotification({title,body})에 위임.
 * @param {object} args { title, body }
 * @param {object} ctx { showNotification?, logger? }
 * @returns {{ok:boolean, code?:string}}
 */
function notify(args, ctx) {
  args = (args && typeof args === 'object') ? args : {};
  const title = clean(args.title, MAX_TITLE);
  const body = clean(args.body, MAX_BODY);
  if (!title && !body) return { ok: false, code: 'EMPTY' };
  const show = ctx && typeof ctx.showNotification === 'function' ? ctx.showNotification : null;
  if (!show) return { ok: false, code: 'UNAVAILABLE' };
  try {
    show({ title: title || '알림', body });
    return { ok: true };
  } catch (_) {
    return { ok: false, code: 'INTERNAL' };
  }
}

module.exports = { notify, clean, MAX_TITLE, MAX_BODY };
