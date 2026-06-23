'use strict';
/**
 * SPIP 대시보드 클라이언트 — store / view / filter / actions (Claude Design 시안 재현)
 * 요구ID: R-10(렌더) · R-11(필터·정렬·검색, 클라이언트 메모리 단일 출처) · R-12(열기 액션)
 *
 * 보안 L-1: 모든 스캔/서버 유래 문자열(name·path·description·branch·언어 등)은
 *   textContent/createElement로만 렌더한다. innerHTML에 데이터 결합 절대 금지.
 * CSP: 인라인 스크립트/이벤트 핸들러 0. 외부 자산 0. /static/* 만 참조.
 *
 * 순수 함수(매핑/필터/정렬/검색/통계/상대시간/언어퍼센트/에러매핑)는 DOM 비의존으로
 * 분리하여 node:test로 검증한다(파일 하단 CommonJS export).
 */

/* =====================================================================
 * 순수 로직 (DOM 비의존, 테스트 대상)
 * ===================================================================== */

/** 계약 Project shape를 안전한 표시용 뷰모델로 매핑. 결측/널 graceful 처리. */
function toViewModel(p) {
  // P2-5: 최상위 p가 null/원시값이면 빈 객체로 방어. 비정상 항목도 렌더 전체를 깨지 않도록.
  p = (p && typeof p === 'object') ? p : {};
  const git = (p && p.git) || {};
  const lang = (p && p.language) || {};
  const fresh = (p && p.freshness) || {};
  const size = (p && p.size) || {};
  // 실 git.dirty 는 boolean(개수 아님). status==='na'면 Git 아님.
  const gitStatus = git.status === 'na' ? 'na' : (git.dirty === true ? 'dirty' : 'clean');
  const ahead = gitStatus === 'na' ? null : (typeof git.ahead === 'number' ? git.ahead : null);
  const behind = gitStatus === 'na' ? null : (typeof git.behind === 'number' ? git.behind : null);
  return {
    id: typeof p.id === 'string' ? p.id : '',
    name: orName(p.name),
    path: orName(p.path),
    description: (typeof p.description === 'string' && p.description.trim()) ? p.description : null,
    language: (typeof lang.primary === 'string' && lang.primary) ? lang.primary : '알 수 없음',
    breakdown: (lang.breakdown && typeof lang.breakdown === 'object') ? lang.breakdown : {},
    isStale: fresh.isStale === true,
    lastModified: fresh.lastModified || null,
    lastCommit: fresh.lastCommit || null,
    gitStatus,                       // 'clean' | 'dirty' | 'na'
    isRepo: gitStatus !== 'na',
    branch: gitStatus === 'na' ? null : (git.branch || null),
    dirty: gitStatus === 'na' ? null : (git.dirty === true),
    ahead,
    behind,
    // size: MVP에서 status==='skipped' & 전부 null → "미측정"
    sizeStatus: typeof size.status === 'string' ? size.status : 'skipped',
    totalBytes: typeof size.totalBytes === 'number' ? size.totalBytes : null,
    nodeModulesBytes: typeof size.nodeModulesBytes === 'number' ? size.nodeModulesBytes : null,
    deps: typeof size.deps === 'number' ? size.deps : null,
    devDeps: typeof size.devDeps === 'number' ? size.devDeps : null,
  };
}

function orName(v) {
  return (typeof v === 'string' && v.length) ? v : '(이름 없음)';
}

/**
 * IPC 액션 실패를 사용자 친화 한국어 메시지로 매핑(BUG-2).
 * `{ok:false, code}` 반환 객체를 호출처가 실패로 분기해 이 함수로 넘긴다.
 * 인자: (data) 1개 — IPC 반환 객체. (구 시그니처 (status, data) 호환: 객체를 두 번째로도 허용)
 */
function describeError(data, maybeData) {
  // 구 호출부 호환: describeError(status, data) 형태로 와도 객체 인자를 찾아낸다.
  const obj = (data && typeof data === 'object') ? data
    : (maybeData && typeof maybeData === 'object') ? maybeData : {};
  const code = typeof obj.code === 'string' ? obj.code : '';
  switch (code) {
    case 'CODE_CLI_NOT_FOUND':
      return 'VS Code CLI(code)를 찾을 수 없습니다. PATH에 추가하세요.';
    case 'OPEN_FAILED':
      return 'VS Code 실행에 실패했습니다.';
    case 'PATH_GONE':
      return '프로젝트 폴더가 더 이상 존재하지 않습니다.';
    case 'ID_NOT_FOUND':
      return '프로젝트를 찾을 수 없습니다. 다시 스캔해 보세요.';
    case 'PATH_NOT_ALLOWED':
      return '허용되지 않은 경로입니다.';
    case 'NO_SCAN_ROOTS':
      return '스캔할 루트 폴더가 없습니다. 폴더를 먼저 추가하세요.';
    case 'SCAN_IN_PROGRESS':
      return '이미 스캔이 진행 중입니다.';
    case 'INVALID_PATH':
      return '경로 형식이 올바르지 않습니다.';
    case 'CANCELLED':
      return '폴더 선택이 취소되었습니다.';
    case 'NOT_FOUND':
      return '해당 항목을 찾을 수 없습니다.';
    case 'INTERNAL':
      return '내부 오류가 발생했습니다. 잠시 후 다시 시도하세요.';
    default:
      return code ? ('알 수 없는 오류 (' + code + ')') : '요청을 처리하지 못했습니다.';
  }
}

/** addRoots/pickFolders 의 rejected 항목 사유 토큰을 한국어로 매핑(§4.2 고정 토큰). */
function describeRejectReason(reason) {
  switch (reason) {
    case 'NOT_FOUND': return '폴더를 찾을 수 없음';
    case 'NOT_DIR': return '폴더가 아님';
    case 'SYSTEM_DIR': return '시스템 폴더는 추가할 수 없음';
    case 'DUP': return '이미 추가된 폴더';
    default: return '추가 거부됨';
  }
}

/** 정규화된 검색어 부분일치(이름·경로, 대소문자 무시, 리터럴). */
function matchesSearch(vm, query) {
  if (!query) return true;
  const q = query.toLowerCase();
  return vm.name.toLowerCase().includes(q) || vm.path.toLowerCase().includes(q);
}

/**
 * 다중선택 패싯 AND/OR 필터.
 * filters = { languages:[], freshness:[], git:[] }
 * - languages: OR(선택 언어 중 하나라도). 빈 배열이면 통과.
 * - freshness: OR. 'active'(활동중=!isStale) | 'stale'.
 * - git: OR. 'clean'|'dirty'|'ahead'|'norepo' (vm의 gitKeys와 교집합).
 * 카테고리 간에는 AND.
 */
function matchesFilters(vm, filters) {
  filters = filters || {};
  const langs = filters.languages || [];
  const fresh = filters.freshness || [];
  const git = filters.git || [];
  if (langs.length && !langs.includes(vm.language)) return false;
  if (fresh.length) {
    const key = vm.isStale ? 'stale' : 'active';
    if (!fresh.includes(key)) return false;
  }
  if (git.length) {
    const keys = gitKeys(vm);
    if (!keys.some((k) => git.includes(k))) return false;
  }
  return true;
}

/** 뷰모델의 Git 패싯 키 목록. norepo / clean / dirty / ahead 복합 가능. */
function gitKeys(vm) {
  if (vm.gitStatus === 'na') return ['norepo'];
  const keys = [];
  if (vm.gitStatus !== 'dirty' && !(vm.ahead > 0)) keys.push('clean');
  if (vm.gitStatus === 'dirty') keys.push('dirty');
  if (vm.ahead > 0) keys.push('ahead');
  if (keys.length === 0) keys.push('clean');
  return keys;
}

/** 필터(AND/OR) → 검색 → 정렬을 메모리에서 결합 적용. 원본 배열 불변. */
function applyQuery(viewModels, state) {
  const out = viewModels.filter(
    (vm) => matchesFilters(vm, state.filters) && matchesSearch(vm, state.search || '')
  );
  return sortViewModels(out, state.sort || 'modified');
}

/**
 * 정렬. 시안 키: 'modified'(최근수정순) | 'name'(이름순) | 'size'(용량순).
 * 'size'는 MVP 미측정 → 데이터 없으면 자동으로 'modified' 폴백(호출부에서 안내).
 * 결측 날짜(null lastModified)는 항상 말단.
 */
function sortViewModels(list, sortKey) {
  const arr = list.slice();
  const byName = (a, b) => a.name.localeCompare(b.name, 'ko');
  if (sortKey === 'name') {
    arr.sort(byName);
  } else if (sortKey === 'size') {
    // 용량 데이터가 모두 null이면 최근수정 폴백
    const anySize = arr.some((v) => typeof v.totalBytes === 'number');
    if (anySize) {
      arr.sort((a, b) => (numOr(b.totalBytes, -1) - numOr(a.totalBytes, -1)) || byName(a, b));
    } else {
      arr.sort((a, b) => cmpDateDesc(a.lastModified, b.lastModified) || byName(a, b));
    }
  } else {
    // 'modified' = 최근수정순(내림차순)
    arr.sort((a, b) => cmpDateDesc(a.lastModified, b.lastModified) || byName(a, b));
  }
  return arr;
}

/** 용량 정렬이 실제로 가능한지(데이터 존재) 여부. */
function canSortBySize(viewModels) {
  return viewModels.some((v) => typeof v.totalBytes === 'number');
}

