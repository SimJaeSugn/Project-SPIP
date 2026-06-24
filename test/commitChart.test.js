'use strict';
/**
 * commitChart.test.js — R-33 SVG 자작 커밋 차트(헤드리스 F-3).
 *   commitChartModel(순수: 수치 sanitize·스케일·기하) + M-2 보안 정적 검증(textContent·Number 가드·
 *   고정 팔레트 setAttribute·외부 의존 0) + RG.widget 'commitChart' 등록.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { commitChartModel, commitActivityKey, tipLeft } = require('../public/app.js');
const APP_SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const CSS_SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');

// ── [M10-DG-1] commitActivityKey (diff 가드, epoch-day prefix + count 시퀀스) ──
test('M10-DG-1 — 동일 count·동일 마지막날짜 → 동일 키', () => {
  const a = { days: [{ date: '2026-06-20', count: 1 }, { date: '2026-06-24', count: 3 }] };
  const b = { days: [{ date: '2026-06-20', count: 1 }, { date: '2026-06-24', count: 3 }] };
  assert.strictEqual(commitActivityKey(a), commitActivityKey(b));
});

test('M10-DG-1 — count 1개 변경 → 다른 키', () => {
  const a = { days: [{ date: '2026-06-24', count: 3 }] };
  const b = { days: [{ date: '2026-06-24', count: 4 }] };
  assert.notStrictEqual(commitActivityKey(a), commitActivityKey(b));
});

test('M10-DG-1 — count 동일·마지막 날짜 1일 이동(epoch-day) → 다른 키(날짜창 이동 감지)', () => {
  const a = { days: [{ date: '2026-06-23', count: 5 }] };
  const b = { days: [{ date: '2026-06-24', count: 5 }] };
  assert.notStrictEqual(commitActivityKey(a), commitActivityKey(b));
});

test('M10-DG-1 — NaN/음수 count → 0 정규화(M-2)', () => {
  const a = { days: [{ date: '2026-06-24', count: NaN }, { date: '2026-06-24', count: -3 }] };
  const k = commitActivityKey(a);
  assert.ok(/\|0,0$/.test(k), '0,0 으로 정규화: ' + k);
});

test('M10-DG-1 — Date.parse 실패(잘못된 date) → epochDay=0', () => {
  const a = { days: [{ date: 'not-a-date', count: 2 }] };
  assert.strictEqual(commitActivityKey(a), '0|2');
});

test('M10-DG-1 — 빈/비배열 → 빈 문자열', () => {
  assert.strictEqual(commitActivityKey({ days: [] }), '');
  assert.strictEqual(commitActivityKey(null), '');
  assert.strictEqual(commitActivityKey({}), '');
});

test('M10-DG-1 — 키는 정수만 포함(L-1/M-2: 날짜·라벨 문자열 미진입)', () => {
  const k = commitActivityKey({ days: [{ date: '2026-06-24', count: 3 }, { date: '2026-06-24', count: 0 }] });
  assert.ok(/^[0-9]+\|[0-9,]+$/.test(k), '정수·쉼표·파이프만: ' + k);
});

// ── [M10-TT-1] tipLeft (툴팁 가로위치 순수 계산, 경계 클램핑) ──
test('M10-TT-1 — 좌측 끝 막대 → left=0 클램핑', () => {
  // 막대 중심 비율 ~0(맨 왼쪽). svgLeft=wrapLeft=0, svgWidth=240, tipWidth=80.
  const left = tipLeft(0.07, 0, 240, 0, 240, 80);
  assert.strictEqual(left, 0, '음수 rawLeft → 0 클램핑');
});

test('M10-TT-1 — 우측 끝 막대 → maxLeft 클램핑', () => {
  const left = tipLeft(0.93, 0, 240, 0, 240, 80);
  assert.strictEqual(left, 240 - 80, 'maxLeft=wrapWidth-tipWidth');
});

test('M10-TT-1 — 중앙 막대 → 중심 정렬(클램핑 안 됨)', () => {
  // centerRatio=0.5 → rawLeft = 0.5*240 - 40 = 80. maxLeft=160. 클램핑 없이 80.
  const left = tipLeft(0.5, 0, 240, 0, 240, 80);
  assert.strictEqual(left, 80);
});

test('M10-TT-1 — tipWidth >= wrapWidth → maxLeft=0 가드', () => {
  const left = tipLeft(0.5, 0, 240, 0, 100, 200);
  assert.strictEqual(left, 0, '음수 maxLeft 방지(0)');
});

test('M10-TT-1 — 비정상 입력 graceful(NaN → 기본값)', () => {
  assert.strictEqual(typeof tipLeft(NaN, 0, NaN, 0, NaN, NaN), 'number');
});

// ── 정적: 툴팁 세로 띄움 유지(F-3b) ──
test('M10-P1 — showTip 가 left(px) + translateY(-100%) 분리 설정(세로 띄움 유지)', () => {
  const start = APP_SRC.indexOf('const showTip = () =>');
  assert.ok(start >= 0, 'showTip 클로저가 있어야 한다');
  const body = APP_SRC.slice(start, start + 700);
  assert.ok(/tip\.style\.left\s*=/.test(body), 'left 픽셀 설정');
  assert.ok(/translateY\(-100%\)/.test(body), 'translateY(-100%) 세로 띄움 유지');
  assert.ok(!/transform\s*=\s*'none'/.test(body), "transform='none' 으로 덮지 않음(F-3b)");
});

test('M10-P1 — CSS .commit-chart__tip 에서 left:50%/translateX(-50%) 제거', () => {
  const m = CSS_SRC.match(/\.commit-chart__tip\s*\{[^}]*\}/);
  assert.ok(m, '.commit-chart__tip 규칙 존재');
  assert.ok(!/left:\s*50%/.test(m[0]), 'left:50% 제거');
  assert.ok(!/translateX/.test(m[0]), 'translateX 제거');
});

// ── commitChartModel: 수치 sanitize / 스케일 ─────────────────────────────
test('R-33 — 빈/비배열 입력은 7칸 0 막대(graceful, 기간 동일)', () => {
  for (const input of [[], null, undefined, 'x', {}]) {
    const m = commitChartModel(input);
    assert.strictEqual(m.bars.length, 7, '항상 7 막대');
    assert.strictEqual(m.maxCount, 0);
    m.bars.forEach((b) => assert.strictEqual(b.count, 0));
  }
});

test('R-33 — NaN/Infinity/음수/비수치 count 는 0으로 클램프(M-2)', () => {
  const m = commitChartModel([
    { count: NaN }, { count: Infinity }, { count: -5 }, { count: 'abc' },
    { count: null }, { count: undefined }, { count: 3 },
  ]);
  const counts = m.bars.map((b) => b.count);
  assert.deepStrictEqual(counts, [0, 0, 0, 0, 0, 0, 3]);
  assert.strictEqual(m.maxCount, 3);
});

test('R-33 — 문자열 수치 count 는 Number() 변환(유효 시 사용)', () => {
  // 입력 2개는 뒤쪽 2칸(앞 5칸 0 패딩): index 5='4', index 6='0'.
  const m = commitChartModel([{ count: '4' }, { count: '0' }]);
  assert.strictEqual(m.bars[5].count, 4, "'4' → 4");
  assert.strictEqual(m.bars[6].count, 0, "'0' → 0");
  assert.strictEqual(m.maxCount, 4);
});

test('R-33 — 막대 높이는 maxCount 기준 비례·baseline 안에(스케일 정확)', () => {
  const m = commitChartModel([{ count: 0 }, { count: 5 }, { count: 10 }], { width: 200, height: 100, pad: 4 });
  const bars = m.bars;
  const maxBar = bars[bars.length - 1]; // count 10 = max
  const midBar = bars[bars.length - 2]; // count 5
  // 최대 막대 높이 = usableH(baseline-pad)에 근접, 중간은 절반 근사.
  assert.ok(maxBar.h > midBar.h, '큰 count 가 더 높다');
  assert.ok(Math.abs(midBar.h - maxBar.h / 2) < 1, '5는 10의 절반 높이 근사');
  // 모든 막대가 차트 영역 안(y>=0, y+h<=baseline+오차).
  bars.forEach((b) => {
    assert.ok(b.y >= 0, 'y>=0');
    assert.ok(b.y + b.h <= m.baseline + 0.5, '바닥(baseline) 안');
    assert.ok(b.x >= 0 && b.x + b.w <= m.viewW + 0.5, 'x 범위 안');
  });
});

test('R-33 — 7칸 초과 입력은 최근 7개만(maxBars), 미만은 앞을 0으로 패딩', () => {
  const many = commitChartModel(Array.from({ length: 12 }, (_, i) => ({ count: i })));
  assert.strictEqual(many.bars.length, 7);
  assert.strictEqual(many.bars[6].count, 11, '최근값 유지');
  const few = commitChartModel([{ count: 9 }]);
  assert.strictEqual(few.bars.length, 7);
  assert.strictEqual(few.bars[6].count, 9, '마지막 칸에 실제값');
  assert.strictEqual(few.bars[0].count, 0, '앞은 0 패딩');
});

test('R-33 — label 은 문자열만 보존(비문자열은 빈 문자열)', () => {
  const m = commitChartModel([{ count: 1, label: '월' }, { count: 2, label: 123 }, { count: 3 }]);
  assert.strictEqual(m.bars[4].label, '월');
  assert.strictEqual(m.bars[5].label, '');
  assert.strictEqual(m.bars[6].label, '');
});

test('R-33 — isLast 는 마지막 막대만 true(오늘 강조용)', () => {
  const m = commitChartModel([{ count: 1 }, { count: 2 }]);
  assert.strictEqual(m.bars[m.bars.length - 1].isLast, true);
  assert.strictEqual(m.bars[0].isLast, false);
});

// ── M-2 보안 정적 검증(chartBars 빌더) ───────────────────────────────────
function chartBarsBody() {
  const start = APP_SRC.indexOf('function chartBars(');
  assert.ok(start >= 0, 'chartBars 함수가 있어야 한다');
  const end = APP_SRC.indexOf('function dot(', start);
  return APP_SRC.slice(start, end > start ? end : start + 3000);
}

test('R-33 M-2 — 라벨/툴팁은 textContent 만(innerHTML/insertAdjacentHTML 0)', () => {
  const body = chartBarsBody();
  assert.ok(/\.textContent\s*=/.test(body), 'textContent 사용');
  assert.ok(!/innerHTML/.test(body), 'innerHTML 금지');
  assert.ok(!/insertAdjacentHTML/.test(body), 'insertAdjacentHTML 금지');
});

test('R-33 M-2 — 색은 고정 팔레트(CHART_PALETTE)에서 setAttribute, 데이터 직접 인터폴레이션 0', () => {
  const body = chartBarsBody();
  assert.ok(/CHART_PALETTE/.test(APP_SRC), 'CHART_PALETTE 고정 팔레트 정의');
  assert.ok(/setAttribute\('fill',\s*CHART_PALETTE/.test(body) || /setAttribute\('fill',\s*baseFill\)/.test(body),
    'fill 은 팔레트 상수에서');
  // 치수도 모델값(String(b.x) 등)으로 — 데이터 문자열을 속성에 직접 결합하지 않음.
  assert.ok(/setAttribute\('width',\s*String\(b\.w\)\)/.test(body), 'width 는 모델 수치');
});

test('R-33 M-2 — 외부 리소스 0(xlink:href/외부 url 금지)', () => {
  const body = chartBarsBody();
  assert.ok(!/xlink:href/.test(body), 'xlink:href 금지');
  assert.ok(!/https?:\/\//.test(body), '외부 url 금지');
});

test('R-33 — chartBars 는 { node, destroy } 반환(핸들러 detach)', () => {
  const body = chartBarsBody();
  assert.ok(/return\s*\{\s*node,\s*destroy\s*\}/.test(body), '{ node, destroy } 반환');
  assert.ok(/removeEventListener/.test(body), 'destroy 가 핸들러 detach');
});

test('R-33 — RG.widget commitChart 등록(render destroy/recreate)', () => {
  assert.ok(/id:\s*'commitChart'/.test(APP_SRC), "RG.widget.define({id:'commitChart'})");
  assert.ok(/\.commit-chart-host/.test(APP_SRC), 'init 이 .commit-chart-host 를 찾는다');
  assert.ok(/inst\.destroy\(\)/.test(APP_SRC), 'destroy 가 인스턴스 destroy 호출');
});
