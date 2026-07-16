'use strict';
/**
 * postit-theme.test.js — 포스트잇 테마(PT-*) 배선·스킨 회귀 고정
 *
 * 라이트/다크/시스템에 이은 4번째 테마 'postit'(코르크보드 + 스티키노트 홈 스킨)을 추가했다.
 *   ─ 축: store.theme 값 'postit'. 정규화(렌더러 normalizeUiState + 메인 uiStateStore)·적용(resolveTheme)·
 *          설정 토글·커맨드팔레트가 모두 postit 을 통과시켜야 한다.
 *   ─ 스킨: :root[data-theme="postit"] 아래에서만 홈을 재도장(앱 크롬 무변화). 인라인 HOME_CARD 를 덮는
 *          종이 노트 override(!important), 코르크 배경, 압정(::before), 손글씨 제목, 다크 히어로 배너, Gaegu @font-face.
 *   ─ 계약: 라이트/다크/시스템 동작 무변화(스킨 규칙은 전부 postit 스코프). L-1(textContent) 유지.
 *
 * 정적 소스/순수 로직 대조 — 렌더러 GUI 는 헤드리스 검증 불가라 배선·규칙 존재로 회귀를 고정한다.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const APP = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const CSS = fs.readFileSync(path.join(ROOT, 'public', 'styles.css'), 'utf8');
const store = require(path.join(ROOT, 'lib', 'common', 'uiStateStore.js'));

/* ── 정규화(메인·렌더러) ─────────────────────────────────────────────── */

test('PT-1 — 메인 uiStateStore: theme=postit 통과, 미지값은 system 폴백', () => {
  assert.strictEqual(store.normalizeState({ theme: 'postit' }).theme, 'postit', 'postit 허용');
  assert.strictEqual(store.normalizeState({ theme: 'light' }).theme, 'light', '기존 라이트 무변화');
  assert.strictEqual(store.normalizeState({ theme: 'dark' }).theme, 'dark', '기존 다크 무변화');
  assert.strictEqual(store.normalizeState({ theme: 'system' }).theme, 'system', '기존 시스템 무변화');
  assert.strictEqual(store.normalizeState({ theme: 'bogus' }).theme, 'system', '미지값 폴백');
});

test('PT-1 — 렌더러 normalizeUiState 가 theme=postit 를 통과시킨다', () => {
  assert.ok(/r\.theme === 'system' \|\| r\.theme === 'postit'\) \? r\.theme : 'system'/.test(APP),
    'normalizeUiState theme 클램프에 postit 포함');
});

/* ── 적용·전환 배선 ──────────────────────────────────────────────────── */

test('PT-2 — resolveTheme 이 postit 을 data-theme 값으로 직접 반환(system 해석 대상 아님)', () => {
  assert.ok(/store\.theme === 'postit'\) return store\.theme/.test(APP), 'resolveTheme postit 직접 반환');
});

test('PT-2 — onSetTheme 이 postit 을 수용', () => {
  assert.ok(/theme === 'system' \|\| theme === 'postit'\) \? theme : 'system'/.test(APP), 'onSetTheme postit 수용');
});

test('PT-3 — 설정 테마 토글에 포스트잇 옵션', () => {
  assert.ok(/\['postit', '포스트잇', store\.theme === 'postit', \(\) => onSetTheme\('postit'\)\]/.test(APP),
    'segToggle 에 postit 항목');
});

test('PT-3 — 커맨드팔레트 테마 전환 목록에 postit + onSetTheme 호출(존재하지 않는 setTheme 참조 아님)', () => {
  assert.ok(/\['light', 'dark', 'system', 'postit'\]\.forEach/.test(APP), '팔레트 테마 목록에 postit');
  assert.ok(/run: function \(\) \{ onSetTheme\(t\); \}/.test(APP), '팔레트가 onSetTheme 호출');
  assert.ok(!/run: function \(\) \{ setTheme\(t\); \}/.test(APP), '미정의 setTheme 참조 제거');
});

/* ── @font-face (Gaegu 로컬 번들) ────────────────────────────────────── */

