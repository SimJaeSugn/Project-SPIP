'use strict';
/**
 * favorites-dom-render.test.js — 0-의존성 경량 DOM 스텁으로 위젯 카드 실 렌더 검증.
 *
 * 원 버그("위젯에 버튼만 보이고 즐겨찾기 카드가 전혀 안 떴다")는 jsdom 0-의존 정책상
 * 순수함수만 테스트해서 샜다. 본 테스트는 favorites.js 의 mountWidget(doc, win, spip) 을
 * 필요한 DOM API 만 구현한 순수 JS shim 에 태워, 실제로 .fav-card 노드가 생성·삽입되고
 * 개수·이름/경로 텍스트·현재 슬라이드 가시성이 맞는지 직접 단언한다(여전히 0-의존).
 *
 * 헤드리스 Electron 스모크(favorites-smoke.test.js)와 동일 보장을 런타임 의존 없이 커버.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fav = require('../public/favorites.js');

/* ──────────────────────── 경량 DOM shim ──────────────────────── */
class ClassList {
  constructor(node) { this._n = node; this._set = new Set(); }
  add(c) { this._set.add(c); this._sync(); }
  remove(c) { this._set.delete(c); this._sync(); }
  toggle(c, on) { (on === undefined ? !this._set.has(c) : on) ? this._set.add(c) : this._set.delete(c); this._sync(); }
  contains(c) { return this._set.has(c); }
  _sync() { this._n._className = Array.from(this._set).join(' '); }
}

class StyleStub {
  setProperty() {}
}

class Node {
  constructor(doc, tag, ns) {
    this._doc = doc;
    this.tagName = String(tag || '').toUpperCase();
    this.ns = ns || null;
    this.childNodes = [];
    this.parentNode = null;
    this.attributes = {};
    this._textContent = '';
    this._className = '';
    this.title = '';
    this.disabled = false;
    this.tabIndex = 0;
    this._listeners = {};
    this.style = new StyleStub();
    this.classList = new ClassList(this);
  }
  get firstChild() { return this.childNodes[0] || null; }
  get className() { return this._className; }
  set className(v) {
    this._className = String(v == null ? '' : v);
    this.classList._set = new Set(this._className.split(/\s+/).filter(Boolean));
  }
  // 텍스트 노드가 없으므로 textContent 는 자식 텍스트 결합으로 모델링.
  get textContent() {
    if (this.childNodes.length === 0) return this._textContent;
    return this.childNodes.map((c) => c.textContent).join('');
  }
  set textContent(v) {
    this.childNodes = [];
    this._textContent = String(v == null ? '' : v);
  }
  setAttribute(k, v) {
    this.attributes[k] = String(v);
    if (k === 'class') this.className = String(v);
    if (k === 'inert') this._inert = true;
  }
  getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attributes, k) ? this.attributes[k] : null; }
  appendChild(child) {
    if (!child) return child;
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }
  removeChild(child) {
    const i = this.childNodes.indexOf(child);
    if (i >= 0) this.childNodes.splice(i, 1);
    child.parentNode = null;
    return child;
  }
  addEventListener(ev, fn) { (this._listeners[ev] = this._listeners[ev] || []).push(fn); }
  _dispatch(ev, evt) { for (const fn of (this._listeners[ev] || [])) fn(evt || {}); }
  _classes() { return new Set((this._className || '').split(/\s+/).filter(Boolean)); }
  _walk(out) { out.push(this); for (const c of this.childNodes) c._walk(out); return out; }
  // 매우 작은 셀렉터 엔진: ".a", "tag", ".a.b .c .d" (공백=하위), ".a[aria-x=\"v\"]" 부분 지원.
  _matchesSimple(sel) {
    sel = sel.trim();
    // tag 부분
    let rest = sel;
    let tagMatch = true;
    const tagm = rest.match(/^[a-zA-Z][\w-]*/);
    if (tagm) {
      tagMatch = this.tagName === tagm[0].toUpperCase();
      rest = rest.slice(tagm[0].length);
    }
    // class 부분
    const classes = this._classes();
    const classMatches = rest.match(/\.[\w-]+/g) || [];
    for (const cm of classMatches) {
      if (!classes.has(cm.slice(1))) return false;
    }
    // [attr="v"] 부분
    const attrMatches = rest.match(/\[[^\]]+\]/g) || [];
    for (const am of attrMatches) {
      const m = am.match(/\[([\w-]+)(?:=["']?([^"'\]]*)["']?)?\]/);
      if (!m) return false;
      const have = this.getAttribute(m[1]);
      if (m[2] === undefined) { if (have == null) return false; }
      else if (have !== m[2]) return false;
    }
    return tagMatch;
  }
  querySelectorAll(selector) {
    const parts = String(selector).trim().split(/\s+(?![^\[]*\])/);
    // 단일 파트: 자손 중 매칭. 다중 파트: 후손 체인.
    const all = [];
    this._walk(all);
    const descendants = all.filter((n) => n !== this);
    if (parts.length === 1) {
      return descendants.filter((n) => n._matchesSimple(parts[0]));
    }
    // 다중: 마지막 파트 매칭 노드 중, 조상 체인에 앞 파트들이 순서대로 존재.
    const last = parts[parts.length - 1];
    const cands = descendants.filter((n) => n._matchesSimple(last));
    return cands.filter((n) => {
      let need = parts.length - 2;
      let cur = n.parentNode;
      while (cur && need >= 0) {
        if (cur._matchesSimple && cur._matchesSimple(parts[need])) need--;
        cur = cur.parentNode;
        if (need < 0) break;
      }
      return need < 0;
    });
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}

