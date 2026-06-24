'use strict';
/**
 * lib/common/elevationState.js — 중앙 elevated 플래그 (M12 B안 b3, 단일 출처)
 *
 * 설계 §B "가드 단일화": 시작 시 elevationGuard.detectElevation() 결과를 여기 1곳에 둔다.
 *   출처(set)는 electron/main.js onReady 1회. 참조(isElevated)는 영속 write 3경로
 *   (serializer.writeSnapshot · uiStateStore.write · config.persistConfigKeys)와
 *   rescan 가드(electron/ipc/actions.js)가 공유한다.
 *
 * 프로세스 전역 모듈 싱글턴 — require 캐시로 단일 인스턴스 보장. 기본값 false(비상승)이며,
 *   set 이 호출되지 않은 환경(CLI·dev·테스트·portable)에서는 항상 false 라 동작 불변(회귀 0).
 *
 * 부작용·외부 의존성 0(순수 상태 보관). 테스트는 set/reset 으로 격리한다.
 */

let _elevated = false;

/**
 * 중앙 elevated 플래그를 설정한다(출처 1곳 — main.js onReady). Boolean 강제.
 * @param {boolean} v
 */
function setElevated(v) {
  _elevated = v === true;
}

/** 현재 elevated 여부. set 미호출 시 false(비상승 — 동작 불변). @returns {boolean} */
function isElevated() {
  return _elevated === true;
}

/** 테스트/재기동용 초기화(false 로 복귀). */
function reset() {
  _elevated = false;
}

module.exports = { setElevated, isElevated, reset };
