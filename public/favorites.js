'use strict';
/**
 * favorites.js — 즐겨찾기 위젯 창 렌더러 (app://favorites.html 전용).
 * 요구ID: R-22(즐겨찾기 독립 위젯 창).
 *
 * [M8-DESIGN] 신규 트레이 플라이아웃 UI — Claude Design "즐겨찾기 트레이" 이식.
 *   프로스티드(글래스) 패널 안에 카드(300px)를 하나의 트랙에 가로로 깔고, 포인터 드래그 +
 *   관성(momentum) + 휠 + 양끝 화살표로 좌우 스크롤한다. 하단 진행 바가 스크롤 위치를 표시.
 *   (이전 M7-FIX 의 "한 장씩 페이징되는 캐러셀"을 디자인의 드래그-스크롤 트랙으로 교체.)
 *
 * 보안(이전 모델에서 보존):
 *   L-1: name·path·desc·branch 등 모든 표시 문자열은 textContent/createElement 로만 렌더(innerHTML 결합 0).
 *   CSP: 인라인 스크립트/이벤트 핸들러 0. 자산은 app:// 상대경로('self')만. 외부 폰트(CDN) 금지 →
 *        시스템 폰트 스택(favorites.css)으로 대체.
 *   SEC-H2 focus 게이팅: 부수효과 액션(open·copyText·setFavorite)은 위젯이 focus 상태일 때만 실행.
 *                        비포커스 첫 클릭은 포커스만 획득(액션 미실행). 드래그/스크롤은 부수효과 아님.
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

/** git 이 실제 레포인지(순수). gitLabel '—' 판정과 동형. */
function isGitRepo(git) {
  git = (git && typeof git === 'object') ? git : {};
  if (git.status === 'na' || git.isRepo === false) return false;
  if (git.status === undefined && git.isRepo === undefined && !(typeof git.branch === 'string' && git.branch)) return false;
  return true;
}

/**
 * project 계약 → 위젯 카드 상태 배지 목록(순수, N-07 색 외 텍스트).
 *   레포 아님 → []. dirty → '미커밋', ahead>0 → '미푸시 N', behind>0 → '미반영 N',
 *   깨끗+동기화 → '정상'. 실 git.dirty 는 boolean(개수 아님)이라 개수 없이 표기.
 */
function widgetBadges(p) {
  p = (p && typeof p === 'object') ? p : {};
  const git = (p.git && typeof p.git === 'object') ? p.git : {};
  if (!isGitRepo(git)) return [];
  const dirty = git.dirty === true;
  const ahead = Number.isInteger(git.ahead) ? git.ahead : 0;
  const behind = Number.isInteger(git.behind) ? git.behind : 0;
  const out = [];
  if (dirty) out.push({ kind: 'dirty', text: '미커밋' });
  if (ahead > 0) out.push({ kind: 'ahead', text: '미푸시 ' + ahead });
  if (behind > 0) out.push({ kind: 'behind', text: '미반영 ' + behind });
  if (!dirty && ahead === 0 && behind === 0) out.push({ kind: 'clean', text: '정상' });
  return out;
}

/** ISO|epoch|null → epoch(ms) | null(순수). */
function dateVal(iso) {
  if (iso == null) return null;
  if (typeof iso === 'number' && Number.isFinite(iso)) return iso;
  if (typeof iso !== 'string' || !iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

/** 상대시간(순수): '오늘'/'어제'/'N일 전'/'N주 전'/'N개월 전'/'N년 전' | '—'(app.js relTime 동형). */
function widgetRelTime(iso, now) {
  const t = dateVal(iso);
  if (t === null) return '—';
  const base = (now instanceof Date) ? now.getTime()
    : (typeof now === 'number' && Number.isFinite(now)) ? now : Date.now();
  const days = Math.floor((base - t) / 86400000);
  if (days <= 0) return '오늘';
  if (days === 1) return '어제';
  if (days < 7) return days + '일 전';
  if (days < 30) return Math.floor(days / 7) + '주 전';
  if (days < 365) return Math.floor(days / 30) + '개월 전';
  return Math.floor(days / 365) + '년 전';
}

/** 바이트 → 사람이 읽는 용량(순수, app.js sizeLabel 동형). */
function bytesLabel(bytes) {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes)) return '미측정';
  if (bytes >= 1 << 30) return (bytes / (1 << 30)).toFixed(1) + ' GB';
  if (bytes >= 1 << 20) return (bytes / (1 << 20)).toFixed(0) + ' MB';
  if (bytes >= 1 << 10) return (bytes / (1 << 10)).toFixed(0) + ' KB';
  return bytes + ' B';
}

