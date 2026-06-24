'use strict';
/**
 * homeLayout-front.test.js — R-32 프런트엔드(홈 섹션 드래그·데이터-주도 배치, 헤드리스 F-3).
 *   applyHomeLayout(순수 순서 정규화) + HOME_SECTION_IDS(메인 계약 동형) + 정적 배선 검증.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { HOME_SECTION_IDS, applyHomeLayout } = require('../public/app.js');
const APP_SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
// 메인 계약(단일 신뢰 경계)과 동형인지 교차 확인.
const STORE_SRC = fs.readFileSync(path.join(__dirname, '..', 'lib', 'common', 'uiStateStore.js'), 'utf8');

// ── HOME_SECTION_IDS 계약 동형 ────────────────────────────────────────────
test('R-32 — HOME_SECTION_IDS: 8섹션 enum(배열 순서 = 기본 순서)', () => {
  assert.deepStrictEqual(HOME_SECTION_IDS,
    ['attention', 'productivity', 'activity', 'todos', 'mail', 'disk', 'aiusage', 'featureAdd']);
});

test('R-32 — 렌더러 HOME_SECTION_IDS 가 메인 uiStateStore 와 동일 집합·순서', () => {
  const m = STORE_SRC.match(/HOME_SECTION_IDS\s*=\s*\[([^\]]*)\]/);
  assert.ok(m, '메인에 HOME_SECTION_IDS 정의가 있어야 한다');
  const mainIds = (m[1].match(/'([a-zA-Z]+)'/g) || []).map((s) => s.replace(/'/g, ''));
  assert.deepStrictEqual(mainIds, HOME_SECTION_IDS, '렌더러·메인 동형(드리프트 0)');
});

// ── applyHomeLayout (순서 정규화, 메인 normalizeHomeLayout 과 동일 규칙) ──
test('R-32 — applyHomeLayout: 유효 순열은 그대로 유지', () => {
  const input = ['mail', 'attention', 'disk', 'todos', 'activity', 'productivity', 'aiusage', 'featureAdd'];
  assert.deepStrictEqual(applyHomeLayout(input), input);
});

test('R-32 — applyHomeLayout: 부분 순서는 나머지를 기본 순서로 끝에 보충(항상 8개)', () => {
  const out = applyHomeLayout(['mail', 'todos']);
  assert.strictEqual(out.length, 8);
  assert.deepStrictEqual(out.slice(0, 2), ['mail', 'todos']);
  // 나머지는 기본 순서 유지(중복 없이).
  assert.deepStrictEqual(out, ['mail', 'todos', 'attention', 'productivity', 'activity', 'disk', 'aiusage', 'featureAdd']);
});

test('R-32 — applyHomeLayout: 화이트리스트 외·중복·비문자열 제거', () => {
  const out = applyHomeLayout(['mail', 'mail', 'bogus', 123, null, 'attention']);
  assert.deepStrictEqual(out.slice(0, 2), ['mail', 'attention']);
  assert.strictEqual(out.length, 8);
  assert.strictEqual(new Set(out).size, 8, '중복 없음');
  for (const id of out) assert.ok(HOME_SECTION_IDS.includes(id), '화이트리스트 내: ' + id);
});

test('R-32 — applyHomeLayout: 부재/비배열/빈 → 기본 순서(graceful)', () => {
  assert.deepStrictEqual(applyHomeLayout(null), HOME_SECTION_IDS);
  assert.deepStrictEqual(applyHomeLayout(undefined), HOME_SECTION_IDS);
  assert.deepStrictEqual(applyHomeLayout('x'), HOME_SECTION_IDS);
  assert.deepStrictEqual(applyHomeLayout([]), HOME_SECTION_IDS);
});

// ── 정적 배선 검증 ────────────────────────────────────────────────────────
test('R-32 — renderHomeSection 이 모든 enum 섹션을 case 로 처리(누락 0)', () => {
  const start = APP_SRC.indexOf('function renderHomeSection(');
  assert.ok(start >= 0, 'renderHomeSection 함수가 있어야 한다');
  const body = APP_SRC.slice(start, start + 700);
  const caseIds = new Set((body.match(/case\s+'([a-zA-Z]+)'/g) || []).map((s) => s.replace(/case\s+'|'/g, '')));
  for (const id of HOME_SECTION_IDS) assert.ok(caseIds.has(id), 'renderHomeSection 누락 섹션: ' + id);
});

test('R-32 — renderHome 이 homeLayout 순서로 데이터-주도 배치(masonry)', () => {
  assert.ok(/applyHomeLayout\(store\.homeLayout\)\.forEach/.test(APP_SRC),
    'renderHome 이 applyHomeLayout(store.homeLayout) 순회로 섹션 배치');
  assert.ok(/'data-home-section'\s*:\s*id/.test(APP_SRC), 'data-home-section 에 enum id(고정) 부여');
  assert.ok(/cls:\s*'home-masonry'/.test(APP_SRC), 'home-masonry 컨테이너(CSS columns)');
});

test('R-32 — loadUiState 가 res.homeLayout 적재(getUiState 응답 소비)', () => {
  assert.ok(/store\.homeLayout\s*=\s*applyHomeLayout\(res[\s\S]{0,40}homeLayout/.test(APP_SRC),
    'loadUiState 에서 res.homeLayout 을 applyHomeLayout 으로 적재');
});

test('R-32 — homeSortable: RG.widget 등록 + onEnd 마이크로태스크 패턴(R4) + setHomeLayout 영속', () => {
  // RG.widget 등록.
  assert.ok(/id:\s*'homeSections'/.test(APP_SRC), "RG.widget.define({id:'homeSections'})");
  // onEnd: _dragging=false 즉시 + 마이크로태스크 지연 + commitHomeLayout.
  const start = APP_SRC.indexOf('function initHomeSortable(');
  assert.ok(start >= 0, 'initHomeSortable 함수가 있어야 한다');
  const body = APP_SRC.slice(start, start + 2200);
  assert.ok(/store\._dragging\s*=\s*true/.test(body), 'onStart 에서 _dragging=true(R-25 보류)');
  assert.ok(/store\._dragging\s*=\s*false/.test(body), 'onEnd 에서 _dragging=false 즉시');
  assert.ok(/Promise\.resolve\(\)\.then/.test(body), 'commit 은 마이크로태스크로 지연(R4)');
  assert.ok(/data-home-section/.test(body), 'DOM 의 data-home-section enum 순서를 읽어 영속');
  assert.ok(/commitHomeLayout\(ids\)/.test(body), '재정렬 시 commitHomeLayout 호출');
  // commitHomeLayout: setHomeLayout IPC → 응답 정규화 반영.
  const cs = APP_SRC.indexOf('function commitHomeLayout(');
  assert.ok(cs >= 0, 'commitHomeLayout 함수가 있어야 한다');
  const cbody = APP_SRC.slice(cs, cs + 700);
  assert.ok(/ipc\('setHomeLayout',\s*next\)/.test(cbody), "setHomeLayout IPC 호출(정규화된 next)");
  assert.ok(/applyHomeLayout\(res\.homeLayout\)/.test(cbody), '응답 homeLayout 을 최종 순서로 확정');
});
