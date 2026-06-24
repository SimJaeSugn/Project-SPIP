'use strict';
/**
 * electron/main.js — Electron main 프로세스 (composition root) (electron-migration §7.1)
 *
 * 책임:
 *   · 환경변수 악용 차단(EM-M-3): ELECTRON_RUN_AS_NODE로 기동되면 즉시 종료.
 *   · 단일 인스턴스 락(둘째 실행은 기존 창 포커스).
 *   · app:// 커스텀 프로토콜로 public/ 자산 서빙(EM-M-1) → loadURL('app://index.html').
 *   · buildContext로 server.js 조립 승계(config·store·scanController).
 *   · 보안 webPreferences(contextIsolation·nodeIntegration off·sandbox)·하드닝·CSP 이중주입.
 *   · ipcMain 채널 등록(register.js) + senderFrame 발신자 검증.
 *   · 종료 시 스캔 진행 중이면 확인 다이얼로그(Q4).
 *
 * 이 파일의 창·메뉴·생명주기 wiring은 수동 GUI 스모크로만 검증된다(F-3). 비즈니스 로직·검증은
 * electron/ipc/*·context.js·security.js의 순수 함수로 분리되어 헤드리스 단위테스트된다.
 */

// ── EM-M-3: RUN_AS_NODE로 기동되면 앱 로직을 절대 실행하지 않고 종료(패킹 앱 악용 표면 제거) ──
if (process.env.ELECTRON_RUN_AS_NODE) {
  // app이 아직 없을 수 있으므로 프로세스 자체를 종료.
  process.exit(0);
}

const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, Menu, dialog, ipcMain, protocol, shell, clipboard, screen } = require('electron');

const { buildContext } = require('./context');
const { registerIpcHandlers } = require('./ipc/register');
const { applyCspHeaders, hardenWebContents, TRUSTED_ORIGIN } = require('./security');
const { buildMenuTemplate } = require('./menu');
const { createTray } = require('./tray');
const { resolveAppRelPath } = require('./appProtocol');
const favoritesWidget = require('./favoritesWidget');
const { initAutoUpdate } = require('./autoUpdate');
const { Logger, clampString } = require('../lib/common/logger');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const PRELOAD = path.join(__dirname, 'preload.js');
// 트레이 전용 아이콘(icon-tray.ico). 패키지에선 resources/(electron-builder.yml extraResources 동봉),
//   개발에선 build/ 에서 로드. 부재 시 tray.js 가 빈 이미지로 graceful 폴백(트레이는 계속 생성).
const TRAY_ICON = app.isPackaged
  ? path.join(process.resourcesPath, 'icon-tray.ico')
  : path.join(__dirname, '..', 'build', 'icon-tray.ico');
// [P3-4] TRUSTED_ORIGIN은 security.js 단일 원천에서 import(이중정의 제거).
const IS_DEV = !app.isPackaged;

// app:// 응답 Content-Type 매핑(확장자 기준). 누락 확장자는 octet-stream.
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
};
function contentTypeFor(filePath) {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

let win = null;
let ctx = null;
let tray = null;
// [R-21] 트레이 '종료'·앱 quit 시에만 true. close-to-tray 분기 기준(§9.2).
let isQuitting = false;
// 업데이트 설치 재시작(quitAndInstall) 경로 표식 — close 시 Q4(스캔 확인) 건너뛰고 즉시 종료.
let isInstalling = false;
// [R-21/MQ-4] 최초 hide 시 트레이 풍선 안내를 1회만 표시.
let trayBalloonShown = false;
const logger = new Logger();

// app:// 를 표준·보안 스킴으로 등록(앱 ready 전 호출 필수).
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: false, corsEnabled: false } },
]);

