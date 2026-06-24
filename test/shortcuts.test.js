'use strict';
/**
 * shortcuts.test.js — R-29 단축키 단일 출처(SHORTCUTS) + keydown 순수 매핑(matchShortcut)
 *   + R-28 검증: F5(새로고침) 신설, Ctrl+O/Ctrl+R 이관, 안내표·keydown 단일 출처 일치.
 * 대상: public/app.js (헤드리스 F-3 — 순수 로직만).
 */
const { test } = require('node:test');
const assert = require('node:assert');

const { SHORTCUTS, matchShortcut, isEditableTarget } = require('../public/app.js');

// ── SHORTCUTS 상수 구조 ──────────────────────────────────────────────────
test('R-29 — SHORTCUTS: 각 항목이 keys·action·label(한국어 설명)을 가진다', () => {
  assert.ok(Array.isArray(SHORTCUTS) && SHORTCUTS.length > 0, '비어있지 않은 배열');
  for (const sc of SHORTCUTS) {
    assert.strictEqual(typeof sc.keys, 'string');
    assert.ok(sc.keys.length > 0, 'keys 비어있지 않음');
    assert.strictEqual(typeof sc.action, 'string');
    assert.ok(sc.action.length > 0, 'action 비어있지 않음');
    assert.strictEqual(typeof sc.label, 'string');
    assert.ok(sc.label.length > 0, 'label(설명) 비어있지 않음');
  }
});

test('R-28/R-29 — SHORTCUTS: F5(새로고침) 신설 포함', () => {
  const f5 = SHORTCUTS.find((s) => s.keys === 'F5');
  assert.ok(f5, 'F5 항목이 있어야 한다');
  assert.strictEqual(f5.action, 'refresh');
  assert.strictEqual(f5.label, '새로고침');
});

test('R-29 — SHORTCUTS: 기존 단축키(Ctrl+O·Ctrl+R)도 단일 상수로 흡수', () => {
  const keys = SHORTCUTS.map((s) => s.keys);
  assert.ok(keys.includes('Ctrl+O'), '폴더 추가(Ctrl+O)');
  assert.ok(keys.includes('Ctrl+R'), '재스캔(Ctrl+R)');
});

test('R-29 — SHORTCUTS: 중복 키 없음(단일 출처 무결성)', () => {
  const keys = SHORTCUTS.map((s) => s.keys);
  assert.strictEqual(new Set(keys).size, keys.length, '키 중복 없음');
});

// ── matchShortcut(keydown → action) 순수 매핑 ────────────────────────────
test('R-28 — matchShortcut: F5(수식키 없음) → refresh', () => {
  assert.strictEqual(matchShortcut({ key: 'F5' }), 'refresh');
  assert.strictEqual(matchShortcut({ key: 'F5', ctrlKey: false }), 'refresh');
});

test('R-29 — matchShortcut: Ctrl+O → pickFolders, Ctrl+R → rescan (Cmd 동등)', () => {
  assert.strictEqual(matchShortcut({ key: 'o', ctrlKey: true }), 'pickFolders');
  assert.strictEqual(matchShortcut({ key: 'O', ctrlKey: true }), 'pickFolders');
  assert.strictEqual(matchShortcut({ key: 'r', ctrlKey: true }), 'rescan');
  assert.strictEqual(matchShortcut({ key: 'R', metaKey: true }), 'rescan'); // macOS Cmd
});

test('R-29 — matchShortcut: 수식키 없는 o/r 은 매칭 안 함(텍스트 입력 충돌 방지)', () => {
  assert.strictEqual(matchShortcut({ key: 'o' }), null);
  assert.strictEqual(matchShortcut({ key: 'r' }), null);
});

test('R-29 — matchShortcut: F5 + 수식키는 매칭 안 함', () => {
  assert.strictEqual(matchShortcut({ key: 'F5', ctrlKey: true }), null);
  assert.strictEqual(matchShortcut({ key: 'F5', shiftKey: true }), null);
});

test('R-29 — matchShortcut: 비정상 입력 graceful null', () => {
  assert.strictEqual(matchShortcut(null), null);
  assert.strictEqual(matchShortcut(undefined), null);
  assert.strictEqual(matchShortcut({}), null);
  assert.strictEqual(matchShortcut({ key: 123 }), null);
  assert.strictEqual(matchShortcut({ key: 'x', ctrlKey: true }), null);
});

// ── B-1: 편집 가능 요소 가드(isEditableTarget) ──────────────────────────
test('R-29 B-1 — isEditableTarget: input/textarea/select/contenteditable 는 true', () => {
  assert.strictEqual(isEditableTarget({ tagName: 'INPUT' }), true);
  assert.strictEqual(isEditableTarget({ tagName: 'textarea' }), true); // 대소문자 무관
  assert.strictEqual(isEditableTarget({ tagName: 'SELECT' }), true);
  assert.strictEqual(isEditableTarget({ tagName: 'DIV', isContentEditable: true }), true);
});

test('R-29 B-1 — isEditableTarget: 일반 요소·비정상 입력은 false', () => {
  assert.strictEqual(isEditableTarget({ tagName: 'BUTTON' }), false);
  assert.strictEqual(isEditableTarget({ tagName: 'DIV' }), false);
  assert.strictEqual(isEditableTarget({ tagName: 'DIV', isContentEditable: false }), false);
  assert.strictEqual(isEditableTarget(null), false);
  assert.strictEqual(isEditableTarget(undefined), false);
  assert.strictEqual(isEditableTarget('input'), false);
  assert.strictEqual(isEditableTarget({}), false);
});

// ── 단일 출처 정합: matchShortcut 가 매핑하는 action 은 SHORTCUTS 에 모두 존재 ──
test('R-29 — keydown 매핑 action 이 SHORTCUTS 안내표와 동일 출처', () => {
  const tableActions = new Set(SHORTCUTS.map((s) => s.action));
  // matchShortcut 가 낼 수 있는 action(Esc/close 는 전역 ESC 핸들러 소관이라 matchShortcut 비대상)
  const dispatched = ['refresh', 'pickFolders', 'rescan'];
  for (const a of dispatched) {
    assert.ok(tableActions.has(a), 'keydown action 이 안내표에도 있어야 함: ' + a);
  }
});
