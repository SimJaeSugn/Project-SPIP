'use strict';
/**
 * favorites.js — 즐겨찾기 위젯 창 렌더러 (app://favorites.html 전용).
 * 요구ID: R-22(즐겨찾기 독립 위젯 창).
 *
 * [M7-FIX] 신규 캐러셀 UI (대시보드 buildCard·옛 슬라이더 재활용 금지 — 위젯 전용 컴포넌트).
 *   즐겨찾기한 프로젝트를 "이미지 슬라이더"처럼 한 트랙(track)에 가로로 깔고 transform: translateX
 *   로 좌우 롤링한다. 좌/우 화살표·Arrow 키·점 인디케이터·N/M 위치로 이동, 부드러운 슬라이드 전환
 *   (prefers-reduced-motion 존중).
 *
 * 근본원인(왜 카드가 안 보였나):
 *   기존 렌더는 카드를 1장만 그렸고, 액션 3버튼이 토스트 폭(360px)에서 줄바꿈(flex-wrap)되며
 *   margin-top:auto 로 하단에 고정되어 카드 본문(이름/경로) 영역을 시각적으로 압착 → 사용자에게
 *   "버튼만 보이고 카드가 안 보임"으로 인지됨(레이아웃 클리핑, 진단 후보 c). 데이터/DOM 생성은 정상.
 *   → 신규 UI는 카드 본문(이름·언어·git·경로)을 상단에 고정 표시하고 액션 줄을 분리(줄바꿈 억제·
 *     아이콘 축약)해 본문이 항상 보이도록 한다. + 헤드리스 DOM 테스트로 회귀 봉인.
 *
 * 보안:
 *   L-1: name·path·label·branch 등 모든 표시 문자열은 textContent/createElement 로만 렌더(innerHTML 결합 0).
 *   CSP: 인라인 스크립트/이벤트 핸들러 0. 자산은 app:// 상대경로('self')만.
 *   SEC-H2 focus 게이팅: 부수효과 액션(open·copyText·setFavorite)은 위젯이 focus 상태일 때만 실행.
 *                        비포커스 첫 클릭은 포커스만 획득(액션 미실행).
 *   SEC-M2: onFavoritesChanged payload 는 { favorites:string[] } 만 신뢰(favoritesChangedView 정규화).
 *
 * preload(window.spip) 부재(웹/테스트)에서도 graceful — 축소 preload 6채널만 호출:
 *   getUiState · getProjects · open(id) · copyText(text) · setFavorite(id,on) · onFavoritesChanged(cb).
 *
 * 순수 로직(DOM 비의존)은 파일 하단 CommonJS export 로 node:test 검증.
 * 렌더러(DOM 의존)도 mountWidget 로 export 하여 헤드리스 DOM 스텁에서 카드 생성·표시를 단언.
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

/** project 계약 → 위젯 표시 뷰모델(순수). name/path/git 폴백, 비객체 graceful. */
function widgetCardVm(p) {
  p = (p && typeof p === 'object') ? p : {};
  const lang = (p.language && typeof p.language === 'object') ? p.language : {};
  const git = (p.git && typeof p.git === 'object') ? p.git : {};
  return {
    id: typeof p.id === 'string' ? p.id : '',
    name: (typeof p.name === 'string' && p.name.trim()) ? p.name : '(이름 없음)',
    path: (typeof p.path === 'string' && p.path.trim()) ? p.path : '',
    language: (typeof lang.primary === 'string' && lang.primary) ? lang.primary : '알 수 없음',
    git: gitLabel(git),
  };
}

/** git 계약 → 짧은 표시 라벨(순수). na/비레포 → '—'. dirty/ahead/behind 축약. */
function gitLabel(git) {
  git = (git && typeof git === 'object') ? git : {};
  if (git.status === 'na' || git.isRepo === false) return '—';
  // git 정보가 전혀 없으면(빈 객체) '—'로 표기 — 실제 분리 HEAD('detached')와 구분.
  if (git.status === undefined && git.isRepo === undefined && !(typeof git.branch === 'string' && git.branch)) return '—';
  const branch = (typeof git.branch === 'string' && git.branch) ? git.branch : 'detached';
  const marks = [];
  if (git.dirty === true) marks.push('●');
  const ahead = Number.isInteger(git.ahead) ? git.ahead : 0;
  const behind = Number.isInteger(git.behind) ? git.behind : 0;
  if (ahead > 0) marks.push('↑' + ahead);
  if (behind > 0) marks.push('↓' + behind);
  return marks.length ? (branch + ' ' + marks.join(' ')) : branch;
}