// 단일 인스턴스 락 — 둘째 실행은 기존 창 포커스.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  // [M6-M-3] second-instance가 전달하는 argv/cwd payload는 비신뢰 — 절대 파싱·경로 사용·실행 안 함.
  //   win.show()/restore()/focus() 트리거로만 사용(트레이로 숨어 있어도 복원).
  app.on('second-instance', (_e, _argv, _cwd) => {
    if (win) {
      win.show();
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(onReady).catch((err) => {
    logger.error('main ready 실패', err);
    app.quit();
  });
}

/** app:// 자산 요청을 public/ 루트로 안전 매핑(디렉터리 이탈 차단). */
function registerAppProtocol() {
  protocol.handle('app', (request) => {
    // app:// 는 standard scheme이라 'app://favorites.html'의 파일명이 hostname으로 파싱된다.
    //   resolveAppRelPath가 host/pathname을 종합해 올바른 public/ 상대 경로를 돌려준다(순수·테스트됨).
    const pathname = resolveAppRelPath(request.url);
    if (pathname === null) return new Response('Bad Request', { status: 400 });

    // public/ 루트 기준으로 정규화하고 이탈을 차단.
    const resolved = path.normalize(path.join(PUBLIC_DIR, pathname));
    const rootWithSep = PUBLIC_DIR.endsWith(path.sep) ? PUBLIC_DIR : PUBLIC_DIR + path.sep;
    if (resolved !== PUBLIC_DIR && !resolved.startsWith(rootWithSep)) {
      return new Response('Forbidden', { status: 403 });
    }
    // 패키징(asar) 환경에서는 Chromium net의 file://이 asar 내부를 못 읽으므로
    // (asar 지원은 Node fs에만 패치됨) fs로 직접 읽어 바이트로 응답한다 — dev·패키징 양쪽 동작.
    // 디렉터리면 readFileSync가 EISDIR로 throw → catch → 404.
    let body;
    try {
      body = fs.readFileSync(resolved);
    } catch (_) {
      return new Response('Not Found', { status: 404 });
    }
    return new Response(body, { status: 200, headers: { 'content-type': contentTypeFor(resolved) } });
  });
}

/** 계정 라벨 접두("[label] ") — 공개 뷰 기준, 제어문자/길이 정리(L-3). */
function mailLabelPrefix(account) {
  const label = (account && typeof account.label === 'string' && account.label)
    ? account.label
    : (account && account.user ? account.user : '');
  return label ? '[' + clampString(label, 40) + '] ' : '';
}

/** 새 메일 도착을 트레이 풍선 알림으로 노출(어느 계정인지 라벨 포함, L-3). */
function notifyNewMail(payload) {
  if (!tray || !tray.tray || typeof tray.tray.displayBalloon !== 'function') return;
  const newCount = (payload && Number.isFinite(payload.newCount)) ? payload.newCount : 0;
  if (newCount <= 0) return;
  const unseen = (payload && Number.isFinite(payload.unseen)) ? payload.unseen : null;
  let content = mailLabelPrefix(payload && payload.account) + '새 메일 ' + newCount + '통이 도착했습니다.';
  if (unseen != null && unseen > 0) content += ' (읽지 않음 ' + unseen + '통)';
  try {
    tray.tray.displayBalloon({ title: 'Project-SPIP 메일', content: clampString(content, 200) });
  } catch (_) { /* noop */ }
}

/** 메일 로그인 실패를 트레이로 1회 안내(해당 계정 감시 중단 시점). */
function notifyMailAuthError(payload) {
  if (!tray || !tray.tray || typeof tray.tray.displayBalloon !== 'function') return;
  try {
    tray.tray.displayBalloon({
      title: 'Project-SPIP 메일',
      content: clampString(mailLabelPrefix(payload && payload.account)
        + '메일 로그인에 실패해 자동 확인을 중단했습니다. 설정에서 계정 정보를 확인하세요.', 200),
    });
  } catch (_) { /* noop */ }
}

/** 새 메일 감지 시 렌더러(홈)로 갱신 신호 push — 홈이 getMailSummary로 최신 다이제스트 재조회. */
function pushMailUpdated() {
  if (win && !win.isDestroyed() && win.webContents && !win.webContents.isDestroyed()) {
    try { win.webContents.send('spip:mailUpdated', {}); } catch (_) { /* 창 파괴 레이스 격리 */ }
  }
}

/** 현재 config.mailAccounts로 메일 감시를 재구성한다(계정 추가/수정/삭제 후 IPC가 호출). */
function applyMailWatch() {
  if (!ctx || !ctx.mailManager) return;
  const accounts = Array.isArray(ctx.config && ctx.config.mailAccounts) ? ctx.config.mailAccounts : [];
  try {
    ctx.mailManager.apply(accounts, {
      onNewMail: (payload) => { notifyNewMail(payload); pushMailUpdated(); },
      onAuthError: notifyMailAuthError,
    });
  } catch (err) {
    logger.error('메일 감시 재구성 실패', err);
  }
}

function onReady() {
  registerAppProtocol();

  // composition root 승계.
  ctx = buildContext({ logger });

  // 보안 webPreferences.
  win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    show: false,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });

  // CSP 이중주입(EM-M-1) + 하드닝(§6.2).
  //   [P3-2] applyCspHeaders는 2번째 인자를 받지 않는다(CSP는 trustedOrigin과 무관) — 인자 제거.
  applyCspHeaders(win.webContents.session);
  hardenWebContents(win.webContents, { trustedOrigin: TRUSTED_ORIGIN });

  // ipcMain 채널 등록 + senderFrame 검증.
  registerIpcHandlers({
    ipcMain,
    dialog,
    clipboard, // [R-17] main clipboard 주입(copyText).
    shell,     // 경로 열기(shell.openPath) 주입.
    ctx,
    logger,
    trustedOrigin: TRUSTED_ORIGIN,
    getWebContents: () => (win && !win.isDestroyed() ? win.webContents : null),
    // [M7 SEC-M2] 위젯 wc 지연평가 — favorites-changed broadcast 대상(파괴 시 null).
    getFavoritesWidgetWc: () => favoritesWidget.getWebContents(),
    getWin: () => win,
  });

  // [R-24 상태 주시] 한 번 스캔된 뒤(스냅샷 보유) 재스캔 전까지 git·freshness를 주기 재수집해
  //   변경분을 메인 창에 push('spip:projectsUpdated'). 빈 store(0개)면 tick은 무동작이라 항상 시작해도
  //   안전하다 — 첫 스캔으로 store.load()되면 그때부터 실제로 주시한다. 스캔 중엔 tick이 건너뛴다.
  try {
    ctx.stateWatcher.start({
      store: ctx.store,
      config: ctx.config,
      isScanning: () => {
        const phase = ctx.scanController ? ctx.scanController.status().phase : 'idle';
        return phase === 'scanning' || phase === 'finalizing';
      },
      onUpdate: (payload) => {
        if (win && !win.isDestroyed() && win.webContents && !win.webContents.isDestroyed()) {
          try { win.webContents.send('spip:projectsUpdated', payload); } catch (_) { /* 창 파괴 레이스 격리 */ }
        }
      },
    });
  } catch (err) {
    logger.error('상태 주시 시작 실패 — 주시 없이 계속', err);
  }

  // 메뉴(P2-1) — 메뉴 클릭은 포커스된 창의 webContents로 'spip:menu:<action>'를 send하고,
  //   renderer가 preload onMenu(cb)로 구독해 해당 액션(폴더선택/재스캔/새로고침/정보)을 수행한다.
  //   dead wiring(아무도 안 받는 send) 해소 — 발신·수신이 단일 계약(action 집합)으로 연결된다.
  Menu.setApplicationMenu(Menu.buildFromTemplate(buildMenuTemplate({
    isDev: IS_DEV,
    // 포커스된 창(없으면 메인 창)으로 보낸다 — 멀티/포커스 상황에서도 올바른 대상.
    getWebContents: () => {
      const focused = BrowserWindow.getFocusedWindow();
      const target = (focused && !focused.isDestroyed()) ? focused
        : ((win && !win.isDestroyed()) ? win : null);
      return target ? target.webContents : null;
    },
  })));

  // [R-21] 트레이 생성(창 생성 후). 콜백은 main이 소유하는 생명주기 함수로 연결.
  //   ★P2-2: onQuit는 app.quit()을 직접 부르지 않고 win.close() 트리거로 통일 → 실제 종료(dispose+
  //   destroy+exit)는 close 핸들러가 Q4 통과 후 doFinalQuit 단일 경로에서만 수행(조기 dispose 방지).
  try {
    tray = createTray({
      iconPath: TRAY_ICON,
      onShowDashboard: () => { if (win && !win.isDestroyed()) { win.show(); win.focus(); } },
      // '메일 지금 확인' — 등록된 모든 계정을 즉시 1회 폴링(계정 없으면 무동작).
      onCheckMail: () => { try { ctx.mailManager.checkNow(); } catch (_) { /* noop */ } },
      // [M7 §8.1 R4] 트레이 '즐겨찾기' → 독립 위젯 창 show(메인창 push/show 폐기).
      //   메인창이 hidden(트레이 상주)이어도 위젯 등장(R-22 독립성). applyCspHeaders는 deps 불요
      //   (SEC-H1: default session에 앱 1회 등록 자동 적용). hardenWebContents는 per-wc라 주입.
      onShowFavorites: () => {
        try {
          favoritesWidget.show({ hardenWebContents, trustedOrigin: TRUSTED_ORIGIN, screen });
        } catch (err) {
          logger.error('즐겨찾기 위젯 표시 실패', err);
        }
      },
      onQuit: () => { isQuitting = true; if (win && !win.isDestroyed()) win.close(); else doFinalQuit(); },
    });
  } catch (err) {
    logger.error('트레이 생성 실패 — 트레이 없이 계속', err);
  }

  // 트레이 풍선 클릭 시 대시보드 복원(메일 알림 클릭 → 창 표시).
  if (tray && tray.tray && typeof tray.tray.on === 'function') {
    try {
      tray.tray.on('balloon-click', () => { if (win && !win.isDestroyed()) { win.show(); win.focus(); } });
    } catch (_) { /* noop */ }
  }

  // 메일 계정 변경 시 IPC 핸들러가 감시를 재구성하도록 훅 노출 + 시작 시 1회 적용.
  //   최초 폴링은 계정별 기준선만 잡고 통지 안 함. 감시 실패는 워처 내부에서 격리(가용성 보존).
  ctx.restartMailWatch = applyMailWatch;
  applyMailWatch();

  win.loadURL('app://index.html');
  win.once('ready-to-show', () => win.show());
  // 방어: 렌더러 로드가 실패하면 ready-to-show가 영영 안 와서 창이 숨은 채(=무반응) 멈춘다.
  //   실패를 로깅하고 창을 강제 표시해 사용자가 상태를 인지하도록 한다.
  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    logger.error('renderer 로드 실패', { code, desc, url });
    if (win && !win.isDestroyed()) win.show();
  });

  // [R-21] close-to-tray 생명주기(§9.2/ADR-M6-4).
  //   평소 X(close): 종료가 아니라 트레이로 숨김(스캔은 백그라운드 지속). 최초 1회 트레이 풍선 안내(MQ-4).
  //   완전 종료(isQuitting=true)에서만 Q4(스캔 중 확인) 적용 — ★dispose는 Q4 통과 후 doFinalQuit에서만(P2-2).
  win.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      win.hide();
      if (!trayBalloonShown && tray && tray.tray && typeof tray.tray.displayBalloon === 'function') {
        trayBalloonShown = true;
        try {
          tray.tray.displayBalloon({ title: 'Project-SPIP', content: '트레이에서 계속 실행 중입니다. 종료하려면 트레이 메뉴의 “종료”를 사용하세요.' });
        } catch (_) { /* noop */ }
      }
      return;
    }
    // 업데이트 설치 재시작(quitAndInstall) 경로: Q4(스캔 확인) 건너뛰고 즉시 정리·종료.
    //   quitAndInstall 이 인스톨러를 detached 로 이미 spawn 했으므로 app.exit 후에도 설치는 진행.
    if (isInstalling) { doFinalQuit(); return; }
    // 완전 종료 경로(isQuitting=true)에서만 Q4 적용.
    const phase = ctx && ctx.scanController ? ctx.scanController.status().phase : 'idle';
    if (phase === 'scanning' || phase === 'finalizing') {
      e.preventDefault();
      const choice = dialog.showMessageBoxSync(win, {
        type: 'question',
        buttons: ['종료', '취소'],
        defaultId: 1,
        cancelId: 1,
        message: '스캔이 진행 중입니다. 종료하시겠습니까?',
      });
      if (choice === 0) { doFinalQuit(); win.destroy(); } // 확정 시에만 dispose(P2-2)
      else { isQuitting = false; } // ★취소: 종료 의도 해제·미dispose로 정상 복귀(스캔 지속)
    } else {
      doFinalQuit();
    }
  });

  // [P2-3] 창 unload/reload 시 진행 스냅샷 push는 makeProgressSender의 isDestroyed/getWebContents
  //   지연평가 가드로 자연 격리된다(파괴된 wc로 send 안 함). 추가로 reload 시 renderer 쪽 구독
  //   (onScanProgress·onMenu)은 페이지 재로드로 자동 폐기되므로 main 측 누수는 없다.
  win.on('closed', () => { win = null; });

  // 자동 업데이트 클라이언트 초기화(trigger-and-forget) — 패키징 빌드에서만 동작(내부 가드).
  //   진행 상황은 메인창 webContents 로 'spip:update:status' push. 설치 직전 beforeInstall 로
  //   isInstalling/isQuitting 을 세워 close-to-tray 를 통과시킨다(인스톨러는 detached 로 생존).
  try {
    initAutoUpdate({
      logger,
      getWebContents: () => (win && !win.isDestroyed() ? win.webContents : null),
      beforeInstall: () => { isInstalling = true; isQuitting = true; },
    });
  } catch (err) {
    logger.error('자동 업데이트 초기화 실패 — 업데이트 없이 계속', err);
  }
}

