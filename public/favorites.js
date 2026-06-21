'use strict';
/**
 * favorites.js — 즐겨찾기 위젯 창 렌더러 (app://favorites.html 전용).
 * 요구ID: R-22(즐겨찾기 독립 위젯 창).
 *
 * 보안:
 *   L-1: name·path·label 등 모든 표시 문자열은 textContent/createElement 로만 렌더(innerHTML 결합 0).
 *   CSP: 인라인 스크립트/이벤트 핸들러 0. 자산은 app:// 상대경로('self')만.
 *   SEC-H2 focus 게이팅: 부수효과 액션(open·copyText·setFavorite)은 위젯이 focus 상태일 때만 실행.
 *                        비포커스 첫 클릭은 포커스만 획득(액션 미실행).
 *   SEC-M2: onFavoritesChanged payload 는 { favorites:string[] } 만 신뢰(favoritesChangedView 정규화).
 *
 * preload(window.spip) 부재(웹/테스트)에서도 graceful — 축소 preload 6채널만 호출:
 *   getUiState · getProjects · open(id) · copyText(text) · setFavorite(id,on) · onFavoritesChanged(cb).
 *
 * 순수 로직(DOM 비의존)은 파일 하단 CommonJS export 로 node:test 검증.
 */

/* =====================================================================
 * 순수 로직 (DOM 비의존, 테스트 대상) — app.js 동형 로직 이식(독립 창이라 공유 모듈 없음)
 * ===================================================================== */

/** favorites(id) ∩ projects 스냅샷 교집합을 favorites 순서로 산출(순수). 소멸 id skip. */
function favoriteWidgetViewModels(projects, favorites) {
  const ps = Array.isArray(projects) ? projects : [];
  const favs = (Array.isArray(favorites) ? favorites : []).filter((x) => typeof x === 'string');
  const byId = new Map();
  for (const p of ps) {
    const id = (p && typeof p.id === 'string') ? p.id : '';
    if (id && !byId.has(id)) byId.set(id, p);
  }
  const out = [];
  const used = new Set();
  for (const id of favs) {
    if (byId.has(id) && !used.has(id)) { out.push(byId.get(id)); used.add(id); }
  }
  return out;
}

/** project 계약 → 위젯 표시 뷰모델(순수). name/path 폴백, 비객체 graceful. */
function widgetCardVm(p) {
  p = (p && typeof p === 'object') ? p : {};
  const lang = (p.language && typeof p.language === 'object') ? p.language : {};
  return {
    id: typeof p.id === 'string' ? p.id : '',
    name: (typeof p.name === 'string' && p.name.trim()) ? p.name : '(이름 없음)',
    path: (typeof p.path === 'string' && p.path.trim()) ? p.path : '',
    language: (typeof lang.primary === 'string' && lang.primary) ? lang.primary : '알 수 없음',
  };
}

/** 슬라이더 인덱스 이동(순수, 래핑). count 항목에서 dir(-1/+1) 이동. 빈 목록 → 0. */
function nextSlideIndex(cur, dir, count) {
  const n = Number.isInteger(count) && count > 0 ? count : 0;
  if (n === 0) return 0;
  let i = Number.isInteger(cur) ? cur : 0;
  i = ((i % n) + n) % n;
  const d = (dir === 1 || dir === -1) ? dir : 0;
  return (((i + d) % n) + n) % n;
}

/** SEC-H2 focus 게이팅 상태(순수). focused=false → 액션 비활성·첫 클릭은 포커스만. */
function focusGate(focused) {
  const ok = focused === true;
  return { allow: ok, focusOnly: !ok };
}

/** spip:favorites-changed payload → 정규화 favorites 배열(순수). 손상 → null(상태 유지). */
function favoritesChangedView(payload) {
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.favorites)) return null;
  return payload.favorites.filter((x) => typeof x === 'string');
}