/** 경로 축약(순수): 앞 1세그먼트 + … + 뒤 2세그먼트. 짧으면 원본. 표시 보조(원본은 복사·title용). */
function shortenPath(path, keepTail) {
  if (typeof path !== 'string' || !path) return '';
  const tail = Number.isInteger(keepTail) && keepTail > 0 ? keepTail : 2;
  const norm = path.replace(/\\/g, '/');
  const segs = norm.split('/').filter(Boolean);
  if (segs.length <= tail + 1) return path;
  const sep = path.indexOf('\\') >= 0 ? '\\' : '/';
  const head = segs[0];
  const tailSegs = segs.slice(segs.length - tail);
  return head + sep + '…' + sep + tailSegs.join(sep);
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

/** 해제 등으로 항목 제거 시 인덱스 보정(순수). 제거 후 길이 newCount 기준 clamp. */
function clampSlideIndex(cur, newCount) {
  const n = Number.isInteger(newCount) && newCount > 0 ? newCount : 0;
  if (n === 0) return 0;
  let i = Number.isInteger(cur) ? cur : 0;
  if (i >= n) i = n - 1;
  if (i < 0) i = 0;
  return i;
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
    'HTML': '#e34c26', 'CSS': '#563d7c', 'Shell': '#89e051', 'Node.js': '#539e43',
  };
  return map[lang] || '#a8a29e';
}

/* =====================================================================
 * 위젯 렌더러 (DOM 의존) — mountWidget(doc, win, spip): 헤드리스 DOM 스텁 주입 가능.
 *   카드 트랙(track)에 슬라이드 N장을 모두 빌드하고 transform: translateX 로 좌우 롤링.
 * ===================================================================== */