// [P2-4] 앱 종료 직전 진행 스캔 watchdog 타이머 등 리소스 정리(타이머 leak 방지).
//   makeProgressSender는 getWebContents()가 null/파괴 wc를 반환하면 무동작이므로 sender 자체
//   별도 해제는 불필요. scanController.dispose()로 watchdog 타이머만 명시 해제한다.
//   ★멱등(P2-2): 중복 호출돼도 dispose는 1회 효과(_disposed 가드)·외부 OS 종료(before-quit) 직접 도달 시도 안전.
let _disposed = false;
function disposeResources() {
  if (_disposed) return;
  _disposed = true;
  try { if (ctx && ctx.scanController && typeof ctx.scanController.dispose === 'function') ctx.scanController.dispose(); } catch (err) { logger.error('dispose 실패', err); }
  // [R-24] 상태 주시 워처 타이머 정리(멱등).
  try { if (ctx && ctx.stateWatcher && typeof ctx.stateWatcher.stop === 'function') ctx.stateWatcher.stop(); } catch (err) { logger.error('워처 정리 실패', err); }
  // 메일 감시 관리자(계정별 타이머) 정리(멱등).
  try { if (ctx && ctx.mailManager && typeof ctx.mailManager.stop === 'function') ctx.mailManager.stop(); } catch (err) { logger.error('메일 감시 정리 실패', err); }
}

// [P2-2] 실제 종료 1지점: 자원 dispose는 여기서만(=Q4 통과/창 없음 확정 후). 멱등 설계.
function doFinalQuit() {
  disposeResources();
  // [M7 SEC-L3] 즐겨찾기 위젯 정리(멱등) — 미생성/이미 destroy 시 no-op. 단일 종료 경로 불변.
  try { favoritesWidget.dispose(); } catch (err) { logger.error('위젯 dispose 실패', err); }
  if (tray && typeof tray.destroy === 'function') { tray.destroy(); tray = null; }
  app.exit(0);
}

// ★before-quit: dispose를 여기서 직접 하지 않는다(중복·조기 dispose 방지). isQuitting 가드만.
//   외부 OS 종료(로그오프 등)로 before-quit이 직접 와도 doFinalQuit/disposeResources 멱등성으로 안전.
app.on('before-quit', () => { isQuitting = true; });

// ★window-all-closed에서 quit 제거 — 트레이 상주(전 플랫폼). 완전 종료는 onQuit→close→doFinalQuit가 담당.
app.on('window-all-closed', () => { /* no-op: 트레이 상주. 창 닫혀도 quit 안 함 */ });

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0 && app.isReady()) onReady();
});
