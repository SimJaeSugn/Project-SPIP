'use strict';
/**
 * electron/ipc/register.js — ipcMain 채널 등록 + 공통 게이트 (electron-migration §4.2 공통)
 *
 * 모든 채널을 ipcMain.handle로 등록하고, 공통 게이트를 한 곳에서 적용한다:
 *   ① 발신자 검증(EM-M-2): event.senderFrame이 신뢰 로컬 origin(app://) 인지 확인,
 *      불일치 시 무시(고정 {ok:false,code:'FORBIDDEN'} 반환).
 *   ② try/catch 래핑: 예외 시 고정 {ok:false,code:'INTERNAL'}(L-3, 절대경로·스택은 로그로만).
 *
 * preload는 ipcRenderer 원본·범용 invoke(channel,…)를 노출하지 않고 채널명을 하드코딩한다(MUST).
 *
 * 핸들러 비즈니스 로직은 data/actions/scan/folders.js의 순수 함수에 있고(헤드리스 테스트 가능),
 * 본 모듈은 Electron(ipcMain·dialog·webContents) wiring과 발신자 검증만 담당한다.
 *
 * isTrustedSender는 순수 함수로 분리해 단위테스트한다(Electron 미설치에서도 검증).
 */

const dataIpc = require('./data');
const actionsIpc = require('./actions');
const scanIpc = require('./scan');
const foldersIpc = require('./folders');
const clipboardIpc = require('./clipboard');
const toolsIpc = require('./tools');
const uiStateIpc = require('./uiState');
// [P3-4] 신뢰 origin 단일 원천(security.js). 리터럴 이중정의 제거.
const { TRUSTED_ORIGIN } = require('../security');

/**
 * 발신자(senderFrame)가 신뢰 로컬 origin인지 검증한다(EM-M-2).
 *
 * [EI-L-1] origin 검증을 접두 매칭(startsWith('app:'))이 아니라 **정확 일치**로 좁힌다.
 *   접두 매칭은 'app://../../etc'·'app:anything' 같은 비정상 origin도 신뢰로 오판하는
 *   심층방어 약화였다. URL을 파싱해 정규 origin('app://<host>')을 산출하고, 기대 origin과
 *   정확히 비교한다. 파싱 불가/스킴 불일치/host 불일치는 모두 거부.
 *
 * @param {object} event ipcMain 이벤트(또는 모킹). { senderFrame:{ url, origin } } 형태
 * @param {object} [opts] { trustedOrigin, allowFileUrl }
 * @returns {boolean}
 */
function isTrustedSender(event, opts) {
  opts = opts || {};
  const trusted = opts.trustedOrigin || TRUSTED_ORIGIN;
  const frame = event && event.senderFrame;
  if (!frame) return false;
  const url = typeof frame.url === 'string' ? frame.url : '';
  const origin = typeof frame.origin === 'string' ? frame.origin : '';

  // 기대 스킴('app') — trustedOrigin('app://')에서 스킴만 추출.
  const trustedScheme = String(trusted).replace(/:.*$/, ''); // 'app://' → 'app'

  // [EI-L-1] 신뢰 판정은 접두 매칭이 아니라 **정규 origin 정확 비교**로 한다.
  //   - URL을 파싱(실패=거부)하고 protocol이 정확히 신뢰 스킴(app:)인지 본다.
  //   - 계층형(authority 있는, 'app://…') origin만 허용하고 opaque('app:foo')는 거부한다.
  //   - host에 경로 이탈/제어 문자가 섞인 비정상 origin('app://../../etc' 등)은 거부한다.
  const isTrustedScheme = (str) => {
    if (!str) return false;
    let u;
    try { u = new URL(str); } catch (_) { return false; }
    if (u.protocol !== trustedScheme + ':') return false;
    // 계층형 URL은 origin이 '<scheme>://<host>'로 정규화된다. opaque(예: 'app:foo')는
    //   origin이 'null'이거나 href가 'app://'로 시작하지 않으므로 거부.
    if (!u.href.startsWith(trustedScheme + '://')) return false;
    // host에 '..'·역슬래시·인코딩 잔재 등 비정상 토큰이 있으면 거부(정상 자산 host는 단순 토큰).
    if (/[\\/]|\.\./.test(u.host)) return false;
    return true;
  };

  if (isTrustedScheme(url) || isTrustedScheme(origin)) return true;

  // 폴백: loadFile(file://) 전략을 쓰는 경우의 우리 index 허용(opt-in, 정확 스킴 일치).
  if (opts.allowFileUrl) {
    try { if (new URL(url).protocol === 'file:') return true; } catch (_) { /* 거부 */ }
  }
  return false;
}

