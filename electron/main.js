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
const favoritesWidget = require('./favoritesWidget');
const { Logger } = require('../lib/common/logger');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const PRELOAD = path.join(__dirname, 'preload.js');
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
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(request.url).pathname);
    } catch (_) {
      return new Response('Bad Request', { status: 400 });
    }
    if (!pathname || pathname === '/') pathname = '/index.html';

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
    ctx,
    logger,
    trustedOrigin: TRUSTED_ORIGIN,
    getWebContents: () => (win && !win.isDestroyed() ? win.webContents : null),
    // [M7 SEC-M2] 위젯 wc 지연평가 — favorites-changed broadcast 대상(파괴 시 null).
    getFavoritesWidgetWc: () => favoritesWidget.getWebContents(),
    getWin: () => win,
  });

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
      onShowDashboard: () => { if (win && !win.isDestroyed()) { win.show(); win.focus(); } },
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