/** project.size 계약 → 용량 표시 라벨(순수, app.js sizeStatusLabel 동형). */
function widgetSizeLabel(p) {
  const size = (p && p.size && typeof p.size === 'object') ? p.size : {};
  const status = typeof size.status === 'string' ? size.status : 'skipped';
  const bytes = typeof size.totalBytes === 'number' ? size.totalBytes : null;
  if (status === 'error') return '측정 실패';
  if (status === 'partial') {
    return (bytes !== null) ? ('≈ ' + bytesLabel(bytes) + ' (부분)') : '부분 측정';
  }
  if (status === 'ok' && bytes !== null) return bytesLabel(bytes);
  return bytesLabel(bytes);
}

/** project 계약 → 위젯 카드 부가 표시(순수). 설명/용량/상대시간/배지. widgetCardVm(5필드)과 분리(계약 고정). */
function widgetCardExtra(p, now) {
  p = (p && typeof p === 'object') ? p : {};
  const fresh = (p.freshness && typeof p.freshness === 'object') ? p.freshness : {};
  const desc = (typeof p.description === 'string' && p.description.trim()) ? p.description : '';
  return {
    description: desc,
    size: widgetSizeLabel(p),
    rel: widgetRelTime(fresh.lastModified || null, now),
    badges: widgetBadges(p),
  };
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

/** 슬라이더 인덱스 이동(순수, 래핑). count 항목에서 dir(-1/+1) 이동. 빈 목록 → 0. (양끝 화살표 폴백용 보존) */
function nextSlideIndex(cur, dir, count) {
  const n = Number.isInteger(count) && count > 0 ? count : 0;
  if (n === 0) return 0;
  let i = Number.isInteger(cur) ? cur : 0;
  i = ((i % n) + n) % n;
  const d = (dir === 1 || dir === -1) ? dir : 0;
  return (((i + d) % n) + n) % n;
}

/** 해제 등으로 항목 제거 시 인덱스 보정(순수). 제거 후 길이 newCount 기준 clamp. (보존) */
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
    'JavaScript': '#cba70f', 'TypeScript': '#3178c6', 'Python': '#3572A5',
    'Java': '#b07219', 'Go': '#00a7c4', 'Rust': '#c46a36', 'C#': '#178600',
    'C++': '#6e40c9', 'C': '#6e40c9', 'Ruby': '#701516', 'PHP': '#4f5d95',
    'HTML': '#e34c26', 'CSS': '#9b59b6', 'Shell': '#5b8a2e', 'Node.js': '#5b8a2e',
    'Vue': '#41b883', 'Swift': '#F05138', 'Kotlin': '#A97BFF', 'Markdown': '#78716c',
  };
  return map[lang] || '#a8a29e';
}

/* =====================================================================
 * 위젯 렌더러 (DOM 의존) — mountWidget(doc, win, spip): 헤드리스 DOM 스텁 주입 가능.
 *   카드(300px)를 단일 트랙에 가로로 깔고 포인터 드래그 + 관성 + 휠 + 양끝 화살표로 스크롤.
 *   진행 바가 스크롤 위치/가시 비율을 표시.
 * ===================================================================== */
