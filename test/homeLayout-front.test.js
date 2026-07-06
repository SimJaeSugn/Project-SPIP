'use strict';
/**
 * homeLayout-front.test.js — R-32 프런트엔드(홈 섹션 드래그·데이터-주도 배치, 헤드리스 F-3).
 *   applyHomeLayout(순수 순서 정규화) + HOME_SECTION_IDS(메인 계약 동형) + 정적 배선 검증.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { HOME_SECTION_IDS, applyHomeLayout, TOGGLEABLE_WIDGET_IDS, applyHomeWidgetSizes, computeHomeCols, homeDefaultSpan, HOME_MAX_COLS } = require('../public/app.js');
const realStore = require('../lib/common/uiStateStore');
const APP_SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
// 메인 계약(단일 신뢰 경계)과 동형인지 교차 확인.
const STORE_SRC = fs.readFileSync(path.join(__dirname, '..', 'lib', 'common', 'uiStateStore.js'), 'utf8');

// ── HOME_SECTION_IDS 계약 동형 ────────────────────────────────────────────
// [SH-2] 셸프 위젯 2변형('shelf','shelfWide')을 featureAdd 앞에 추가 → 10섹션 enum.
const N_SECTIONS = 10;
test('R-32 — HOME_SECTION_IDS: 10섹션 enum(배열 순서 = 기본 순서)', () => {
  assert.deepStrictEqual(HOME_SECTION_IDS,
    ['attention', 'productivity', 'activity', 'todos', 'mail', 'disk', 'aiusage', 'shelf', 'shelfWide', 'featureAdd']);
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

// ── applyHomeLayout (순서 정규화, 메인 normalizeHomeLayout 과 동일 규칙) ──
test('R-32 — applyHomeLayout: 유효 순열은 그대로 유지', () => {
  const input = ['mail', 'attention', 'disk', 'todos', 'shelf', 'activity', 'productivity', 'aiusage', 'shelfWide', 'featureAdd'];
  assert.deepStrictEqual(applyHomeLayout(input), input);
});

test('R-32 — applyHomeLayout: 부분 순서는 나머지를 기본 순서로 끝에 보충(항상 10개)', () => {
  const out = applyHomeLayout(['mail', 'todos']);
  assert.strictEqual(out.length, N_SECTIONS);
  assert.deepStrictEqual(out.slice(0, 2), ['mail', 'todos']);
  // 나머지는 기본 순서 유지(중복 없이).
  assert.deepStrictEqual(out, ['mail', 'todos', 'attention', 'productivity', 'activity', 'disk', 'aiusage', 'shelf', 'shelfWide', 'featureAdd']);
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
  const body = APP_SRC.slice(start, start + 700);
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

test('홈 위젯 크기 — layoutHomeMasonry 가 열 수·폭/높이 스팬을 적용', () => {
  const start = APP_SRC.indexOf('function layoutHomeMasonry(');
  assert.ok(start >= 0, 'layoutHomeMasonry 함수 존재');
  const body = APP_SRC.slice(start, start + 1700);
  assert.ok(/setProperty\('--home-cols'/.test(body), '반응형 열 수(--home-cols) 주입');
  assert.ok(/gridColumnEnd\s*=\s*'span '/.test(body), '폭 = grid-column span 적용');
  assert.ok(/gridRowEnd\s*=\s*'span '/.test(body), '높이 = grid-row span 적용');
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
  // layoutHomeMasonry 가 사용자 높이 지정 시 --sized 표식 토글
  const lm = fnBody('layoutHomeMasonry', 1700);
  assert.ok(/classList\.add\('home-section__content--sized'\)/.test(lm), '사이즈 지정 시 --sized 부여');
  assert.ok(/classList\.remove\('home-section__content--sized'\)/.test(lm), '미지정 시 --sized 제거');
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
