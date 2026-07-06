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

// ── [Phase 2 기반] 프리셋 CRUD (순수·결정적) ────────────────────────────────
test('Phase2 — presetAdd: 기본 배치 프리셋 추가 + 활성 지정 + 결정적 id', () => {
  const base = S.defaultDashboardState();
  const r = S.presetAdd(base, '  집중 모드  ');
  assert.strictEqual(r.state.presets.length, 2);
  assert.strictEqual(r.id, 'p1');                 // default 는 'default'라 첫 슬롯 p1
  assert.strictEqual(r.state.activePreset, 'p1');
  assert.strictEqual(r.state.presets[1].name, '집중 모드'); // trim
  assert.deepStrictEqual(r.state.presets[1].layout, S.HOME_SECTION_IDS);
  // 결정적: 같은 입력 → 같은 id
  assert.strictEqual(S.presetAdd(base, 'x').id, 'p1');
});

test('Phase2 — presetAdd: MAX_PRESETS 상한 초과 시 무변경(id=null)', () => {
  let s = S.defaultDashboardState();
  for (let i = 0; i < S.MAX_PRESETS - 1; i++) s = S.presetAdd(s, 'm' + i).state;
  assert.strictEqual(s.presets.length, S.MAX_PRESETS);
  const r = S.presetAdd(s, 'over');
  assert.strictEqual(r.id, null);
  assert.strictEqual(r.state.presets.length, S.MAX_PRESETS);
});

test('Phase2 — presetDuplicate: 내용 복사 + 새 id + 활성 지정 + 뒤에 삽입', () => {
  const base = S.migrateLegacyToDashboard({ homeLayout: ['mail', 'todos'], homeWidgetSizes: { mail: { w: 2, h: 240 } } });
  const r = S.presetDuplicate(base, 'default');
  assert.strictEqual(r.state.presets.length, 2);
  assert.strictEqual(r.state.presets[1].id, r.id);
  assert.strictEqual(r.state.activePreset, r.id);
  assert.deepStrictEqual(r.state.presets[1].sizes, { mail: { w: 2, h: 240 } }); // 내용 복사
  assert.ok(r.state.presets[1].name.endsWith('복사'));
});

test('Phase2 — presetRename', () => {
  const s = S.presetRename(S.defaultDashboardState(), 'default', '아침 브리핑');
  assert.strictEqual(s.presets[0].name, '아침 브리핑');
});

test('Phase2 — presetRemove: 마지막 프리셋은 삭제 불가, 활성 삭제 시 인접 이동', () => {
  // 마지막 1개 보존
  assert.strictEqual(S.presetRemove(S.defaultDashboardState(), 'default').presets.length, 1);
  // 3개 중 활성(가운데) 삭제 → 인접으로 이동
  let s = S.defaultDashboardState();
  s = S.presetAdd(s, 'A').state; // p1
  s = S.presetAdd(s, 'B').state; // p2, active p2
  s = S.presetSetActive(s, 'p1'); // active p1(가운데)
  const after = S.presetRemove(s, 'p1');
  assert.strictEqual(after.presets.length, 2);
  assert.ok(!after.presets.some((p) => p.id === 'p1'));
  assert.ok(after.presets.some((p) => p.id === after.activePreset), '활성은 실재 프리셋');
});

test('Phase2 — presetSetActive: 존재할 때만', () => {
  const base = S.presetAdd(S.defaultDashboardState(), 'A').state; // default, p1(active)
  assert.strictEqual(S.presetSetActive(base, 'default').activePreset, 'default');
  assert.strictEqual(S.presetSetActive(base, 'ghost').activePreset, base.activePreset); // 무변경
});

// ── [Phase 2 배선] normalizeState 통합 — 레거시 키 권위 + 활성 프리셋 reconcile ──────────
test('Phase2배선 — normalizeState: 레거시 키(no dashboard)를 활성 프리셋에 reconcile + shelf-union', () => {
  const st = S.normalizeState({ homeLayout: ['mail', 'todos'], hiddenWidgets: ['disk'], homeWidgetSizes: { mail: { w: 2, h: 240 } } });
  assert.ok(st.dashboard && Array.isArray(st.dashboard.presets));
  const active = st.dashboard.presets.find((p) => p.id === st.dashboard.activePreset);
  assert.deepStrictEqual(active.layout.slice(0, 2), ['mail', 'todos']);
  assert.deepStrictEqual(active.sizes, { mail: { w: 2, h: 240 } });
  // 레거시(schemaVersion 부재) → shelf-union 반영: hidden 에 disk + shelf/shelfWide
  assert.ok(active.hidden.includes('disk'));
  assert.ok(active.hidden.includes('shelf') && active.hidden.includes('shelfWide'));
  // 레거시 키도 활성 프리셋과 동일(권위 유지)
  assert.deepStrictEqual(st.homeLayout, active.layout);
  assert.deepStrictEqual(st.hiddenWidgets, active.hidden);
  assert.deepStrictEqual(st.homeWidgetSizes, active.sizes);
});

