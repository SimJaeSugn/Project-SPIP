'use strict';
/**
 * electron/favoritesWidget.js — 즐겨찾기 위젯 창 (M7 R-22 · ADR-M7-1/2/3/5)
 *
 * 메인 대시보드와 독립된 frameless·우측하단 토스트형 BrowserWindow 1개를 관리한다.
 * 트레이 '즐겨찾기'가 main을 통해 show()를 호출하며, 메인창이 hidden(트레이 상주)이어도
 * 위젯은 등장한다(독립 생명주기 — parent 미지정).
 *
 * 보안(§5):
 *   · webPreferences는 메인창과 1:1 동일(contextIsolation·nodeIntegration:false·sandbox·webSecurity).
 *   · preload는 위젯 전용 축소 allowlist(preload-favorites.js).
 *   · app://favorites.html 로드(file:// 미사용). CSP는 default session 공유로 main이 1회 등록한
 *     applyCspHeaders가 자동 적용 → 위젯 생성 시 재호출하지 않음(SEC-H1, 세션당 1핸들러).
 *   · hardenWebContents는 per-webContents라 위젯 생성 시 반드시 호출(SEC-M1).
 *
 * SEC-H2(UI redressing/입력 가로채기 통제):
 *   · movable:false(비드래그·고정 우측하단, MQ7-2).
 *   · show 시 setAlwaysOnTop(true,'floating'), hide/blur 시 setAlwaysOnTop(false).
 *   · blur → 100ms grace 후 hide(grace 중 재focus면 취소). Esc/× 는 명시 hide().
 *   · setIgnoreMouseEvents 미사용(클릭통과 비허용).
 *
 * 생명주기(ADR-M7-2): 최초 1회 생성 후 hide/show 재사용. 단독 close=hide(destroy 아님).
 *   완전 종료(doFinalQuit)에서만 dispose()로 destroy(멱등·SEC-L3).
 *
 * [헤드리스 검증] BrowserWindow·screen·hardenWebContents를 deps로 주입 가능(기본 require('electron')).
 *   위치계산(positionBottomRight)·dispose 멱등·show/hide 토글을 모킹으로 단위테스트한다.
 *
 * 외부 의존성 0 — Electron은 지연 require(헤드리스 테스트 시 deps 주입).
 */

const path = require('path');

const PRELOAD_FAVORITES = path.join(__dirname, 'preload-favorites.js');
const WIDGET_URL = 'app://favorites.html';
const WIDGET_WIDTH = 360;
const WIDGET_HEIGHT = 220;
const MARGIN = 16;
const BLUR_GRACE_MS = 100;
const FLOATING_LEVEL = 'floating';

// 단일 위젯 인스턴스(모듈 변수) — 1개만 유지(재사용).
let widget = null;
let graceTimer = null;

/** deps에서 Electron API를 해석(헤드리스 테스트 시 주입). */
function resolveDeps(deps) {
  deps = deps || {};
  const electron = deps.electron || safeRequireElectron();
  return {
    BrowserWindow: deps.BrowserWindow || (electron && electron.BrowserWindow),
    screen: deps.screen || (electron && electron.screen),
    hardenWebContents: deps.hardenWebContents,
    trustedOrigin: deps.trustedOrigin || deps.TRUSTED_ORIGIN || 'app://',
  };
}

function safeRequireElectron() {
  try { return require('electron'); } catch (_) { return null; }
}

/**
 * 우측 하단 위치 계산(작업영역 기준·멀티모니터). show 트리거마다 재계산.
 *   커서가 놓인 디스플레이의 workArea(작업표시줄 제외) 기준 우측하단에 margin 띄워 배치.
 * @param {object} win BrowserWindow(또는 { getSize, setPosition } 모킹)
 * @param {object} screen Electron screen(또는 모킹)
 */
function positionBottomRight(win, screen) {
  if (!win || typeof win.setPosition !== 'function') return;
  if (!screen || typeof screen.getCursorScreenPoint !== 'function'
    || typeof screen.getDisplayNearestPoint !== 'function') return;
  const cursor = screen.getCursorScreenPoint();
  const disp = screen.getDisplayNearestPoint(cursor); // 커서가 있는 모니터
  const wa = (disp && disp.workArea) || { x: 0, y: 0, width: WIDGET_WIDTH, height: WIDGET_HEIGHT };
  const size = (typeof win.getSize === 'function') ? win.getSize() : [WIDGET_WIDTH, WIDGET_HEIGHT];
  const w = (Array.isArray(size) && size.length >= 1) ? size[0] : WIDGET_WIDTH;
  const h = (Array.isArray(size) && size.length >= 2) ? size[1] : WIDGET_HEIGHT;
  const x = wa.x + wa.width - w - MARGIN;  // 우측 여백
  const y = wa.y + wa.height - h - MARGIN; // 작업표시줄 위(하단 여백)
  win.setPosition(Math.round(x), Math.round(y), false);
}