/** 최신순: 큰 날짜 먼저, null은 말단. */
function cmpDateDesc(a, b) {
  const ta = dateVal(a), tb = dateVal(b);
  if (ta === null && tb === null) return 0;
  if (ta === null) return 1;
  if (tb === null) return -1;
  return tb - ta;
}
function dateVal(iso) {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

/** 통계 응답에서 표시용 값 도출. totalBytes는 size 측정 스냅샷이면 실값(§4.3). */
function deriveStats(stats, viewModels) {
  const list = Array.isArray(viewModels) ? viewModels : [];
  const byLang = (stats && stats.byLanguage && typeof stats.byLanguage === 'object')
    ? stats.byLanguage : {};
  const total = numOr(stats && stats.total, list.length);
  const staleCount = numOr(stats && stats.staleCount, list.filter((v) => v.isStale).length);

  // M4 §4.3: stats.totalBytes 가 number 면 실값. null/미존재면 viewModels 에서 합산 폴백.
  //   (stats 가 아직 totalBytes 를 안 채우면 측정된 항목 합으로 KPI 채움 — graceful)
  const statsTotal = (stats && typeof stats.totalBytes === 'number') ? stats.totalBytes : null;
  const totalBytesNum = statsTotal != null ? statsTotal : sumTotalBytes(list);
  const nmBytesNum = sumNodeModulesBytes(list);
  return {
    total,
    staleCount,
    activeCount: total - staleCount,
    languageCount: Object.keys(byLang).length,
    totalBytes: sizeLabel(totalBytesNum),         // number 면 "1.2 GB", 없으면 "미측정"
    nodeModulesBytes: sizeLabel(nmBytesNum),
    totalBytesMeasured: totalBytesNum != null,    // KPI 강조 분기용
  };
}

/** 측정된(ok/partial) 항목들의 totalBytes 합. 모두 미측정이면 null. */
function sumTotalBytes(viewModels) {
  let sum = 0;
  let any = false;
  for (const v of (viewModels || [])) {
    if (typeof v.totalBytes === 'number' && Number.isFinite(v.totalBytes)) { sum += v.totalBytes; any = true; }
  }
  return any ? sum : null;
}
/** 측정된 항목들의 nodeModulesBytes 합. 모두 미측정이면 null. */
function sumNodeModulesBytes(viewModels) {
  let sum = 0;
  let any = false;
  for (const v of (viewModels || [])) {
    if (typeof v.nodeModulesBytes === 'number' && Number.isFinite(v.nodeModulesBytes)) { sum += v.nodeModulesBytes; any = true; }
  }
  return any ? sum : null;
}
function numOr(v, fallback) {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/** 빈 상태 판정 (P2-5): hasSnapshot=false 또는 projects 없음/빈 배열 → firstRun. */
function isEmptySnapshot(payload) {
  if (!payload) return true;
  if (payload.hasSnapshot === false) return true;
  if (!Array.isArray(payload.projects)) return true;
  return payload.projects.length === 0;
}

/**
 * 언어 패싯 집계: [{ lang, count }] 내림차순(동률은 이름).
 * 사이드바/툴바 체크박스·KPI 막대/범례 공통 소스.
 */
function languageFacets(viewModels) {
  const counts = {};
  for (const vm of viewModels) counts[vm.language] = (counts[vm.language] || 0) + 1;
  return Object.keys(counts)
    .map((lang) => ({ lang, count: counts[lang] }))
    .sort((a, b) => (b.count - a.count) || a.lang.localeCompare(b.lang, 'ko'));
}

/** Git 패싯별 개수: { clean, dirty, ahead, norepo }. */
function gitFacetCounts(viewModels) {
  const c = { clean: 0, dirty: 0, ahead: 0, norepo: 0 };
  for (const vm of viewModels) {
    for (const k of gitKeys(vm)) { if (k in c) c[k] += 1; }
  }
  return c;
}

/** KPI: 미커밋(dirty) 개수 / 미푸시(ahead>0) 개수. */
function gitChangeCounts(viewModels) {
  let dirty = 0, ahead = 0;
  for (const vm of viewModels) {
    if (vm.gitStatus === 'dirty') dirty += 1;
    if (vm.ahead > 0) ahead += 1;
  }
  return { dirty, ahead };
}

/**
 * 언어 비율(breakdown: {lang:0~1}) → [{ name, pct }] 퍼센트 내림차순.
 * 합이 1이 아니어도 그대로 환산(반올림). 빈 breakdown은 primary 100%.
 */
function langPercents(vm) {
  const bd = vm.breakdown || {};
  const keys = Object.keys(bd);
  if (keys.length === 0) {
    return [{ name: vm.language, pct: 100 }];
  }
  return keys
    .map((name) => ({ name, pct: Math.round((bd[name] || 0) * 100) }))
    .sort((a, b) => b.pct - a.pct);
}

/** 언어별 도트 색상(시안 팔레트). 미지정은 중립색. */
function langColor(lang) {
  const m = {
    'TypeScript': '#3178c6', 'JavaScript': '#cba70f', 'Node.js': '#5b8a2e',
    'Python': '#3572A5', 'Go': '#00a7c4', 'Rust': '#c46a36', 'C++': '#6e40c9',
    'C': '#6e40c9', 'Shell': '#5b8a2e', 'HTML': '#e34c26', 'CSS': '#9b59b6',
    'Java': '#b07219', 'Ruby': '#701516', 'PHP': '#4F5D95', 'Vue': '#41b883',
    'Swift': '#F05138', 'Kotlin': '#A97BFF', 'Markdown': '#78716c',
  };
  return m[lang] || '#a8a29e';
}

/**
 * 상대시간(ISO|null, now=Date) → '오늘'/'어제'/'N일 전'/'N주 전'/'N개월 전'/'N년 전' | 'N/A'.
 */
function relTime(iso, now) {
  const t = dateVal(iso);
  if (t === null) return 'N/A';
  const base = (now instanceof Date) ? now.getTime() : Date.now();
  const days = Math.floor((base - t) / 86400000);
  if (days <= 0) return '오늘';
  if (days === 1) return '어제';
  if (days < 7) return days + '일 전';
  if (days < 30) return Math.floor(days / 7) + '주 전';
  if (days < 365) return Math.floor(days / 30) + '개월 전';
  return Math.floor(days / 365) + '년 전';
}

/** 절대일자(ISO|null) → 'YYYY-MM-DD' | '—'. */
function fmtDate(iso) {
  const t = dateVal(iso);
  if (t === null) return '—';
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

/** 바이트 → 사람이 읽는 용량(미측정이면 그대로 '미측정'). */
function sizeLabel(bytes) {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes)) return '미측정';
  if (bytes >= 1 << 30) return (bytes / (1 << 30)).toFixed(1) + ' GB';
  if (bytes >= 1 << 20) return (bytes / (1 << 20)).toFixed(0) + ' MB';
  if (bytes >= 1 << 10) return (bytes / (1 << 10)).toFixed(0) + ' KB';
  return bytes + ' B';
}

/**
 * M4 §4.2: size.data.status 별 표시 라벨.
 *   ok       → "1.2 GB"
 *   partial  → "≈ 1.2 GB (부분)"        (예산/상한 도달 — 근사)
 *   error    → "측정 실패"
 *   skipped  → "미측정"   (또는 totalBytes 없음)
 * 색만으로 구분하지 않도록 텍스트로 상태를 병기(N-07 색 외 텍스트, WCAG 1.4.1).
 */
function sizeStatusLabel(status, bytes) {
  if (status === 'error') return '측정 실패';
  if (status === 'partial') {
    return (typeof bytes === 'number' && Number.isFinite(bytes))
      ? ('≈ ' + sizeLabel(bytes) + ' (부분)')
      : '부분 측정';
  }
  if (status === 'ok' && typeof bytes === 'number' && Number.isFinite(bytes)) {
    return sizeLabel(bytes);
  }
  // skipped / null / 알 수 없음
  return sizeLabel(typeof bytes === 'number' ? bytes : null);
}

/* =====================================================================
 * M4 R-15: 스캔 진행 폴링 상태 머신 / 포맷 (순수, 테스트 대상)
 * ===================================================================== */

/**
 * Electron 전환(R-15): 1초 폴링 폐기 → main→renderer 이벤트 푸시(onScanProgress) 구독.
 * 폴링 상태머신(nextPollAction)을 push 모델에 맞게 재정의한다 — 입력원만 교체되고
 * scanId 대조(M4-L-1)·phase 전이(done→refetch / error / scanning→render)는 보존한다.
 * push 모델에서는 타이머·idle 상한이 사라지므로 'continue'/'stop' 액션은 제거하고,
 * 진행 미관측(idle/null)은 'render'(현 진행 패널 유지)로 단순화한다.
 *
 *   ctx = { ownScanId:string|null }
 *     - ownScanId : rescan 성공(SCAN_STARTED)에서 받은 scanId. null 이면 대조 생략(이미 진행 중 따라붙기).
 *   payload = ScanProgress | null    — onScanProgress 콜백이 받은 객체(또는 getScanStatus 동기화)
 * 반환 { action, reason } :
 *   action='render'   진행 패널 갱신(scanning/finalizing/idle — 계속 구독)
 *   action='refetch'  phase=done → 구독 해제 + getProjects/getStats 재조회
 *   action='error'    phase=error → 구독 해제 + 오류 표시
 *   action='foreign'  scanId 불일치(다른 스캔) → 무시
 */
function nextScanAction(ctx, payload) {
  ctx = ctx || {};
  if (!payload || typeof payload !== 'object') {
    return { action: 'render', reason: 'no-status' };
  }
  const phase = typeof payload.phase === 'string' ? payload.phase : 'idle';
  // scanId 대조: 양쪽 모두 있고 다르면 다른 스캔으로 간주(혼선 방지, M4-L-1).
  if (ctx.ownScanId && payload.scanId && payload.scanId !== ctx.ownScanId) {
    return { action: 'foreign', reason: 'scanId-mismatch' };
  }
  if (phase === 'done') return { action: 'refetch', reason: 'done' };
  if (phase === 'error') return { action: 'error', reason: 'error' };
  // scanning / finalizing / idle / 알 수 없는 phase — 진행 패널 갱신하며 계속 구독
  return { action: 'render', reason: phase };
}

/**
 * ScanProgress → 진행 패널 표시 뷰모델(순수). 모든 문자열 textContent 대상(L-1, M4-L-2).
 *   pct 는 서버가 안 주므로(설계상 dirs/found만) found 진척이 아닌 "불확정 진행"으로 처리:
 *   - done/finalizing → 100
 *   - scanning → null(불확정) — 호출부가 indeterminate 바 표시
 */
function progressView(status) {
  const s = (status && typeof status === 'object') ? status : {};
  const phase = typeof s.phase === 'string' ? s.phase : 'idle';
  const dirs = numOr(s.dirs, 0);
  const found = numOr(s.found, 0);
  const elapsedMs = numOr(s.elapsedMs, 0);
  const done = phase === 'done';
  const finalizing = phase === 'finalizing';
  return {
    phase,
    running: phase === 'scanning',
    finalizing,
    done,
    error: phase === 'error',
    dirs,
    found,
    elapsedSec: Math.max(0, Math.floor(elapsedMs / 1000)),
    pct: (done || finalizing) ? 100 : null,   // null = indeterminate
    // currentPath / note 는 서버 유래 문자열 → 호출부에서 textContent 로만 렌더
    currentPath: typeof s.currentPath === 'string' ? s.currentPath : null,
    note: typeof s.note === 'string' ? s.note : null,
    title: progressTitle(phase),
    counts: (s.counts && typeof s.counts === 'object') ? s.counts : null,
  };
}
function progressTitle(phase) {
  switch (phase) {
    case 'scanning': return '프로젝트 스캔 중…';
    case 'finalizing': return '마무리 중…';
    case 'done': return '스캔 완료';
    case 'error': return '스캔 실패';
    default: return '스캔 준비 중…';
  }
}

/** 정수 천단위 콤마(진행 카운트 표시용). */
function fmtCount(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '0';
  return Math.round(n).toLocaleString('en-US');
}

/** 경과(초) → "12s" / "1m 03s". */
function fmtElapsed(sec) {
  const s = typeof sec === 'number' && Number.isFinite(sec) ? Math.max(0, Math.floor(sec)) : 0;
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m + 'm ' + String(r).padStart(2, '0') + 's';
}

/**
 * rescan IPC 반환 → 액션 분류(순수). 진행 구독 시작/토스트 분기용.
 * IPC 계약(§4.1): 성공 `{ok:true, code:'SCAN_STARTED', scanId, startedAt}`,
 *   실패 `{ok:false, code:'SCAN_IN_PROGRESS'|'NO_SCAN_ROOTS', scanId?, message?}`.
 * HTTP 상태코드가 없어졌으므로 ok/code 만으로 분류한다(인자 1개).
 *   반환 { action, code, scanId? }
 *     'start'        SCAN_STARTED → 진행 구독 시작
 *     'in-progress'  SCAN_IN_PROGRESS → 안내(이미 진행 중, 따라붙어 구독)
 *     'no-roots'     NO_SCAN_ROOTS → 폴더 추가 안내
 *     'error'        기타 실패(INTERNAL 등)
 */
function classifyRescan(data) {
  const d = (data && typeof data === 'object') ? data : {};
  const code = typeof d.code === 'string' ? d.code : '';
  const scanId = typeof d.scanId === 'string' ? d.scanId : null;
  if (d.ok === true && (code === 'SCAN_STARTED' || code === '')) {
    return { action: 'start', code: code || 'SCAN_STARTED', scanId };
  }
  if (code === 'SCAN_IN_PROGRESS') return { action: 'in-progress', code, scanId };
  if (code === 'NO_SCAN_ROOTS') return { action: 'no-roots', code };
  return { action: 'error', code: code || 'INTERNAL' };
}

/**
 * P2-1: 네이티브 메뉴 명령(onMenu cb 가 받는 {action}) → renderer 핸들러 토큰(순수).
 * preload `window.spip.onMenu(cb)` 가 main/menu 의 `spip:menu:*` send 를 받아 cb({action}) 로
 * 전달한다(공유 계약). 여기서는 action 문자열을 핸들러 식별 토큰으로 결정론적으로 매핑한다 —
 * 디스패치 부수효과는 호출부(initBrowser)가 담당하고, 매핑 자체만 헤드리스로 단위테스트한다.
 *   action ∈ pickFolders | rescan | refresh | about
 *   반환 { handler:'pickFolders'|'rescan'|'refresh'|'about'|null }
 *     null = 알 수 없는/누락 action(graceful 무시). cb 가 객체가 아니거나 action 비문자열이어도 null.
 */
function dispatchMenuAction(msg) {
  const action = (msg && typeof msg === 'object' && typeof msg.action === 'string') ? msg.action : '';
  switch (action) {
    case 'pickFolders': return { handler: 'pickFolders' };
    case 'rescan':      return { handler: 'rescan' };
    case 'refresh':     return { handler: 'refresh' };
    case 'about':       return { handler: 'about' };
    default:            return { handler: null };
  }
}

/**
 * P2-6: 스캔 done→대시보드 전환 뷰 결정(순수, 결정론적).
 * 기존엔 done 후 1100ms 고정 타이머로 dashboard 전환 → 사용자 뷰 전환과 레이스(매직넘버).
 * 데이터 재조회(getProjects)가 끝난 시점에 스냅샷 내용만으로 다음 뷰를 결정한다 — 타이머 제거.
 *   payload  = getProjects 결과(스냅샷) 또는 null
 *   반환 { view:'dashboard'|'firstRun', empty:boolean }
 *     empty 스냅샷 → firstRun, 아니면 dashboard. 재조회 완료 == 전환 시점(결정적).
 */
function resolveScanReloadView(payload) {
  const empty = isEmptySnapshot(payload);
  return { view: empty ? 'firstRun' : 'dashboard', empty };
}

/* =====================================================================
 * Electron 적응: 옵션 매핑 · 루트 관리 · 폴더 선택 결과 (순수, 테스트 대상)
 * ===================================================================== */

/**
 * 재스캔 옵션 정규화(순수). UI 상태 → rescan(opts) 인자.
 *   - withSize: Boolean 강제
 *   - allDrives: Boolean 강제, 단 allowAllDrives 게이트가 false 면 항상 false 로 강등.
 *     (main 도 config.allowAllDrives 로 재게이트하지만, UI 도 동일 규칙으로 미리 강등해
 *      비활성 옵션이 새어나가지 않게 한다 — §4.2 정합.)
 *   uiOpts = { withSize?, allDrives? } / cfg = getConfig() 결과(또는 null)
 */
function sanitizeRescanOpts(uiOpts, cfg) {
  const o = (uiOpts && typeof uiOpts === 'object') ? uiOpts : {};
  const allowAll = !!(cfg && cfg.allowAllDrives === true);
  return {
    withSize: !!o.withSize,
    allDrives: allowAll ? !!o.allDrives : false,
  };
}

/**
 * getConfig() 응답 → 옵션 UI 표시용 뷰모델(순수). 결측 graceful.
 * 계약(§4.1): { scanRoots:string[], staleDays:number, allowAllDrives:boolean,
 *               size:{enabled:boolean, maxBytes:number, maxEntries:number} }
 */
function configView(cfg) {
  const c = (cfg && typeof cfg === 'object') ? cfg : {};
  const size = (c.size && typeof c.size === 'object') ? c.size : {};
  const roots = Array.isArray(c.scanRoots)
    ? c.scanRoots.filter((p) => typeof p === 'string' && p.length)
    : [];
  return {
    scanRoots: roots,
    rootCount: roots.length,
    excludes: Array.isArray(c.excludes) ? c.excludes.filter((p) => typeof p === 'string' && p.length) : [],
    staleDays: numOr(c.staleDays, 90),
    allowAllDrives: c.allowAllDrives === true,
    sizeEnabled: size.enabled === true,
    sizeMaxBytes: typeof size.maxBytes === 'number' ? size.maxBytes : null,
    sizeMaxEntries: typeof size.maxEntries === 'number' ? size.maxEntries : null,
  };
}

/**
 * 경로 직접 입력 텍스트 → addRoots 인자 배열(순수). 줄바꿈/구분 처리·trim·빈줄 제거.
 * 한 줄 입력(단일 경로)도 배열로. main 이 전량 재검증하므로 여기선 분리만 한다.
 */
function parseRootInput(text) {
  if (typeof text !== 'string') return [];
  return text
    .split(/[\r\n]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * addRoots/pickFolders 결과 → 사용자 토스트/표시 요약(순수).
 * 계약: { ok:true, added:string[], rejected?:[{path,reason}], roots:string[] }
 *       | { ok:false, code:'INVALID_PATH'|'CANCELLED' }
 *   반환 { ok, kind, addedCount, rejected:[{path,reason,label}], roots, message }
 *     kind='added'    1개 이상 추가됨
 *     kind='none'     추가 0(전부 거부/중복)
 *     kind='cancelled' 사용자 취소
 *     kind='error'    INVALID_PATH 등
 */
function summarizeAddResult(res) {
  const r = (res && typeof res === 'object') ? res : {};
  if (r.ok !== true) {
    const code = typeof r.code === 'string' ? r.code : 'INTERNAL';
    return {
      ok: false,
      kind: code === 'CANCELLED' ? 'cancelled' : 'error',
      addedCount: 0, rejected: [], roots: [],
      message: code === 'CANCELLED' ? '폴더 선택이 취소되었습니다.' : describeError(r),
    };
  }
  const added = Array.isArray(r.added) ? r.added.filter((p) => typeof p === 'string') : [];
  const roots = Array.isArray(r.roots) ? r.roots.filter((p) => typeof p === 'string') : [];
  const rejected = (Array.isArray(r.rejected) ? r.rejected : [])
    .filter((x) => x && typeof x === 'object' && typeof x.path === 'string')
    .map((x) => ({
      path: x.path,
      reason: typeof x.reason === 'string' ? x.reason : '',
      label: describeRejectReason(typeof x.reason === 'string' ? x.reason : ''),
    }));
  const addedCount = added.length;
  let message;
  if (addedCount > 0) {
    message = addedCount + '개 폴더를 추가했습니다.'
      + (rejected.length ? (' (' + rejected.length + '개 거부됨)') : '');
  } else if (rejected.length) {
    message = '추가된 폴더가 없습니다. ' + rejected.length + '개 항목이 거부되었습니다.';
  } else {
    message = '추가된 폴더가 없습니다.';
  }
  return {
    ok: true,
    kind: addedCount > 0 ? 'added' : 'none',
    addedCount, rejected, roots, message,
  };
}

/* =====================================================================
 * M6 (R-17~R-21): 순수 로직 (DOM 비의존, 테스트 대상)
 *   - R-17 경로 복사 텍스트 구성
 *   - R-18 tools 응답 → 설정 표시 뷰모델 매핑 + 실패 code 한국어
 *   - R-19 order 적용 / sortMode 전이
 *   - R-20 favorites 토글 상태 / 필터 합류
 *   - R-21 슬라이더 인덱스 이동 / onTray 디스패치
 *   계약: docs/architecture/m6-design.html §4(IPC), §6~9(UI). tools 응답에 args 없음.
 * ===================================================================== */

/**
 * R-17: 클립보드로 복사할 경로 텍스트 구성(순수). copyText IPC 인자.
 *   - 비문자열/공백 → null(복사할 것 없음 → 호출부가 토스트 생략/안내).
 *   - 앞뒤 공백만 정리(경로 자체는 그대로 — main이 텍스트로만 취급, 변형/이스케이프 없음, L-1).
 */
function buildCopyText(path) {
  if (typeof path !== 'string') return null;
  const t = path.trim();
  return t.length ? t : null;
}

/**
 * R-18: getTools 응답 항목 → 설정 UI 표시 뷰모델(순수). 결측 graceful.
 *   계약(§4.1): { id, label, path, resolved:boolean, source:'config'|'path'|'none' }
 *   - label 비면 id 폴백(textContent 렌더 — L-1, 변형/이스케이프 없음).
 *   - source 화이트리스트 밖이면 'none'.
 *   - needsPathHelp: resolved=false && source='none' → PATH 안내 박스 노출(§6.3 ⓐ).
 *   - statusLabel: 색 외 텍스트(N-07).
 */
function toolView(t) {
  const o = (t && typeof t === 'object') ? t : {};
  const id = typeof o.id === 'string' ? o.id : '';
  const label = (typeof o.label === 'string' && o.label.length) ? o.label : (id || '(이름 없음)');
  const path = (typeof o.path === 'string' && o.path.length) ? o.path : null;
  const resolved = o.resolved === true;
  const source = (o.source === 'config' || o.source === 'path') ? o.source : 'none';
  return {
    id,
    label,
    path,
    resolved,
    source,
    needsPathHelp: !resolved && source === 'none',
    statusLabel: toolStatusLabel(resolved, source),
  };
}

/** R-18: 툴 해석 상태 → 표시 라벨(순수, 색 외 텍스트 N-07). */
function toolStatusLabel(resolved, source) {
  if (!resolved) return '미해결 — 실행 파일을 찾을 수 없음';
  if (source === 'config') return '해결됨 — 지정한 경로';
  if (source === 'path') return '해결됨 — PATH에서 발견';
  return '미해결';
}

/** R-18: getTools 응답 배열 → toolView 배열(순수). 비배열 graceful. */
function toolViews(tools) {
  return (Array.isArray(tools) ? tools : []).map(toolView);
}

/**
 * R-18: setToolPath/pickToolExecutable 실패 code → 한국어(순수, 고정 토큰만 — L-3).
 *   계약(§4.1): INVALID_TOOL_ID | NOT_ABSOLUTE | NOT_FOUND | NOT_EXECUTABLE | CANCELLED
 */
function describeToolError(data) {
  const obj = (data && typeof data === 'object') ? data : {};
  const code = typeof obj.code === 'string' ? obj.code : '';
  switch (code) {
    case 'INVALID_TOOL_ID': return '알 수 없는 툴입니다.';
    case 'NOT_ABSOLUTE': return '절대경로를 입력하세요.';
    case 'NOT_FOUND': return '해당 경로에 파일이 없습니다.';
    case 'NOT_EXECUTABLE': return '실행 파일이 아닙니다. (.exe 실행 파일을 지정하세요)';
    case 'CANCELLED': return '파일 선택이 취소되었습니다.';
    case 'INTERNAL': return '내부 오류가 발생했습니다.';
    default: return code ? ('처리하지 못했습니다 (' + code + ')') : '처리하지 못했습니다.';
  }
}

/**
 * R-20: 즐겨찾기 집합 토글 결과(순수). 낙관적 메모리 반영용.
 *   현재 set(배열) + id + on(Boolean) → 새 배열(중복 없음, 순서 보존).
 *   on=true: 추가(이미 있으면 그대로). on=false: 제거. id 비유효 → 원본 그대로.
 */
function toggleFavorite(favorites, id, on) {
  const set = (Array.isArray(favorites) ? favorites : []).filter((x) => typeof x === 'string');
  if (typeof id !== 'string' || !id) return set.slice();
  const has = set.includes(id);
  if (on) {
    return has ? set.slice() : set.concat([id]);
  }
  return set.filter((x) => x !== id);
}

/** R-20: 즐겨찾기 여부(순수). */
function isFavorite(favorites, id) {
  return Array.isArray(favorites) && typeof id === 'string' && favorites.includes(id);
}

/**
 * R-19: sortMode + order(id 배열)를 viewModels 에 적용(순수).
 *   - mode='manual': order 순서로 정렬하되 order 에 없는 신규 항목은 뒤에 append(§3.2·§7).
 *       order 에 있으나 스냅샷에 없는 id 는 자동 skip(존재하는 vm 만 출력).
 *   - mode='auto'(또는 그 외): 기존 정렬(sortViewModels) 적용.
 *   원본 배열 불변.
 */
function applyOrder(viewModels, sortMode, order) {
  const vms = Array.isArray(viewModels) ? viewModels : [];
  if (sortMode !== 'manual') {
    return sortViewModels(vms, 'modified'); // 호출부가 실제 sortKey 로 별도 정렬(여기선 manual 분기만 의미)
  }
  const ord = (Array.isArray(order) ? order : []).filter((x) => typeof x === 'string');
  const byId = new Map();
  for (const vm of vms) if (vm && typeof vm.id === 'string') byId.set(vm.id, vm);
  const out = [];
  const used = new Set();
  for (const id of ord) {
    if (byId.has(id) && !used.has(id)) { out.push(byId.get(id)); used.add(id); }
  }
  // order 에 없는 신규 프로젝트는 원래 순서대로 뒤에 append
  for (const vm of vms) {
    if (vm && typeof vm.id === 'string' && !used.has(vm.id)) { out.push(vm); used.add(vm.id); }
  }
  return out;
}

/**
 * R-19: 드래그/키보드로 from → to 인덱스로 항목 이동한 새 id 배열(순수).
 *   범위 밖/동일 인덱스 → 원본 복제. setOrder 인자 구성·낙관적 렌더에 사용.
 */
function moveInOrder(ids, from, to) {
  const arr = (Array.isArray(ids) ? ids : []).slice();
  if (!Number.isInteger(from) || !Number.isInteger(to)) return arr;
  if (from < 0 || from >= arr.length || to < 0 || to >= arr.length || from === to) return arr;
  const [item] = arr.splice(from, 1);
  arr.splice(to, 0, item);
  return arr;
}

/**
 * R-19: 현재 표시 목록에서 sortMode 전이 결정(순수).
 *   - 사용자가 카드를 드래그/이동 → 'manual' 강제 전환(setOrder 가 sortMode='manual' 동반, §7).
 *   - 정렬 셀렉터 변경 → 'auto' 복귀.
 *   반환 { sortMode, changed }.
 */
function nextSortMode(current, trigger) {
  const cur = (current === 'manual') ? 'manual' : 'auto';
  if (trigger === 'reorder') return { sortMode: 'manual', changed: cur !== 'manual' };
  if (trigger === 'sortSelect') return { sortMode: 'auto', changed: cur !== 'auto' };
  return { sortMode: cur, changed: false };
}

/**
 * R-21: 슬라이더 인덱스 이동(순수, 래핑). count 항목에서 dir(-1/+1) 이동.
 *   빈 목록 → 0. 범위 밖 cur 보정. 좌/우 버튼·화살표 키 공용.
 */
function nextSlideIndex(cur, dir, count) {
  const n = Number.isInteger(count) && count > 0 ? count : 0;
  if (n === 0) return 0;
  let i = Number.isInteger(cur) ? cur : 0;
  i = ((i % n) + n) % n;
  const d = (dir === 1 || dir === -1) ? dir : 0;
  return (((i + d) % n) + n) % n;
}

/**
 * R-21: favorites(id) ∩ viewModels 교집합을 favorites 순서로 산출(순수).
 *   스냅샷에 없는 즐겨찾기 id 는 skip(소멸 프로젝트 graceful, §8·§9.3).
 */
function favoriteViewModels(viewModels, favorites) {
  const vms = Array.isArray(viewModels) ? viewModels : [];
  const favs = (Array.isArray(favorites) ? favorites : []).filter((x) => typeof x === 'string');
  const byId = new Map();
  for (const vm of vms) if (vm && typeof vm.id === 'string') byId.set(vm.id, vm);
  const out = [];
  const used = new Set();
  for (const id of favs) {
    if (byId.has(id) && !used.has(id)) { out.push(byId.get(id)); used.add(id); }
  }
  return out;
}

/**
 * R-20: 즐겨찾기 필터 합류(순수). favoritesOnly 면 즐겨찾기만 통과.
 *   기존 matchesFilters/ matchesSearch 와 AND 결합(호출부). 여기선 즐겨찾기 술어만.
 */
function matchesFavoritesFilter(vm, favoritesOnly, favorites) {
  if (!favoritesOnly) return true;
  return isFavorite(favorites, vm && vm.id);
}

/**
 * R-21/M7-R4: 트레이 push 액션({action}) → renderer 핸들러 토큰(순수). onMenu 패턴 정합.
 *   계약(m7 §8.1): 'favorites' 는 더 이상 메인창에 push 되지 않고 main 이 위젯 창을 직접 연다.
 *   따라서 화이트리스트를 'dashboard' 단일로 축소(SEC-L1: 죽은 수신 채널 잔존 방지).
 *   그 외(과거 'favorites' 포함) → null(graceful 무시).
 */
function dispatchTrayAction(msg) {
  const action = (msg && typeof msg === 'object' && typeof msg.action === 'string') ? msg.action : '';
  switch (action) {
    case 'dashboard': return { handler: 'dashboard' };
    default: return { handler: null };
  }
}

/**
 * R-23: FLIP(First-Last-Invert-Play) 좌표 diff 계산(순수, DOM 비의존).
 *   render() 전후의 cardId→rect 맵 두 개를 받아 각 카드의 invert(translate) 값을 산출한다.
 *   - reduce(prefers-reduced-motion) 가 true 면 빈 배열(전이 0).
 *   - 이전 rect 가 없는(신규) 카드는 skip. dx=dy=0(이동 없음)도 skip.
 *   반환: [{ id, dx, dy }] — 호출부가 transform=translate(dx,dy) → '' 로 play.
 *   계약(m7 §9.2): dx = prev.left - now.left, dy = prev.top - now.top.
 */
function computeFlip(firstMap, lastMap, reduce) {
  if (reduce) return [];
  const first = (firstMap instanceof Map) ? firstMap : new Map();
  const last = (lastMap instanceof Map) ? lastMap : new Map();
  const out = [];
  for (const [id, now] of last) {
    const prev = first.get(id);
    if (!prev || !now) continue; // 신규 카드 — FLIP 대상 아님
    const dx = prev.left - now.left;
    const dy = prev.top - now.top;
    if (!dx && !dy) continue; // 이동 없음
    out.push({ id, dx, dy });
  }
  return out;
}

/**
 * SEC-H2: 위젯 focus 게이팅 상태(순수, DOM 비의존).
 *   부수효과 액션(open·copyText·setFavorite)은 위젯이 focus 상태일 때만 활성.
 *   비포커스 상태에서의 액션 클릭은 "포커스만 획득"(액션 미실행)으로 게이팅한다.
 *   계약(m7 §5 focus 게이팅): focused=false → { allow:false, focusOnly:true }.
 *                            focused=true  → { allow:true,  focusOnly:false }.
 */
function focusGate(focused) {
  const ok = focused === true;
  return { allow: ok, focusOnly: !ok };
}

/**
 * R-22: spip:favorites-changed push payload → 정규화된 favorites 배열(순수).
 *   계약(m7 §6.1·SEC-M2): payload = { favorites:string[] }. 문자열만 통과.
 *   손상/비배열/비객체 → null(무시: 기존 상태 유지). 빈 배열은 유효(전부 해제).
 */
function favoritesChangedView(payload) {
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.favorites)) return null;
  return payload.favorites.filter((x) => typeof x === 'string');
}

/**
 * R-19/20/21: getUiState 응답 → 초기 UI 상태 뷰모델(순수). 결측/손상 graceful.
 *   계약(§4.1): { ok:true, favorites:string[], order:string[], sortMode:string }
 *   sortMode 화이트리스트 밖 → 'auto'. 배열 아님 → 빈 배열. id 필터(문자열만).
 */
function uiStateView(res) {
  const r = (res && typeof res === 'object') ? res : {};
  const favorites = (Array.isArray(r.favorites) ? r.favorites : []).filter((x) => typeof x === 'string');
  const order = (Array.isArray(r.order) ? r.order : []).filter((x) => typeof x === 'string');
  const sortMode = (r.sortMode === 'manual') ? 'manual' : 'auto';
  return { favorites, order, sortMode };
}

/* =====================================================================
 * 브라우저 전용 (DOM / fetch / 이벤트)
 * ===================================================================== */
function initBrowser() {
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const STALE_DAYS = 90; // 계약상 isStale은 서버 판정. 안내 문구용 기본값.

  /** store: 단일 출처 메모리(/api 1회 fetch). 필터/정렬/검색은 메모리에서만. */
  const store = {
    raw: [],
    viewModels: [],
    stats: null,
    now: new Date(),
    state: {
      view: 'loading',           // 'loading' | 'dashboard' | 'firstRun' | 'scanning' | 'error'
      density: 'cards',          // 'cards' | 'table'
      layout: 'sidebar',         // 'sidebar' | 'toolbar'
      search: '',
      sort: 'modified',
      filters: { languages: [], freshness: [], git: [] },
      selectedId: null,
      opening: {},               // id -> true(연타 방지)
      rescanning: false,         // 재스캔 요청 in-flight(버튼 비활성)
      // M6 UI 상태(R-19/20/21) — getUiState 로 초기 적재, 액션 시 낙관적 반영 + IPC 영속
      favorites: [],             // R-20: 즐겨찾기 id 집합(배열)
      order: [],                 // R-19: 수동 카드 순서(id 배열)
      sortMode: 'auto',          // R-19: 'auto' | 'manual'
      favoritesOnly: false,      // R-20: '즐겨찾기만' 필터
      // [M7 §8.1] 즐겨찾기 슬라이더 오버레이(store.state.slider) 제거 — 독립 위젯 창(favorites.html)으로 이전.
    },
    // R-15: 진행 통지 컨텍스트(Electron push 모델 — 폴링 타이머 제거)
    scan: {
      ownScanId: null,           // rescan SCAN_STARTED scanId(M4-L-1 대조)
      progress: null,            // 마지막 ScanProgress
      unsubscribe: null,         // onScanProgress 구독 해제 함수
      returnView: 'dashboard',   // 진행 끝나면 돌아갈 뷰(dashboard/firstRun)
      startedAt: 0,              // 로컬 시작 시각(경과 폴백)
    },
    // 설정/루트 관리 상태(Electron 신규)
    config: null,                // getConfig() 마지막 결과(configView 입력)
    roots: [],                   // 현재 scanRoots(루트 관리 UI 표시)
    rootInput: '',               // 경로 직접 입력 필드 값(컨트롤드)
    lastRejected: [],            // 직전 addRoots/pickFolders 거부 항목(표시)
    busyFolders: false,          // 폴더 추가/선택/삭제 in-flight(버튼 비활성)
    showSettings: false,         // 설정 팝업(모달) 열림 여부
    showHelp: false,             // #6 도움말 팝업(모달) 열림 여부
    // 궤도 맵(Orbit Map) 컨트롤 상태 — 캔버스 루프가 live로 읽는다.
    orbit: { layout: 'drive', speed: 1, paused: false, scrub: 0, triage: false, hi: null, search: '', kpi: null },
    opts: { withSize: false, allDrives: false }, // 재스캔 옵션 UI 상태
    menuUnsubscribe: null,       // P2-1: spip.onMenu 구독 해제 함수(teardown 시 호출)
    // M6 (R-18) 외부 툴 설정 상태
    tools: [],                   // getTools 응답(toolViews 입력)
    toolPathInput: {},           // 툴별 경로 직접 입력 컨트롤드 값 { id: text }
    busyTools: false,            // 툴 경로 설정 in-flight
    // #4 제외 항목(폴더명/절대경로)
    excludes: [],                // getConfig().excludes
    excludeInput: '',            // 제외 항목 직접 입력(컨트롤드)
    busyExcludes: false,         // 제외 추가/삭제 in-flight
    trayUnsubscribe: null,       // R-21: spip.onTray 구독 해제 함수
    projectsUpdatedUnsubscribe: null, // R-24: spip.onProjectsUpdated 구독 해제 함수
    // 자동 업데이트(사용자 주도) 상태 — 설정 드로어의 "소프트웨어 업데이트" 섹션이 표시.
    update: {
      packaged: null,          // null=미조회, true/false (false면 개발 모드 안내)
      currentVersion: '',      // app.getVersion()
      status: 'idle',          // idle|checking|available|not-available|downloading|downloaded|error
      version: '',             // 감지/다운로드된 새 버전
      percent: 0,              // 다운로드 진행률(%)
      busy: false,             // check/download in-flight(버튼 비활성)
      unsubscribe: null,       // onUpdateStatus 구독 해제 함수
    },
  };

  const app = document.getElementById('app');
  const toastEl = document.getElementById('toast');

  /* =====================================================================
   * 전송 어댑터 (Electron IPC — window.spip.*). HTTP/fetch/세션토큰 전부 제거.
   *   preload allowlist 만 호출. 응답 shape 은 불변(Project·stats·ScanProgress).
   *   window.spip 부재(브라우저 직접 열람 등) 시 graceful 오류 객체 반환.
   * ===================================================================== */
  const spip = (typeof window !== 'undefined' && window.spip) ? window.spip : null;
  function hasBridge() { return !!spip; }
  function bridgeMissing() {
    return { ok: false, code: 'INTERNAL', message: 'Electron 환경이 아닙니다(window.spip 없음).' };
  }
  async function ipc(method, ...args) {
    if (!spip || typeof spip[method] !== 'function') return bridgeMissing();
    try {
      return await spip[method](...args);
    } catch (err) {
      // L-3: 절대경로·스택 비노출. 사용자에겐 고정 메시지.
      return { ok: false, code: 'INTERNAL', message: (err && err.message) ? err.message : 'IPC 오류' };
    }
  }
  // M6 신규 채널 어댑터. method 를 변수로 전달해 ipc() 와 동일 경로(graceful)로 호출하되,
  //   preload 미배포 환경(웹/테스트·devops 미병합)에서도 brideMissing 으로 안전 폴백한다.
  //   (정합 테스트는 ipc('리터럴')만 대조하므로 신규 채널은 호출부가 직접 ipc(varMethod) 사용.)
  function bridgeHas(method) { return !!(spip && typeof spip[method] === 'function'); }

  /* ---- DOM 빌더 헬퍼 (L-1: 텍스트는 항상 textContent) ---- */
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
  function svg(paths, opts) {
    opts = opts || {};
    const s = document.createElementNS(SVG_NS, 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('width', String(opts.size || 16));
    s.setAttribute('height', String(opts.size || 16));
    s.setAttribute('fill', 'none');
    s.setAttribute('stroke', opts.stroke || 'currentColor');
    s.setAttribute('stroke-width', String(opts.sw || 2));
    s.setAttribute('stroke-linecap', 'round');
    s.setAttribute('stroke-linejoin', 'round');
    if (opts.cls) s.setAttribute('class', opts.cls);
    s.setAttribute('aria-hidden', 'true');
    for (const d of paths) {
      const el2 = document.createElementNS(SVG_NS, d.t || 'path');
      for (const k in d) if (k !== 't') el2.setAttribute(k, d[k]);
      s.appendChild(el2);
    }
    return s;
  }
  function dot(lang, size) {
    const s = el('span', { cls: 'lang-dot' });
    s.style.background = langColor(lang);
    if (size) { s.style.width = size + 'px'; s.style.height = size + 'px'; }
    return s;
  }
  function colorDot(color, size) {
    const s = el('span', { cls: 'status-dot' });
    s.style.background = color;
    if (size) { s.style.width = size + 'px'; s.style.height = size + 'px'; }
    return s;
  }
  function badge(cls, text) {
    return el('span', { cls: 'badge ' + cls, text });
  }

  /* ---- 상대시간(now 고정) ---- */
  const rel = (iso) => relTime(iso, store.now);

  /* =====================================================================
   * 메인 렌더 디스패치
   * ===================================================================== */
  function render() {
    destroyCardSortable();   // [M8] 이전 .cards 의 Sortable 인스턴스 정리(노드 교체 전).
    const v = store.state.view;
    // 뷰가 막 바뀐 경우에만 진입 애니메이션(is-enter)을 1회 부여 — 재렌더(스캔 진행 250ms 등)마다
    //   재생되면 깜빡인다. 같은 뷰의 반복 렌더는 entering=false라 애니메이션 없이 즉시 갱신.
    const entering = store._lastView !== v;
    // 재렌더로 노드가 교체되면 스크롤 컨테이너가 새로 생겨 위치가 0으로 초기화된다(설정 모달에서
    //   버튼 클릭 시 스크롤 튐). 교체 전 위치를 저장해 동일 셀렉터에 복원한다.
    const SCROLL_SEL = ['.modal__body', '.drawer', '.orbit__panel'];
    const savedScroll = {};
    SCROLL_SEL.forEach((sel) => { const e = app.querySelector(sel); if (e) savedScroll[sel] = e.scrollTop; });
    // 궤도 뷰를 벗어나면 캔버스 RAF·리스너 정리(누수 방지). 궤도 안의 재렌더에선 유지.
    if (v !== 'orbit' && orb.canvasEl) stopOrbit();
    app.replaceChildren();
    if (v === 'loading') { app.appendChild(renderLoading(entering)); }
    else if (v === 'error') { app.appendChild(renderError(entering)); }
    else if (v === 'scanning') { app.appendChild(renderScanning(entering)); }
    else if (v === 'firstRun') { app.appendChild(renderFirstRun()); }
    else if (v === 'orbit') {
      app.appendChild(renderOrbit());
      if (store.state.selectedId) app.appendChild(renderDrawer()); // 노드 클릭 상세(기존 드로어 재사용)
    }
    else {
      app.appendChild(renderDashboard());
      initCardSortable();    // [M8] 카드뷰면 .cards 에 드래그 재정렬 부착(표/무결과면 no-op).
    }
    // 설정·도움말 모달은 모든 뷰 위에 표시(대시보드·궤도 등 어디서든 열림).
    if (store.showSettings) app.appendChild(renderSettings());
    if (store.showHelp) app.appendChild(renderHelp());
    // 저장한 스크롤 위치를 새 컨테이너에 복원(버튼 클릭 등 재렌더 후에도 위치 유지).
    SCROLL_SEL.forEach((sel) => { if (savedScroll[sel] != null) { const e = app.querySelector(sel); if (e) e.scrollTop = savedScroll[sel]; } });
    store._lastView = v;
  }

  /* ---- 로딩 / 에러 ---- */
  function renderLoading(entering) {
    return el('div', {
      cls: 'centered-screen',
      children: [el('div', {
        cls: 'panel-card panel-card--sm' + (entering ? ' is-enter' : ''),
        children: [
          el('div', { cls: 'spinner' }),
          el('div', { cls: 'centered-title', text: '프로젝트를 불러오는 중…' }),
        ],
      })],
    });
  }
  function renderError(entering) {
    return el('div', {
      cls: 'centered-screen',
      children: [el('div', {
        cls: 'panel-card panel-card--sm' + (entering ? ' is-enter' : ''),
        children: [
          el('div', { cls: 'centered-title', text: '데이터를 불러오지 못했습니다' }),
          el('div', { cls: 'centered-sub', text: store._errorMsg || '잠시 후 다시 시도하세요.' }),
          el('button', {
            cls: 'btn btn--dark', text: '다시 시도',
            on: { click: () => load() },
          }),
        ],
      })],
    });
  }

  /* =====================================================================
   * R-15: 스캔 진행 화면 (시안 scanning 재현 + 실 폴링 연동)
   *   - aria-live(polite) 영역에 진행 텍스트 갱신(N-07 4.1.3)
   *   - 모든 서버 유래 문자열(currentPath·note)은 textContent(L-1, M4-L-2)
   * ===================================================================== */
  function renderScanning(entering) {
    const pv = progressView(store.scan.progress);
    const card = el('div', { cls: 'panel-card scanview' + (entering ? ' is-enter' : ''), attrs: { role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' } });

    // 헤더: 스피너/완료 아이콘 + 제목 + 카운트 + (불확정이면 % 숨김)
    const head = el('div', { cls: 'scanview__head' });
    if (pv.done) {
      const okIcon = el('div', { cls: 'scanview__icon scanview__icon--ok' });
      okIcon.appendChild(svg([{ t: 'path', d: 'M5 12l4 4 10-10' }], { size: 18, stroke: '#15803d', sw: 2.6 }));
      head.appendChild(okIcon);
    } else if (pv.error) {
      const errIcon = el('div', { cls: 'scanview__icon scanview__icon--err' });
      errIcon.appendChild(svg([{ t: 'line', x1: '6', y1: '6', x2: '18', y2: '18' }, { t: 'line', x1: '18', y1: '6', x2: '6', y2: '18' }], { size: 18, stroke: '#b91c1c', sw: 2.6 }));
      head.appendChild(errIcon);
    } else {
      head.appendChild(el('div', { cls: 'scanview__spinner' }));
    }

    const titleWrap = el('div', { cls: 'scanview__titlewrap' });
    titleWrap.appendChild(el('div', { cls: 'scanview__title', text: pv.title }));
    titleWrap.appendChild(el('div', {
      cls: 'scanview__counts',
      text: fmtCount(pv.dirs) + ' 폴더 탐색 · ' + fmtCount(pv.found) + ' 프로젝트 발견',
    }));
    head.appendChild(titleWrap);
    head.appendChild(el('div', { cls: 'spacer' }));
    card.appendChild(head);

    // 진행바: pct=null 이면 indeterminate(불확정), 아니면 100%
    const track = el('div', { cls: 'scanview__track' });
    const barCls = 'scanview__bar' + (pv.pct == null && !pv.error ? ' scanview__bar--indet' : '') + (pv.error ? ' scanview__bar--err' : '');
    const bar = el('div', { cls: barCls });
    if (pv.pct != null) bar.style.width = pv.pct + '%';
    track.appendChild(bar);
    card.appendChild(track);

    // 현재 경로 / 완료·오류 메시지 (textContent)
    const pathRow = el('div', { cls: 'scanview__path mono' });
    if (pv.done) {
      pathRow.appendChild(el('span', { cls: 'scanview__path-ok', text: '✓' }));
      pathRow.appendChild(el('span', { text: '스캔 완료 — 결과를 캐시에 저장했습니다' }));
    } else if (pv.error) {
      pathRow.appendChild(el('span', { cls: 'scanview__path-err', text: '!' }));
      pathRow.appendChild(el('span', { text: pv.note || '스캔에 실패했습니다. 다시 시도하세요.' }));
    } else if (pv.finalizing) {
      pathRow.appendChild(el('span', { cls: 'scanview__path-cur', text: '▸' }));
      pathRow.appendChild(el('span', { text: '스냅샷 마무리 중…' }));
    } else {
      pathRow.appendChild(el('span', { cls: 'scanview__path-cur', text: '▸' }));
      // currentPath 는 서버 유래(basename 축약) → textContent
      pathRow.appendChild(el('span', { cls: 'scanview__path-txt', text: pv.currentPath || '탐색 시작…' }));
    }
    card.appendChild(pathRow);

    // note(예: all-drives 강등 안내) — 진행 중에도 표기
    if (pv.note && !pv.error) {
      card.appendChild(el('div', { cls: 'scanview__note', text: pv.note }));
    }

    // 풋: 경과 + 액션
    const foot = el('div', { cls: 'scanview__foot' });
    foot.appendChild(el('div', { cls: 'scanview__elapsed mono', text: '경과 ' + fmtElapsed(pv.elapsedSec) }));
    foot.appendChild(el('div', { cls: 'spacer' }));
    if (pv.done) {
      foot.appendChild(el('button', { cls: 'btn btn--dark', text: '대시보드 열기 →', on: { click: () => { store.state.view = 'dashboard'; render(); } } }));
    } else if (pv.error) {
      foot.appendChild(el('button', { cls: 'btn', text: '돌아가기', on: { click: () => { store.state.view = store.scan.returnView; render(); } } }));
      foot.appendChild(el('button', { cls: 'btn btn--dark', text: '다시 시도', on: { click: () => triggerRescan() } }));
    } else {
      // 진행 중에는 취소(=뷰만 벗어남, 서버 스캔은 백그라운드 단일 락이라 계속됨)
      foot.appendChild(el('button', { cls: 'btn', text: '백그라운드로', on: { click: () => { store.state.view = store.scan.returnView; render(); } } }));
    }
    card.appendChild(foot);

    return el('div', { cls: 'centered-screen', children: [card] });
  }

  /* =====================================================================
   * firstRun / 빈 상태 (Electron 실동작: 네이티브 폴더 선택 + 경로 직접 입력 + 루트 목록)
   *   - CLI 안내 제거. spip.pickFolders()/addRoots()/removeRoot()/rescan() 으로 실동작.
   *   - 모든 경로 문자열은 textContent(L-1). 키보드/포커스/aria(N-07) 적용.
   * ===================================================================== */
  function renderFirstRun() {
    const card = el('div', { cls: 'panel-card firstrun' });

    const brand = el('div', { cls: 'firstrun__brand', children: [
      el('div', { cls: 'logo-mark', text: 'S' }),
      el('div', { cls: 'logo-text', text: 'Project-SPIP' }),
      badge('badge--local', 'LOCAL'),
    ]});
    card.appendChild(brand);

    const hasRoots = store.roots.length > 0;
    card.appendChild(el('h1', { cls: 'firstrun__title', text: hasRoots ? '스캔 준비 완료' : '스캔할 폴더를 추가하세요' }));
    card.appendChild(el('p', { cls: 'firstrun__lead', text: hasRoots
      ? '아래 폴더를 스캔하면 대시보드가 채워집니다. 스캔은 이 PC에서 로컬로만 수행됩니다.'
      : '프로젝트가 들어 있는 폴더를 추가하면 스캔할 수 있습니다. 폴더 선택과 스캔은 이 PC에서 로컬로만 수행됩니다.' }));

    // 루트 관리 블록(공통 컴포넌트)
    card.appendChild(renderRootManager());

    // 1차 액션: 스캔 시작(루트가 있어야 의미)
    const startBtn = el('button', {
      cls: 'btn btn--dark btn--block', text: store.state.rescanning ? '스캔 시작 중…' : '스캔 시작',
      attrs: { 'aria-label': '추가된 폴더 스캔 시작' },
      on: { click: () => triggerRescan('firstRun') },
    });
    if (!store.state.rescanning) {
      startBtn.prepend(svg([{ t: 'path', d: 'M21 12a9 9 0 1 1-2.64-6.36' }, { t: 'path', d: 'M21 3v6h-6' }], { size: 15 }));
    }
    if (store.state.rescanning || !hasRoots || store.busyFolders) startBtn.disabled = true;
    card.appendChild(startBtn);

    if (!hasRoots) {
      card.appendChild(el('p', { cls: 'firstrun__note', text: '폴더를 1개 이상 추가하면 스캔할 수 있습니다.' }));
    }

    const sec = el('div', { cls: 'firstrun__security', children: [
      svg([{ t: 'rect', x: '4', y: '11', width: '16', height: '9', rx: '2' }, { t: 'path', d: 'M8 11V8a4 4 0 0 1 8 0v3' }], { size: 13, stroke: '#a8a29e' }),
      el('span', { text: '로컬 전용 · 외부로 어떤 데이터도 전송하지 않습니다' }),
    ]});
    card.appendChild(sec);

    return el('div', { cls: 'centered-screen', children: [card] });
  }

  /* =====================================================================
   * 루트 관리 컴포넌트 (firstRun · 설정 공용)
   *   - 네이티브 폴더 선택(pickFolders) · 경로 직접 입력(addRoots) · 목록/삭제(removeRoot)
   *   - 거부(rejected) 결과 표시. 키보드·aria-live·focus-visible(N-07).
   * ===================================================================== */
  function renderRootManager() {
    const wrap = el('div', { cls: 'rootmgr', attrs: { 'aria-label': '스캔 폴더 관리' } });

    // 동작 버튼: 네이티브 선택 + 직접 입력 토글은 항상 표시
    const actions = el('div', { cls: 'rootmgr__actions' });
    const pickBtn = el('button', {
      cls: 'btn', text: '폴더 선택…',
      attrs: { 'aria-label': '네이티브 대화상자로 폴더 선택' },
      on: { click: onPickFolders },
    });
    pickBtn.prepend(svg([{ t: 'path', d: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z' }], { size: 14 }));
    if (store.busyFolders) pickBtn.disabled = true;
    actions.appendChild(pickBtn);
    wrap.appendChild(actions);

    // #5 드라이브 선택 안내 — 폴더 대화상자/직접 입력에서 드라이브 루트(C:\)도 고를 수 있다.
    //   드라이브를 추가하면 스캔 시 시스템 폴더 제외 + 깊이 제한이 자동 적용된다.
    wrap.appendChild(el('p', { cls: 'settings__opt-sub', text: '폴더 대화상자에서 드라이브(C:, D:)를 선택하거나 C:\\ 처럼 직접 입력하면 드라이브 전체를 스캔합니다(시스템 폴더 자동 제외·깊이 제한).' }));

    // 경로 직접 입력(키보드/붙여넣기 편의 — N-07)
    const inputRow = el('div', { cls: 'rootmgr__inputrow' });
    const pathInput = el('input', {
      cls: 'rootmgr__input',
      attrs: {
        type: 'text', placeholder: '폴더 절대경로 직접 입력 (예: E:\\projects)',
        'aria-label': '폴더 경로 직접 입력', autocomplete: 'off', spellcheck: 'false',
      },
    });
    pathInput.value = store.rootInput;
    pathInput.addEventListener('input', (e) => { store.rootInput = e.target.value || ''; });
    pathInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); onAddRoot(); } });
    const addBtn = el('button', {
      cls: 'btn', text: '추가', attrs: { 'aria-label': '입력한 경로 추가' }, on: { click: onAddRoot },
    });
    if (store.busyFolders) { pathInput.disabled = true; addBtn.disabled = true; }
    inputRow.appendChild(pathInput);
    inputRow.appendChild(addBtn);
    wrap.appendChild(inputRow);

    // 루트 목록(경로는 textContent — L-1)
    const listLabel = el('div', { cls: 'rootmgr__label', text: '추가된 폴더 (' + store.roots.length + ')' });
    wrap.appendChild(listLabel);
    if (store.roots.length === 0) {
      wrap.appendChild(el('div', { cls: 'rootmgr__empty', text: '아직 추가된 폴더가 없습니다.' }));
    } else {
      const ul = el('ul', { cls: 'rootmgr__list', attrs: { role: 'list' } });
      for (const p of store.roots) {
        const li = el('li', { cls: 'rootmgr__item' });
        li.appendChild(el('span', { cls: 'rootmgr__path mono', text: p, title: p })); // L-1 textContent
        const rm = el('button', {
          cls: 'rootmgr__remove', text: '삭제',
          attrs: { type: 'button', 'aria-label': '폴더 제거: ' + p },
          on: { click: () => onRemoveRoot(p) },
        });
        if (store.busyFolders) rm.disabled = true;
        li.appendChild(rm);
        ul.appendChild(li);
      }
      wrap.appendChild(ul);
    }

    // 거부 결과(aria-live 로 안내 — 경로는 textContent)
    if (store.lastRejected.length) {
      const rej = el('div', { cls: 'rootmgr__rejected', attrs: { role: 'status', 'aria-live': 'polite' } });
      rej.appendChild(el('div', { cls: 'rootmgr__rejected-title', text: '추가하지 못한 항목' }));
      const rl = el('ul', { cls: 'rootmgr__rejected-list', attrs: { role: 'list' } });
      for (const r of store.lastRejected) {
        const li = el('li', { cls: 'rootmgr__rejected-item' });
        li.appendChild(el('span', { cls: 'mono rootmgr__rejected-path', text: r.path, title: r.path })); // L-1
        li.appendChild(el('span', { cls: 'rootmgr__rejected-reason', text: r.label }));
        rl.appendChild(li);
      }
      rej.appendChild(rl);
      wrap.appendChild(rej);
    }

    return wrap;
  }

  /* =====================================================================
   * 대시보드
   * ===================================================================== */
  function renderDashboard() {
    const root = el('div', { cls: 'dash' });
    root.appendChild(renderHeader());
    root.appendChild(renderToolbar());
    root.appendChild(renderKpis());

    const body = el('div', { cls: 'dash__body' });
    if (store.state.layout === 'sidebar') body.appendChild(renderSidebar());

    const main = el('main', { cls: 'dash__main spip-scroll', attrs: { id: 'main' } });
    if (store.state.layout === 'toolbar') main.appendChild(renderToolbarFacets());
    main.appendChild(renderResults());
    body.appendChild(main);
    root.appendChild(body);

    if (store.state.selectedId) root.appendChild(renderDrawer());
    // 설정 모달은 render()에서 앱 레벨로 append(모든 뷰에서 열리도록 — 궤도 뷰 포함).
    // [M7 §8.1] 즐겨찾기 슬라이더 오버레이 제거 — 독립 위젯 창(app://favorites.html)으로 이전.
    return root;
  }

  /* =====================================================================
   * 설정 드로어 (폴더 관리 + 재스캔 옵션). 드로어 패턴(포커스 트랩·Esc·복귀) 재사용.
   * ===================================================================== */
  function openSettings() {
    store._settingsOpener = (typeof document !== 'undefined') ? document.activeElement : null;
    store.showSettings = true;
    store.lastRejected = [];
    render();
    // 최신 config/roots 동기화(비동기 — 끝나면 재렌더)
    refreshConfig();
    // R-18: 툴 해석 상태도 동기화(설정 드로어 오픈 시에만 — 빈도 낮음, §4.1)
    refreshTools();
    // 업데이트 상태(현재 버전·패키징 여부·마지막 status)도 동기화(설정 오픈 시에만).
    refreshUpdateState();
  }
  function closeSettings() {
    store.showSettings = false;
    store._settingsShown = false; // 다음 열림에 진입 애니메이션 재적용
    const opener = store._settingsOpener;
    store._settingsOpener = null;
    render();
    if (opener && typeof opener.focus === 'function' && document.contains(opener)) {
      try { opener.focus(); } catch (_) { /* ignore */ }
    }
  }

  /* =====================================================================
   * 중앙 팝업 모달 컴포넌트 (설정·도움말 공용). 드로어 대신 화면 중앙 오버레이.
   *   포커스 트랩(N-07)·Esc 닫기·오버레이 클릭 닫기·포커스 복귀. bodyChildren는 DOM 노드 배열.
   * ===================================================================== */
  function buildModal(opts) {
    opts = opts || {};
    const titleId = opts.titleId || 'modal-title';
    const onClose = (typeof opts.onClose === 'function') ? opts.onClose : function () {};
    const overlay = el('div', { cls: 'modal-overlay', on: { click: onClose } });
    const dialog = el('div', {
      cls: 'modal' + (opts.wide ? ' modal--wide' : '') + (opts.enter ? ' is-enter' : '') + ' spip-scroll',
      attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId },
    });
    dialog.addEventListener('click', (e) => e.stopPropagation());

    const head = el('div', { cls: 'modal__head' });
    head.appendChild(el('div', { cls: 'modal__titlewrap', children: [
      el('div', { cls: 'modal__name', text: opts.title || '', attrs: { id: titleId } }),
      opts.subtitle ? el('div', { cls: 'modal__sub', text: opts.subtitle }) : null,
    ]}));
    const close = el('button', { cls: 'modal__close', text: '×', attrs: { 'aria-label': '닫기' }, on: { click: onClose } });
    head.appendChild(close);
    dialog.appendChild(head);

    const body = el('div', { cls: 'modal__body spip-scroll' });
    for (const c of (opts.bodyChildren || [])) if (c) body.appendChild(c);
    dialog.appendChild(body);
    overlay.appendChild(dialog);

    // 키보드: Esc 닫기 + 포커스 트랩(N-07)
    dialog.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); return; }
      if (e.key !== 'Tab') return;
      const items = getTabbables(dialog);
      if (items.length === 0) { e.preventDefault(); return; }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (e.shiftKey) {
        if (active === first || !dialog.contains(active)) { e.preventDefault(); last.focus(); }
      } else {
        if (active === last || !dialog.contains(active)) { e.preventDefault(); first.focus(); }
      }
    });
    setTimeout(() => { try { close.focus(); } catch (_) { /* ignore */ } }, 0);
    return overlay;
  }

  function renderSettings() {
    const enter = !store._settingsShown; store._settingsShown = true; // 진입 애니메이션 1회만
    return buildModal({
      titleId: 'settings-title',
      title: '설정',
      subtitle: '스캔 폴더·제외·드라이브·옵션을 관리합니다',
      onClose: closeSettings,
      wide: true,
      enter,
      bodyChildren: [
        // 1) 폴더 관리 (드라이브 루트 C:\ 도 폴더 선택에서 그대로 추가 가능 — #5)
        el('div', { cls: 'insight', children: [
          el('div', { cls: 'insight__title', text: '스캔 폴더' }),
          renderRootManager(),
        ]}),
        // 2) 제외 항목(#4)
        renderExcludeSettings(),
        // 3) 재스캔 옵션 (getConfig 기반)
        renderScanOptions(),
        // 4) 외부 툴 경로(R-18)
        renderToolSettings(),
        // 5) 소프트웨어 업데이트(자동 업데이트 클라이언트)
        renderUpdateSettings(),
      ],
    });
  }

  /** 재스캔 옵션 UI: withSize · allDrives(allowAllDrives 게이트) · 정책 표시(getConfig). */
  function renderScanOptions() {
    const cv = configView(store.config);
    const block = el('div', { cls: 'insight', children: [el('div', { cls: 'insight__title', text: '스캔 옵션' })] });

    // withSize
    block.appendChild(optionRow({
      id: 'opt-withsize',
      label: '용량(size) 수집',
      sub: cv.sizeEnabled ? '디렉터리 용량·node_modules 측정 (느려질 수 있음)' : '설정에서 size 수집이 비활성 상태입니다',
      checked: store.opts.withSize,
      disabled: false,
      onChange: (v) => { store.opts.withSize = v; },
    }));

    // allDrives — allowAllDrives 게이트
    block.appendChild(optionRow({
      id: 'opt-alldrives',
      label: '전체 드라이브 스캔',
      sub: cv.allowAllDrives ? '연결된 모든 드라이브를 스캔합니다' : '설정(allowAllDrives)이 꺼져 있어 사용할 수 없습니다',
      checked: cv.allowAllDrives && store.opts.allDrives,
      disabled: !cv.allowAllDrives,
      onChange: (v) => { store.opts.allDrives = v; },
    }));

    // 정책 표시(읽기 전용)
    const policy = el('div', { cls: 'rootmgr__label', text: '현재 정책' });
    block.appendChild(policy);
    const kv = el('div', { cls: 'settings__kv' });
    kv.appendChild(kvRow('방치 기준', el('span', { cls: 'mono kv__v', text: cv.staleDays + '일' })));
    kv.appendChild(kvRow('용량 수집', el('span', { cls: 'kv__v', text: cv.sizeEnabled ? '활성' : '비활성' })));
    kv.appendChild(kvRow('전체 드라이브 허용', el('span', { cls: 'kv__v', text: cv.allowAllDrives ? '허용' : '미허용' })));
    block.appendChild(kv);

    // 옵션 적용 재스캔
    const applyBtn = el('button', {
      cls: 'btn btn--dark btn--block', text: store.state.rescanning ? '재스캔 중…' : '이 옵션으로 재스캔',
      attrs: { 'aria-label': '선택한 옵션으로 재스캔' },
      on: { click: () => { closeSettings(); triggerRescan('dashboard'); } },
    });
    if (store.state.rescanning || store.roots.length === 0) applyBtn.disabled = true;
    block.appendChild(applyBtn);
    if (store.roots.length === 0) {
      block.appendChild(el('p', { cls: 'firstrun__note', text: '폴더를 1개 이상 추가해야 재스캔할 수 있습니다.' }));
    }

    return block;
  }

  function optionRow(o) {
    const input = el('input', { attrs: { type: 'checkbox', id: o.id }, cls: 'facet__check' });
    input.checked = !!o.checked;
    if (o.disabled) input.disabled = true;
    input.addEventListener('change', () => { o.onChange(input.checked); render(); });
    const label = el('label', { cls: 'settings__opt' + (o.disabled ? ' is-disabled' : ''), attrs: { for: o.id } });
    label.appendChild(input);
    const txt = el('div', { cls: 'settings__opt-txt' });
    txt.appendChild(el('div', { cls: 'settings__opt-label', text: o.label }));
    txt.appendChild(el('div', { cls: 'settings__opt-sub', text: o.sub }));
    label.appendChild(txt);
    return label;
  }

  /* =====================================================================
   * R-18: 외부 툴 경로 설정 섹션 (getTools / setToolPath / pickToolExecutable)
   *   - 각 툴: 해석 상태(resolved/source) + 경로 직접 입력 + 파일 선택 + 지정 해제
   *   - resolved=false && source='none' → PATH 추가 방법 안내(정적 텍스트, 외부 링크 없음)
   *   - 모든 경로/라벨은 textContent(L-1).
   * ===================================================================== */
  function renderToolSettings() {
    const block = el('div', { cls: 'insight', children: [el('div', { cls: 'insight__title', text: '외부 툴 경로' })] });
    const views = toolViews(store.tools);

    if (!bridgeHas('getTools') && views.length === 0) {
      block.appendChild(el('div', { cls: 'rootmgr__empty', text: '이 환경에서는 외부 툴 설정을 사용할 수 없습니다.' }));
      return block;
    }
    if (views.length === 0) {
      block.appendChild(el('div', { cls: 'rootmgr__empty', text: '툴 정보를 불러오는 중…' }));
      return block;
    }

    for (const tv of views) block.appendChild(renderToolRow(tv));
    return block;
  }

  function renderToolRow(tv) {
    const row = el('div', { cls: 'toolrow' });

    // 헤더: 라벨 + 상태 배지(색 외 텍스트, N-07)
    const head = el('div', { cls: 'toolrow__head' });
    head.appendChild(el('span', { cls: 'toolrow__label', text: tv.label })); // L-1
    const statusCls = tv.resolved ? 'badge--git-clean' : 'badge--git-na';
    head.appendChild(badge(statusCls, tv.statusLabel));
    row.appendChild(head);

    // 현재 해석 경로(있으면) — textContent
    if (tv.path) {
      row.appendChild(el('div', { cls: 'toolrow__path mono', text: tv.path, title: tv.path }));
    }

    // ⓐ PATH 안내(미해결 & source='none')
    if (tv.needsPathHelp) {
      row.appendChild(el('div', { cls: 'toolrow__help', attrs: { role: 'note' }, children: [
        el('div', { cls: 'toolrow__help-title', text: tv.id + '을(를) PATH에서 찾을 수 없습니다.' }),
        el('div', { cls: 'toolrow__help-body', text: 'VS Code에서 Ctrl/Cmd+Shift+P → "Shell Command: Install \'code\' command in PATH" 를 실행하거나, 아래에서 실행 파일(.exe)을 직접 지정하세요.' }),
      ]}));
    }

    // ⓑ 경로 직접 입력 + 파일 선택 + 지정 해제
    const inputRow = el('div', { cls: 'toolrow__inputrow' });
    const inputId = 'tool-path-' + tv.id;
    const pathInput = el('input', {
      cls: 'rootmgr__input',
      attrs: {
        type: 'text', id: inputId,
        placeholder: '실행 파일 절대경로 (예: C:\\Program Files\\Microsoft VS Code\\Code.exe)',
        'aria-label': tv.label + ' 실행 파일 경로 직접 입력', autocomplete: 'off', spellcheck: 'false',
      },
    });
    const curInput = (typeof store.toolPathInput[tv.id] === 'string') ? store.toolPathInput[tv.id] : (tv.path || '');
    pathInput.value = curInput;
    pathInput.addEventListener('input', (e) => { store.toolPathInput[tv.id] = e.target.value || ''; });
    pathInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); onSetToolPath(tv.id); } });
    if (store.busyTools) pathInput.disabled = true;
    inputRow.appendChild(pathInput);

    const setBtn = el('button', {
      cls: 'btn btn--sm', text: '저장', attrs: { type: 'button', 'aria-label': tv.label + ' 경로 저장' },
      on: { click: () => onSetToolPath(tv.id) },
    });
    if (store.busyTools) setBtn.disabled = true;
    inputRow.appendChild(setBtn);
    row.appendChild(inputRow);

    const actions = el('div', { cls: 'toolrow__actions' });
    const pickBtn = el('button', {
      cls: 'btn btn--sm', text: '실행 파일 선택…', attrs: { type: 'button', 'aria-label': tv.label + ' 실행 파일 선택' },
      on: { click: () => onPickToolExecutable(tv.id) },
    });
    if (store.busyTools || !bridgeHas('pickToolExecutable')) pickBtn.disabled = true;
    actions.appendChild(pickBtn);

    if (tv.path) {
      const clearBtn = el('button', {
        cls: 'btn btn--sm btn--ghost', text: '지정 해제', attrs: { type: 'button', 'aria-label': tv.label + ' 경로 지정 해제' },
        on: { click: () => onClearToolPath(tv.id) },
      });
      if (store.busyTools) clearBtn.disabled = true;
      actions.appendChild(clearBtn);
    }
    row.appendChild(actions);

    return row;
  }

  /* =====================================================================
   * 소프트웨어 업데이트 (자동 업데이트 클라이언트 — electron-updater, 사용자 주도)
   *   상태 머신(store.update.status):
   *     idle/not-available → "업데이트 확인"
   *     checking           → "확인 중…"(버튼 비활성)
   *     available          → "새 버전 vX 사용 가능" + "다운로드"
   *     downloading        → 진행 바(percent) + "다운로드 중 NN%"
   *     downloaded         → "vX 다운로드 완료" + "재시작하여 설치"
   *     error              → "확인/다운로드 실패" + "다시 시도"
   *   진행 상황은 spip.onUpdateStatus(cb) 단방향 push 로 실시간 갱신된다(subscribeUpdateStatus).
   * ===================================================================== */
  function renderUpdateSettings() {
    const u = store.update;
    const block = el('div', { cls: 'insight', children: [el('div', { cls: 'insight__title', text: '소프트웨어 업데이트' })] });

    // 현재 버전(있으면)
    const kv = el('div', { cls: 'settings__kv' });
    kv.appendChild(kvRow('현재 버전', el('span', { cls: 'mono kv__v', text: u.currentVersion ? ('v' + u.currentVersion) : '—' })));
    block.appendChild(kv);

    // 브리지 부재(웹/테스트) 또는 미패키징(개발 모드) → 안내만.
    if (!bridgeHas('checkForUpdate')) {
      block.appendChild(el('div', { cls: 'rootmgr__empty', text: '이 환경에서는 업데이트를 확인할 수 없습니다.' }));
      return block;
    }
    if (u.packaged === false) {
      block.appendChild(el('div', { cls: 'rootmgr__empty', text: '개발 모드에서는 업데이트를 확인할 수 없습니다. (설치본에서만 동작)' }));
      return block;
    }

    // 상태 메시지
    const msg = updateStatusMessage(u);
    if (msg) block.appendChild(el('div', { cls: 'rootmgr__label', text: msg }));

    // 다운로드 진행 바
    if (u.status === 'downloading') {
      const pct = Math.max(0, Math.min(100, Math.round(u.percent || 0)));
      const bar = el('div', { cls: 'update-bar', attrs: { role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(pct) } });
      const fill = el('div', { cls: 'update-bar__fill' });
      fill.style.width = pct + '%';
      bar.appendChild(fill);
      block.appendChild(bar);
    }

    // 액션 버튼(상태별)
    const busy = u.busy || u.status === 'checking' || u.status === 'downloading';
    if (u.status === 'available') {
      const dl = el('button', {
        cls: 'btn btn--dark btn--block', text: busy ? '다운로드 중…' : '다운로드',
        attrs: { 'aria-label': '업데이트 다운로드' }, on: { click: doDownloadUpdate },
      });
      if (busy) dl.disabled = true;
      block.appendChild(dl);
    } else if (u.status === 'downloaded') {
      const install = el('button', {
        cls: 'btn btn--dark btn--block', text: '재시작하여 설치',
        attrs: { 'aria-label': '재시작하여 업데이트 설치' }, on: { click: doInstallUpdate },
      });
      block.appendChild(install);
    } else {
      const label = u.status === 'checking' ? '확인 중…' : (u.status === 'error' ? '다시 시도' : '업데이트 확인');
      const check = el('button', {
        cls: 'btn btn--dark btn--block', text: label,
        attrs: { 'aria-label': '업데이트 확인' }, on: { click: doCheckUpdate },
      });
      if (busy) check.disabled = true;
      block.appendChild(check);
    }

    return block;
  }

  /** 업데이트 상태 → 사용자 표시 문구(순수, 고정 토큰만 — L-3). */
  function updateStatusMessage(u) {
    switch (u.status) {
      case 'checking':      return '업데이트를 확인하는 중…';
      case 'available':     return u.version ? ('새 버전 v' + u.version + ' 을(를) 사용할 수 있습니다.') : '새 버전을 사용할 수 있습니다.';
      case 'not-available': return '최신 버전을 사용 중입니다.';
      case 'downloading':   return '업데이트를 다운로드하는 중… ' + Math.round(u.percent || 0) + '%';
      case 'downloaded':    return u.version ? ('v' + u.version + ' 다운로드 완료 — 재시작하면 설치됩니다.') : '다운로드 완료 — 재시작하면 설치됩니다.';
      case 'error':         return '업데이트 확인/다운로드에 실패했습니다. 잠시 후 다시 시도하세요.';
      default:              return '';
    }
  }

  /** 설정 오픈 시 현재 버전·패키징 여부·마지막 status 동기화(비동기 — 끝나면 재렌더). */
  async function refreshUpdateState() {
    if (!bridgeHas('getUpdateState')) return;
    const res = await ipc('getUpdateState');
    if (!res || res.ok === false) return;
    store.update.packaged = !!res.packaged;
    store.update.currentVersion = (typeof res.currentVersion === 'string') ? res.currentVersion : '';
    applyUpdateStatusPayload(res.status);
    if (store.showSettings) render();
  }

  /** onUpdateStatus push 페이로드를 store.update 에 반영(순수 매핑). */
  function applyUpdateStatusPayload(payload) {
    if (!payload || typeof payload !== 'object') return;
    const u = store.update;
    if (typeof payload.status === 'string') u.status = payload.status;
    if (typeof payload.version === 'string') u.version = payload.version;
    if (typeof payload.percent === 'number') u.percent = payload.percent;
    // 진행/완료/오류로 전이하면 in-flight 해제(버튼 복귀).
    if (u.status !== 'checking' && u.status !== 'downloading') u.busy = false;
  }

  async function doCheckUpdate() {
    if (!bridgeHas('checkForUpdate')) return;
    store.update.busy = true;
    store.update.status = 'checking';
    render();
    const res = await ipc('checkForUpdate');
    if (res && res.ok === false) {
      store.update.busy = false;
      store.update.status = 'error';
      if (res.code === 'NOT_PACKAGED') store.update.packaged = false;
      render();
    }
    // 성공 시 결과는 onUpdateStatus push(available/not-available)로 도착.
  }

  async function doDownloadUpdate() {
    if (!bridgeHas('downloadUpdate')) return;
    store.update.busy = true;
    store.update.status = 'downloading';
    store.update.percent = 0;
    render();
    const res = await ipc('downloadUpdate');
    if (res && res.ok === false) {
      store.update.busy = false;
      store.update.status = 'error';
      render();
    }
    // 진행/완료는 download-progress/update-downloaded push로 도착.
  }

  async function doInstallUpdate() {
    if (!bridgeHas('installUpdate')) return;
    // 앱이 곧 종료·재시작된다. 실패해도 graceful(토스트).
    const res = await ipc('installUpdate');
    if (res && res.ok === false) {
      toast('업데이트 설치를 시작하지 못했습니다.', true);
    }
  }

  /* =====================================================================
   * #4 제외 항목 (폴더명 또는 절대경로) — getConfig().excludes / addExcludes / removeExclude
   *   · 폴더명(예: temp) → 그 이름의 폴더를 모두 제외
   *   · 절대경로(예: E:\\projects\\old) → 그 폴더(하위 포함)만 제외
   * ===================================================================== */
  function renderExcludeSettings() {
    const block = el('div', { cls: 'insight', children: [el('div', { cls: 'insight__title', text: '제외 항목' })] });
    if (!bridgeHas('addExcludes')) {
      block.appendChild(el('div', { cls: 'rootmgr__empty', text: '이 환경에서는 제외 항목을 설정할 수 없습니다.' }));
      return block;
    }
    block.appendChild(el('p', { cls: 'settings__opt-sub', text: '폴더 이름(예: temp)이면 같은 이름 폴더 모두, 절대경로(예: E:\\projects\\old)면 그 폴더만, 정규식이면 전체 경로에 매칭되는 폴더를 제외합니다. 정규식은 반드시 양쪽 끝을 / 로 감싸세요(닫는 / 가 빠지면 일반 경로로 처리됨). 경로 구분자는 / 로 쓰고(Windows \\ 자동 매칭), 앞뒤 경로가 무엇이든 가운데 패턴만 지정 — 예: /workspace/study/ 는 경로 중간의 workspace/study… 폴더를 제외. node_modules·.git·dist 등은 기본 제외됩니다.' }));

    // 직접 입력 + 추가
    const inputRow = el('div', { cls: 'rootmgr__inputrow' });
    const input = el('input', {
      cls: 'rootmgr__input',
      attrs: {
        type: 'text', placeholder: '폴더 이름 · 절대경로 · /정규식/',
        'aria-label': '제외할 폴더 이름·절대경로·정규식', autocomplete: 'off', spellcheck: 'false',
      },
    });
    input.value = store.excludeInput;
    input.addEventListener('input', (e) => { store.excludeInput = e.target.value || ''; });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); onAddExclude(); } });
    const addBtn = el('button', { cls: 'btn', text: '추가', attrs: { 'aria-label': '제외 항목 추가' }, on: { click: onAddExclude } });
    if (store.busyExcludes) { input.disabled = true; addBtn.disabled = true; }
    inputRow.appendChild(input);
    inputRow.appendChild(addBtn);
    block.appendChild(inputRow);

    // 예시 칩 — 클릭하면 입력칸을 채운다(검토 후 '추가'). 정규식 예시 포함.
    const examples = [
      { v: 'temp', t: '이름: temp 폴더 모두 제외' },
      { v: '/temp/', t: '정규식: 경로에 temp 포함(앞뒤 임의)' },
      { v: '/eclipse/plugins/', t: '정규식: 경로 중간의 eclipse/plugins 하위 전부' },
    ];
    const exRow = el('div', { cls: 'exclude-ex' });
    exRow.appendChild(el('span', { cls: 'exclude-ex__label', text: '예시' }));
    for (const ex of examples) {
      exRow.appendChild(el('button', {
        cls: 'exclude-ex__chip mono', text: ex.v, attrs: { type: 'button', title: ex.t, 'aria-label': '예시 입력: ' + ex.v },
        on: { click: () => { store.excludeInput = ex.v; render(); } },
      }));
    }
    block.appendChild(exRow);

    // 목록
    block.appendChild(el('div', { cls: 'rootmgr__label', text: '제외 목록 (' + store.excludes.length + ')' }));
    if (store.excludes.length === 0) {
      block.appendChild(el('div', { cls: 'rootmgr__empty', text: '추가된 제외 항목이 없습니다(기본 제외 규칙만 적용).' }));
    } else {
      const ul = el('ul', { cls: 'rootmgr__list', attrs: { role: 'list' } });
      for (const e of store.excludes) {
        const li = el('li', { cls: 'rootmgr__item' });
        li.appendChild(el('span', { cls: 'rootmgr__path mono', text: e, title: e })); // L-1
        const rm = el('button', {
          cls: 'rootmgr__remove', text: '삭제',
          attrs: { type: 'button', 'aria-label': '제외 제거: ' + e },
          on: { click: () => onRemoveExclude(e) },
        });
        if (store.busyExcludes) rm.disabled = true;
        li.appendChild(rm);
        ul.appendChild(li);
      }
      block.appendChild(ul);
    }
    return block;
  }

  async function onAddExclude() {
    const v = (store.excludeInput || '').trim();
    if (!v) { toast('제외할 폴더 이름 또는 경로를 입력하세요.', true); return; }
    if (!bridgeHas('addExcludes')) return;
    store.busyExcludes = true; render();
    const res = await ipc('addExcludes', [v]);
    store.busyExcludes = false;
    if (res && res.ok && Array.isArray(res.excludes)) {
      store.excludes = res.excludes.filter((x) => typeof x === 'string');
      store.excludeInput = '';
      if (Array.isArray(res.added) && res.added.length) toast('제외 항목을 추가했습니다.');
      else if (Array.isArray(res.rejected) && res.rejected.some((r) => r.reason === 'BAD_REGEX')) toast('정규식 형식이 올바르지 않습니다.', true);
      else if (Array.isArray(res.rejected) && res.rejected.length) toast('이미 있거나 추가할 수 없는 항목입니다.', true);
    } else {
      toast('제외 항목 추가에 실패했습니다.', true);
    }
    render();
  }

  async function onRemoveExclude(pattern) {
    if (!bridgeHas('removeExclude')) return;
    store.busyExcludes = true; render();
    const res = await ipc('removeExclude', pattern);
    store.busyExcludes = false;
    if (res && res.ok && Array.isArray(res.excludes)) {
      store.excludes = res.excludes.filter((x) => typeof x === 'string');
    } else {
      toast('제외 항목 삭제에 실패했습니다.', true);
    }
    render();
  }

  /* =====================================================================
   * 궤도 맵 (Orbit Map) — 프로젝트를 별/궤도로 시각화하는 캔버스 뷰 (UI 템플릿 이식)
   *   · 중심에 가까울수록 최근, 외곽일수록 방치(나이=반지름). 크기=디스크 용량, 색=주 언어.
   *   · 각도 배치: 드라이브(C/D/E…) 또는 언어별 부채꼴(배치 기준 토글, 부드럽게 모핑).
   *   · dirty/ahead(Git 주의)는 맥동 고리. 방치+node_modules는 '정리 모드'에서 회수 후보로 강조.
   *   · pan(드래그)·zoom(휠/버튼)·hover(툴팁)·click(포커스+상세 드로어). 시간 되감기(scrub)·속도·일시정지.
   * 런타임 상태(orb)는 모듈 레벨에 유지해 재렌더로 캔버스를 재생성해도 애니메이션이 끊기지 않게 한다.
   * ===================================================================== */
  const orb = {
    canvasEl: null, octx: null, raf: null,
    zoom: 1, panX: 0, panY: 0, hoverId: null, focusId: null,
    geo: null, geoKey: '', angT: 0, layoutMix: 0,
    stars: null, starsW: 0, starsH: 0, ot0: 0, introT0: 0, lastNow: 0,
    dragging: false, moved: false, lx: 0, ly: 0, dsx: 0, dsy: 0,
    tz: null, tpx: null, tpy: null, model: null, reclaimMB: 0, teardown: null,
    speedLabelEl: null, scrubLabelEl: null, menu: null,
  };

  /** 검색어가 정규식 형식(`/.../`)이면 컴파일(렌더러 측 — excludeRules와 동일 규칙). 아니면 null. */
  function orbCompileSearchRegex(q) {
    if (typeof q !== 'string' || !/^\/.+\/[gimsuy]*$/.test(q)) return null;
    const m = /^\/(.+)\/([gimsuy]*)$/.exec(q);
    try { return new RegExp(m[1], m[2].replace(/[gy]/g, '')); } catch (_) { return null; }
  }
  /** 노드(vm)가 검색어에 매칭되는지 — 정규식이면 전체 경로(/ 정규화)·이름에, 아니면 substring. */
  function orbMatch(vm, q) {
    const query = (q || '').trim();
    if (!query) return true;
    const re = orbCompileSearchRegex(query);
    if (re) { const p = String(vm.path).replace(/\\/g, '/'); return re.test(p) || re.test(vm.name); }
    return matchesSearch(vm, query);
  }

  function orbHash(str) { let h = 0; const s = String(str); for (let i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) | 0; } return Math.abs(h); }
  function orbAgeDays(vm) {
    const t = vm && vm.lastModified ? Date.parse(vm.lastModified) : NaN;
    if (!Number.isFinite(t)) return 999;
    const now = (store.now && store.now.getTime) ? store.now.getTime() : Date.now();
    return Math.max(0, (now - t) / 86400000);
  }
  const orbGlow = (hex, a) => {
    const h = String(hex).replace('#', '');
    const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
    return 'rgba(' + (r || 0) + ',' + (g || 0) + ',' + (b || 0) + ',' + a + ')';
  };
  function orbRoundRect(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }

  /** store.viewModels → { rings, nodes } 궤도 모델. 기하(_geo)는 프로젝트 집합이 바뀔 때만 1회 산출. */
  function buildOrbitModel() {
    const A = Array.isArray(store.viewModels) ? store.viewModels : [];
    const sd = configView(store.config).staleDays || 90;
    const q = (store.orbit.search || '').trim();
    const lr = (d) => Math.log(1 + Math.max(0, d)) / Math.log(441);
    const radFrac = (d) => 0.12 + 0.86 * lr(d);
    const szOf = (p) => (typeof p.totalBytes === 'number' && p.totalBytes > 0) ? p.totalBytes : 0;
    const maxSz = Math.max(1, ...A.map(szOf));

    const key = A.map((p) => p.id).join('|');
    if (!orb.geo || orb.geoKey !== key) {
      orb.geo = {}; orb.geoKey = key;
      const layoutAngles = (keyOf, order) => {
        const groups = order.filter((k) => A.some((p) => keyOf(p) === k));
        A.forEach((p) => { const k = keyOf(p); if (!groups.includes(k)) groups.push(k); });
        const gapA = 14 * Math.PI / 180, usableA = 2 * Math.PI - gapA * Math.max(1, groups.length);
        let curA = -Math.PI / 2 + gapA / 2; const out = {};
        groups.forEach((k) => {
          const items = A.filter((p) => keyOf(p) === k);
          const span = usableA * items.length / Math.max(1, A.length);
          items.forEach((p, i) => { out[p.id] = curA + span * ((i + 0.5) / items.length); });
          curA += span + gapA;
        });
        return out;
      };
      const driveOf = (p) => (String(p.path)[0] || 'C').toUpperCase();
      const langOf = (p) => p.language;
      const driveA = layoutAngles(driveOf, ['C', 'D', 'E', 'F', 'G']);
      const langA = layoutAngles(langOf, ['TypeScript', 'JavaScript', 'Node.js', 'Python', 'Go', 'Rust', 'C++', 'C', 'Java', 'HTML', 'CSS']);
      A.forEach((p) => {
        const rf = radFrac(orbAgeDays(p));
        orb.geo[p.id] = {
          angleDrive: driveA[p.id] != null ? driveA[p.id] : 0,
          angleLang: langA[p.id] != null ? langA[p.id] : 0,
          angSpeed: 0.016 + 0.03 * (1 - rf),
          phase: (orbHash(p.id) % 628) / 100,
          wob: 0.22 + (orbHash(p.id + 'w') % 40) / 100,
        };
      });
    }

    const ringSeen = {};
    const rings = [{ d: 7, label: '1주' }, { d: 30, label: '1개월' }, { d: sd, label: '방치 ' + sd + '일+', stale: true }, { d: 365, label: '1년' }]
      .filter((r) => { if (ringSeen[r.d] || r.d > 420) return false; ringSeen[r.d] = 1; return true; })
      .sort((a, b) => a.d - b.d)
      .map((r) => ({ label: r.label, stale: !!r.stale, radFrac: radFrac(r.d) }));

    let reclaimMB = 0;
    const nodes = A.map((p) => {
      const g = orb.geo[p.id]; const age = orbAgeDays(p);
      const nm = (typeof p.nodeModulesBytes === 'number' && p.nodeModulesBytes > 0) ? p.nodeModulesBytes : 0;
      const stale = p.isStale === true, dirty = p.gitStatus === 'dirty', ahead = (typeof p.ahead === 'number' ? p.ahead : 0);
      const reclaim = stale && nm > 0; if (reclaim) reclaimMB += nm;
      const status = !p.isRepo ? { t: 'Git 아님', c: '#a8a29e' }
        : dirty ? { t: '미커밋', c: '#fbbf24' }
          : ahead > 0 ? { t: '미푸시 ' + ahead, c: '#60a5fa' }
            : stale ? { t: '방치', c: '#a8a29e' }
              : { t: '정상', c: '#34d399' };
      const sz = szOf(p);
      return {
        id: p.id, name: p.name, path: p.path, lang: p.language, color: langColor(p.language),
        mod: age, nm, sizePx: 12 + Math.sqrt(sz / maxSz) * 40,
        stale, attention: p.isRepo && (dirty || ahead > 0), reclaim, status,
        sizeLabel: sizeLabel(p.totalBytes), nmLabel: nm > 0 ? sizeLabel(nm) : '없음', rel: rel(p.lastModified),
        angleDrive: g.angleDrive, angleLang: g.angleLang, angSpeed: g.angSpeed, phase: g.phase, wob: g.wob,
        match: orbMatch(p, q), // 정규식(/.../) 또는 substring
      };
    });
    orb.model = { rings, nodes };
    orb.reclaimMB = reclaimMB;
    return orb.model;
  }

  function orbLaAngle(n) { let a = n.angleDrive, b = n.angleLang, m = orb.layoutMix || 0, d = b - a; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return a + d * m; }

  function orbHitTest(mx, my) {
    const m = orb.model; if (!m) return null;
    for (let i = m.nodes.length - 1; i >= 0; i--) { const n = m.nodes[i]; if (n._x == null) continue; const dx = mx - n._x, dy = my - n._y; if (dx * dx + dy * dy <= (n._r + 5) * (n._r + 5)) return n.id; }
    return null;
  }
  function orbZoomAt(mx, my, nz) {
    const cv = orb.canvasEl; if (!cv) return;
    nz = Math.max(0.5, Math.min(6, nz));
    const cx = cv.clientWidth / 2, cy = cv.clientHeight / 2, z = orb.zoom || 1;
    orb.panX = mx - cx - ((mx - cx - orb.panX) / z) * nz;
    orb.panY = my - cy - ((my - cy - orb.panY) / z) * nz;
    orb.zoom = nz;
  }
  function orbFocusNode(id) {
    const m = orb.model, cv = orb.canvasEl; if (!m || !cv) return;
    const n = m.nodes.find((x) => x.id === id); if (!n) return;
    orb.focusId = id;
    const baseR = Math.min(cv.clientWidth, cv.clientHeight) * 0.45;
    const ang = orbLaAngle(n) + (orb.angT || 0) * n.angSpeed;
    const effDays = Math.max(0, n.mod - (store.orbit.scrub || 0) * 30);
    const rf = 0.12 + 0.86 * (Math.log(1 + effDays) / Math.log(441));
    const off = rf * baseR, tz = 1.85;
    orb.tz = tz; orb.tpx = -off * Math.cos(ang) * tz - cv.clientWidth * 0.16; orb.tpy = -off * Math.sin(ang) * tz;
  }
  function orbClearFocus() { orb.focusId = null; orb.tz = 1; orb.tpx = 0; orb.tpy = 0; }

  function attachOrbit(canvas) {
    orb.zoom = 1; orb.panX = 0; orb.panY = 0; orb.dragging = false; orb.moved = false;
    orb.octx = canvas.getContext('2d');
    orb.ot0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    orb.introT0 = orb.ot0; orb.angT = orb.angT || 0;
    orb.layoutMix = store.orbit.layout === 'lang' ? 1 : 0; orb.stars = null;
    const pos = (e) => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
    const onMove = (e) => {
      if (orb.dragging) {
        orb.panX += e.clientX - orb.lx; orb.panY += e.clientY - orb.ly; orb.lx = e.clientX; orb.ly = e.clientY;
        if (Math.abs(e.clientX - orb.dsx) + Math.abs(e.clientY - orb.dsy) > 4) orb.moved = true;
        orb.hoverId = null; canvas.style.cursor = 'grabbing'; return;
      }
      const m = pos(e); orb.hoverId = orbHitTest(m.x, m.y); canvas.style.cursor = orb.hoverId ? 'pointer' : 'grab';
    };
    const onLeave = () => { orb.hoverId = null; canvas.style.cursor = 'default'; };
    const onDown = (e) => { if (e.button !== 0) return; orb.tz = orb.tpx = orb.tpy = null; orb.focusId = null; orb.dragging = true; orb.moved = false; orb.lx = orb.dsx = e.clientX; orb.ly = orb.dsy = e.clientY; };
    const onUp = () => { orb.dragging = false; };
    // 우클릭 → 노드 위면 컨텍스트 메뉴(디렉터리 제외). 빈 곳이면 메뉴 닫기.
    const onCtx = (e) => {
      e.preventDefault();
      const m = pos(e); const id = orbHitTest(m.x, m.y);
      if (id) {
        const n = orb.model && orb.model.nodes.find((x) => x.id === id);
        orb.menu = { x: m.x, y: m.y, id, name: n ? n.name : '', path: n ? n.path : '' };
      } else { orb.menu = null; }
      render();
    };
    const onClick = (e) => {
      if (orb.moved) return;
      const m = pos(e); const id = orbHitTest(m.x, m.y);
      if (id) { orbFocusNode(id); openDrawer(id); }
      else if (orb.focusId || store.state.selectedId) { orbClearFocus(); if (store.state.selectedId) closeDrawer(); }
    };
    const onWheel = (e) => { e.preventDefault(); orb.tz = orb.tpx = orb.tpy = null; orb.focusId = null; const m = pos(e); const f = Math.exp(-e.deltaY * 0.0015); orbZoomAt(m.x, m.y, (orb.zoom || 1) * f); };
    canvas.addEventListener('mousemove', onMove);
    canvas.addEventListener('mouseleave', onLeave);
    canvas.addEventListener('mousedown', onDown);
    window.addEventListener('mouseup', onUp);
    canvas.addEventListener('click', onClick);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('contextmenu', onCtx);
    orb.teardown = () => {
      canvas.removeEventListener('mousemove', onMove); canvas.removeEventListener('mouseleave', onLeave);
      canvas.removeEventListener('mousedown', onDown); window.removeEventListener('mouseup', onUp);
      canvas.removeEventListener('click', onClick); canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('contextmenu', onCtx);
    };
  }

  function orbitLoop(now) {
    if (!orb.canvasEl) { orb.raf = null; return; }
    const dt = orb.lastNow ? Math.min(0.05, (now - orb.lastNow) / 1000) : 0; orb.lastNow = now;
    const sp = (store.orbit.paused || orb.focusId) ? 0 : (store.orbit.speed || 1);
    orb.angT += dt * sp;
    orbitFrame((now - orb.ot0) / 1000, now);
    orb.raf = requestAnimationFrame(orbitLoop);
  }

  function orbitFrame(t, now) {
    const cv = orb.canvasEl, ctx = orb.octx, model = orb.model; if (!cv || !ctx || !model) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cw = cv.clientWidth, ch = cv.clientHeight; if (!cw || !ch) return;
    if (cv.width !== Math.round(cw * dpr) || cv.height !== Math.round(ch * dpr)) { cv.width = Math.round(cw * dpr); cv.height = Math.round(ch * dpr); }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, cw, ch);

    if (orb.tz != null) {
      orb.zoom += (orb.tz - orb.zoom) * 0.12;
      orb.panX = (orb.panX || 0) + (orb.tpx - (orb.panX || 0)) * 0.12;
      orb.panY = (orb.panY || 0) + (orb.tpy - (orb.panY || 0)) * 0.12;
      if (Math.abs(orb.tz - orb.zoom) < 0.01) { orb.zoom = orb.tz; orb.panX = orb.tpx; orb.panY = orb.tpy; orb.tz = orb.tpx = orb.tpy = null; }
    }
    const lt = store.orbit.layout === 'lang' ? 1 : 0;
    orb.layoutMix = (orb.layoutMix || 0) + (lt - (orb.layoutMix || 0)) * 0.08;

    const z = orb.zoom || 1;
    const cx = cw / 2 + (orb.panX || 0), cy = ch / 2 + (orb.panY || 0), R = Math.min(cw, ch) * 0.45 * z;
    const hi = store.orbit.hi, aT = orb.angT || 0, scrub = store.orbit.scrub || 0, triage = store.orbit.triage;
    const fActive = !!(store.orbit.search || '').trim();
    const intro = Math.min(1, (now - (orb.introT0 || now)) / 950), ease = 1 - Math.pow(1 - intro, 3);
    const liveRF = (n) => 0.12 + 0.86 * (Math.log(1 + Math.max(0, n.mod - scrub * 30)) / Math.log(441));
    const angleOf = (n) => { let a = n.angleDrive, b = n.angleLang, mx = orb.layoutMix || 0, d = b - a; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return a + d * mx; };
    const kpi = store.orbit.kpi;
    const kpiMatch = (n) => !kpi || (kpi === 'active' ? !n.stale : kpi === 'attention' ? n.attention : kpi === 'stale' ? n.stale : true);
    const isDim = (n) => (hi && n.lang !== hi) || (fActive && !n.match) || (triage && !n.reclaim) || !kpiMatch(n);
    const MONO = "ui-monospace, 'Consolas', monospace";

    // starfield
    if (!orb.stars || orb.starsW !== cw || orb.starsH !== ch) { orb.stars = []; orb.starsW = cw; orb.starsH = ch; const N = Math.round(cw * ch / 9000); for (let i = 0; i < N; i++) orb.stars.push({ x: Math.random() * cw, y: Math.random() * ch, r: Math.random() * 1.1 + 0.3, p: Math.random() * 6.28, s: 0.3 + Math.random() * 0.7 }); }
    ctx.fillStyle = '#cdd3ff';
    orb.stars.forEach((s2) => { ctx.globalAlpha = 0.05 + 0.07 * Math.sin(t * 0.8 * s2.s + s2.p); ctx.beginPath(); ctx.arc((s2.x + t * 2 * s2.s) % cw, s2.y, s2.r, 0, Math.PI * 2); ctx.fill(); });
    ctx.globalAlpha = 1;

    // rings
    model.rings.forEach((r) => {
      const rad = r.radFrac * R;
      ctx.beginPath(); ctx.arc(cx, cy, rad, 0, Math.PI * 2);
      ctx.lineWidth = 1; ctx.strokeStyle = r.stale ? 'rgba(251,191,36,.30)' : 'rgba(255,255,255,.06)';
      if (r.stale) ctx.setLineDash([5, 7]); ctx.stroke(); ctx.setLineDash([]);
      ctx.font = '9px ' + MONO; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      const ly = cy - rad, tw = ctx.measureText(r.label).width;
      ctx.fillStyle = '#0c0a09'; ctx.fillRect(cx - tw / 2 - 4, ly - 7, tw + 8, 14);
      ctx.fillStyle = r.stale ? 'rgba(251,191,36,.72)' : 'rgba(255,255,255,.34)'; ctx.fillText(r.label, cx, ly);
    });

    // orbit trails
    ctx.globalAlpha = ease;
    model.nodes.forEach((n) => {
      if (isDim(n)) return;
      const ang = angleOf(n) + aT * n.angSpeed, rad = liveRF(n) * R;
      ctx.beginPath(); ctx.arc(cx, cy, rad, ang - 0.36, ang);
      ctx.strokeStyle = orbGlow(n.color, n.stale ? 0.08 : 0.16); ctx.lineWidth = Math.max(1, n.sizePx * z * 0.16); ctx.stroke();
    });
    ctx.globalAlpha = 1;

    // constellation lines for highlighted language
    if (hi) {
      model.nodes.forEach((n) => {
        if (n.lang !== hi) return;
        const ang = angleOf(n) + aT * n.angSpeed, rad = liveRF(n) * R;
        const x = cx + rad * Math.cos(ang), y = cy + rad * Math.sin(ang);
        ctx.strokeStyle = orbGlow(n.color, 0.22); ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(x, y); ctx.stroke();
      });
    }

    // core star
    const pulse = 0.5 + 0.5 * Math.sin(t * 2);
    const cr = (30 + 12 * pulse) * z;
    const cg = ctx.createRadialGradient(cx, cy, 0, cx, cy, cr);
    cg.addColorStop(0, 'rgba(129,140,248,' + (0.34 + 0.16 * pulse) + ')'); cg.addColorStop(1, 'rgba(129,140,248,0)');
    ctx.fillStyle = cg; ctx.beginPath(); ctx.arc(cx, cy, cr, 0, Math.PI * 2); ctx.fill();
    const sg = ctx.createRadialGradient(cx - 3 * z, cy - 3 * z, 0, cx, cy, 9 * z);
    sg.addColorStop(0, '#e0e7ff'); sg.addColorStop(1, '#818cf8');
    ctx.fillStyle = sg; ctx.beginPath(); ctx.arc(cx, cy, 8 * z, 0, Math.PI * 2); ctx.fill();
    ctx.font = "600 11px 'Pretendard Variable', sans-serif"; ctx.fillStyle = 'rgba(255,255,255,.6)'; ctx.textAlign = 'center'; ctx.textBaseline = 'top'; ctx.fillText(scrub === 0 ? '지금' : scrub + '개월 전', cx, cy + 9 * z + 5);

    // nodes
    model.nodes.forEach((n) => {
      const ang = angleOf(n) + aT * n.angSpeed;
      const rad = (liveRF(n) * R) * (1 + 0.7 * (1 - ease)) + Math.sin(t * n.wob + n.phase) * 4 * z;
      const x = cx + rad * Math.cos(ang), y = cy + rad * Math.sin(ang);
      const sz = n.sizePx * z; n._x = x; n._y = y; n._r = sz / 2;
      const dim = isDim(n), hov = orb.hoverId === n.id, focused = store.state.selectedId === n.id;
      const matchPulse = fActive && n.match && !dim;
      const psc = matchPulse ? (1 + 0.12 * Math.sin(t * 4 + n.phase)) : 1;
      const twk = 0.82 + 0.18 * Math.sin(t * 2.4 + n.phase);
      if (!n.stale && !dim) {
        const gr = sz * (hov ? 2 : 1.5) * psc;
        const g = ctx.createRadialGradient(x, y, sz * 0.3, x, y, gr);
        g.addColorStop(0, orbGlow(n.color, 0.5 * twk)); g.addColorStop(1, orbGlow(n.color, 0));
        ctx.globalAlpha = ease; ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, gr, 0, Math.PI * 2); ctx.fill(); ctx.globalAlpha = 1;
      }
      if (!dim && ((n.attention && !n.stale) || (triage && n.reclaim))) {
        const col = (triage && n.reclaim) ? '#fbbf24' : n.color;
        const prog = (t / 2.2) % 1, hr = sz * 0.5 * (1 + 1.3 * prog);
        ctx.globalAlpha = 0.55 * (1 - prog) * ease; ctx.lineWidth = 1.5; ctx.strokeStyle = col;
        ctx.beginPath(); ctx.arc(x, y, hr, 0, Math.PI * 2); ctx.stroke(); ctx.globalAlpha = 1;
      }
      if (focused) {
        ctx.globalAlpha = 0.9; ctx.lineWidth = 2; ctx.strokeStyle = '#c7d2fe';
        ctx.beginPath(); ctx.arc(x, y, sz / 2 + 6 + 2 * Math.sin(t * 3), 0, Math.PI * 2); ctx.stroke(); ctx.globalAlpha = 1;
      }
      const br = sz / 2 * (hov ? 1.16 : 1) * psc;
      ctx.globalAlpha = (dim ? 0.16 : (n.stale ? 0.55 : 1)) * ease;
      ctx.fillStyle = dim ? '#5b5b58' : n.color;
      ctx.beginPath(); ctx.arc(x, y, br, 0, Math.PI * 2); ctx.fill();
      ctx.lineWidth = 1.5; ctx.strokeStyle = 'rgba(255,255,255,' + (n.stale ? 0.12 : 0.34) + ')'; ctx.stroke();
      ctx.globalAlpha = (dim ? 0.16 : (hov ? 1 : (n.stale ? 0.32 : 0.55))) * ease;
      ctx.font = (hov ? '600 ' : '') + Math.max(8, Math.min(9 * z, 17)).toFixed(1) + 'px ' + MONO; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      ctx.fillStyle = (triage && n.reclaim && !dim) ? '#fbbf24' : (hov ? '#ffffff' : '#e7e5e4');
      ctx.fillText((triage && n.reclaim) ? n.name + '  ▸ ' + n.nmLabel : n.name, x, y + br + 5);
      ctx.globalAlpha = 1;
    });

    // hover tooltip
    const hn = orb.hoverId ? model.nodes.find((n) => n.id === orb.hoverId) : null;
    if (hn && hn._x != null) {
      const pad = 12, bw = 220;
      ctx.font = '10px ' + MONO;
      const pathLines = []; let cur = '';
      for (const ch2 of String(hn.path)) { if (ctx.measureText(cur + ch2).width > bw - pad * 2) { pathLines.push(cur); cur = ch2; } else cur += ch2; }
      if (cur) pathLines.push(cur);
      const bh = pad * 2 + 18 + pathLines.length * 13 + 8 + 15 + 6 + 14;
      let bx = Math.max(8, Math.min(cw - bw - 8, hn._x - bw / 2));
      let by = hn._y - hn._r - bh - 14; if (by < 8) by = hn._y + hn._r + 14;
      ctx.fillStyle = '#1c1917'; ctx.strokeStyle = 'rgba(255,255,255,.12)'; ctx.lineWidth = 1;
      orbRoundRect(ctx, bx, by, bw, bh, 11); ctx.fill(); ctx.stroke();
      let ty = by + pad; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
      ctx.fillStyle = hn.color; ctx.beginPath(); ctx.arc(bx + pad + 4, ty + 7, 4, 0, Math.PI * 2); ctx.fill();
      ctx.font = "600 13px 'Pretendard Variable', sans-serif"; ctx.fillStyle = '#fff'; ctx.fillText(hn.name, bx + pad + 14, ty); ty += 18;
      ctx.font = '10px ' + MONO; ctx.fillStyle = 'rgba(255,255,255,.42)';
      pathLines.forEach((l) => { ctx.fillText(l, bx + pad, ty); ty += 13; }); ty += 8;
      ctx.font = '600 11px ' + MONO;
      ctx.fillStyle = 'rgba(255,255,255,.7)'; ctx.fillText(hn.lang, bx + pad, ty);
      const lw = ctx.measureText(hn.lang).width;
      ctx.fillStyle = 'rgba(255,255,255,.2)'; ctx.fillText('·', bx + pad + lw + 7, ty);
      ctx.fillStyle = hn.status.c; ctx.fillText(hn.status.t, bx + pad + lw + 16, ty); ty += 15 + 6;
      ctx.font = '11px ' + MONO; ctx.fillStyle = 'rgba(255,255,255,.45)';
      ctx.fillText(hn.rel + '  ·  ' + hn.sizeLabel, bx + pad, ty);
    }
  }

  function stopOrbit() {
    if (orb.raf) { cancelAnimationFrame(orb.raf); orb.raf = null; }
    if (orb.teardown) { try { orb.teardown(); } catch (_) { /* ignore */ } orb.teardown = null; }
    orb.canvasEl = null; orb.octx = null; orb.hoverId = null; orb.menu = null;
  }

  function enterOrbit() {
    // 진입할 때마다 검색·필터/강조 상태 초기화(검색어·언어 강조·인사이트 강조·정리 모드·시간 되감기).
    //   배치 기준(layout)·속도·일시정지 등 표시 설정은 유지.
    store.orbit.search = '';
    store.orbit.hi = null;
    store.orbit.kpi = null;
    store.orbit.triage = false;
    store.orbit.scrub = 0;
    orb.focusId = null; orb.menu = null; // 포커스/컨텍스트 메뉴도 초기화
    store.state.view = 'orbit';
    orb.introT0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    render();
  }
  function exitOrbit() {
    stopOrbit();
    store.state.view = store.viewModels && store.viewModels.length ? 'dashboard' : 'firstRun';
    render();
  }

  /** 공통: 값(이름/경로/정규식)을 제외에 추가하고 토스트로 결과 안내. */
  async function orbAddExclude(value, okMsg) {
    const v = (value || '').trim();
    if (!v || !bridgeHas('addExcludes')) return;
    const res = await ipc('addExcludes', [v]);
    if (res && res.ok && Array.isArray(res.added) && res.added.length) {
      if (Array.isArray(res.excludes)) store.excludes = res.excludes.filter((x) => typeof x === 'string');
      toast(okMsg + ' — 다음 스캔부터 적용됩니다.');
    } else if (res && res.rejected && res.rejected.some((r) => r.reason === 'BAD_REGEX')) {
      toast('정규식 형식이 올바르지 않습니다.', true);
    } else if (res && res.ok) {
      toast('이미 제외 목록에 있습니다.');
    } else {
      toast('제외 추가에 실패했습니다.', true);
    }
  }
  function orbExcludeDir(path) { orbAddExclude(path, '이 폴더를 제외에 추가했습니다'); }
  function orbAddExcludeFromSearch() {
    const q = (store.orbit.search || '').trim();
    if (!q) { toast('검색창에 이름·경로·정규식을 입력하세요.', true); return; }
    orbAddExclude(q, '검색값을 제외에 추가했습니다');
  }

  /** 궤도 컨트롤 패널의 KPI/배지 미니 박스. */
  function orbKpi(value, label, color, key) {
    const v = el('div', { cls: 'orbit__kpi-v', text: String(value) });
    v.style.color = color; // CSSOM — CSP(style-src 'self')가 인라인 style 속성을 막으므로 속성 대신 직접 설정
    const on = store.orbit.kpi === key;
    return el('button', {
      cls: 'orbit__kpi' + (on ? ' is-on' : ''),
      attrs: { type: 'button', 'aria-pressed': on ? 'true' : 'false', 'aria-label': label + ' 강조 토글' },
      children: [v, el('div', { cls: 'orbit__kpi-l', text: label })],
      on: { click: () => { store.orbit.kpi = on ? null : key; render(); } },
    });
  }

  function renderOrbit() {
    buildOrbitModel();
    const o = store.orbit;
    const A = Array.isArray(store.viewModels) ? store.viewModels : [];
    const sd = configView(store.config).staleDays || 90;
    const activeCount = A.filter((p) => !p.isStale).length;
    const staleCount = A.filter((p) => p.isStale).length;
    const attention = (orb.model.nodes || []).filter((n) => n.attention).length;
    const langCounts = {};
    A.forEach((p) => { langCounts[p.language] = (langCounts[p.language] || 0) + 1; });
    const langs = Object.keys(langCounts).sort((a, b) => langCounts[b] - langCounts[a]);

    const root = el('div', { cls: 'orbit' });

    /* ── 좌측 컨트롤 패널 ── */
    const aside = el('aside', { cls: 'orbit__panel spip-scroll' });
    const topRow = el('div', { cls: 'orbit__toprow' });
    topRow.appendChild(el('button', {
      cls: 'orbit__back', text: '← 대시보드', attrs: { type: 'button', 'aria-label': '대시보드로 돌아가기' },
      on: { click: exitOrbit },
    }));
    if (bridgeHas('getConfig')) {
      topRow.appendChild(el('button', {
        cls: 'orbit__back', text: '설정', attrs: { type: 'button', 'aria-label': '설정 열기' },
        on: { click: openSettings },
      }));
    }
    aside.appendChild(topRow);
    aside.appendChild(el('div', { children: [
      el('div', { cls: 'orbit__eyebrow', text: 'Project Orbit · 실험적 뷰' }),
      el('h1', { cls: 'orbit__title', children: [document.createTextNode('내 머신의'), el('br'), document.createTextNode('프로젝트 궤도')] }),
      el('p', { cls: 'orbit__lead', text: '중심에 가까울수록 최근에 만진 프로젝트, 바깥으로 밀려날수록 오래 잊힌 프로젝트입니다. 점의 크기는 디스크 용량, 색은 주 언어예요.' }),
    ]}));

    // KPI
    aside.appendChild(el('div', { cls: 'orbit__kpis', children: [
      orbKpi(activeCount, '활동 중', '#34d399', 'active'),
      orbKpi(attention, 'Git 주의', '#fbbf24', 'attention'),
      orbKpi(staleCount, '외곽·방치', '#d6d3d1', 'stale'),
    ]}));

    // 컨트롤 박스 (그룹 간격 13px, 그룹 내부 8px / 정리모드 7px — 템플릿 정합)
    const ctrl = el('div', { cls: 'orbit__box' });
    ctrl.appendChild(el('div', { cls: 'orbit__box-title', text: '컨트롤' }));

    // 검색(돋보기 아이콘 + 입력)
    const searchWrap = el('div', { cls: 'orbit__search-wrap' });
    searchWrap.appendChild(svg(
      [{ t: 'circle', cx: '11', cy: '11', r: '7' }, { t: 'line', x1: '21', y1: '21', x2: '16.5', y2: '16.5' }],
      { size: 13, stroke: 'rgba(255,255,255,.4)', cls: 'orbit__search-icon' }
    ));
    const searchInput = el('input', {
      cls: 'orbit__search', attrs: { type: 'search', placeholder: '이름·경로·/정규식/ 검색', 'aria-label': '궤도 검색(이름·경로·정규식)', autocomplete: 'off', spellcheck: 'false' },
    });
    searchInput.value = o.search;
    searchWrap.appendChild(searchInput);
    // 검색 그룹: 검색 + "이 검색을 제외 추가"(입력값을 그대로 제외 항목으로). 정규식 미리보기 후 바로 추가.
    const searchG = el('div', { cls: 'orbit__group' });
    searchG.appendChild(searchWrap);
    const exAddBtn = el('button', {
      cls: 'orbit__btn-sm orbit__search-add', text: '이 검색을 제외에 추가', attrs: { type: 'button', 'aria-label': '검색값을 제외 항목으로 추가' },
      on: { click: orbAddExcludeFromSearch },
    });
    const canAdd = bridgeHas('addExcludes');
    exAddBtn.disabled = !((o.search || '').trim()) || !canAdd;
    // 입력은 focus 보존 위해 render() 없이 모델만 갱신 → 버튼 disabled 도 여기서 직접 토글.
    searchInput.addEventListener('input', (e) => {
      store.orbit.search = e.target.value || '';
      buildOrbitModel();
      exAddBtn.disabled = !(store.orbit.search.trim()) || !canAdd;
    });
    searchG.appendChild(exAddBtn);
    ctrl.appendChild(searchG);

    // 모션(일시정지 + 속도)
    const motionG = el('div', { cls: 'orbit__group' });
    const motionRow = el('div', { cls: 'orbit__row' });
    motionRow.appendChild(el('span', { cls: 'orbit__row-label', text: '모션' }));
    motionRow.appendChild(el('button', {
      cls: 'orbit__btn-sm', text: o.paused ? '재생' : '일시정지', attrs: { type: 'button' },
      on: { click: () => { store.orbit.paused = !store.orbit.paused; render(); } },
    }));
    motionG.appendChild(motionRow);
    const speedRow = el('div', { cls: 'orbit__sliderrow' });
    const speedLabel = el('span', { cls: 'orbit__speed-val', text: (o.speed).toFixed(1) + '×' });
    orb.speedLabelEl = speedLabel;
    const speed = el('input', { cls: 'orbit__slider', attrs: { type: 'range', min: '0.2', max: '3', step: '0.1', value: String(o.speed), 'aria-label': '회전 속도' } });
    speed.addEventListener('input', (e) => { const v = parseFloat(e.target.value) || 1; store.orbit.speed = v; if (orb.speedLabelEl) orb.speedLabelEl.textContent = v.toFixed(1) + '×'; });
    speedRow.appendChild(speedLabel); speedRow.appendChild(speed);
    motionG.appendChild(speedRow);
    ctrl.appendChild(motionG);

    // 시간 되감기(scrub)
    const scrubG = el('div', { cls: 'orbit__group' });
    const scrubHead = el('div', { cls: 'orbit__row' });
    scrubHead.appendChild(el('span', { cls: 'orbit__row-label', text: '시간 되감기' }));
    const scrubLabel = el('span', { cls: 'orbit__scrub-val', text: o.scrub === 0 ? '현재' : o.scrub + '개월 전' });
    orb.scrubLabelEl = scrubLabel;
    scrubHead.appendChild(scrubLabel);
    scrubG.appendChild(scrubHead);
    const scrub = el('input', { cls: 'orbit__slider orbit__slider--full', attrs: { type: 'range', min: '0', max: '12', step: '1', value: String(o.scrub), 'aria-label': '시간 되감기(개월)' } });
    scrub.addEventListener('input', (e) => { const v = parseInt(e.target.value, 10) || 0; store.orbit.scrub = v; if (orb.scrubLabelEl) orb.scrubLabelEl.textContent = v === 0 ? '현재' : v + '개월 전'; });
    scrubG.appendChild(scrub);
    ctrl.appendChild(scrubG);

    // 배치 기준
    const layoutG = el('div', { cls: 'orbit__group' });
    layoutG.appendChild(el('span', { cls: 'orbit__row-label', text: '배치 기준' }));
    const seg = el('div', { cls: 'orbit__seg' });
    [['drive', '드라이브'], ['lang', '언어']].forEach(([val, label]) => {
      seg.appendChild(el('button', { cls: 'orbit__seg-btn' + (o.layout === val ? ' is-on' : ''), text: label, attrs: { type: 'button' }, on: { click: () => { store.orbit.layout = val; render(); } } }));
    });
    layoutG.appendChild(seg);
    ctrl.appendChild(layoutG);

    // 정리 모드
    const triageG = el('div', { cls: 'orbit__group orbit__group--triage' });
    triageG.appendChild(el('button', { cls: 'orbit__triage' + (o.triage ? ' is-on' : ''), text: '정리 모드', attrs: { type: 'button' }, on: { click: () => { store.orbit.triage = !store.orbit.triage; render(); } } }));
    triageG.appendChild(el('div', { cls: 'orbit__triage-note', children: [
      document.createTextNode('방치 + node_modules '),
      el('b', { cls: 'orbit__reclaim', text: sizeLabel(orb.reclaimMB || 0) }),
      document.createTextNode(' 회수 가능'),
    ]}));
    ctrl.appendChild(triageG);
    aside.appendChild(ctrl);

    // 읽는 법 (각 항목 좌측 34px 스와치 + 설명 — 템플릿 정합)
    const legend = el('div', { cls: 'orbit__box orbit__box--legend' });
    legend.appendChild(el('div', { cls: 'orbit__box-title', text: '읽는 법' }));
    const orbCircle = (d, bg, extra) => { const c = el('span'); c.style.cssText = 'width:' + d + 'px;height:' + d + 'px;border-radius:50%;background:' + bg + ';' + (extra || ''); return c; };
    const legendRow = (swNode, txt) => el('div', { cls: 'orbit__legend-row', children: [swNode, el('span', { text: txt })] });
    const swDist = el('span', { cls: 'orbit__sw' });
    const distBar = el('span'); distBar.style.cssText = 'width:34px;height:13px;border-radius:7px;background:linear-gradient(90deg,#818cf8,rgba(129,140,248,.08))';
    swDist.appendChild(distBar);
    legend.appendChild(legendRow(swDist, '거리 — 중심=최근, 외곽=방치'));
    legend.appendChild(legendRow(el('span', { cls: 'orbit__sw', children: [orbCircle(7, '#8a8580'), orbCircle(14, '#8a8580')] }), '크기 — 디스크 용량'));
    legend.appendChild(legendRow(el('span', { cls: 'orbit__sw', children: [orbCircle(9, '#3178c6'), orbCircle(9, '#cba70f')] }), '색 — 주 언어'));
    legend.appendChild(legendRow(el('span', { cls: 'orbit__sw', children: [orbCircle(11, '#fbbf24', 'box-shadow:0 0 0 4px rgba(251,191,36,.22)')] }), '맥동 고리 — Git 주의'));
    legend.appendChild(legendRow(el('span', { cls: 'orbit__sw orbit__sw--drive', text: 'C·D·E' }), '부채꼴 — 드라이브'));
    aside.appendChild(legend);

    // 언어 칩(클릭해 강조)
    if (langs.length) {
      const langBox = el('div', { cls: 'orbit__langs' });
      langBox.appendChild(el('div', { cls: 'orbit__box-title', text: '언어 · 클릭해 강조' }));
      const chips = el('div', { cls: 'orbit__chips' });
      langs.forEach((lang) => {
        const on = o.hi === lang;
        const chip = el('button', { cls: 'orbit__chip' + (on ? ' is-on' : '') + (o.hi && !on ? ' is-faded' : ''), attrs: { type: 'button' }, on: { click: () => { store.orbit.hi = on ? null : lang; render(); } } });
        const dotn = el('span', { cls: 'orbit__chip-dot' }); dotn.style.background = langColor(lang);
        chip.appendChild(dotn);
        chip.appendChild(document.createTextNode(' ' + lang + ' '));
        chip.appendChild(el('span', { cls: 'orbit__chip-n', text: String(langCounts[lang]) }));
        chips.appendChild(chip);
      });
      langBox.appendChild(chips);
      aside.appendChild(langBox);
    }

    root.appendChild(aside);

    /* ── 우측 캔버스 스테이지 ── */
    const stage = el('div', { cls: 'orbit__stage' });
    // 영속 캔버스 노드를 재사용(재렌더로 컨텍스트·픽셀을 잃지 않게 — 1회만 attach).
    if (!orb.canvasEl) {
      const cv = el('canvas', { cls: 'orbit__canvas' });
      orb.canvasEl = cv;
      attachOrbit(cv);
    }
    if (!orb.raf) orb.raf = requestAnimationFrame(orbitLoop);
    stage.appendChild(orb.canvasEl);

    const zoomBox = el('div', { cls: 'orbit__zoom' });
    const zc = () => { const cv = orb.canvasEl; return cv ? { x: cv.clientWidth / 2, y: cv.clientHeight / 2 } : { x: 0, y: 0 }; };
    zoomBox.appendChild(el('button', { cls: 'orbit__zoom-btn', text: '+', attrs: { type: 'button', title: '확대' }, on: { click: () => { orb.tz = orb.tpx = orb.tpy = null; orb.focusId = null; const c = zc(); orbZoomAt(c.x, c.y, (orb.zoom || 1) * 1.3); } } }));
    zoomBox.appendChild(el('button', { cls: 'orbit__zoom-btn orbit__zoom-btn--out', text: '−', attrs: { type: 'button', title: '축소' }, on: { click: () => { orb.tz = orb.tpx = orb.tpy = null; orb.focusId = null; const c = zc(); orbZoomAt(c.x, c.y, (orb.zoom || 1) / 1.3); } } }));
    zoomBox.appendChild(el('button', { cls: 'orbit__zoom-btn orbit__zoom-btn--reset', text: '⤢', attrs: { type: 'button', title: '원래대로' }, on: { click: () => { orbClearFocus(); } } }));
    stage.appendChild(zoomBox);
    stage.appendChild(el('div', { cls: 'orbit__hint', text: '스크롤 확대 · 드래그 이동 · 클릭해 포커스·상세 · 우클릭해 폴더 제외' }));

    // 우클릭 컨텍스트 메뉴(노드 위에서) — 디렉터리 제외. 바깥/Esc 로 닫힘.
    if (orb.menu) {
      const closeMenu = () => { orb.menu = null; render(); };
      const ov = el('div', { cls: 'orbit__ctx-overlay', on: { click: closeMenu, contextmenu: (e) => { e.preventDefault(); closeMenu(); } } });
      const menu = el('div', { cls: 'orbit__ctxmenu' });
      menu.style.left = orb.menu.x + 'px';
      menu.style.top = orb.menu.y + 'px';
      menu.addEventListener('click', (e) => e.stopPropagation());
      menu.appendChild(el('div', { cls: 'orbit__ctxmenu-title', text: orb.menu.name || '프로젝트' }));
      menu.appendChild(el('div', { cls: 'orbit__ctxmenu-path mono', text: orb.menu.path, title: orb.menu.path }));
      const p = orb.menu.path;
      menu.appendChild(el('button', {
        cls: 'orbit__ctxmenu-btn', text: '이 폴더를 제외에 추가', attrs: { type: 'button' },
        on: { click: () => { orb.menu = null; render(); orbExcludeDir(p); } },
      }));
      stage.appendChild(ov);
      stage.appendChild(menu);
    }

    root.appendChild(stage);
    return root;
  }

  /* ---- 헤더 ---- */
  function renderHeader() {
    const header = el('header', { cls: 'topbar' });

    const brand = el('div', { cls: 'topbar__brand', children: [
      el('div', { cls: 'logo-mark', text: 'S' }),
      el('div', { cls: 'logo-text', text: 'Project-SPIP' }),
      badge('badge--local', 'LOCAL'),
    ]});
    header.appendChild(brand);

    const searchWrap = el('div', { cls: 'topbar__search' });
    searchWrap.appendChild(svg(
      [{ t: 'circle', cx: '11', cy: '11', r: '7' }, { t: 'line', x1: '21', y1: '21', x2: '16.5', y2: '16.5' }],
      { size: 15, stroke: '#a8a29e', cls: 'topbar__search-icon' }
    ));
    const searchInput = el('input', {
      cls: 'topbar__search-input',
      attrs: { type: 'search', placeholder: '이름 · 경로 검색', 'aria-label': '프로젝트 검색', autocomplete: 'off', spellcheck: 'false' },
    });
    searchInput.value = store.state.search;
    const debounced = debounce(() => render(), 120);
    searchInput.addEventListener('input', (e) => { store.state.search = e.target.value || ''; debounced(); });
    searchWrap.appendChild(searchInput);
    header.appendChild(searchWrap);

    header.appendChild(el('div', { cls: 'spacer' }));

    const actions = el('div', { cls: 'topbar__actions' });
    if (store._snapshotLabel) {
      actions.appendChild(el('span', { cls: 'muted snapshot-label', text: store._snapshotLabel }));
    }
    // 도움말 버튼(#6) — 스캔 기준·항목 설명 팝업
    const helpBtn = el('button', {
      cls: 'btn', text: '도움말',
      attrs: { 'aria-label': '도움말 열기' },
      on: { click: openHelp },
    });
    helpBtn.prepend(svg([
      { t: 'circle', cx: '12', cy: '12', r: '9' },
      { t: 'path', d: 'M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.7.4-1 .8-1 1.7' },
      { t: 'line', x1: '12', y1: '17', x2: '12', y2: '17' },
    ], { size: 13, sw: 1.8 }));
    actions.appendChild(helpBtn);

    // 설정(폴더 관리 + 옵션) 버튼
    const settingsBtn = el('button', {
      cls: 'btn', text: '설정',
      attrs: { 'aria-label': '폴더 및 스캔 설정 열기' },
      on: { click: openSettings },
    });
    settingsBtn.prepend(svg([
      { t: 'circle', cx: '12', cy: '12', r: '3' },
      { t: 'path', d: 'M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z' },
    ], { size: 13, sw: 1.8 }));
    actions.appendChild(settingsBtn);

    // 궤도 맵 진입 버튼(UI 템플릿 이식) — 프로젝트를 별/궤도로 보는 실험적 뷰.
    const orbitBtn = el('button', {
      cls: 'btn', text: '궤도 맵',
      attrs: { 'aria-label': '궤도 맵 열기' },
      on: { click: enterOrbit },
    });
    orbitBtn.prepend(svg([
      { t: 'circle', cx: '12', cy: '12', r: '2.5' },
      { t: 'ellipse', cx: '12', cy: '12', rx: '10', ry: '4.5' },
      { t: 'ellipse', cx: '12', cy: '12', rx: '10', ry: '4.5', transform: 'rotate(60 12 12)' },
    ], { size: 13, sw: 1.6 }));
    actions.appendChild(orbitBtn);

    const rescanning = store.state.rescanning;
    const rescan = el('button', {
      cls: 'btn btn--dark', text: rescanning ? '재스캔 중…' : '재스캔',
      attrs: { 'aria-label': '프로젝트 다시 스캔' },
      on: { click: onRescan },
    });
    if (rescanning) rescan.disabled = true;
    else rescan.prepend(svg([{ t: 'path', d: 'M21 12a9 9 0 1 1-2.64-6.36' }, { t: 'path', d: 'M21 3v6h-6' }], { size: 13, sw: 2.2 }));
    actions.appendChild(rescan);
    header.appendChild(actions);
    return header;
  }

  /* ---- 툴바(표시개수·칩·정렬·뷰 토글) ---- */
  function renderToolbar() {
    const st = store.state;
    const list = displayList();
    const bar = el('div', { cls: 'toolbar' });

    const count = el('div', { cls: 'toolbar__count', children: [
      el('b', { text: String(list.length) }),
      el('span', { cls: 'muted', text: ' / ' + store.viewModels.length + ' 프로젝트' }),
    ]});
    bar.appendChild(count);

    // 활성 필터 칩
    for (const chip of activeChips()) {
      const b = el('button', { cls: 'chip', on: { click: chip.remove } });
      b.appendChild(el('span', { text: chip.label }));
      b.appendChild(el('span', { cls: 'chip__x', text: '×' }));
      bar.appendChild(b);
    }
    if (hasFilters()) {
      bar.appendChild(el('button', { cls: 'link-btn', text: '초기화', on: { click: clearFilters } }));
    }

    bar.appendChild(el('div', { cls: 'spacer' }));

    // 정렬
    const sortWrap = el('div', { cls: 'toolbar__sort' });
    sortWrap.appendChild(el('span', { cls: 'toolbar__label', text: '정렬' }));
    const sizeOk = canSortBySize(store.viewModels);
    const sel = el('select', { cls: 'select', attrs: { 'aria-label': '정렬 기준' } });
    [['modified', '최근 수정순'], ['name', '이름순'], ['size', sizeOk ? '용량순' : '용량순 (미측정)']].forEach(([val, label]) => {
      const opt = el('option', { text: label, attrs: { value: val } });
      if (val === 'size' && !sizeOk) opt.disabled = true;
      if (st.sort === val) opt.selected = true;
      sel.appendChild(opt);
    });
    sel.addEventListener('change', (e) => {
      const v = e.target.value;
      if (v === 'size' && !sizeOk) { toast('용량 데이터가 아직 측정되지 않아 최근 수정순으로 표시합니다.'); }
      st.sort = v;
      // R-19: 정렬 셀렉터를 고르면 수동순서(manual) → auto 복귀(§7).
      applySortMode('sortSelect');
      render();
    });
    sortWrap.appendChild(sel);
    // R-19: 수동순서(manual) 상태 표시 + auto 복귀 토글(키보드 도달)
    if (st.sortMode === 'manual') {
      const manualBtn = el('button', {
        cls: 'link-btn toolbar__manual',
        text: '수동순서 · 자동정렬로',
        attrs: { type: 'button', 'aria-label': '수동 순서 해제하고 자동 정렬로 전환' },
        on: { click: () => { applySortMode('sortSelect'); render(); } },
      });
      sortWrap.appendChild(manualBtn);
    }
    bar.appendChild(sortWrap);

    // 카드/표 토글
    bar.appendChild(segToggle([
      ['cards', '카드', st.density === 'cards', () => { st.density = 'cards'; render(); }],
      ['table', '표', st.density === 'table', () => { st.density = 'table'; render(); }],
    ]));
    // R-20: '즐겨찾기만' 필터 토글(aria-pressed)
    const favOnly = el('button', {
      cls: 'btn favfilter-btn' + (st.favoritesOnly ? ' is-active' : ''),
      attrs: { type: 'button', 'aria-pressed': st.favoritesOnly ? 'true' : 'false', 'aria-label': '즐겨찾기만 보기 토글' },
      on: { click: () => { st.favoritesOnly = !st.favoritesOnly; render(); } },
    });
    favOnly.appendChild(starIcon(st.favoritesOnly, 13));
    favOnly.appendChild(el('span', { text: '즐겨찾기만' }));
    bar.appendChild(favOnly);

    // [M7 §8.1] '슬라이더' 버튼 제거 — 즐겨찾기는 트레이 '즐겨찾기' → 독립 위젯 창에서 표시.

    // 카드/표 토글
    bar.appendChild(segToggle([
      ['cards', '카드', st.density === 'cards', () => { st.density = 'cards'; render(); }],
      ['table', '표', st.density === 'table', () => { st.density = 'table'; render(); }],
    ]));
    // 사이드바/툴바 토글
    bar.appendChild(segToggle([
      ['sidebar', '사이드바', st.layout === 'sidebar', () => { st.layout = 'sidebar'; render(); }],
      ['toolbar', '툴바', st.layout === 'toolbar', () => { st.layout = 'toolbar'; render(); }],
    ]));

    return bar;
  }

  /** 별 아이콘 SVG(채움 여부). filled=true면 currentColor 채움. */
  function starIcon(filled, size) {
    const s = svg([{ t: 'path', d: 'M12 2.5l2.9 5.9 6.5.95-4.7 4.6 1.1 6.45L12 17.85 6.1 20.95l1.1-6.45-4.7-4.6 6.5-.95z' }], { size: size || 14, sw: 1.6 });
    if (filled) { s.setAttribute('fill', 'currentColor'); }
    return s;
  }
  function segToggle(items) {
    const group = el('div', { cls: 'seg' });
    for (const [, label, active, on] of items) {
      group.appendChild(el('button', {
        cls: 'seg__btn' + (active ? ' is-active' : ''),
        text: label,
        attrs: { 'aria-pressed': active ? 'true' : 'false' },
        on: { click: on },
      }));
    }
    return group;
  }

  /* ---- KPI 5종 ---- */
  function renderKpis() {
    const s = deriveStats(store.stats, store.viewModels);
    const gc = gitChangeCounts(store.viewModels);
    const grid = el('div', { cls: 'kpis' });

    // 1. 전체
    grid.appendChild(kpi('전체 프로젝트', [
      el('div', { cls: 'kpi__value', text: String(s.total) }),
      el('div', { cls: 'kpi__sub', text: s.activeCount + ' 활동 · ' + s.staleCount + ' 방치' }),
    ]));

    // 2. Git 변경 (dirty boolean → 개수 집계)
    const gitRow = el('div', { cls: 'kpi__dual' });
    gitRow.appendChild(el('div', { children: [
      el('span', { cls: 'kpi__value kpi__value--warn', text: String(gc.dirty) }),
      el('span', { cls: 'kpi__unit', text: ' 미커밋' }),
    ]}));
    gitRow.appendChild(el('div', { children: [
      el('span', { cls: 'kpi__value kpi__value--push', text: String(gc.ahead) }),
      el('span', { cls: 'kpi__unit', text: ' 미푸시' }),
    ]}));
    grid.appendChild(kpi('Git 변경', [gitRow, el('div', { cls: 'kpi__sub', text: '커밋·푸시 잊은 프로젝트' })]));

    // 3. 방치
    grid.appendChild(kpi('방치(Stale)', [
      el('div', { cls: 'kpi__value kpi__value--muted', text: String(s.staleCount) }),
      el('div', { cls: 'kpi__sub', text: '기준 ' + STALE_DAYS + '일 무활동' }),
    ]));

    // 4. 언어 분포
    const facets = languageFacets(store.viewModels);
    const totalForBar = store.viewModels.length || 1;
    const bar = el('div', { cls: 'langbar' });
    for (const f of facets) {
      const seg = el('div', { cls: 'langbar__seg' });
      seg.style.width = (f.count / totalForBar * 100) + '%';
      seg.style.background = langColor(f.lang);
      seg.title = f.lang + ' ' + f.count;
      bar.appendChild(seg);
    }
    const legend = el('div', { cls: 'langlegend' });
    for (const f of facets.slice(0, 4)) {
      legend.appendChild(el('span', { cls: 'langlegend__item', children: [
        dot(f.lang),
        el('span', { text: f.lang }),
        el('span', { cls: 'mono muted', text: String(f.count) }),
      ]}));
    }
    grid.appendChild(kpi('언어 분포 · ' + facets.length + '종', [bar, legend]));

    // 5. 디스크 (size 측정 스냅샷이면 실값, 아니면 미측정)
    const diskValCls = 'kpi__value' + (s.totalBytesMeasured ? '' : ' kpi__value--na');
    grid.appendChild(kpi('디스크 사용', [
      el('div', { cls: diskValCls, text: s.totalBytes }),
      el('div', { cls: 'kpi__sub', text: 'node_modules ' + s.nodeModulesBytes }),
    ]));

    return grid;
  }
  function kpi(label, children) {
    return el('div', { cls: 'kpi', children: [
      el('div', { cls: 'kpi__label', text: label }),
      ...children,
    ]});
  }

  /* ---- 사이드바 패싯 ---- */
  function renderSidebar() {
    const aside = el('aside', { cls: 'sidebar spip-scroll', attrs: { 'aria-label': '필터' } });
    aside.appendChild(facetBlockLanguages('list'));
    aside.appendChild(el('div', { cls: 'sidebar__divider' }));
    aside.appendChild(facetBlockFreshness('list'));
    aside.appendChild(el('div', { cls: 'sidebar__divider' }));
    aside.appendChild(facetBlockGit('list'));
    return aside;
  }

  /* ---- 툴바 레이아웃 패싯 바 ---- */
  function renderToolbarFacets() {
    const bar = el('div', { cls: 'facetbar spip-scroll' });
    bar.appendChild(el('span', { cls: 'facetbar__label', text: '언어' }));
    for (const node of facetChips('languages', languageFacets(store.viewModels).map((f) => ({ key: f.lang, label: f.lang, count: f.count, lang: f.lang })))) bar.appendChild(node);
    bar.appendChild(el('div', { cls: 'facetbar__sep' }));
    bar.appendChild(el('span', { cls: 'facetbar__label', text: '신선도' }));
    for (const node of facetChips('freshness', freshnessItems())) bar.appendChild(node);
    bar.appendChild(el('div', { cls: 'facetbar__sep' }));
    bar.appendChild(el('span', { cls: 'facetbar__label', text: 'Git' }));
    for (const node of facetChips('git', gitItems())) bar.appendChild(node);
    return bar;
  }

  function freshnessItems() {
    const s = deriveStats(store.stats, store.viewModels);
    return [
      { key: 'active', label: '활동 중', count: s.activeCount },
      { key: 'stale', label: '방치(' + STALE_DAYS + '일+)', count: s.staleCount },
    ];
  }
  function gitItems() {
    const c = gitFacetCounts(store.viewModels);
    return [
      { key: 'clean', label: '정상', count: c.clean, color: '#15803d' },
      { key: 'dirty', label: '미커밋 변경', count: c.dirty, color: '#b45309' },
      { key: 'ahead', label: '미푸시(ahead)', count: c.ahead, color: '#1d4ed8' },
      { key: 'norepo', label: 'Git 아님', count: c.norepo, color: '#d6d3d1' },
    ];
  }

  function facetBlockLanguages() {
    const block = el('div', { cls: 'facet' });
    block.appendChild(el('div', { cls: 'facet__title', text: '언어' }));
    for (const f of languageFacets(store.viewModels)) {
      block.appendChild(facetCheckRow('languages', f.lang, f.lang, f.count, { lang: f.lang }));
    }
    return block;
  }
  function facetBlockFreshness() {
    const block = el('div', { cls: 'facet' });
    block.appendChild(el('div', { cls: 'facet__title', text: '신선도' }));
    for (const it of freshnessItems()) {
      block.appendChild(facetCheckRow('freshness', it.key, it.label, it.count, {}));
    }
    return block;
  }
  function facetBlockGit() {
    const block = el('div', { cls: 'facet' });
    block.appendChild(el('div', { cls: 'facet__title', text: 'Git 상태' }));
    for (const it of gitItems()) {
      block.appendChild(facetCheckRow('git', it.key, it.label, it.count, { color: it.color }));
    }
    return block;
  }

  /** 사이드바 체크 행. */
  function facetCheckRow(group, key, label, count, opts) {
    opts = opts || {};
    const checked = store.state.filters[group].includes(key);
    const input = el('input', { attrs: { type: 'checkbox' }, cls: 'facet__check' });
    input.checked = checked;
    input.addEventListener('change', () => { toggleFilter(group, key); });
    const row = el('label', { cls: 'facet__row' });
    row.appendChild(input);
    if (opts.lang) row.appendChild(dot(opts.lang));
    else if (opts.color) row.appendChild(colorDot(opts.color, 8));
    row.appendChild(el('span', { cls: 'facet__name', text: label }));
    row.appendChild(el('span', { cls: 'mono facet__count', text: String(count) }));
    return row;
  }

  /** 툴바 칩(체크박스 포함). */
  function facetChips(group, items) {
    return items.map((it) => {
      const checked = store.state.filters[group].includes(it.key);
      const input = el('input', { attrs: { type: 'checkbox' }, cls: 'facet__check' });
      input.checked = checked;
      input.addEventListener('change', () => toggleFilter(group, it.key));
      const label = el('label', { cls: 'facetchip' + (checked ? ' is-active' : '') });
      label.appendChild(input);
      if (it.lang) label.appendChild(dot(it.lang));
      else if (it.color) label.appendChild(colorDot(it.color, 7));
      label.appendChild(el('span', { text: it.label }));
      label.appendChild(el('span', { cls: 'mono muted facetchip__count', text: String(it.count) }));
      return label;
    });
  }

  /**
   * 표시 목록(필터·검색·즐겨찾기 필터 적용 + 정렬/수동순서)을 산출.
   *   - 즐겨찾기만(favoritesOnly) 필터를 기존 AND 필터에 합류(R-20).
   *   - sortMode='manual' 이면 order(id 배열) 순서로 배치(신규는 뒤 append, R-19),
   *     'auto' 면 기존 정렬(sort 키) 적용.
   */
  function displayList() {
    const st = store.state;
    const filtered = store.viewModels.filter((vm) =>
      matchesFilters(vm, st.filters)
      && matchesSearch(vm, st.search || '')
      && matchesFavoritesFilter(vm, st.favoritesOnly, st.favorites)
    );
    if (st.sortMode === 'manual') {
      return applyOrder(filtered, 'manual', st.order);
    }
    return sortViewModels(filtered, st.sort || 'modified');
  }

  /* ---- 결과(카드/표/무결과) ---- */
  function renderResults() {
    const list = displayList();
    if (list.length === 0) return renderNoResults();
    return store.state.density === 'table' ? renderTable(list) : renderCards(list);
  }

  function renderNoResults() {
    const wrap = el('div', { cls: 'noresults' });
    const icon = el('div', { cls: 'noresults__icon', children: [
      svg([{ t: 'circle', cx: '11', cy: '11', r: '7' }, { t: 'line', x1: '21', y1: '21', x2: '16.5', y2: '16.5' }], { size: 22, stroke: '#a8a29e' }),
    ]});
    wrap.appendChild(icon);
    wrap.appendChild(el('div', { cls: 'noresults__title', text: '조건에 맞는 프로젝트가 없습니다' }));
    wrap.appendChild(el('div', { cls: 'noresults__sub', text: '필터나 검색어를 조정해 보세요.' }));
    wrap.appendChild(el('button', { cls: 'btn', text: '필터 초기화', on: { click: clearFilters } }));
    return wrap;
  }

  function renderCards(list) {
    const grid = el('div', { cls: 'cards' });
    // 드래그 reorder 는 cards 밀도에서만(§7). 현재 표시 목록의 id 순서를 reorder 기준으로 삼는다.
    const ids = list.map((vm) => vm.id);
    for (let i = 0; i < list.length; i++) grid.appendChild(buildCard(list[i], i, ids));
    return grid;
  }

  function buildCard(vm, index, displayIds) {
    const card = el('article', { cls: 'card' });
    // [M8] 카드 순서 변경은 SortableJS(initCardSortable)가 .cards 컨테이너에서 일괄 관리한다.
    //   드래그 중 placeholder 라이브 프리뷰 + 형제 카드 실시간 시프트(onEnd 에서 setOrder 영속).
    //   data-card-id 는 onEnd 의 새 순서 산출·FLIP 키로 사용. 키보드 이동 버튼은 접근성 대체(N-07).
    card.dataset.cardId = vm.id || '';

    const head = el('div', { cls: 'card__head' });
    head.appendChild(dot(vm.language));
    // 키보드 도달 가능한 버튼(N-07 2.1.1) — 제목 클릭으로 상세 드로어
    const titleWrap = el('button', {
      cls: 'card__titlewrap',
      attrs: { type: 'button', 'aria-label': '상세 보기: ' + vm.name },
      on: { click: () => openDrawer(vm.id) },
    });
    titleWrap.appendChild(el('div', { cls: 'card__name', text: vm.name, title: vm.name }));
    titleWrap.appendChild(el('div', { cls: 'card__path mono', text: vm.path, title: vm.path }));
    head.appendChild(titleWrap);
    // R-20: 즐겨찾기 별 토글(aria-pressed)
    head.appendChild(favoriteButton(vm));
    card.appendChild(head);

    card.appendChild(el('div', { cls: 'card__desc', text: vm.description || '설명 없음' }));

    const badges = el('div', { cls: 'card__badges' });
    badges.appendChild(badge('badge--lang mono', vm.language));
    appendGitBadges(badges, vm, false);
    if (vm.isStale) badges.appendChild(badge('badge--stale', '방치'));
    card.appendChild(badges);

    const footer = el('div', { cls: 'card__footer' });
    const meta = el('div', { cls: 'card__meta mono', children: [
      el('span', { text: rel(vm.lastModified) }),
      el('span', { cls: 'card__meta-sep', text: '·' }),
      el('span', { text: sizeStatusLabel(vm.sizeStatus, vm.totalBytes) }),
    ]});
    footer.appendChild(meta);
    const acts = el('div', { cls: 'card__acts' });
    // 카드 순서 변경은 드래그(SortableJS)로만 — 좌/우 이동 버튼은 제거(사용자 요청).
    // R-17: 경로 복사
    acts.appendChild(copyPathButton(vm, 'btn btn--ghost btn--sm'));
    acts.appendChild(el('button', { cls: 'btn btn--ghost', text: '상세', on: { click: () => openDrawer(vm.id) } }));
    acts.appendChild(openButton(vm, 'btn btn--dark'));
    footer.appendChild(acts);
    card.appendChild(footer);

    return card;
  }

  /** R-20: 즐겨찾기 별 토글 버튼(aria-pressed, N-07). */
  function favoriteButton(vm) {
    const on = isFavorite(store.state.favorites, vm.id);
    const btn = el('button', {
      cls: 'fav-btn' + (on ? ' is-on' : ''),
      attrs: {
        type: 'button',
        'aria-pressed': on ? 'true' : 'false',
        'aria-label': (on ? '즐겨찾기 해제: ' : '즐겨찾기 추가: ') + vm.name,
        title: on ? '즐겨찾기 해제' : '즐겨찾기 추가',
      },
      on: { click: (e) => { e.stopPropagation(); setFavorite(vm.id, !on); } },
    });
    if (!vm.id) btn.disabled = true;
    btn.appendChild(starIcon(on, 16));
    return btn;
  }

  /** R-17: 경로 복사 버튼(클립보드는 main copyText IPC — navigator.clipboard 미사용). */
  function copyPathButton(vm, cls) {
    const btn = el('button', {
      cls: cls || 'btn btn--ghost btn--sm', text: '경로 복사',
      attrs: { type: 'button', 'aria-label': '경로 복사: ' + vm.path },
      on: { click: (e) => { e.stopPropagation(); copyPath(vm.path); } },
    });
    return btn;
  }

  /** Git 배지들(카드/표 공용). table=true면 컴팩트 클래스. */
  function appendGitBadges(container, vm, table) {
    const pfx = table ? 'badge--t ' : '';
    if (vm.gitStatus === 'na') { container.appendChild(badge(pfx + 'badge--git-na', 'Git 아님')); return; }
    if (vm.gitStatus === 'dirty') container.appendChild(badge(pfx + 'badge--git-dirty', '미커밋'));
    if (vm.ahead > 0) container.appendChild(badge(pfx + 'badge--git-ahead', '미푸시 ' + vm.ahead));
    if (vm.gitStatus !== 'dirty' && !(vm.ahead > 0)) container.appendChild(badge(pfx + 'badge--git-clean', '정상'));
  }

  function renderTable(list) {
    const wrap = el('div', { cls: 'table-wrap' });
    const table = el('table', { cls: 'table' });
    const thead = el('thead');
    const trh = el('tr');
    ['프로젝트', '경로', '언어', '최종 수정', 'Git', '크기', ''].forEach((h, i) => {
      const th = el('th', { text: h });
      if (i === 5) th.className = 'ta-right';
      trh.appendChild(th);
    });
    thead.appendChild(trh);
    table.appendChild(thead);

    const tbody = el('tbody');
    for (const vm of list) {
      const tr = el('tr', { cls: 'table__row', on: { click: () => openDrawer(vm.id) } });

      const tdName = el('td');
      // 키보드 도달 가능한 이름 버튼(N-07 2.1.1)
      const nameBtn = el('button', {
        cls: 'table__name table__name-btn',
        attrs: { type: 'button', 'aria-label': '상세 보기: ' + vm.name },
        children: [dot(vm.language), el('span', { text: vm.name })],
        on: { click: (e) => { e.stopPropagation(); openDrawer(vm.id); } },
      });
      tdName.appendChild(nameBtn);
      tr.appendChild(tdName);

      tr.appendChild(el('td', { cls: 'table__path mono', text: vm.path, title: vm.path }));
      tr.appendChild(el('td', { cls: 'table__lang', text: vm.language }));

      const tdMod = el('td', { cls: 'table__mod mono' });
      tdMod.appendChild(el('span', { text: rel(vm.lastModified) }));
      if (vm.isStale) tdMod.appendChild(badge('badge--stale badge--t', '방치'));
      tr.appendChild(tdMod);

      const tdGit = el('td');
      const gb = el('div', { cls: 'table__git' });
      appendGitBadges(gb, vm, true);
      tdGit.appendChild(gb);
      tr.appendChild(tdGit);

      tr.appendChild(el('td', { cls: 'ta-right mono table__size', text: sizeStatusLabel(vm.sizeStatus, vm.totalBytes) }));

      const tdAct = el('td', { cls: 'ta-right' });
      const actWrap = el('div', { cls: 'table__acts' });
      actWrap.appendChild(favoriteButton(vm)); // R-20
      actWrap.appendChild(copyPathButton(vm, 'btn btn--ghost btn--sm')); // R-17
      actWrap.appendChild(openButton(vm, 'btn btn--ghost btn--sm'));
      // 행 클릭(드로어)와 분리
      tdAct.appendChild(actWrap);
      tr.appendChild(tdAct);

      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    wrap.appendChild(table);
    return wrap;
  }

  /** VS Code 열기 버튼(상태 라벨 포함, 연타 방지). */
  function openButton(vm, cls) {
    const opening = !!store.state.opening[vm.id];
    const btn = el('button', { cls, text: opening ? '여는 중…' : '열기' });
    btn.setAttribute('aria-label', 'VS Code로 열기: ' + vm.name);
    if (!vm.id || opening) btn.disabled = true;
    btn.addEventListener('click', (e) => { e.stopPropagation(); openProject(vm.id); });
    return btn;
  }

  /* =====================================================================
   * 상세 드로어 (4 인사이트)
   * ===================================================================== */
  function openDrawer(id) {
    // 포커스 복귀(N-07 2.4.3): 현재 포커스(=여는 버튼/행)를 기억
    store._drawerOpener = (typeof document !== 'undefined') ? document.activeElement : null;
    store.state.selectedId = id;
    render();
  }
  function closeDrawer() {
    store.state.selectedId = null;
    store._drawerShown = false; // 다음 열림에 진입 슬라이드 재적용
    const opener = store._drawerOpener;
    store._drawerOpener = null;
    render();
    // 닫은 뒤 여는 버튼으로 포커스 복귀(요소가 재렌더로 사라졌으면 무시)
    if (opener && typeof opener.focus === 'function' && document.contains(opener)) {
      try { opener.focus(); } catch (_) { /* ignore */ }
    }
  }

  /** 컨테이너 내 tabbable 요소 목록(포커스 트랩용). */
  function getTabbables(container) {
    const sel = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
    return Array.prototype.slice.call(container.querySelectorAll(sel))
      .filter((n) => n.offsetParent !== null || n === document.activeElement);
  }

  function renderDrawer() {
    const vm = store.viewModels.find((v) => v.id === store.state.selectedId);
    if (!vm) { store.state.selectedId = null; return el('div'); }

    const overlay = el('div', { cls: 'drawer-overlay', on: { click: closeDrawer } });
    const titleId = 'drawer-title';
    const enter = !store._drawerShown; store._drawerShown = true; // 진입 슬라이드 1회만(재렌더 깜빡임 방지)
    const aside = el('aside', { cls: 'drawer spip-scroll' + (enter ? ' is-enter' : ''), attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId } });
    aside.addEventListener('click', (e) => e.stopPropagation());

    // header
    const head = el('div', { cls: 'drawer__head' });
    head.appendChild(dot(vm.language, 9));
    const nameEl = el('div', { cls: 'drawer__name', text: vm.name, attrs: { id: titleId } });
    head.appendChild(el('div', { cls: 'drawer__titlewrap', children: [
      nameEl,
      el('div', { cls: 'drawer__path mono', text: vm.path }),
    ]}));
    const close = el('button', { cls: 'drawer__close', text: '×', attrs: { 'aria-label': '닫기' }, on: { click: closeDrawer } });
    head.appendChild(close);
    aside.appendChild(head);

    const bodyWrap = el('div', { cls: 'drawer__body' });

    // open button + desc
    const openBtn = openButton(vm, 'btn btn--dark btn--block');
    openBtn.textContent = store.state.opening[vm.id] ? '여는 중…' : 'VS Code로 열기';
    openBtn.prepend(svg([{ t: 'path', d: 'M5 12h14M13 6l6 6-6 6' }], { size: 14 }));
    bodyWrap.appendChild(openBtn);
    // R-17/R-20: 경로 복사 + 즐겨찾기 토글
    const drawerActs = el('div', { cls: 'drawer__acts' });
    drawerActs.appendChild(copyPathButton(vm, 'btn'));
    const favWrap = favoriteButton(vm);
    favWrap.classList.add('fav-btn--labeled');
    favWrap.appendChild(el('span', { cls: 'fav-btn__label', text: isFavorite(store.state.favorites, vm.id) ? '즐겨찾기됨' : '즐겨찾기' }));
    drawerActs.appendChild(favWrap);
    bodyWrap.appendChild(drawerActs);
    bodyWrap.appendChild(el('div', { cls: 'drawer__desc', text: vm.description || '설명 없음' }));

    // insight 1: language
    bodyWrap.appendChild(insightLanguage(vm));
    // insight 2: freshness
    bodyWrap.appendChild(insightFreshness(vm));
    // insight 3: git
    bodyWrap.appendChild(insightGit(vm));
    // insight 4: size
    bodyWrap.appendChild(insightSize(vm));

    aside.appendChild(bodyWrap);
    overlay.appendChild(aside);

    // 키보드: Esc 닫기 + Tab/Shift+Tab 포커스 트랩(N-07 2.4.3·1.3.2)
    aside.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); closeDrawer(); return; }
      if (e.key !== 'Tab') return;
      const items = getTabbables(aside);
      if (items.length === 0) { e.preventDefault(); return; }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (e.shiftKey) {
        if (active === first || !aside.contains(active)) { e.preventDefault(); last.focus(); }
      } else {
        if (active === last || !aside.contains(active)) { e.preventDefault(); first.focus(); }
      }
    });
    // 초기 포커스: 닫기 버튼(드로어 내부)
    setTimeout(() => { try { close.focus(); } catch (_) { /* ignore */ } }, 0);
    return overlay;
  }

  function insightCard(title, rows) {
    return el('div', { cls: 'insight', children: [
      el('div', { cls: 'insight__title', text: title }),
      ...rows,
    ]});
  }
  function kvRow(k, valueNode) {
    const row = el('div', { cls: 'kv' });
    row.appendChild(el('span', { cls: 'kv__k', text: k }));
    row.appendChild(valueNode);
    return row;
  }

  function insightLanguage(vm) {
    const head = el('div', { cls: 'insight__langhead', children: [dot(vm.language, 9), el('span', { cls: 'insight__langname', text: vm.language })] });
    const percents = langPercents(vm);
    const bar = el('div', { cls: 'mixbar' });
    for (const m of percents) {
      const seg = el('div', { cls: 'mixbar__seg' });
      seg.style.width = m.pct + '%';
      seg.style.background = langColor(m.name);
      bar.appendChild(seg);
    }
    const list = el('div', { cls: 'mixlist' });
    for (const m of percents) {
      list.appendChild(el('div', { cls: 'mixlist__row', children: [
        dot(m.name), el('span', { cls: 'mixlist__name', text: m.name }), el('span', { cls: 'mono muted', text: m.pct + '%' }),
      ]}));
    }
    return insightCard('언어 / 스택', [head, bar, list]);
  }

  function insightFreshness(vm) {
    const modVal = el('span', { cls: 'kv__v', children: [
      el('span', { text: fmtDate(vm.lastModified) }),
      el('span', { cls: 'mono muted kv__rel', text: ' (' + rel(vm.lastModified) + ')' }),
    ]});
    const commitVal = el('span', { cls: 'kv__v', children: [
      el('span', { text: fmtDate(vm.lastCommit) }),
      el('span', { cls: 'mono muted kv__rel', text: ' (' + rel(vm.lastCommit) + ')' }),
    ]});
    const statusBadge = vm.isStale
      ? badge('badge--stale', '방치 · ' + STALE_DAYS + '일+ 무활동')
      : badge('badge--git-clean', '활동 중');
    return insightCard('활동 / 신선도', [
      kvRow('최종 파일 수정', modVal),
      el('div', { cls: 'kv__divider' }),
      kvRow('최근 커밋', commitVal),
      el('div', { cls: 'kv__divider' }),
      kvRow('상태', statusBadge),
    ]);
  }

  function insightGit(vm) {
    if (vm.gitStatus === 'na') {
      return insightCard('Git 상태', [el('div', { cls: 'git-na', children: [
        colorDot('#d6d3d1', 8), el('span', { text: 'Git 저장소가 아닙니다 — N/A' }),
      ]})]);
    }
    const branchVal = el('span', { cls: 'mono pill', text: vm.branch || '(브랜치 미상)' });
    const dirtyVal = vm.dirty
      ? el('span', { cls: 'kv__v kv__v--warn', text: '있음(미커밋 변경)' })
      : el('span', { cls: 'kv__v kv__v--ok', text: '없음' });
    const aheadBehind = el('span', { cls: 'mono kv__v', text: '↑' + (vm.ahead || 0) + ' ↓' + (vm.behind || 0) });
    return insightCard('Git 상태', [
      kvRow('브랜치', branchVal),
      el('div', { cls: 'kv__divider' }),
      kvRow('미커밋 변경', dirtyVal),
      el('div', { cls: 'kv__divider' }),
      kvRow('원격 대비', aheadBehind),
    ]);
  }

  function insightSize(vm) {
    // size.status 별 실값/근사/실패/미측정 (N-07: 색 외 텍스트 병기)
    const measured = vm.sizeStatus === 'ok' || vm.sizeStatus === 'partial';
    const totalCls = 'mono kv__v' + (measured ? '' : ' kv__v--na');
    const totalVal = el('span', { cls: totalCls, text: sizeStatusLabel(vm.sizeStatus, vm.totalBytes) });
    const nmText = (typeof vm.nodeModulesBytes === 'number')
      ? sizeStatusLabel(vm.sizeStatus, vm.nodeModulesBytes)
      : '미측정';
    const nmCls = 'mono kv__v' + (typeof vm.nodeModulesBytes === 'number' ? '' : ' kv__v--na');
    const depsHas = (typeof vm.deps === 'number' || typeof vm.devDeps === 'number');
    return insightCard('규모 / 의존성', [
      kvRow('총 용량', totalVal),
      el('div', { cls: 'kv__divider' }),
      kvRow('node_modules', el('span', { cls: nmCls, text: nmText })),
      el('div', { cls: 'kv__divider' }),
      kvRow('의존성', el('span', { cls: 'mono kv__v' + (depsHas ? '' : ' kv__v--na'), text: depsLabel(vm) })),
    ]);
  }
  function depsLabel(vm) {
    if (typeof vm.deps !== 'number' && typeof vm.devDeps !== 'number') return '미측정';
    return (vm.deps || 0) + ' deps · ' + (vm.devDeps || 0) + ' devDeps';
  }

  /* =====================================================================
   * 필터 상태 조작 (메모리)
   * ===================================================================== */
  function toggleFilter(group, key) {
    const arr = store.state.filters[group];
    const i = arr.indexOf(key);
    if (i >= 0) arr.splice(i, 1); else arr.push(key);
    render();
  }
  function clearFilters() {
    store.state.search = '';
    store.state.filters = { languages: [], freshness: [], git: [] };
    render();
  }
  function hasFilters() {
    const f = store.state.filters;
    return !!(store.state.search.trim() || f.languages.length || f.freshness.length || f.git.length);
  }
  function activeChips() {
    const chips = [];
    const f = store.state.filters;
    f.languages.forEach((l) => chips.push({ label: l, remove: () => toggleFilter('languages', l) }));
    const freshLabel = { active: '활동 중', stale: '방치' };
    f.freshness.forEach((k) => chips.push({ label: freshLabel[k] || k, remove: () => toggleFilter('freshness', k) }));
    const gitLabel = { clean: '정상', dirty: '미커밋', ahead: '미푸시', norepo: 'Git 아님' };
    f.git.forEach((k) => chips.push({ label: gitLabel[k] || k, remove: () => toggleFilter('git', k) }));
    if (store.state.search.trim()) chips.push({ label: '"' + store.state.search.trim() + '"', remove: () => { store.state.search = ''; render(); } });
    return chips;
  }

  /* =====================================================================
   * 액션
   * ===================================================================== */
  function onRescan() { triggerRescan('dashboard'); }

  /**
   * R-16 + R-15: spip.rescan(opts) → SCAN_STARTED 면 scanning 뷰 + onScanProgress 구독.
   *   returnView = 진행 끝나면 돌아갈 뷰(현재 firstRun/dashboard).
   *   M4-L-1: SCAN_STARTED 의 scanId 를 보관해 push 응답과 대조.
   *   옵션: store.opts(withSize/allDrives)를 config 게이트로 정규화해 전달(§4.2).
   */
  async function triggerRescan(returnView) {
    if (store.state.rescanning) return;
    store.state.rescanning = true;
    const rv = returnView || (store.state.view === 'firstRun' ? 'firstRun' : 'dashboard');
    store.scan.returnView = rv;
    render(); // 버튼 비활성 반영

    const opts = sanitizeRescanOpts(store.opts, store.config);
    const data = await ipc('rescan', opts);
    const cls = classifyRescan(data);
    store.state.rescanning = false;

    if (cls.action === 'start' || cls.action === 'in-progress') {
      store.scan.ownScanId = cls.scanId || null;
      store.scan.progress = { phase: 'scanning', scanId: cls.scanId || null, dirs: 0, found: 0, currentPath: null, elapsedMs: 0 };
      store.scan.startedAt = Date.now();
      store.state.view = 'scanning';
      if (cls.action === 'in-progress') toast('이미 스캔이 진행 중입니다. 진행 상황을 표시합니다.');
      render();
      subscribeScan();
      return;
    }
    if (cls.action === 'no-roots') {
      toast((data && data.message) || '스캔할 폴더가 없습니다. 설정에서 폴더를 추가하세요.', true);
      render();
      return;
    }
    toast(describeError(data), true);
    render();
  }

  /**
   * R-15 push: spip.onScanProgress(cb) 구독. 1초 폴링·타이머 제거.
   *   cb 가 ScanProgress 를 받아 nextScanAction 으로 분기 → scanning 뷰 갱신 /
   *   done → getProjects/getStats 재조회 / error·foreign 가드.
   *   초기 1회 getScanStatus 로 동기화(놓친 첫 이벤트 보완).
   */
  function subscribeScan() {
    unsubscribeScan();
    if (!hasBridge() || typeof spip.onScanProgress !== 'function') {
      // 브리지 없음(비-Electron) — 진행 통지 불가, 동기 상태만 시도
      syncScanStatusOnce();
      return;
    }
    store.scan.unsubscribe = spip.onScanProgress((payload) => handleScanProgress(payload));
    // 구독 직후 현재 상태 1회 동기화(이미 진행 중인 스캔 따라잡기)
    syncScanStatusOnce();
  }
  function unsubscribeScan() {
    if (typeof store.scan.unsubscribe === 'function') {
      try { store.scan.unsubscribe(); } catch (_) { /* ignore */ }
    }
    store.scan.unsubscribe = null;
  }
  async function syncScanStatusOnce() {
    const status = await ipc('getScanStatus');
    if (status && typeof status === 'object' && status.ok !== false) handleScanProgress(status);
  }

  /** onScanProgress 콜백 본체(push 1건 처리). */
  function handleScanProgress(payload) {
    const act = nextScanAction({ ownScanId: store.scan.ownScanId }, payload);
    if (payload && typeof payload === 'object') store.scan.progress = mergeElapsed(payload);

    if (act.action === 'foreign') {
      // 다른 스캔 — 구독 해제, 화면 유지(혼선 방지)
      unsubscribeScan();
      return;
    }
    if (act.action === 'render') {
      if (store.state.view === 'scanning') render();
      return;
    }
    if (act.action === 'error') {
      unsubscribeScan();
      if (store.state.view === 'scanning') render();
      return;
    }
    if (act.action === 'refetch') {
      // done → 구독 해제 + done 화면 잠깐 표시 후 데이터 재조회
      unsubscribeScan();
      if (store.state.view === 'scanning') render();
      reloadAfterScan();
      return;
    }
  }

  /** elapsedMs 가 push 페이로드에 없으면 로컬 시작시각으로 폴백. */
  function mergeElapsed(status) {
    const s = Object.assign({}, status);
    if (typeof s.elapsedMs !== 'number' || !Number.isFinite(s.elapsedMs)) {
      s.elapsedMs = store.scan.startedAt ? (Date.now() - store.scan.startedAt) : 0;
    }
    return s;
  }

  /** phase=done 이후 getProjects/getStats 재조회 후 대시보드 갱신(R-11). */
  async function reloadAfterScan() {
    try {
      const payload = await ipc('getProjects');
      if (!payload || payload.ok === false || !Array.isArray(payload.projects)) {
        if (payload && payload.ok === false) throw new Error(describeError(payload));
        // 빈 스냅샷도 graceful
      }
      const stats = await ipc('getStats');
      store.stats = (stats && stats.ok !== false) ? stats : null;
      store.now = new Date();
      store._snapshotLabel = (payload && payload.generatedAt) ? ('스냅샷 ' + fmtDate(payload.generatedAt)) : '';

      // P2-6: 고정 1100ms 타이머 race 제거 — 재조회 완료 시점에 결정론적으로 전환.
      const next = resolveScanReloadView(payload);
      if (next.empty) {
        store.raw = []; store.viewModels = [];
        await refreshConfig(); // 루트 표시 갱신
      } else {
        store.raw = payload.projects;
        store.viewModels = payload.projects.map(toViewModel);
      }
      // scanning(스캔 done) 또는 dashboard/firstRun(메뉴 새로고침)에서만 결과 뷰로 전환.
      // 그 외(error/loading 등)는 현 뷰 유지 — 사용자 컨텍스트 보존.
      const v = store.state.view;
      if (v === 'scanning' || v === 'dashboard' || v === 'firstRun') store.state.view = next.view;
      store.scan.ownScanId = null; // P2-3 보강: 잔여 구독 재진입 차단(전환 완료 후 리셋)
      render();
    } catch (err) {
      toast('스캔은 끝났지만 결과를 불러오지 못했습니다: ' + (err && err.message ? err.message : '오류'), true);
    }
  }

  /* =====================================================================
   * P2-1: 네이티브 메뉴 구독 (spip.onMenu → 액션 디스패치)
   *   menu.js/main.js 가 보내는 spip:menu:* 가 preload 에서 onMenu(cb) 로 합쳐져
   *   cb({action}) 로 도착한다. dispatchMenuAction 으로 핸들러를 결정해 실행한다.
   *   onMenu 부재(웹/테스트) 시 graceful — 구독 생략.
   * ===================================================================== */
  function subscribeMenu() {
    unsubscribeMenu();
    if (!hasBridge() || typeof spip.onMenu !== 'function') return; // graceful
    const unsub = spip.onMenu((msg) => onMenuCommand(msg));
    store.menuUnsubscribe = (typeof unsub === 'function') ? unsub : null;
  }
  function unsubscribeMenu() {
    if (typeof store.menuUnsubscribe === 'function') {
      try { store.menuUnsubscribe(); } catch (_) { /* ignore */ }
    }
    store.menuUnsubscribe = null;
  }
  /** onMenu 콜백 본체 — action 토큰을 핸들러로 디스패치(매핑은 순수 dispatchMenuAction). */
  function onMenuCommand(msg) {
    const { handler } = dispatchMenuAction(msg);
    switch (handler) {
      case 'pickFolders': onPickFolders(); break;          // 폴더 선택 흐름
      case 'rescan':      triggerRescan('dashboard'); break;
      case 'refresh':     refreshDashboard(); break;        // getProjects/getStats 재조회
      case 'about':       showAbout(); break;
      default: /* 알 수 없는 action — graceful 무시 */ break;
    }
  }

  /* =====================================================================
   * 자동 업데이트 진행 구독 (spip.onUpdateStatus → store.update 반영 → 설정 열려있으면 재렌더)
   *   main(autoUpdate.js)이 보내는 'spip:update:status' 를 받아 실시간 갱신. 부재 시 graceful.
   * ===================================================================== */
  function subscribeUpdateStatus() {
    unsubscribeUpdateStatus();
    if (!hasBridge() || typeof spip.onUpdateStatus !== 'function') return; // graceful
    const unsub = spip.onUpdateStatus((payload) => {
      applyUpdateStatusPayload(payload);
      if (store.showSettings) render();
    });
    store.update.unsubscribe = (typeof unsub === 'function') ? unsub : null;
  }
  function unsubscribeUpdateStatus() {
    if (typeof store.update.unsubscribe === 'function') {
      try { store.update.unsubscribe(); } catch (_) { /* ignore */ }
    }
    store.update.unsubscribe = null;
  }

  /** 메뉴 '새로고침' — 진행 중 스캔이 없을 때 대시보드 데이터 재조회(getProjects/getStats). */
  async function refreshDashboard() {
    if (store.state.view === 'scanning') return; // 스캔 중엔 push 가 갱신
    await reloadAfterScan();
  }

  /* =====================================================================
   * R-21: 트레이 push 구독 (spip.onTray → dashboard|favorites 디스패치)
   *   main 이 트레이 메뉴 클릭 시 win.show() 후 {action} push. 부재(웹/테스트) graceful.
   * ===================================================================== */
  function subscribeTray() {
    unsubscribeTray();
    if (!hasBridge() || typeof spip.onTray !== 'function') return; // graceful
    const unsub = spip.onTray((msg) => onTrayCommand(msg));
    store.trayUnsubscribe = (typeof unsub === 'function') ? unsub : null;
  }
  function unsubscribeTray() {
    if (typeof store.trayUnsubscribe === 'function') {
      try { store.trayUnsubscribe(); } catch (_) { /* ignore */ }
    }
    store.trayUnsubscribe = null;
  }

  /* =====================================================================
   * R-24: 상태 주시(라이브 갱신) 구독 — spip.onProjectsUpdated → git·freshness 병합
   *   main 의 StateWatcher 가 재스캔 없이 주기 재수집한 변경분을 push 한다.
   *   payload: { projects:[<§8.1 project(갱신분)>] }. 부재(웹/테스트) graceful.
   * ===================================================================== */
  function subscribeProjectsUpdated() {
    unsubscribeProjectsUpdated();
    if (!hasBridge() || typeof spip.onProjectsUpdated !== 'function') return; // graceful
    const unsub = spip.onProjectsUpdated((payload) => applyProjectsUpdate(payload));
    store.projectsUpdatedUnsubscribe = (typeof unsub === 'function') ? unsub : null;
  }
  function unsubscribeProjectsUpdated() {
    if (typeof store.projectsUpdatedUnsubscribe === 'function') {
      try { store.projectsUpdatedUnsubscribe(); } catch (_) { /* ignore */ }
    }
    store.projectsUpdatedUnsubscribe = null;
  }
  /**
   * 라이브 갱신 병합. 변경된 project(들)를 store.raw/viewModels 에 id 로 교체하고 재렌더한다.
   *   - 식별/구조 필드는 watcher 가 건드리지 않으므로 toViewModel 로 전체 재매핑해도 안전.
   *   - stale KPI 는 freshness 변동을 반영하도록 로컬 재계산.
   *   - 드래그 중이면 데이터만 병합하고 렌더는 보류(드래그 종료 후 자연 렌더에 반영) — DnD 파손 방지.
   *   - 대시보드 뷰에서만 렌더(스캐닝/설정 등 컨텍스트 보존).
   */
  function applyProjectsUpdate(payload) {
    if (!payload || typeof payload !== 'object' || !Array.isArray(payload.projects)) return;
    const ups = payload.projects.filter((p) => p && typeof p === 'object' && typeof p.id === 'string');
    if (!ups.length) return;
    if (!Array.isArray(store.raw)) store.raw = [];
    if (!Array.isArray(store.viewModels)) store.viewModels = [];
    let changed = false;
    for (const up of ups) {
      const ri = store.raw.findIndex((p) => p && p.id === up.id);
      if (ri < 0) continue; // 현재 스냅샷에 없는 id(재스캔으로 교체 등) — 무시
      store.raw[ri] = up;
      const vi = store.viewModels.findIndex((v) => v && v.id === up.id);
      const vm = toViewModel(up);
      if (vi >= 0) store.viewModels[vi] = vm; else store.viewModels.push(vm);
      changed = true;
    }
    if (!changed) return;
    // stale KPI 로컬 보정(freshness 변동 반영).
    if (store.stats && typeof store.stats === 'object') {
      store.stats.staleCount = store.viewModels.filter((v) => v && v.isStale).length;
    }
    // 대시보드 뷰 + 비드래그 + 오버레이(설정/도움말/드로어) 미개방일 때만 재렌더.
    //   오버레이가 열려 있으면 데이터만 병합하고 렌더는 보류 — 모달 깜빡임/포커스·스크롤 손실 방지.
    //   (오버레이가 닫힐 때 자연 렌더로 최신 데이터 반영.)
    const overlayOpen = store.showSettings || store.showHelp || store.state.selectedId;
    if (store.state.view === 'dashboard' && !store._dragging && !overlayOpen) render();
  }
  /** onTray 콜백 본체 — action 토큰 디스패치(매핑은 순수 dispatchTrayAction).
   *  [M7 §8.1·R4] 'favorites' 분기 제거 — 트레이 '즐겨찾기'는 main 이 위젯 창을 직접 열고
   *  메인창에 push 하지 않는다. onTray 는 'dashboard'(대시보드 포커스)만 수신한다. */
  function onTrayCommand(msg) {
    const { handler } = dispatchTrayAction(msg);
    if (handler === 'dashboard') {
      // 대시보드 포커스/표시
      if (store.state.view !== 'dashboard' && store.viewModels.length) store.state.view = 'dashboard';
      render();
    }
    // 그 외 — graceful 무시
  }

  /** 메뉴 '정보' — 간단한 정보 토스트(L-1: textContent). */
  /* =====================================================================
   * #6 도움말 팝업 — 프로젝트 인식 패턴 + 각 항목(설명·언어·변경일자·Git·크기 등) 산출 기준 설명.
   * ===================================================================== */
  function showAbout() { openHelp(); } // 메뉴 '정보'·헤더 '도움말' 공용 진입점.

  function openHelp() {
    store._helpOpener = (typeof document !== 'undefined') ? document.activeElement : null;
    store.showHelp = true;
    render();
  }
  function closeHelp() {
    store.showHelp = false;
    store._helpShown = false; // 다음 열림에 진입 애니메이션 재적용
    const opener = store._helpOpener;
    store._helpOpener = null;
    render();
    if (opener && typeof opener.focus === 'function' && document.contains(opener)) {
      try { opener.focus(); } catch (_) { /* ignore */ }
    }
  }

  /** 도움말 항목 한 줄(용어 + 설명). */
  function helpRow(term, desc) {
    return el('div', { cls: 'help__row', children: [
      el('div', { cls: 'help__term', text: term }),
      el('div', { cls: 'help__desc', text: desc }),
    ]});
  }
  /** 도움말 섹션(제목 + 행들). */
  function helpSection(title, rows) {
    return el('div', { cls: 'insight', children: [
      el('div', { cls: 'insight__title', text: title }),
      el('div', { cls: 'help__list', children: rows }),
    ]});
  }

  function renderHelp() {
    const ver = (store.update && store.update.currentVersion) ? ('v' + store.update.currentVersion) : '';

    // 1) 프로젝트 인식 기준
    const detect = helpSection('프로젝트로 인식하는 기준', [
      el('p', { cls: 'help__lead', text: '폴더 안에 아래 “신호” 파일/폴더가 하나라도 있으면 프로젝트로 봅니다. 중첩된 경우 가장 바깥 프로젝트 하나만 셉니다.' }),
      helpRow('.git', 'Git 저장소'),
      helpRow('package.json', 'Node.js / 프런트엔드'),
      helpRow('.vscode · *.code-workspace', 'VS Code 작업공간'),
      helpRow('pyproject.toml', 'Python'),
      helpRow('Cargo.toml', 'Rust'),
      helpRow('go.mod', 'Go'),
      helpRow('pom.xml · build.gradle', 'Java'),
      helpRow('composer.json', 'PHP'),
      helpRow('Gemfile', 'Ruby'),
      helpRow('*.csproj · *.sln', '.NET'),
      el('p', { cls: 'help__note', text: '제외: node_modules · .git · dist · build · out · .cache · target · vendor · venv 등 빌드/캐시 폴더와 OS 시스템 폴더는 스캔하지 않습니다. 설정의 “제외 항목”으로 더 추가할 수 있습니다.' }),
    ]);

    // 2) 각 항목 산출 기준
    const fields = helpSection('각 항목은 어떻게 정해지나', [
      helpRow('이름', 'package.json의 name이 있으면 그 값을, 없으면 폴더 이름을 씁니다.'),
      helpRow('설명', 'package.json의 description을 그대로 표시합니다. 없으면 “설명 없음”.'),
      helpRow('언어/스택', '의존성(React·Vue·Next 등)을 우선 보고, 없으면 폴더 안 파일 확장자 비율로 대표 언어를 정합니다.'),
      helpRow('변경일자(최종 수정)', '폴더 내 파일들의 최신 수정시각과 최근 커밋 시각 중 더 최근 값입니다.'),
      helpRow('방치(stale)', '최종 활동(수정/커밋)이 기준일(기본 90일)보다 오래되면 “방치”로 표시합니다. 기준일은 설정에서 바꿀 수 있습니다.'),
      helpRow('Git 상태', 'Git 저장소면 브랜치·미커밋 변경(미커밋)·미푸시(ahead)를 표시합니다. 저장소가 아니거나 Git이 없으면 “Git 아님”.'),
      helpRow('크기/의존성', '의존성 개수는 항상 표시합니다. 디렉터리 용량·node_modules 크기는 설정에서 “용량 수집”을 켰을 때만 측정합니다(미측정이면 “미측정”).'),
    ]);

    // 3) 앱 정보
    const about = helpSection('Project-SPIP', [
      el('p', { cls: 'help__lead', text: 'PC에 흩어진 VS Code 프로젝트를 스캔해 한눈에 보여주는 로컬 데스크톱 앱입니다. 모든 처리는 이 PC에서만 일어나며 외부로 데이터를 전송하지 않습니다.' }),
      ver ? helpRow('버전', ver) : null,
    ]);

    const enter = !store._helpShown; store._helpShown = true; // 진입 애니메이션 1회만
    return buildModal({
      titleId: 'help-title',
      title: '도움말',
      subtitle: '스캔 기준과 각 항목의 의미',
      onClose: closeHelp,
      wide: true,
      enter,
      bodyChildren: [detect, fields, about],
    });
  }

  /** R-12: spip.open(id). 연타 방지(opening map). */
  async function openProject(id) {
    if (!id || store.state.opening[id]) return;
    store.state.opening[id] = true;
    render();
    try {
      const data = await ipc('open', id);
      if (data && data.ok) toast('VS Code에서 여는 중');
      else if (data && data.code === 'CODE_CLI_NOT_FOUND') {
        // R-18: code 미발견 → 설정에서 경로 지정 안내(액션 토스트 + 설정 열기 유도)
        toastWithAction('VS Code를 찾을 수 없습니다. 설정 > 외부 툴에서 실행 파일 경로를 지정하세요.', '설정 열기', () => openSettings());
      } else toast(describeError(data), true);
    } finally {
      setTimeout(() => { delete store.state.opening[id]; render(); }, 800);
    }
  }

  /* =====================================================================
   * R-17: 경로 복사 (main clipboard.writeText — navigator.clipboard 미사용)
   * ===================================================================== */
  async function copyPath(path) {
    const text = buildCopyText(path);
    if (!text) { toast('복사할 경로가 없습니다.', true); return; }
    if (!bridgeHas('copyText')) { toast('이 환경에서는 복사를 사용할 수 없습니다.', true); return; }
    const res = await ipc('copyText', text);
    if (res && res.ok) toast('경로를 복사했습니다.');
    else if (res && res.code === 'INVALID_TEXT') toast('경로가 너무 길어 복사하지 못했습니다.', true);
    else toast('경로를 복사하지 못했습니다.', true);
  }

  /* =====================================================================
   * R-20: 즐겨찾기 토글 (낙관적 메모리 반영 → setFavorite 영속)
   * ===================================================================== */
  async function setFavorite(id, on) {
    if (!id) return;
    // 낙관적: 메모리 즉시 반영
    store.state.favorites = toggleFavorite(store.state.favorites, id, on);
    render();
    if (!bridgeHas('setFavorite')) return; // 웹/테스트 graceful
    const res = await ipc('setFavorite', id, on);
    if (res && res.ok && Array.isArray(res.favorites)) {
      store.state.favorites = res.favorites.filter((x) => typeof x === 'string');
      render();
    } else if (res && res.ok === false) {
      toast('즐겨찾기 저장에 실패했습니다.', true);
    }
  }

  /* =====================================================================
   * R-19: 드래그/키보드 reorder (자동 manual 전환 → setOrder 영속)
   * ===================================================================== */
  /** sortMode 전이 적용(reorder|sortSelect). 변경 시 setSortMode 영속. */
  function applySortMode(trigger) {
    const r = nextSortMode(store.state.sortMode, trigger);
    if (!r.changed) { store.state.sortMode = r.sortMode; return; }
    store.state.sortMode = r.sortMode;
    if (bridgeHas('setSortMode')) {
      ipc('setSortMode', r.sortMode).then((res) => {
        if (res && res.ok && (res.sortMode === 'auto' || res.sortMode === 'manual')) {
          store.state.sortMode = res.sortMode;
        }
      });
    }
  }

  /**
   * 재배열 결과 영속. 현재 표시 목록이 부분집합(필터/즐겨찾기)일 수 있으므로,
   *   전체 order 를 "새 표시순서 → 표시목록 밖 기존 항목" 으로 재구성해 저장한다(누락 방지).
   */
  function commitReorder(newDisplayIds) {
    // 전체 order 기준선: 기존 order + 스냅샷의 모든 id(누락 보강)
    const allIds = store.viewModels.map((vm) => vm.id).filter((x) => typeof x === 'string');
    const displaySet = new Set(newDisplayIds);
    // 새 전체 순서: 표시목록은 새 순서, 그 외는 기존 상대 순서 유지
    const base = (store.state.order && store.state.order.length) ? store.state.order.slice() : allIds.slice();
    const rest = base.filter((id) => allIds.includes(id) && !displaySet.has(id));
    const merged = newDisplayIds.concat(rest);
    // allIds 중 어디에도 없는(신규) 항목 뒤 append
    for (const id of allIds) if (!merged.includes(id)) merged.push(id);
    // [R-23] render() 전후 카드 위치를 FLIP 으로 보간(카드뷰만). state 변경 + render 를
    //   flipReorder(mutate) 로 위임 — capture(First) → mutate(Last) → invert → rAF play.
    //   sortMode 도 mutate 내부에서 manual 로 설정해 capture 시점(First)과 정합 유지.
    flipReorder(() => {
      store.state.sortMode = 'manual';
      store.state.order = merged;
      // [P2-3] 영속은 아래 setOrder 가 manual 을 동반하므로 별도 setSortMode IPC 미호출(중복 제거).
      render();
    });
    if (!bridgeHas('setOrder')) return; // 웹/테스트 graceful
    ipc('setOrder', merged).then((res) => {
      if (res && res.ok) {
        if (Array.isArray(res.order)) store.state.order = res.order.filter((x) => typeof x === 'string');
        if (res.sortMode === 'manual') store.state.sortMode = 'manual';
        render();
      } else if (res && res.ok === false) {
        toast('순서 저장에 실패했습니다.', true);
      }
    });
  }

  /* =====================================================================
   * [M8] SortableJS 드래그 재정렬 (placeholder 라이브 프리뷰)
   *   .cards 컨테이너에 Sortable 인스턴스를 부착 → 드래그 중 placeholder(ghost)로 드롭 위치를
   *   미리 보여주고 형제 카드를 실시간 시프트한다. 드롭(onEnd) 시 현재 DOM 의 id 순서를 읽어
   *   commitReorder 로 manual 전환 + setOrder 영속(키보드 이동과 동일 경로 재사용).
   *   - CSP: ./vendor/Sortable.min.js('self')로 로드(window.Sortable). 부재 시 graceful(키보드 이동만).
   *   - 인터랙티브 컨트롤(버튼/링크/입력)에서 시작하는 드래그는 filter 로 차단(클릭 보존).
   *   - prefers-reduced-motion 시 애니메이션 0.
   * ===================================================================== */
  let cardSortable = null;
  function destroyCardSortable() {
    if (cardSortable && typeof cardSortable.destroy === 'function') {
      try { cardSortable.destroy(); } catch (_) { /* ignore */ }
    }
    cardSortable = null;
  }
  function initCardSortable() {
    destroyCardSortable();
    if (typeof document === 'undefined') return;
    const Sortable = (typeof window !== 'undefined') ? window.Sortable : null;
    if (!Sortable || typeof Sortable.create !== 'function') return; // 라이브러리 부재 — 키보드 이동만
    const grid = document.querySelector('.cards');
    if (!grid) return; // 표 밀도/무결과 — 카드 컨테이너 없음
    cardSortable = Sortable.create(grid, {
      draggable: '.card',
      // 버튼/링크/입력에서 시작하는 포인터다운은 드래그로 잡지 않음(클릭 동작 보존).
      filter: 'button, a, input, select, textarea, .fav-btn, .btn, .move-btn',
      preventOnFilter: false,
      animation: prefersReducedMotion() ? 0 : 160,
      easing: 'cubic-bezier(.2,.8,.2,1)',
      ghostClass: 'card--ghost',    // placeholder(드롭 위치 미리보기)
      chosenClass: 'card--chosen',  // 선택된 원본 카드
      dragClass: 'card--drag',      // 따라다니는 드래그 클론(fallback)
      fallbackTolerance: 4,
      // [R-24] 드래그 동안은 라이브 갱신 재렌더를 보류해 DnD 파손을 막는다.
      onStart: () => { store._dragging = true; },
      onEnd: (evt) => {
        store._dragging = false;
        if (!evt || evt.oldIndex === evt.newIndex) return; // 위치 동일 — 무시
        const grid2 = evt.to || grid;
        const newIds = Array.prototype.slice.call(grid2.querySelectorAll('[data-card-id]'))
          .map((n) => (n.dataset && n.dataset.cardId) || '')
          .filter((x) => typeof x === 'string' && x);
        if (!newIds.length) return;
        // onEnd 실행 중 render()가 이 Sortable 인스턴스를 destroy 하지 않도록 마이크로태스크로 지연.
        Promise.resolve().then(() => commitReorder(newIds));
      },
    });
  }

  /* =====================================================================
   * 폴더/루트 관리 액션 (Electron 신규)
   * ===================================================================== */

  /**
   * R-19/20/21: getUiState() 로 초기 favorites/order/sortMode 적재(graceful).
   *   부재(웹/테스트) 시 기본값 유지. 적재 후 슬라이더 인덱스 보정.
   */
  async function loadUiState() {
    if (!bridgeHas('getUiState')) return;
    const res = await ipc('getUiState');
    const uv = uiStateView(res && res.ok !== false ? res : null);
    store.state.favorites = uv.favorites;
    store.state.order = uv.order;
    store.state.sortMode = uv.sortMode;
  }

  /** getConfig() 동기화 → store.config / store.roots 갱신 후 재렌더. */
  async function refreshConfig() {
    const cfg = await ipc('getConfig');
    if (cfg && cfg.ok !== false) {
      store.config = cfg;
      const cv = configView(cfg);
      store.roots = cv.scanRoots;
      store.excludes = cv.excludes; // #4
      if (!cv.allowAllDrives) store.opts.allDrives = false; // 게이트 강등
    }
    render();
  }

  /* =====================================================================
   * R-18: 외부 툴 경로 액션 (getTools / setToolPath / pickToolExecutable)
   * ===================================================================== */
  /** getTools() 동기화 → store.tools 갱신 후 재렌더(설정 드로어 오픈 시). */
  async function refreshTools() {
    if (!bridgeHas('getTools')) { store.tools = []; return; }
    const res = await ipc('getTools');
    if (res && res.ok && Array.isArray(res.tools)) {
      store.tools = res.tools;
    }
    render();
  }

  /** 단일 툴 응답({ok,tool}) → store.tools 갱신(해당 id 항목 교체/삽입). */
  function applyToolUpdate(res) {
    if (!res || res.ok !== true || !res.tool || typeof res.tool !== 'object') return false;
    const t = res.tool;
    const next = (Array.isArray(store.tools) ? store.tools : []).slice();
    const i = next.findIndex((x) => x && x.id === t.id);
    if (i >= 0) next[i] = t; else next.push(t);
    store.tools = next;
    if (typeof t.id === 'string') store.toolPathInput[t.id] = (typeof t.path === 'string') ? t.path : '';
    return true;
  }

  /** 경로 직접 입력 저장(setToolPath). 빈 입력은 지정 해제(null)로 처리. */
  async function onSetToolPath(id) {
    if (store.busyTools || !bridgeHas('setToolPath')) return;
    const raw = (typeof store.toolPathInput[id] === 'string') ? store.toolPathInput[id].trim() : '';
    const path = raw.length ? raw : null;
    store.busyTools = true;
    render();
    const res = await ipc('setToolPath', id, path);
    store.busyTools = false;
    if (applyToolUpdate(res)) toast(path ? '실행 파일 경로를 저장했습니다.' : '경로 지정을 해제했습니다.');
    else toast(describeToolError(res), true);
    render();
  }

  /** 경로 지정 해제(setToolPath(id, null)). */
  async function onClearToolPath(id) {
    if (store.busyTools || !bridgeHas('setToolPath')) return;
    store.busyTools = true;
    render();
    const res = await ipc('setToolPath', id, null);
    store.busyTools = false;
    if (applyToolUpdate(res)) { store.toolPathInput[id] = ''; toast('경로 지정을 해제했습니다.'); }
    else toast(describeToolError(res), true);
    render();
  }

  /** 네이티브 dialog 로 실행 파일 선택(pickToolExecutable). main 재검증 후 저장. */
  async function onPickToolExecutable(id) {
    if (store.busyTools || !bridgeHas('pickToolExecutable')) return;
    store.busyTools = true;
    render();
    const res = await ipc('pickToolExecutable', id);
    store.busyTools = false;
    if (applyToolUpdate(res)) toast('실행 파일을 지정했습니다.');
    else if (res && res.code === 'CANCELLED') { /* 취소 — 조용히 */ }
    else toast(describeToolError(res), true);
    render();
  }

  /** 네이티브 폴더 선택(pickFolders) → 채택/거부 표시 + 루트 갱신. */
  async function onPickFolders() {
    if (store.busyFolders) return;
    store.busyFolders = true;
    render();
    const res = await ipc('pickFolders');
    store.busyFolders = false;
    applyAddResult(res);
  }

  /** 경로 직접 입력(addRoots) → 채택/거부 표시 + 루트 갱신. */
  async function onAddRoot() {
    if (store.busyFolders) return;
    const paths = parseRootInput(store.rootInput);
    if (paths.length === 0) { toast('추가할 경로를 입력하세요.', true); return; }
    store.busyFolders = true;
    render();
    const res = await ipc('addRoots', paths);
    store.busyFolders = false;
    if (res && res.ok) store.rootInput = ''; // 성공 시 입력 비움
    applyAddResult(res);
  }

  /** addRoots/pickFolders 결과 공통 처리. */
  function applyAddResult(res) {
    const sum = summarizeAddResult(res);
    if (sum.ok) {
      store.roots = sum.roots;
      store.lastRejected = sum.rejected;
      toast(sum.message, sum.kind === 'none');
    } else if (sum.kind === 'cancelled') {
      store.lastRejected = [];
      // 취소는 조용히(토스트 생략 가능하나 안내)
    } else {
      store.lastRejected = [];
      toast(sum.message, true);
    }
    render();
  }

  /** 루트 삭제(removeRoot). */
  async function onRemoveRoot(path) {
    if (store.busyFolders) return;
    store.busyFolders = true;
    render();
    const res = await ipc('removeRoot', path);
    store.busyFolders = false;
    if (res && res.ok && Array.isArray(res.roots)) {
      store.roots = res.roots.filter((p) => typeof p === 'string');
      store.lastRejected = [];
      toast('폴더를 제거했습니다.');
    } else {
      toast(describeError(res), true);
    }
    render();
  }

  let toastTimer = null;
  function toast(message, isError) {
    toastEl.replaceChildren();
    toastEl.textContent = message; // L-1: 서버 유래 일부 포함 가능 → textContent
    toastEl.className = 'toast' + (isError ? ' toast--error' : '');
    toastEl.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.hidden = true; }, 3500);
  }

  /** 액션 링크가 포함된 토스트(예: CODE_CLI_NOT_FOUND → '설정 열기'). 키보드 도달 버튼. */
  function toastWithAction(message, actionLabel, onAction) {
    toastEl.replaceChildren();
    toastEl.appendChild(el('span', { text: message })); // L-1
    if (actionLabel && typeof onAction === 'function') {
      toastEl.appendChild(el('button', {
        cls: 'toast__action', text: actionLabel,
        attrs: { type: 'button' },
        on: { click: () => { toastEl.hidden = true; onAction(); } },
      }));
    }
    toastEl.className = 'toast toast--error';
    toastEl.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.hidden = true; }, 6000);
  }

  /* =====================================================================
   * R-23: 카드 reorder FLIP 애니메이션 (렌더러 전용 — IPC·보안 무관)
   *   현 reorder 는 render() 가 카드 DOM 을 전부 재구성(노드 교체)하므로 카드가 점프한다.
   *   FLIP(First-Last-Invert-Play): mutate(=render) 전후의 [data-card-id] 별 rect 를
   *   실측 캐시 → invert(transform) → rAF 로 play(180ms). 키는 기존 dataset.cardId(R3).
   *   prefers-reduced-motion 존중(필수): 모션 비활성 시 transition 생략하고 즉시 적용.
   *   적용 범위는 .cards(카드뷰)만 — table 밀도는 reorder 트리거 자체가 없음(R5).
   * ===================================================================== */
  function captureCardRects() {
    const map = new Map();
    if (typeof document === 'undefined') return map;
    const nodes = document.querySelectorAll('.cards [data-card-id]');
    for (const n of nodes) {
      const id = n.dataset && n.dataset.cardId;
      if (!id) continue;
      if (n.classList && n.classList.contains('is-dragging')) continue; // 드래그 중 카드는 네이티브 DnD 가 추종
      map.set(id, n.getBoundingClientRect());
    }
    return map;
  }
  function prefersReducedMotion() {
    return !!(typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }
  /**
   * mutate() (= order 변경 + render) 전후의 카드 위치차를 FLIP 으로 보간한다.
   * 좌표 diff 산출은 순수 computeFlip 으로 위임(테스트 대상). play 는 DOM transform.
   */
  function flipReorder(mutate) {
    const reduce = prefersReducedMotion();
    const first = reduce ? new Map() : captureCardRects();
    mutate();                                   // Last: order 변경 + render()
    if (reduce) return;                          // 모션 민감 사용자 — 즉시 적용(전이 0)
    if (typeof document === 'undefined' || typeof requestAnimationFrame !== 'function') return;
    const last = new Map();
    const nodeById = new Map();
    for (const n of document.querySelectorAll('.cards [data-card-id]')) {
      const id = n.dataset && n.dataset.cardId;
      if (!id) continue;
      last.set(id, n.getBoundingClientRect());
      nodeById.set(id, n);
    }
    const diffs = computeFlip(first, last, false);
    for (const { id, dx, dy } of diffs) {
      const n = nodeById.get(id);
      if (!n) continue;
      n.style.transition = 'none';                // Invert
      n.style.transform = 'translate(' + dx + 'px,' + dy + 'px)';
    }
    if (!diffs.length) return;
    requestAnimationFrame(() => {                 // Play
      for (const { id } of diffs) {
        const n = nodeById.get(id);
        if (!n) continue;
        n.style.transition = 'transform 180ms cubic-bezier(.2,.8,.2,1)';
        n.style.transform = '';
      }
    });
  }

  function debounce(fn, ms) {
    let t = null;
    return function (...args) { if (t) clearTimeout(t); t = setTimeout(() => fn.apply(this, args), ms); };
  }

  /* =====================================================================
   * 데이터 로드 (단일 출처, 1회 fetch)
   * ===================================================================== */
  async function load() {
    store.state.view = 'loading';
    store.state.selectedId = null;
    store.showSettings = false;
    render();

    if (!hasBridge()) {
      store._errorMsg = 'Electron 환경에서만 동작합니다. (window.spip 브리지를 찾을 수 없습니다)';
      store.state.view = 'error';
      render();
      return;
    }

    try {
      const payload = await ipc('getProjects');
      if (payload && payload.ok === false) throw new Error(describeError(payload));
      const stats = await ipc('getStats');
      store.stats = (stats && stats.ok !== false) ? stats : null;
      store.now = new Date();

      store._snapshotLabel = (payload && payload.generatedAt)
        ? ('스냅샷 ' + fmtDate(payload.generatedAt))
        : '';

      if (isEmptySnapshot(payload)) {
        store.raw = [];
        store.viewModels = [];
        await refreshConfig(); // firstRun 의 루트 목록 표시용
        store.state.view = 'firstRun';
        render();
        return;
      }

      store.raw = payload.projects;
      store.viewModels = payload.projects.map(toViewModel);
      store.state.view = 'dashboard';
      // 설정 패널/재스캔에서 쓸 config 를 비동기로 미리 적재(렌더 비블로킹)
      ipc('getConfig').then((cfg) => {
        if (cfg && cfg.ok !== false) {
          store.config = cfg;
          store.roots = configView(cfg).scanRoots;
        }
      });
      // R-19/20/21: UI 상태(favorites/order/sortMode) 적재 후 재렌더(비블로킹)
      loadUiState().then(() => { if (store.state.view === 'dashboard') render(); });
      render();
    } catch (err) {
      store._errorMsg = '데이터를 불러오지 못했습니다. (' + (err && err.message ? err.message : '오류') + ')';
      store.state.view = 'error';
      render();
    }
  }

  // 전역 ESC로 드로어/설정 닫기(접근성)
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (store.showHelp) { closeHelp(); return; }
    if (store.state.selectedId) { closeDrawer(); return; }
    if (store.showSettings) { closeSettings(); return; }
    if (store.state.view === 'orbit' && orb.menu) { orb.menu = null; render(); return; }
    if (store.state.view === 'orbit') { exitOrbit(); }
  });

  // P2-1: 네이티브 메뉴 구독(앱 1회). 부재 시 graceful — subscribeMenu 내부 가드.
  subscribeMenu();
  // R-21: 트레이 push 구독(앱 1회). 부재 시 graceful — subscribeTray 내부 가드.
  subscribeTray();
  // R-24: 상태 주시 라이브 갱신 구독(앱 1회). 부재 시 graceful — 내부 가드.
  subscribeProjectsUpdated();
  // 자동 업데이트 진행 구독(앱 1회). 부재 시 graceful — 내부 가드.
  subscribeUpdateStatus();

  // teardown: 창 unload 시 구독 해제(누수 방지 — 메뉴·진행·트레이·주시·업데이트 구독 모두).
  function teardown() {
    unsubscribeMenu();
    unsubscribeScan();
    unsubscribeTray();
    unsubscribeProjectsUpdated();
    unsubscribeUpdateStatus();
    stopOrbit(); // 궤도 캔버스 RAF·리스너 정리
  }
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('pagehide', teardown);
    window.addEventListener('beforeunload', teardown);
  }

  load();
}

