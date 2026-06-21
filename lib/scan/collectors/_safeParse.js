'use strict';
/**
 * lib/scan/collectors/_safeParse.js — 부분신뢰 입력 파싱 가드 (보안 H-3·L-1)
 *
 * 수집기들이 공유하는 적대적 입력 방어 헬퍼. 가드는 모두 파싱/격리보다 "앞단"에 둔다.
 *   ① 파일 크기 상한(fs.stat) → 초과 시 읽지 않음(거대 package.json 메모리 고갈 차단)
 *   ② 읽기 바이트 상한(부분 읽기) → 파일 핸들 가드
 *   ③ JSON.parse 후 깊이 가드(JSON 폭탄·과중첩 거부)
 *   ④ 문자열 필드 길이 절단 + 제어문자 제거(L-1 저장형 XSS 1차 축소)
 *
 * 외부 의존성 0 — fs만 + logger(제어문자 제거 재사용).
 */

const fs = require('fs');
const { clampString } = require('../../common/logger');

/**
 * 파일 크기를 검사하고 상한 내면 바이트 한도까지 읽어 UTF-8 문자열로 반환한다(H-3 ①②).
 * @param {string} filePath
 * @param {object} limits { maxFileBytes, maxReadBytes }
 * @returns {{ ok:boolean, text:string|null, reason:string|null }}
 */
function readTextGuarded(filePath, limits) {
  let st;
  try {
    st = fs.statSync(filePath);
  } catch (_) {
    return { ok: false, text: null, reason: 'NOT_FOUND' };
  }
  if (!st.isFile()) return { ok: false, text: null, reason: 'NOT_FILE' };

  const maxFileBytes = (limits && limits.maxFileBytes) || 1024 * 1024;
  const maxReadBytes = (limits && limits.maxReadBytes) || maxFileBytes;

  // ① 크기 상한: 초과 시 아예 읽지 않음(메모리 고갈 차단).
  if (st.size > maxFileBytes) {
    return { ok: false, text: null, reason: 'TOO_LARGE' };
  }

  // ② 바이트 한도까지만 부분 읽기(파일 핸들 가드).
  const cap = Math.min(st.size, maxReadBytes);
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.allocUnsafe(cap);
    const bytes = fs.readSync(fd, buf, 0, cap, 0);
    return { ok: true, text: buf.slice(0, bytes).toString('utf8'), reason: null };
  } catch (_) {
    return { ok: false, text: null, reason: 'READ_FAIL' };
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch (_) { /* noop */ }
    }
  }
}

/**
 * 객체/배열의 중첩 깊이가 한도 이내인지 검사한다(H-3 ③, JSON 폭탄·과중첩 차단).
 * 재귀 대신 명시 스택으로 스택오버플로 자체를 회피한다.
 * @returns {boolean} 깊이가 maxDepth 이하면 true
 */
function depthWithinLimit(value, maxDepth) {
  const stack = [{ v: value, d: 1 }];
  while (stack.length > 0) {
    const { v, d } = stack.pop();
    if (d > maxDepth) return false;
    if (v && typeof v === 'object') {
      if (Array.isArray(v)) {
        for (let i = 0; i < v.length; i++) stack.push({ v: v[i], d: d + 1 });
      } else {
        for (const k in v) {
          if (Object.prototype.hasOwnProperty.call(v, k)) stack.push({ v: v[k], d: d + 1 });
        }
      }
    }
  }
  return true;
}

/**
 * 가드를 거친 JSON 파싱(H-3 ①②③).
 * @param {string} filePath
 * @param {object} limits { maxFileBytes, maxReadBytes, maxJsonDepth }
 * @returns {{ ok:boolean, value:any|null, reason:string|null }}
 */
function parseJsonGuarded(filePath, limits) {
  const read = readTextGuarded(filePath, limits);
  if (!read.ok) return { ok: false, value: null, reason: read.reason };

  let parsed;
  try {
    parsed = JSON.parse(read.text);
  } catch (_) {
    return { ok: false, value: null, reason: 'PARSE_FAIL' };
  }

  const maxDepth = (limits && limits.maxJsonDepth) || 64;
  if (!depthWithinLimit(parsed, maxDepth)) {
    return { ok: false, value: null, reason: 'TOO_DEEP' };
  }
  return { ok: true, value: parsed, reason: null };
}

/**
 * 문자열 필드 정제: 제어문자 제거 + 길이 절단(H-3 ④ / L-1).
 * @param {*} s
 * @param {number} maxLen
 * @returns {string|null} 문자열 아니면 null
 */
function sanitizeField(s, maxLen) {
  if (typeof s !== 'string') return null;
  const cleaned = clampString(s, maxLen || 1000);
  return cleaned;
}

module.exports = {
  readTextGuarded,
  parseJsonGuarded,
  depthWithinLimit,
  sanitizeField,
};