class DocStub {
  constructor() {
    this.byId = {};
    this.readyState = 'complete';
    this.hidden = false;
    this._listeners = {};
  }
  createElement(tag) { return new Node(this, tag, null); }
  createElementNS(ns, tag) { return new Node(this, tag, ns); }
  getElementById(id) { return this.byId[id] || null; }
  addEventListener(ev, fn) { (this._listeners[ev] = this._listeners[ev] || []).push(fn); }
  hasFocus() { return true; }
}

class WinStub {
  constructor() { this._listeners = {}; this.focusedCalls = 0; }
  addEventListener(ev, fn) { (this._listeners[ev] = this._listeners[ev] || []).push(fn); }
  _dispatch(ev, evt) { for (const fn of (this._listeners[ev] || [])) fn(evt || {}); }
  focus() { this.focusedCalls++; }
  blur() {}
}

/* spip 모의(축소 6채널 동형). resolve 즉시 — flush 로 마이크로태스크 정리. */
function makeSpip(favorites, projects) {
  return {
    _favorites: favorites.slice(),
    _projects: projects,
    _changedCb: null,
    getUiState: async function () { return { ok: true, favorites: this._favorites.slice() }; },
    getProjects: async function () { return { ok: true, projects: this._projects }; },
    open: async () => ({ ok: true }),
    copyText: async () => ({ ok: true }),
    setFavorite: async function (id, on) {
      this._favorites = on ? this._favorites : this._favorites.filter((x) => x !== id);
      return { ok: true, favorites: this._favorites.slice() };
    },
    onFavoritesChanged: function (cb) { this._changedCb = cb; return () => {}; },
  };
}

const PROJECTS = [
  { id: 'a', name: 'Alpha', path: 'E:\\proj\\alpha', language: { primary: 'JavaScript' },
    description: '첫 프로젝트', git: { isRepo: true, branch: 'main', dirty: true } },
  { id: 'b', name: 'Beta', path: 'E:\\proj\\beta', language: { primary: 'Python' },
    git: { isRepo: true, branch: 'dev' } },
  { id: 'c', name: 'Gamma', path: 'E:\\proj\\gamma', language: { primary: 'Go' }, git: { status: 'na' } },
];