function mountWidget(doc, win, spip) {
  const root = doc.getElementById('fav-widget');
  if (!root) return null;

  // 위젯 상태(메모리). 단일 진실 원천은 main(ui-state.json) — 여기는 캐시 + show/changed 동기화 뷰.
  const state = {
    favorites: [],   // id 배열(SEC-M2 정규화)
    projects: [],    // getProjects 스냅샷
    focused: (doc && typeof doc.hasFocus === 'function') ? doc.hasFocus() : true,
    busy: false,     // open/copy in-flight(연타 방지)
    toast: '',       // 일시 피드백 토스트
  };

  // 스크롤 트랙 상태(드래그/관성 — render 사이에 보존되는 closure 변수).
  let offset = 0;        // 현재 트랙 translateX(px, ≤0)
  let minOffset = 0;     // 좌측 한계(음수). 0 이면 스크롤 불필요(전부 보임).
  let dragging = false;
  let moved = false;
  let startX = 0;
  let startOff = 0;
  let lastX = 0;
  let lastT = 0;
  let vel = 0;
  let rafId = 0;
  let transTimer = 0;
  let toastTimer = 0;

  // 매 render 마다 갱신되는 DOM 참조.
  let vpEl = null;
  let trackEl = null;
  let progEl = null;
  let prevBtn = null;
  let nextBtn = null;

  const VIEWPORT_PAD = 32; // viewport 좌우 padding 합(16*2) — measure 보정.

  function has(method) { return !!(spip && typeof spip[method] === 'function'); }
  async function call(method, ...args) {
    if (!has(method)) return { ok: false, code: 'NO_BRIDGE' };
    try { return await spip[method](...args); }
    catch (err) { return { ok: false, code: 'INTERNAL', message: (err && err.message) || 'IPC 오류' }; }
  }

  // rAF/performance 헤드리스 가드 — DOM 스텁(win 미구현)에서도 throw 없이 동작.
  function raf(cb) {
    if (win && typeof win.requestAnimationFrame === 'function') return win.requestAnimationFrame(cb);
    return 0;
  }
  function caf(id) {
    if (id && win && typeof win.cancelAnimationFrame === 'function') win.cancelAnimationFrame(id);
  }
  function nowMs() {
    if (typeof performance !== 'undefined' && performance && typeof performance.now === 'function') return performance.now();
    return Date.now();
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
  function svg(opts) {
    opts = opts || {};
    const s = doc.createElementNS(SVG_NS, 'svg');
    const size = opts.size || 16;
    s.setAttribute('viewBox', opts.viewBox || '0 0 24 24');
    s.setAttribute('width', String(opts.w || size));
    s.setAttribute('height', String(opts.h || size));
    s.setAttribute('fill', opts.fill || 'none');
    if (opts.stroke) {
      s.setAttribute('stroke', opts.stroke);
      s.setAttribute('stroke-width', String(opts.sw || 2));
      s.setAttribute('stroke-linecap', 'round');
      s.setAttribute('stroke-linejoin', 'round');
    }
    s.setAttribute('aria-hidden', 'true');
    const paths = Array.isArray(opts.d) ? opts.d : (opts.d ? [opts.d] : []);
    for (const dd of paths) {
      const p = doc.createElementNS(SVG_NS, 'path');
      p.setAttribute('d', dd);
      s.appendChild(p);
    }
    return s;
  }
  function iconChevron(dir) {
    return svg({ d: dir < 0 ? 'M15 6l-6 6 6 6' : 'M9 6l6 6-6 6', stroke: 'currentColor', sw: 2.2, w: 17, h: 17 });
  }
  function iconStar(filled) {
    const d = 'M12 2l2.9 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l7.1-1.01z';
    return svg({ d, w: 15, h: 15, fill: filled ? 'currentColor' : 'none', stroke: 'currentColor', sw: 1.6 });
  }
  function iconGrid() {
    const s = doc.createElementNS(SVG_NS, 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('width', '15'); s.setAttribute('height', '15');
    s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor'); s.setAttribute('stroke-width', '2');
    s.setAttribute('aria-hidden', 'true');
    for (const [x, y] of [[3, 3], [14, 3], [3, 14], [14, 14]]) {
      const r = doc.createElementNS(SVG_NS, 'rect');
      r.setAttribute('x', String(x)); r.setAttribute('y', String(y));
      r.setAttribute('width', '7'); r.setAttribute('height', '7'); r.setAttribute('rx', '1.5');
      s.appendChild(r);
    }
    return s;
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
  // 버튼 위 포인터다운은 트랙 드래그를 시작하지 않도록 차단(클릭 보호).
  function stopPointer(e) { if (e && typeof e.stopPropagation === 'function') e.stopPropagation(); }

  /* ---- 액션(축소 preload 6채널만) ---- */
  async function doOpen(id, name) {
    if (!id || state.busy) return;
    state.busy = true;
    flash((name ? name + ' — ' : '') + 'VS Code로 여는 중…');
    const res = await call('open', id);
    state.busy = false;
    if (res && res.ok === false) flash('열기에 실패했습니다');
  }
  async function doCopy(path) {
    if (!path || state.busy) return;
    state.busy = true;
    const res = await call('copyText', path);
    state.busy = false;
    flash(res && res.ok !== false ? '경로를 복사했습니다' : '복사에 실패했습니다');
  }
  async function doUnfavorite(id) {
    if (!id) return;
    // 낙관적: 메모리 즉시 반영(서버 broadcast 가 정합 동기화).
    state.favorites = state.favorites.filter((x) => x !== id);
    render();
    const res = await call('setFavorite', id, false);
    if (res && res.ok && Array.isArray(res.favorites)) {
      state.favorites = res.favorites.filter((x) => typeof x === 'string');
      render();
    }
  }
  // 헤더 '대시보드 열기' — 메인 대시보드 창 show/focus. 위젯은 blur→자동 숨김(favoritesWidget onBlur).
  async function doOpenDashboard() {
    if (state.busy) return;
    state.busy = true;
    const res = await call('openDashboard');
    state.busy = false;
    if (res && res.ok === false && res.code !== 'NO_BRIDGE') flash('대시보드를 열 수 없습니다');
  }

  function cardCount() {
    return favoriteWidgetViewModels(state.projects, state.favorites).length;
  }

  /* ---- 트랙 스크롤(드래그/관성/휠/화살표) ---- */
  function measure() {
    if (!vpEl || !trackEl) { minOffset = 0; return; }
    const inner = (vpEl.clientWidth || 0) - VIEWPORT_PAD;
    const sw = trackEl.scrollWidth || 0;
    minOffset = Math.min(0, inner - sw);
  }
  function clampOffset() { offset = Math.max(minOffset, Math.min(0, offset)); }
  function setTransition(on) {
    if (trackEl) trackEl.style.transition = on ? 'transform .42s cubic-bezier(.22,1,.36,1)' : 'none';
  }
  function apply() {
    if (trackEl) trackEl.style.transform = 'translate3d(' + offset + 'px,0,0)';
    if (progEl && vpEl && trackEl) {
      const sw = trackEl.scrollWidth || 0;
      const inner = (vpEl.clientWidth || 0) - VIEWPORT_PAD;
      const ratio = sw > 0 ? Math.min(1, inner / sw) : 1;
      const w = Math.max(ratio * 100, 12);
      const frac = minOffset < 0 ? (offset / minOffset) : 0;
      const travel = 100 - w;
      progEl.style.width = w + '%';
      progEl.style.marginLeft = (frac * travel) + '%';
    }
  }
  function syncBounds() {
    const atStart = offset >= -0.5;
    const atEnd = offset <= minOffset + 0.5 || minOffset >= -0.5;
    if (prevBtn) prevBtn.classList.toggle('is-off', atStart);
    if (nextBtn) nextBtn.classList.toggle('is-off', atEnd);
  }

  function onDown(e) {
    caf(rafId);
    measure();
    dragging = true; moved = false;
    startX = e.clientX; startOff = offset;
    lastX = e.clientX; lastT = nowMs(); vel = 0;
    setTransition(false);
    if (vpEl) vpEl.classList.add('is-grabbing');
    try { if (e.currentTarget && e.currentTarget.setPointerCapture) e.currentTarget.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
  }
  function onMove(e) {
    if (!dragging) return;
    const dx = e.clientX - startX;
    if (Math.abs(dx) > 3) moved = true;
    let next = startOff + dx;
    if (next > 0) next = next * 0.4;                                  // rubber-band(좌측 한계 초과)
    else if (next < minOffset) next = minOffset + (next - minOffset) * 0.4; // (우측 한계 초과)
    offset = next;
    const t = nowMs(), dt = t - lastT;
    if (dt > 0) vel = (e.clientX - lastX) / dt;
    lastX = e.clientX; lastT = t;
    apply();
  }
  function onUp(e) {
    if (!dragging) return;
    dragging = false;
    if (vpEl) vpEl.classList.remove('is-grabbing');
    try { if (e && e.currentTarget && e.currentTarget.releasePointerCapture) e.currentTarget.releasePointerCapture(e.pointerId); } catch (_) { /* ignore */ }
    momentum();
  }
  function onLeave() { if (dragging) { dragging = false; if (vpEl) vpEl.classList.remove('is-grabbing'); momentum(); } }

  function momentum() {
    let v = vel * 16; // px/frame
    const step = () => {
      if (offset > 0) { offset += (0 - offset) * 0.2; if (Math.abs(offset) < 0.5) offset = 0; }
      else if (offset < minOffset) { offset += (minOffset - offset) * 0.2; if (Math.abs(offset - minOffset) < 0.5) offset = minOffset; }
      else { offset += v; v *= 0.92; if (offset > 0) offset = 0; if (offset < minOffset) offset = minOffset; }
      apply();
      const settled = Math.abs(v) < 0.15;
      const inBounds = offset <= 0.5 && offset >= minOffset - 0.5;
      if (settled && inBounds) { apply(); syncBounds(); return; }
      rafId = raf(step);
    };
    rafId = raf(step);
  }

  function animateTo(target) {
    caf(rafId);
    measure();
    offset = Math.max(minOffset, Math.min(0, target));
    setTransition(true);
    apply();
    syncBounds();
    clearTimeout(transTimer);
    transTimer = setTimeout(() => setTransition(false), 460);
  }
  function pageSize() {
    const w = vpEl ? (vpEl.clientWidth || 0) : 0;
    return Math.max(220, w - 120);
  }
  function next() { animateTo(offset - pageSize()); }
  function prev() { animateTo(offset + pageSize()); }

  function onWheel(e) {
    const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    if (d === 0) return;
    if (typeof e.preventDefault === 'function') e.preventDefault();
    caf(rafId);
    measure();
    setTransition(false);
    offset = Math.max(minOffset, Math.min(0, offset - d));
    apply();
    syncBounds();
  }

  function flash(msg) {
    state.toast = msg;
    render();
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { state.toast = ''; render(); }, 1800);
  }

  /* ---- 카드 빌더 — 디자인 트레이 카드 ---- */
  function buildCard(p, gate, now) {
    const vm = widgetCardVm(p);
    const extra = widgetCardExtra(p, now);

    const card = el('article', {
      cls: 'fav-card',
      attrs: { role: 'group', 'aria-roledescription': '즐겨찾기 카드', 'aria-label': vm.name },
    });

    // ── 헤더(이름·경로 + 별 해제) ──
    const idBlock = el('div', { cls: 'fav-card__id', children: [
      el('h2', { cls: 'fav-card__name', text: vm.name, title: vm.name }),  // L-1
      el('div', { cls: 'fav-card__path', text: shortenPath(vm.path), title: vm.path }), // L-1
    ]});
    const star = el('button', {
      cls: 'fav-card__star',
      attrs: { type: 'button', 'aria-label': '즐겨찾기 해제: ' + vm.name, title: '즐겨찾기 해제' },
      children: [iconStar(true)],
      on: { click: guardedAction(() => doUnfavorite(vm.id)), pointerdown: stopPointer },
    });
    if (!gate.allow || !vm.id) star.disabled = true;
    const head = el('div', { cls: 'fav-card__head', children: [langDot(vm.language), idBlock, star] });

    // ── 설명(2줄 클램프) ──
    const desc = el('div', {
      cls: 'fav-card__desc' + (extra.description ? '' : ' is-empty'),
      text: extra.description || '설명 없음',
    });

    // ── 배지(언어 + git 상태) ──
    const badges = el('div', { cls: 'fav-card__badges' });
    badges.appendChild(el('span', { cls: 'fav-badge fav-badge--lang', text: vm.language }));
    for (const b of extra.badges) {
      badges.appendChild(el('span', { cls: 'fav-badge fav-badge--' + b.kind, text: b.text }));
    }

    const body = el('div', { cls: 'fav-card__body', children: [head, desc, badges] });

    // ── 푸터(상대시간·용량 + 복사/열기) ──
    const meta = el('div', { cls: 'fav-card__meta', children: [
      el('span', { text: extra.rel }),
      el('span', { cls: 'fav-card__metasep', text: '·', attrs: { 'aria-hidden': 'true' } }),
      el('span', { text: extra.size }),
    ]});
    const copyBtn = el('button', {
      cls: 'fav-act',
      attrs: { type: 'button', 'aria-label': '경로 복사: ' + vm.path, title: '경로 복사' },
      text: '복사',
      on: { click: guardedAction(() => doCopy(vm.path)), pointerdown: stopPointer },
    });
    const openBtn = el('button', {
      cls: 'fav-act fav-act--primary',
      attrs: { type: 'button', 'aria-label': 'VS Code로 열기: ' + vm.name, title: 'VS Code로 열기' },
      text: '열기',
      on: { click: guardedAction(() => doOpen(vm.id, vm.name)), pointerdown: stopPointer },
    });
    if (!gate.allow) { copyBtn.disabled = true; openBtn.disabled = true; }
    if (!vm.path) copyBtn.disabled = true;
    if (!vm.id) openBtn.disabled = true;
    const acts = el('div', { cls: 'fav-card__acts', children: [copyBtn, openBtn] });
    const foot = el('div', { cls: 'fav-card__foot', children: [meta, acts] });

    card.appendChild(body);
    card.appendChild(foot);
    return card;
  }

  /* ---- 헤더(로고·제목·개수·닫기) ---- */
  function buildHeader(count) {
    const logo = el('div', { cls: 'fav-head__logo', text: 'S', attrs: { 'aria-hidden': 'true' } });
    const titleRow = el('div', { cls: 'fav-head__titlerow', children: [
      el('span', { cls: 'fav-head__title', text: '즐겨찾기' }),
      el('span', { cls: 'fav-head__count', text: String(count) }),
    ]});
    const sub = el('div', { cls: 'fav-head__sub', text: '좌우로 드래그해 카드를 넘기세요' });
    const titleBlock = el('div', { cls: 'fav-head__block', children: [titleRow, sub] });
    // 디자인 참고 코드와 동일 위치(우상단)에 '대시보드 열기'(그리드) 버튼. 닫기는 Esc·포커스 이탈(blur)로 수행.
    const dash = el('button', {
      cls: 'fav-head__dash',
      attrs: { type: 'button', 'aria-label': '대시보드 열기', title: '대시보드 열기' },
      children: [iconGrid()],
      on: { click: guardedAction(() => doOpenDashboard()) },
    });
    if (!focusGate(state.focused).allow) dash.disabled = true;
    return el('div', { cls: 'fav-head', children: [logo, titleBlock, dash] });
  }

  /* ---- 렌더(전체 재구성) ---- */
  function render() {
    while (root.firstChild) root.removeChild(root.firstChild);
    root.classList.toggle('is-blurred', !state.focused);

    const projectsVm = favoriteWidgetViewModels(state.projects, state.favorites);
    const count = projectsVm.length;
    root.appendChild(buildHeader(count));

    // 빈 상태(즐겨찾기 0개)
    if (count === 0) {
      vpEl = trackEl = progEl = prevBtn = nextBtn = null;
      root.appendChild(el('div', { cls: 'fav-empty', children: [
        el('div', { cls: 'fav-empty__icon', attrs: { 'aria-hidden': 'true' }, children: [
          iconStar(false),
        ]}),
        el('div', { cls: 'fav-empty__title', text: '즐겨찾기한 프로젝트가 없습니다' }),
        el('div', { cls: 'fav-empty__sub', text: '대시보드에서 카드의 별(★)을 눌러 추가하세요.' }),
      ]}));
      if (state.toast) root.appendChild(buildToast(state.toast));
      return;
    }

    const gate = focusGate(state.focused);
    const now = Date.now();

    // ── 캐러셀(드래그 스크롤 트랙) ──
    const viewport = el('div', {
      cls: 'fav-carousel__viewport',
      attrs: { role: 'region', 'aria-label': '즐겨찾기 목록 (좌우 스크롤)' },
      on: {
        pointerdown: onDown, pointermove: onMove, pointerup: onUp,
        pointercancel: onUp, pointerleave: onLeave, wheel: onWheel,
      },
    });
    const track = el('div', { cls: 'fav-carousel__track' });
    for (const p of projectsVm) track.appendChild(buildCard(p, gate, now));
    viewport.appendChild(track);

    const prev = el('button', {
      cls: 'fav-carousel__nav fav-carousel__nav--prev',
      attrs: { type: 'button', 'aria-label': '이전 카드' },
      children: [iconChevron(-1)],
      on: { click: () => prev_(), pointerdown: stopPointer },
    });
    const nxt = el('button', {
      cls: 'fav-carousel__nav fav-carousel__nav--next',
      attrs: { type: 'button', 'aria-label': '다음 카드' },
      children: [iconChevron(1)],
      on: { click: () => next_(), pointerdown: stopPointer },
    });
    const carousel = el('div', { cls: 'fav-carousel', children: [viewport, prev, nxt] });
    root.appendChild(carousel);

    // ── 진행 바 ──
    const prog = el('div', { cls: 'fav-prog__bar' });
    const progTrack = el('div', { cls: 'fav-prog', attrs: { 'aria-hidden': 'true' }, children: [prog] });
    root.appendChild(el('div', { cls: 'fav-foot', children: [progTrack] }));

    // refs 갱신 후 측정/적용.
    vpEl = viewport; trackEl = track; progEl = prog; prevBtn = prev; nextBtn = nxt;
    setTransition(false);
    measure();
    clampOffset();
    apply();
    syncBounds();

    if (state.toast) root.appendChild(buildToast(state.toast));
  }

  // 화살표 핸들러(이름 충돌 회피용 래퍼).
  function prev_() { prev(); }
  function next_() { next(); }

  function buildToast(msg) {
    return el('div', {
      cls: 'fav-toast', attrs: { role: 'status', 'aria-live': 'polite' },
      children: [
        svg({ d: 'M5 12l4 4 10-10', stroke: 'currentColor', sw: 2.4, w: 14, h: 14 }),
        el('span', { text: msg }),
      ],
    });
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
    render();
  }

  /* ---- 이벤트 배선 ---- */
  if (win && typeof win.addEventListener === 'function') {
    win.addEventListener('keydown', (e) => {
      if (!e) return;
      if (e.key === 'Escape') { if (e.preventDefault) e.preventDefault(); requestClose(); return; }
      if (e.key === 'ArrowLeft') { if (e.preventDefault) e.preventDefault(); prev(); return; }
      if (e.key === 'ArrowRight') { if (e.preventDefault) e.preventDefault(); next(); }
    });
    win.addEventListener('focus', () => { state.focused = true; refresh(); });
    win.addEventListener('blur', () => { state.focused = false; render(); });
    win.addEventListener('resize', () => { measure(); clampOffset(); apply(); syncBounds(); });
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
    next,
    prev,
    _state: state,
    _count: cardCount,
    _getOffset: () => offset,
    _getMinOffset: () => minOffset,
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
    isGitRepo,
    widgetBadges,
    widgetRelTime,
    widgetSizeLabel,
    widgetCardExtra,
    bytesLabel,
    dateVal,
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
