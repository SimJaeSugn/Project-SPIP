'use strict';
/**
 * home-theme.test.js — 홈 대시보드 다크 테마 대응(HT-1)
 *
 * 홈 위젯은 과거 "라이트 전용"으로 인라인/클래스에 색을 하드코딩해 다크에서 대부분 흰색으로 남았다.
 * 중립색(배경·테두리·글자·표면·accent)을 테마 변수(var(--…))로 옮겨 라이트 무변화·다크 반영이 되게 했다.
 * 정적 소스 대조로 회귀를 고정한다(의미색 amber/green/blue/red·흰 글자는 유지가 정상).
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const APP = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const CSS = fs.readFileSync(path.join(ROOT, 'public', 'styles.css'), 'utf8');

/** 홈 위젯 렌더 영역(카드 상수 ~ md 편집기 끝)만 잘라낸다. */
function homeRegion() {
  const s = APP.indexOf('var HOME_CARD =');
  const e = APP.indexOf('/* ===== [MD 편집기 위젯] 끝');
  assert.ok(s >= 0 && e > s, '홈 영역 마커');
  return APP.slice(s, e);
}

test('HT-1 — HOME_CARD 상수가 테마 변수(패널·테두리)를 쓴다', () => {
  assert.ok(/var HOME_CARD = 'background:var\(--panel\);border:1px solid var\(--border\);/.test(APP),
    'HOME_CARD 는 var(--panel)/var(--border)');
  assert.ok(/style: 'background:var\(--bg\);color:var\(--t1\);/.test(APP), '홈 메인 배경/글자도 변수');
});

test('HT-1 — 홈 영역에 themed 되어야 할 중립색 하드코딩이 없다(라이트 무변화·다크 반영)', () => {
  const r = homeRegion();
  assert.ok(!/background:\s*#fff\b/.test(r), '카드/패널 배경은 var(--panel)');
  assert.ok(!/color:\s*#1c1917\b/.test(r), '본문 글자는 var(--t1)');
  assert.ok(!/#f6f6f5\b/.test(r), '페이지 배경은 var(--bg)');
  assert.ok(!/#e7e5e4\b/.test(r), '테두리는 var(--border)');
  assert.ok(!/#78716c\b/.test(r) && !/#57534e\b/.test(r) && !/#a8a29e\b/.test(r), '글자 그레이는 var(--t2/t3/t4)');
  // 흰 글자(색 대비용)·의미색은 유지가 정상.
  assert.ok(/color:#fff\b/.test(r), '유색 배경 위 흰 글자는 유지');
  assert.ok(/#b45309\b/.test(r) && /#15803d\b/.test(r), '상태 의미색(amber/green)은 유지');
});

test('HT-1 — 테마 변수 정의가 온전하다(자기참조 없음·이중 래핑 정리)', () => {
  assert.ok(/--panel:\s*#fff;/.test(CSS) && /--bg:\s*#f6f6f5;/.test(CSS), ':root 라이트 변수 정의 유지');
  assert.ok(/:root\[data-theme="dark"\]\s*\{[\s\S]*--panel:\s*#1c1917;/.test(CSS), '다크 변수 정의 유지');
  // 커스텀 프로퍼티가 자기 자신을 참조하지 않는다(치환이 정의 블록을 건드리면 테마가 깨진다).
  assert.ok(!/--(panel|bg|border|t1|t2|t3|t4|surface-[23]|accent[a-z-]*):\s*var\(/.test(CSS), '변수 정의 자기참조 0');
  assert.ok(!/var\(--[a-z0-9-]+,\s*var\(--[a-z0-9-]+\)\)/.test(CSS), '이중 var 래핑 아티팩트 0');
});

test('HT-1 — 다크에서 묻히는 반전 칩(preset-tab.is-on)에 다크 오버라이드', () => {
  assert.ok(/:root\[data-theme="dark"\]\s*\.preset-tab\.is-on\s*\{[^}]*background:\s*var\(--t1\)/.test(CSS),
    '활성 대시보드 탭 다크 반전');
});

test('HT-2 — 메모(scratchpad): 기본·포커스 배경이 모두 테마 변수(포커스 아웃 시 흰색 방지)', () => {
  const m = /\.scratch-input\s*\{([^}]*)\}/.exec(CSS);
  assert.ok(m, '.scratch-input 규칙');
  assert.ok(/background:\s*var\(--/.test(m[1]), '기본 배경 테마 변수(#fcfcfb 같은 고정색 금지)');
  assert.ok(!/#f[0-9a-fA-F]{5}/.test(m[1]), '기본 배경에 고정 흰색조 없음');
  assert.ok(/\.scratch-input:focus\s*\{[^}]*background:\s*var\(--/.test(CSS), '포커스 배경도 테마 변수');
});

test('HT-2 — 즐겨찾기(shelf): 렌더 영역에 테마 미적용 중립 색조·반전칩 잔재 없음', () => {
  const a = APP.indexOf('function renderHomeShelf(');
  const b = APP.indexOf('function renderDashboard()');
  assert.ok(a >= 0 && b > a, '셸프 렌더 영역');
  const seg = APP.slice(a, b);
  for (const shade of ['#f2f1ef', '#fafaf9', '#c0bdb8', '#f3f2f0', '#e2e0dd', '#f7f7f6', '#fcfcfb']) {
    assert.ok(seg.indexOf(shade) < 0, '테마 미적용 색조 잔재: ' + shade);
  }
  // 반전 칩은 다크에서 묻히므로 var(--t1)/var(--bg) 반전으로 — 인라인 background:#1c1917 금지.
  assert.ok(!/background:\s*#1c1917/.test(seg), '반전 칩 배경은 var(--t1) 반전(고정 #1c1917 금지)');
  assert.ok(/background:var\(--t1\);color:var\(--bg\)/.test(seg), '반전 칩이 테마 반전(밝은 칩+어두운 글자)');
});
