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
    // 기본 프리셋은 현행 기본 배치(전 섹션 순서) + 신규 위젯 기본 숨김(셸프 2변형 + 스크래치패드).
    // [위젯 인스턴스] 기본 프리셋 배치 = 기본 숨김 위젯을 뺀 타입 각 1개(타입 id 를 iid 로).
    assert.deepStrictEqual(d.presets[0].widgets, S.defaultHomeWidgets());
  }
});

// ── 레거시 → 대시보드 무손실 이행 ───────────────────────────────────────────
test('Phase0 — migrateLegacyToDashboard: 기존 배치·숨김·크기를 기본 프리셋으로 승격(무손실)', () => {
  // [위젯 인스턴스] 레거시 layout+hidden → widgets([{iid,type,name}]). 타입 id 가 그대로 iid 로 승격되어
  //   sizes 키가 하나도 바뀌지 않는다(이행 무손실의 핵심).
  const legacy = {
    homeLayout: ['mail', 'attention', 'todos'], // 부분 순서 → 나머지 기본 순서로 보충됨
    hiddenWidgets: ['disk'],
    homeWidgetSizes: { mail: { w: 3, h: 250 }, bogus: { w: 2, h: 200 } },
  };
  const d = S.migrateLegacyToDashboard(legacy, 5); // v5 저장본으로 이행
  assert.strictEqual(d.presets.length, 1);
  const p = d.presets[0];
  assert.strictEqual(p.id, 'default');
  assert.strictEqual(d.activePreset, 'default');
  // widgets: 레거시 순서 보존(앞 3개) + 숨김(disk) 미배치 + featureAdd 는 인스턴스 아님.
  assert.deepStrictEqual(p.widgets.slice(0, 3).map((w) => w.iid), ['mail', 'attention', 'todos']);
  assert.ok(!p.widgets.some((w) => w.type === 'disk'), '숨김이었던 위젯은 미배치');
  assert.ok(!p.widgets.some((w) => w.type === 'featureAdd'), 'featureAdd 는 인스턴스가 아니다');
  assert.deepStrictEqual(p.widgets[0], { iid: 'mail', type: 'mail', name: '' });
  // sizes: 배치되지 않은 bogus 제거, 유효 항목(mail) 은 키·값 그대로 유지.
  assert.deepStrictEqual(p.sizes, { mail: { w: 3, h: 250 } });
});

test('Phase0 — 이행 결과는 정규화에 대해 안정(idempotent stable)', () => {
  const legacy = { homeLayout: ['todos', 'mail'], hiddenWidgets: ['shelf', 'shelfWide'], homeWidgetSizes: { todos: { w: 2, h: 300 } } };
  const once = S.migrateLegacyToDashboard(legacy);
  const twice = S.normalizeDashboardState(once);
  assert.deepStrictEqual(twice, once, '정규화 재적용해도 동일(안정)');
});

