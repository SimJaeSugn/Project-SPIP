'use strict';
/**
 * dashboardState.test.js — [대시보드 자유도 로드맵 · Phase 0]
 *   통합 대시보드 상태 모델(프리셋) 정규화 + 레거시 무손실 이행의 단일 신뢰 경계 검증.
 *   순수 계층(영속 미연결)이라 fs 없이 헤드리스 검증한다. layout/hidden/sizes 는 기존 정규화 재사용.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const S = require('../lib/common/uiStateStore');

// ── 기본/부재/손상 → graceful 기본 상태 ─────────────────────────────────────
test('Phase0 — normalizeDashboardState: 부재/손상은 기본(프리셋 1개 default)', () => {
  for (const bad of [null, undefined, 42, 'x', [], {}, { presets: 'nope' }, { presets: {} }]) {
    const d = S.normalizeDashboardState(bad);
    assert.strictEqual(d.schemaVersion, S.DASHBOARD_SCHEMA_VERSION);
    assert.strictEqual(d.presets.length, 1);
    assert.strictEqual(d.presets[0].id, S.DEFAULT_PRESET_ID);
    assert.strictEqual(d.activePreset, S.DEFAULT_PRESET_ID);
    assert.strictEqual(d.presets[0].layoutMode, 'masonry');
    assert.deepStrictEqual(d.presets[0].positions, {});
    assert.deepStrictEqual(d.presets[0].groups, []);
    // 기본 프리셋은 현행 기본 배치(전 섹션 순서) + 셸프 기본 숨김.
    assert.deepStrictEqual(d.presets[0].layout, S.HOME_SECTION_IDS);
    assert.deepStrictEqual(d.presets[0].hidden, S.SHELF_WIDGET_IDS);
  }
});

// ── 레거시 → 대시보드 무손실 이행 ───────────────────────────────────────────
test('Phase0 — migrateLegacyToDashboard: 기존 배치·숨김·크기를 기본 프리셋으로 승격(무손실)', () => {
  const legacy = {
    homeLayout: ['mail', 'attention', 'todos'], // 부분 순서 → 나머지 기본 순서로 보충됨
    hiddenWidgets: ['disk'],
    homeWidgetSizes: { mail: { w: 3, h: 250 }, bogus: { w: 2, h: 200 } },
  };
  const d = S.migrateLegacyToDashboard(legacy);
  assert.strictEqual(d.presets.length, 1);
  const p = d.presets[0];
  assert.strictEqual(p.id, 'default');
  assert.strictEqual(d.activePreset, 'default');
  // layout: normalizeHomeLayout 재사용 → 앞 3개 유지 + 나머지 보충(10섹션).
  assert.deepStrictEqual(p.layout.slice(0, 3), ['mail', 'attention', 'todos']);
  assert.strictEqual(p.layout.length, S.HOME_SECTION_IDS.length);
  assert.deepStrictEqual(p.hidden, ['disk']);
  // sizes: 화이트리스트 밖 bogus 제거, 유효 항목 클램프 유지.
  assert.deepStrictEqual(p.sizes, { mail: { w: 3, h: 250 } });
});

test('Phase0 — 이행 결과는 정규화에 대해 안정(idempotent stable)', () => {
  const legacy = { homeLayout: ['todos', 'mail'], hiddenWidgets: ['shelf', 'shelfWide'], homeWidgetSizes: { todos: { w: 2, h: 300 } } };
  const once = S.migrateLegacyToDashboard(legacy);
  const twice = S.normalizeDashboardState(once);
  assert.deepStrictEqual(twice, once, '정규화 재적용해도 동일(안정)');
});

// ── 화이트리스트·클램프 (프리셋 필드) ───────────────────────────────────────
test('Phase0 — normalizePreset: 미지 위젯/모드/좌표 방어', () => {
  const d = S.normalizeDashboardState({
    activePreset: 'a',
    presets: [{
      id: 'a', name: '  집중  ', layoutMode: 'chaos', // 잘못된 모드 → masonry
      layout: ['mail', 'bogus', 'mail'],               // 미지·중복 제거 + 보충
      hidden: ['featureAdd', 'disk'],                  // featureAdd 는 숨김 불가 → 제거
      sizes: { mail: { w: 99, h: 99999 } },            // 클램프
      positions: { mail: { x: -5, y: 9999 }, featureAdd: { x: 1, y: 1 }, bogus: { x: 1, y: 1 } },
    }],
  });
  const p = d.presets[0];
  assert.strictEqual(p.name, '집중');           // trim
  assert.strictEqual(p.layoutMode, 'masonry');  // 잘못된 모드 폴백
  assert.ok(!p.layout.includes('bogus'));
  assert.deepStrictEqual(p.hidden, ['disk']);   // featureAdd 제거
  assert.deepStrictEqual(p.sizes.mail, { w: S.HOME_MAX_COLS, h: S.HOME_H_MAX }); // 클램프: w→4, h→1600
  // positions: featureAdd·bogus 제거, mail 은 [0,MAX_POS] 클램프.
  assert.deepStrictEqual(Object.keys(p.positions), ['mail']);
  assert.strictEqual(p.positions.mail.x, 0);
  assert.strictEqual(p.positions.mail.y, 200);
});

// ── activePreset 폴백 · id 중복 · 개수 상한 ─────────────────────────────────
test('Phase0 — activePreset dangling 이면 첫 프리셋으로 폴백', () => {
  const d = S.normalizeDashboardState({ activePreset: 'ghost', presets: [{ id: 'first' }, { id: 'second' }] });
  assert.strictEqual(d.activePreset, 'first');
  assert.strictEqual(d.presets.length, 2);
});

test('Phase0 — 프리셋 id 중복은 첫 항목만 유지', () => {
  const d = S.normalizeDashboardState({ activePreset: 'dup', presets: [{ id: 'dup', name: 'A' }, { id: 'dup', name: 'B' }] });
  assert.strictEqual(d.presets.length, 1);
  assert.strictEqual(d.presets[0].name, 'A');
});

test('Phase0 — 프리셋 개수 MAX_PRESETS 상한', () => {
  const many = [];
  for (let i = 0; i < S.MAX_PRESETS + 8; i++) many.push({ id: 'p' + i.toString(36) });
  const d = S.normalizeDashboardState({ presets: many });
  assert.strictEqual(d.presets.length, S.MAX_PRESETS);
});

test('Phase0 — 손상 id 는 fallback 슬러그로 대체(유효 프리셋 유지)', () => {
  const d = S.normalizeDashboardState({ presets: [{ id: 'BAD ID!', name: '모드' }] });
  assert.strictEqual(d.presets.length, 1);
  assert.ok(S.PRESET_ID_RE.test(d.presets[0].id), '대체 id 는 슬러그 형식');
});

test('Phase0 — layoutMode freeform 은 허용(화이트리스트)', () => {
  const d = S.normalizeDashboardState({ presets: [{ id: 'ff', layoutMode: 'freeform' }] });
  assert.strictEqual(d.presets[0].layoutMode, 'freeform');
});