/* =====================================================================
 * 환경 분기
 * ===================================================================== */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    toViewModel,
    describeError,
    matchesSearch,
    matchesFilters,
    gitKeys,
    applyQuery,
    sortViewModels,
    canSortBySize,
    deriveStats,
    isEmptySnapshot,
    languageFacets,
    gitFacetCounts,
    gitChangeCounts,
    langPercents,
    langColor,
    relTime,
    fmtDate,
    sizeLabel,
    // M4 추가
    sizeStatusLabel,
    sumTotalBytes,
    sumNodeModulesBytes,
    progressView,
    progressTitle,
    fmtCount,
    fmtElapsed,
    classifyRescan,
    // Electron 적응 추가
    describeRejectReason,
    dispatchMenuAction,
    resolveScanReloadView,
    nextScanAction,
    sanitizeRescanOpts,
    configView,
    parseRootInput,
    summarizeAddResult,
    // M6 (R-17~R-21) 순수 로직
    buildCopyText,
    toolView,
    toolViews,
    toolStatusLabel,
    describeToolError,
    toggleFavorite,
    isFavorite,
    applyOrder,
    moveInOrder,
    nextSortMode,
    nextSlideIndex,
    favoriteViewModels,
    matchesFavoritesFilter,
    dispatchTrayAction,
    uiStateView,
    // M7 (R-22/R-23) 순수 로직
    computeFlip,
    focusGate,
    favoritesChangedView,
  };
} else if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initBrowser);
  } else {
    initBrowser();
  }
}
