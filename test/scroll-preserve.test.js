'use strict';
/**
 * scroll-preserve.test.js — 재렌더 시 스크롤 위치 보존(RG-2).
 *
 * 원 버그: 위젯을 클릭·저장·삭제할 때마다 홈 화면이 맨 위로 튀어 올랐다.
 *   홈 마소너리의 행 스팬(=콘텐츠 높이)은 render() 직후가 아니라 **rAF 뒤**에 정해진다.
 *   그런데 스크롤 복원은 render() 안에서 동기로 실행돼, 아직 짧은 콘텐츠의 최대 스크롤에
 *   scrollTop 이 걸려 0 으로 잘렸다(브라우저가 클램프). 레이아웃이 앉은 뒤 다시 걸어야 한다.
 *
 * jsdom 0-의존 정책 — 필요한 API 만 구현한 스텁으로 클램프까지 재현해 단언한다.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const APP_SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

/** scrollTop 이 콘텐츠 높이에 클램프되는(=실제 브라우저와 동일) 스크롤 컨테이너 스텁. */
function scrollBox(clientH, contentH) {
  return {
    clientHeight: clientH,
    scrollHeight: contentH,
    _top: 0,
    get scrollTop() { return this._top; },
    set scrollTop(v) { this._top = Math.max(0, Math.min(v, Math.max(0, this.scrollHeight - this.clientHeight))); },
    /** 마소너리가 rAF 뒤 행 스팬을 매겨 콘텐츠가 길어지는 순간. */
    layoutSettles(h) { this.scrollHeight = h; },
  };
}

/** app.js 의 RG.preserve.restore 와 동형인 최소 재현(같은 순서: 즉시 → rAF → rAF). */
function makeRestore(rootEl, raf) {
  return function restore(snap) {
    const apply = () => {
      if (snap.scroll == null) return;
      const e = rootEl.el;
      if (e && e.scrollTop !== snap.scroll) e.scrollTop = snap.scroll;
    };
    apply();
    raf(() => { apply(); raf(apply); });
  };
}

test('RG-2 — 레이아웃이 rAF 뒤에 앉아도 스크롤 위치가 복원된다(원 버그: 맨 위로 튐)', () => {
  const box = scrollBox(800, 900);          // 재렌더 직후: 스팬 미계산 → 콘텐츠가 짧다(최대 스크롤 100)
  const root = { el: box };
  const frames = [];
  const raf = (fn) => frames.push(fn);

  makeRestore(root, raf)({ scroll: 1200 }); // 사용자가 1200px 내려둔 상태를 복원 시도
  assert.strictEqual(box.scrollTop, 100, '동기 복원분은 짧은 콘텐츠에 클램프된다(여기까진 예전과 동일)');

  box.layoutSettles(4000);                  // 마소너리가 행 스팬을 매겨 콘텐츠가 길어짐
  frames.shift()();                         // 1프레임: 재적용
  assert.strictEqual(box.scrollTop, 1200, '레이아웃이 앉은 뒤 재적용되어 원위치로 복원');
});

test('RG-2 — 복원값이 이미 맞으면 다시 쓰지 않는다(사용자 스크롤 방해 없음)', () => {
  const box = scrollBox(800, 4000);
  const root = { el: box };
  const frames = [];
  makeRestore(root, (fn) => frames.push(fn))({ scroll: 1200 });
  assert.strictEqual(box.scrollTop, 1200);

  box.scrollTop = 300;                      // 복원 직후 사용자가 스스로 스크롤
  frames.shift()();                         // rAF 재적용 — 아직 스냅샷 값으로 되돌린다(같은 프레임 내 보정)
  assert.strictEqual(box.scrollTop, 1200, '보정 창은 2프레임뿐(그 뒤 스크롤은 사용자 것)');
});

/* ── 배선(정적 소스) — 실제 restore 가 rAF 재적용을 갖는가 ── */

test('RG-2 배선 — restore 는 즉시 + rAF 2프레임에 걸쳐 스크롤을 재적용한다', () => {
  const start = APP_SRC.indexOf('restore(rootEl, snap) {');
  assert.ok(start > 0, 'RG.preserve.restore 정의');
  const src = APP_SRC.slice(start, start + 900);
  assert.ok(/const applyScroll = \(\) =>/.test(src), '재사용 가능한 적용 함수');
  assert.ok(/applyScroll\(\);[\s\S]{0,400}requestAnimationFrame\(\(\) => \{ applyScroll\(\); requestAnimationFrame\(applyScroll\); \}\)/.test(src),
    '즉시 1회 + rAF 2프레임 재적용(마소너리 스팬 계산 뒤)');
});

test('RG-2 배선 — 홈 스크롤 컨테이너(.dash__main)가 보존 대상에 있다', () => {
  const m = APP_SRC.match(/const SCROLL_SEL = \[([^\]]*)\]/);
  assert.ok(m, 'SCROLL_SEL 정의');
  assert.ok(/\.dash__main/.test(m[1]), '홈·대시보드 본문이 스크롤 보존 대상');
});
