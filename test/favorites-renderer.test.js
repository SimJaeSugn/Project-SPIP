'use strict';
/**
 * favorites-renderer.test.js — M7 프론트 순수 로직(DOM 비의존).
 *
 * 대상:
 *   public/app.js   — computeFlip(FLIP rect diff·R-23)·focusGate(SEC-H2)·favoritesChangedView(SEC-M2)
 *                     + dispatchTrayAction 축소(R4) 회귀
 *   public/favorites.js — 위젯 렌더러 순수 로직: favoriteWidgetViewModels·widgetCardVm·
 *                     nextSlideIndex·focusGate·favoritesChangedView·langColor
 *
 * 계약: docs/architecture/m7-design.html §5(focus 게이팅·SEC-M2)·§6.1(favorites-changed payload)·
 *       §8.1(onTray dashboard만·R4)·§9.2(FLIP dx/dy)·§7(favorites∩스냅샷 교집합).
 * 보안: XSS — name/path 는 변형/이스케이프 없이 보존(textContent 전제 L-1).
 */
const { test } = require('node:test');
const assert = require('node:assert');

const app = require('../public/app.js');
const fav = require('../public/favorites.js');

/* ─────────────── R-23: computeFlip (FLIP rect diff·dx/dy) ─────────────── */
const rect = (left, top) => ({ left, top });

test('computeFlip: dx = prev.left - now.left, dy = prev.top - now.top (§9.2)', () => {
  const first = new Map([['a', rect(100, 50)], ['b', rect(0, 0)]]);
  const last = new Map([['a', rect(0, 0)], ['b', rect(100, 50)]]);
  const out = app.computeFlip(first, last, false);
  // a: 0,0 → invert (100-0, 50-0); b: invert (0-100, 0-50)
  assert.deepStrictEqual(out.find((x) => x.id === 'a'), { id: 'a', dx: 100, dy: 50 });
  assert.deepStrictEqual(out.find((x) => x.id === 'b'), { id: 'b', dx: -100, dy: -50 });
});

test('computeFlip: prefers-reduced-motion(reduce=true) → 빈 배열(전이 0)', () => {
  const first = new Map([['a', rect(100, 50)]]);
  const last = new Map([['a', rect(0, 0)]]);
  assert.deepStrictEqual(app.computeFlip(first, last, true), []);
});

test('computeFlip: 이동 없음(dx=dy=0) skip', () => {
  const first = new Map([['a', rect(10, 20)]]);
  const last = new Map([['a', rect(10, 20)]]);
  assert.deepStrictEqual(app.computeFlip(first, last, false), []);
});

test('computeFlip: 신규 카드(이전 rect 부재) skip', () => {
  const first = new Map(); // a 가 이전에 없었음
  const last = new Map([['a', rect(0, 0)]]);
  assert.deepStrictEqual(app.computeFlip(first, last, false), []);
});

test('computeFlip: 비-Map 입력 graceful(빈 배열)', () => {
  assert.deepStrictEqual(app.computeFlip(null, null, false), []);
  assert.deepStrictEqual(app.computeFlip(undefined, new Map(), false), []);
});

/* ─────────────── SEC-H2: focusGate ─────────────── */
test('focusGate: focused=true → 액션 허용', () => {
  assert.deepStrictEqual(app.focusGate(true), { allow: true, focusOnly: false });
});
test('focusGate: focused=false → 액션 차단·포커스만(첫 클릭)', () => {
  assert.deepStrictEqual(app.focusGate(false), { allow: false, focusOnly: true });
});
test('focusGate: 비boolean → 비포커스로 안전 처리', () => {
  assert.deepStrictEqual(app.focusGate(undefined), { allow: false, focusOnly: true });
  assert.deepStrictEqual(app.focusGate(1), { allow: false, focusOnly: true });
});
test('focusGate: app.js 와 favorites.js 동형(동일 계약)', () => {
  assert.deepStrictEqual(app.focusGate(true), fav.focusGate(true));
  assert.deepStrictEqual(app.focusGate(false), fav.focusGate(false));
});

