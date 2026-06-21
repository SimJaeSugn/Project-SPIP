'use strict';
/**
 * lib/common/logger.js — 콘솔 로깅 + warnings[] 수집 (N-05, L-3 토대)
 *
 * - info/warn/error를 콘솔에 출력한다.
 * - warn은 warnings[] 배열에도 누적해 스냅샷 warnings 필드(§8.1)와 콘솔 요약에
 *   재사용할 수 있게 한다.
 * - [L-3] 사용자/응답에 노출되는 메시지에는 내부 절대경로·원시 예외·스택을
 *   담지 않는다. sanitizeForUser()로 경로/스택 흔적을 제거하는 토대를 둔다.
 *   (실제 응답 메시지 고정문 매핑은 서버 단계 S5에서 확정)
 *
 * 외부 의존성 0.
 */

// C0 제어문자(0x00-0x1F)와 DEL(0x7F) 매칭. 선형시간(ReDoS-free).
// 소스에 리터럴 제어문자를 두지 않기 위해 RegExp 문자열로 생성.
const CONTROL_CHARS_RE = new RegExp('[\\u0000-\\u001F\\u007F]', 'g');

/** 제어문자 제거 + 길이 절단 (H-3/L-1 토대) */
function clampString(s, max) {
  if (typeof s !== 'string') return s;
  const cleaned = s.replace(CONTROL_CHARS_RE, ' ');
  const limit = typeof max === 'number' && max > 0 ? max : 500;
  return cleaned.length > limit ? cleaned.slice(0, limit) + '…' : cleaned;
}

/**
 * 사용자 노출용으로 메시지를 정제한다(L-3 토대).
 * 절대경로처럼 보이는 토큰을 제거하고 제어문자/길이를 정리한다.
 * TODO(L-3): 현재 서버 응답은 고정문 매핑이라 직접 호출처는 없다(단위 테스트로만 검증).
 *   향후 동적 메시지를 사용자에게 노출할 때 이 함수를 경유시킨다(경로/스택 누출 차단 토대).
 */
function sanitizeForUser(msg) {
  if (msg == null) return '';
  let s = String(msg);
  // Windows 드라이브 경로 / UNC / POSIX 절대경로 흔적 마스킹
  s = s.replace(/[A-Za-z]:\\[^\s"']*/g, '<path>');
  s = s.replace(/\\\\[^\s"']+/g, '<path>');
  s = s.replace(/(^|\s)\/[^\s"']*/g, '$1<path>');
  return clampString(s, 300);
}

class Logger {
  constructor(opts) {
    opts = opts || {};
    this.warnings = [];
    // quiet 모드면 info 억제(테스트 노이즈 감소). warn/error는 항상 출력.
    this.quiet = !!opts.quiet;
  }

  info(msg) {
    if (!this.quiet) console.log(msg);
  }

  /**
   * 경고를 콘솔에 출력하고 warnings[]에 누적한다.
   * @param {string} reason 사람이 읽는 사유(고정문 권장)
   * @param {object} [meta] { path, ... } — 콘솔 디버그용. 응답에는 그대로 싣지 않음.
   */
  warn(reason, meta) {
    const entry = { reason };
    if (meta && typeof meta === 'object') {
      Object.assign(entry, meta);
    }
    this.warnings.push(entry);
    console.warn('[warn] ' + reason + (meta && meta.path ? ' (' + meta.path + ')' : ''));
    return entry;
  }

  /** 에러를 콘솔에만 상세 출력(L-3: 스택은 콘솔 전용). */
  error(reason, err) {
    console.error('[error] ' + reason);
    if (err && err.stack && !this.quiet) console.error(err.stack);
  }

  /** 누적된 경고 배열을 반환(스냅샷 warnings 필드용). */
  getWarnings() {
    return this.warnings.slice();
  }
}

/** 기본 공용 로거 인스턴스. 필요 시 new Logger()로 분리 생성. */
const defaultLogger = new Logger();

module.exports = { Logger, defaultLogger, sanitizeForUser, clampString };
