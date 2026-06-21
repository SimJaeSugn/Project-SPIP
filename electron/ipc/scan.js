'use strict';
/**
 * electron/ipc/scan.js — 스캔 진행 IPC (electron-migration §4.1/§4.3 scan 채널)
 *
 *   spip:getScanStatus (invoke) → ScanProgress — 초기 동기화·재구독용
 *   spip:scanProgress  (send)   → main→renderer 진행 푸시(폴링 폐기, R-15)
 *
 * 진행 푸시는 scanController.start(opts)에 추가된 공개 onProgress 콜백(F-1)을 통해
 * 발생한다 — actions.rescan이 ctx.sendProgress를 start로 전달하고, 그 콜백이 매 진행마다
 * status()(shortenPath 축약, M4-H-1)를 받아 webContents.send('spip:scanProgress', snap)한다.
 * 본 모듈은 그 콜백 팩토리와 getScanStatus 순수 함수만 제공한다(register.js가 wiring).
 *
 * [헤드리스 검증, F-3] Electron API 미import. getScanStatus는 ctx 주입으로 단위테스트 가능.
 *   makeProgressSender는 webContents-유사 객체를 주입받아 send 호출을 검증할 수 있다.
 */

/**
 * getScanStatus — 컨트롤러 진행 스냅샷. 미주입 시 idle로 안전 응답(L-3).
 * @param {object} ctx { scanController }
 * @returns {object} ScanProgress (currentPath는 shortenPath 축약)
 */
function getScanStatus(ctx) {
  const controller = ctx && ctx.scanController;
  if (!controller || typeof controller.status !== 'function') {
    return {
      phase: 'idle', scanId: null, dirs: 0, found: 0, currentPath: null,
      elapsedMs: 0, startedAt: null, counts: null, note: null,
    };
  }
  return controller.status();
}

/**
 * 진행 푸시 콜백 팩토리. start(opts).onProgress로 전달된다.
 * webContents가 파괴되었으면 조용히 무시한다(창 닫힘 레이스 방어).
 * @param {object} getWebContents () => webContents | null  (지연 평가 — 창 재생성 대비)
 * @returns {(snapshot:object) => void}
 */
function makeProgressSender(getWebContents) {
  return function sendProgress(snapshot) {
    try {
      const wc = typeof getWebContents === 'function' ? getWebContents() : getWebContents;
      if (!wc || (typeof wc.isDestroyed === 'function' && wc.isDestroyed())) return;
      wc.send('spip:scanProgress', snapshot);
    } catch (_) {
      /* 창 파괴/전송 실패 격리 — 스캔 진행에 영향 없음 */
    }
  };
}

module.exports = { getScanStatus, makeProgressSender };
