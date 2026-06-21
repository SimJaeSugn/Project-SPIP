'use strict';
/**
 * favorites-widget.test.js — electron/favoritesWidget.js (M7 R-22, 헤드리스 F-3)
 *
 * BrowserWindow·screen·hardenWebContents를 deps로 주입(모킹)해 위젯 창 생성·창 속성(§4.1)·
 * SEC-H1(CSP 재등록 부재)·SEC-H2(movable:false·alwaysOnTop 토글·blur grace)·우측하단 위치계산·
 * dispose 멱등·단일 인스턴스 재사용·broadcast 대상 getWebContents를 검증한다.
 *
 * Electron 미설치에서도 동작 — favoritesWidget은 Electron을 지연 require하며 deps 주입을 허용.
 */
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');

const favoritesWidget = require('../electron/favoritesWidget');

// ── 모킹 BrowserWindow ──
function makeFakeWindow() {
  const win = {
    _opts: null,
    _destroyed: false,
    _focused: true,
    _shown: false,
    _alwaysOnTop: false,
    _alwaysOnTopLevel: null,
    _position: null,
    _size: [360, 220],
    _loadedUrl: null,
    _events: {},
    _hardened: false,
    webContents: {
      isDestroyed: () => win._destroyed,
      send: () => {},
    },
    isDestroyed: () => win._destroyed,
    isFocused: () => win._focused,
    getSize: () => win._size,
    setPosition: (x, y) => { win._position = [x, y]; },
    setAlwaysOnTop: (on, level) => { win._alwaysOnTop = on; win._alwaysOnTopLevel = on ? (level || null) : null; },
    show: () => { win._shown = true; },
    hide: () => { win._shown = false; },
    focus: () => { win._focused = true; },
    loadURL: (u) => { win._loadedUrl = u; },
    on: (ev, cb) => { win._events[ev] = cb; },
    destroy: () => { win._destroyed = true; if (win._events.closed) win._events.closed(); },
    _emit: (ev, ...args) => { if (win._events[ev]) win._events[ev](...args); },
  };
  return win;
}

function makeDeps() {
  const created = [];
  let cspCalls = 0;
  const hardenCalls = [];
  const BrowserWindow = function (opts) {
    const w = makeFakeWindow();
    w._opts = opts;
    created.push(w);
    return w;
  };
  const screen = {
    getCursorScreenPoint: () => ({ x: 1500, y: 1000 }),
    getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }),
  };
  const deps = {
    BrowserWindow,
    screen,
    trustedOrigin: 'app://',
    hardenWebContents: (wc, opts) => { hardenCalls.push({ wc, opts }); if (wc) wc._hardened = true; },
    // applyCspHeaders는 deps에 의도적으로 없음(SEC-H1) — 위젯이 호출할 수 없음을 보장.
    _created: created,
    _hardenCalls: hardenCalls,
    _cspCalls: () => cspCalls,
  };
  return deps;
}

beforeEach(() => {
  // 각 테스트 격리 — 모듈 단일 widget 인스턴스 초기화.
  favoritesWidget.dispose();
});

test('show — BrowserWindow 생성 + §4.1 창 속성 1:1', () => {
  const deps = makeDeps();
  favoritesWidget.show(deps);
  assert.strictEqual(deps._created.length, 1);
  const o = deps._created[0]._opts;
  assert.strictEqual(o.frame, false);
  assert.strictEqual(o.transparent, true);
  assert.strictEqual(o.resizable, false);
  assert.strictEqual(o.minimizable, false);
  assert.strictEqual(o.maximizable, false);
  assert.strictEqual(o.fullscreenable, false);
  assert.strictEqual(o.movable, false);          // ★SEC-H2
  assert.strictEqual(o.skipTaskbar, true);
  assert.strictEqual(o.alwaysOnTop, false);       // ★SEC-H2: 생성 시 off
  assert.strictEqual(o.show, false);
  assert.ok(!('parent' in o), 'parent 미지정(독립 생명주기·R-22)');
});

test('show — webPreferences 메인창과 1:1 동일 + preload-favorites', () => {
  const deps = makeDeps();
  favoritesWidget.show(deps);
  const wp = deps._created[0]._opts.webPreferences;
  assert.strictEqual(wp.contextIsolation, true);
  assert.strictEqual(wp.nodeIntegration, false);
  assert.strictEqual(wp.sandbox, true);
  assert.strictEqual(wp.webSecurity, true);
  assert.ok(/preload-favorites\.js$/.test(wp.preload), 'preload-favorites.js 사용');
});

test('show — app://favorites.html 로드(file:// 아님)', () => {
  const deps = makeDeps();
  favoritesWidget.show(deps);
  assert.strictEqual(deps._created[0]._loadedUrl, 'app://favorites.html');
});

test('SEC-M1 — hardenWebContents가 위젯 wc로 1회 호출(per-wc)', () => {
  const deps = makeDeps();
  favoritesWidget.show(deps);
  assert.strictEqual(deps._hardenCalls.length, 1);
  assert.strictEqual(deps._hardenCalls[0].opts.trustedOrigin, 'app://');
  assert.strictEqual(deps._created[0].webContents._hardened, true);
});

