'use strict';
/**
 * orbit-pick.test.js — 궤도 맵 노드 클릭(상세 드로어 미열림 회귀).
 *
 * 원 버그: 노드를 클릭해도 상세 패널이 열리지 않는다.
 *   노드 반지름은 최소 6px인데 판정이 '그린 원 + 5px'뿐이었고, 노드는 회전·요동으로 매 프레임
 *   움직인다. 그래서 (a) 눈으로는 점 위인데 커서가 가장자리를 스쳐 히트 실패, (b) 누르고 떼는
 *   사이 노드가 커서 밑을 빠져나가 click 시점 재판정이 null → 클릭이 통째로 삼켜졌다.
 * 계약: 최소 픽 반경(ORB_PICK_MIN) 보장 + 겹치면 최근접 노드 + mousedown 래치(pressId) 폴백.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { orbPick, ORB_PICK_MIN } = require('../public/app.js');
const APP_SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

const node = (id, x, y, r) => ({ id, _x: x, _y: y, _r: r });

test('궤도 픽 — 노드 중심 클릭은 당연히 잡힌다', () => {
  assert.strictEqual(orbPick([node('a', 100, 100, 6)], 100, 100), 'a');
});

test('궤도 픽 — 최소 픽 반경: 작은 점(r=6)의 가장자리 밖 12px도 잡힌다(원 버그)', () => {
  const nodes = [node('a', 100, 100, 6)];
  // 그린 원(6) + 옛 여유(5) = 11px 밖 → 예전 판정은 null 이었다.
  assert.strictEqual(orbPick(nodes, 112, 100), 'a');
  assert.ok(ORB_PICK_MIN >= 12, '최소 픽 반경은 12px 이상');
});

test('궤도 픽 — 픽 반경 밖은 여전히 null(빈 곳 클릭 = 포커스 해제 경로 보존)', () => {
  assert.strictEqual(orbPick([node('a', 100, 100, 6)], 100 + ORB_PICK_MIN + 2, 100), null);
});

test('궤도 픽 — 큰 노드는 자기 반지름(+5)만큼 넓게 잡힌다', () => {
  assert.strictEqual(orbPick([node('big', 100, 100, 30)], 133, 100), 'big');
  assert.strictEqual(orbPick([node('big', 100, 100, 30)], 140, 100), null);
});

test('궤도 픽 — 겹치면 가장 가까운 노드를 고른다(뒤 노드가 앞 노드를 가로채지 않음)', () => {
  const nodes = [node('near', 100, 100, 6), node('far', 108, 100, 6)];
  assert.strictEqual(orbPick(nodes, 101, 100), 'near');
  assert.strictEqual(orbPick(nodes, 107, 100), 'far');
});

test('궤도 픽 — 아직 그려지지 않은 노드(_x 없음)는 건너뛴다', () => {
  const nodes = [{ id: 'unpainted' }, node('a', 100, 100, 6)];
  assert.strictEqual(orbPick(nodes, 100, 100), 'a');
  assert.strictEqual(orbPick([{ id: 'unpainted' }], 0, 0), null);
  assert.strictEqual(orbPick(null, 0, 0), null);
});

// ── 라벨 박스(2순위 표적) — 사람은 점이 아니라 이름을 겨냥한다 ──
// 라벨은 점 아래 중앙에 그려진다: 폭 200px 라벨의 오른쪽을 가리키면 점은 좌상단(11시)으로 ~70px 떨어져 있다.
const withLabel = (id, x, y, r, lw, lh) =>
  Object.assign(node(id, x, y, r), { _lx: x - lw / 2, _ly: y + r + 5, _lw: lw, _lh: lh });

test('궤도 픽 — 이름 라벨 위를 가리켜도 그 노드가 잡힌다(원 버그: 11시 방향 1~2cm 어긋남)', () => {
  const n = withLabel('a', 400, 300, 6, 200, 12);
  // 라벨 오른쪽 끝 부근(점에서 좌상단으로 한참 떨어진 지점) — 예전엔 아무것도 안 잡혔다.
  assert.strictEqual(orbPick([n], 495, 313), 'a');
  assert.strictEqual(orbPick([n], 305, 313), 'a'); // 라벨 왼쪽 끝
});

test('궤도 픽 — 라벨 박스 밖은 null(빈 곳 클릭 보존)', () => {
  const n = withLabel('a', 400, 300, 6, 200, 12);
  assert.strictEqual(orbPick([n], 520, 313), null); // 라벨 오른쪽 바깥
  assert.strictEqual(orbPick([n], 495, 340), null); // 라벨 아래쪽 바깥
});

test('궤도 픽 — 점이 라벨보다 우선(점 위에 있으면 겹친 이웃 라벨에 뺏기지 않음)', () => {
  const dot = node('dot', 400, 300, 6);
  const other = withLabel('other', 300, 260, 6, 240, 12); // 라벨이 dot 위를 지나가도록
  assert.strictEqual(orbPick([other, dot], 400, 300), 'dot');
});

// ── 배선(정적 소스) — 클릭 경로가 픽·래치를 실제로 쓰는지 ──
test('궤도 클릭 배선 — orbHitTest 는 순수 orbPick 에 위임한다', () => {
  assert.match(APP_SRC, /function orbHitTest\(mx, my\)[\s\S]{0,160}orbPick\(m\.nodes, mx, my\)/);
});

test('궤도 클릭 배선 — mousedown 에서 pressId 래치, click 에서 폴백으로 드로어 열기', () => {
  assert.match(APP_SRC, /orb\.pressId = orbHitTest\(m\.x, m\.y\)/, 'mousedown 이 누른 노드를 래치');
  assert.match(APP_SRC, /const id = orbHitTest\(m\.x, m\.y\) \|\| pressId;[\s\S]{0,120}openDrawer\(id\)/,
    'click 은 재판정 실패 시 래치된 노드로 상세를 연다');
});

test('궤도 클릭 배선 — 렌더 루프가 라벨 박스(_lx/_ly/_lw/_lh)를 매 프레임 기록한다', () => {
  assert.match(APP_SRC, /n\._lx = x - lw \/ 2; n\._ly = lTop; n\._lw = lw; n\._lh = lfs \+ 2;/);
});

// ── 배율 보정 — body { zoom } 하에서 클릭 좌표가 캔버스 그리기 공간(레이아웃 px)으로 정규화되는지 ──
// 원 버그: pos() 가 getBoundingClientRect(줌 좌표)만 써서, 배율≠1 이면 원점에서 멀수록(노드 위치)·배율에
//   비례해 히트가 어긋났다. 계약: clientWidth/rect.width 비율로 되돌려 위치·배율과 무관하게 정확.
test('궤도 배율 보정 — pos()가 clientWidth/rect.width 비율로 포인터 좌표를 정규화한다', () => {
  assert.match(APP_SRC, /const sx = r\.width \? canvas\.clientWidth \/ r\.width : 1;/);
  assert.match(APP_SRC, /const sy = r\.height \? canvas\.clientHeight \/ r\.height : 1;/);
  assert.match(APP_SRC, /return \{ x: \(e\.clientX - r\.left\) \* sx, y: \(e\.clientY - r\.top\) \* sy \};/);
});

// ── 배율 보정(하단 여백) — .orbit 는 100vh 를 재지정하지 않는다(.app-root 가 이미 zoom 보정) ──
const CSS_SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
test('궤도 레이아웃 — .orbit 는 height:100% 를 쓴다(100vh 금지 — 배율 시 하단 여백 방지)', () => {
  const m = CSS_SRC.match(/\.orbit \{[^}]*\}/);
  assert.ok(m, '.orbit 규칙이 존재한다');
  assert.match(m[0], /height:\s*100%/, '.orbit 는 height:100% 로 .app-root 를 채운다');
  assert.doesNotMatch(m[0], /height:\s*100vh/, '.orbit 에 100vh 재지정 금지');
});