/* ─────────────── SEC-M2: favoritesChangedView (push payload 정규화) ─────────────── */
test('favoritesChangedView: { favorites:string[] } 만 통과(문자열 필터)', () => {
  assert.deepStrictEqual(app.favoritesChangedView({ favorites: ['a', 1, null, 'b'] }), ['a', 'b']);
  assert.deepStrictEqual(app.favoritesChangedView({ favorites: [] }), []); // 빈 배열은 유효(전부 해제)
});
test('favoritesChangedView: 손상/비배열/비객체 → null(상태 유지)', () => {
  assert.strictEqual(app.favoritesChangedView(null), null);
  assert.strictEqual(app.favoritesChangedView({}), null);
  assert.strictEqual(app.favoritesChangedView({ favorites: 'x' }), null);
  assert.strictEqual(app.favoritesChangedView('x'), null);
});
test('favoritesChangedView: app.js 와 favorites.js 동형', () => {
  const p = { favorites: ['a', 'b'] };
  assert.deepStrictEqual(app.favoritesChangedView(p), fav.favoritesChangedView(p));
});

/* ─────────────── 위젯 뷰모델 (favorites ∩ 스냅샷 교집합) ─────────────── */
const PROJECTS = [
  { id: 'a', name: 'Alpha', path: 'E:\\a', language: { primary: 'JavaScript' } },
  { id: 'b', name: 'Beta', path: 'E:\\b', language: { primary: 'Python' } },
  { id: 'c', name: 'Gamma', path: 'E:\\c' },
];

test('favoriteWidgetViewModels: favorites 순서로 교집합(소멸 id skip)', () => {
  const out = fav.favoriteWidgetViewModels(PROJECTS, ['c', 'zzz', 'a']);
  assert.deepStrictEqual(out.map((p) => p.id), ['c', 'a']);
});
test('favoriteWidgetViewModels: 빈/비배열 graceful', () => {
  assert.deepStrictEqual(fav.favoriteWidgetViewModels(PROJECTS, []), []);
  assert.deepStrictEqual(fav.favoriteWidgetViewModels(null, ['a']), []);
  assert.deepStrictEqual(fav.favoriteWidgetViewModels(PROJECTS, null), []);
});
test('favoriteWidgetViewModels: 중복 favorites 첫 등장만', () => {
  const out = fav.favoriteWidgetViewModels(PROJECTS, ['a', 'a', 'b']);
  assert.deepStrictEqual(out.map((p) => p.id), ['a', 'b']);
});

test('widgetCardVm: 계약 매핑 + name/path/language 폴백', () => {
  const v = fav.widgetCardVm({ id: 'a', name: 'Alpha', path: 'E:\\a', language: { primary: 'Go' } });
  assert.deepStrictEqual(v, { id: 'a', name: 'Alpha', path: 'E:\\a', language: 'Go', git: '—' });
  const empty = fav.widgetCardVm({ id: 'x' });
  assert.strictEqual(empty.name, '(이름 없음)');
  assert.strictEqual(empty.path, '');
  assert.strictEqual(empty.language, '알 수 없음');
});
test('widgetCardVm: 비객체 graceful', () => {
  const v = fav.widgetCardVm(null);
  assert.strictEqual(v.id, '');
  assert.strictEqual(v.name, '(이름 없음)');
});
test('widgetCardVm XSS: name/path 를 이스케이프/변형 없이 보존(textContent 전제 L-1)', () => {
  const evil = '<img src=x onerror=alert(1)>';
  const v = fav.widgetCardVm({ id: 'a', name: evil, path: 'E:\\' + evil });
  assert.strictEqual(v.name, evil);
  assert.strictEqual(v.path, 'E:\\' + evil);
});

/* ─────────────── 위젯 슬라이더 인덱스 (래핑) ─────────────── */
test('nextSlideIndex(widget): 좌/우 래핑 + 빈/단일 graceful', () => {
  assert.strictEqual(fav.nextSlideIndex(0, 1, 3), 1);
  assert.strictEqual(fav.nextSlideIndex(2, 1, 3), 0);
  assert.strictEqual(fav.nextSlideIndex(0, -1, 3), 2);
  assert.strictEqual(fav.nextSlideIndex(0, 1, 0), 0);
  assert.strictEqual(fav.nextSlideIndex(5, 1, 1), 0);
});

/* ─────────────── 위젯 langColor (표시 보조, 비-DOM) ─────────────── */
test('langColor: 알려진 언어 색 / 미지 폴백', () => {
  assert.strictEqual(fav.langColor('TypeScript'), '#3178c6');
  assert.strictEqual(fav.langColor('알 수 없음'), '#a8a29e');
  assert.strictEqual(fav.langColor(undefined), '#a8a29e');
});