/**
 * ipcMain에 모든 채널을 등록한다.
 * @param {object} deps { ipcMain, dialog, clipboard, getWebContents, getWin, ctx, logger, trustedOrigin?, allowFileUrl? }
 *   - ctx: { config, store, scanController, cachePath, logger }
 *   - getWebContents: () => webContents  (진행 푸시 대상, 지연 평가)
 *   - getWin: () => BrowserWindow  (dialog 부모)
 *   - clipboard: Electron clipboard(R-17 copyText 주입)
 */
function registerIpcHandlers(deps) {
  const { ipcMain, dialog, clipboard, getWebContents, getWin, ctx, logger } = deps;
  const senderOpts = { trustedOrigin: deps.trustedOrigin || TRUSTED_ORIGIN, allowFileUrl: !!deps.allowFileUrl };

  // 진행 푸시 콜백(F-1/§4.3) — rescan이 start로 전달.
  const sendProgress = scanIpc.makeProgressSender(getWebContents);

  // 공통 게이트로 핸들러를 감싼다.
  const guard = (channel, fn) => {
    ipcMain.handle(channel, async (event, ...args) => {
      if (!isTrustedSender(event, senderOpts)) {
        if (logger) logger.warn('IPC 발신자 검증 실패 — 무시', { channel });
        return { ok: false, code: 'FORBIDDEN' };
      }
      try {
        return await fn(...args);
      } catch (err) {
        if (logger) logger.error('IPC 핸들러 예외', { channel, err: err && err.message });
        return { ok: false, code: 'INTERNAL' };
      }
    });
  };

  // data — 인자 무시(읽기 채널).
  guard('spip:getProjects', () => dataIpc.getProjects(ctx));
  guard('spip:getStats', () => dataIpc.getStats(ctx));
  guard('spip:getHealth', () => dataIpc.getHealth(ctx));
  guard('spip:getConfig', () => dataIpc.getConfig(ctx));

  // scan
  guard('spip:getScanStatus', () => scanIpc.getScanStatus(ctx));

  // actions — rescan에 sendProgress 주입.
  guard('spip:openInVsCode', (args) => actionsIpc.openInVsCode(args, ctx));
  guard('spip:rescan', (args) => actionsIpc.rescan(args, Object.assign({}, ctx, { sendProgress })));

  // folders — dialog/win 주입.
  guard('spip:addRoots', (args) => foldersIpc.addRoots(args, ctx));
  guard('spip:removeRoot', (args) => foldersIpc.removeRoot(args, ctx));
  guard('spip:pickFolders', () => foldersIpc.pickFolders(Object.assign({}, ctx, {
    dialog,
    win: typeof getWin === 'function' ? getWin() : undefined,
  })));

  // [M6 R-17] 클립보드 — main clipboard 주입.
  guard('spip:copyText', (args) => clipboardIpc.copyText(args, { clipboard }));

  // [M6 R-18] 외부 툴 — tools.js. setToolPath/pick는 캐시 무효화·persist·force 재검증.
  guard('spip:getTools', () => toolsIpc.getTools(ctx));
  guard('spip:setToolPath', (args) => toolsIpc.setToolPath(args, ctx));
  guard('spip:pickToolExecutable', (args) => toolsIpc.pickToolExecutable(args, Object.assign({}, ctx, {
    dialog,
    win: typeof getWin === 'function' ? getWin() : undefined,
  })));

  // [M6 R-19/R-20] UI 상태 — uiState.js.
  guard('spip:getUiState', () => uiStateIpc.getUiState(ctx));
  guard('spip:setFavorite', (args) => uiStateIpc.setFavorite(args, ctx));
  guard('spip:setOrder', (args) => uiStateIpc.setOrder(args, ctx));
  guard('spip:setSortMode', (args) => uiStateIpc.setSortMode(args, ctx));
}

module.exports = { registerIpcHandlers, isTrustedSender, TRUSTED_ORIGIN };