/** 언어 → 점 색(간단 팔레트, app.js langColor 의 축약본). 표시 보조용. */
function langColor(lang) {
  const map = {
    'JavaScript': '#f7df1e', 'TypeScript': '#3178c6', 'Python': '#3776ab',
    'Java': '#b07219', 'Go': '#00add8', 'Rust': '#dea584', 'C#': '#178600',
    'C++': '#f34b7d', 'C': '#555555', 'Ruby': '#701516', 'PHP': '#4f5d95',
    'HTML': '#e34c26', 'CSS': '#563d7c', 'Shell': '#89e051',
  };
  return map[lang] || '#a8a29e';
}

/* =====================================================================
 * 위젯 렌더러 (브라우저 전용)
 * ===================================================================== */
function initWidget() {
  const spip = (typeof window !== 'undefined' && window.spip) ? window.spip : null;
  const root = document.getElementById('fav-widget');
  if (!root) return;

  // 위젯 상태(메모리). 단일 진실 원천은 main(ui-state.json) — 여기는 캐시 + show/changed 동기화 뷰.
  const state = {
    favorites: [],   // id 배열(SEC-M2 정규화)
    projects: [],    // getProjects 스냅샷
    index: 0,        // 슬라이더 인덱스
    focused: (typeof document !== 'undefined' && document.hasFocus) ? document.hasFocus() : true,
    busy: false,     // open/copy in-flight(연타 방지)
  };

  function has(method) { return !!(spip && typeof spip[method] === 'function'); }
  async function call(method, ...args) {
    if (!has(method)) return { ok: false, code: 'NO_BRIDGE' };
    try { return await spip[method](...args); }
    catch (err) { return { ok: false, code: 'INTERNAL', message: (err && err.message) || 'IPC 오류' }; }
  }

  /* ---- DOM 빌더(L-1: 텍스트는 항상 textContent) ---- */
  function el(tag, opts) {
    const node = document.createElement(tag);
    opts = opts || {};
    if (opts.cls) node.className = opts.cls;
    if (opts.text != null) node.textContent = opts.text; // L-1
    if (opts.attrs) for (const k in opts.attrs) node.setAttribute(k, opts.attrs[k]);
    if (opts.title != null) node.title = opts.title;
    if (opts.on) for (const ev in opts.on) node.addEventListener(ev, opts.on[ev]);
    if (opts.children) for (const c of opts.children) if (c) node.appendChild(c);
    return node;
  }
  const SVG_NS = 'http://www.w3.org/2000/svg';
  function chevron(dir) {
    const s = document.createElementNS(SVG_NS, 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('width', '18'); s.setAttribute('height', '18');
    s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor');
    s.setAttribute('stroke-width', '2.2'); s.setAttribute('stroke-linecap', 'round');
    s.setAttribute('stroke-linejoin', 'round'); s.setAttribute('aria-hidden', 'true');
    const p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', dir < 0 ? 'M15 18l-6-6 6-6' : 'M9 18l6-6-6-6');
    s.appendChild(p);
    return s;
  }
  function langDot(lang) {
    const d = el('span', { cls: 'fav-widget__dot' });
    d.style.background = langColor(lang);
    return d;
  }

  /* ---- focus 게이팅 ---- */
  // 비포커스 상태에서 액션을 시도하면 액션을 실행하지 않고 포커스만 획득(SEC-H2).
  function guardedAction(fn) {
    return (e) => {
      if (e && typeof e.stopPropagation === 'function') e.stopPropagation();
      const gate = focusGate(state.focused);
      if (!gate.allow) {
        // 첫 클릭은 포커스만 — 액션 미실행. 창에 포커스를 요청.
        try { if (typeof window !== 'undefined' && window.focus) window.focus(); } catch (_) { /* ignore */ }
        state.focused = true;
        renderInteractivity(); // 버튼 활성화 갱신
        return;
      }
      fn();
    };
  }

  /* ---- 액션(축소 preload 6채널만) ---- */
  async function doOpen(id) {
    if (!id || state.busy) return;
    state.busy = true;
    await call('open', id);
    state.busy = false;
  }
  async function doCopy(path) {
    if (!path || state.busy) return;
    state.busy = true;
    await call('copyText', path);
    state.busy = false;
  }
  async function doUnfavorite(id) {
    if (!id) return;
    // 낙관적: 메모리 즉시 반영(서버 broadcast 가 정합 동기화).
    state.favorites = state.favorites.filter((x) => x !== id);
    clampIndex();
    render();
    const res = await call('setFavorite', id, false);
    if (res && res.ok && Array.isArray(res.favorites)) {
      state.favorites = res.favorites.filter((x) => typeof x === 'string');
      clampIndex();
      render();
    }
  }

  function clampIndex() {
    const n = favoriteWidgetViewModels(state.projects, state.favorites).length;
    if (n === 0) { state.index = 0; return; }
    if (state.index >= n) state.index = n - 1;
    if (state.index < 0) state.index = 0;
  }
  function slideBy(dir) {
    const n = favoriteWidgetViewModels(state.projects, state.favorites).length;
    state.index = nextSlideIndex(state.index, dir, n);
    render();
  }

  /* ---- 렌더 ---- */
  function render() {
    while (root.firstChild) root.removeChild(root.firstChild);
    root.classList.toggle('is-blurred', !state.focused);

    // 헤더
    const head = el('div', { cls: 'fav-widget__head' });
    head.appendChild(el('div', { cls: 'fav-widget__title', text: '즐겨찾기' }));
    head.appendChild(el('div', { cls: 'fav-widget__spacer' }));
    head.appendChild(el('button', {
      cls: 'fav-widget__close', text: '×',
      attrs: { type: 'button', 'aria-label': '위젯 닫기' },
      on: { click: () => requestClose() },
    }));
    root.appendChild(head);

    const favs = favoriteWidgetViewModels(state.projects, state.favorites).map(widgetCardVm);

    if (favs.length === 0) {
      root.appendChild(el('div', { cls: 'fav-widget__empty', children: [
        el('div', { cls: 'fav-widget__empty-title', text: '즐겨찾기가 없습니다' }),
        el('div', { cls: 'fav-widget__empty-sub', text: '대시보드 카드의 별(★)을 눌러 추가하세요.' }),
      ]}));
      return;
    }

    let idx = ((state.index % favs.length) + favs.length) % favs.length;
    state.index = idx;
    const vm = favs[idx];
    const gate = focusGate(state.focused);

    // 스테이지: 이전 / 카드 / 다음
    const stage = el('div', { cls: 'fav-widget__stage' });
    const prev = el('button', {
      cls: 'fav-widget__nav', attrs: { type: 'button', 'aria-label': '이전 즐겨찾기' },
      on: { click: () => slideBy(-1) },
    });
    prev.appendChild(chevron(-1));
    if (favs.length < 2) prev.disabled = true;

    const card = el('div', { cls: 'fav-widget__card' });
    card.appendChild(el('div', { cls: 'fav-widget__card-head', children: [
      langDot(vm.language),
      el('div', { cls: 'fav-widget__name', text: vm.name, title: vm.name }), // L-1
    ]}));
    card.appendChild(el('div', { cls: 'fav-widget__path', text: vm.path, title: vm.path })); // L-1

    const acts = el('div', { cls: 'fav-widget__acts' });
    const openBtn = el('button', {
      cls: 'fav-btn fav-btn--dark', text: 'VS Code로 열기',
      attrs: { type: 'button', 'aria-label': 'VS Code로 열기: ' + vm.name },
      on: { click: guardedAction(() => doOpen(vm.id)) },
    });
    const copyBtn = el('button', {
      cls: 'fav-btn', text: '경로 복사',
      attrs: { type: 'button', 'aria-label': '경로 복사: ' + vm.path },
      on: { click: guardedAction(() => doCopy(vm.path)) },
    });
    const unfavBtn = el('button', {
      cls: 'fav-btn', text: '즐겨찾기 해제',
      attrs: { type: 'button', 'aria-label': '즐겨찾기 해제: ' + vm.name },
      on: { click: guardedAction(() => doUnfavorite(vm.id)) },
    });
    // focus 게이팅: 비포커스 시 액션 버튼 비활성(첫 클릭은 포커스만 — 위 guardedAction 이 차단)
    if (!gate.allow) { openBtn.disabled = true; copyBtn.disabled = true; unfavBtn.disabled = true; }
    if (!vm.id) { openBtn.disabled = true; unfavBtn.disabled = true; }
    if (!vm.path) copyBtn.disabled = true;
    acts.appendChild(openBtn);
    acts.appendChild(copyBtn);
    acts.appendChild(unfavBtn);
    card.appendChild(acts);

    const next = el('button', {
      cls: 'fav-widget__nav', attrs: { type: 'button', 'aria-label': '다음 즐겨찾기' },
      on: { click: () => slideBy(1) },
    });
    next.appendChild(chevron(1));
    if (favs.length < 2) next.disabled = true;

    stage.appendChild(prev);
    stage.appendChild(card);
    stage.appendChild(next);
    root.appendChild(stage);

    // 점 인디케이터 + 위치 표시(색 외 텍스트, N-07)
    const dots = el('div', { cls: 'fav-widget__dots', attrs: { 'aria-hidden': 'true' } });
    for (let i = 0; i < favs.length; i++) {
      dots.appendChild(el('span', { cls: 'fav-widget__dot-i' + (i === idx ? ' is-active' : '') }));
    }
    root.appendChild(dots);
    root.appendChild(el('div', {
      cls: 'fav-widget__pos', attrs: { role: 'status', 'aria-live': 'polite' },
      text: (idx + 1) + ' / ' + favs.length,
    }));
  }

  // 포커스 변경 시 전체 재렌더 없이 버튼 활성/시각만 갱신(가벼운 경로).
  function renderInteractivity() { render(); }

  /* ---- 닫기 요청(Esc·헤더 ×) ---- */
  function requestClose() {
    // 헤더 ×/Esc → 위젯 hide 요청. closeWidget 채널이 있으면 사용, 없으면 blur 유발(main 의 blur→hide).
    if (has('closeWidget')) { call('closeWidget'); return; }
    try { if (typeof window !== 'undefined' && window.blur) window.blur(); } catch (_) { /* ignore */ }
  }

  /* ---- 데이터 적재(stale 해소): show/가시성/포커스 복귀마다 재조회 ---- */
  async function refresh() {
    const ui = await call('getUiState');
    if (ui && ui.ok !== false && Array.isArray(ui.favorites)) {
      state.favorites = ui.favorites.filter((x) => typeof x === 'string');
    }
    const pr = await call('getProjects');
    if (pr && pr.ok !== false && Array.isArray(pr.projects)) {
      state.projects = pr.projects;
    }
    clampIndex();
    render();
  }

  /* ---- 이벤트 배선 ---- */
  // 키보드: Esc 닫기 / 좌·우 화살표 슬라이딩(N-07)
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); requestClose(); return; }
    if (e.key === 'ArrowLeft') { e.preventDefault(); slideBy(-1); return; }
    if (e.key === 'ArrowRight') { e.preventDefault(); slideBy(1); }
  });

  // focus/blur: 액션 게이팅 + show 복귀 시 stale 해소(re-fetch)
  window.addEventListener('focus', () => {
    state.focused = true;
    refresh(); // 포커스 복귀(=show)마다 재조회
  });
  window.addEventListener('blur', () => {
    state.focused = false;
    render(); // 액션 버튼 비활성 반영
  });
  // 가시성 복귀(show) 시에도 재조회(stale 해소)
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) refresh();
    });
  }

  // favorites 변경 구독(SEC-M2): main→renderer 단방향 push
  if (has('onFavoritesChanged')) {
    spip.onFavoritesChanged((payload) => {
      const favs = favoritesChangedView(payload);
      if (favs === null) return; // 손상 — 무시(상태 유지)
      state.favorites = favs;
      clampIndex();
      render();
    });
  }

  // 최초 적재
  render();    // 빈 상태 먼저(깜빡임 방지)
  refresh();   // getUiState + getProjects
}

/* =====================================================================
 * 환경 분기
 * ===================================================================== */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    favoriteWidgetViewModels,
    widgetCardVm,
    nextSlideIndex,
    focusGate,
    favoritesChangedView,
    langColor,
  };
} else if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initWidget);
  } else {
    initWidget();
  }
}
