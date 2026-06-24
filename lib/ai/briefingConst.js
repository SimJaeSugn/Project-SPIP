'use strict';
/**
 * lib/ai/briefingConst.js — 브리핑 AI 임계값 단일 출처(L4 순수·외부 의존성 0)
 *
 * FeatureSpec R-36 "기본 임계값(명세 수준 고정)"을 단일 상수 모듈로 둔다. 설계 ⑧대로
 * 일부는 설정 가변(coalesceMs·deadlineH)이되 기본값은 확정이며, 나머지(인디케이터·디스크·
 * 대량 dirty·truncate 상한 등)는 고정(비노출)이다.
 *
 * 이 파일은 DOM/타이머/IO/Electron을 절대 import하지 않는다(헤드리스 단위테스트 보장, F-3).
 */

const BRIEFING_CONST = Object.freeze({
  // ── 트리거·반응성(R-36 / N-09) ──
  COALESCE_MS: 2000,        // 일반 변경 디바운스 창(설정 가변·기본 확정)
  DEADLINE_H: 24,           // 마감 임박 "급함" 임계(시간, 설정 가변·기본 확정)
  INDICATOR_MS: 300,        // 인디케이터 노출 상한(고정·비노출). LLM 호출 전 push.
  MASS_DIRTY: 3,            // 한 tick 신규 dirty repo ≥ 이 값이면 fast-path(고정·비노출)
  DISK_RECLAIM_BYTES: 1 * 1024 * 1024 * 1024, // 디스크 회수 신규 임계 1GB(고정·비노출)
  DELTA_FLUSH_MS: 80,       // delta 약한 배치 flush 주기(RK3 — IPC 폭주 완화)

  // ── 프롬프트 길이 상한(N-08 / M-3) ──
  MAIL_BODY_MAX: 2000,      // 메일 본문 항목당 상한(자)
  COMMIT_MSG_MAX: 500,      // 커밋 메시지 상한(자)
  TITLE_MAX: 200,           // 신호/항목 제목 등 일반 텍스트 상한(자)
  MAX_SIGNALS: 40,          // 프롬프트에 싣는 신호 항목 총개수 상한
  MAX_CARRYOVER: 40,        // 프롬프트에 싣는 carry-over 항목 총개수 상한
  SYSTEM_PROMPT_MAX: 8000,  // 사용자 편집 System(지시) 텍스트 상한(자) — 신뢰 영역이나 길이/제어문자 정제

  // ── carry-over 상태(R-38) ──
  MAX_ITEMS: 200,           // 영속 items 개수 상한(MAX_TODOS 동급)
  DISMISS_TTL_MS: 14 * 24 * 60 * 60 * 1000, // dismissed 만료 14일

  // ── 출력 파서(R-37 / L-1) ──
  PARSE_TITLE_MAX: 200,
  PARSE_REASON_MAX: 500,
  PARSE_GUIDE_MAX: 800,
  PARSE_MAX_ITEMS: 40,

  // ── LLM 클라이언트 기본(R-34) ──
  DEFAULT_TEMPERATURE: 0.3,
  DEFAULT_MAX_TOKENS: 1024,
  DEFAULT_TIMEOUT_MS: 30000,
  // [security L-1] 누적 스트림 절대 상한(자) — 오작동/악성 서버 무한 스트림 방어. 초과 시 abort+안전종료.
  MAX_STREAM_CHARS: 64 * 1024,
});

module.exports = BRIEFING_CONST;
