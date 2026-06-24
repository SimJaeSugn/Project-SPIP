'use strict';
/**
 * patchRegion.test.js — M10 P3/P4 patchRegion + 폴링 무재시도 + 위젯 소유권(헤드리스 F-3).
 *   patchRegionPlan 순수 분기 + 정적 배선 검증(8 flush 지점·_destroyById/_mountById·2단 영역·위젯 소유).
 *   (jsdom 0-의존 정책 — 실 DOM 동작은 수동 스모크. 여기선 순수 분기 + 소스 계약을 강제.)
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { patchRegionPlan } = require('../public/app.js');
const APP_SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

// ── [M10-PG-1] patchRegionPlan 순수 분기 ──
test('M10-PG-1 — deferred=true → defer(보류, coalesce.request)', () => {
  assert.strictEqual(patchRegionPlan(true, true), 'defer');
  assert.strictEqual(patchRegionPlan(false, true), 'defer'); // deferred 우선
});

test('M10-PG-1 — deferred=false + container 부재 → fallback(전체 render)', () => {
  assert.strictEqual(patchRegionPlan(false, false), 'fallback');
});

test('M10-PG-1 — deferred=false + container 존재 → patch(영역 교체)', () => {
  assert.strictEqual(patchRegionPlan(true, false), 'patch');
});

// ── 정적: patchRegion 5단계 계약 구조 ──
function patchRegionBody() {
  const start = APP_SRC.indexOf('patchRegion(containerEl, builderFn, opts)');
  assert.ok(start >= 0, 'patchRegion 메서드가 있어야 한다');
  return APP_SRC.slice(start, start + 2100);
}

test('M10-P3 — patchRegion: deferred 보류·fallback·5단계 순서', () => {
  const b = patchRegionBody();
  // [M11] isDeferred = bypassDefer ? false : deferred() — patchRegionPlan(present, isDeferred).
  assert.ok(/patchRegionPlan\(present,\s*isDeferred\)/.test(b), '순수 분기 사용');
  assert.ok(/bypassDefer\s*\?\s*false\s*:\s*deferred\(\)/.test(b), 'bypassDefer 분기');
  assert.ok(/coalesce\.request\(\)/.test(b), 'defer 시 coalesce.request');
  assert.ok(/fallback\(\)/.test(b), 'fallback 호출');
  // 순서: _destroyById(②) → capture(③) → replaceChildren(④) → restore(⑤) → _mountById(⑤)
  const iDestroy = b.indexOf('_destroyById');
  const iCapture = b.indexOf('preserve.capture');
  const iReplace = b.indexOf('replaceChildren');
  const iRestore = b.indexOf('preserve.restore');
  const iMount = b.indexOf('_mountById');
  assert.ok(iDestroy > 0 && iCapture > iDestroy && iReplace > iCapture && iRestore > iReplace && iMount > iRestore,
    'destroy → capture → replace → restore → mount 순서');
  assert.ok(/catch[\s\S]{0,120}fallback\(\)/.test(b), 'builderFn 예외 → fallback');
});

test('M10-WG-1 — RG.widget _destroyById/_mountById 내부 메서드 존재', () => {
  assert.ok(/_destroyById\(id\)\s*\{/.test(APP_SRC), '_destroyById 정의');
  assert.ok(/_mountById\(id,\s*rootEl\)\s*\{/.test(APP_SRC), '_mountById 정의');
  // _mountById: 이미 살아있으면 skip.
  const start = APP_SRC.indexOf('_mountById(id, rootEl)');
  const b = APP_SRC.slice(start, start + 300);
  assert.ok(/_instances\[id\] != null\) return/.test(b), '이미 살아있으면 skip(중복 방지)');
});

// ── 정적: P4 위젯 소유권 단일화(2단 영역, builder 는 빈 호스트만) ──
test('M10-P4/F-2 — renderHomeProductivity 가 .commit-chart-region > .commit-chart-host 2단 구조', () => {
  assert.ok(/cls:\s*'commit-chart-region'/.test(APP_SRC), 'commit-chart-region 래퍼');
  const i = APP_SRC.indexOf("cls: 'commit-chart-region'");
  const b = APP_SRC.slice(i, i + 300);
  assert.ok(/commit-chart-host/.test(b), 'region 안에 host');
});

test('M10-P4/F-2 — patchCommitChart builderFn 은 빈 호스트만(차트 노드 미생성), 위젯 소유', () => {
  const start = APP_SRC.indexOf('function patchCommitChart(');
  assert.ok(start >= 0, 'patchCommitChart 함수');
  const b = APP_SRC.slice(start, start + 700);
  assert.ok(/cls:\s*'commit-chart-host'/.test(b), '빈 호스트 컨테이너만 반환');
  assert.ok(!/chartBars\(/.test(b), 'builderFn 은 차트 노드(chartBars) 만들지 않음(위젯 소유)');
  assert.ok(/widgets:\s*\['commitChart'\]/.test(b), "widgets:['commitChart'] 로 위젯이 노드 단독 소유");
  assert.ok(/preserveFocus:\s*false/.test(b), '차트 영역 포커스 입력 없음 → false');
  assert.ok(/fallback/.test(b), 'fallback=render 안전망');
});

test('M10-P4 — commitChart 위젯 init 이 전달받은 root 스코프 사용(전역 querySelector 의존 제거)', () => {
  const start = APP_SRC.indexOf("id: 'commitChart'");
  const b = APP_SRC.slice(start, start + 600);
  assert.ok(/init:\s*\(root\)\s*=>/.test(b), 'init(root) 시그니처');
  assert.ok(/root\s*\|\|\s*document/.test(b), 'root 우선, 없으면 document fallback');
});

// ── 정적: 폴링 무재시도 8지점 + silent 분기 ──
test('M10-P1 — refreshCommitActivity({silent}) 분기(폴링은 진입 render 생략)', () => {
  const start = APP_SRC.indexOf('async function refreshCommitActivity(opts)');
  assert.ok(start >= 0, 'refreshCommitActivity(opts) 시그니처');
  const b = APP_SRC.slice(start, start + 1100);
  assert.ok(/!opts\.silent\s*&&\s*store\.state\.view === 'home'\)\s*render\(\)/.test(b),
    'silent 면 진입 로딩 render 생략');
  assert.ok(/onCommitActivityFetched\(\)/.test(b), '완료부 diff 가드 경유');
});

test('M10-P1 — maybeAutoRefreshCommit deferred 시 _pendingCommitRefresh=true, 폴링은 silent', () => {
  const start = APP_SRC.indexOf('function maybeAutoRefreshCommit()');
  const b = APP_SRC.slice(start, start + 500);
  assert.ok(/_pendingCommitRefresh\s*=\s*true/.test(b), 'deferred 시 플래그 설정');
  assert.ok(/refreshCommitActivity\(\{\s*silent:\s*true\s*\}\)/.test(b), '폴링은 silent');
});

test('M10-P1 — maybeFlushCommitRefresh: pending 가드 + 재진입 가드(이중 발화 방지)', () => {
  const start = APP_SRC.indexOf('function maybeFlushCommitRefresh()');
  assert.ok(start >= 0, 'maybeFlushCommitRefresh 함수');
  const b = APP_SRC.slice(start, start + 500);
  assert.ok(/if \(!_pendingCommitRefresh\) return/.test(b), 'pending 없으면 즉시 반환(이중 발화 방지)');
  assert.ok(/store\.busyCommitActivity \|\| RG\.deferred\(\)\) return/.test(b), 'busy/deferred 재진입 가드');
  assert.ok(/refreshCommitActivity\(\{\s*silent:\s*true\s*\}\)/.test(b), 'silent 재시도');
});

test('M10-P1/F-3d — maybeFlushCommitRefresh 가 보류 해제 8지점에 동반 호출', () => {
  const calls = (APP_SRC.match(/maybeFlushCommitRefresh\(\)/g) || []).length;
  // 정의 호출부 제외: 정의 1 + 호출 8 = 최소 9회 등장(8지점 + 함수 정의 내부 0). 안전하게 >=8 호출 확인.
  // release/flushIfPending 옆 동반: addTodo·mail·closeSettings·closeDrawer·closeHelp·card onEnd·home onEnd·compositionend.
  assert.ok(calls >= 8, 'maybeFlushCommitRefresh 호출 8지점 이상(실제=' + calls + ')');
});

test('M10 — lib/common/renderGuard.js 불변(patchRegion 미추가)', () => {
  const RG_SRC = fs.readFileSync(path.join(__dirname, '..', 'lib', 'common', 'renderGuard.js'), 'utf8');
  assert.ok(!/patchRegion/.test(RG_SRC), 'renderGuard.js 에 patchRegion 없음(DOM 미접근 원칙)');
  assert.ok(/shouldDeferRender/.test(RG_SRC) && /createCoalescer/.test(RG_SRC), '기존 순수 export 불변');
});
