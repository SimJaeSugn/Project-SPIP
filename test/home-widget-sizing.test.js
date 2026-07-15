'use strict';
/**
 * home-widget-sizing.test.js — [6조합 반응형 계약] 홈 위젯의 최소 크기 + 무잘림 배선 검증(헤드리스·정적 소스).
 *
 * CLAUDE.md UI 규약: 모든 위젯은 최소 가로·세로 크기를 갖고, 그 최소를 기준으로
 *   (1,1)(1,2)(1,3)(1,4)(2,1)(3,1) 각 크기에서 잘림 없는 반응형 UI를 가져야 한다.
 * 렌더러 UI 는 헤드리스 시각검증이 불가하므로(브리지 부재), 여기서는 계약을 강제하는
 *   구조적 배선(순수 로직 + 정적 CSS/소스)을 검증한다:
 *   ① 위젯별 최소 높이(homeWidgetMinH) 하한  ② 강제 높이 시 잘림 대신 내부 스크롤(hw-body/hw-cardscroll)
 *   ③ 카드가 높이를 채우는 flex 세로 구조 + 헤더/푸터 고정.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const app = require('../public/app.js');
const { homeWidgetMinH, HOME_WIDGET_MIN_H, applyHomeWidgetSizes, TOGGLEABLE_WIDGET_IDS, homeHRow } = app;
const APP_SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const CSS = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
const HOME_H_MIN = 120;

function fnBody(name, len) {
  const start = APP_SRC.indexOf('function ' + name + '(');
  assert.ok(start >= 0, name + ' 함수가 있어야 한다');
  return APP_SRC.slice(start, start + (len || 2500));
}

// ── ① 위젯별 최소 높이(리사이즈 하한) ────────────────────────────────────────
test('6조합 — homeWidgetMinH: 지정 위젯은 전역 하한(120)보다 큰 최소 높이', () => {
  // 감사에서 산정한 위젯별 최소 높이(핵심 콘텐츠가 잘리지 않는 하한).
  assert.strictEqual(homeWidgetMinH('attention'), 190);
  assert.strictEqual(homeWidgetMinH('productivity'), 240);
  assert.strictEqual(homeWidgetMinH('aiusage'), 210);
  assert.strictEqual(homeWidgetMinH('commitHeatmap'), 200);
  assert.strictEqual(homeWidgetMinH('systemStatus'), 150);
  assert.strictEqual(homeWidgetMinH('explorer'), 190);
  assert.strictEqual(homeWidgetMinH('shelf'), 300);
  assert.strictEqual(homeWidgetMinH('shelfWide'), 300);
});
test('6조합 — homeWidgetMinH: 미지정 위젯(mail·scratchpad)·미지 id 는 전역 하한 120', () => {
  assert.strictEqual(homeWidgetMinH('mail'), HOME_H_MIN);
  assert.strictEqual(homeWidgetMinH('scratchpad'), HOME_H_MIN);
  assert.strictEqual(homeWidgetMinH('nope'), HOME_H_MIN);
  assert.strictEqual(homeWidgetMinH(undefined), HOME_H_MIN);
});
test('6조합 — 모든 토글 위젯의 최소 높이 ≥ 120, 값은 유한 정수', () => {
  for (const id of TOGGLEABLE_WIDGET_IDS) {
    const h = homeWidgetMinH(id);
    assert.ok(Number.isFinite(h) && h >= HOME_H_MIN, id + ' 최소 높이 ≥ 120');
  }
});

// ── ② applyHomeWidgetSizes 가 위젯별 최소 높이로 올려 클램프(렌더 경로 하한) ──
test('6조합 — applyHomeWidgetSizes: 최소 미만 높이는 위젯별 최소로 상향 클램프', () => {
  const r = applyHomeWidgetSizes({
    disk: { w: 1, h: 10 },        // → 160
    attention: { w: 1, h: 100 },  // → 170
    shelf: { w: 1, h: 50 },       // → 240
    mail: { w: 1, h: 130 },       // 그대로(130 ≥ 120)
  });
  assert.strictEqual(r.disk.h, homeWidgetMinH('disk'));
  assert.strictEqual(r.attention.h, homeWidgetMinH('attention'));
  assert.strictEqual(r.shelf.h, homeWidgetMinH('shelf'));
  assert.strictEqual(r.mail.h, 130);
});
test('6조합 — applyHomeWidgetSizes: 자동 높이(h:null)는 최소 클램프 대상 아님', () => {
  const r = applyHomeWidgetSizes({ attention: { w: 2, h: null } });
  assert.strictEqual(r.attention.h, null);
});

// ── 리사이즈 핸들이 위젯별 최소 높이를 하한으로 사용(정적 소스) ──
test('6조합 — onHomeResizeMove 가 homeWidgetMinH 를 높이 하한으로 사용', () => {
  const body = fnBody('onHomeResizeMove', 700);
  assert.ok(/Math\.max\(\s*homeWidgetMinH\(r\.id\)/.test(body), '높이 하한이 위젯별 최소(homeWidgetMinH)');
});

// ── 높이 행 단계(homeHRow) — (·,1)(·,2)... 조합을 위한 높이 tier ──
test('6조합 — homeHRow: 자동 높이/0/음수 → 0(행 단계 없음, 상세 UI)', () => {
  assert.strictEqual(homeHRow('shelf', null), 0);
  assert.strictEqual(homeHRow('shelf', 0), 0);
  assert.strictEqual(homeHRow('shelf', -10), 0);
  assert.strictEqual(homeHRow('shelf', undefined), 0);
});
test('6조합 — homeHRow: 최소 높이=1행, 배수마다 행 증가, 상한 4', () => {
  assert.strictEqual(homeHRow('shelf', 300), 1);     // = 최소(300) → 1행
  assert.strictEqual(homeHRow('shelf', 320), 1);     // 최소 근방 → 여전히 1행
  assert.strictEqual(homeHRow('shelf', 600), 2);     // 2배 → 2행
  assert.strictEqual(homeHRow('shelf', 900), 3);
  assert.strictEqual(homeHRow('shelf', 5000), 4);    // 상한 클램프
  assert.strictEqual(homeHRow('mail', 120), 1);      // mail 최소 120
  assert.strictEqual(homeHRow('mail', 240), 2);
});
test('6조합 — setHomeCellHRow 가 masonry/freeform 배치에서 셀에 [data-hrow] 부여', () => {
  // [MD-EXP-1] 펼침 셀은 자연 높이라 hrow 를 자동(undefined)으로 — forceAuto ? undefined : sz.h.
  assert.ok(/setHomeCellHRow\(cell, id, forceAuto \? undefined : sz\.h\)/.test(fnBody('layoutMasonryGrid', 2800)), 'masonry 에서 hrow 부여');
  assert.ok(/setHomeCellHRow\(cell, id, forceAuto \? undefined : sz\.h\)/.test(fnBody('layoutHomeFreeform', 3000)), 'freeform 에서 hrow 부여');
});

// ── ③ 무잘림 공통 CSS 패턴 ───────────────────────────────────────────────────
test('6조합 — CSS: hw-card(세로 flex + overflow 백스톱)', () => {
  assert.ok(/\.hw-card\s*\{[^}]*flex-direction:\s*column/.test(CSS), 'hw-card 세로 flex');
  assert.ok(/\.hw-card\s*\{[^}]*overflow:\s*hidden/.test(CSS), 'hw-card overflow 백스톱');
});
test('6조합 — CSS: 높이 지정(--sized) 시 본문(hw-body)이 내부 스크롤(잘림 대신)', () => {
  assert.ok(/\.home-section__content--sized\s+\.hw-body\s*\{[^}]*overflow-y:\s*auto/.test(CSS),
    '--sized 상태에서 hw-body 세로 스크롤');
  assert.ok(/\.home-section__content--sized\s+\.hw-body\s*\{[^}]*flex:\s*1 1 auto/.test(CSS),
    '--sized 상태에서 hw-body 가 남는 높이 차지');
});
test('6조합 — CSS: 카드 전체 스크롤 변형(hw-cardscroll)도 --sized 에서 세로 스크롤', () => {
  assert.ok(/\.home-section__content--sized\s+\.hw-cardscroll\s*\{[^}]*overflow-y:\s*auto/.test(CSS),
    '--sized 상태에서 hw-cardscroll 세로 스크롤');
});

// ── ④ 위젯별 렌더 배선 — 위반 위젯이 무잘림 구조를 갖췄는지 ──────────────────
test('6조합 — attention/activity/todos/disk: 카드 hw-card + 목록 hw-body', () => {
  for (const fn of ['renderHomeAttention', 'renderHomeActivity', 'renderHomeTodos', 'renderHomeDisk']) {
    const body = fnBody(fn, 2800);
    assert.ok(/cls:\s*'hw-card'/.test(body), fn + ' 카드에 hw-card');
    assert.ok(/hw-cols hw-body/.test(body), fn + ' 목록에 hw-body');
  }
});
test('6조합 — commitHeatmap/systemStatus: 카드 hw-card(격자·미터 스크롤 흡수)', () => {
  assert.ok(/cls:\s*'hw-card'/.test(fnBody('renderHomeCommitHeatmap', 900)), '히트맵 카드에 hw-card');
  assert.ok(/cls:\s*'hw-card'/.test(fnBody('renderHomeSystemStatus', 900)), '시스템 상태 카드에 hw-card');
  assert.ok(/cls:\s*'sysstat-body hw-body'/.test(fnBody('renderHomeSystemStatus', 1500)), '시스템 상태 본문에 hw-body');
});
test('6조합 — productivity/aiusage: 카드 전체 스크롤(hw-cardscroll — 차트 툴팁 보존)', () => {
  assert.ok(/cls:\s*'hw-split hw-cardscroll'/.test(fnBody('renderHomeProductivity', 400)), '생산성 카드 hw-cardscroll');
  assert.ok(/cls:\s*'hw-cardscroll'/.test(fnBody('renderHomeAiUsage', 900)), '토큰 사용량 카드 hw-cardscroll');
});
test('6조합 — heatmap: 격자(.heatmap-scroll)가 --sized 에서 세로 스크롤(가로 스크롤 유지)', () => {
  assert.ok(/\.home-section__content--sized\s+\.heatmap-scroll\s*\{[^}]*overflow-y:\s*auto/.test(CSS),
    '히트맵 격자 세로 스크롤');
});
test('6조합 — systemStatus: 넓은 폭(@container ≥520px)에서 미터 다열 그리드(가로 활용)', () => {
  assert.ok(/@container hw \(min-width:\s*520px\)[\s\S]{0,160}\.sysstat-body\s*\{[^}]*display:\s*grid/.test(CSS),
    '넓으면 sysstat-body 그리드');
});
test('6조합 — mail: 높이 지정(--sized) 시 좁아도(S) 큰 숫자 대신 스크롤 목록 노출', () => {
  assert.ok(/data-density="S"\]\s+\.home-section__content--sized\s+\.mail-list\s*\{[^}]*display:\s*grid/.test(CSS),
    'S+sized 에서 mail-list 노출');
  assert.ok(/data-density="S"\]\s+\.home-section__content--sized\s+\.mail-summary\s*\{[^}]*display:\s*none/.test(CSS),
    'S+sized 에서 큰 숫자 요약 숨김');
});
test('6조합 — shelf: 카드 flex 세로 + 본문(.shelf-body)만 남는 높이 차지 + --sized 스크롤', () => {
  assert.ok(/flex-direction:column/.test(fnBody('renderShelfCard', 700)), '셸프 카드 flex 세로');
  assert.ok(/cls:\s*'shelf-body'[\s\S]{0,80}flex:1 1 auto/.test(fnBody('shelfBody', 400)), '셸프 본문 flex:1 1 auto');
  assert.ok(/\.home-section__content--sized\s+\.shelf-body\s*\{[^}]*overflow-y:\s*auto/.test(CSS),
    '셸프 본문 --sized 세로 스크롤');
});
test('6조합 — shelf 1행(data-hrow=1): 책장만 접어 간략 목록으로(입력은 유지)', () => {
  // 렌더: 컴포저·푸터에 타깃 클래스 부여.
  assert.ok(/cls:\s*'shelf-composer'/.test(fnBody('shelfComposer', 200)), '컴포저에 shelf-composer');
  assert.ok(/cls:\s*'shelf-foot'/.test(fnBody('shelfFooter', 200)), '푸터에 shelf-foot');
  // CSS: 1행에서 책장(full) 숨기고 간략 목록(compact) 노출 — 폭과 무관.
  assert.ok(/\.home-section\[data-hrow="1"\]\s+\.shelf-view--full\s*\{[^}]*display:\s*none/.test(CSS),
    '1행에서 책장(full) 숨김');
  assert.ok(/\.home-section\[data-hrow="1"\]\s+\.shelf-view--compact\s*\{[^}]*display:\s*grid/.test(CSS),
    '1행에서 간략 목록(compact) 노출');
});
test('6조합 — shelf: region 2단 래핑이 flex 패스스루(카드가 높이를 채워 목록 스크롤 작동)', () => {
  assert.ok(/\.shelf-region\s*\{[^}]*flex-direction:\s*column/.test(CSS), 'shelf-region 세로 flex');
  assert.ok(/\.shelf-region\s*>\s*\*\s*\{[^}]*flex:\s*1 1 auto/.test(CSS), 'shelf-region 자식(카드) flex:1');
});
test('6조합 — shelf 간략 목록이 넓으면 다열(auto-fit 그리드로 가로 공간 활용)', () => {
  assert.ok(/\.shelf-view--compact\s*\{[^}]*grid-template-columns:\s*repeat\(auto-fit/.test(CSS),
    '간략 목록 auto-fit 다열');
});
test('6조합 — shelf 추가 기능(입력 컴포저): 모든 크기에서 노출(높이로 숨기지 않음)', () => {
  // 어떤 높이(1행 포함)에서도 '추가'가 가능해야 한다 → 컴포저를 숨기는 규칙이 아예 없어야 한다.
  assert.ok(!/\.shelf-composer\s*\{[^}]*display:\s*none/.test(CSS),
    '무조건적 컴포저 숨김 규칙 없음');
  assert.ok(!/\[data-hrow[^\]]*\]\s+\.shelf-composer\b[\s\S]{0,60}display:\s*none/.test(CSS),
    'hrow(높이) 기반 컴포저 숨김 규칙 없음 → 1:2·1:3·1:4 에서도 입력 노출');
});
test('6조합 — shelf 1:3·1:4(data-hrow 3·4): 간략 행 강화(배너 썸네일 확대 + 설명 메타 노출)', () => {
  // 렌더: 썸네일/메타 클래스 배선 + 배너 이미지·설명 데이터 활용.
  const body = fnBody('shelfCompactRow', 2200);
  assert.ok(/cls:\s*'shelf-crow__thumb/.test(body), '행 썸네일 클래스');
  assert.ok(/p\.bannerImage/.test(body) && /cls:\s*'shelf-crow__img'/.test(body), '배너 있으면 이미지 썸네일');
  assert.ok(/cls:\s*'shelf-crow__meta'/.test(body) && /p\.desc\s*\|\|\s*p\.cat/.test(body), '설명/카테고리 메타 줄');
  // CSS: 기본 숨김, 세로(hrow 3·4) 또는 가로(density M·L) 여유가 커지면 메타 노출 + 썸네일 확대.
  assert.ok(/\.shelf-crow__meta\s*\{\s*display:\s*none/.test(CSS), '메타 기본 숨김');
  assert.ok(/\.shelf-crow__meta\s*\{[^}]*display:\s*none[\s\S]*?display:\s*block/.test(CSS), '여유 시 메타 display:block 규칙 존재');
  assert.ok(/\[data-hrow="3"\]\s+\.shelf-crow__meta/.test(CSS), '세로(1:3) 트리거로 메타');
  assert.ok(/\[data-density="L"\]\s+\.shelf-crow__meta/.test(CSS), '가로(넓음) 트리거로 메타');
  // 확대는 실제 배너 이미지(--img)만 — 아이콘(색 배지)은 확대하지 않는다.
  assert.ok(/\.shelf-crow__thumb--img[\s\S]{0,180}width:\s*52px/.test(CSS), '여유 시 배너 이미지만 52px 확대');
  assert.ok(/\[data-density="L"\]\s+\.shelf-crow__thumb--img/.test(CSS), '가로(넓음) 트리거로 배너 이미지 확대');
  assert.ok(!/\[data-(hrow|density)[^\]]*\]\s+\.shelf-crow__thumb\s*\{[^}]*width:\s*52px/.test(CSS),
    '아이콘 배지(.shelf-crow__thumb 단독)는 확대 규칙 없음');
});
test('6조합 — shelf 좁은 목록 모드의 추가 UI 간결화(유형 라벨 접고 입력 슬림)', () => {
  assert.ok(/cls:\s*'shelf-ctype'/.test(fnBody('shelfComposer', 1800)), '유형 행에 shelf-ctype');
  assert.ok(/cls:\s*'shelf-cbox'/.test(fnBody('shelfComposer', 1800)), '입력 박스에 shelf-cbox');
  assert.ok(/@container hw \(max-width:\s*440px\)[\s\S]*?\.shelf-ctype__lbl\s*\{[^}]*display:\s*none/.test(CSS),
    '좁으면 유형 라벨 접힘');
  assert.ok(/@container hw \(max-width:\s*440px\)[\s\S]*?\.shelf-cbox\s*\{[^}]*height:\s*40px/.test(CSS),
    '좁으면 입력 박스 슬림');
});
