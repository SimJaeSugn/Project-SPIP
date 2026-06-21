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
const { app, BrowserWindow, Menu, dialog, ipcMain, protocol, shell } = require('electron');

const { buildContext } = require('./context');
const { registerIpcHandlers } = require('./ipc/register');
const { applyCspHeaders, hardenWebContents, TRUSTED_ORIGIN } = require('./security');
const { buildMenuTemplate } = require('./menu');
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
  app.on('second-instance', () => {
    if (win) {
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
    ctx,
    logger,
    trustedOrigin: TRUSTED_ORIGIN,
    getWebContents: () => (win && !win.isDestroyed() ? win.webContents : null),
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

  win.loadURL('app://index.html');
  win.once('ready-to-show', () => win.show());
  // 방어: 렌더러 로드가 실패하면 ready-to-show가 영영 안 와서 창이 숨은 채(=무반응) 멈춘다.
  //   실패를 로깅하고 창을 강제 표시해 사용자가 상태를 인지하도록 한다.
  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    logger.error('renderer 로드 실패', { code, desc, url });
    if (win && !win.isDestroyed()) win.show();
  });

  // 종료 시 스캔 진행 중이면 확인 다이얼로그(Q4).
  win.on('close', (e) => {
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
      if (choice === 0) win.destroy();
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
function disposeResources() {
  try { if (ctx && ctx.scanController && typeof ctx.scanController.dispose === 'function') ctx.scanController.dispose(); } catch (err) { logger.error('dispose 실패', err); }
}

app.on('before-quit', disposeResources);

app.on('window-all-closed', () => {
  disposeResources();
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0 && app.isReady()) onReady();
});
