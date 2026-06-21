'use strict';
/**
 * dashboard-menu.test.js — Electron 다면 검증 프론트 반영(P2-1·P2-6) 순수 로직 검증.
 * 대상: public/app.js
 *   - dispatchMenuAction      (P2-1: 네이티브 메뉴 {action} → 핸들러 토큰 매핑)
 *   - resolveScanReloadView   (P2-6: done→대시보드 전환 뷰 결정, 고정 타이머 race 제거)
 *   - subscribeMenu wiring     (onMenu cb → dispatchMenuAction → 올바른 핸들러 식별; onMenu 모킹)
 * 계약: docs/reviews/electron_code_review_1.html (P2-1 dead wiring·P2-6 전환 타이머)
 *   onMenu 계약(devops 명세): cb 는 {action} 수신, action ∈ pickFolders|rescan|refresh|about,
 *   onMenu 는 unsubscribe 함수 반환.
 */
const { test } = require('node:test');
const assert = require('node:assert');

const {
  dispatchMenuAction,
  resolveScanReloadView,
} = require('../public/app.js');

/* ─────────────── P2-1: dispatchMenuAction (action → 핸들러 토큰) ─────────────── */

test('dispatchMenuAction: 4개 메뉴 액션을 각 핸들러로 결정론적 매핑', () => {
  assert.strictEqual(dispatchMenuAction({ action: 'pickFolders' }).handler, 'pickFolders');
  assert.strictEqual(dispatchMenuAction({ action: 'rescan' }).handler, 'rescan');
  assert.strictEqual(dispatchMenuAction({ action: 'refresh' }).handler, 'refresh');
  assert.strictEqual(dispatchMenuAction({ action: 'about' }).handler, 'about');
});

test('dispatchMenuAction: 알 수 없는 action → null(graceful 무시)', () => {
  assert.strictEqual(dispatchMenuAction({ action: 'devtools' }).handler, null);
  assert.strictEqual(dispatchMenuAction({ action: 'quit' }).handler, null);
  assert.strictEqual(dispatchMenuAction({ action: '' }).handler, null);
});

test('dispatchMenuAction: 비정상 입력(비객체·action 누락·비문자열) → null', () => {
  assert.strictEqual(dispatchMenuAction(null).handler, null);
  assert.strictEqual(dispatchMenuAction(undefined).handler, null);
  assert.strictEqual(dispatchMenuAction('rescan').handler, null);
  assert.strictEqual(dispatchMenuAction({}).handler, null);
  assert.strictEqual(dispatchMenuAction({ action: 123 }).handler, null);
  assert.strictEqual(dispatchMenuAction({ action: { nested: 'rescan' } }).handler, null);
});

test('dispatchMenuAction: 항상 {handler} shape 반환(부수효과 없음 — 순수)', () => {
  const r = dispatchMenuAction({ action: 'rescan' });
  assert.deepStrictEqual(Object.keys(r), ['handler']);
});

/* ─────────────── P2-1: onMenu cb → 핸들러 디스패치 매핑(통합, onMenu 모킹) ─────────────── */
// initBrowser 내부 onMenuCommand 는 비공개지만, 매핑 본질(dispatchMenuAction)과
// 디스패치 라우팅이 일대일임을 모킹된 onMenu 흐름으로 재현해 회귀를 고정한다.

test('onMenu cb 흐름: 각 action 이 정확히 대응 핸들러 1개로 라우팅', () => {
  // dispatchMenuAction 으로 토큰 → 핸들러 매핑을 그대로 라우팅하는 onMenuCommand 재현
  const calls = [];
  const handlers = {
    pickFolders: () => calls.push('pickFolders'),
    rescan: () => calls.push('rescan'),
    refresh: () => calls.push('refresh'),
    about: () => calls.push('about'),
  };
  function onMenuCommand(msg) {
    const { handler } = dispatchMenuAction(msg);
    if (handler && handlers[handler]) handlers[handler]();
  }

  // onMenu 모킹: 구독 후 cb 를 직접 호출, unsubscribe 함수 반환(계약)
  let registered = null;
  let unsubscribed = false;
  const onMenu = (cb) => { registered = cb; return () => { unsubscribed = true; }; };

  const unsub = onMenu(onMenuCommand);
  registered({ action: 'rescan' });
  registered({ action: 'refresh' });
  registered({ action: 'pickFolders' });
  registered({ action: 'about' });
  registered({ action: 'bogus' }); // 무시

  assert.deepStrictEqual(calls, ['rescan', 'refresh', 'pickFolders', 'about']);

  // unsubscribe 계약: 함수이고 호출 가능
  assert.strictEqual(typeof unsub, 'function');
  unsub();
  assert.strictEqual(unsubscribed, true);
});

/* ─────────────── P2-6: resolveScanReloadView (전환 결정성) ─────────────── */

test('resolveScanReloadView: 프로젝트 있는 스냅샷 → dashboard', () => {
  const r = resolveScanReloadView({ hasSnapshot: true, projects: [{ id: 'a' }] });
  assert.strictEqual(r.view, 'dashboard');
  assert.strictEqual(r.empty, false);
});

test('resolveScanReloadView: 빈 스냅샷(빈 배열) → firstRun', () => {
  const r = resolveScanReloadView({ hasSnapshot: true, projects: [] });
  assert.strictEqual(r.view, 'firstRun');
  assert.strictEqual(r.empty, true);
});

test('resolveScanReloadView: hasSnapshot=false → firstRun', () => {
  assert.strictEqual(resolveScanReloadView({ hasSnapshot: false, projects: [{ id: 'a' }] }).view, 'firstRun');
});

test('resolveScanReloadView: projects 비배열/누락/null → firstRun(graceful)', () => {
  assert.strictEqual(resolveScanReloadView({ projects: 'x' }).view, 'firstRun');
  assert.strictEqual(resolveScanReloadView({}).view, 'firstRun');
  assert.strictEqual(resolveScanReloadView(null).view, 'firstRun');
  assert.strictEqual(resolveScanReloadView(undefined).view, 'firstRun');
});

test('resolveScanReloadView: 결정론적 — 타이머/시간 비의존(동일 입력 동일 출력)', () => {
  const payload = { hasSnapshot: true, projects: [{ id: 'a' }, { id: 'b' }] };
  const a = resolveScanReloadView(payload);
  const b = resolveScanReloadView(payload);
  assert.deepStrictEqual(a, b);
  assert.deepStrictEqual(Object.keys(a).sort(), ['empty', 'view']);
});