test('Phase2배선 — normalizeState: 비활성 프리셋 내용 보존 + 활성만 레거시로 reconcile', () => {
  const dashboard = {
    activePreset: 'default',
    presets: [
      { id: 'default', name: '기본', layout: S.HOME_SECTION_IDS.slice(), hidden: [], sizes: {}, layoutMode: 'masonry' },
      { id: 'p1', name: '집중', layout: ['todos', 'mail'], hidden: ['disk'], sizes: { todos: { w: 2, h: 300 } }, layoutMode: 'freeform' },
    ],
  };
  const st = S.normalizeState({ schemaVersion: 2, homeLayout: ['mail', 'attention'], hiddenWidgets: [], homeWidgetSizes: {}, dashboard });
  const p1 = st.dashboard.presets.find((p) => p.id === 'p1');
  assert.deepStrictEqual(p1.layout.slice(0, 2), ['todos', 'mail'], '비활성 프리셋 배치 보존');
  assert.strictEqual(p1.layoutMode, 'freeform', '비활성 프리셋 모드 보존');
  const active = st.dashboard.presets.find((p) => p.id === 'default');
  assert.deepStrictEqual(active.layout.slice(0, 2), ['mail', 'attention'], '활성 프리셋은 레거시로 reconcile');
});

// ── [Phase 1·K] 내보내기/가져오기 직렬화 (순수·방어) ────────────────────────
test('Phase1K — serialize→deserialize 라운드트립(프리셋 보존)', () => {
  let s = S.defaultDashboardState();
  s = S.presetAdd(s, '집중').state;
  s = S.presetUpdate(s, s.activePreset, { layout: ['todos', 'mail'], layoutMode: 'freeform' });
  const json = S.serializeDashboard(s);
  assert.strictEqual(typeof json, 'string');
  const back = S.deserializeDashboard(json);
  assert.strictEqual(back.presets.length, 2);
  const active = back.presets.find((p) => p.id === back.activePreset);
  assert.deepStrictEqual(active.layout.slice(0, 2), ['todos', 'mail']);
  assert.strictEqual(active.layoutMode, 'freeform');
});

test('Phase1K — deserialize 방어: 비문자열/파싱실패는 null, 베어 객체도 허용', () => {
  assert.strictEqual(S.deserializeDashboard(null), null);
  assert.strictEqual(S.deserializeDashboard(123), null);
  assert.strictEqual(S.deserializeDashboard('{not json'), null);
  // 래퍼 없는 베어 대시보드도 정규화 허용
  const bare = S.deserializeDashboard(JSON.stringify({ activePreset: 'x', presets: [{ id: 'x', layout: ['mail'] }] }));
  assert.ok(bare && bare.presets.length === 1);
  // 손상 필드가 섞여도 정규화로 방어(항상 유효 대시보드)
  const messy = S.deserializeDashboard(JSON.stringify({ presets: [{ id: 'a', layout: ['bogus'], layoutMode: 'nope' }] }));
  assert.strictEqual(messy.presets[0].layoutMode, 'masonry');
});

test('Phase2 — presetUpdate: 활성 프리셋 편집 영속(정규화·화이트리스트)', () => {
  const base = S.defaultDashboardState();
  const s = S.presetUpdate(base, 'default', {
    layout: ['mail', 'todos', 'bogus'],
    sizes: { mail: { w: 99, h: 5 }, featureAdd: { w: 2, h: 200 } }, // 클램프 + featureAdd 제거
    layoutMode: 'freeform',
    positions: { mail: { x: 2, y: 3 } },
  });
  const p = s.presets[0];
  assert.deepStrictEqual(p.layout.slice(0, 2), ['mail', 'todos']);
  assert.ok(!p.layout.includes('bogus'));
  assert.deepStrictEqual(p.sizes, { mail: { w: S.HOME_MAX_COLS, h: S.HOME_H_MIN } }); // 99→4, 5→120
  assert.strictEqual(p.layoutMode, 'freeform');
  assert.deepStrictEqual(p.positions, { mail: { x: 2, y: 3 } });
  assert.deepStrictEqual(p.groups, []); // 항상 정규화
});
