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
const mailAccountsIpc = require('./mailAccounts');
const insightsIpc = require('./insights');
const uiStateIpc = require('./uiState');
const briefingIpc = require('./briefing');
const shelfIpc = require('./shelf');
const notifyIpc = require('./notify');
const autoUpdate = require('../autoUpdate');
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
 * @param {object} deps { ipcMain, dialog, clipboard, getWebContents, getFavoritesWidgetWc, getWin, ctx, logger, trustedOrigin?, allowFileUrl? }
 *   - ctx: { config, store, scanController, cachePath, logger }
 *   - getWebContents: () => webContents  (진행 푸시 대상·메인창, 지연 평가)
 *   - getFavoritesWidgetWc: () => webContents  (위젯 창, 지연 평가·파괴 시 null) — favorites-changed broadcast 대상(SEC-M2)
 *   - getWin: () => BrowserWindow  (dialog 부모)
 *   - clipboard: Electron clipboard(R-17 copyText 주입)
 */
function registerIpcHandlers(deps) {
  const { ipcMain, dialog, clipboard, shell, getWebContents, getFavoritesWidgetWc, getWin, ctx, logger } = deps;
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
  guard('spip:openPath', (args) => actionsIpc.openPath(args, Object.assign({}, ctx, { shell })));
  guard('spip:rescan', (args) => actionsIpc.rescan(args, Object.assign({}, ctx, { sendProgress })));

  // folders — dialog/win 주입.
  guard('spip:addRoots', (args) => foldersIpc.addRoots(args, ctx));
  guard('spip:removeRoot', (args) => foldersIpc.removeRoot(args, ctx));
  guard('spip:pickFolders', () => foldersIpc.pickFolders(Object.assign({}, ctx, {
    dialog,
    win: typeof getWin === 'function' ? getWin() : undefined,
  })));

  // 제외 항목(#4) — 폴더명/절대경로 추가·제거(config.excludes 영속). 스캔 시 excludeRules가 적용.
  guard('spip:getExcludes', () => foldersIpc.getExcludes(ctx));
  guard('spip:addExcludes', (args) => foldersIpc.addExcludes(args, ctx));
  guard('spip:removeExclude', (args) => foldersIpc.removeExclude(args, ctx));

  // 프로젝트 인식 기준(detectSignals) — 이름/글로브/정규식. 조회·추가·삭제·기본값 복원.
  guard('spip:getDetectSignals', () => foldersIpc.getDetectSignals(ctx));
  guard('spip:addDetectSignals', (args) => foldersIpc.addDetectSignals(args, ctx));
  guard('spip:removeDetectSignal', (args) => foldersIpc.removeDetectSignal(args, ctx));
  guard('spip:restoreDetectSignals', (args) => foldersIpc.restoreDetectSignals(args, ctx));
  // 드라이브(#5)는 별도 채널 없이 폴더 선택(addRoots/pickFolders)에서 드라이브 루트를 그대로 허용한다.

  // [M6 R-17] 클립보드 — main clipboard 주입.
  guard('spip:copyText', (args) => clipboardIpc.copyText(args, { clipboard }));

  // [M8-DESIGN] 위젯 헤더 '대시보드 열기' — 메인 대시보드 창 show/focus(약한 네비게이션, 인자 없음).
  //   tray onShowDashboard와 동일 동작. 창 부재/파괴 시 graceful({ok:false}).
  guard('spip:openDashboard', () => {
    const win = (typeof getWin === 'function') ? getWin() : null;
    if (win && (typeof win.isDestroyed !== 'function' || !win.isDestroyed())) {
      try { if (typeof win.show === 'function') win.show(); } catch (_) { /* noop */ }
      try { if (typeof win.focus === 'function') win.focus(); } catch (_) { /* noop */ }
      return { ok: true };
    }
    return { ok: false, code: 'NO_WINDOW' };
  });

  // [M6 R-18] 외부 툴 — tools.js. setToolPath/pick는 캐시 무효화·persist·force 재검증.
  guard('spip:getTools', () => toolsIpc.getTools(ctx));
  guard('spip:setToolPath', (args) => toolsIpc.setToolPath(args, ctx));
  guard('spip:pickToolExecutable', (args) => toolsIpc.pickToolExecutable(args, Object.assign({}, ctx, {
    dialog,
    win: typeof getWin === 'function' ? getWin() : undefined,
  })));

  // 메일 계정(복수 IMAP) — mailAccounts.js. 변경 시 persist + 감시 재구성(ctx.restartMailWatch).
  //   응답엔 비밀번호 미포함(toPublicView). testMailAccount는 실제 IMAP 로그인 1회 시도.
  guard('spip:getMailAccounts', () => mailAccountsIpc.getMailAccounts(ctx));
  guard('spip:addMailAccount', (args) => mailAccountsIpc.addMailAccount(args, ctx));
  guard('spip:updateMailAccount', (args) => mailAccountsIpc.updateMailAccount(args, ctx));
  guard('spip:removeMailAccount', (args) => mailAccountsIpc.removeMailAccount(args, ctx));
  guard('spip:testMailAccount', (args) => mailAccountsIpc.testMailAccount(args, ctx));
  guard('spip:getMailSummary', () => mailAccountsIpc.getMailSummary(ctx));
  guard('spip:getMailMessage', (args) => mailAccountsIpc.getMailMessage(args, ctx));

  // 홈 인사이트 — 최근 14일 커밋 빈도(등록 프로젝트 합산, git -C safeExec).
  guard('spip:getCommitActivity', () => insightsIpc.getCommitActivity(ctx));
  // [항목2] 홈 인사이트 — Claude Code 로컬 로그 토큰 사용량 집계(읽기 전용·수치만).
  guard('spip:getClaudeUsage', () => insightsIpc.getClaudeUsage(ctx));

  // [M7 SEC-M2] 즐겨찾기 변경 broadcast(단방향 push) — setFavorite 성공 시 메인 wc + 위젯 wc 양쪽에 동기화.
  //   payload 스키마 = { favorites:string[] }만(경로/실행 인자/내부 상태 금지). 대상 wc는 메인·위젯 2개로
  //   화이트리스트(getAllWindows() 순회 금지 — 향후 창 추가 시 누설 방지). send 전 !isDestroyed() 가드.
  const broadcastFavorites = (favorites) => {
    const payload = { favorites }; // 형식 검증된 id 배열뿐(uiState가 반환한 res.favorites)
    const mainWc = (typeof getWebContents === 'function') ? getWebContents() : null;
    const widgetWc = (typeof getFavoritesWidgetWc === 'function') ? getFavoritesWidgetWc() : null;
    [mainWc, widgetWc].forEach((wc) => {
      if (wc && typeof wc.isDestroyed === 'function' && !wc.isDestroyed() && typeof wc.send === 'function') {
        try { wc.send('spip:favorites-changed', payload); } catch (_) { /* noop */ }
      }
    });
  };

  // [M6 R-19/R-20] UI 상태 — uiState.js.
  guard('spip:getUiState', () => uiStateIpc.getUiState(ctx));
  guard('spip:setFavorite', async (args) => {
    const res = await uiStateIpc.setFavorite(args, ctx); // 기존 핸들러(검증·영속) 불변
    if (res && res.ok && Array.isArray(res.favorites)) broadcastFavorites(res.favorites);
    return res;
  });
  guard('spip:setOrder', (args) => uiStateIpc.setOrder(args, ctx));
  guard('spip:setSortMode', (args) => uiStateIpc.setSortMode(args, ctx));
  // [R-32] 홈 섹션 순서 — 섹션 enum 화이트리스트만(경로·실행 무관). 검증은 메인 normalizeHomeLayout 단일 경계.
  guard('spip:setHomeLayout', (args) => uiStateIpc.setHomeLayout(args, ctx));
  // [위젯 추가/제거] 숨긴(미적용) 위젯 집합 — 토글 가능 위젯 화이트리스트만. 검증은 메인 normalizeHiddenWidgets.
  guard('spip:setHiddenWidgets', (args) => uiStateIpc.setHiddenWidgets(args, ctx));
  // 프로젝트 표시 별칭 + 테마(라이트/다크/시스템).
  guard('spip:setProjectName', (args) => uiStateIpc.setProjectName(args, ctx));
  guard('spip:setTheme', (args) => uiStateIpc.setTheme(args, ctx));
  // 할 일(홈 브리핑) — 추가/완료토글/삭제. 읽기는 getUiState 응답의 todos로.
  guard('spip:addTodo', (args) => uiStateIpc.addTodo(args, ctx));
  guard('spip:toggleTodo', (args) => uiStateIpc.toggleTodo(args, ctx));
  guard('spip:removeTodo', (args) => uiStateIpc.removeTodo(args, ctx));
  // [백로그2-4] 할 일 마감 일시 설정/해제 + 마감 도래 시 OS 토스트 알림.
  guard('spip:setTodoDue', (args) => uiStateIpc.setTodoDue(args, ctx));
  guard('spip:notify', (args) => notifyIpc.notify(args, ctx));
  // 홈 언어 분포 추세 baseline(스캔 간 비교) — getUiState 응답의 langTrend로 읽기.
  guard('spip:updateLangTrend', (args) => uiStateIpc.updateLangTrend(args, ctx));

  // [M13 R-34~R-41] 브리핑 AI — shape 검증은 각 핸들러 본체(rev P1-1). 키 평문 회송 0(getSettings=hasApiKey).
  //   상태/델타/완료/에러는 단방향 push(orchestrator가 getWebContents로 메인창에 send). egress는 메인 단독.
  guard('spip:briefing:getState', (args) => briefingIpc.getState(args, ctx));
  guard('spip:briefing:trigger', (args) => briefingIpc.trigger(args, ctx));
  guard('spip:briefing:abort', (args) => briefingIpc.abort(args, ctx));
  guard('spip:briefing:resolveItem', (args) => briefingIpc.resolveItem(args, ctx));
  guard('spip:briefing:getSettings', (args) => briefingIpc.getSettings(args, ctx));
  guard('spip:briefing:setSettings', (args) => briefingIpc.setSettings(args, ctx));
  guard('spip:briefing:testConnection', (args) => briefingIpc.testConnection(args, ctx));

  // [SH-2/SH-3] 즐겨찾기 셸프 위젯 — shelf.js. folder/file(localMeta)·url(urlMeta 크롤·SSRF·og).
  //   shell 주입(file=openPath / url=openExternal). add/open 양쪽 pathPolicy 재게이트. main이 id·시각 스탬프.
  const shelfCtx = () => Object.assign({}, ctx, { shell });

  // [SH-4] 셸프 변경 단방향 push — 메인창 wc에만 화이트리스트 송신(신호만, payload 없음). 렌더러는
  //   onChanged 수신 시 list() 재조회(onMailUpdated 패턴). 스케줄러/수동 refresh가 메타 변경 시 호출.
  const broadcastShelf = () => {
    const mainWc = (typeof getWebContents === 'function') ? getWebContents() : null;
    if (mainWc && typeof mainWc.isDestroyed === 'function' && !mainWc.isDestroyed() && typeof mainWc.send === 'function') {
      try { mainWc.send('spip:shelf:changed'); } catch (_) { /* noop */ }
    }
  };
  // [SH-4] main.js 스케줄러가 동일 broadcastShelf를 재사용하도록 콜백 주입(있으면).
  if (typeof deps.setShelfBroadcast === 'function') {
    try { deps.setShelfBroadcast(broadcastShelf); } catch (_) { /* noop */ }
  }

  guard('spip:shelf:list', () => shelfIpc.list(undefined, shelfCtx()));
  guard('spip:shelf:add', (args) => shelfIpc.add(args, shelfCtx()));
  guard('spip:shelf:remove', (args) => shelfIpc.remove(args, shelfCtx()));
  // 책 제목(스파인 표시명) 사용자 지정 — 성공 시 다른 창 동기화를 위해 changed push.
  guard('spip:shelf:rename', async (args) => {
    const res = await shelfIpc.rename(args, shelfCtx());
    if (res && res.ok) broadcastShelf();
    return res;
  });
  guard('spip:shelf:reorder', (args) => shelfIpc.reorder(args, shelfCtx()));
  guard('spip:shelf:open', (args) => shelfIpc.open(args, shelfCtx()));
  // 수동 refresh 성공(메타 변경 가능) 시 다른 창 동기화를 위해 changed push.
  guard('spip:shelf:refresh', async (args) => {
    const res = await shelfIpc.refresh(args, shelfCtx());
    if (res && res.ok) broadcastShelf();
    return res;
  });
  // [SH-4] 자동 재크롤 토글 조회/설정(config.shelfAutoRefresh 영속). list 응답에도 autoRefresh 포함.
  guard('spip:shelf:getSettings', () => shelfIpc.getSettings(undefined, shelfCtx()));
  guard('spip:shelf:setSettings', (args) => shelfIpc.setSettings(args, shelfCtx()));

  // 자동 업데이트(사용자 주도) — 제어는 autoUpdate.js(electron-updater). 진행 상황은 단방향 push
  //   'spip:update:status'(initAutoUpdate 가 getWebContents 로 메인창에 send). 미패키징은 NOT_PACKAGED.
  guard('spip:getUpdateState', () => autoUpdate.getUpdateState());
  guard('spip:checkForUpdate', () => autoUpdate.checkForUpdates());
  guard('spip:downloadUpdate', () => autoUpdate.downloadUpdate());
  guard('spip:installUpdate', () => autoUpdate.quitAndInstall());
}

module.exports = { registerIpcHandlers, isTrustedSender, TRUSTED_ORIGIN };