test('PT-4 — Gaegu @font-face 로컬 번들(CDN 금지·CSP font-src self) — 한글·라틴 서브셋', () => {
  assert.ok(/@font-face\s*\{[^}]*font-family:\s*'Gaegu'[^}]*gaegu-korean-700-normal\.woff2/.test(CSS),
    'Gaegu 한글 700 로컬 woff2');
  assert.ok(/gaegu-latin-400-normal\.woff2/.test(CSS) && /gaegu-latin-700-normal\.woff2/.test(CSS),
    'Gaegu 라틴 400·700');
  assert.ok(/gaegu-korean-400-normal\.woff2/.test(CSS), 'Gaegu 한글 400');
  // CDN 참조 금지(로컬 Electron·무CDN 규칙).
  assert.ok(!/fonts\.googleapis\.com/.test(CSS) && !/cdn\.jsdelivr\.net/.test(CSS), '폰트 CDN 참조 없음');
});

test('PT-4 — Gaegu woff2 자산이 실제로 번들되어 있다', () => {
  const dir = path.join(ROOT, 'public', 'fonts', 'gaegu');
  for (const f of ['gaegu-korean-400-normal.woff2', 'gaegu-korean-700-normal.woff2',
                   'gaegu-latin-400-normal.woff2', 'gaegu-latin-700-normal.woff2']) {
    const p = path.join(dir, f);
    assert.ok(fs.existsSync(p) && fs.statSync(p).size > 1000, '폰트 파일 존재+비어있지 않음: ' + f);
  }
  assert.ok(fs.existsSync(path.join(dir, 'OFL.txt')), 'OFL 라이선스 동봉');
});

/* ── 홈 스킨 규칙(전부 postit 스코프 — 타 테마 무영향) ──────────────────── */

/** postit 스코프 CSS 만 잘라낸다(회귀 대조 범위 한정). */
function postitScope() {
  const i = CSS.indexOf('포스트잇 테마 (data-theme="postit")');
  assert.ok(i >= 0, '포스트잇 스킨 섹션 마커');
  return CSS.slice(i);
}