function mount(favorites, projects) {
  const doc = new DocStub();
  const root = doc.createElement('div');
  root.setAttribute('id', 'fav-widget');
  root.className = 'fav-widget';
  doc.byId['fav-widget'] = root;
  const win = new WinStub();
  const spip = makeSpip(favorites, projects || PROJECTS);
  const handle = fav.mountWidget(doc, win, spip);
  return { doc, root, win, spip, handle };
}

/** mountWidget 의 refresh()(async getUiState→getProjects→render) 가 끝날 때까지 flush. */
async function flush(n) {
  for (let i = 0; i < (n || 8); i++) { await Promise.resolve(); await new Promise((r) => setImmediate(r)); }
}

/* ──────────────────────── 테스트 ──────────────────────── */

test('shim 자체 점검: querySelectorAll(class) / 후손 셀렉터 동작', () => {
  const doc = new DocStub();
  const root = doc.createElement('div');
  const a = doc.createElement('article'); a.className = 'fav-card';
  const body = doc.createElement('div'); body.className = 'fav-card__body';
  const name = doc.createElement('h2'); name.className = 'fav-card__name'; name.textContent = 'X';
  body.appendChild(name); a.appendChild(body); root.appendChild(a);
  assert.strictEqual(root.querySelectorAll('.fav-card').length, 1);
  assert.strictEqual(root.querySelector('.fav-card .fav-card__name').textContent, 'X');
});

test('실 렌더: 즐겨찾기 3개 → .fav-card 3장이 DOM 에 생성된다(원 버그 봉인)', async () => {
  const { root } = mount(['a', 'b', 'c']);
  await flush();
  const cards = root.querySelectorAll('.fav-card');
  assert.ok(cards.length >= 1, '카드가 1장 이상 렌더되어야 함(버튼만 있고 카드 0 = 원 버그)');
  assert.strictEqual(cards.length, 3, '즐겨찾기 3개 → 카드(슬라이드) 3장');
});

test('실 렌더: 카드 본문 이름/경로 텍스트가 실제로 채워진다(클리핑 회귀 아님)', async () => {
  const { root } = mount(['a', 'b', 'c']);
  await flush();
  const names = root.querySelectorAll('.fav-card__name').map((n) => n.textContent);
  assert.deepStrictEqual(names, ['Alpha', 'Beta', 'Gamma']);
  const firstPath = root.querySelector('.fav-card__path');
  assert.ok(firstPath && firstPath.textContent.length > 0, '카드 경로 본문이 비어있지 않아야 함');
});

test('실 렌더: 카드가 단일 트랙에 모두 깔리고 버튼과 함께 존재(버튼만 있는 상태가 아님)', async () => {
  const { root } = mount(['a', 'b', 'c']);
  await flush();
  const track = root.querySelector('.fav-carousel__track');
  assert.ok(track, '드래그 트랙(.fav-carousel__track) 존재');
  const inTrack = track.querySelectorAll('.fav-card');
  assert.strictEqual(inTrack.length, 3, '트랙에 카드 3장 모두 배치(페이징 아님)');
  // "버튼은 있는데 카드는 없다" 가 거짓임을 명시.
  const buttons = root.querySelectorAll('button');
  const cards = root.querySelectorAll('.fav-card');
  assert.ok(buttons.length > 0 && cards.length > 0, '버튼과 카드가 함께 존재해야 함');
});

test('헤더: 개수 배지 + 대시보드 열기 버튼', async () => {
  const { root } = mount(['a', 'b', 'c']);
  await flush();
  assert.strictEqual(root.querySelector('.fav-head__count').textContent, '3');
  const dash = root.querySelector('.fav-head__dash');
  assert.ok(dash, '대시보드 열기 버튼(.fav-head__dash) 존재');
  // 클릭 graceful(mock spip 에 openDashboard 부재 → NO_BRIDGE, throw 없음).
  assert.doesNotThrow(() => dash._dispatch('click', { stopPropagation() {} }));
});

