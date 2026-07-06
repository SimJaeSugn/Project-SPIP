'use strict';
/**
 * homeLayout-front.test.js — R-32 프런트엔드(홈 섹션 드래그·데이터-주도 배치, 헤드리스 F-3).
 *   applyHomeLayout(순수 순서 정규화) + HOME_SECTION_IDS(메인 계약 동형) + 정적 배선 검증.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { HOME_SECTION_IDS, applyHomeLayout, TOGGLEABLE_WIDGET_IDS, applyHomeWidgetSizes, computeHomeCols, homeDefaultSpan, HOME_MAX_COLS, applyDashboard, densityTier, DENSITY_M_MIN, DENSITY_L_MIN, buildHeatmapModel, heatmapLevel, actionMatchScore, filterActions, freeformSeedPositions, freeformSnapCell, freeformCellPx, HOME_FREE_ROW } = require('../public/app.js');
const realStore = require('../lib/common/uiStateStore');
const APP_SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
// 메인 계약(단일 신뢰 경계)과 동형인지 교차 확인.
const STORE_SRC = fs.readFileSync(path.join(__dirname, '..', 'lib', 'common', 'uiStateStore.js'), 'utf8');

// ── HOME_SECTION_IDS 계약 동형 ────────────────────────────────────────────
// [SH-2] 셸프 2변형 + [Phase 3·G] 스크래치패드·커밋 히트맵·시스템 상태('systemStatus')를 featureAdd 앞에 → 13섹션 enum.
const N_SECTIONS = 13;
test('R-32 — HOME_SECTION_IDS: 13섹션 enum(배열 순서 = 기본 순서)', () => {
  assert.deepStrictEqual(HOME_SECTION_IDS,
    ['attention', 'productivity', 'activity', 'todos', 'mail', 'disk', 'aiusage', 'shelf', 'shelfWide', 'scratchpad', 'commitHeatmap', 'systemStatus', 'featureAdd']);
});

test('R-32 — 렌더러 HOME_SECTION_IDS 가 메인 uiStateStore 와 동일 집합·순서', () => {
  const m = STORE_SRC.match(/HOME_SECTION_IDS\s*=\s*\[([^\]]*)\]/);
  assert.ok(m, '메인에 HOME_SECTION_IDS 정의가 있어야 한다');
  const mainIds = (m[1].match(/'([a-zA-Z]+)'/g) || []).map((s) => s.replace(/'/g, ''));
  assert.deepStrictEqual(mainIds, HOME_SECTION_IDS, '렌더러·메인 동형(드리프트 0)');
});

// ── [홈 위젯 크기] applyHomeWidgetSizes / computeHomeCols / homeDefaultSpan (렌더러 순수) ──
test('홈 위젯 크기 — applyHomeWidgetSizes: 화이트리스트·클램프(메인 동형)', () => {
  const r = applyHomeWidgetSizes({
    mail: { w: 3, h: 250 },
    aiusage: { w: 99, h: 99999 },  // 클램프 → w:HOME_MAX_COLS, h:1600
    featureAdd: { w: 2, h: 200 },  // 제거
    bogus: { w: 2, h: 200 },       // 제거
  });
  assert.deepStrictEqual(r, { mail: { w: 3, h: 250 }, aiusage: { w: HOME_MAX_COLS, h: 1600 } });
  assert.deepStrictEqual(applyHomeWidgetSizes(null), {});
  assert.deepStrictEqual(applyHomeWidgetSizes([1]), {});
});

test('홈 위젯 크기 — computeHomeCols: 폭에 따라 1..HOME_MAX_COLS 반응(최소열 300+gap20)', () => {
  assert.strictEqual(computeHomeCols(0), 1);
  assert.strictEqual(computeHomeCols(300), 1);      // 1열 최소
  assert.strictEqual(computeHomeCols(640), 2);      // 2*300+20=620 ≤ 640
  assert.strictEqual(computeHomeCols(960), 3);      // 3*300+40=940 ≤ 960
  assert.strictEqual(computeHomeCols(1280), 4);     // 4*300+60=1260 ≤ 1280
  assert.strictEqual(computeHomeCols(5000), HOME_MAX_COLS); // 최대 캡
});

test('홈 위젯 크기 — homeDefaultSpan: shelfWide 는 전체폭, 그 외 1', () => {
  assert.strictEqual(homeDefaultSpan('shelfWide'), HOME_MAX_COLS);
  assert.strictEqual(homeDefaultSpan('mail'), 1);
  assert.strictEqual(homeDefaultSpan('attention'), 1);
});

// ── [로드맵 Phase 3·C] 위젯 밀도 tier 파생(순수 — 실측 폭 → S|M|L) ──
test('로드맵 Phase 3·C — densityTier: 실측 폭에서 S|M|L 경계 파생(단조·보수적 폴백)', () => {
  // 경계값: [<M) = S, [M,L) = M, [L,∞) = L. 경계는 포함(>=).
  assert.strictEqual(densityTier(0), 'S');            // 0/비유효 → 가장 보수적
  assert.strictEqual(densityTier(DENSITY_M_MIN - 1), 'S');
  assert.strictEqual(densityTier(DENSITY_M_MIN), 'M'); // M 하한 포함
  assert.strictEqual(densityTier(DENSITY_L_MIN - 1), 'M');
  assert.strictEqual(densityTier(DENSITY_L_MIN), 'L'); // L 하한 포함
  assert.strictEqual(densityTier(2000), 'L');
  // 비유효 입력 graceful → S.
  assert.strictEqual(densityTier(-100), 'S');
  assert.strictEqual(densityTier(NaN), 'S');
  assert.strictEqual(densityTier('foo'), 'S');
  assert.strictEqual(densityTier(undefined), 'S');
  // 임계 순서 불변식(M<L) — 상수 오설정 방지.
  assert.ok(DENSITY_M_MIN < DENSITY_L_MIN, 'M 임계 < L 임계');
});

// ── [로드맵 Phase 3·C] layoutHomeMasonry 가 셀에 [data-density] 훅 부여(배선) ──
test('로드맵 Phase 3·C — 렌더러: layoutHomeMasonry 가 실측 셀폭→densityTier→data-density 부여', () => {
  const start = APP_SRC.indexOf('function layoutMasonryGrid(');
  assert.ok(start >= 0, 'layoutMasonryGrid 함수가 있어야 한다');
  const body = APP_SRC.slice(start, start + 2800);
  assert.ok(/colW\s*=\s*\(contentW\s*-\s*HOME_GAP\s*\*\s*\(cols\s*-\s*1\)\)\s*\/\s*cols/.test(body), '한 열 실제 폭(colW) 산출');
  assert.ok(/cellW\s*=\s*colW\s*\*\s*w\s*\+\s*HOME_GAP\s*\*\s*\(w\s*-\s*1\)/.test(body), '셀 실측 폭(cellW) = colW*스팬 + gap');
  assert.ok(/cell\.dataset\.density\s*=\s*densityTier\(cellW\)/.test(body), 'densityTier(cellW) → data-density 부여');
});

// ── [로드맵 Phase 4·D] 커맨드 팔레트 — 순수 매칭/랭킹 + 렌더 배선 ──
test('로드맵 Phase 4·D — actionMatchScore: 접두>부분>키워드>서브시퀀스, 불일치 0', () => {
  const a = { title: '위젯 편집', keywords: 'edit widget' };
  assert.ok(actionMatchScore(a, '위젯') > actionMatchScore({ title: '가위젯', keywords: '' }, '위젯'), '제목 접두 > 내부 부분');
  assert.ok(actionMatchScore(a, 'edit') > 0, '키워드 매칭');
  assert.strictEqual(actionMatchScore(a, 'zzz'), 0, '불일치 0');
  assert.strictEqual(actionMatchScore(a, ''), 1, '빈 질의 = 1(전부 통과)');
  // 서브시퀀스(흩어진 순서).
  assert.ok(actionMatchScore({ title: 'export dashboard', keywords: '' }, 'exdb') > 0, '서브시퀀스 매칭');
  assert.strictEqual(actionMatchScore({ title: 'abc', keywords: '' }, 'cba'), 0, '역순은 서브시퀀스 아님');
});

test('로드맵 Phase 4·D — filterActions: 랭킹·enabled 제외·동점 안정 정렬', () => {
  const acts = [
    { id: 'a', title: '위젯 편집', keywords: 'edit' },
    { id: 'b', title: '설정', keywords: 'settings' },
    { id: 'c', title: '위젯 추가: 메일', keywords: 'add mail' },
    { id: 'd', title: '테마: 다크', enabled: () => false },
  ];
  const r = filterActions(acts, '위젯');
  assert.deepStrictEqual(r.map((x) => x.id), ['a', 'c'], '위젯 포함만, 접두(a) 우선');
  // enabled=false 제외.
  assert.ok(!filterActions(acts, '').some((x) => x.id === 'd'), 'enabled=false 제외');
  // 빈 질의는 원래 순서(동점 안정).
  assert.deepStrictEqual(filterActions(acts, '').map((x) => x.id), ['a', 'b', 'c'], '빈 질의 = 원래 순서(d만 제외)');
  // enabled throw 는 제외(격리).
  assert.deepStrictEqual(filterActions([{ id: 'x', title: 'x', enabled: () => { throw new Error('e'); } }], '').map((x) => x.id), []);
});

test('로드맵 Phase 4·D — 팔레트 렌더 배선: Cmd+K 토글·액션 레지스트리·부분교체·L-1', () => {
  const CSS = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  // Cmd/Ctrl+K 토글.
  assert.ok(/\(e\.ctrlKey \|\| e\.metaKey\)[^\n]*e\.key === 'k'/.test(APP_SRC), 'Cmd/Ctrl+K 토글 바인딩');
  assert.ok(/function openPalette\(/.test(APP_SRC) && /function closePalette\(/.test(APP_SRC), '열기/닫기 핸들러');
  assert.ok(/function buildActions\(/.test(APP_SRC), '액션 레지스트리 조립기');
  assert.ok(/filterActions\(buildActions\(\),\s*store\.palette\.query\)/.test(APP_SRC), '질의로 액션 필터');
  assert.ok(/store\.palette && store\.palette\.open\)\s*app\.appendChild\(renderPalette/.test(APP_SRC), 'render 에서 팔레트 마운트');
  // ESC 로 팔레트 우선 닫힘.
  assert.ok(/store\.palette && store\.palette\.open\)\s*\{\s*closePalette\(\)/.test(APP_SRC), 'ESC 팔레트 우선 닫기');
  // 질의/선택 부분 교체(입력 포커스 보존).
  assert.ok(/function patchPaletteList\(/.test(APP_SRC) && /function patchPaletteActive\(/.test(APP_SRC), '목록·선택 부분 교체');
  // 키보드 내비.
  assert.ok(/ArrowDown/.test(APP_SRC) && /ArrowUp/.test(APP_SRC) && /function onPaletteKeydown\(/.test(APP_SRC), '방향키 내비게이션');
  // CSS + L-1.
  assert.ok(/\.palette__item\.is-active\s*\{/.test(CSS), '활성 항목 스타일');
  assert.ok(!/function renderPalette\([\s\S]{0,1400}innerHTML/.test(APP_SRC), '팔레트 렌더 innerHTML 미사용(L-1)');
});

// ── [로드맵 Phase 5·M] 그룹/섹션 — 렌더·CRUD·접기·멤버 관리 배선 ──
test('로드맵 Phase 5·M — 그룹: 렌더·CRUD·접기·멤버 배정·격자 제외·masonry 전용', () => {
  const CSS = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  // 편집 모드 그룹 추가 버튼(masonry 전용).
  assert.ok(/text:\s*'\+ 그룹'/.test(APP_SRC), '그룹 추가 버튼');
  assert.ok(/editing && !freeform && bridgeHas\('setGroups'\)/.test(APP_SRC), '그룹은 masonry 편집 모드에서만');
  // 그룹 소속 위젯은 메인 격자에서 제외.
  assert.ok(/if \(groupedOf\[id\]\) return;/.test(APP_SRC), '그룹 위젯은 메인 격자에서 제외');
  assert.ok(/renderHomeGroups\(groups, hidden, reclaim, editing\)/.test(APP_SRC), '그룹 섹션 렌더 호출');
  // 렌더 함수 + CRUD 핸들러.
  assert.ok(/function renderHomeGroups\(/.test(APP_SRC) && /function renderGroupAddPicker\(/.test(APP_SRC), '그룹 렌더·피커');
  assert.ok(/function onAddGroup\(/.test(APP_SRC) && /function onDeleteGroup\(/.test(APP_SRC) && /function onToggleGroupCollapse\(/.test(APP_SRC), 'CRUD·접기 핸들러');
  assert.ok(/function onAddToGroup\(/.test(APP_SRC) && /function onRemoveFromGroup\(/.test(APP_SRC), '멤버 배정/제거');
  assert.ok(/ipc\('setGroups',\s*next\)/.test(APP_SRC), 'setGroups IPC 영속');
  // 하이드레이션.
  assert.ok(/store\.groups\s*=\s*applyGroups\(/.test(APP_SRC) && /function applyGroups\(/.test(APP_SRC), '그룹 하이드레이션·방어 적재');
  // 멤버 한 그룹에만(배정 시 타 그룹서 제거).
  assert.ok(/function onAddToGroup\([\s\S]{0,320}filter\(function \(m\) \{ return m !== widgetId/.test(APP_SRC), '배정 시 타 그룹서 제거(유일)');
  // CSS — 그룹 내부도 masonry 격자(--home-cols)로 멤버 리사이즈/스팬 지원.
  assert.ok(/\.home-group__grid\s*\{[^}]*repeat\(var\(--home-cols/.test(CSS), '멤버 masonry 격자(--home-cols)');
  assert.ok(/\.home-group\.is-collapsed/.test(CSS), '접기 상태 CSS');
  // 멤버 리사이즈·순서변경(masonry 그룹 내부).
  assert.ok(/function buildGroupMemberCell\(/.test(APP_SRC) && /buildGroupMemberCell\(id, reclaim, editing, true\)/.test(APP_SRC), '밴드 멤버 리사이즈(withResize=true)');
  assert.ok(/function initGroupSortables\(/.test(APP_SRC) && /function commitGroupMembers\(/.test(APP_SRC) && /function commitGroupOrder\(/.test(APP_SRC), '멤버·그룹 순서변경 Sortable/커밋');
  assert.ok(/closest\('\.home-masonry, \.home-group__grid'\)/.test(APP_SRC), '리사이즈가 속한 격자(메인/그룹) 기준');
});

// ── [로드맵 Phase 5·M] 프리폼 그룹 자유 배치 ──
test('로드맵 Phase 5·M — 프리폼에서 그룹 블록 자유 배치(좌표·드래그·화이트리스트)', () => {
  const CSS = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  // 그룹은 두 모드 모두 적용(masonry=밴드, freeform=자유 셀).
  assert.ok(/var groups = Array\.isArray\(store\.groups\) \? store\.groups : \[\]/.test(APP_SRC), '그룹은 모드 무관 적재');
  assert.ok(/function renderGroupFreeCell\(/.test(APP_SRC), '프리폼 그룹 자유 배치 셀 렌더');
  assert.ok(/if \(freeform\) \{[\s\S]{0,260}renderGroupFreeCell\(g, hidden, reclaim, editing\)/.test(APP_SRC), '프리폼에서 그룹 셀을 격자에 추가');
  assert.ok(/onFreeformDragStart\(e, g\.id\)/.test(APP_SRC), '그룹 셀 드래그(그룹 id)');
  // 그룹 id 판정 + 좌표/폭 화이트리스트 확장(프리폼 그룹 배치·폭).
  assert.ok(/function isGroupId\(/.test(APP_SRC), '그룹 id 판정');
  assert.ok(/HOME_SECTION_IDS\.indexOf\(id\) < 0 && !isGroupId\(id\)\) continue/.test(APP_SRC), 'positions 에 그룹 id 허용');
  assert.ok(/if \(isGroupId\(id\)\) return 2;/.test(APP_SRC), '그룹 블록 기본 2열');
  // layoutHomeFreeform 은 직계 셀만(중첩 멤버 제외).
  assert.ok(/grid\.children\[c\]\.classList\.contains\('home-section'\)/.test(APP_SRC), '프리폼 배치는 직계 셀만(멤버 제외)');
  assert.ok(/\.home-group__gridfree\s*\{[^}]*repeat\(auto-fit/.test(CSS), '프리폼 그룹 멤버 auto-fit');
});

test('로드맵 Phase 5·M — featureAdd(+위젯) 는 항상 최하단(그룹 위에 최상단 배치 가능)', () => {
  // 메인 격자 루프에서 featureAdd 제외 → 별도 렌더.
  assert.ok(/if \(id === 'featureAdd'\) return; \/\/ \[Phase 5·M\]/.test(APP_SRC), '메인 루프에서 featureAdd 제외');
  // masonry: 그룹 밴드 다음에 featureAdd 카드(최하단).
  assert.ok(/renderHomeGroups\(groups, hidden, reclaim, editing\)\);[\s\S]{0,220}renderHomeSection\('featureAdd'/.test(APP_SRC), 'masonry 는 그룹 밴드 뒤에 featureAdd 카드');
  // freeform: featureAdd 도 자유 배치 셀(그룹 다음에 추가 → 기본 최하단 시드).
  assert.ok(/buildHomeCell\('featureAdd', reclaim, editing, freeform\)/.test(APP_SRC), 'freeform featureAdd 자유 배치 셀');
  assert.ok(/function buildHomeCell\(/.test(APP_SRC), '홈 셀 빌더 추출');
});

// ── [로드맵 Phase 5·B] 프리폼(자유 배치) — 순수 좌표 유틸 + 렌더/드래그 배선 ──
test('로드맵 Phase 5·B — freeformSeedPositions: 미배치만 순차 패킹, 기존 좌표 유지·클램프', () => {
  const r = freeformSeedPositions(['a', 'b', 'c', 'd', 'e'], { b: { x: 9, y: 1 } }, 2);
  assert.deepStrictEqual(r.a, { x: 0, y: 0 });
  assert.deepStrictEqual(r.b, { x: 1, y: 1 }, '기존 좌표 유지(x는 cols-1=1로 클램프)');
  assert.deepStrictEqual(r.c, { x: 1, y: 0 });
  assert.deepStrictEqual(r.d, { x: 0, y: 4 }, '열 넘치면 다음 줄');
  assert.deepStrictEqual(freeformSeedPositions(null, {}, 3), {});
});

test('로드맵 Phase 5·B — freeformSnapCell/CellPx: 픽셀↔셀 스냅(순수·클램프)', () => {
  assert.deepStrictEqual(freeformSnapCell(5, 5, 300, 20, 4), { x: 0, y: 0 });
  assert.deepStrictEqual(freeformSnapCell(320, 80, 300, 20, 4), { x: 1, y: 2 }, '열 스텝=colW+gap, 세로=HOME_FREE_ROW');
  assert.deepStrictEqual(freeformSnapCell(99999, 0, 300, 20, 3), { x: 2, y: 0 }, 'x 는 cols-1 로 클램프');
  assert.deepStrictEqual(freeformSnapCell(-50, -50, 300, 20, 4), { x: 0, y: 0 }, '음수 → 0');
  assert.deepStrictEqual(freeformCellPx(2, 3, 300, 20), { left: 640, top: 3 * HOME_FREE_ROW });
});

test('로드맵 Phase 5·B — 프리폼 렌더/드래그 배선 + SortableJS 게이팅 + IPC', () => {
  const CSS = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  assert.ok(/function onToggleLayoutMode\(/.test(APP_SRC) && /function onAutoArrange\(/.test(APP_SRC), '모드 토글/자동 정렬');
  assert.ok(/ipc\('setLayoutMode',\s*next\)/.test(APP_SRC), 'setLayoutMode IPC');
  assert.ok(/ipc\('setWidgetPositions',\s*next\)/.test(APP_SRC), 'setWidgetPositions IPC');
  assert.ok(/store\.layoutMode === 'freeform'\)\s*\{\s*layoutHomeFreeform\(grid\);\s*return/.test(APP_SRC), 'layout 분기(freeform→절대배치)');
  assert.ok(/function layoutHomeFreeform\(/.test(APP_SRC), '프리폼 레이아웃 함수');
  assert.ok(/function onFreeformDragStart\(/.test(APP_SRC) && /function onFreeformDragEnd\(/.test(APP_SRC), '프리폼 드래그 시작/종료');
  assert.ok(/closest\('\.home-resize'\)/.test(APP_SRC) && /closest\('textarea'\)/.test(APP_SRC), '드래그가 리사이즈·텍스트 입력과 분리');
  // 이동 임계값(클릭 vs 드래그) — featureAdd 클릭(갤러리) 유지.
  assert.ok(/FREE_DRAG_THRESHOLD/.test(APP_SRC) && /if \(!d\.moved\)/.test(APP_SRC), '이동 임계값으로 클릭/드래그 구분');
  assert.ok(/freeformSnapCell\(/.test(APP_SRC), '드롭 시 셀 스냅');
  // [좌우 여백 대칭] 절대 배치가 좌/상 패딩을 반영해 대칭 여백.
  assert.ok(/cell\.style\.left = \(padL \+ px\.left\)/.test(APP_SRC), '레이아웃이 좌측 패딩 반영');
  assert.ok(/d\.cell\.style\.left = \(d\.padL \+ left\)/.test(APP_SRC), '드래그 표시도 좌측 패딩 반영(레이아웃과 동일 좌표계)');
  assert.ok(/if \(store\.layoutMode === 'freeform'\) return;/.test(fnBody('initHomeSortable', 400)), '프리폼에서 Sortable 게이팅');
  assert.ok(/store\.layoutMode\s*=\s*applyLayoutMode\(/.test(APP_SRC) && /store\.widgetPositions\s*=\s*applyWidgetPositions\(/.test(APP_SRC), 'layoutMode·positions 하이드레이션');
  assert.ok(/\.home-masonry--freeform \.home-section\s*\{[^}]*position:\s*absolute/.test(CSS), '프리폼 절대 배치 CSS');
});

// ── [로드맵 Phase 4·I/H] 포커스 위젯 + 딥링크(프로젝트 점프) 배선 ──
test('로드맵 Phase 4·I — 포커스 위젯: 버튼·오버레이·masonry 재측정·ESC 우선순위', () => {
  const CSS = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  // 셀에 포커스 버튼 부착(제거 버튼과 함께).
  assert.ok(/function widgetFocusBtn\(/.test(APP_SRC), '포커스 버튼 빌더');
  assert.ok(/cell\.appendChild\(widgetFocusBtn\(id\)\)/.test(APP_SRC), '셀에 포커스 버튼 부착');
  // 열기/닫기 + 오버레이 렌더 + 마운트.
  assert.ok(/function openFocusWidget\(/.test(APP_SRC) && /function closeFocusWidget\(/.test(APP_SRC), '포커스 열기/닫기');
  assert.ok(/function renderFocusOverlay\(/.test(APP_SRC), '포커스 오버레이 렌더');
  assert.ok(/store\.focusWidget && store\.focusWidget\.open\)\s*app\.appendChild\(renderFocusOverlay/.test(APP_SRC), 'render 에서 포커스 마운트');
  // 닫을 때 masonry 재측정(로드맵 §4 요구).
  assert.ok(/function closeFocusWidget\(\)[\s\S]{0,220}scheduleHomeMasonryLayout\(\)/.test(APP_SRC), '포커스 종료 시 masonry 재측정');
  // 오버레이는 컨테이너 컨텍스트 재사용(밀도 L 반응).
  assert.ok(/focusw__body home-section__content/.test(APP_SRC), '포커스 본문이 컨테이너 컨텍스트 재사용');
  // ESC 우선순위: 팔레트 > 포커스 > 도움말.
  assert.ok(/store\.focusWidget && store\.focusWidget\.open\)\s*\{\s*closeFocusWidget\(\)/.test(APP_SRC), 'ESC 포커스 닫기');
  // CSS.
  assert.ok(/\.focusw-overlay\s*\{/.test(CSS) && /\.widget-focus\s*\{/.test(CSS), '포커스 오버레이·버튼 CSS');
});

test('로드맵 Phase 4·H/I — 팔레트 액션에 위젯 포커스·프로젝트 점프(딥링크) 포함', () => {
  // 포커스 액션(표시 위젯) + 프로젝트 점프(viewModels → openDrawer).
  const b = APP_SRC.slice(APP_SRC.indexOf('function buildActions('), APP_SRC.indexOf('function buildActions(') + 4800);
  assert.ok(/id:\s*'focus\.'\s*\+\s*id/.test(b), '표시 위젯 포커스 액션');
  assert.ok(/openFocusWidget\(id\)/.test(b), '포커스 액션이 openFocusWidget 실행');
  assert.ok(/id:\s*'project\.'\s*\+\s*vm\.id/.test(b), '프로젝트 점프 액션');
  assert.ok(/openDrawer\(vm\.id\)/.test(b), '프로젝트 점프가 상세 드로어 열기(딥링크)');
});

// ── [로드맵 Phase 3·G] 시스템 상태 위젯 — 렌더 배선·지연로드·주기갱신·L-1 ──
test('로드맵 Phase 3·G — 시스템 상태 위젯: 렌더·표시시 지연로드·주기갱신 타이머·부분교체·L-1', () => {
  const CSS = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  assert.ok(HOME_SECTION_IDS.includes('systemStatus'), '렌더러 enum 에 systemStatus');
  assert.ok(/function renderHomeSystemStatus\(/.test(APP_SRC), '시스템 상태 렌더 함수');
  assert.ok(/case 'systemStatus':\s*return renderHomeSystemStatus\(\)/.test(APP_SRC), 'renderHomeSection case');
  assert.ok(/systemStatus:\s*\{\s*name:/.test(APP_SRC), 'WIDGET_META.systemStatus');
  // 표시될 때만 로드 + 주기 갱신 타이머(숨김/이탈 시 정지).
  assert.ok(/function maybeLoadSystemStatus\(/.test(APP_SRC) && /homeWidgetVisible\('systemStatus'\)/.test(APP_SRC), '표시(visible)될 때만 로드');
  assert.ok(/ipc\('getSystemStatus'\)/.test(APP_SRC), 'getSystemStatus IPC');
  assert.ok(/setInterval\(/.test(fnBody('ensureSystemStatusTimer', 500)) && /stopSystemStatusTimer/.test(APP_SRC), '주기 갱신 타이머 + 정지');
  // 자동 갱신은 위젯 본문만 부분 교체(전체 재렌더 회피).
  assert.ok(/function patchSystemStatus\(/.test(APP_SRC) && /\.sysstat-body/.test(APP_SRC), '본문 부분 교체(patchSystemStatus)');
  // 미터 색은 클래스(임계 등급), CSS 존재.
  assert.ok(/\.sysmeter__fill\.sysmeter--hi\s*\{/.test(CSS), '고사용 색 등급 클래스');
  // L-1: innerHTML 미사용.
  assert.ok(!/renderHomeSystemStatus[\s\S]{0,1200}innerHTML/.test(APP_SRC), '시스템 상태 렌더 innerHTML 미사용(L-1)');
  assert.ok(!/buildSystemStatusBody[\s\S]{0,1500}innerHTML/.test(APP_SRC), '본문 빌더 innerHTML 미사용(L-1)');
});

// ── [로드맵 Phase 3·G] 통합 커밋 히트맵 — 순수 모델 + 렌더 배선 ──
test('로드맵 Phase 3·G — heatmapLevel: 커밋 수 → 색 강도 레벨 0..4(고정 임계·단조)', () => {
  assert.strictEqual(heatmapLevel(0), 0);
  assert.strictEqual(heatmapLevel(1), 1);
  assert.strictEqual(heatmapLevel(2), 1);
  assert.strictEqual(heatmapLevel(3), 2);
  assert.strictEqual(heatmapLevel(5), 2);
  assert.strictEqual(heatmapLevel(6), 3);
  assert.strictEqual(heatmapLevel(9), 3);
  assert.strictEqual(heatmapLevel(10), 4);
  assert.strictEqual(heatmapLevel(999), 4);
  // 비유효 graceful → 0.
  assert.strictEqual(heatmapLevel(-5), 0);
  assert.strictEqual(heatmapLevel(NaN), 0);
  assert.strictEqual(heatmapLevel('x'), 0);
});

test('로드맵 Phase 3·G — buildHeatmapModel: 주간 격자·요일 패딩·월 라벨·집계(순수)', () => {
  // 2026-01-04(일)~2026-01-10(토) 7일 + 앞뒤. 첫날 2026-01-01(목=dow4) → 선행 null 4개.
  const days = [
    { date: '2026-01-01', count: 0 }, { date: '2026-01-02', count: 3 }, { date: '2026-01-03', count: 0 },
    { date: '2026-01-04', count: 1 }, { date: '2026-01-05', count: 12 }, { date: '2026-01-06', count: 0 },
    { date: '2026-01-07', count: 2 }, { date: '2026-01-08', count: 0 }, { date: '2026-01-09', count: 6 },
  ];
  const m = buildHeatmapModel(days);
  // 선행 패딩 4 + 9일 = 13칸 → 2열(7,6). 첫 열 첫 4칸 null.
  assert.strictEqual(m.weeks.length, 2);
  for (let i = 0; i < 4; i++) assert.strictEqual(m.weeks[0][i], null, '첫날 요일 선행 패딩(목=4)');
  assert.deepStrictEqual(m.weeks[0][4], { date: '2026-01-01', count: 0, level: 0 });
  assert.deepStrictEqual(m.weeks[0][5], { date: '2026-01-02', count: 3, level: 2 });
  // 집계.
  assert.strictEqual(m.total, 0 + 3 + 0 + 1 + 12 + 0 + 2 + 0 + 6);
  assert.strictEqual(m.activeDays, 5, 'count>0 인 날 수');
  assert.strictEqual(m.days, 9);
  // 월 라벨 — 첫 열에 1월.
  assert.ok(m.months.some((x) => x.col === 0 && x.label === '1월'));
  // 빈/손상 graceful.
  assert.deepStrictEqual(buildHeatmapModel([]), { weeks: [], months: [], total: 0, activeDays: 0, days: 0 });
  assert.deepStrictEqual(buildHeatmapModel(null).weeks, []);
  assert.deepStrictEqual(buildHeatmapModel([{ date: 'bad', count: 5 }]).weeks, [], '형식 불량 날짜 폐기');
});

test('로드맵 Phase 3·G — 커밋 히트맵 위젯: 렌더·지연로드·365일 요청·반응형 스크롤·L-1', () => {
  const CSS = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  assert.ok(HOME_SECTION_IDS.includes('commitHeatmap'), '렌더러 enum 에 commitHeatmap');
  assert.strictEqual(homeDefaultSpan('commitHeatmap'), 2, '기본 2열(가로 캘린더)');
  assert.ok(/function renderHomeCommitHeatmap\(/.test(APP_SRC), '히트맵 렌더 함수');
  assert.ok(/case 'commitHeatmap':\s*return renderHomeCommitHeatmap\(\)/.test(APP_SRC), 'renderHomeSection case');
  assert.ok(/commitHeatmap:\s*\{\s*name:/.test(APP_SRC), 'WIDGET_META.commitHeatmap');
  // 지연 로드: 표시될 때만 + 365일 요청.
  assert.ok(/function maybeLoadCommitHeatmap\(/.test(APP_SRC) && /homeWidgetVisible\('commitHeatmap'\)/.test(APP_SRC), '표시(visible)될 때만 로드');
  assert.ok(/ipc\('getCommitActivity',\s*365\)/.test(APP_SRC), '365일 범위 요청');
  assert.ok(/buildHeatmapModel\(/.test(fnBody('renderHomeCommitHeatmap', 3200)), '렌더가 순수 모델 사용');
  // 반응형: 가로 스크롤 컨테이너(페이지 스크롤 안 남김) + 레벨 색 클래스.
  assert.ok(/\.heatmap-scroll\s*\{[^}]*overflow-x:\s*auto/.test(CSS), '좁으면 내부 가로 스크롤');
  assert.ok(/\.heatmap-cell\.lvl-4\s*\{/.test(CSS), '레벨 색 클래스');
  // L-1: 색은 클래스, 데이터는 title/textContent(innerHTML 미사용).
  assert.ok(!/renderHomeCommitHeatmap[\s\S]{0,3200}innerHTML/.test(APP_SRC), '히트맵 렌더 innerHTML 미사용(L-1)');
});

// ── [로드맵 Phase 3·G] 스크래치패드 메모 위젯 배선(렌더·IPC·반응형 계약·L-1) ──
test('로드맵 Phase 3·G — 스크래치패드 위젯: 렌더 함수·WIDGET_META·case·하이드레이션·디바운스 저장', () => {
  const CSS = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  // enum 동형(메인/렌더러) — 드리프트 방지.
  assert.ok(HOME_SECTION_IDS.includes('scratchpad'), '렌더러 enum 에 scratchpad');
  // 렌더 함수 + 섹션 디스패치 case + 갤러리 메타.
  assert.ok(/function renderHomeScratchpad\(/.test(APP_SRC), '스크래치패드 렌더 함수');
  assert.ok(/case 'scratchpad':\s*return renderHomeScratchpad\(\)/.test(APP_SRC), 'renderHomeSection case 배선');
  assert.ok(/scratchpad:\s*\{\s*name:/.test(APP_SRC), 'WIDGET_META.scratchpad 메타');
  // 하이드레이션 + 방어 적재.
  assert.ok(/store\.scratchpad\s*=\s*applyScratchpad\(/.test(APP_SRC), 'loadUiState 가 scratchpad 하이드레이션');
  assert.ok(/function applyScratchpad\(/.test(APP_SRC), '방어 적재기(applyScratchpad)');
  // 저장 경로: 디바운스 + blur flush + setScratchpad IPC.
  const sp = fnBody('renderHomeScratchpad', 1600);
  assert.ok(/addEventListener\('input'/.test(sp) && /onScratchpadInput/.test(sp), 'input → 디바운스 저장');
  assert.ok(/addEventListener\('blur'.*flushScratchpad|flushScratchpad/.test(APP_SRC), 'blur flush');
  assert.ok(/ipc\('setScratchpad',\s*text\)/.test(APP_SRC), 'setScratchpad IPC 영속');
  assert.ok(/setTimeout\(commitScratchpad,\s*600\)/.test(APP_SRC), '600ms 디바운스');
  // 반응형/코너 규약: textarea resize:none(위젯 리사이즈 핸들과 충돌 회피) + 높이 채움.
  assert.ok(/\.scratch-input\s*\{[^}]*resize:\s*none/.test(CSS), 'textarea resize:none(§3 코너 규약)');
  assert.ok(/\.scratch-input\s*\{[^}]*flex:\s*1 1 auto/.test(CSS), 'textarea 가 위젯 높이 채움');
  // L-1: 렌더는 el/textContent/value 만(innerHTML 미사용).
  assert.ok(!/renderHomeScratchpad[\s\S]{0,1400}innerHTML/.test(APP_SRC), '스크래치패드 렌더 innerHTML 미사용(L-1)');
});

// ── [로드맵 Phase 3·C] 메일 위젯 밀도 소비(showcase): S=숫자요약 / M=목록(시간숨김) / L=목록+시간 ──
test('로드맵 Phase 3·C — 메일 위젯 밀도 소비: 요약 노드·시간 클래스 렌더 + [data-density] CSS 전환', () => {
  const CSS = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  // 렌더: 밀도 요약 노드(숫자+라벨) + 시간 span 에 mail-time 클래스.
  const mailBody = fnBody('renderHomeMailCard', 5200);
  assert.ok(/cls:\s*'mail-summary'/.test(mailBody), '밀도 숫자 요약 노드(mail-summary)');
  assert.ok(/cls:\s*'mail-summary__num'/.test(mailBody), '요약 숫자(mail-summary__num)');
  assert.ok(/cls:\s*'mail-time'/.test(mailBody), '시간 span 에 mail-time 클래스(밀도별 표시)');
  // CSS: 셀 data-density 로 S=요약만 / M=시간숨김 / L=기본(전부).
  assert.ok(/\.home-section\[data-density="S"\]\s+\.mail-summary\s*\{[^}]*display:\s*flex/.test(CSS), 'S: 숫자 요약 노출');
  assert.ok(/\.home-section\[data-density="S"\]\s+\.mail-list\s*\{[^}]*display:\s*none/.test(CSS), 'S: 목록 숨김(숫자만)');
  assert.ok(/\.home-section\[data-density="M"\]\s+\.mail-time\s*\{[^}]*display:\s*none/.test(CSS), 'M: 시간 숨겨 간결');
  assert.ok(/\.mail-summary\s*\{[^}]*display:\s*none/.test(CSS), '요약은 기본 숨김(S 에서만 노출)');
});

// ── applyHomeLayout (순서 정규화, 메인 normalizeHomeLayout 과 동일 규칙) ──
test('R-32 — applyHomeLayout: 유효 순열은 그대로 유지', () => {
  const input = ['mail', 'attention', 'disk', 'todos', 'shelf', 'activity', 'productivity', 'aiusage', 'shelfWide', 'scratchpad', 'commitHeatmap', 'systemStatus', 'featureAdd'];
  assert.deepStrictEqual(applyHomeLayout(input), input);
});

test('R-32 — applyHomeLayout: 부분 순서는 나머지를 기본 순서로 끝에 보충(항상 10개)', () => {
  const out = applyHomeLayout(['mail', 'todos']);
  assert.strictEqual(out.length, N_SECTIONS);
  assert.deepStrictEqual(out.slice(0, 2), ['mail', 'todos']);
  // 나머지는 기본 순서 유지(중복 없이).
  assert.deepStrictEqual(out, ['mail', 'todos', 'attention', 'productivity', 'activity', 'disk', 'aiusage', 'shelf', 'shelfWide', 'scratchpad', 'commitHeatmap', 'systemStatus', 'featureAdd']);
});

test('R-32 — applyHomeLayout: 화이트리스트 외·중복·비문자열 제거', () => {
  const out = applyHomeLayout(['mail', 'mail', 'bogus', 123, null, 'attention']);
  assert.deepStrictEqual(out.slice(0, 2), ['mail', 'attention']);
  assert.strictEqual(out.length, N_SECTIONS);
  assert.strictEqual(new Set(out).size, N_SECTIONS, '중복 없음');
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
  const body = APP_SRC.slice(start, start + 1200);
  const caseIds = new Set((body.match(/case\s+'([a-zA-Z]+)'/g) || []).map((s) => s.replace(/case\s+'|'/g, '')));
  for (const id of HOME_SECTION_IDS) assert.ok(caseIds.has(id), 'renderHomeSection 누락 섹션: ' + id);
});

// ── [위젯 추가/제거] 위젯 갤러리·hidden 필터 ────────────────────────────────
test('[위젯 추가/제거] TOGGLEABLE_WIDGET_IDS: 렌더러·메인 동형 + featureAdd 제외', () => {
  assert.deepStrictEqual(TOGGLEABLE_WIDGET_IDS, HOME_SECTION_IDS.filter((id) => id !== 'featureAdd'));
  assert.deepStrictEqual(TOGGLEABLE_WIDGET_IDS, realStore.TOGGLEABLE_WIDGET_IDS, '메인 동형(드리프트 0)');
  assert.ok(TOGGLEABLE_WIDGET_IDS.indexOf('featureAdd') < 0, 'featureAdd는 토글 불가(항상 표시)');
});

test('[위젯 추가/제거] masonry가 hidden 위젯을 건너뛰고 featureAdd는 갤러리를 연다', () => {
  // 마소니 순회에서 숨김 위젯 필터.
  assert.ok(/hidden\.indexOf\(id\)\s*>=\s*0\)\s*return/.test(APP_SRC), 'hidden 위젯 skip');
  // featureAdd 카드가 위젯 갤러리를 연다(설정이 아니라).
  const fa = APP_SRC.indexOf('function renderHomeFeatureAdd(');
  const faBody = APP_SRC.slice(fa, fa + 800);
  assert.ok(/showWidgetGallery\s*=\s*true/.test(faBody), 'featureAdd → 갤러리 오픈');
  // 갤러리/추가/제거 핸들러 + IPC 영속 배선.
  assert.ok(/function renderWidgetGallery\(/.test(APP_SRC), '갤러리 렌더 함수');
  assert.ok(/function onAddWidget\(/.test(APP_SRC) && /function onRemoveWidget\(/.test(APP_SRC), '추가/제거 핸들러');
  assert.ok(/ipc\('setHiddenWidgets'/.test(APP_SRC), 'setHiddenWidgets IPC 영속');
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

// ── [홈 위젯 크기] 렌더 배선(정적 소스 검증 — 이 저장소의 렌더러 배선 검증 관례) ──
test('홈 위젯 크기 — 렌더가 콘텐츠 래퍼·리사이즈 핸들·레이아웃 예약을 배선', () => {
  assert.ok(/cls:\s*'home-section__content'/.test(APP_SRC), '콘텐츠 래퍼(.home-section__content) 생성');
  assert.ok(/homeResizeHandle\(id\)/.test(APP_SRC), '리사이즈 핸들 부착(homeResizeHandle)');
  assert.ok(/scheduleHomeMasonryLayout\(\)/.test(APP_SRC), 'DOM 삽입 후 레이아웃 예약 호출');
  // shelfWide 전용 --wide 클래스 제거(이제 grid-column span 으로 처리)
  assert.ok(!/home-section--wide/.test(APP_SRC), '구 column-span(.home-section--wide) 배선 제거');
});

test('홈 위젯 크기 — layoutMasonryGrid 가 열 수·폭/높이 스팬을 적용(메인·그룹 공용)', () => {
  // [Phase 5·M] 실제 배치 로직은 layoutMasonryGrid 로 추출(메인 격자 + 그룹 내부 격자 공용).
  const start = APP_SRC.indexOf('function layoutMasonryGrid(');
  assert.ok(start >= 0, 'layoutMasonryGrid 함수 존재');
  const body = APP_SRC.slice(start, start + 2800);
  assert.ok(/setProperty\('--home-cols'/.test(body), '반응형 열 수(--home-cols) 주입');
  assert.ok(/gridColumnEnd\s*=\s*'span '/.test(body), '폭 = grid-column span 적용');
  assert.ok(/gridRowEnd\s*=\s*'span '/.test(body), '높이 = grid-row span 적용');
  // 메인 격자 + 그룹 격자 모두 배치.
  assert.ok(/querySelectorAll\('\.home-group__grid'\)/.test(APP_SRC), 'layoutHomeMasonry 가 그룹 격자도 배치');
  // [좌측 치우침 보정] 열 수를 아이템 수·최대 스팬으로 캡(적은 아이템도 폭 채움).
  assert.ok(/Math\.min\(computeHomeCols\(contentW\), Math\.max\(1, Math\.max\(count/.test(body), '열 수를 아이템 수로 캡(좌측 치우침 보정)');
});

test('홈 위젯 크기 — 리사이즈 종료 시 setHomeWidgetSizes 로 영속', () => {
  assert.ok(/ipc\('setHomeWidgetSizes'/.test(APP_SRC), 'setHomeWidgetSizes IPC 로 크기 영속');
  assert.ok(/store\._homeResize\s*=\s*\{/.test(APP_SRC), '리사이즈 세션 상태 보관(store._homeResize)');
});

// ── [홈 위젯 반응형] 위젯 내부 UI 가 자기 폭에 반응(컨테이너 쿼리/auto-fit) ──
test('홈 위젯 반응형 — 컨테이너 컨텍스트 + 반응형 훅 클래스 배선', () => {
  const CSS = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  // 각 위젯이 inline-size 컨테이너
  assert.ok(/\.home-section__content\s*\{[^}]*container-type:\s*inline-size/.test(CSS), 'content 가 inline-size 컨테이너');
  // 리스트 다열(auto-fit) + 생산성 스택(@container)
  assert.ok(/\.hw-cols\s*\{[^}]*repeat\(auto-fit/.test(CSS), 'hw-cols auto-fit 다열');
  assert.ok(/@container\s+hw\s*\(max-width:\s*480px\)/.test(CSS), '생산성 스택 컨테이너 쿼리');
  // 렌더가 훅 클래스를 부여
  assert.ok(/cls:\s*'hw-split'/.test(APP_SRC), '생산성 카드에 hw-split');
  assert.ok(/cls:\s*'hw-vrule'/.test(APP_SRC), '생산성 구분선에 hw-vrule');
  assert.ok(/cls:\s*'hw-cols'/.test(APP_SRC), '리스트형 위젯에 hw-cols');
});

// ── [홈 위젯 반응형] 모든 콘텐츠 위젯이 자기 폭에 반응하는지 함수별 배선 검증(위배 0) ──
function fnBody(name, len) {
  const start = APP_SRC.indexOf('function ' + name + '(');
  assert.ok(start >= 0, name + ' 함수가 있어야 한다');
  return APP_SRC.slice(start, start + (len || 2000));
}
test('홈 위젯 반응형 — 목록형 위젯(활동·할 일)이 hw-cols 로 폭 반응(넓으면 다열)', () => {
  assert.ok(/cls:\s*'hw-cols'/.test(fnBody('renderHomeActivity', 900)), '활동 타임라인 목록에 hw-cols');
  assert.ok(/cls:\s*'hw-cols'/.test(fnBody('renderHomeTodos', 1500)), '할 일 목록에 hw-cols');
});
test('홈 위젯 반응형 — 활동 다열 시 세로 연결선 숨김(hw-tl-rail 컨테이너 쿼리)', () => {
  const CSS = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  assert.ok(/cls:\s*'hw-tl-rail'/.test(fnBody('renderHomeActivity', 1400)), '연결선에 hw-tl-rail 클래스');
  assert.ok(/@container\s+hw\s*\(min-width:\s*480px\)\s*\{[^}]*\.hw-tl-rail[^}]*display:\s*none/.test(CSS),
    '다열(min-width:480px)에서 .hw-tl-rail display:none');
});
test('홈 위젯 반응형 — 토큰 사용량 2섹션이 hw-split 로 폭 반응(넓으면 2단, 좁으면 스택)', () => {
  const body = fnBody('renderHomeAiUsage', 6000);
  assert.ok(/cls:\s*'hw-split'/.test(body), 'aiusage 두 섹션을 hw-split 로 배치');
  assert.ok(/cls:\s*'hw-vrule'/.test(body), 'aiusage 세로 구분선(hw-vrule)');
});
test('홈 위젯 반응형 — 셸프 위젯: 좁은 영역용 경량 리스트 UI(@container 로 책장↔리스트 전환)', () => {
  const CSS = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  // display 소유는 클래스(인라인 아님) — 그래야 컨테이너 쿼리로 전환 가능
  assert.ok(/\.shelf-view--full\s*\{[^}]*display:\s*flex/.test(CSS), '풀 뷰(책장) display 는 클래스가 소유');
  assert.ok(/\.shelf-view--compact\s*\{[^}]*display:\s*none/.test(CSS), '경량 뷰 기본 숨김');
  assert.ok(/@container\s+hw\s*\(max-width:\s*440px\)/.test(CSS), '좁은 영역 컨테이너 쿼리(≤440px)');
  assert.ok(/\.shelf-view--full[^}]*display:\s*none/.test(CSS), '좁으면 책장 숨김');
  assert.ok(/\.shelf-view--compact[^}]*display:\s*flex/.test(CSS), '좁으면 경량 리스트 표시');
  // 렌더가 두 뷰 + 경량 행 함수 배선(둘 다 렌더 후 @container 로 택1)
  assert.ok(/cls:\s*'shelf-view shelf-view--full/.test(APP_SRC), 'shelfBody 가 풀 뷰 클래스 부여');
  assert.ok(/cls:\s*'shelf-view shelf-view--compact/.test(APP_SRC), 'shelfBody 가 경량 뷰 클래스 부여');
  assert.ok(/function shelfCompactList\(/.test(APP_SRC) && /function shelfCompactRow\(/.test(APP_SRC), '경량 리스트/행 함수 존재');
  // 셸프 풀 뷰(shelf-row)는 인라인 display 를 두지 않는다(클래스가 소유해야 전환됨)
  const sb = fnBody('shelfBody', 1500);
  assert.ok(/shelf-view--full[\s\S]*?style:\s*'position:relative;gap:6px/.test(sb), '풀 뷰 인라인 style 에 display 미포함');
});
test('홈 위젯 반응형/높이 — 메일 위젯: 카드가 위젯 높이를 채우고 목록이 높이에 반응', () => {
  const CSS = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  // .mail-region 이 카드를 세로로 늘림(카드 fill)
  assert.ok(/\.mail-region\s*\{[^}]*display:\s*flex/.test(CSS), 'mail-region flex 컬럼');
  // [회귀 가드] mail-region 을 display:block 으로 되돌리는 후속 규칙이 없어야(카드 채움 무력화 방지).
  assert.ok(!/\.mail-region\s*\{[^}]*display:\s*block/.test(CSS), 'mail-region 를 block 으로 재선언하는 규칙 없음');
  assert.ok(/\.mail-region\s*>\s*\*\s*\{[^}]*flex:\s*1 1 auto/.test(CSS), 'mail-region 자식(카드) 높이 채움');
  // 기본은 목록 캡, 높이 조절 시 채움
  assert.ok(/\.mail-list\s*\{[^}]*max-height:\s*264px[^}]*overflow-y:\s*auto/.test(CSS), '기본 목록 max-height 캡+스크롤');
  assert.ok(/\.home-section__content--sized\s+\.mail-list\s*\{[^}]*max-height:\s*none[^}]*flex:\s*1 1 auto/.test(CSS), '높이 조절 시 목록이 카드 채움');
  // 렌더: 카드 flex 컬럼 + 목록 mail-list 클래스
  const body = fnBody('renderHomeMailCard', 2400);
  assert.ok(/flex-direction:column/.test(body), '메일 카드 flex 컬럼');
  assert.ok(/cls:\s*'hw-cols mail-list'/.test(body), '메일 목록에 mail-list 클래스');
  // layoutMasonryGrid 가 사용자 높이 지정 시 --sized 표식 토글
  const lm = fnBody('layoutMasonryGrid', 2800);
  assert.ok(/classList\.add\('home-section__content--sized'\)/.test(lm), '사이즈 지정 시 --sized 부여');
  assert.ok(/classList\.remove\('home-section__content--sized'\)/.test(lm), '미지정 시 --sized 제거');
});

// ── [로드맵 Phase 2] 대시보드(프리셋) 렌더러 배선 ──────────────────────────
test('로드맵 Phase 2 — applyDashboard: 방어 적재(부재→기본, dangling active 폴백, id 중복 제거)', () => {
  // 부재/손상 → 단일 기본 프리셋
  for (const bad of [null, undefined, {}, { presets: [] }, { presets: 'x' }, 7]) {
    const d = applyDashboard(bad);
    assert.strictEqual(d.presets.length, 1);
    assert.strictEqual(d.activePreset, d.presets[0].id);
  }
  // 유효 → id/name 보존, dangling active → 첫 프리셋
  const d = applyDashboard({ activePreset: 'ghost', presets: [{ id: 'a', name: 'A' }, { id: 'a', name: 'dup' }, { id: 'b', name: 'B', layoutMode: 'freeform' }] });
  assert.deepStrictEqual(d.presets.map((p) => p.id), ['a', 'b'], 'id 중복 제거');
  assert.strictEqual(d.activePreset, 'a', 'dangling active → 첫 프리셋');
  assert.strictEqual(d.presets[1].layoutMode, 'freeform');
});

test('로드맵 Phase 2 — 렌더러 배선: 프리셋 탭 + 전환/추가 핸들러 + dashboard 하이드레이션', () => {
  const CSS = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  assert.ok(/cls:\s*'preset-tabs'/.test(APP_SRC), '프리셋 탭 바(preset-tabs)');
  assert.ok(/function onSwitchPreset\(/.test(APP_SRC) && /function onAddPreset\(/.test(APP_SRC), '전환/추가 핸들러');
  assert.ok(/function applyPresetResponse\(/.test(APP_SRC), '프리셋 응답 적용기');
  assert.ok(/store\.dashboard\s*=\s*applyDashboard\(/.test(APP_SRC), 'loadUiState 가 dashboard 하이드레이션');
  assert.ok(/ipc\('setActivePreset'/.test(APP_SRC) && /ipc\('addPreset'/.test(APP_SRC), '프리셋 IPC 호출');
  assert.ok(/\.preset-tab\.is-on\s*\{/.test(CSS), '활성 탭 스타일');
});

// ── [로드맵 Phase 1] 위젯 편집 모드 토글 배선 ──────────────────────────────
test('로드맵 Phase 1 — 편집 모드: 토글 버튼 + masonry --editing 클래스 + 상시 노출 CSS', () => {
  const CSS = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  // 렌더: 편집 토글 버튼(store.editMode 토글) + 켜짐 시 masonry 에 --editing 클래스
  assert.ok(/cls:\s*'home-editmode'/.test(APP_SRC), '편집 모드 토글 버튼(home-editmode)');
  assert.ok(/store\.editMode\s*=\s*!store\.editMode/.test(APP_SRC), '버튼이 store.editMode 토글');
  assert.ok(/home-masonry'\s*\+\s*\(editing\s*\?\s*'\s*home-masonry--editing'/.test(APP_SRC), '편집 시 masonry--editing 클래스 부여');
  // CSS: 편집 모드에서 핸들·제거·셀 윤곽 상시 노출
  assert.ok(/\.home-masonry--editing\s+\.home-resize\s*\{[^}]*opacity/.test(CSS), '편집 시 리사이즈 핸들 노출');
  assert.ok(/\.home-masonry--editing\s+\.widget-remove\s*\{[^}]*opacity:\s*1/.test(CSS), '편집 시 제거 버튼 노출');
  assert.ok(/\.home-editmode\.is-on\s*\{/.test(CSS), '토글 on 상태 스타일');
});

// ── [로드맵 Phase 1·K] 대시보드 내보내기/가져오기 렌더러 배선 ──────────────
test('로드맵 Phase 1·K — 렌더러: 편집 모드 내보내기/가져오기 버튼 + IPC + 정규화 응답 적용', () => {
  // 편집 모드에서만 노출 + 백엔드 IPC 존재 가드.
  assert.ok(/editing\s*&&\s*bridgeHas\('exportDashboard'\)/.test(APP_SRC), '편집 모드 & export IPC 가드로 내보내기 버튼');
  assert.ok(/editing\s*&&\s*bridgeHas\('importDashboard'\)/.test(APP_SRC), '편집 모드 & import IPC 가드로 가져오기 버튼');
  // 모달 열기/닫기 + 렌더 배선.
  assert.ok(/function openDashboardIO\(/.test(APP_SRC) && /function closeDashboardIO\(/.test(APP_SRC), '모달 열기/닫기 핸들러');
  assert.ok(/function renderDashboardIOModal\(/.test(APP_SRC), '모달 렌더 함수');
  assert.ok(/store\.dashIO\s*&&\s*store\.dashIO\.open\)\s*app\.appendChild\(renderDashboardIOModal/.test(APP_SRC), 'render 에서 모달 마운트');
  // 내보내기: exportDashboard IPC + 복사/파일저장 경로.
  assert.ok(/ipc\('exportDashboard'\)/.test(APP_SRC), 'exportDashboard IPC 호출');
  assert.ok(/ipc\('copyText',\s*json\)/.test(APP_SRC), '내보내기 JSON 클립보드 복사');
  assert.ok(/new Blob\(\[json\]/.test(APP_SRC), '내보내기 JSON 파일 저장(Blob)');
  // 가져오기: importDashboard IPC + 정규화 응답을 applyPresetResponse 로 반영(활성 프리셋 스왑).
  assert.ok(/ipc\('importDashboard',\s*json\)/.test(APP_SRC), 'importDashboard IPC 호출(메인 정규화 단일 신뢰 경계)');
  assert.ok(/applyPresetResponse\(res\)/.test(fnBody('onDashImportApply', 900)), '가져오기 성공 시 applyPresetResponse 로 반영');
  // 파일 선택 → FileReader 로 텍스트 적재(로컬 파일만).
  assert.ok(/function onDashImportFile\(/.test(APP_SRC) && /readAsText\(file\)/.test(APP_SRC), '파일 선택 시 FileReader 텍스트 적재');
  // L-1: 모달은 textContent/el 헬퍼만(innerHTML 미사용).
  assert.ok(!/renderDashboardIOModal[\s\S]{0,1600}innerHTML/.test(APP_SRC), '모달은 innerHTML 미사용(L-1)');
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