/** blur 시: floating 즉시 해제 + 100ms grace 후 hide(재focus면 취소·SEC-H2+R1). */
function onBlur() {
  if (widget && !widget.isDestroyed() && typeof widget.setAlwaysOnTop === 'function') {
    widget.setAlwaysOnTop(false); // 표시 중에만 floating — 비포커스 위젯이 위에 떠 입력 가로채지 않게
  }
  clearTimeout(graceTimer);
  graceTimer = setTimeout(() => {
    if (widget && !widget.isDestroyed() && !widget.isFocused()) widget.hide();
  }, BLUR_GRACE_MS);
}

/** focus 시: grace 취소(위젯 내부 클릭 경합으로 인한 오작동 닫힘 방지). */
function onFocus() {
  clearTimeout(graceTimer);
}

/**
 * 위젯 인스턴스를 보장(없으면 생성·app:// 로드). 단일 인스턴스 재사용.
 * @param {object} deps { BrowserWindow?, screen?, hardenWebContents, trustedOrigin?|TRUSTED_ORIGIN?, electron? }
 * @returns {object} BrowserWindow
 */
function ensureWidget(deps) {
  const d = resolveDeps(deps);
  if (widget && !widget.isDestroyed()) return widget;
  if (!d.BrowserWindow) throw new Error('favoritesWidget: BrowserWindow unavailable');

  widget = new d.BrowserWindow({
    width: WIDGET_WIDTH,
    height: WIDGET_HEIGHT,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    movable: false,            // ★SEC-H2: 비드래그·고정 우측하단(MQ7-2)
    skipTaskbar: true,
    alwaysOnTop: false,        // ★SEC-H2: 생성 시 off, show 시에만 floating
    autoHideMenuBar: true,
    // parent 미지정 — 메인창 hide/close에 종속되지 않는 top-level 독립 창(R-22 독립성).
    webPreferences: {
      preload: PRELOAD_FAVORITES,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });

  // ★SEC-H1: applyCspHeaders 재호출 없음 — default session에 main이 이미 1회 등록(중복 등록 금지).
  // ★SEC-M1: per-webContents 하드닝(will-navigate·setWindowOpenHandler:deny·webview 거부)은 반드시 호출.
  if (typeof d.hardenWebContents === 'function' && widget.webContents) {
    d.hardenWebContents(widget.webContents, { trustedOrigin: d.trustedOrigin });
  }

  if (typeof widget.loadURL === 'function') widget.loadURL(WIDGET_URL); // app:// 로 별도 페이지(file:// 아님)

  if (typeof widget.on === 'function') {
    widget.on('blur', onBlur);
    widget.on('focus', onFocus);
    // 단독 close는 hide로 치환(destroy 아님·재사용). doFinalQuit dispose만 destroy.
    widget.on('close', (e) => {
      if (widget && !widget.isDestroyed()) {
        if (e && typeof e.preventDefault === 'function') e.preventDefault();
        hide();
      }
    });
    widget.on('closed', () => { widget = null; clearTimeout(graceTimer); });
  }

  return widget;
}

/**
 * 위젯 표시: ensure → 우측하단 재배치 → floating ON → show → focus.
 *   메인창 상태와 무관(독립). 트레이 onShowFavorites가 호출.
 * @param {object} deps { hardenWebContents, screen, trustedOrigin?|TRUSTED_ORIGIN?, BrowserWindow?, electron? }
 */
function show(deps) {
  const d = resolveDeps(deps);
  const w = ensureWidget(deps);
  positionBottomRight(w, d.screen);
  if (typeof w.setAlwaysOnTop === 'function') w.setAlwaysOnTop(true, FLOATING_LEVEL); // ★SEC-H2: 표시 시점에만 floating
  if (typeof w.show === 'function') w.show();
  if (typeof w.focus === 'function') w.focus();
  return w;
}

/**
 * 위젯 숨김: floating 해제 후 hide(없으면 no-op·SEC-H2).
 *   blur(grace 후)·Esc·헤더 ×·closeWidget 공통 경로. destroy 아님(재사용).
 */
function hide() {
  if (widget && !widget.isDestroyed()) {
    if (typeof widget.setAlwaysOnTop === 'function') widget.setAlwaysOnTop(false);
    if (typeof widget.hide === 'function') widget.hide();
  }
}

/**
 * 위젯 webContents(없거나 destroy면 null) — broadcast 지연평가 대상(register.js 주입).
 * @returns {object|null}
 */
function getWebContents() {
  if (widget && !widget.isDestroyed() && widget.webContents) return widget.webContents;
  return null;
}

/**
 * 위젯 정리(멱등·SEC-L3) — main.js doFinalQuit()에서만 호출.
 *   미생성/이미 destroy 시 no-op. 중복 호출 안전.
 */
function dispose() {
  clearTimeout(graceTimer);
  graceTimer = null;
  if (widget && !widget.isDestroyed() && typeof widget.destroy === 'function') {
    widget.destroy();
  }
  widget = null;
}

/** [테스트 전용] 모듈 내부 상태 조회. */
function _getWidgetForTest() {
  return widget;
}

module.exports = {
  show,
  hide,
  getWebContents,
  dispose,
  ensureWidget,
  positionBottomRight,
  PRELOAD_FAVORITES,
  WIDGET_URL,
  _getWidgetForTest,
};