test('빈 상태: 즐겨찾기 0 → 빈 안내 표시 + .fav-card 0 + 개수 0', async () => {
  const { root } = mount([]);
  await flush();
  assert.strictEqual(root.querySelectorAll('.fav-card').length, 0, '카드 0');
  const empty = root.querySelector('.fav-empty');
  assert.ok(empty, '빈 안내(.fav-empty) 표시');
  assert.ok(root.querySelector('.fav-empty__title').textContent.length > 0, '빈 안내 제목 텍스트');
  assert.strictEqual(root.querySelector('.fav-head__count').textContent, '0');
});

test('양끝 화살표: prev/next 버튼이 존재하고 next()/prev() 호출이 throw 없음', async () => {
  const { root, handle } = mount(['a', 'b', 'c']);
  await flush();
  assert.ok(root.querySelector('.fav-carousel__nav--prev'), '이전 화살표 존재');
  assert.ok(root.querySelector('.fav-carousel__nav--next'), '다음 화살표 존재');
  assert.doesNotThrow(() => { handle.next(); handle.prev(); }, '스크롤 호출 안전(헤드리스 지오메트리 0)');
});

test('git 배지: dirty→미커밋 / clean→정상 / 비레포→배지 없음(언어칩만)', async () => {
  const { root } = mount(['a', 'b', 'c']);
  await flush();
  const cards = root.querySelectorAll('.fav-card');
  const texts = (card) => card.querySelectorAll('.fav-badge').map((b) => b.textContent);
  assert.deepStrictEqual(texts(cards[0]), ['JavaScript', '미커밋'], 'Alpha: 언어칩 + 미커밋');
  assert.deepStrictEqual(texts(cards[1]), ['Python', '정상'], 'Beta: 언어칩 + 정상');
  assert.deepStrictEqual(texts(cards[2]), ['Go'], 'Gamma(비레포): 언어칩만');
});

test('즐겨찾기 해제: 별(★) 버튼 클릭 시 해당 카드 제거 + 개수 갱신', async () => {
  const { root, handle } = mount(['a', 'b', 'c']);
  await flush();
  // 마지막 카드(Gamma)의 해제 버튼.
  const stars = root.querySelectorAll('.fav-card__star');
  assert.strictEqual(stars.length, 3, '카드마다 해제 버튼');
  stars[2]._dispatch('click', { stopPropagation() {} });
  await flush();
  const cards = root.querySelectorAll('.fav-card');
  assert.strictEqual(cards.length, 2, '해제 후 카드 2장');
  const names = root.querySelectorAll('.fav-card__name').map((n) => n.textContent);
  assert.deepStrictEqual(names, ['Alpha', 'Beta'], 'Gamma 제거됨');
  assert.strictEqual(root.querySelector('.fav-head__count').textContent, '2', '개수 배지 갱신');
  assert.strictEqual(handle._count(), 2);
});

test('focus 게이팅(SEC-H2): blur 시 부수효과 버튼(열기·복사·해제) 비활성', async () => {
  const { root, win } = mount(['a', 'b', 'c']);
  await flush();
  // 포커스 상태에서는 활성.
  assert.strictEqual(root.querySelector('.fav-act--primary').disabled, false);
  win._dispatch('blur'); // 비포커스 → 재렌더
  assert.strictEqual(root.querySelector('.fav-act--primary').disabled, true, '열기 버튼 비활성');
  assert.strictEqual(root.querySelector('.fav-card__star').disabled, true, '해제 버튼 비활성');
});

test('비매칭 favorites(소멸 id) 는 카드로 그려지지 않음(교집합)', async () => {
  const { root } = mount(['a', 'zzz', 'b']); // zzz 는 projects 에 없음
  await flush();
  const names = root.querySelectorAll('.fav-card__name').map((n) => n.textContent);
  assert.deepStrictEqual(names, ['Alpha', 'Beta'], '소멸 id 는 카드 미생성');
});