test('SEC-H1 — applyCspHeaders deps 미존재(위젯이 CSP 재등록 불가)', () => {
  const deps = makeDeps();
  // deps에 applyCspHeaders 키가 없어야 한다(설계: default session 공유·앱 1회 등록).
  assert.strictEqual(deps.applyCspHeaders, undefined);
  favoritesWidget.show(deps);
  assert.strictEqual(deps._cspCalls(), 0);
});

test('SEC-H2 — show 시 setAlwaysOnTop(true,floating)', () => {
  const deps = makeDeps();
  favoritesWidget.show(deps);
  const w = deps._created[0];
  assert.strictEqual(w._alwaysOnTop, true);
  assert.strictEqual(w._alwaysOnTopLevel, 'floating');
  assert.strictEqual(w._shown, true);
});

test('SEC-H2 — hide 시 setAlwaysOnTop(false) 후 hide', () => {
  const deps = makeDeps();
  favoritesWidget.show(deps);
  favoritesWidget.hide();
  const w = deps._created[0];
  assert.strictEqual(w._alwaysOnTop, false);
  assert.strictEqual(w._shown, false);
});

test('SEC-H2 — blur: floating 즉시 해제 + 100ms grace 후(비포커스) hide', async () => {
  const deps = makeDeps();
  favoritesWidget.show(deps);
  const w = deps._created[0];
  w._focused = false;
  w._emit('blur');
  assert.strictEqual(w._alwaysOnTop, false, 'blur 즉시 floating 해제');
  assert.strictEqual(w._shown, true, 'grace 동안은 아직 표시');
  await new Promise((r) => setTimeout(r, 130));
  assert.strictEqual(w._shown, false, 'grace 후 hide');
});

test('SEC-H2 — blur 후 grace 중 재focus면 hide 취소', async () => {
  const deps = makeDeps();
  favoritesWidget.show(deps);
  const w = deps._created[0];
  w._focused = false;
  w._emit('blur');
  w._focused = true;
  w._emit('focus'); // grace 취소
  await new Promise((r) => setTimeout(r, 130));
  assert.strictEqual(w._shown, true, '재focus 시 hide 취소');
});

test('우측하단 위치계산 — workArea 기준(작업표시줄 제외·margin 16)', () => {
  const deps = makeDeps();
  favoritesWidget.show(deps);
  const w = deps._created[0];
  // wa {0,0,1920,1040}, size [360,220], margin 16
  assert.deepStrictEqual(w._position, [1920 - 360 - 16, 1040 - 220 - 16]);
});

test('우측하단 위치계산 — 멀티모니터 오프셋 workArea(x/y 비0)', () => {
  const deps = makeDeps();
  deps.screen.getDisplayNearestPoint = () => ({ workArea: { x: 1920, y: 100, width: 1280, height: 700 } });
  favoritesWidget.show(deps);
  const w = deps._created[0];
  assert.deepStrictEqual(w._position, [1920 + 1280 - 360 - 16, 100 + 700 - 220 - 16]);
});

test('단일 인스턴스 — 반복 show는 재생성 없이 재사용·재배치', () => {
  const deps = makeDeps();
  favoritesWidget.show(deps);
  favoritesWidget.hide();
  favoritesWidget.show(deps);
  assert.strictEqual(deps._created.length, 1, '재호출 시 새 창 생성 안 함');
  assert.strictEqual(deps._created[0]._shown, true);
});

test('getWebContents — 생존 시 wc, dispose 후 null', () => {
  const deps = makeDeps();
  favoritesWidget.show(deps);
  assert.ok(favoritesWidget.getWebContents());
  favoritesWidget.dispose();
  assert.strictEqual(favoritesWidget.getWebContents(), null);
});

test('SEC-L3 — dispose 멱등: 미생성 호출 no-op', () => {
  assert.doesNotThrow(() => favoritesWidget.dispose());
  assert.strictEqual(favoritesWidget.getWebContents(), null);
});

test('SEC-L3 — dispose 멱등: 생성 후 중복 dispose 안전', () => {
  const deps = makeDeps();
  favoritesWidget.show(deps);
  favoritesWidget.dispose();
  const w = deps._created[0];
  assert.strictEqual(w._destroyed, true);
  assert.doesNotThrow(() => favoritesWidget.dispose());
});

test('단독 close는 hide로 치환(destroy 아님·재사용)', () => {
  const deps = makeDeps();
  favoritesWidget.show(deps);
  const w = deps._created[0];
  let prevented = false;
  w._emit('close', { preventDefault: () => { prevented = true; } });
  assert.strictEqual(prevented, true, 'close 차단');
  assert.strictEqual(w._destroyed, false, 'destroy 아님');
  assert.strictEqual(w._shown, false, 'hide됨');
});

test('hide — 미생성 시 no-op(throw 없음)', () => {
  assert.doesNotThrow(() => favoritesWidget.hide());
});

test('positionBottomRight — screen 미가용 시 no-op(throw 없음)', () => {
  const w = makeFakeWindow();
  assert.doesNotThrow(() => favoritesWidget.positionBottomRight(w, null));
  assert.strictEqual(w._position, null);
});
