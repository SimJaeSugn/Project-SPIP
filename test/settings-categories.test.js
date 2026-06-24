'use strict';
/**
 * settings-categories.test.js — R-30 설정 2-pane 카테고리 구조(헤드리스 F-3).
 *   SETTINGS_CATEGORIES 단일 출처(5분류·섹션 유일 소속)·resolveSettingsTab(기본/정규화).
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { SETTINGS_CATEGORIES, resolveSettingsTab } = require('../public/app.js');
const APP_SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

// ── 카테고리 구조 ────────────────────────────────────────────────────────
test('R-30 — 5개 카테고리(스캔/연동/외관/단축키/정보)가 순서대로 존재', () => {
  assert.ok(Array.isArray(SETTINGS_CATEGORIES));
  assert.deepStrictEqual(SETTINGS_CATEGORIES.map((c) => c.id),
    ['scan', 'integration', 'appearance', 'shortcuts', 'info']);
  assert.deepStrictEqual(SETTINGS_CATEGORIES.map((c) => c.label),
    ['스캔', '연동', '외관', '단축키', '정보']);
});

test('R-30 — 각 카테고리는 id·label·sections(비어있지 않은 배열)를 가진다', () => {
  for (const c of SETTINGS_CATEGORIES) {
    assert.strictEqual(typeof c.id, 'string');
    assert.strictEqual(typeof c.label, 'string');
    assert.ok(Array.isArray(c.sections) && c.sections.length > 0, c.id + ' sections 비어있지 않음');
  }
});

test('R-30 — 설계 §8 매핑표대로 섹션 배치', () => {
  const byId = Object.fromEntries(SETTINGS_CATEGORIES.map((c) => [c.id, c.sections]));
  assert.deepStrictEqual(byId.scan, ['roots', 'exclude', 'detect', 'scanOptions']);
  assert.deepStrictEqual(byId.integration, ['tools', 'mail']);
  assert.deepStrictEqual(byId.appearance, ['theme']);
  assert.deepStrictEqual(byId.shortcuts, ['shortcuts']);
  assert.deepStrictEqual(byId.info, ['info', 'update']);
});

test('R-30 — 각 섹션은 정확히 하나의 카테고리에만 속한다(중복 배치 0)', () => {
  const seen = new Map();
  for (const c of SETTINGS_CATEGORIES) {
    for (const s of c.sections) {
      assert.ok(!seen.has(s), '섹션 중복 배치: ' + s + ' (' + seen.get(s) + ' & ' + c.id + ')');
      seen.set(s, c.id);
    }
  }
  // 기존 8섹션 + 신설(단축키·정보) = 10개 섹션 모두 배치됐는지(누락 0).
  const all = ['roots', 'exclude', 'detect', 'scanOptions', 'tools', 'mail', 'theme', 'shortcuts', 'info', 'update'];
  assert.deepStrictEqual([...seen.keys()].sort(), all.slice().sort());
});

test('R-30 — 카테고리 id 중복 없음(단일 출처 무결성)', () => {
  const ids = SETTINGS_CATEGORIES.map((c) => c.id);
  assert.strictEqual(new Set(ids).size, ids.length);
});

// ── resolveSettingsTab (활성 탭 정규화) ──────────────────────────────────
test('R-30 — resolveSettingsTab: 기본값은 첫 카테고리(scan)', () => {
  assert.strictEqual(resolveSettingsTab(undefined), 'scan');
  assert.strictEqual(resolveSettingsTab(null), 'scan');
  assert.strictEqual(resolveSettingsTab(''), 'scan');
  assert.strictEqual(resolveSettingsTab('bogus'), 'scan');
});

test('R-30 — resolveSettingsTab: 유효 카테고리는 그대로 유지(재렌더 후 복원)', () => {
  for (const c of SETTINGS_CATEGORIES) {
    assert.strictEqual(resolveSettingsTab(c.id), c.id);
  }
});

// ── 디스패치–데이터 키 일치(개선 ①): 데이터에 키 추가 후 buildSettingsSection case 누락 방지 ──
test('R-30 — SETTINGS_CATEGORIES 모든 섹션 키가 buildSettingsSection case 로 처리된다', () => {
  // buildSettingsSection 본문에서 case 'key': 형태의 키를 정적 추출.
  const start = APP_SRC.indexOf('function buildSettingsSection(');
  assert.ok(start >= 0, 'buildSettingsSection 함수가 있어야 한다');
  const end = APP_SRC.indexOf('function renderSettings(', start);
  const body = APP_SRC.slice(start, end > start ? end : start + 2000);
  const caseKeys = new Set();
  const re = /case\s+'([A-Za-z0-9_]+)'/g;
  let m;
  while ((m = re.exec(body)) !== null) caseKeys.add(m[1]);

  // 데이터의 모든 섹션 키가 case 에 존재해야 한다(누락 시 우측 패널이 빈다).
  const dataKeys = new Set();
  for (const c of SETTINGS_CATEGORIES) for (const k of c.sections) dataKeys.add(k);
  for (const k of dataKeys) {
    assert.ok(caseKeys.has(k), 'buildSettingsSection 에 누락된 섹션 case: ' + k);
  }
  // 역방향: case 에만 있고 데이터에 없는 키(고아 case)도 없어야 한다(불일치 0).
  for (const k of caseKeys) {
    assert.ok(dataKeys.has(k), 'SETTINGS_CATEGORIES 에 없는 고아 case: ' + k);
  }
});
