'use strict';
/**
 * dashboard-menu.test.js — Electron 프론트 순수 로직 검증.
 *   - resolveScanReloadView   (P2-6: done→대시보드 전환 뷰 결정, 고정 타이머 race 제거)
 *
 * [R-28 정리] dispatchMenuAction(P2-1 네이티브 메뉴 매핑)은 메뉴 폐기로 제거됨 → 관련 테스트 삭제.
 *   단축키 매핑은 test/shortcuts.test.js(matchShortcut)에서 검증한다.
 */
const { test } = require('node:test');
const assert = require('node:assert');

const {
  resolveScanReloadView,
} = require('../public/app.js');

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