// ── 화이트리스트·클램프 (프리셋 필드) ───────────────────────────────────────
test('Phase0 — normalizePreset: 미지 위젯/모드/좌표 방어(배치된 iid 기준)', () => {
  // [위젯 인스턴스] sizes/positions/groups 는 **그 프리셋에 배치된 iid** 로만 검증된다 —
  //   배치에 없는 키(bogus)는 조용히 정리되고, 같은 타입 2개(mail / w1)는 각자의 크기·좌표를 갖는다.
  const d = S.normalizeDashboardState({
    activePreset: 'a',
    presets: [{
      id: 'a', name: '  집중  ', layoutMode: 'chaos', // 잘못된 모드 → masonry
      widgets: [
        { iid: 'mail', type: 'mail', name: '' },
        { iid: 'w1', type: 'mail', name: '업무 메일' },  // 같은 타입 중복 배치
        { iid: 'w2', type: 'nope' },                     // 미지 타입 → 제거
      ],
      sizes: { mail: { w: 99, h: 99999 }, w1: { w: 1, h: 200 }, bogus: { w: 2, h: 200 } },
      positions: { mail: { x: -5, y: 9999 }, featureAdd: { x: 1, y: 1 }, bogus: { x: 1, y: 1 } },
    }],
  });
  const p = d.presets[0];
  assert.strictEqual(p.name, '집중');           // trim
  assert.strictEqual(p.layoutMode, 'masonry');  // 잘못된 모드 폴백
  assert.deepStrictEqual(p.widgets.map((w) => w.iid), ['mail', 'w1'], '미지 타입 제거, 중복 배치 유지');
  assert.strictEqual(p.widgets[1].name, '업무 메일', '배치별 이름 보존');
  // sizes: 배치된 iid 만. 같은 타입 두 인스턴스가 서로 다른 크기를 갖는다.
  assert.deepStrictEqual(p.sizes.mail, { w: S.HOME_MAX_COLS, h: S.HOME_H_MAX }); // 클램프: w→4, h→1600
  assert.deepStrictEqual(p.sizes.w1, { w: 1, h: 200 });
  assert.ok(!('bogus' in p.sizes), '미배치 iid 크기 제거');
  // positions: bogus(미배치) 제거, featureAdd 는 허용(프리폼 배치 대상), mail 은 [0,MAX_POS] 클램프.
  assert.deepStrictEqual(Object.keys(p.positions).sort(), ['featureAdd', 'mail']);
  assert.strictEqual(p.positions.mail.x, 0);
  assert.strictEqual(p.positions.mail.y, 200);
  assert.deepStrictEqual(p.positions.featureAdd, { x: 1, y: 1 });
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
  assert.deepStrictEqual(r.state.presets[1].widgets, S.defaultHomeWidgets());
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
test('Phase2배선 — normalizeState: 레거시 키(no dashboard)를 활성 프리셋에 reconcile + 신규 위젯 미배치', () => {
  const st = S.normalizeState({ homeLayout: ['mail', 'todos'], hiddenWidgets: ['disk'], homeWidgetSizes: { mail: { w: 2, h: 240 } } });
  assert.ok(st.dashboard && Array.isArray(st.dashboard.presets));
  const active = st.dashboard.presets.find((p) => p.id === st.dashboard.activePreset);
  // [위젯 인스턴스] 레거시 layout+hidden → widgets. 순서 보존, 숨김(disk) 미배치.
  assert.deepStrictEqual(active.widgets.slice(0, 2).map((w) => w.iid), ['mail', 'todos']);
  assert.deepStrictEqual(active.sizes, { mail: { w: 2, h: 240 } });
  const types = new Set(active.widgets.map((w) => w.type));
  assert.ok(!types.has('disk'), '숨김이었던 위젯은 미배치');
  // 레거시(schemaVersion 부재) → 그 이후 도입된 위젯(셸프 등)은 미배치
  assert.ok(!types.has('shelf') && !types.has('shelfWide'), '신규 위젯은 미배치(갑툭튀 금지)');
  // 최상위 키도 활성 프리셋과 동일(권위 유지)
  assert.deepStrictEqual(st.homeWidgets, active.widgets);
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
  // [위젯 인스턴스] 각 프리셋의 레거시 layout/hidden 이 각자 widgets 로 이행된다(프리셋별 배치가 다르다).
  const p1 = st.dashboard.presets.find((p) => p.id === 'p1');
  assert.deepStrictEqual(p1.widgets.slice(0, 2).map((w) => w.iid), ['todos', 'mail'], '비활성 프리셋 배치 보존');
  assert.ok(!p1.widgets.some((w) => w.type === 'disk'), '비활성 프리셋의 숨김도 미배치로 이행');
  assert.strictEqual(p1.layoutMode, 'freeform', '비활성 프리셋 모드 보존');
  assert.deepStrictEqual(p1.sizes, { todos: { w: 2, h: 300 } }, '비활성 프리셋 크기 보존');
  const active = st.dashboard.presets.find((p) => p.id === 'default');
  assert.deepStrictEqual(active.widgets.slice(0, 2).map((w) => w.iid), ['mail', 'attention'], '활성 프리셋은 최상위 키로 reconcile');
});

// ── [Phase 1·K] 내보내기/가져오기 직렬화 (순수·방어) ────────────────────────
test('Phase1K — serialize→deserialize 라운드트립(프리셋 보존)', () => {
  let s = S.defaultDashboardState();
  s = S.presetAdd(s, '집중').state;
  s = S.presetUpdate(s, s.activePreset, {
    widgets: [{ iid: 'todos', type: 'todos', name: '' }, { iid: 'mail', type: 'mail', name: '업무' }],
    layoutMode: 'freeform',
  });
  const json = S.serializeDashboard(s);
  assert.strictEqual(typeof json, 'string');
  const back = S.deserializeDashboard(json);
  assert.strictEqual(back.presets.length, 2);
  const active = back.presets.find((p) => p.id === back.activePreset);
  assert.deepStrictEqual(active.widgets.map((w) => w.iid), ['todos', 'mail']);
  assert.strictEqual(active.widgets[1].name, '업무', '배치별 이름도 내보내기/가져오기에 보존');
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
    // [위젯 인스턴스] widgets 를 먼저 확정한 뒤 그 iid 집합으로 sizes/positions 를 검증한다.
    widgets: [{ iid: 'mail', type: 'mail', name: '' }, { iid: 'todos', type: 'todos', name: '' }, { iid: 'w9', type: 'bogus' }],
    sizes: { mail: { w: 99, h: 5 }, featureAdd: { w: 2, h: 200 } }, // 클램프 + featureAdd 제거
    layoutMode: 'freeform',
    positions: { mail: { x: 2, y: 3 } },
  });
  const p = s.presets[0];
  assert.deepStrictEqual(p.widgets.map((w) => w.iid), ['mail', 'todos'], '미지 타입(bogus) 인스턴스 제거');
  assert.deepStrictEqual(p.sizes, { mail: { w: S.HOME_MAX_COLS, h: S.HOME_H_MIN } }); // 99→4, 5→120
  assert.strictEqual(p.layoutMode, 'freeform');
  assert.deepStrictEqual(p.positions, { mail: { x: 2, y: 3 } });
  assert.deepStrictEqual(p.groups, []); // 항상 정규화
});

test('위젯 인스턴스 — presetUpdate 화이트리스트에 widgets 가 있다(누락 시 조용히 소실되는 함정)', () => {
  const base = S.defaultDashboardState();
  const s = S.presetUpdate(base, 'default', {
    widgets: [{ iid: 'mdedit', type: 'mdedit', name: '회의록' }, { iid: 'w1', type: 'mdedit', name: 'TODO' }],
  });
  assert.deepStrictEqual(s.presets[0].widgets, [
    { iid: 'mdedit', type: 'mdedit', name: '회의록' },
    { iid: 'w1', type: 'mdedit', name: 'TODO' },
  ], '중복 배치 + 이름이 프리셋에 영속된다');
});
