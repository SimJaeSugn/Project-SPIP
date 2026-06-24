'use strict';
/**
 * commitPolling.test.js — R-31 커밋 차트 5분 폴링 게이트(헤드리스 F-3).
 *   shouldPollCommit(view, visible): 홈 뷰 + 창 가시 상태일 때만 폴링 → 홈 이탈/비가시 시 정지(git 0).
 *   5분(300000ms) 주기 상수가 메일(60000ms)보다 길다는 정합도 정적 확인.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { shouldPollCommit } = require('../public/app.js');
const APP_SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

// ── shouldPollCommit 게이트 ──────────────────────────────────────────────
test('R-31 — 홈 뷰 + 가시 상태일 때만 폴링 on', () => {
  assert.strictEqual(shouldPollCommit('home', true), true);
});

test('R-31 — 홈 이탈 시 폴링 off(git 호출 0)', () => {
  assert.strictEqual(shouldPollCommit('dashboard', true), false);
  assert.strictEqual(shouldPollCommit('orbit', true), false);
  assert.strictEqual(shouldPollCommit('scanning', true), false);
  assert.strictEqual(shouldPollCommit('loading', true), false);
});

test('R-31 — 홈이어도 창 비가시(visible=false)면 폴링 off(백그라운드 git 0)', () => {
  assert.strictEqual(shouldPollCommit('home', false), false);
});

test('R-31 — visible 미지정(undefined)은 가시로 간주(visibilityState 미지원 graceful)', () => {
  assert.strictEqual(shouldPollCommit('home', undefined), true);
  assert.strictEqual(shouldPollCommit('dashboard', undefined), false);
});

// ── 주기 상수 / 정지 배선 정적 확인 ──────────────────────────────────────
test('R-31 — 폴링 주기 상수 COMMIT_POLL_MS = 300000(5분)', () => {
  assert.ok(/COMMIT_POLL_MS\s*=\s*300000/.test(APP_SRC), 'COMMIT_POLL_MS 가 300000(5분)이어야 한다');
});

test('R-31 — 폴링 타이머가 shouldPollCommit 게이트(syncHomePolling)로 start/stop 된다', () => {
  assert.ok(/startCommitAutoRefresh\(\)/.test(APP_SRC), 'startCommitAutoRefresh 배선');
  assert.ok(/stopCommitAutoRefresh\(\)/.test(APP_SRC), 'stopCommitAutoRefresh 배선');
  assert.ok(/shouldPollCommit\(store\.state\.view,\s*visible\)/.test(APP_SRC),
    'syncHomePolling 이 shouldPollCommit 으로 게이트해야 한다');
  // teardown 에서 커밋 타이머 정리(누수 방지).
  assert.ok(/teardown[\s\S]*?stopCommitAutoRefresh\(\)/.test(APP_SRC), 'teardown 에서 stopCommitAutoRefresh');
  // visibilitychange 에서 동기화.
  assert.ok(/visibilitychange[\s\S]*?syncHomePolling/.test(APP_SRC), 'visibilitychange 에서 syncHomePolling');
});

test('R-31 — 폴링 콜백이 refreshCommitActivity(완료 시 coalesce.release) 경유 + deferred 보류', () => {
  // maybeAutoRefreshCommit 본문 추출.
  const start = APP_SRC.indexOf('function maybeAutoRefreshCommit(');
  assert.ok(start >= 0, 'maybeAutoRefreshCommit 함수가 있어야 한다');
  const body = APP_SRC.slice(start, start + 600);
  assert.ok(/store\.state\.view !== 'home'/.test(body), '홈 뷰에서만');
  assert.ok(/store\.busyCommitActivity/.test(body), 'in-flight 재진입 방지');
  assert.ok(/RG\.deferred\(\)/.test(body), '조합/드래그/오버레이 중 보류(R-25/R-26 정합)');
  assert.ok(/refreshCommitActivity\(\)/.test(body), 'refreshCommitActivity 경유(완료 시 release)');
});