function mountWidget(doc, win, spip) {
  const root = doc.getElementById('fav-widget');
  if (!root) return null;

  // 위젯 상태(메모리). 단일 진실 원천은 main(ui-state.json) — 여기는 캐시 + show/changed 동기화 뷰.
  const state = {
    favorites: [],   // id 배열(SEC-M2 정규화)
    projects: [],    // getProjects 스냅샷
    index: 0,        // 슬라이더 인덱스
    focused: (doc && typeof doc.hasFocus === 'function') ? doc.hasFocus() : true,
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
    const node = doc.createElement(tag);
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
  function svgIcon(d, extra) {
    const s = doc.createElementNS(SVG_NS, 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('width', '16'); s.setAttribute('height', '16');
    s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor');
    s.setAttribute('stroke-width', '2'); s.setAttribute('stroke-linecap', 'round');
    s.setAttribute('stroke-linejoin', 'round'); s.setAttribute('aria-hidden', 'true');
    const paths = Array.isArray(d) ? d : [d];
    for (const dd of paths) {
      const p = doc.createElementNS(SVG_NS, 'path');
      p.setAttribute('d', dd);
      s.appendChild(p);
    }
    if (extra) extra(s);
    return s;
  }
  function chevron(dir) {
    return svgIcon(dir < 0 ? 'M15 18l-6-6 6-6' : 'M9 18l6-6-6-6', (s) => {
      s.setAttribute('width', '18'); s.setAttribute('height', '18'); s.setAttribute('stroke-width', '2.2');
    });
  }
  function langDot(lang) {
    const d = el('span', { cls: 'fav-card__dot', attrs: { 'aria-hidden': 'true' } });
    d.style.background = langColor(lang);
    return d;
  }

  /* ---- focus 게이팅(SEC-H2) ---- */
  function guardedAction(fn) {
    return (e) => {
      if (e && typeof e.stopPropagation === 'function') e.stopPropagation();
      const gate = focusGate(state.focused);
      if (!gate.allow) {
        // 첫 클릭은 포커스만 — 액션 미실행. 창에 포커스를 요청.
        try { if (win && typeof win.focus === 'function') win.focus(); } catch (_) { /* ignore */ }
        state.focused = true;
        render(); // 버튼 활성화 갱신
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
    // 낙관적: 메모리 즉시 반영(서버 broadcast 가 정합 동기화). 인덱스 보정 후 재렌더.
    state.favorites = state.favorites.filter((x) => x !== id);
    syncIndex();
    render();
    const res = await call('setFavorite', id, false);
    if (res && res.ok && Array.isArray(res.favorites)) {
      state.favorites = res.favorites.filter((x) => typeof x === 'string');
      syncIndex();
      render();
    }
  }

  function slideCount() {
    return favoriteWidgetViewModels(state.projects, state.favorites).length;
  }
  function syncIndex() { state.index = clampSlideIndex(state.index, slideCount()); }
  function slideBy(dir) {
    const n = slideCount();
    if (n < 2) return;
    state.index = nextSlideIndex(state.index, dir, n);
    render();
  }
  function goTo(i) {
    const n = slideCount();
    if (n === 0) return;
    state.index = clampSlideIndex(i, n);
    render();
  }

  /* ---- 슬라이드(카드) 빌더 — 위젯 전용 신규 컴포넌트 ---- */
  function buildSlide(vm, gate) {
    const card = el('article', {
      cls: 'fav-card',
      attrs: { role: 'group', 'aria-roledescription': '슬라이드', 'aria-label': vm.name },
    });

    // 본문: 이름 + 언어/내용 메타 + 경로. 항상 상단 고정 표시(클리핑 회귀 방지).
    const titleRow = el('div', { cls: 'fav-card__title-row', children: [
      langDot(vm.language),
      el('h2', { cls: 'fav-card__name', text: vm.name, title: vm.name }), // L-1
    ]});
    const meta = el('div', { cls: 'fav-card__meta', children: [
      el('span', { cls: 'fav-card__lang', text: vm.language }),         // L-1
      el('span', { cls: 'fav-card__sep', text: '·', attrs: { 'aria-hidden': 'true' } }),
      el('span', { cls: 'fav-card__git', text: vm.git, title: 'git: ' + vm.git }), // L-1
    ]});
    const pathRow = el('div', {
      cls: 'fav-card__path', text: shortenPath(vm.path), title: vm.path, // L-1 (축약은 텍스트, 원본 title)
    });

    const body = el('div', { cls: 'fav-card__body', children: [titleRow, meta, pathRow] });

    // 액션 줄(분리·아이콘 축약·줄바꿈 억제) — 본문 압착 방지.
    const openBtn = el('button', {
      cls: 'fav-act fav-act--primary',
      attrs: { type: 'button', 'aria-label': 'VS Code로 열기: ' + vm.name, title: 'VS Code로 열기' },
      children: [
        svgIcon(['M16 3l5 2.5v13L16 21l-9-5.5v-8L16 3z', 'M7 7.5l9 5.5v8M16 3v10']),
        el('span', { cls: 'fav-act__t', text: '열기' }),
      ],
      on: { click: guardedAction(() => doOpen(vm.id)) },
    });
    const copyBtn = el('button', {
      cls: 'fav-act',
      attrs: { type: 'button', 'aria-label': '경로 복사: ' + vm.path, title: '경로 복사' },
      children: [
        svgIcon(['M9 9h10v12H9z', 'M5 15V3h10']),
        el('span', { cls: 'fav-act__t', text: '복사' }),
      ],
      on: { click: guardedAction(() => doCopy(vm.path)) },
    });
    const unfavBtn = el('button', {
      cls: 'fav-act fav-act--star',
      attrs: { type: 'button', 'aria-label': '즐겨찾기 해제: ' + vm.name, title: '즐겨찾기 해제' },
      children: [
        svgIcon('M12 3.5l2.6 5.3 5.9.9-4.25 4.15 1 5.85L12 17.1 6.75 19.75l1-5.85L3.5 9.7l5.9-.9L12 3.5z'),
        el('span', { cls: 'fav-act__t', text: '해제' }),
      ],
      on: { click: guardedAction(() => doUnfavorite(vm.id)) },
    });
    if (!gate.allow) { openBtn.disabled = true; copyBtn.disabled = true; unfavBtn.disabled = true; }
    if (!vm.id) { openBtn.disabled = true; unfavBtn.disabled = true; }
    if (!vm.path) copyBtn.disabled = true;

    const acts = el('div', { cls: 'fav-card__acts', children: [openBtn, copyBtn, unfavBtn] });

    card.appendChild(body);
    card.appendChild(acts);
    return card;
  }

  /* ---- 렌더(전체 재구성) ---- */
  function render() {
    while (root.firstChild) root.removeChild(root.firstChild);
    root.classList.toggle('is-blurred', !state.focused);

    // 헤더
    const head = el('div', { cls: 'fav-head', children: [
      el('div', { cls: 'fav-head__title', text: '즐겨찾기' }),
      el('div', { cls: 'fav-head__spacer' }),
    ]});
    head.appendChild(el('button', {
      cls: 'fav-head__close',
      attrs: { type: 'button', 'aria-label': '위젯 닫기', title: '닫기 (Esc)' },
      text: '×',
      on: { click: () => requestClose() },
    }));
    root.appendChild(head);

    const favs = favoriteWidgetViewModels(state.projects, state.favorites).map(widgetCardVm);

    // 빈 상태(즐겨찾기 0개)
    if (favs.length === 0) {
      root.appendChild(el('div', { cls: 'fav-empty', children: [
        el('div', { cls: 'fav-empty__icon', attrs: { 'aria-hidden': 'true' }, children: [
          svgIcon('M12 3.5l2.6 5.3 5.9.9-4.25 4.15 1 5.85L12 17.1 6.75 19.75l1-5.85L3.5 9.7l5.9-.9L12 3.5z',
            (s) => { s.setAttribute('width', '34'); s.setAttribute('height', '34'); }),
        ]}),
        el('div', { cls: 'fav-empty__title', text: '즐겨찾기한 프로젝트가 없습니다' }),
        el('div', { cls: 'fav-empty__sub', text: '대시보드에서 카드의 별(★)을 눌러 추가하세요.' }),
      ]}));
      return;
    }

    const idx = clampSlideIndex(state.index, favs.length);
    state.index = idx;
    const gate = focusGate(state.focused);

    // ── 캐러셀(이미지 슬라이더): viewport > track > slide* ──
    const carousel = el('div', {
      cls: 'fav-carousel',
      attrs: {
        role: 'region', 'aria-roledescription': '캐러셀', 'aria-label': '즐겨찾기 슬라이더',
      },
    });

    const prev = el('button', {
      cls: 'fav-carousel__nav fav-carousel__nav--prev',
      attrs: { type: 'button', 'aria-label': '이전 즐겨찾기' },
      children: [chevron(-1)],
      on: { click: () => slideBy(-1) },
    });
    const next = el('button', {
      cls: 'fav-carousel__nav fav-carousel__nav--next',
      attrs: { type: 'button', 'aria-label': '다음 즐겨찾기' },
      children: [chevron(1)],
      on: { click: () => slideBy(1) },
    });
    if (favs.length < 2) { prev.disabled = true; next.disabled = true; }

    const viewport = el('div', { cls: 'fav-carousel__viewport' });
    const track = el('div', { cls: 'fav-carousel__track' });
    // 전 슬라이드를 트랙에 깔고 translateX 로 현재 슬라이드만 노출(롤링 애니메이션).
    track.style.transform = 'translateX(' + (-idx * 100) + '%)';
    for (let i = 0; i < favs.length; i++) {
      const slide = el('div', {
        cls: 'fav-carousel__slide' + (i === idx ? ' is-current' : ''),
        attrs: {
          'aria-hidden': i === idx ? 'false' : 'true',
          'aria-label': (i + 1) + ' / ' + favs.length,
        },
      });
      // 비활성 슬라이드의 버튼은 포커스 불가(접근성·탭 순서).
      const slideGate = (i === idx) ? gate : { allow: false, focusOnly: true };
      const slideCard = buildSlide(favs[i], slideGate);
      if (i !== idx) {
        slide.setAttribute('inert', '');
        for (const b of slideCard.querySelectorAll('button')) b.tabIndex = -1;
      }
      slide.appendChild(slideCard);
      track.appendChild(slide);
    }
    viewport.appendChild(track);

    carousel.appendChild(prev);
    carousel.appendChild(viewport);
    carousel.appendChild(next);
    root.appendChild(carousel);

    // ── 하단 컨트롤: 점 인디케이터 + N/M 위치(N-07: 색 외 텍스트) ──
    const ctrl = el('div', { cls: 'fav-ctrl' });
    const dots = el('div', {
      cls: 'fav-ctrl__dots',
      attrs: { role: 'tablist', 'aria-label': '슬라이드 선택' },
    });
    for (let i = 0; i < favs.length; i++) {
      const active = i === idx;
      const dot = el('button', {
        cls: 'fav-ctrl__dot' + (active ? ' is-active' : ''),
        attrs: {
          type: 'button', role: 'tab',
          'aria-label': (i + 1) + '번 즐겨찾기로 이동',
          'aria-selected': active ? 'true' : 'false',
        },
        on: { click: ((n) => () => goTo(n))(i) },
      });
      dots.appendChild(dot);
    }
    ctrl.appendChild(dots);
    ctrl.appendChild(el('div', {
      cls: 'fav-ctrl__pos',
      attrs: { role: 'status', 'aria-live': 'polite' },
      text: (idx + 1) + ' / ' + favs.length,
    }));
    root.appendChild(ctrl);
  }

  /* ---- 닫기 요청(Esc·헤더 ×) ---- */
  function requestClose() {
    if (has('closeWidget')) { call('closeWidget'); return; }
    try { if (win && typeof win.blur === 'function') win.blur(); } catch (_) { /* ignore */ }
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
    syncIndex();
    render();
  }

  /* ---- 이벤트 배선 ---- */
  if (win && typeof win.addEventListener === 'function') {
    win.addEventListener('keydown', (e) => {
      if (!e) return;
      if (e.key === 'Escape') { if (e.preventDefault) e.preventDefault(); requestClose(); return; }
      if (e.key === 'ArrowLeft') { if (e.preventDefault) e.preventDefault(); slideBy(-1); return; }
      if (e.key === 'ArrowRight') { if (e.preventDefault) e.preventDefault(); slideBy(1); }
    });
    win.addEventListener('focus', () => { state.focused = true; refresh(); });
    win.addEventListener('blur', () => { state.focused = false; render(); });
  }
  if (doc && typeof doc.addEventListener === 'function') {
    doc.addEventListener('visibilitychange', () => { if (!doc.hidden) refresh(); });
  }

  // favorites 변경 구독(SEC-M2): main→renderer 단방향 push
  if (has('onFavoritesChanged')) {
    spip.onFavoritesChanged((payload) => {
      const favs = favoritesChangedView(payload);
      if (favs === null) return; // 손상 — 무시(상태 유지)
      state.favorites = favs;
      syncIndex();
      render();
    });
  }

  // 최초 적재
  render();    // 빈 상태 먼저(깜빡임 방지)
  refresh();   // getUiState + getProjects

  // 테스트/디버그용 핸들 노출(부수효과 없음).
  return {
    render,
    refresh,
    slideBy,
    goTo,
    _state: state,
    _slideCount: slideCount,
  };
}

/** 브라우저 부트스트랩(전역 window/document/spip 으로 mountWidget 호출). */
function initWidget() {
  const win = (typeof window !== 'undefined') ? window : null;
  const doc = (typeof document !== 'undefined') ? document : null;
  if (!doc) return;
  const spip = (win && win.spip) ? win.spip : null;
  return mountWidget(doc, win, spip);
}

/* =====================================================================
 * 환경 분기
 * ===================================================================== */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    favoriteWidgetViewModels,
    widgetCardVm,
    gitLabel,
    shortenPath,
    nextSlideIndex,
    clampSlideIndex,
    focusGate,
    favoritesChangedView,
    langColor,
    mountWidget,   // 헤드리스 DOM 스텁 주입용
    initWidget,
  };
} else if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initWidget);
  } else {
    initWidget();
  }
}
