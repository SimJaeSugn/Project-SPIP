'use strict';
/**
 * m11-patchregion.test.js — M11 patchRegion 확장(메일 섹션·설정 우측 패널, 헤드리스 F-3).
 *   mailSummaryKey 순수(diff 가드) + patchRegion bypassDefer 분기 + 정적 배선(2단 영역·silent·탭 전환).
 *   (jsdom 0-의존 — 실 DOM 동작은 수동 스모크. 순수 분기 + 소스 계약 강제.)
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { mailSummaryKey, patchRegionPlan } = require('../public/app.js');
const APP_SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

// ── mailSummaryKey (diff 가드) ──
test('M11 — mailSummaryKey: 동일 요약 → 동일 키', () => {
  const a = [{ id: 'abc', unseen: 2, items: [{ uid: 10, date: '2026-06-24T01:00:00Z' }] }];
  const b = [{ id: 'abc', unseen: 2, items: [{ uid: 10, date: '2026-06-24T01:00:00Z' }] }];
  assert.strictEqual(mailSummaryKey(a), mailSummaryKey(b));
});

test('M11 — mailSummaryKey: unseen 변경 → 다른 키(읽음/도착 반영)', () => {
  const a = [{ id: 'abc', unseen: 2, items: [] }];
  const b = [{ id: 'abc', unseen: 3, items: [] }];
  assert.notStrictEqual(mailSummaryKey(a), mailSummaryKey(b));
});

test('M11 — mailSummaryKey: 새 메일(uid) 추가 → 다른 키', () => {
  const a = [{ id: 'abc', unseen: 1, items: [{ uid: 10, date: '2026-06-24' }] }];
  const b = [{ id: 'abc', unseen: 1, items: [{ uid: 11, date: '2026-06-24' }, { uid: 10, date: '2026-06-24' }] }];
  assert.notStrictEqual(mailSummaryKey(a), mailSummaryKey(b));
});

test('M11 — mailSummaryKey: 제목·발신자 문자열은 키에 미진입(L-1/M-2)', () => {
  const a = [{ id: 'abc', unseen: 1, items: [{ uid: 10, date: '2026-06-24', subject: '<script>', from: 'x@y' }] }];
  const k = mailSummaryKey(a);
  assert.ok(!/script|x@y/.test(k), '신뢰불가 문자열 미포함: ' + k);
  assert.ok(/^[a-f0-9]*#[0-9]+#[0-9:,]*$/.test(k), 'id(hex)#정수#uid:ms 형식: ' + k);
});

test('M11 — mailSummaryKey: 비배열/빈 → 빈 문자열, NaN unseen → 0', () => {
  assert.strictEqual(mailSummaryKey(null), '');
  assert.strictEqual(mailSummaryKey([]), '');
  const k = mailSummaryKey([{ id: 'ab', unseen: NaN, items: [] }]);
  assert.ok(/#0#/.test(k), 'NaN unseen → 0: ' + k);
});

// ── patchRegion bypassDefer 분기(설정 탭 전환용) ──
test('M11 — patchRegionPlan: bypassDefer 시 deferred 무시(사용자 액션은 patch)', () => {
  // bypassDefer 는 호출측이 isDeferred=false 로 전달 → plan='patch'(container 있으면).
  assert.strictEqual(patchRegionPlan(true, false), 'patch');
  // 일반 배경 갱신은 deferred=true → defer(보류).
  assert.strictEqual(patchRegionPlan(true, true), 'defer');
});

test('M11 — patchRegion 에 bypassDefer 옵션 존재(오버레이 내 사용자 액션 우회)', () => {
  assert.ok(/opts\.bypassDefer\s*\?\s*false\s*:\s*deferred\(\)/.test(APP_SRC),
    'bypassDefer=true 면 deferred 무시');
});

// ── 메일 섹션 2단 구조 + silent + diff 가드 배선 ──
test('M11 — renderHomeMail 이 .mail-region(2단) 반환, 카드 본문은 renderHomeMailCard', () => {
  assert.ok(/cls:\s*'mail-region'/.test(APP_SRC), 'mail-region 래퍼');
  assert.ok(/function renderHomeMailCard\(/.test(APP_SRC), 'renderHomeMailCard 분리');
});

test('M11 — refreshMailSummary({silent}) 분기 + onMailSummaryFetched 완료부', () => {
  const start = APP_SRC.indexOf('async function refreshMailSummary(opts)');
  assert.ok(start >= 0, 'refreshMailSummary(opts) 시그니처');
  const b = APP_SRC.slice(start, start + 900);
  assert.ok(/!opts\.silent\s*&&\s*store\.state\.view === 'home'\)\s*render\(\)/.test(b), 'silent 면 진입 render 생략');
  assert.ok(/onMailSummaryFetched\(\)/.test(b), '완료부 diff 가드 경유');
});

test('M11 — maybeAutoRefreshMail(폴링/push)은 silent', () => {
  const start = APP_SRC.indexOf('function maybeAutoRefreshMail()');
  const b = APP_SRC.slice(start, start + 400);
  assert.ok(/refreshMailSummary\(\{\s*silent:\s*true\s*\}\)/.test(b), '폴링은 silent');
});

test('M11/백로그2-2 — onMailSummaryFetched: 무변경 skip, 변경 시 이벤트 버스 브로드캐스트', () => {
  const start = APP_SRC.indexOf('function onMailSummaryFetched()');
  assert.ok(start >= 0, 'onMailSummaryFetched 함수');
  const b = APP_SRC.slice(start, start + 400);
  assert.ok(/mailSummaryKey\(store\.mailSummary\)/.test(b), 'diff 키 비교');
  assert.ok(/=== _lastMailSummaryKey/.test(b), '직전 키와 비교');
  assert.ok(/EV\.emit\('mail:changed'/.test(b), '변경 시 위젯 이벤트 버스로 브로드캐스트');
  // 구독자(위젯 상호작용)가 메일 영역/브리핑을 갱신한다.
  assert.ok(/EV\.on\('mail:changed'/.test(APP_SRC), 'mail:changed 구독자 존재');
  const onIdx = APP_SRC.indexOf("EV.on('mail:changed'");
  const ob = APP_SRC.slice(onIdx, onIdx + 300);
  assert.ok(/patchMailSection\(\)/.test(ob), '구독자가 메일 영역 갱신');
});

test('M11 — patchMailSection: .mail-region 교체, builderFn=renderHomeMailCard, fallback=render', () => {
  const start = APP_SRC.indexOf('function patchMailSection()');
  assert.ok(start >= 0, 'patchMailSection 함수');
  const b = APP_SRC.slice(start, start + 600);
  assert.ok(/querySelector\('\.mail-region'\)/.test(b), '.mail-region 대상');
  assert.ok(/renderHomeMailCard\(\)/.test(b), 'builderFn 이 카드 본문 재빌드');
  assert.ok(/fallback/.test(b), 'fallback 안전망');
});

// ── 설정 우측 패널 탭 전환 배선 ──
test('M11 — 설정 nav 클릭이 switchSettingsTab 경유(전체 render 아님)', () => {
  assert.ok(/on:\s*\{\s*click:\s*\(\)\s*=>\s*\{\s*switchSettingsTab\(cat\.id\)/.test(APP_SRC),
    'nav 클릭 → switchSettingsTab');
  assert.ok(/'data-settings-tab':\s*cat\.id/.test(APP_SRC), 'nav 버튼에 data-settings-tab(class 토글용)');
});

test('M11 — switchSettingsTab: 우측 .settings-pane patchRegion + bypassDefer + 좌측 class 토글', () => {
  const start = APP_SRC.indexOf('function switchSettingsTab(');
  assert.ok(start >= 0, 'switchSettingsTab 함수');
  const b = APP_SRC.slice(start, start + 1300);
  assert.ok(/querySelector\('\.settings-pane'\)/.test(b), '.settings-pane 대상');
  assert.ok(/bypassDefer:\s*true/.test(b), '오버레이 내 사용자 액션 — deferred 우회');
  assert.ok(/preserveFocus:\s*true/.test(b), '입력 포커스/스크롤 보존');
  assert.ok(/classList\.toggle\('is-active'/.test(b), '좌측 nav 활성 표시 class 토글');
  assert.ok(/fallback/.test(b), 'fallback=render 안전망');
  assert.ok(/store\.settingsTab\s*=\s*next/.test(b), 'settingsTab 갱신');
});

test('M11 — buildSettingsPaneInto 가 renderSettings·switchSettingsTab 공용', () => {
  assert.ok(/function buildSettingsPaneInto\(pane,\s*tabId\)/.test(APP_SRC), 'buildSettingsPaneInto 헬퍼');
  const calls = (APP_SRC.match(/buildSettingsPaneInto\(/g) || []).length;
  assert.ok(calls >= 2, 'renderSettings + switchSettingsTab 공용(호출 ' + calls + ')');
});

test('M11 — renderGuard.js 불변(patchRegion 미추가)', () => {
  const RG = fs.readFileSync(path.join(__dirname, '..', 'lib', 'common', 'renderGuard.js'), 'utf8');
  assert.ok(!/patchRegion|mailSummaryKey/.test(RG), 'renderGuard.js 불변');
});