test('PT-5 — 스킨 규칙은 전부 :root[data-theme="postit"] 스코프(라이트/다크 회귀 0)', () => {
  const seg = postitScope();
  // 코르크·노트·압정·제목·히어로 규칙이 모두 postit 스코프 안에서 정의된다.
  for (const sel of ['.home-masonry', '.home-section__content > *', '.home-section::before', '.hw-title', '.briefing-widget']) {
    const re = new RegExp(':root\\[data-theme="postit"\\][^{]*' + sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    assert.ok(re.test(seg), 'postit 스코프 규칙: ' + sel);
  }
});

test('PT-5 — 코르크보드 배경 + 종이 노트 override(인라인 HOME_CARD 를 !important 로 덮음)', () => {
  const seg = postitScope();
  assert.ok(/radial-gradient\(130% 120% at 25% 5%, #d8b478/.test(seg), '코르크 방사 그라데이션');
  assert.ok(/\.home-section__content > \*,[\s\S]*?linear-gradient\(170deg, color-mix[\s\S]*?var\(--paper[\s\S]*?!important/.test(seg),
    '종이 배경 override(!important)');
  assert.ok(/color-mix\(in srgb, var\(--paper/.test(seg), 'color-mix 종이 색조');
});

test('PT-5b — 종이 카드가 내부 콘텐츠를 라운드 모서리에 클립(모서리 불투명 방지)', () => {
  // .hw-card 가 아닌 위젯(마크다운 편집기·탐색기 등)은 자체 overflow:hidden 이 없어 꽉 찬 흰 배경이
  //   둥근 모서리 밖으로 사각으로 삐져나온다 → 카드에서 일괄 overflow:hidden 으로 클립.
  assert.ok(/\.home-section__content > \*,[\s\S]*?overflow: hidden !important/.test(postitScope()),
    '종이 카드 overflow:hidden 클립');
});

test('PT-5c — 코르크 배경이 홈 대시보드 영역 전체(.dash__main--home)에 적용', () => {
  const seg = postitScope();
  assert.ok(/\.dash__main--home\s*\{[\s\S]*?radial-gradient\(130% 120% at 25% 5%, #d8b478[\s\S]*?!important/.test(seg),
    '홈 스크롤 영역 전체 코르크(!important)');
  // 홈 main 에 마커 클래스가 붙어야 스코프가 성립(프로젝트 대시보드 뷰는 제외).
  assert.ok(/cls: 'dash__main dash__main--home spip-scroll'/.test(APP), '홈 main 에 dash__main--home 마커');
  // masonry 는 중첩 코르크 박스를 피하려 투과.
  assert.ok(/\.home-masonry,\s*\n?\s*:root\[data-theme="postit"\] \.home-group__grid\s*\{\s*background: transparent/.test(seg)
    || /\.home-masonry,[\s\S]*?background: transparent;/.test(seg), 'masonry 투과');
});

test('PT-5d — 메일·즐겨찾기(2단 래핑) 모서리도 종이로 클립 — 래퍼 투과 + 안쪽 카드 종이', () => {
  const seg = postitScope();
  // 안쪽 카드가 종이 도장 대상에 포함(content > region > *).
  assert.ok(/\.home-section__content > \.mail-region > \*/.test(seg) && /\.home-section__content > \.shelf-region > \*/.test(seg),
    '메일·즐겨찾기 안쪽 카드 종이 대상');
  // 래퍼(region)는 투과 — 배경/그림자/클립을 걷어낸다(안쪽 카드가 종이·클립을 소유).
  assert.ok(/\.home-section__content > \.mail-region,[\s\S]*?\.shelf-region\s*\{[\s\S]*?background: transparent !important[\s\S]*?overflow: visible !important/.test(seg),
    '래퍼 투과(배경 투명·overflow visible)');
});

test('PT-5 — 압정(::before)·테이프(3n::after)는 셀에 얹어 콘텐츠 클립을 피한다', () => {
  const seg = postitScope();
  assert.ok(/\.home-masonry > \.home-section::before\s*\{[\s\S]*?border-radius: 50%/.test(seg), '압정 원형');
  assert.ok(/nth-child\(3n\)::after/.test(seg), '3n 테이프');
  assert.ok(/nth-child\(6n\+1\)\s*\{ --paper: #feee86/.test(seg), '노트 색조 순환 팔레트');
});

test('PT-6 — 손글씨 제목(.hw-title) + 히어로 다크 배너(브리핑 서브트리 변수 재정의)', () => {
  const seg = postitScope();
  assert.ok(/\.hw-title[\s\S]*?font-family: var\(--hw-note-font\)/.test(seg), '제목 손글씨 폰트');
  assert.ok(/--hw-note-font:\s*'Gaegu'/.test(seg), 'Gaegu 노트 폰트 토큰');
  assert.ok(/\.briefing-widget\s*\{[\s\S]*?--t1: #ffffff[\s\S]*?radial-gradient\(135% 135% at 80% -10%, #241f1a/.test(seg),
    '브리핑 다크 배너 + 텍스트 변수 밝게 재정의');
});

test('PT-7 — hw-title 클래스 훅이 핵심 위젯 제목에 배선(손글씨 대상)', () => {
  // 공유 헬퍼 + 개별 위젯 제목이 hw-title 을 단다.
  assert.ok(/cls: 'hw-title', text: text/.test(APP), 'homeTitle 헬퍼 hw-title');
  const titles = APP.match(/cls: 'hw-title', text: widgetCardTitle/g) || [];
  assert.ok(titles.length >= 6, '핵심 위젯 제목 다수에 hw-title (>=6), 실제=' + titles.length);
});

test('PT-8 — L-1 유지: 스킨은 클래스/CSS 로만 — 홈 렌더에 innerHTML 도입 없음', () => {
  // 이번 변경으로 홈 위젯 렌더 영역에 innerHTML 주입이 생기지 않았는지(스킨은 순수 CSS/클래스) 확인.
  const s = APP.indexOf('var HOME_CARD =');
  const e = APP.indexOf('/* ===== [MD 편집기 위젯] 끝');
  assert.ok(s >= 0 && e > s, '홈 영역 마커');
  assert.ok(!/\.innerHTML\s*=/.test(APP.slice(s, e)), '홈 렌더 영역 innerHTML 대입 없음');
});
