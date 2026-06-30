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
    changes: gitStatus === 'na' ? null : (typeof git.changes === 'number' ? git.changes : null),
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

/* =====================================================================
 * 홈(브리핑) 순수 뷰모델 — 보유 데이터(viewModels)만으로 산출(헤드리스 단위테스트, F-3).
 *   메일 다이제스트·할 일·생산성 차트는 후속 마일스톤(백엔드 동반)에서 합류.
 * ===================================================================== */

/** 시간대별 인사말. now(Date) 기준 — 5~11 아침 / 12~17 오후 / 18~22 저녁 / 그 외 늦은 밤. */
function homeGreeting(now) {
  const d = (now instanceof Date && !isNaN(now)) ? now : new Date();
  const h = d.getHours();
  let greeting;
  if (h >= 5 && h < 12) greeting = '좋은 아침이에요';
  else if (h >= 12 && h < 18) greeting = '좋은 오후예요';
  else if (h >= 18 && h < 23) greeting = '좋은 저녁이에요';
  else greeting = '늦은 밤이에요';
  return { greeting, hour: h };
}

/** 주의 필요 여부 — 미커밋(dirty)·방치(stale)·ahead/behind 중 하나라도. */
function isAttentionVm(vm) {
  if (!vm) return false;
  return vm.gitStatus === 'dirty' || vm.isStale === true
    || (typeof vm.ahead === 'number' && vm.ahead > 0)
    || (typeof vm.behind === 'number' && vm.behind > 0);
}

/** 브리핑 KPI 집계 — { total, attention, stale, dirty }. */
function homeKpis(viewModels) {
  const list = Array.isArray(viewModels) ? viewModels : [];
  let stale = 0, dirty = 0, attention = 0;
  for (const vm of list) {
    if (!vm) continue;
    if (vm.isStale === true) stale += 1;
    if (vm.gitStatus === 'dirty') dirty += 1;
    if (isAttentionVm(vm)) attention += 1;
  }
  return { total: list.length, attention, stale, dirty };
}

/** 주의 필요 프로젝트 상위 N — dirty>변경분>stale 우선, 그 안에서 최근 수정 내림차순. */
function homeAttention(viewModels, limit) {
  const list = Array.isArray(viewModels) ? viewModels : [];
  const flagged = list.filter(isAttentionVm);
  const score = (vm) => (vm.gitStatus === 'dirty' ? 4 : 0)
    + (((vm.ahead || 0) + (vm.behind || 0)) > 0 ? 2 : 0)
    + (vm.isStale ? 1 : 0);
  flagged.sort((a, b) => {
    const s = score(b) - score(a);
    if (s !== 0) return s;
    const ta = a.lastModified ? Date.parse(a.lastModified) : 0;
    const tb = b.lastModified ? Date.parse(b.lastModified) : 0;
    return (tb || 0) - (ta || 0);
  });
  const n = (typeof limit === 'number' && limit > 0) ? limit : 6;
  return flagged.slice(0, n);
}

/** 최근 활동(파일 수정) 타임라인 상위 N — lastModified 내림차순. */
function homeRecentActivity(viewModels, limit) {
  const list = Array.isArray(viewModels) ? viewModels : [];
  const events = [];
  for (const vm of list) {
    if (!vm || !vm.lastModified) continue;
    const ts = Date.parse(vm.lastModified);
    if (!Number.isFinite(ts)) continue;
    events.push({ id: vm.id, name: vm.name, when: vm.lastModified, ts, kind: 'modified' });
  }
  events.sort((a, b) => b.ts - a.ts);
  const n = (typeof limit === 'number' && limit > 0) ? limit : 8;
  return events.slice(0, n);
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
 * [R-29] 단축키 단일 출처(single source). 렌더러 keydown 디스패치·설정 안내표가 모두 이 상수를 참조한다.
 *   네이티브 메뉴 제거(R-28)로 메뉴 accelerator 가 사라지므로 단축키는 전부 렌더러 keydown 으로 처리.
 *   각 항목: { keys(표시·매칭), action(핸들러 토큰), label(한국어 설명) }.
 *   - Ctrl+O(폴더추가)·Ctrl+R(재스캔): 기존 메뉴 accelerator 를 keydown 으로 이관(동작 보존).
 *   - F5(새로고침): R-28 신설(메뉴 '보기>새로고침' 대체).
 *   - Esc(닫기): 기존 전역 ESC 동작을 안내표에 명문화(디스패치는 기존 ESC 핸들러가 담당).
 */
const SHORTCUTS = [
  { keys: 'Ctrl+O', action: 'pickFolders', label: '폴더 추가' },
  { keys: 'Ctrl+R', action: 'rescan',      label: '재스캔' },
  { keys: 'F5',     action: 'refresh',     label: '새로고침' },
  { keys: 'Esc',    action: 'close',       label: '닫기(드로어·모달·궤도)' },
];

/**
 * [R-29] keydown 이벤트 → SHORTCUTS action 토큰(순수, 헤드리스 테스트 대상).
 *   ev = { key, ctrlKey, metaKey } 형태(브라우저 KeyboardEvent 호환). Esc 는 별도 전역 핸들러가
 *   처리하므로 여기선 null(중복 디스패치 방지) — 안내표 표기 전용. 매칭 실패 시 null.
 *   Ctrl/Cmd(metaKey) 동등 취급(macOS CmdOrCtrl 관례). F5 는 수식키 없을 때만.
 */
function matchShortcut(ev) {
  if (!ev || typeof ev.key !== 'string') return null;
  const ctrl = !!(ev.ctrlKey || ev.metaKey);
  const key = ev.key;
  if (key === 'F5' && !ctrl && !ev.shiftKey && !ev.altKey) return 'refresh';
  if (ctrl && (key === 'o' || key === 'O')) return 'pickFolders';
  if (ctrl && (key === 'r' || key === 'R')) return 'rescan';
  return null; // Esc 등은 매칭 대상 아님(전역 ESC 핸들러 소관)
}

/**
 * [R-29/B-1] keydown 대상이 편집 가능 요소(input·textarea·select·contenteditable)인지 판정(순수).
 *   텍스트 입력 중 Ctrl+O/Ctrl+R 같은 단축키가 의도치 않게 발화하는 것을 막는 가드.
 *   el 은 { tagName, isContentEditable } 형태(DOM Element 호환). 비정상 입력은 false.
 */
function isEditableTarget(el) {
  if (!el || typeof el !== 'object') return false;
  if (el.isContentEditable === true) return true;
  const tag = (typeof el.tagName === 'string') ? el.tagName.toUpperCase() : '';
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

/**
 * [R-27] 헤더 뷰별 구성 판정(순수). 공통 골격(브랜드·탭·공통 액션)은 모든 뷰가 공유하고,
 *   뷰별 차이는 검색창 노출 하나로 최소화한다(Q5 확정: 검색은 프로젝트 대시보드 전용, 홈 미니멀).
 *   반환 { showSearch }  — showSearch=true 면 헤더에 검색창을 포함(view==='dashboard'에서만).
 */
function headerViewConfig(view) {
  return { showSearch: view === 'dashboard' };
}

/**
 * [R-30] 설정 2-pane 카테고리 단일 출처(순수 데이터). 좌측 목록·우측 패널 매핑이 이 배열을 참조한다.
 *   사용자 확정 5분류 — 스캔/연동/외관/단축키/정보. 각 카테고리의 sections 는 우측에 그릴
 *   render*Settings 함수의 식별 키(렌더러가 키→함수로 디스패치). 설계 §8 매핑표 그대로.
 */
const SETTINGS_CATEGORIES = [
  { id: 'scan',       label: '스캔',   sections: ['roots', 'exclude', 'detect', 'scanOptions'] },
  { id: 'integration', label: '연동',   sections: ['tools', 'mail', 'briefing'] },
  { id: 'appearance', label: '외관',   sections: ['theme'] },
  { id: 'shortcuts',  label: '단축키', sections: ['shortcuts'] },
  { id: 'info',       label: '정보',   sections: ['info', 'update'] },
];

/**
 * [R-30] 저장된 settingsTab 값을 유효 카테고리 id 로 정규화(순수). 미지정/미지값은 기본 'scan'.
 *   전체 재렌더 후에도 동일 카테고리를 복원하기 위해 호출측이 store.settingsTab 를 이 함수로 보정.
 */
function resolveSettingsTab(stored) {
  const ok = SETTINGS_CATEGORIES.some((c) => c.id === stored);
  return ok ? stored : 'scan';
}

/**
 * [R-31] 커밋 차트 5분 폴링 게이트(순수). 홈 뷰 + 창 가시 상태일 때만 폴링한다.
 *   홈 이탈/비가시(visible===false)면 false → 호출측이 타이머를 정지(홈 비활성 시 git 호출 0).
 *   visible 미지정(undefined)은 가시로 간주(visibilityState 미지원 환경 graceful).
 */
function shouldPollCommit(view, visible) {
  return view === 'home' && visible !== false;
}

/**
 * [R-32] 홈 섹션 화이트리스트(렌더러측). 메인 uiStateStore.HOME_SECTION_IDS 와 동형(고정 enum).
 *   배열 순서 = 기본 순서. renderHome 7섹션과 1:1. 보안 단일 신뢰 경계는 메인 normalizeHomeLayout —
 *   여기 검증은 UX 편의(드래그 DOM에서 읽은 data-id 필터링)일 뿐, 보안 의존 금지.
 */
// [SH-2] 즐겨찾기 셸프 위젯 2변형('shelf'=일반 컬럼, 'shelfWide'=전체폭 스팬)을 featureAdd 앞에 추가.
//   둘은 동일 셸프 데이터·로직 공유(폭만 다름)·둘 다 기본 숨김(메인 uiStateStore가 첫 실행 시 hiddenWidgets 시드).
const HOME_SECTION_IDS = ['attention', 'productivity', 'activity', 'todos', 'mail', 'disk', 'aiusage', 'shelf', 'shelfWide', 'featureAdd'];

// [위젯 추가/제거] 토글 가능한 콘텐츠 위젯 메타(갤러리·제거 UI용). 'featureAdd'는 추가 트리거라 제외(항상 표시).
//   메인 uiStateStore.TOGGLEABLE_WIDGET_IDS 와 동형(드리프트 0 — homeLayout-front 테스트가 교차검증).
const TOGGLEABLE_WIDGET_IDS = HOME_SECTION_IDS.filter((id) => id !== 'featureAdd');
const WIDGET_META = {
  attention: { name: '주의가 필요한 프로젝트', desc: '미커밋·미푸시·방치 프로젝트를 한눈에' },
  productivity: { name: '주간 생산성', desc: '커밋 빈도 차트와 언어·스택 추세' },
  activity: { name: '최근 활동 타임라인', desc: '최근 수정된 프로젝트 흐름' },
  todos: { name: '할 일', desc: '마감·알림이 있는 할 일 목록' },
  mail: { name: '메일', desc: '안 읽은 메일 다이제스트' },
  disk: { name: '디스크 회수', desc: '방치 프로젝트 node_modules 정리 후보' },
  aiusage: { name: '토큰 사용량', desc: 'Claude Code·연결 모델 토큰 추이' },
  shelf: { name: '즐겨찾기 셸프', desc: '사이트·폴더·파일을 한 셸프에서 즐겨찾기' },
  shelfWide: { name: '즐겨찾기 셸프 (와이드)', desc: '셸프를 전체폭으로 — 더 많은 즐겨찾기를 한눈에' },
};

/**
 * [R-32] 저장된 homeLayout → 렌더 순서로 정규화(순수). 메인 normalizeHomeLayout 과 동일 규칙:
 *   화이트리스트 외 제거·중복 제거·누락 섹션은 기본 순서로 끝에 보충 → 항상 7개 순열.
 *   메인이 단일 신뢰 경계지만, 렌더러도 동형 정규화로 부재/손상 응답에 graceful 대응.
 */
function applyHomeLayout(layout) {
  const out = [], seen = new Set();
  if (Array.isArray(layout)) for (const id of layout) {
    if (typeof id !== 'string' || !HOME_SECTION_IDS.includes(id) || seen.has(id)) continue;
    seen.add(id); out.push(id);
  }
  for (const id of HOME_SECTION_IDS) if (!seen.has(id)) out.push(id);
  return out;
}

/* =====================================================================
 * [SH-2] 즐겨찾기 셸프 위젯 — 순수 뷰모델/헬퍼(헤드리스 테스트 대상).
 *   표시 메타(name/title/sub/desc/color/mono/cat/status/bannerImage)는 main 이 ShelfBookmarkView 로
 *   완비해 내려주므로(api-contract §"즐겨찾기 셸프 위젯") 프론트는 레이아웃·상태 분기만 순수 계산한다.
 *   모든 표시 문자열은 렌더 시 textContent 전용(L-1). 배너는 data:URI <img> 또는 색 그라데이션 폴백.
 * ===================================================================== */

/** 스파인 폭(px) — 항목이 6개를 넘어가면 칸마다 3px 좁힘(최소 42). 초안 spineW 그대로. */
function shelfSpineW(n) {
  const count = (typeof n === 'number' && n >= 0) ? n : 0;
  return Math.max(42, 58 - Math.max(0, count - 6) * 3);
}
/** 펼친 카드가 3번째에 오도록 좌측에 스파인 2칸을 남기는 자동스크롤 lead(px). 초안 lead 그대로. */
function shelfLead(n) {
  return 2 * (shelfSpineW(n) + 6);
}
/** 입력 문자열 → 유형 자동 감지(url|folder|file|null). 초안 detectType 포팅(main 이 add 시 재확인). */
function shelfDetectType(raw) {
  const s = (raw == null ? '' : String(raw)).trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) return 'url';
  if (/^(\/|~|\.\.?\/|[a-zA-Z]:\\|\\\\)/.test(s)) {
    if (/[\/\\]$/.test(s)) return 'folder';
    return shelfHasExt(s) ? 'file' : 'folder';
  }
  if (/^[\w.-]+\.[a-z]{2,}([\/?#]|$)/i.test(s)) return 'url';
  return null;
}
function shelfLastSeg(p) {
  return (p == null ? '' : String(p)).replace(/[\/\\]+$/, '').split(/[\/\\]/).pop() || '';
}
function shelfHasExt(s) {
  return /\.[a-zA-Z0-9]{1,8}$/.test(shelfLastSeg(s));
}
function shelfHostOf(raw) {
  let s = (raw == null ? '' : String(raw)).trim();
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  try { return new URL(s).hostname.replace(/^www\./, ''); } catch (_) { return ''; }
}
/** 클라이언트측 1차 유효성(UX 가드 — 진짜 검증은 main). url=호스트 형태, folder/file=경로 구분자 포함. */
function shelfIsValidInput(type, raw) {
  const s = (raw == null ? '' : String(raw)).trim();
  if (type === 'url') { const h = shelfHostOf(s); return !!h && h.includes('.') && h.length > 3; }
  return s.length > 1 && /[\/\\]/.test(s);
}
/** add/open 실패 코드(고정 enum L-3) → 사용자 친화 한국어 메시지. url add 는 실제 크롤이라
 *  실패 시 BLOCKED_HOST/CRAWL_FAILED 등으로 매핑된다(SH-3 실연결 — CRAWL_PENDING 잔재 없음). */
function shelfAddErrorMessage(code, type) {
  switch (code) {
    case 'CRAWL_FAILED':  return '연결할 수 없어요 — URL을 확인해 주세요.';
    case 'BLOCKED_HOST':  return '이 주소는 보안상 추가할 수 없어요.';
    case 'PATH_GONE':     return (type === 'file' ? '파일' : '폴더') + '을 찾을 수 없어요 — 경로를 확인해 주세요.';
    case 'PATH_DENIED':   return '이 경로는 추가할 수 없어요 — 시스템/민감 경로는 제외돼요.';
    case 'UNSUPPORTED_TYPE': return '지원하지 않는 유형이에요.';
    case 'LIMIT':         return '셸프가 가득 찼어요 — 오래된 즐겨찾기를 정리해 주세요.';
    case 'BAD_INPUT':     return type === 'url' ? '주소 형식을 확인해 주세요.' : '경로 형식을 확인해 주세요.';
    case 'NOT_FOUND':     return '항목을 찾을 수 없어요.';
    case 'OPEN_FAILED':   return '열지 못했어요 — 잠시 후 다시 시도해 주세요.';
    case 'INTERNAL':      return '문제가 생겼어요 — 잠시 후 다시 시도해 주세요.';
    case 'FORBIDDEN':     return '요청이 거부됐어요.';
    default:              return type === 'url' ? '연결할 수 없어요 — URL을 확인해 주세요.'
                              : (type === 'file' ? '파일을 찾을 수 없어요 — 경로를 확인해 주세요.'
                              : '폴더를 찾을 수 없어요 — 경로를 확인해 주세요.');
  }
}
/**
 * 컴포저(유형 토글·입력 placeholder·테두리·상태 라벨) 뷰모델(순수).
 * @param {{cType:string, cUrl:string, cState:string}} c
 */
function shelfComposerVM(c) {
  c = c || {};
  const cType = (c.cType === 'folder' || c.cType === 'file') ? c.cType : 'url';
  const cState = (c.cState === 'loading' || c.cState === 'error') ? c.cState : 'idle';
  const placeholder = cType === 'folder' ? '/Users/you/projects/my-app  · 폴더 경로'
                    : cType === 'file'   ? '/Users/you/notes/todo.md  · 파일 경로'
                    : 'https://… 링크를 붙여넣어 셸프에 꽂기';
  const scanWord = cType === 'url' ? '크롤링 중' : '스캔 중';
  const ref = cType === 'url' ? (shelfHostOf(c.cUrl) || '…') : (shelfLastSeg(c.cUrl) || '…');
  return {
    cType, cState,
    types: ['url', 'folder', 'file'].map((t) => ({ t, label: t === 'url' ? 'URL' : (t === 'folder' ? '폴더' : '파일'), active: cType === t })),
    inputPlaceholder: placeholder,
    inputBorder: cState === 'idle' ? '#e7e5e4' : (cState === 'error' ? '#f0b27a' : '#c7d2fe'),
    cIdle: cState === 'idle', cLoading: cState === 'loading', cError: cState === 'error',
    crawlingLabel: scanWord + ' · ' + ref,
  };
}
/**
 * 셸프 패널(스파인↔펼침) 뷰모델 배열(순수). bookmarks=ShelfBookmarkView[].
 *   각 패널은 collapsed/expanded 와 레이아웃 폭(spineW)만 계산하고, 표시 문자열은 원본을 그대로 전달
 *   (렌더 시 textContent). banner 는 bannerImage 유무로 image|gradient 분기 플래그만 둔다.
 */
function shelfPanelsVM(bookmarks, activeId) {
  const list = Array.isArray(bookmarks) ? bookmarks : [];
  const spineW = shelfSpineW(list.length);
  // 활성 id 가 현존하지 않으면 첫 항목을 활성으로 폴백.
  let active = activeId;
  if (!list.some((b) => b && b.id === active)) active = list.length ? list[0].id : null;
  return list.map((b) => {
    b = b || {};
    const expanded = b.id === active;
    const hasBanner = typeof b.bannerImage === 'string' && b.bannerImage.indexOf('data:image/') === 0;
    return {
      id: b.id, type: b.type,
      mono: b.mono || '', name: b.name || '', title: b.title || '', sub: b.sub || '',
      desc: b.desc || '', cat: b.cat || '', status: b.status || '',
      color: shelfSafeColor(b.color),
      bannerImage: hasBanner ? b.bannerImage : null,
      bannerLabel: b.type === 'folder' ? '디렉토리' : (b.type === 'file' ? '파일' : 'og:image'),
      openLabel: b.type === 'folder' ? 'VS Code에서 열기' : (b.type === 'file' ? '편집기에서 열기' : '열기'),
      collapsed: !expanded, expanded, spineW,
    };
  });
}
/** '#RRGGBB' 형식만 허용(속성 인젝션 차단) — 그 외 기본 indigo 폴백. */
function shelfSafeColor(c) {
  return (typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c)) ? c : '#4f46e5';
}
/** 상태 분기 플래그(순수). 로딩 중에도 셸프 행을 보여 placeholder 스파인을 노출(초안 hasItems). */
function shelfStateFlags(bookmarks, cState) {
  const n = Array.isArray(bookmarks) ? bookmarks.length : 0;
  const loading = cState === 'loading';
  return { count: n, hasItems: n > 0 || loading, isEmpty: n === 0 && !loading };
}
/** [SH-4] 자동 재크롤 토글 뷰모델(순수). 기본 ON(undefined/true → on). 푸터 힌트·스위치 라벨·aria 계산. */
function shelfAutoRefreshView(autoRefresh) {
  const on = autoRefresh !== false;
  return {
    on,
    label: '자동 재크롤',
    hint: on
      ? '즐겨찾기는 6시간마다 자동으로 다시 스캔·크롤링돼 정보가 갱신됩니다'
      : '자동 재크롤이 꺼져 있어요 — 정보가 자동으로 갱신되지 않습니다',
    ariaLabel: '자동 재크롤 ' + (on ? '켜짐' : '꺼짐') + ' — 클릭해 ' + (on ? '끄기' : '켜기'),
    switchClass: 'shelf-switch' + (on ? ' shelf-switch--on' : ''),
  };
}

/**
 * [R-33] 커밋 막대 차트 기하 모델(순수, 헤드리스 테스트 대상). days → 막대 좌표/치수 배열.
 *   [M-2 보안] 수치는 Number()+isFinite 강제, 음수·NaN·Infinity·비수치는 0으로 클램프(높이 계산 안전).
 *   라벨 문자열은 모델에 그대로 담되(렌더 시 textContent 로만 사용), 좌표/치수는 데이터가 아닌
 *   상수(W/H/pad)와 sanitize 된 count 로만 계산 → 속성 인젝션 불가.
 * @param {Array} days [{ count, label? }]
 * @param {object} [opts] { width, height, pad, gap, maxBars }
 * @returns {{ bars:Array, maxCount:number, viewW:number, viewH:number, baseline:number }}
 */
function commitChartModel(days, opts) {
  opts = opts || {};
  const viewW = (typeof opts.width === 'number' && opts.width > 0) ? opts.width : 240;
  const viewH = (typeof opts.height === 'number' && opts.height > 0) ? opts.height : 96;
  const pad = (typeof opts.pad === 'number' && opts.pad >= 0) ? opts.pad : 4;
  const gap = (typeof opts.gap === 'number' && opts.gap >= 0) ? opts.gap : 6;
  const labelH = 16;              // 하단 요일 라벨 공간
  const maxBars = (typeof opts.maxBars === 'number' && opts.maxBars > 0) ? opts.maxBars : 7;

  // 입력 sanitize: 배열이 아니면 빈 7칸. 각 count 는 안전 수치(음수/NaN/Infinity → 0).
  const src = Array.isArray(days) ? days.slice(-maxBars) : [];
  const safe = src.map((d) => {
    const n = Number(d && d.count);
    const count = (Number.isFinite(n) && n >= 0) ? n : 0;
    const label = (d && typeof d.label === 'string') ? d.label : '';
    return { count, label };
  });
  while (safe.length < maxBars) safe.unshift({ count: 0, label: '' }); // 항상 maxBars 칸(기간 동일)

  const maxCount = safe.reduce((m, b) => (b.count > m ? b.count : m), 0);
  const baseline = viewH - labelH;            // 막대 바닥 y
  const usableH = baseline - pad;             // 막대 최대 높이 영역
  const n = safe.length;
  const colW = (viewW - gap * (n - 1)) / n;   // 막대 폭(균등 분할)

  const bars = safe.map((b, i) => {
    // 높이: count>0 이면 maxCount 기준 비례(최소 가시 높이 보장), 0 이면 바닥 스텁.
    const h = (b.count > 0 && maxCount > 0)
      ? Math.max(3, (b.count / maxCount) * usableH)
      : 2;
    const x = i * (colW + gap);
    const y = baseline - h;
    return {
      label: b.label, count: b.count,
      x: round1(x), y: round1(y), w: round1(colW), h: round1(h),
      isLast: i === n - 1,
    };
  });
  return { bars, maxCount, viewW, viewH, baseline };
}
function round1(v) { return Math.round(v * 10) / 10; }

/**
 * [M10-P3] patchRegion 분기 결정(순수, DOM 미접근). 계약 §2.2/§2.4 의 진입 분기를 테스트 가능하게 분리.
 *   @returns 'defer'(deferred=true → coalesce.request) | 'fallback'(container 부재 → render) | 'patch'(정상 영역 교체)
 */
function patchRegionPlan(containerPresent, isDeferred) {
  if (isDeferred) return 'defer';
  if (!containerPresent) return 'fallback';
  return 'patch';
}

/**
 * [M10-P2] commitActivity 데이터 동일성 키(순수). 마지막 날짜의 epoch-day 정수 + count 시퀀스.
 *   [Q-M10-1] 날짜 문자열이 아니라 정수만 키에 넣어 L-1/M-2 불변식 유지하면서, 자정 경계로 7일 창이
 *   밀리면(count 같아도) 키가 달라져 갱신 누락 0. Date.parse 실패(NaN)면 epochDay=0. count 는 M-2 규칙.
 */
function commitActivityKey(ca) {
  if (!ca || !Array.isArray(ca.days) || ca.days.length === 0) return '';
  const last = ca.days[ca.days.length - 1];
  const ms = Date.parse(last && last.date);
  const epochDay = Number.isFinite(ms) ? Math.floor(ms / 86400000) : 0;
  const counts = ca.days.slice(-7).map((d) => {
    const n = Number(d && d.count);
    return (Number.isFinite(n) && n >= 0) ? n : 0;
  }).join(',');
  return epochDay + '|' + counts;
}

/**
 * [M11] 메일 요약 동일성 키(순수, diff 가드). 계정별 id+unseen + 항목 uid·date(epoch-ms) 시퀀스.
 *   [L-1/M-2] 제목·발신자 등 신뢰불가 문자열은 키에 넣지 않는다(uid 정수·unseen 정수·date→ms 정수만).
 *   계정 id 는 hex 토큰(영속 키)이라 안전. 데이터·읽음 변동 시 키가 달라져 갱신 누락 0.
 */
function mailSummaryKey(summary) {
  if (!Array.isArray(summary)) return '';
  const parts = [];
  for (const a of summary) {
    if (!a || typeof a !== 'object') continue;
    const id = (typeof a.id === 'string') ? a.id : '';
    const un = Number(a.unseen);
    const unseen = (Number.isFinite(un) && un >= 0) ? un : 0;
    const items = Array.isArray(a.items) ? a.items : [];
    const its = items.map((m) => {
      const uid = Number(m && m.uid);
      const ms = Date.parse(m && m.date);
      return (Number.isFinite(uid) ? uid : 0) + ':' + (Number.isFinite(ms) ? ms : 0);
    }).join(',');
    parts.push(id + '#' + unseen + '#' + its);
  }
  return parts.join('|');
}

/* =====================================================================
 * [M13 R-34~R-41] 브리핑 AI 순수 로직 (DOM 비의존, 헤드리스 테스트 대상)
 * ===================================================================== */

/** [R-35] 세대 가드 — gen 은 단조 증가. push 의 gen 이 현재 추적 gen 이상이면 수용(최신 세대 채택),
 *   미만(취소된 이전 호출 잔여)이면 무시. 수용 시 호출측이 store.briefing.gen 을 msgGen 으로 올린다. */
function briefingAcceptsGen(curGen, msgGen) {
  if (!Number.isFinite(msgGen)) return false;
  return Number(msgGen) >= Number(curGen);
}

/** [R-41] 항목을 분류(category)별로 그룹핑(순수). 고정 순서 urgent→must→good, 미지 분류는 'good' 으로. */
const BRIEFING_CATEGORIES = [
  { id: 'urgent', label: '급함' },
  { id: 'must',   label: '알아야 할 것' },
  { id: 'good',   label: '알면 좋은 것' },
];
function briefingGroupItems(items) {
  const groups = { urgent: [], must: [], good: [] };
  if (Array.isArray(items)) for (const it of items) {
    if (!it || typeof it !== 'object' || typeof it.key !== 'string') continue;
    const cat = (it.category === 'urgent' || it.category === 'must') ? it.category : 'good';
    groups[cat].push(it);
  }
  return BRIEFING_CATEGORIES.map((c) => ({ id: c.id, label: c.label, items: groups[c.id] }))
    .filter((g) => g.items.length > 0);
}

/** [R-40] 폴백/에러 안내 문구(순수). status·code 별 비방해 인라인 힌트. enabled=false 면 안내만. */
function briefingFallbackHint(status, code) {
  if (status === 'disabled') return 'AI 브리핑이 꺼져 있습니다 — 설정 > 연동에서 켤 수 있습니다.';
  if (status !== 'error') return '';
  switch (code) {
    case 'CONN_REFUSED': return 'AI 브리핑을 사용할 수 없습니다 — 로컬 모델 서버가 실행 중인지 설정에서 확인하세요.';
    case 'TIMEOUT':      return 'AI 브리핑 응답이 지연됩니다 — 모델 서버 상태를 설정에서 확인하세요.';
    case 'PARSE':        return 'AI 브리핑 응답을 해석하지 못했습니다 — 다시 시도하거나 모델 설정을 확인하세요.';
    case 'BAD_URL':      return 'AI 브리핑 주소가 올바르지 않습니다 — 설정에서 baseURL 을 확인하세요.';
    default:             return 'AI 브리핑을 사용할 수 없습니다 — 설정에서 연결을 확인하세요.';
  }
}

/** [M-1] baseURL host 가 비-localhost(외부)인지 판정(순수). 경고 표시용. 파싱 실패 시 false(차단 아님). */
function isExternalBaseURL(baseURL) {
  if (typeof baseURL !== 'string' || !baseURL) return false;
  let host = '';
  try { host = new URL(baseURL).hostname; } catch (_) { return false; }
  host = String(host).toLowerCase().replace(/^\[|\]$/g, ''); // ipv6 대괄호 제거
  return !(host === 'localhost' || host === '127.0.0.1' || host === '::1');
}

/** [R-39] getSettings 응답 → 렌더러 설정 뷰(순수). apiKey 평문 없음(hasApiKey 불리언만), external 파생. */
function briefingSettingsView(res) {
  const r = (res && typeof res === 'object' && res.ok !== false) ? res : {};
  const adv = (r.advanced && typeof r.advanced === 'object') ? r.advanced : {};
  const baseURL = (typeof r.baseURL === 'string') ? r.baseURL : '';
  return {
    enabled: r.enabled === true,
    baseURL,
    model: (typeof r.model === 'string') ? r.model : '',
    hasApiKey: r.hasApiKey === true,
    // 사용자 편집 System(지시) 텍스트(빈='' = 시드 사용). defaultSystemPrompt는 시드(읽기전용·placeholder/복원용).
    systemPrompt: (typeof r.systemPrompt === 'string') ? r.systemPrompt : '',
    defaultSystemPrompt: (typeof r.defaultSystemPrompt === 'string') ? r.defaultSystemPrompt : '',
    external: isExternalBaseURL(baseURL),
    advanced: {
      coalesceMs: Number.isFinite(adv.coalesceMs) ? adv.coalesceMs : null,
      deadlineH: Number.isFinite(adv.deadlineH) ? adv.deadlineH : null,
    },
  };
}

/**
 * [M10-P1] 툴팁 가로 위치(left px) 순수 계산 — DOM 미접근(getBoundingClientRect 값은 인자 주입).
 *   막대 중심을 wrap 기준 픽셀로 환산한 뒤 [0, wrapWidth-tipWidth] 로 클램핑.
 *   세로 띄움(translateY(-100%))은 호출측이 별도 유지 — 여기선 가로만 계산.
 * @returns {number} 정수 px(반올림)
 */
function tipLeft(centerRatio, svgLeft, svgWidth, wrapLeft, wrapWidth, tipWidth) {
  const cr = (Number.isFinite(centerRatio)) ? centerRatio : 0.5;
  const sw = (Number.isFinite(svgWidth) && svgWidth > 0) ? svgWidth : 0;
  const tw = (Number.isFinite(tipWidth) && tipWidth >= 0) ? tipWidth : 0;
  const rawLeft = (svgLeft - wrapLeft) + cr * sw - tw / 2;
  const maxLeft = Math.max(0, ((Number.isFinite(wrapWidth) ? wrapWidth : 0)) - tw);
  return Math.round(Math.max(0, Math.min(rawLeft, maxLeft)));
}

// [R-28 정리] dispatchMenuAction 제거 — 네이티브 메뉴 폐기로 도달 불가한 죽은 코드.
//   단축키 디스패치는 matchShortcut(keydown→action)이 담당한다(SHORTCUTS 단일 출처).

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
  const names = (r.names && typeof r.names === 'object' && !Array.isArray(r.names)) ? r.names : {};
  const theme = (r.theme === 'light' || r.theme === 'dark' || r.theme === 'system') ? r.theme : 'system';
  return { favorites, order, sortMode, names, theme };
}

/* =====================================================================
 * 브라우저 전용 (DOM / fetch / 이벤트)
 * ===================================================================== */
function initBrowser() {
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const STALE_DAYS = 90; // 계약상 isStale은 서버 판정. 안내 문구용 기본값.
  const COMMIT_POLL_MS = 300000; // [R-31] 커밋 차트 폴링 주기 5분(git 조회 비용 — 메일 60초보다 길게).

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
    // 프로젝트 표시 별칭·테마(ui-state 영속).
    projectNames: {},            // { id: alias } — vm.name 우선 적용
    detectedNames: {},           // { id: 감지명 } — 별칭 해제 시 복원용(viewModels 빌드 시 캡처)
    editingName: null,           // 드로어에서 이름 편집 중인 id
    nameInput: '',               // 이름 편집 입력값(컨트롤드)
    theme: 'system',             // 'light' | 'dark' | 'system'
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
    settingsTab: 'scan',         // [R-30] 설정 2-pane 활성 카테고리(scan|integration|appearance|shortcuts|info)
    showHelp: false,             // #6 도움말 팝업(모달) 열림 여부
    showFirstRun: false,         // 최초 스캔 팝업(모달) — 스냅샷 없을 때 홈 위에 표시(닫기 가능)
    // 궤도 맵(Orbit Map) 컨트롤 상태 — 캔버스 루프가 live로 읽는다.
    orbit: { layout: 'drive', speed: 1, paused: false, scrub: 0, triage: false, hi: null, search: '', kpi: null },
    opts: { withSize: false, allDrives: false }, // 재스캔 옵션 UI 상태
    // M6 (R-18) 외부 툴 설정 상태
    tools: [],                   // getTools 응답(toolViews 입력)
    toolPathInput: {},           // 툴별 경로 직접 입력 컨트롤드 값 { id: text }
    busyTools: false,            // 툴 경로 설정 in-flight
    // #4 제외 항목(폴더명/절대경로)
    excludes: [],                // getConfig().excludes
    excludeInput: '',            // 제외 항목 직접 입력(컨트롤드)
    busyExcludes: false,         // 제외 추가/삭제 in-flight
    // 프로젝트 인식 기준(detectSignals: 이름/글로브/정규식)
    detectSignals: [],           // 현재 인식 기준
    detectDefaults: [],          // 기본값(복원 안내용)
    detectInput: '',             // 직접 입력(컨트롤드)
    busyDetect: false,           // 추가/삭제/복원 in-flight
    // 할 일(홈 브리핑) — getUiState 응답의 todos
    todos: [],                   // [{id,text,done,createdAt}]
    todoInput: '',               // 추가 입력(컨트롤드)
    todoAdding: false,           // '+ 할 일 추가' 인라인 입력 표시
    _composing: false,           // [R-25 RG-1] IME 조합 중 — 조합 중 재렌더 보류(자모 분리 방지)
    busyTodos: false,            // 추가/토글/삭제 in-flight
    // [백로그2-4] 할 일 마감 일시 — 추가/편집 입력(datetime-local 문자열), 편집 대상 id, 알림 발화 dedupe.
    todoDueInput: '',            // 추가 폼의 마감 입력
    todoDueEditId: null,         // 인라인 마감 편집 중인 할 일 id
    todoDueEditInput: '',        // 편집 폼의 마감 입력
    notifiedDue: new Set(),      // 이미 토스트 발화한 할 일 id(세션 내 1회)
    _dueTimer: null,             // 마감 도래 감시 타이머
    // 메일 다이제스트(홈 브리핑) — getMailSummary 응답(계정별 unseen + 제목/발신자 미리보기)
    mailSummary: [],             // [{id,label,host,user,unseen,items:[{subject,from,date}],ok,code}]
    busyMailSummary: false,      // getMailSummary in-flight
    mailSummaryLoaded: false,    // 최초 1회 자동 로드 가드
    mailView: { open: false, loading: false, accountId: null, uid: null, meta: null, code: null }, // 메일 본문 팝업
    // 메일함 팝업 — 계정별·메일함별 수집 메일 보관함(영속). 헤더 버튼으로 열고 동기화·삭제.
    mailbox: { open: false, loading: false, syncing: false, accounts: [], code: null, selAccount: null, selMailbox: null, errors: [] },
    // 생산성(홈 브리핑) — 최근 14일 커밋 빈도(getCommitActivity). 수동 새로고침(git 호출 비용).
    commitActivity: null,        // {days:[{date,count}],total,repos,scanned}
    busyCommitActivity: false,   // getCommitActivity in-flight
    commitActivityLoaded: false, // 1회 로드 표식
    langPrev: {},                // 직전 스캔 언어 카운트(추세 ▲▼ 비교용)
    // [항목3] 연결된 LLM 모델 토큰 사용량(getUiState.aiUsage 적재 — 브리핑 생성 시 누적).
    aiUsage: null,               // {calls,promptTokens,completionTokens,totalTokens,lastModel,lastAt}
    // [항목2] Claude Code 로컬 로그 토큰 사용량(getClaudeUsage — 무거운 스캔, 수동/지연 로드).
    claudeUsage: null,           // {available,totals,today,byModel,lastAt,scannedFiles}
    busyClaudeUsage: false,      // getClaudeUsage in-flight
    claudeUsageLoaded: false,    // 1회 로드 표식
    // 메일 알림 계정(복수 IMAP) — 공개 뷰 목록 + 입력 폼(비밀번호는 응답에 없음)
    mailAccounts: [],            // getMailAccounts 응답(공개 뷰: id,label,host,port,user,hasPassword)
    mailForm: { label: '', host: '', port: '', user: '', pass: '' }, // 추가/수정 폼(컨트롤드)
    mailEditingId: null,         // 수정 중인 계정 id(없으면 추가 모드)
    busyMail: false,             // 추가/수정/삭제/테스트 in-flight
    trayUnsubscribe: null,       // R-21: spip.onTray 구독 해제 함수
    projectsUpdatedUnsubscribe: null, // R-24: spip.onProjectsUpdated 구독 해제 함수
    mailUpdatedUnsubscribe: null, // 메일 갱신 push(spip.onMailUpdated) 구독 해제 함수
    mailRefreshTimer: null,       // 홈에서 메일 주기 갱신 타이머
    commitRefreshTimer: null,     // [R-31] 홈에서 커밋 차트 5분 주기 갱신 타이머(홈 이탈/비가시 시 정지)
    homeLayout: HOME_SECTION_IDS.slice(), // [R-32] 홈 섹션 표시 순서(getUiState.homeLayout 적재, 기본=enum 순서)
    // [위젯 추가/제거] 숨긴(미적용) 위젯 id 배열(getUiState.hiddenWidgets 적재) + 위젯 갤러리 팝업 표시 플래그.
    hiddenWidgets: [],
    showWidgetGallery: false,
    busyWidgets: false,           // setHiddenWidgets in-flight
    // [SH-2] 즐겨찾기 셸프 위젯 — 렌더러 상태. 데이터는 spip.shelf.list()로 적재, 변경 push(onChanged) 시 재조회.
    shelf: {
      bookmarks: [],              // ShelfBookmarkView[] (main 이 표시 메타 완비)
      active: null,               // 펼친(활성) 항목 id
      loaded: false,              // list() 1회 적재 표식
      busy: false,                // list/add in-flight
      cType: 'url',               // 컴포저 유형 토글(url|folder|file)
      cUrl: '',                   // 컴포저 입력(컨트롤드)
      cState: 'idle',             // 컴포저 상태(idle|loading|error)
      cErr: null,                 // 마지막 add 에러 메시지(error 상태 표시용)
      autoRefresh: true,          // [SH-4] 자동 재크롤(6시간) 토글 — list 응답 autoRefresh 로 초기 적재(기본 ON)
      busyAuto: false,            // setSettings in-flight
      _focusPending: false,       // 활성 변경 후 마운트 시 자동 스크롤 1회 트리거
      editing: null,              // 인라인 책 제목 편집 중인 항목 id(없으면 null)
      _editValue: null,           // 편집 입력값 버퍼(재렌더 보존)
      _addTimer: null,            // 디바운스 add 타이머
      _addSeq: 0,                 // add 경합 가드(취소분 무시)
      unsub: null,                // onChanged 구독 해제
      subscribed: false,
    },
    // [M13 R-34~R-41] 브리핑 AI — 렌더러 상태(apiKey 평문 절대 미보관). status 는 push 로 갱신.
    briefing: {
      enabled: false,            // getSettings.enabled(opt-in)
      status: 'idle',            // idle|generating|streaming|done|error|disabled (onState)
      gen: 0,                    // 최신 세대(취소분 delta/done 무시용)
      streamText: '',            // onDelta 누적 버퍼(평문 모드에서만 표시 — textContent)
      streamMode: 'text',        // 'json'|'text' — json이면 streamItems 카드 표시(원문 JSON 숨김)
      streamItems: [],           // 스트리밍 중 완성된 부분 항목 [{key,title,reason,guide}](점진 표시)
      items: [],                 // 최종/carry-over open 항목 [{key,category,title,reason,guide,ref}]
      counters: null,            // getUiState.briefing.counters
      lastError: null,           // 마지막 에러 code(고정 enum)
      expanded: {},              // key -> 가이드 펼침 여부
      settings: null,            // getSettings 응답 뷰(hasApiKey 불리언만 — 키 평문 없음)
      testResult: null,          // testConnection 결과 {ok,model?,latencyMs?,code?}
      busyTest: false, busySettings: false,
      keyInput: '',              // 설정 키 입력(쓰기 전용 — 저장 후 비움, store 영속 안 함)
      form: { baseURL: '', model: '', systemPrompt: '' }, // 설정 입력 폼(컨트롤드 — getSettings 로 초기화)
      subscribed: false,
      _unsubs: [],
    },
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
    if (opts.style) node.style.cssText = opts.style; // 인라인 스타일(템플릿 충실 복제용)
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

  /* [R-33] SVG 자작 커밋 막대 차트(외부 라이브러리·CDN 0). 호버 툴팁·강조 인터랙티브.
   *   [M-2] 라벨·툴팁은 textContent 만(innerHTML 금지). 색·치수는 고정 팔레트/모델값으로 setAttribute
   *   (데이터 문자열을 속성에 직접 인터폴레이션 안 함). 수치는 commitChartModel 이 sanitize. */
  const CHART_PALETTE = { bar: '#c7d2fe', barLast: '#4f46e5', barHover: '#312e81', stub: '#e7e5e4' };
  /**
   * @param {Array} days [{ count, label, iso? }] (이미 label 계산됨)
   * @param {object} [opts] commitChartModel 옵션 + { ariaLabel }
   * @returns {{ node:SVGElement, destroy:Function }}
   */
  function chartBars(days, opts) {
    opts = opts || {};
    const model = commitChartModel(days, opts);
    const svgEl = document.createElementNS(SVG_NS, 'svg');
    svgEl.setAttribute('viewBox', '0 0 ' + model.viewW + ' ' + model.viewH);
    svgEl.setAttribute('width', '100%');
    svgEl.setAttribute('height', String(model.viewH));
    svgEl.setAttribute('preserveAspectRatio', 'none');
    svgEl.setAttribute('class', 'commit-chart__svg');
    svgEl.setAttribute('role', 'img');
    if (typeof opts.ariaLabel === 'string') svgEl.setAttribute('aria-label', opts.ariaLabel);

    // 외부 툴팁 div(SVG 외부, textContent 만). foreignObject 회피(CSP/렌더 단순).
    const tip = el('div', { cls: 'commit-chart__tip' });
    tip.style.display = 'none';

    const handlers = []; // { el, type, fn } — destroy 에서 detach
    function on(eln, type, fn) { eln.addEventListener(type, fn); handlers.push({ el: eln, type, fn }); }

    model.bars.forEach((b) => {
      const rect = document.createElementNS(SVG_NS, 'rect');
      // 치수는 모델(sanitize 된 수치)에서만 — 데이터 문자열 직접 인터폴레이션 없음.
      rect.setAttribute('x', String(b.x));
      rect.setAttribute('y', String(b.y));
      rect.setAttribute('width', String(b.w));
      rect.setAttribute('height', String(b.h));
      rect.setAttribute('rx', '2');
      const baseFill = (b.count <= 0) ? CHART_PALETTE.stub : (b.isLast ? CHART_PALETTE.barLast : CHART_PALETTE.bar);
      rect.setAttribute('fill', baseFill); // 고정 팔레트
      rect.setAttribute('tabindex', '0');   // 키보드 포커스 가능(접근성)
      rect.setAttribute('role', 'listitem');
      // 접근성 라벨(스크린리더): textContent 기반 title 요소.
      const titleEl = document.createElementNS(SVG_NS, 'title');
      titleEl.textContent = (b.label || '·') + ': ' + b.count + ' 커밋'; // L-1 textContent
      rect.appendChild(titleEl);

      const showTip = () => {
        rect.setAttribute('fill', CHART_PALETTE.barHover);    // 강조
        tip.textContent = (b.label || '·') + ' · ' + b.count + ' 커밋'; // [M-2] textContent 만
        tip.style.display = 'block';                          // offsetWidth 실측 위해 먼저 표시
        // [M10-P1/F-3b] 가로는 막대 중심 추적, 세로 띄움(translateY(-100%))은 항상 유지(가로만 변경).
        const centerRatio = (b.x + b.w / 2) / model.viewW;
        const svgRect = svgEl.getBoundingClientRect();
        const wrapRect = wrap.getBoundingClientRect();
        const left = tipLeft(centerRatio, svgRect.left, svgRect.width, wrapRect.left, wrapRect.width, tip.offsetWidth || 80);
        tip.style.left = left + 'px';
        tip.style.transform = 'translateY(-100%)'; // 세로 띄움 — 'none' 으로 덮지 않는다(F-3b)
      };
      const hideTip = () => {
        rect.setAttribute('fill', baseFill);
        tip.style.display = 'none';
      };
      on(rect, 'mouseenter', showTip);
      on(rect, 'mouseleave', hideTip);
      on(rect, 'focus', showTip);
      on(rect, 'blur', hideTip);
      svgEl.appendChild(rect);
    });

    const wrap = el('div', { cls: 'commit-chart__wrap' });
    wrap.appendChild(svgEl);
    wrap.appendChild(tip);

    // 하단 요일 라벨(textContent 만). 막대와 동일 분할로 가로 배치.
    const labelRow = el('div', { cls: 'commit-chart__labels' });
    model.bars.forEach((b) => {
      labelRow.appendChild(el('span', { cls: 'commit-chart__label', text: b.label || '·' }));
    });

    const node = el('div', { cls: 'commit-chart' });
    node.appendChild(wrap);
    node.appendChild(labelRow);

    function destroy() {
      for (const h of handlers) { try { h.el.removeEventListener(h.type, h.fn); } catch (_) { /* ignore */ } }
      handlers.length = 0;
    }
    return { node, destroy };
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
    // [R-25 RG-3] 노드 교체 전 모든 stateful 위젯(카드 Sortable 등) 정리. 기존 destroyCardSortable 일반화.
    RG.widget.destroyAll();
    const v = store.state.view;
    // 뷰가 막 바뀐 경우에만 진입 애니메이션(is-enter)을 1회 부여 — 재렌더(스캔 진행 250ms 등)마다
    //   재생되면 깜빡인다. 같은 뷰의 반복 렌더는 entering=false라 애니메이션 없이 즉시 갱신.
    const entering = store._lastView !== v;
    // [R-25 RG-2] 재렌더 전 포커스/캐럿/스크롤 스냅샷(기존 인라인 복원 로직을 RG.preserve 로 흡수, 동작 동일).
    const snap = RG.preserve.capture(app);
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
    else if (v === 'home') {
      app.appendChild(renderHome());
    }
    else {
      app.appendChild(renderDashboard());
    }
    // 설정·도움말 모달은 모든 뷰 위에 표시(대시보드·궤도 등 어디서든 열림).
    if (store.showSettings) app.appendChild(renderSettings());
    if (store.showHelp) app.appendChild(renderHelp());
    // 최초 스캔 팝업 — 홈 위에만 표시(스냅샷 없을 때). 닫기 가능(× / Esc / 오버레이).
    if (store.showFirstRun && store.state.view === 'home') app.appendChild(renderFirstRunModal());
    // 메일함 팝업(헤더 버튼) — 먼저 마운트(아래 깔림).
    if (store.mailbox && store.mailbox.open) app.appendChild(renderMailboxModal());
    // 메일 본문 팝업(항목 클릭) — 나중에 마운트해 메일함 위에 표시(메일함에서 메일을 읽을 때 위로).
    if (store.mailView && store.mailView.open) app.appendChild(renderMailMessageModal());
    // [R-25 RG-2] 저장한 스크롤 위치 + 검색 입력 포커스/캐럿 복원(타이핑 중 재렌더로 포커스가 풀리는 문제 해결).
    RG.preserve.restore(app, snap);
    // [R-25 RG-3] 새 DOM 에 매칭되는 위젯만 1회 부착(카드뷰면 .cards 에 Sortable, 표/무결과/홈이면 no-op).
    RG.widget.mountAll(app);
    // [R-31] 뷰가 바뀌면 커밋 폴링 게이트 동기화(홈 진입=시작 / 홈 이탈=정지). 같은 뷰 반복 렌더는 idempotent.
    if (store._lastView !== v) { try { syncHomePolling(); } catch (_) { /* graceful */ } }
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

  /** 최초 스캔 팝업(모달) — renderFirstRun 내용을 대시보드 앞 닫기 가능한 모달로 제공. */
  function renderFirstRunModal() {
    const enter = !store._firstRunShown; store._firstRunShown = true; // 진입 애니메이션 1회만
    const hasRoots = store.roots.length > 0;
    const body = [];
    body.push(el('p', { cls: 'settings__opt-sub', text: hasRoots
      ? '아래 폴더를 스캔하면 대시보드가 채워집니다. 스캔은 이 PC에서 로컬로만 수행됩니다.'
      : '프로젝트가 들어 있는 폴더를 추가하면 스캔할 수 있습니다. 폴더 선택·스캔은 이 PC에서 로컬로만 수행됩니다.' }));
    body.push(renderRootManager());
    const startBtn = el('button', {
      cls: 'btn btn--dark btn--block', text: store.state.rescanning ? '스캔 시작 중…' : '스캔 시작',
      attrs: { 'aria-label': '추가된 폴더 스캔 시작' }, on: { click: () => triggerRescan('home') },
    });
    if (!store.state.rescanning) startBtn.prepend(svg([{ t: 'path', d: 'M21 12a9 9 0 1 1-2.64-6.36' }, { t: 'path', d: 'M21 3v6h-6' }], { size: 15 }));
    if (store.state.rescanning || !hasRoots || store.busyFolders) startBtn.disabled = true;
    body.push(startBtn);
    if (!hasRoots) body.push(el('p', { cls: 'firstrun__note', text: '폴더를 1개 이상 추가하면 스캔할 수 있습니다.' }));
    body.push(el('div', { cls: 'firstrun__security', children: [
      svg([{ t: 'rect', x: '4', y: '11', width: '16', height: '9', rx: '2' }, { t: 'path', d: 'M8 11V8a4 4 0 0 1 8 0v3' }], { size: 13, stroke: '#a8a29e' }),
      el('span', { text: '로컬 전용 · 외부로 어떤 데이터도 전송하지 않습니다' }),
    ]}));
    return buildModal({
      titleId: 'firstrun-title', title: '프로젝트 스캔', subtitle: '스캔할 폴더를 추가하고 스캔을 시작하세요',
      onClose: closeFirstRun, enter: enter, bodyChildren: body,
    });
  }
  function closeFirstRun() { store.showFirstRun = false; store._firstRunShown = false; render(); }

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
      const ul = el('ul', { cls: 'rootmgr__list spip-scroll', attrs: { role: 'list' } });
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
  /* =====================================================================
   * 홈(브리핑) 화면 — 헤더(공유) + 인사말/KPI + 인사이트 카드 그리드.
   *   M1: 보유 데이터(주의 필요 프로젝트·최근 활동)만. 메일/할일/차트는 후속 마일스톤.
   * ===================================================================== */
  /* =====================================================================
   * 홈(브리핑) 화면 — docs/temp/홈 대시보드 B.html 템플릿을 인라인 스타일로 충실 복제.
   *   데이터는 실데이터로 와이어링(없는 항목은 graceful). 렌더 텍스트는 textContent(L-1).
   * ===================================================================== */
  // 템플릿 팔레트(하드코딩 rgb — 템플릿 자체완결, 라이트 전용).
  var HOME_MONO = 'font-family:"Geist Mono",monospace;';
  var HOME_CARD = 'background:#fff;border:1px solid #e7e5e4;border-radius:16px;';

  function homeWeekday(dateStr) {
    var WD = ['일', '월', '화', '수', '목', '금', '토'];
    var d = new Date(String(dateStr) + 'T00:00:00');
    return isNaN(d) ? '' : WD[d.getDay()];
  }
  function homeAvatarColors(i) {
    var pal = [
      { bg: '#eef2ff', fg: '#4338ca' }, { bg: '#1c1917', fg: '#ffffff' },
      { bg: '#dcfce7', fg: '#15803d' }, { bg: '#fef3c7', fg: '#b45309' },
      { bg: '#f5f5f4', fg: '#78716c' },
    ];
    return pal[i % pal.length];
  }
  function homeIsReply(subject) {
    return /\b(re:|fwd:)|회신|요청|부탁/i.test(String(subject || ''));
  }

  /* =====================================================================
   * [M13 R-35/R-40/R-41] 브리핑 AI 렌더(스트리밍·항목·폴백). 모든 텍스트 textContent(L-1).
   *   모델 출력은 절대 innerHTML/마크다운→HTML 변환 안 함 — el()+textContent 노드 구성만.
   * ===================================================================== */
  /** 정적 브리핑 문장(폴백·기본). 기존 KPI 기반 문장 보존. */
  function staticBriefingLine() {
    var kpis = homeKpis(store.viewModels || []);
    var todosOpen = (store.todos || []).filter(function (t) { return !t.done; }).length;
    var unread = mailUnreadTotal();
    return fmtDate(store.now ? store.now.toISOString() : null)
      + ' · 주의가 필요한 프로젝트 ' + kpis.attention + '개, 안 읽은 메일 ' + unread
      + '건, 남은 할 일 ' + todosOpen + '건이 있어요.';
  }

  /** 브리핑 카드 본문(renderHome·patchBriefing 공용). enabled/상태에 따라 정적/스트리밍/항목/폴백. */
  function renderBriefingCard() {
    var b = store.briefing;
    var card = el('div', { cls: 'briefing-card' });

    // opt-in off → 정적 문장만(회귀 0).
    if (!b.enabled) {
      card.appendChild(el('p', { text: staticBriefingLine(), style: 'margin:0;font-size:13.5px;color:#78716c;line-height:1.55;' }));
      return card;
    }

    // 상단 줄: 상태 + 액션(재생성/중단).
    var head = el('div', { cls: 'briefing-card__head' });
    var statusText = (b.status === 'generating') ? '브리핑 생성 중…'
      : (b.status === 'streaming') ? '브리핑 작성 중…'
      : (b.status === 'error') ? '브리핑 오류'
      : 'AI 브리핑';
    head.appendChild(el('span', { cls: 'briefing-card__status', text: statusText }));
    if (b.status === 'generating' || b.status === 'streaming') {
      head.appendChild(el('span', { cls: 'briefing-card__spinner', attrs: { 'aria-hidden': 'true' } }));
      head.appendChild(el('button', {
        cls: 'briefing-card__btn', text: '중단', attrs: { type: 'button', 'aria-label': '브리핑 생성 중단' },
        on: { click: function () { try { spip.briefing.abort(); } catch (_) {} } },
      }));
    } else if (bridgeHas2('briefing')) {
      head.appendChild(el('button', {
        cls: 'briefing-card__btn', text: '새로고침', attrs: { type: 'button', 'aria-label': '브리핑 재생성' },
        on: { click: function () { triggerBriefing(); } },
      }));
    }
    card.appendChild(head);

    // 폴백 안내(error/disabled) — 정적 문장 + 비방해 힌트.
    var hint = briefingFallbackHint(b.status, b.lastError);
    if (b.status === 'error') {
      card.appendChild(el('p', { text: staticBriefingLine(), style: 'margin:6px 0 0;font-size:13.5px;color:#78716c;line-height:1.55;' }));
    }
    if (hint) {
      var hintRow = el('div', { cls: 'briefing-card__hint' });
      hintRow.appendChild(el('span', { text: hint }));
      hintRow.appendChild(el('button', {
        cls: 'briefing-card__link', text: '설정 열기', attrs: { type: 'button' },
        on: { click: function () { store.settingsTab = 'integration'; openSettings(); } },
      }));
      card.appendChild(hintRow);
    }

    // 스트리밍 중 — JSON 모드면 완성된 부분 항목을 카드로 점진 표시(원문 JSON 숨김), 평문 모드면
    //   누적 원문 그대로(textContent). 어느 쪽도 마크다운→HTML 변환은 절대 없음.
    var showingStream = false;
    if (b.status === 'streaming') {
      if (b.streamMode === 'json' && b.streamItems && b.streamItems.length) {
        var sWrap = el('div', { cls: 'briefing-items briefing-items--stream' });
        b.streamItems.forEach(function (it) { sWrap.appendChild(renderBriefingStreamItem(it)); });
        card.appendChild(sWrap);
        showingStream = true;
      } else if (b.streamMode !== 'json' && b.streamText) {
        card.appendChild(el('p', { cls: 'briefing-card__stream', text: b.streamText }));
      }
      // JSON 모드인데 아직 완성 항목 0개면 본문 비움 — 상단 "브리핑 작성 중…" 인디케이터가 대신한다.
    }

    // 항목(done/carry-over) — 스트리밍 미리보기를 보이는 중이면 생략(중복 방지).
    var groups = showingStream ? [] : briefingGroupItems(b.items);
    if (groups.length > 0) {
      var listWrap = el('div', { cls: 'briefing-items' });
      groups.forEach(function (gp) {
        listWrap.appendChild(el('div', { cls: 'briefing-items__cat', text: gp.label }));
        gp.items.forEach(function (it) { listWrap.appendChild(renderBriefingItem(it, gp.id)); });
      });
      card.appendChild(listWrap);
    } else if (b.status !== 'streaming' && b.status !== 'generating' && b.status !== 'error') {
      // enabled·정상이나 항목 없음 → 정적 문장(빈 화면 0).
      card.appendChild(el('p', { text: staticBriefingLine(), style: 'margin:6px 0 0;font-size:13.5px;color:#78716c;line-height:1.55;' }));
    }
    return card;
  }

  /** 브리핑 항목 1개 — 제목·사유(textContent) + done/dismiss + 가이드 접힘/펼침. 모델 출력 표시전용. */
  function renderBriefingItem(it, catId) {
    var key = it.key;
    var row = el('div', { cls: 'briefing-item briefing-item--' + catId });
    var top = el('div', { cls: 'briefing-item__top' });
    top.appendChild(el('span', { cls: 'briefing-item__title', text: String(it.title || '') }));
    // done/dismiss — resolveItem(key, action). 모델 문자열은 클릭 명령/href 에 절대 쓰지 않음(key 만).
    var actions = el('div', { cls: 'briefing-item__actions' });
    actions.appendChild(el('button', {
      cls: 'briefing-item__act', text: '완료', attrs: { type: 'button', 'aria-label': '항목 완료 처리' },
      on: { click: function () { resolveBriefingItem(key, 'done'); } },
    }));
    actions.appendChild(el('button', {
      cls: 'briefing-item__act briefing-item__act--dim', text: '닫기', attrs: { type: 'button', 'aria-label': '항목 닫기' },
      on: { click: function () { resolveBriefingItem(key, 'dismiss'); } },
    }));
    top.appendChild(actions);
    row.appendChild(top);
    if (it.reason) row.appendChild(el('div', { cls: 'briefing-item__reason', text: String(it.reason) }));
    // 가이드 토글(urgent 기본 펼침).
    if (it.guide) {
      var open = (store.briefing.expanded[key] != null) ? store.briefing.expanded[key] : (catId === 'urgent');
      var toggle = el('button', {
        cls: 'briefing-item__guide-toggle', text: open ? '가이드 접기' : '가이드 보기',
        attrs: { type: 'button', 'aria-expanded': open ? 'true' : 'false' },
        on: { click: function () { store.briefing.expanded[key] = !open; patchBriefing(); } },
      });
      row.appendChild(toggle);
      if (open) row.appendChild(el('div', { cls: 'briefing-item__guide', text: String(it.guide) }));
    }
    return row;
  }

  /** 스트리밍 중 부분 항목 1개 — 제목·사유만(읽기 전용 미리보기). 완료 전이라 액션 버튼 없음.
   *   모델 출력은 표시 전용(textContent). 마지막 항목에 '작성 중' 느낌(stream 클래스). */
  function renderBriefingStreamItem(it) {
    var row = el('div', { cls: 'briefing-item briefing-item--stream' });
    if (it.title) row.appendChild(el('div', { cls: 'briefing-item__title', text: String(it.title) }));
    if (it.reason) row.appendChild(el('div', { cls: 'briefing-item__reason', text: String(it.reason) }));
    return row;
  }

  /** [R-35] 브리핑 영역만 부분 갱신(patchRegion). 영역 부재/오류/deferred 시 내부 안전 처리. */
  function patchBriefing() {
    if (typeof document === 'undefined') { render(); return; }
    var region = document.querySelector('.briefing-region');
    RG.preserve.patchRegion(region, function () { return renderBriefingCard(); }, {
      widgets: [], preserveFocus: false, fallback: function () { render(); },
    });
  }

  /** 브리핑 bridge 메서드 존재 확인(graceful). */
  function bridgeHas2(ns) { return !!(spip && spip[ns] && typeof spip[ns].trigger === 'function'); }

  /** 수동 트리거(새로고침). enabled·홈에서만. */
  function triggerBriefing() {
    if (!spip || !spip.briefing || typeof spip.briefing.trigger !== 'function') return;
    try { spip.briefing.trigger({ reason: 'manual' }); } catch (_) { /* graceful */ }
  }

  /** [R-41] 항목 done/dismiss — resolveItem(key,action) → 응답 items 로 갱신 후 영역만 patch. */
  function resolveBriefingItem(key, action) {
    if (!spip || !spip.briefing || typeof spip.briefing.resolveItem !== 'function') return;
    Promise.resolve(spip.briefing.resolveItem(key, action)).then(function (res) {
      if (res && res.ok && Array.isArray(res.items)) {
        store.briefing.items = res.items.filter(function (x) { return x && typeof x.key === 'string'; });
        if (store.briefing.expanded) delete store.briefing.expanded[key];
        patchBriefing();
      }
    }).catch(function () { /* graceful — 표시 유지 */ });
  }

  function renderHome() {
    maybeInitBriefing();
    maybeLoadMailSummary();
    maybeLoadCommitActivity();
    maybeLoadClaudeUsage();
    maybeLoadShelf();
    var vms = store.viewModels || [];
    var g = homeGreeting(store.now);
    var kpis = homeKpis(vms);
    var todosOpen = (store.todos || []).filter(function (t) { return !t.done; }).length;
    var unread = mailUnreadTotal();
    var reclaim = diskReclaim(vms);

    var root = el('div', { cls: 'dash home' });
    root.appendChild(renderHeader());

    var main = el('main', { cls: 'dash__main spip-scroll', attrs: { id: 'main' }, style: 'background:#f6f6f5;color:#1c1917;font-family:Geist,Pretendard,system-ui,sans-serif;' });
    var wrap = el('div', { style: 'max-width:1480px;margin:0 auto;' });

    // 스캔된 프로젝트가 없으면(팝업을 닫았어도) 재스캔 진입 배너를 노출.
    if (vms.length === 0 && !store.showFirstRun) {
      var bn = el('div', { style: 'padding:18px 30px 0;' });
      var bar = el('div', { style: 'background:#eef2ff;border:1px solid #c7d2fe;border-radius:12px;padding:13px 16px;display:flex;align-items:center;gap:12px;' });
      bar.appendChild(el('span', { text: '아직 스캔된 프로젝트가 없습니다.', style: 'flex:1;font-size:13px;color:#1c1917;' }));
      bar.appendChild(el('button', {
        cls: 'btn btn--dark', text: '폴더 스캔하기', attrs: { type: 'button', 'aria-label': '프로젝트 스캔 팝업 열기' },
        on: { click: function () { store.showFirstRun = true; render(); } },
      }));
      bn.appendChild(bar);
      wrap.appendChild(bn);
    }

    // ── 히어로(오늘의 브리핑 + KPI 4) ──
    var heroPad = el('div', { style: 'padding:26px 30px 6px;' });
    var hero = el('div', { style: HOME_CARD + 'padding:26px 28px;display:flex;align-items:center;gap:30px;' });
    var heroL = el('div', { style: 'flex:1 1 0%;min-width:0;' });
    heroL.appendChild(el('div', { text: '오늘의 브리핑', style: HOME_MONO + 'font-size:11px;letter-spacing:0.12em;text-transform:uppercase;color:#4f46e5;' }));
    heroL.appendChild(el('h1', { text: g.greeting, style: 'margin:9px 0 7px;font-size:29px;font-weight:700;letter-spacing:-0.022em;line-height:1.12;' }));
    // [M13 R-35/R-40] 정적 브리핑 문장을 브리핑 영역(2단: .briefing-region > 카드)으로 승격.
    //   enabled 면 AI 스트리밍/항목, 아니면 기존 정적 문장 폴백. delta 시 이 영역만 patchRegion 교체.
    var briefingRegion = el('div', { cls: 'briefing-region' });
    briefingRegion.appendChild(renderBriefingCard());
    heroL.appendChild(briefingRegion);
    hero.appendChild(heroL);
    var heroR = el('div', { style: 'display:flex;gap:0;flex:0 0 auto;' });
    var kpi = function (val, label, color) {
      var c = el('div', { style: 'padding:0 22px;border-left:1px solid #f0efed;' });
      c.appendChild(el('div', { text: String(val), style: 'font-size:30px;font-weight:700;letter-spacing:-0.02em;color:' + color + ';font-variant-numeric:tabular-nums;line-height:1;' }));
      c.appendChild(el('div', { text: label, style: 'font-size:11.5px;color:#78716c;margin-top:7px;' }));
      return c;
    };
    heroR.appendChild(kpi(kpis.attention, '주의 필요', '#b45309'));
    heroR.appendChild(kpi(unread, '안 읽은 메일', '#1d4ed8'));
    heroR.appendChild(kpi(todosOpen, '남은 할 일', '#4338ca'));
    heroR.appendChild(kpi(reclaim.label, '회수 가능', '#15803d'));
    hero.appendChild(heroR);
    heroPad.appendChild(hero);
    wrap.appendChild(heroPad);

    // ── [R-32] 워터폴(masonry) 섹션 — homeLayout 순서로 데이터-주도 배치 + 드래그 재정렬 ──
    //   각 섹션은 .home-section(data-home-section=enum id) 래퍼로 감싸 SortableJS 가 이동 단위로 잡는다.
    //   레이아웃은 CSS columns(.home-masonry) — 높이가 제각각인 카드를 빈틈 없이 채운다.
    var grid = el('div', { cls: 'home-masonry', style: 'padding:20px 30px 36px;' });
    var hidden = store.hiddenWidgets || [];
    applyHomeLayout(store.homeLayout).forEach(function (id) {
      // [위젯 추가/제거] 미적용(숨김) 콘텐츠 위젯은 건너뜀. featureAdd(추가 트리거)는 항상 표시.
      if (id !== 'featureAdd' && hidden.indexOf(id) >= 0) return;
      var node = renderHomeSection(id, reclaim);
      if (!node) return;
      // data-home-section 은 고정 enum 값만(L-2/L-3: 스캔 유래 신뢰 못 할 데이터 아님). 드래그 이동 단위.
      //   [SH-2] shelfWide 는 masonry 컬럼 전체폭 스팬(.home-section--wide → column-span:all).
      var cell = el('div', { cls: 'home-section' + (id === 'shelfWide' ? ' home-section--wide' : ''), attrs: { 'data-home-section': id } });
      // [위젯 추가/제거] featureAdd 외 위젯엔 제거(×) 버튼 오버레이(호버 시 노출).
      if (id !== 'featureAdd') cell.appendChild(widgetRemoveBtn(id));
      cell.appendChild(node);
      grid.appendChild(cell);
    });
    wrap.appendChild(grid);

    main.appendChild(wrap);
    root.appendChild(main);
    if (store.state.selectedId) root.appendChild(renderDrawer());
    if (store.showWidgetGallery) root.appendChild(renderWidgetGallery()); // [위젯 추가/제거] 위젯 갤러리 팝업
    return root;
  }

  /** [R-32] 홈 섹션 id(enum) → 섹션 DOM 빌더. 기존 render*Home* 함수를 그대로 호출(내용·동작 불변).
   *   reclaim 은 디스크 섹션 입력(renderHome 에서 1회 계산해 전달). 미지 id 는 null(graceful). */
  function renderHomeSection(id, reclaim) {
    switch (id) {
      case 'attention':    return renderHomeAttention();
      case 'productivity': return renderHomeProductivity();
      case 'activity':     return renderHomeActivity();
      case 'todos':        return renderHomeTodos();
      case 'mail':         return renderHomeMail();
      case 'disk':         return renderHomeDisk(reclaim);
      case 'aiusage':      return renderHomeAiUsage();
      case 'shelf':        return renderHomeShelf();
      case 'shelfWide':    return renderHomeShelf();
      case 'featureAdd':   return renderHomeFeatureAdd();
      default:             return null;
    }
  }

  /** 메일 안 읽은 합계(요약 로드 전이면 0). */
  function mailUnreadTotal() {
    var a = store.mailSummary || [];
    var n = 0;
    for (var i = 0; i < a.length; i++) if (a[i] && a[i].ok !== false && Number.isFinite(a[i].unseen)) n += a[i].unseen;
    return n;
  }
  /** 메일 항목 평탄화(계정 가로질러, 최신순 근사) — 홈 메일 카드용. */
  function mailFlatItems(limit) {
    var out = [];
    var a = store.mailSummary || [];
    for (var i = 0; i < a.length; i++) {
      if (!a[i] || a[i].ok === false || !Array.isArray(a[i].items)) continue;
      for (var j = 0; j < a[i].items.length; j++) out.push(Object.assign({ accountId: a[i].id }, a[i].items[j]));
    }
    out.sort(function (x, y) { return (Date.parse(y && y.date) || 0) - (Date.parse(x && x.date) || 0); });
    return out.slice(0, limit || 5);
  }
  /** 메일용 상대시각(분/시간 단위 포함). 하루 이상은 rel()로 위임. */
  function relMail(dateStr) {
    var t = Date.parse(dateStr);
    if (!t) return '';
    var nowMs = (store.now instanceof Date) ? store.now.getTime() : Date.now();
    var diff = nowMs - t; if (diff < 0) diff = 0;
    var min = Math.floor(diff / 60000);
    if (min < 1) return '방금';
    if (min < 60) return min + '분 전';
    var hr = Math.floor(min / 60);
    if (hr < 24) return hr + '시간 전';
    return rel(new Date(t).toISOString());
  }
  /** 방치 프로젝트 node_modules 회수 가능 용량(size 수집 켜진 경우만). */
  function diskReclaim(vms) {
    var items = [];
    var total = 0;
    for (var i = 0; i < vms.length; i++) {
      var v = vms[i];
      if (!v || !v.isStale) continue;
      var b = (typeof v.nodeModulesBytes === 'number' && v.nodeModulesBytes > 0) ? v.nodeModulesBytes : 0;
      if (b <= 0) continue;
      items.push({ name: v.name, bytes: b });
      total += b;
    }
    items.sort(function (a, b) { return b.bytes - a.bytes; });
    var mb = Math.round(total / 1048576);
    return { items: items.slice(0, 5), total: total, label: mb > 0 ? (mb + ' MB') : '0 MB', max: items.length ? items[0].bytes : 1 };
  }

  /** 흰 카드 + 헤더(제목/우측 액션) 헬퍼. */
  function homeCardHead(titleNode, rightNode, mb) {
    var head = el('div', { style: 'display:flex;align-items:center;gap:10px;margin-bottom:' + (mb == null ? 15 : mb) + 'px;' });
    head.appendChild(titleNode);
    if (rightNode) head.appendChild(rightNode);
    return head;
  }
  function homeTitle(text) {
    return el('div', { text: text, style: 'font-size:15px;font-weight:600;letter-spacing:-0.01em;flex:1 1 0%;' });
  }
  function homeBadge(text, kind) {
    var c = { amber: 'background:#fef3c7;color:#b45309;border:1px solid #fde68a;', blue: 'background:#dbeafe;color:#1d4ed8;border:1px solid #bfdbfe;', cyan: 'background:#cffafe;color:#0e7490;border:1px solid #a5f3fc;' }[kind] || '';
    return el('span', { text: text, style: 'font-size:10.5px;font-weight:600;padding:2px 8px;border-radius:6px;' + c });
  }

  function renderHomeAttention() {
    var items = homeAttention(store.viewModels || [], 6);
    // 섹션 전체 클릭/커서 제거 — 이동은 아래 '전체보기' 액션만 담당.
    var card = el('div', { style: HOME_CARD + 'padding:21px 22px;' });
    var openDashboard = function () { store.state.view = 'dashboard'; render(); };
    var icon = el('div', { style: 'width:30px;height:30px;border-radius:8px;background:#fef3c7;display:flex;align-items:center;justify-content:center;flex:0 0 auto;' });
    icon.appendChild(svg([{ t: 'path', d: 'M12 9v4M12 17h.01' }, { t: 'path', d: 'M10.3 3.86l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.7-3.14l-8-14a2 2 0 0 0-3.4 0z' }], { size: 16, stroke: '#b45309' }));
    var titleWrap = el('div', { style: 'flex:1 1 0%;' });
    titleWrap.appendChild(el('div', { text: '주의가 필요한 프로젝트', style: 'font-size:15px;font-weight:600;letter-spacing:-0.01em;' }));
    titleWrap.appendChild(el('div', { text: '미커밋 · 미푸시 · 방치 ' + items.length + '건', style: 'font-size:11.5px;color:#a8a29e;margin-top:1px;' }));
    var open = el('span', {
      style: 'font-size:12.5px;font-weight:600;color:#4f46e5;display:inline-flex;align-items:center;gap:4px;cursor:pointer;',
      attrs: { role: 'button', tabindex: '0', 'aria-label': '주의가 필요한 프로젝트 전체보기' },
      on: {
        click: openDashboard,
        keydown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDashboard(); } },
      },
    });
    open.appendChild(el('span', { text: '전체보기' }));
    open.appendChild(el('span', { text: '→', style: 'font-size:14px;' }));
    var head = el('div', { style: 'display:flex;align-items:center;gap:10px;margin-bottom:15px;' });
    head.appendChild(icon); head.appendChild(titleWrap); head.appendChild(open);
    card.appendChild(head);

    var listWrap = el('div', { style: 'display:flex;flex-direction:column;gap:2px;' });
    if (items.length === 0) {
      listWrap.appendChild(el('div', { text: '모든 프로젝트가 깔끔합니다.', style: 'font-size:12.5px;color:#a8a29e;padding:8px 6px;' }));
    }
    items.forEach(function (vm, idx) {
      var row = el('div', { style: 'display:flex;align-items:center;gap:11px;padding:9px 6px;border-radius:9px;' + (idx > 0 ? 'border-top:1px solid #f4f3f1;' : '') });
      row.appendChild(el('span', { style: 'width:9px;height:9px;border-radius:2px;flex:0 0 auto;display:inline-block;background:' + langColor(vm.language) + ';' }));
      var nm = el('div', { style: 'flex:1 1 0%;min-width:0;' });
      nm.appendChild(el('div', { text: vm.name, style: 'font-size:13px;font-weight:600;color:#1c1917;' }));
      nm.appendChild(el('div', { text: vm.path, style: HOME_MONO + 'font-size:10.5px;color:#a8a29e;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;' }));
      row.appendChild(nm);
      if (vm.gitStatus === 'dirty') row.appendChild(homeBadge('미커밋' + ((vm.changes || 0) > 0 ? ' ' + vm.changes : ''), 'amber'));
      if ((vm.ahead || 0) > 0) row.appendChild(homeBadge('미푸시 ' + vm.ahead, 'blue'));
      if ((vm.behind || 0) > 0) row.appendChild(homeBadge('받을 ' + vm.behind, 'cyan')); // pull 필요
      row.appendChild(el('span', { text: vm.isStale ? rel(vm.lastModified) : rel(vm.lastModified), style: HOME_MONO + 'font-size:11px;color:#a8a29e;width:52px;text-align:right;flex:0 0 auto;' }));
      listWrap.appendChild(row);
    });
    card.appendChild(listWrap);
    return card;
  }

  function renderHomeProductivity() {
    var card = el('div', { style: HOME_CARD + 'padding:21px 22px;display:flex;gap:26px;' });
    // 좌: 주간 생산성(최근 7일 커밋)
    var leftCol = el('div', { style: 'flex:1.2 1 0%;min-width:0;' });
    var ca = store.commitActivity || { days: [] };
    var days = Array.isArray(ca.days) ? ca.days.slice(-7) : [];
    var total7 = days.reduce(function (s, d) { return s + (d.count || 0); }, 0);
    var hd = el('div', { style: 'display:flex;align-items:baseline;gap:9px;margin-bottom:3px;' });
    hd.appendChild(el('div', { text: '주간 생산성', style: 'font-size:15px;font-weight:600;flex:1 1 0%;' }));
    hd.appendChild(el('span', { text: total7 + ' 커밋', style: HOME_MONO + 'font-size:12.5px;font-weight:600;color:#1c1917;' }));
    leftCol.appendChild(hd);
    leftCol.appendChild(el('div', { text: store.commitActivityLoaded ? '최근 7일 커밋 빈도' : '집계하려면 새로고침…', style: 'font-size:11.5px;color:#a8a29e;margin-bottom:18px;' }));
    // [R-33/M10-P4] 차트 영역 2단 구조: .commit-chart-region(patchRegion 교체 대상) > .commit-chart-host
    //   (위젯이 차트 노드를 꽂는 컨테이너). 실제 차트 노드 생성·삽입·destroy·핸들러는 RG.widget('commitChart')
    //   단독 소유(_destroyById/_mountById). 폴링 갱신은 patchCommitChart()가 region 만 교체 → 깜빡임 0.
    var chartRegion = el('div', { cls: 'commit-chart-region' });
    chartRegion.appendChild(el('div', { cls: 'commit-chart-host', attrs: { 'aria-label': '최근 7일 커밋 빈도 차트' } }));
    leftCol.appendChild(chartRegion);
    card.appendChild(leftCol);
    card.appendChild(el('div', { style: 'width:1px;background:#f0efed;flex:0 0 auto;' }));
    // 우: 언어 · 스택 추세
    var rightCol = el('div', { style: 'flex:1 1 0%;min-width:0;' });
    rightCol.appendChild(el('div', { text: '언어 · 스택 추세', style: 'font-size:15px;font-weight:600;margin-bottom:3px;' }));
    var facets = languageFacets(store.viewModels || []);
    var totalProj = facets.reduce(function (s, f) { return s + f.count; }, 0) || 1;
    rightCol.appendChild(el('div', { text: '전체 ' + (store.viewModels || []).length + '개 기준', style: 'font-size:11.5px;color:#a8a29e;margin-bottom:18px;' }));
    var stack = el('div', { style: 'display:flex;height:8px;border-radius:5px;overflow:hidden;background:#f0efed;margin-bottom:14px;' });
    facets.forEach(function (f) { stack.appendChild(el('div', { style: 'width:' + (f.count / totalProj * 100) + '%;height:100%;background:' + langColor(f.lang) + ';' })); });
    rightCol.appendChild(stack);
    var legend = el('div', { style: 'display:flex;flex-direction:column;gap:9px;' });
    facets.slice(0, 5).forEach(function (f) {
      var row = el('div', { style: 'display:flex;align-items:center;gap:8px;font-size:12.5px;' });
      row.appendChild(el('span', { style: 'width:9px;height:9px;border-radius:2px;flex:0 0 auto;display:inline-block;background:' + langColor(f.lang) + ';' }));
      row.appendChild(el('span', { text: f.lang, style: 'flex:1 1 0%;color:#57534e;' }));
      row.appendChild(el('span', { text: String(f.count), style: HOME_MONO + 'color:#a8a29e;' }));
      var prevC = (store.langPrev || {})[f.lang];
      var diff = (typeof prevC === 'number') ? (f.count - prevC) : 0;
      row.appendChild(el('span', {
        text: diff > 0 ? '▲' : (diff < 0 ? '▼' : ''),
        style: HOME_MONO + 'font-size:10px;width:14px;text-align:right;color:' + (diff > 0 ? '#15803d' : (diff < 0 ? '#b45309' : '#d6d3d1')) + ';',
      }));
      legend.appendChild(row);
    });
    rightCol.appendChild(legend);
    card.appendChild(rightCol);
    return card;
  }

  function renderHomeActivity() {
    var events = homeRecentActivity(store.viewModels || [], 6);
    var card = el('div', { style: HOME_CARD + 'padding:21px 22px;' });
    card.appendChild(el('div', { text: '최근 활동 타임라인', style: 'font-size:15px;font-weight:600;margin-bottom:16px;' }));
    var list = el('div', { style: 'display:flex;flex-direction:column;' });
    if (events.length === 0) {
      list.appendChild(el('div', { text: '최근 수정 기록이 없습니다.', style: 'font-size:12.5px;color:#a8a29e;' }));
    }
    events.forEach(function (ev, i) {
      var vm = (store.viewModels || []).find(function (v) { return v.id === ev.id; }) || {};
      var row = el('div', { style: 'display:flex;gap:13px;' });
      var rail = el('div', { style: 'display:flex;flex-direction:column;align-items:center;flex:0 0 auto;' });
      rail.appendChild(el('span', { style: 'width:9px;height:9px;border-radius:2px;flex:0 0 auto;display:inline-block;background:' + langColor(vm.language || ev.name) + ';' }));
      if (i < events.length - 1) rail.appendChild(el('span', { style: 'width:1.5px;flex:1 1 0%;min-height:18px;background:#e7e5e4;margin-top:3px;' }));
      row.appendChild(rail);
      var body = el('div', { style: 'flex:1 1 0%;min-width:0;padding-bottom:15px;' });
      var top = el('div', { style: 'display:flex;align-items:center;gap:9px;' });
      top.appendChild(el('span', { text: ev.name, style: 'font-size:13px;font-weight:600;color:#1c1917;' }));
      top.appendChild(el('span', { text: rel(ev.when), style: HOME_MONO + 'font-size:10.5px;color:#a8a29e;' }));
      body.appendChild(top);
      var sub = (vm.gitStatus === 'dirty' && (vm.changes || 0) > 0) ? ('미커밋 변경 ' + vm.changes + '건')
        : ((vm.behind || 0) > 0 ? ('받을 커밋 ' + vm.behind + '개')
          : ((vm.ahead || 0) > 0 ? ('미푸시 커밋 ' + vm.ahead + '개') : '파일 수정'));
      body.appendChild(el('div', { text: (vm.language || '알 수 없음') + ' · ' + sub, style: 'font-size:11.5px;color:#78716c;margin-top:2px;' }));
      row.appendChild(body);
      list.appendChild(row);
    });
    card.appendChild(list);
    return card;
  }

  /** [백로그2-4] 할 일 마감 일시 → 표시 라벨·상태(overdue/near/soon/normal)·색. dueAt 없으면 null. */
  function todoDueInfo(dueAt, nowMs) {
    if (typeof dueAt !== 'number' || !isFinite(dueAt) || dueAt <= 0) return null;
    var now = (typeof nowMs === 'number') ? nowMs : ((store.now instanceof Date) ? store.now.getTime() : Date.now());
    var diff = dueAt - now;
    var d = new Date(dueAt);
    var hh = ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
    var dayMs = 86400000;
    var startToday = new Date(now); startToday.setHours(0, 0, 0, 0);
    var dayDelta = Math.floor((new Date(dueAt).setHours(0, 0, 0, 0) - startToday.getTime()) / dayMs);
    var dayLabel = (dayDelta === 0) ? '오늘' : (dayDelta === 1 ? '내일' : (dayDelta === -1 ? '어제' : (d.getMonth() + 1) + '/' + d.getDate()));
    var state, color;
    if (diff <= 0) { state = 'overdue'; color = '#dc2626'; }
    else if (diff <= 3600000) { state = 'near'; color = '#b45309'; }     // 1시간 이내
    else if (diff <= dayMs) { state = 'soon'; color = '#1d4ed8'; }       // 24시간 이내
    else { state = 'normal'; color = '#78716c'; }
    var label = (state === 'overdue' ? '지남 · ' : '') + dayLabel + ' ' + hh;
    return { state: state, color: color, label: label };
  }

  function renderHomeTodos() {
    var todos = Array.isArray(store.todos) ? store.todos : [];
    var open = todos.filter(function (t) { return !t.done; }).length;
    var card = el('div', { style: HOME_CARD + 'padding:21px 20px;' });
    var head = el('div', { style: 'display:flex;align-items:center;gap:10px;margin-bottom:15px;' });
    head.appendChild(el('div', { text: '할 일', style: 'font-size:15px;font-weight:600;flex:1 1 0%;' }));
    var cnt = el('span', { style: HOME_MONO + 'font-size:12px;font-weight:600;color:#1c1917;' });
    cnt.appendChild(el('span', { text: String(open) }));
    cnt.appendChild(el('span', { text: '/' + todos.length, style: 'color:#a8a29e;' }));
    head.appendChild(cnt);
    card.appendChild(head);

    // [백로그2-3] 행간 축소: 행 패딩·간격·줄높이 축소(8px/2px/1.4 → 5px/1px/1.3).
    var list = el('div', { style: 'display:flex;flex-direction:column;gap:1px;' });
    todos.forEach(function (t) {
      var due = t.done ? null : todoDueInfo(t.dueAt); // 완료 항목은 마감 강조 안 함
      var row = el('div', { cls: 'home-todo-row', style: 'display:flex;align-items:flex-start;gap:11px;padding:5px 4px;border-radius:8px;' });
      var box = el('span', {
        attrs: { role: 'checkbox', 'aria-checked': t.done ? 'true' : 'false', 'aria-label': '완료: ' + t.text, tabindex: '0' },
        style: 'width:18px;height:18px;border-radius:6px;flex:0 0 auto;display:flex;align-items:center;justify-content:center;margin-top:1px;cursor:pointer;' + (t.done ? 'border:1.5px solid #4f46e5;background:#4f46e5;' : 'border:1.5px solid #d6d3d1;background:#fff;'),
        on: { click: function () { onToggleTodo(t.id, !t.done); } },
      });
      if (t.done) box.appendChild(svg([{ t: 'path', d: 'M5 12l4 4 10-10' }], { size: 11, stroke: '#fff', sw: 3 }));
      row.appendChild(box);
      var txt = el('div', { style: 'flex:1 1 0%;min-width:0;' });
      var txtRow = el('div', { style: 'display:flex;align-items:baseline;gap:8px;' });
      txtRow.appendChild(el('div', { text: t.text, style: 'flex:1 1 0%;min-width:0;font-size:13px;line-height:1.3;' + (t.done ? 'color:#a8a29e;text-decoration:line-through;' : 'color:#1c1917;') }));
      // [백로그2-4] 마감 일시 배지(임박/경과 색 강조). 클릭하면 일시 변경(미설정 시 "+ 마감").
      var dueBadge = el('span', {
        cls: 'home-todo-due',
        text: due ? due.label : '+ 마감',
        attrs: { role: 'button', tabindex: '0', 'aria-label': '마감 일시 설정' },
        style: 'flex:0 0 auto;font-size:10.5px;font-weight:600;cursor:pointer;' + (due ? ('color:' + due.color + ';') : 'color:#c7c2bd;') + (due && due.state === 'overdue' ? 'text-decoration:underline;' : ''),
        on: { click: function () { openTodoDueEditor(t); } },
      });
      txtRow.appendChild(dueBadge);
      txt.appendChild(txtRow);
      txt.appendChild(el('button', {
        cls: 'home-todo-del', text: '삭제',
        attrs: { type: 'button', 'aria-label': '할 일 삭제: ' + t.text },
        style: 'appearance:none;border:none;background:none;cursor:pointer;padding:0;margin-top:1px;font-size:10.5px;color:#a8a29e;',
        on: { click: function () { onRemoveTodo(t.id); } },
      }));
      row.appendChild(txt);
      row.appendChild(el('span', { style: 'width:7px;height:7px;border-radius:50%;flex:0 0 auto;margin-top:6px;background:' + (t.done ? '#d6d3d1' : (due ? due.color : '#b45309')) + ';' }));
      list.appendChild(row);
    });
    card.appendChild(list);

    // [백로그2-4] 인라인 마감 일시 편집기(특정 할 일 선택 시) — datetime-local 입력 + 설정/해제.
    if (store.todoDueEditId) {
      var editing = todos.filter(function (t) { return t.id === store.todoDueEditId; })[0];
      if (editing) card.appendChild(renderTodoDueEditor(editing));
      else store.todoDueEditId = null;
    }

    // + 할 일 추가(클릭 시 인라인 입력)
    if (store.todoAdding) {
      var addWrap = el('div', { style: 'border-top:1px solid #f4f3f1;margin-top:10px;padding-top:12px;display:flex;flex-direction:column;gap:8px;' });
      var addRow = el('div', { style: 'display:flex;gap:8px;' });
      var input = el('input', { attrs: { type: 'text', placeholder: '할 일 입력 후 Enter', 'aria-label': '할 일 추가', autocomplete: 'off' }, style: 'flex:1;min-width:0;border:1px solid #e7e5e4;border-radius:8px;padding:7px 10px;font-size:12.5px;color:#1c1917;outline:none;' });
      input.value = store.todoInput;
      input.addEventListener('input', function (e) { store.todoInput = e.target.value || ''; });
      input.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); onAddTodo(); } if (e.key === 'Escape') { store.todoAdding = false; store.todoInput = ''; store.todoDueInput = ''; render(); } });
      var b = el('button', { text: '추가', attrs: { type: 'button' }, style: 'border:none;background:#4f46e5;color:#fff;border-radius:8px;padding:0 14px;font-size:12.5px;font-weight:600;cursor:pointer;', on: { click: onAddTodo } });
      if (store.busyTodos) { input.disabled = true; b.disabled = true; }
      addRow.appendChild(input); addRow.appendChild(b);
      addWrap.appendChild(addRow);
      // [백로그2-4] 선택 마감 일시(datetime-local). 비우면 마감 없음.
      var dueRow = el('div', { style: 'display:flex;align-items:center;gap:8px;' });
      dueRow.appendChild(el('span', { text: '마감(선택)', style: 'font-size:11px;color:#a8a29e;flex:0 0 auto;' }));
      var dueInput = el('input', { attrs: { type: 'datetime-local', 'aria-label': '마감 일시' }, style: 'flex:1;min-width:0;border:1px solid #e7e5e4;border-radius:8px;padding:6px 9px;font-size:12px;color:#57534e;outline:none;' });
      dueInput.value = store.todoDueInput || '';
      dueInput.addEventListener('input', function (e) { store.todoDueInput = e.target.value || ''; });
      if (store.busyTodos) dueInput.disabled = true;
      dueRow.appendChild(dueInput);
      addWrap.appendChild(dueRow);
      card.appendChild(addWrap);
      setTimeout(function () { try { input.focus(); } catch (_) { } }, 0);
    } else {
      var add = el('div', {
        style: 'border-top:1px solid #f4f3f1;margin-top:10px;padding-top:12px;display:flex;align-items:center;gap:7px;color:#a8a29e;font-size:12.5px;font-weight:600;cursor:pointer;',
        attrs: { role: 'button', tabindex: '0', 'aria-label': '할 일 추가' },
        on: { click: function () { store.todoAdding = true; render(); } },
      });
      add.appendChild(el('span', { text: '+', style: 'font-size:15px;line-height:1;' }));
      add.appendChild(el('span', { text: ' 할 일 추가' }));
      card.appendChild(add);
    }
    return card;
  }

  function applyTodoResult(res) {
    if (res && res.ok && Array.isArray(res.todos)) { store.todos = res.todos; return true; }
    return false;
  }
  /** [백로그2-4] datetime-local 문자열('YYYY-MM-DDTHH:mm') → ms(로컬). 빈/무효는 null. */
  function parseDueInput(v) {
    if (typeof v !== 'string' || !v) return null;
    var t = Date.parse(v); // datetime-local은 로컬 시간으로 해석
    return (typeof t === 'number' && isFinite(t)) ? t : null;
  }
  /** ms → datetime-local 입력값('YYYY-MM-DDTHH:mm', 로컬). 없으면 ''. */
  function toDueInput(ms) {
    if (typeof ms !== 'number' || !isFinite(ms) || ms <= 0) return '';
    var d = new Date(ms);
    var p = function (n) { return ('0' + n).slice(-2); };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  async function onAddTodo() {
    var v = (store.todoInput || '').trim();
    if (!v) { toast('할 일 내용을 입력하세요.', true); return; }
    if (store.busyTodos || !bridgeHas('addTodo')) return;
    var dueAt = parseDueInput(store.todoDueInput);
    store.busyTodos = true; render();
    var res = await ipc('addTodo', v, dueAt);
    store.busyTodos = false;
    if (applyTodoResult(res)) { store.todoInput = ''; store.todoDueInput = ''; store.todoAdding = false; }
    else toast(res && res.code === 'LIMIT' ? '할 일이 너무 많습니다.' : '할 일 추가에 실패했습니다.', true);
    // [F-1] todoAdding(editing) 해제 가능 지점 — release()로 즉시 1회 반영 + 잔류 pending 소비.
    RG.coalesce.release();
    maybeFlushCommitRefresh(); // [M10-P1] editing 해제 → 보류된 커밋 폴링 따라감
  }
  /** [백로그2-4] 특정 할 일의 마감 편집기 열기(인라인). */
  function openTodoDueEditor(t) {
    store.todoDueEditId = t.id;
    store.todoDueEditInput = toDueInput(t.dueAt);
    render();
  }
  /** [백로그2-4] 마감 일시 편집기 UI(설정/해제). */
  function renderTodoDueEditor(t) {
    var wrap = el('div', { style: 'border-top:1px solid #f4f3f1;margin-top:8px;padding-top:10px;display:flex;flex-direction:column;gap:8px;' });
    wrap.appendChild(el('div', { text: '“' + t.text + '” 마감 일시', style: 'font-size:11.5px;color:#78716c;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;' }));
    var row = el('div', { style: 'display:flex;gap:8px;align-items:center;' });
    var inp = el('input', { attrs: { type: 'datetime-local', 'aria-label': '마감 일시 변경' }, style: 'flex:1;min-width:0;border:1px solid #e7e5e4;border-radius:8px;padding:6px 9px;font-size:12px;color:#57534e;outline:none;' });
    inp.value = store.todoDueEditInput || '';
    inp.addEventListener('input', function (e) { store.todoDueEditInput = e.target.value || ''; });
    row.appendChild(inp);
    row.appendChild(el('button', { text: '설정', attrs: { type: 'button' }, style: 'border:none;background:#4f46e5;color:#fff;border-radius:8px;padding:6px 12px;font-size:12px;font-weight:600;cursor:pointer;flex:0 0 auto;', on: { click: function () { onSetTodoDue(t.id, parseDueInput(store.todoDueEditInput)); } } }));
    if (t.dueAt) row.appendChild(el('button', { text: '해제', attrs: { type: 'button' }, style: 'border:1px solid #e7e5e4;background:#fff;color:#78716c;border-radius:8px;padding:6px 12px;font-size:12px;cursor:pointer;flex:0 0 auto;', on: { click: function () { onSetTodoDue(t.id, null); } } }));
    row.appendChild(el('button', { text: '닫기', attrs: { type: 'button' }, style: 'border:none;background:none;color:#a8a29e;font-size:12px;cursor:pointer;flex:0 0 auto;', on: { click: function () { store.todoDueEditId = null; render(); } } }));
    wrap.appendChild(row);
    return wrap;
  }
  async function onSetTodoDue(id, dueAt) {
    if (store.busyTodos || !bridgeHas('setTodoDue')) { store.todoDueEditId = null; render(); return; }
    store.busyTodos = true; render();
    var res = await ipc('setTodoDue', id, dueAt);
    store.busyTodos = false;
    if (applyTodoResult(res)) { store.todoDueEditId = null; store.notifiedDue.delete(id); } // 재설정 시 알림 재무장
    else toast('마감 일시 설정에 실패했습니다.', true);
    render();
  }
  async function onToggleTodo(id, done) {
    if (store.busyTodos || !bridgeHas('toggleTodo')) return;
    store.busyTodos = true; render();
    var res = await ipc('toggleTodo', id, done);
    store.busyTodos = false;
    if (!applyTodoResult(res)) toast('할 일 상태 변경에 실패했습니다.', true);
    render();
  }
  async function onRemoveTodo(id) {
    if (store.busyTodos || !bridgeHas('removeTodo')) return;
    store.busyTodos = true; render();
    var res = await ipc('removeTodo', id);
    store.busyTodos = false;
    if (!applyTodoResult(res)) toast('할 일 삭제에 실패했습니다.', true);
    render();
  }

  /** [M11] 메일 섹션 2단 구조: .mail-region(patchRegion 교체 대상) > 카드. 폴링 갱신 시 region 만 교체. */
  function renderHomeMail() {
    var region = el('div', { cls: 'mail-region' });
    region.appendChild(renderHomeMailCard());
    return region;
  }
  /** 메일 카드 본문(patchMailSection 의 builderFn 이 재사용). 내용·동작은 기존과 동일. */
  function renderHomeMailCard() {
    var card = el('div', { style: HOME_CARD + 'padding:21px 20px;' });
    var items = mailFlatItems(5);
    var replies = items.filter(function (m) { return homeIsReply(m.subject); }).length;
    var head = el('div', { style: 'display:flex;align-items:center;gap:10px;margin-bottom:14px;' });
    head.appendChild(el('div', { text: '메일', style: 'font-size:15px;font-weight:600;flex:1 1 0%;' }));
    if (replies > 0) head.appendChild(homeBadge(replies + ' 회신 필요', 'blue'));
    // 헤더 → 메일함(보관함) 팝업 열기(항목 클릭은 본문 팝업). 계정 설정은 팝업 안/전역 설정에서.
    head.appendChild(el('button', {
      cls: 'home-mail-more', text: '메일함',
      attrs: { type: 'button', 'aria-label': '메일함 열기', title: '메일함 — 계정·메일함별 수집 메일' },
      style: 'appearance:none;border:none;background:none;cursor:pointer;font-size:12px;font-weight:600;color:#4f46e5;padding:0 2px;',
      on: { click: function () { openMailbox(); } },
    }));
    card.appendChild(head);

    var list = el('div', { style: 'display:flex;flex-direction:column;' });
    if (!store.mailSummaryLoaded && store.busyMailSummary) {
      list.appendChild(el('div', { text: '메일을 확인하는 중…', style: 'font-size:12px;color:#a8a29e;padding:6px 0;' }));
    } else if (items.length === 0) {
      list.appendChild(el('div', { text: '안 읽은 메일이 없습니다. 설정에서 계정을 추가하세요.', style: 'font-size:12px;color:#a8a29e;padding:6px 0;' }));
    }
    items.forEach(function (m, i) {
      var clickable = Number.isInteger(m.uid) && bridgeHas('getMailMessage');
      var row = el('div', {
        cls: clickable ? 'home-mail-row' : '',
        attrs: clickable ? { role: 'button', tabindex: '0', 'aria-label': '메일 보기: ' + (m.subject || '') } : {},
        style: 'display:flex;align-items:center;gap:11px;padding:9px 2px;' + (i > 0 ? 'border-top:1px solid #f4f3f1;' : '') + (clickable ? 'cursor:pointer;' : ''),
        on: clickable ? { click: function () { openMailMessage(m.accountId, m.uid, { subject: m.subject, from: m.from, date: m.date, mailbox: m.mailbox }); } } : {},
      });
      var av = homeAvatarColors(i);
      var name = m.from || '(발신자)';
      row.appendChild(el('span', { text: (name[0] || '?'), style: 'width:30px;height:30px;border-radius:9px;flex:0 0 auto;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:700;background:' + av.bg + ';color:' + av.fg + ';' }));
      var mid = el('div', { style: 'flex:1 1 0%;min-width:0;' });
      var nameRow = el('div', { style: 'display:flex;align-items:center;gap:7px;' });
      nameRow.appendChild(el('span', { text: name, style: 'font-size:12.5px;font-weight:700;color:#1c1917;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;' }));
      if (homeIsReply(m.subject)) nameRow.appendChild(el('span', { text: '회신', style: 'font-size:9.5px;font-weight:600;padding:1px 6px;border-radius:5px;background:#fef3c7;color:#b45309;flex:0 0 auto;' }));
      mid.appendChild(nameRow);
      mid.appendChild(el('div', { text: m.subject || '(제목 없음)', style: 'font-size:12px;color:#57534e;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px;' }));
      row.appendChild(mid);
      row.appendChild(el('span', { text: relMail(m.date), style: HOME_MONO + 'font-size:10.5px;color:#a8a29e;flex:0 0 auto;' }));
      list.appendChild(row);
    });
    card.appendChild(list);
    return card;
  }

  /** 메일 본문 팝업 — 항목 클릭 시 단건 본문 조회(읽음표시 영향 없음).
   *   제목·발신자·날짜는 목록(엔벨로프 — 정확 디코드)의 known 값을 우선 사용한다. 원시 헤더가 MIME 인코딩
   *   없는 레거시 charset(예: raw EUC-KR)이면 본문 파서의 헤더가 깨질 수 있어, 신뢰 가능한 known을 쓴다. */
  async function openMailMessage(accountId, uid, known) {
    if (!bridgeHas('getMailMessage') || !Number.isInteger(uid)) return;
    known = (known && typeof known === 'object') ? known : {};
    store._mailViewNonce = (store._mailViewNonce || 0) + 1; // 새 메일 → iframe 리로드 키
    store.mailView = { open: true, loading: true, accountId: accountId, uid: uid, meta: null, code: null, known: known, showImages: false };
    store._mailViewShown = false;
    render();
    // 본문은 메일이 속한 메일함(known.mailbox)에서 조회한다. 없으면 main이 INBOX로 폴백.
    var res = await ipc('getMailMessage', accountId, uid, known.mailbox);
    if (!store.mailView.open || store.mailView.uid !== uid) return; // 닫혔거나 다른 메일 — 무시
    store.mailView.loading = false;
    if (res && res.ok) {
      store.mailView.meta = {
        subject: known.subject || res.subject,
        from: known.from || res.from,
        date: known.date || res.date,
        text: res.text,
        hasHtml: !!res.hasHtml, // [메일 뷰어] 격리 iframe(app://mailbody) 렌더 가능 여부
      };
      // 열람 시 서버에서 읽음 처리됨 → 메일함 팝업 표시도 즉시 읽음 반영(낙관적, 다음 동기화에 영속).
      if (store.mailbox && store.mailbox.open && known.mailbox) markArchiveItemSeenLocal(accountId, known.mailbox, uid);
    } else store.mailView.code = (res && res.code) || 'NETWORK';
    render();
  }
  /** [메일 뷰어] 격리 이메일 문서 src — nonce로 리로드, img=1이면 원격 이미지 허용(CSP가 통제). */
  function mailViewerSrc() {
    // 메인 페이지와 동일 origin(app://index.html)에 ?mailview=1로 — 'self' 프레이밍 가능. 응답 CSP는 메인이 이메일용 부여.
    return 'app://index.html?mailview=1&n=' + (store._mailViewNonce || 0) + (store.mailView.showImages ? '&img=1' : '');
  }
  function toggleMailImages() {
    store.mailView.showImages = !store.mailView.showImages;
    store._mailViewNonce = (store._mailViewNonce || 0) + 1; // 정책 변경 → iframe 리로드
    render();
  }
  function closeMailMessage() {
    store.mailView = { open: false, loading: false, accountId: null, uid: null, meta: null, code: null };
    store._mailViewShown = false;
    render();
  }

  /* ===== 메일함(보관함) 팝업 — 계정별·메일함별 수집 메일(영속). 헤더 '메일함' 버튼으로 연다. ===== */
  function openMailbox() {
    if (!bridgeHas('getMailArchive')) { openSettings(); return; } // 구버전 preload 폴백
    store.mailbox = { open: true, loading: true, syncing: false, accounts: [], code: null, selAccount: null, selMailbox: null, errors: [] };
    store._mailboxShown = false;
    render();
    refreshMailArchive();
  }
  function closeMailbox() {
    store.mailbox = { open: false, loading: false, syncing: false, accounts: [], code: null, selAccount: null, selMailbox: null, errors: [] };
    store._mailboxShown = false;
    render();
  }
  /** 보관함을 디스크에서 읽어 표시한 뒤(즉시), 곧바로 서버 동기화를 한 번 돌린다. */
  async function refreshMailArchive() {
    var res = await ipc('getMailArchive');
    if (!store.mailbox.open) return;
    store.mailbox.loading = false;
    if (res && res.ok) { store.mailbox.accounts = res.accounts || []; ensureMailboxSelection(); }
    else store.mailbox.code = (res && res.code) || 'NETWORK';
    render();
    syncMailbox(); // 최신 상태로 동기화(읽음/삭제 반영)
  }
  /** 서버에서 전 메일함 인덱스를 수집해 보관함과 병합·영속(읽음/삭제 상태 동기화). */
  async function syncMailbox() {
    if (!bridgeHas('syncMailArchive') || store.mailbox.syncing) return;
    store.mailbox.syncing = true; render();
    var res = await ipc('syncMailArchive');
    if (!store.mailbox.open) return;
    store.mailbox.syncing = false;
    if (res && res.ok) {
      store.mailbox.accounts = res.accounts || [];
      store.mailbox.errors = Array.isArray(res.errors) ? res.errors : [];
      ensureMailboxSelection();
    }
    render();
  }
  /** 선택된 계정/메일함이 유효하지 않으면 첫 항목으로 보정. */
  function ensureMailboxSelection() {
    var accts = store.mailbox.accounts || [];
    var acct = accts.find(function (a) { return a.accountId === store.mailbox.selAccount; });
    if (!acct) acct = accts.find(function (a) { return a.mailboxes && a.mailboxes.length; }) || accts[0] || null;
    store.mailbox.selAccount = acct ? acct.accountId : null;
    if (!acct) { store.mailbox.selMailbox = null; return; }
    var mb = (acct.mailboxes || []).find(function (m) { return m.name === store.mailbox.selMailbox; });
    if (!mb) mb = (acct.mailboxes || [])[0] || null;
    store.mailbox.selMailbox = mb ? mb.name : null;
  }
  function selectMailbox(accountId, mailbox) {
    store.mailbox.selAccount = accountId;
    store.mailbox.selMailbox = mailbox;
    render();
  }
  /** 메일함 팝업에서 계정 설정으로 이동(전역 설정 '연동' 탭). */
  function mailboxOpenSettings() {
    closeMailbox();
    store.settingsTab = 'integration';
    openSettings();
  }
  function describeMailboxDeleteError(res) {
    var c = res && res.code;
    if (c === 'AUTH') return '메일 로그인에 실패해 삭제하지 못했습니다.';
    if (c === 'NETWORK') return '서버 연결 실패로 삭제하지 못했습니다.';
    return '삭제에 실패했습니다.';
  }
  /** 단건 메일 삭제 — 서버 휴지통으로 이동 + 로컬 보관함에서 제거. */
  async function deleteMailboxMail(accountId, mailbox, uid) {
    if (!bridgeHas('deleteMailArchiveItem') || store.mailbox.busy) return;
    store.mailbox.busy = true; render();
    var res = await ipc('deleteMailArchiveItem', accountId, mailbox, uid);
    store.mailbox.busy = false;
    if (!store.mailbox.open) return;
    if (res && res.ok) { store.mailbox.accounts = res.accounts || []; ensureMailboxSelection(); toast('메일을 휴지통으로 옮겼습니다.'); }
    else toast(describeMailboxDeleteError(res), true);
    render();
  }
  /** 메일함(폴더) 비우기 — 그 폴더의 서버 메일을 일괄 휴지통으로 이동 + 로컬 제거. 대량이라 확인 후 진행. */
  async function clearMailboxFolder(accountId, mailbox, label) {
    if (!bridgeHas('deleteMailArchiveItem') || store.mailbox.busy) return;
    if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
      if (!window.confirm('“' + (label || mailbox) + '” 메일함의 메일을 서버 휴지통으로 모두 옮깁니다. 계속할까요?')) return;
    }
    store.mailbox.busy = true; render();
    var res = await ipc('deleteMailArchiveItem', accountId, mailbox);
    store.mailbox.busy = false;
    if (!store.mailbox.open) return;
    if (res && res.ok) { store.mailbox.accounts = res.accounts || []; ensureMailboxSelection(); toast('메일함을 비웠습니다(휴지통 이동).'); }
    else toast(describeMailboxDeleteError(res), true);
    render();
  }
  /** 메일을 열었을 때(서버 읽음 처리됨) 보관함 표시도 즉시 읽음으로 반영(낙관적 — 다음 동기화에 영속). */
  function markArchiveItemSeenLocal(accountId, mailbox, uid) {
    var accts = (store.mailbox && store.mailbox.accounts) || [];
    var a = accts.find(function (x) { return x.accountId === accountId; });
    var mb = a && (a.mailboxes || []).find(function (m) { return m.name === mailbox; });
    if (!mb) return;
    var it = (mb.items || []).find(function (x) { return x.uid === uid; });
    if (it && !it.seen) { it.seen = true; mb.unread = (mb.items || []).filter(function (x) { return x.onServer && !x.seen; }).length; }
  }
  function renderMailboxModal() {
    var mx = store.mailbox;
    var enter = !store._mailboxShown; store._mailboxShown = true;
    var body = [];

    // 상단 도구 막대: 동기화 / 계정 설정 / 오류.
    var bar = el('div', { style: 'display:flex;align-items:center;gap:8px;margin-bottom:12px;flex-wrap:wrap;' });
    var syncAttrs = { type: 'button', title: '서버에서 전 메일함을 다시 수집' };
    if (mx.syncing) syncAttrs.disabled = 'disabled';
    bar.appendChild(el('button', {
      text: mx.syncing ? '동기화 중…' : '동기화',
      attrs: syncAttrs,
      style: 'appearance:none;border:1px solid #e7e5e4;border-radius:8px;background:#fff;cursor:pointer;font-size:12px;font-weight:600;color:#4f46e5;padding:6px 12px;' + (mx.syncing ? 'opacity:.6;cursor:default;' : ''),
      on: { click: function () { syncMailbox(); } },
    }));
    bar.appendChild(el('button', {
      text: '계정 설정',
      attrs: { type: 'button', title: '메일 계정 추가·수정(연동 설정)' },
      style: 'appearance:none;border:1px solid #e7e5e4;border-radius:8px;background:#fff;cursor:pointer;font-size:12px;font-weight:600;color:#57534e;padding:6px 12px;',
      on: { click: function () { mailboxOpenSettings(); } },
    }));
    if (mx.errors && mx.errors.length) {
      bar.appendChild(el('span', { text: '일부 계정 동기화 실패(' + mx.errors.length + ')', style: 'font-size:11.5px;color:#b91c1c;' }));
    }
    body.push(bar);

    if (mx.loading) {
      body.push(el('div', { style: 'color:#a8a29e;font-size:13px;padding:16px 0;', text: '메일함을 불러오는 중…' }));
      return buildModal({ title: '메일함', subtitle: '계정·메일함별 수집 메일 (로컬 보관)', onClose: closeMailbox, wide: true, enter: enter, bodyChildren: body });
    }
    if (mx.code) {
      body.push(el('div', { style: 'color:#b91c1c;font-size:13px;padding:16px 0;', text: '보관함을 불러오지 못했습니다.' }));
      return buildModal({ title: '메일함', subtitle: '계정·메일함별 수집 메일 (로컬 보관)', onClose: closeMailbox, wide: true, enter: enter, bodyChildren: body });
    }
    var accts = mx.accounts || [];
    if (!accts.length) {
      body.push(el('div', { style: 'color:#78716c;font-size:13px;padding:16px 0;line-height:1.7;', children: [
        el('div', { text: '등록된 메일 계정이 없습니다.' }),
        el('div', { text: '“계정 설정”에서 IMAP 계정을 추가하면 메일함이 채워집니다.' }),
      ]}));
      return buildModal({ title: '메일함', subtitle: '계정·메일함별 수집 메일 (로컬 보관)', onClose: closeMailbox, wide: true, enter: enter, bodyChildren: body });
    }

    // 본문: 좌(계정→메일함 트리) / 우(선택 메일함의 메일 목록).
    var wrap = el('div', { style: 'display:flex;gap:16px;align-items:flex-start;min-height:320px;' });

    // 좌측 트리.
    var tree = el('div', { cls: 'mailbox-tree', style: 'flex:0 0 230px;max-height:60vh;overflow:auto;border-right:1px solid #f4f3f1;padding-right:10px;' });
    accts.forEach(function (a) {
      tree.appendChild(el('div', { text: a.label || a.host || a.accountId, title: a.user || '', style: 'font-size:12px;font-weight:700;color:#1c1917;margin:10px 0 4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;' }));
      if (!a.mailboxes || !a.mailboxes.length) {
        tree.appendChild(el('div', { text: '(수집된 메일 없음)', style: 'font-size:11px;color:#a8a29e;padding:2px 0 2px 8px;' }));
        return;
      }
      a.mailboxes.forEach(function (m) {
        var active = a.accountId === mx.selAccount && m.name === mx.selMailbox;
        var mbLabel = m.displayName || m.name; // 표시는 디코드된 한글, 동작(select)은 원본 name
        var row = el('div', {
          attrs: { role: 'button', tabindex: '0', title: mbLabel },
          style: 'display:flex;align-items:center;gap:6px;padding:5px 8px;border-radius:7px;cursor:pointer;font-size:12px;' + (active ? 'background:#eef2ff;color:#4338ca;font-weight:600;' : 'color:#57534e;'),
          on: { click: (function (id, nm) { return function () { selectMailbox(id, nm); }; })(a.accountId, m.name) },
        });
        row.appendChild(el('span', { text: mbLabel, style: 'flex:1 1 0%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;' }));
        if (m.unread > 0) row.appendChild(el('span', { text: String(m.unread), style: 'flex:0 0 auto;font-size:10px;font-weight:700;background:#4f46e5;color:#fff;border-radius:9px;padding:1px 6px;' }));
        row.appendChild(el('span', { text: String(m.total), style: 'flex:0 0 auto;font-size:10px;color:#a8a29e;' }));
        tree.appendChild(row);
      });
    });
    wrap.appendChild(tree);

    // 우측 메일 목록.
    var listWrap = el('div', { cls: 'mailbox-list', style: 'flex:1 1 0%;min-width:0;max-height:60vh;overflow:auto;' });
    var selAcct = accts.find(function (a) { return a.accountId === mx.selAccount; });
    var selMb = selAcct && (selAcct.mailboxes || []).find(function (m) { return m.name === mx.selMailbox; });
    if (!selMb) {
      listWrap.appendChild(el('div', { text: '메일함을 선택하세요.', style: 'color:#a8a29e;font-size:13px;padding:16px 0;' }));
    } else {
      var mbHead = el('div', { style: 'display:flex;align-items:center;gap:8px;margin-bottom:8px;' });
      mbHead.appendChild(el('div', { text: selMb.displayName || selMb.name, style: 'font-size:13px;font-weight:700;color:#1c1917;flex:1 1 0%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;' }));
      mbHead.appendChild(el('span', { text: '전체 ' + selMb.total + ' · 안읽음 ' + selMb.unread, style: 'font-size:11px;color:#a8a29e;flex:0 0 auto;' }));
      if (selMb.total > 0) mbHead.appendChild(el('button', {
        text: '비우기',
        attrs: { type: 'button', title: '이 메일함의 메일을 서버 휴지통으로 모두 옮깁니다' },
        style: 'appearance:none;border:1px solid #fecaca;border-radius:7px;background:#fff;cursor:pointer;font-size:11px;color:#b91c1c;padding:4px 9px;flex:0 0 auto;',
        on: { click: (function (id, nm, label) { return function () { clearMailboxFolder(id, nm, label); }; })(selAcct.accountId, selMb.name, selMb.displayName || selMb.name) },
      }));
      listWrap.appendChild(mbHead);

      var items = selMb.items || [];
      if (!items.length) {
        listWrap.appendChild(el('div', { text: '메일이 없습니다.', style: 'color:#a8a29e;font-size:13px;padding:12px 0;' }));
      }
      items.forEach(function (m, i) {
        var clickable = Number.isInteger(m.uid) && bridgeHas('getMailMessage');
        var row = el('div', {
          style: 'display:flex;align-items:center;gap:10px;padding:8px 4px;' + (i > 0 ? 'border-top:1px solid #f4f3f1;' : ''),
        });
        // 읽음/안읽음 점.
        row.appendChild(el('span', {
          attrs: { title: m.seen ? '읽음' : '안읽음' },
          style: 'flex:0 0 auto;width:8px;height:8px;border-radius:50%;background:' + (m.onServer && !m.seen ? '#4f46e5' : '#d6d3d1') + ';',
        }));
        var mid = el('div', {
          style: 'flex:1 1 0%;min-width:0;cursor:' + (clickable ? 'pointer' : 'default') + ';',
          attrs: clickable ? { role: 'button', tabindex: '0', 'aria-label': '메일 보기: ' + (m.subject || '') } : {},
          on: clickable ? { click: (function (id, uid, known) { return function () { openMailMessage(id, uid, known); }; })(selAcct.accountId, m.uid, { subject: m.subject, from: m.from, date: m.date, mailbox: selMb.name }) } : {},
        });
        var top = el('div', { style: 'display:flex;align-items:center;gap:7px;' });
        top.appendChild(el('span', { text: m.from || '(발신자)', style: 'font-size:12.5px;font-weight:' + (m.seen ? '500' : '700') + ';color:#1c1917;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:240px;' }));
        if (!m.onServer) top.appendChild(el('span', { text: '서버 삭제됨', style: 'flex:0 0 auto;font-size:9.5px;font-weight:600;padding:1px 6px;border-radius:5px;background:#f5f5f4;color:#a8a29e;' }));
        mid.appendChild(top);
        mid.appendChild(el('div', { text: m.subject || '(제목 없음)', style: 'font-size:12px;color:#57534e;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px;' }));
        row.appendChild(mid);
        row.appendChild(el('span', { text: relMail(m.date), style: HOME_MONO + 'font-size:10.5px;color:#a8a29e;flex:0 0 auto;' }));
        row.appendChild(el('button', {
          text: '×',
          attrs: { type: 'button', 'aria-label': '메일 삭제(휴지통으로 이동)', title: '삭제 — 서버 휴지통으로 이동' },
          style: 'appearance:none;border:none;background:none;cursor:pointer;font-size:15px;color:#d6d3d1;flex:0 0 auto;padding:0 4px;',
          on: { click: (function (id, nm, uid) { return function (e) { e.stopPropagation(); deleteMailboxMail(id, nm, uid); }; })(selAcct.accountId, selMb.name, m.uid) },
        }));
        listWrap.appendChild(row);
      });
    }
    wrap.appendChild(listWrap);
    body.push(wrap);

    return buildModal({ title: '메일함', subtitle: '계정·메일함별 수집 메일 (열람=서버 읽음 · 삭제=서버 휴지통)', onClose: closeMailbox, wide: true, enter: enter, bodyChildren: body });
  }

  function renderMailMessageModal() {
    var mv = store.mailView;
    var enter = !store._mailViewShown; store._mailViewShown = true;
    var body = [];
    if (mv.loading) {
      body.push(el('div', { cls: 'home-card__empty', text: '메일을 불러오는 중…' }));
    } else if (mv.code) {
      body.push(el('div', { cls: 'home-card__empty', text: describeMailError({ code: mv.code }) }));
    } else if (mv.meta) {
      var meta = el('div', { style: 'font-size:12px;color:#78716c;margin-bottom:12px;line-height:1.7;border-bottom:1px solid #f0efed;padding-bottom:10px;' });
      if (mv.meta.from) meta.appendChild(el('div', { text: '보낸사람 · ' + mv.meta.from }));
      if (mv.meta.date) meta.appendChild(el('div', { text: '날짜 · ' + mv.meta.date }));
      body.push(meta);
      if (mv.meta.hasHtml && bridgeHas('getMailMessage')) {
        // [메일 뷰어] 격리 iframe(app://mailbody, 자체 CSP·sandbox)으로 HTML 렌더. 스크립트 차단·원격이미지 기본 차단.
        var bar = el('div', { style: 'display:flex;align-items:center;gap:8px;margin-bottom:8px;' });
        bar.appendChild(el('button', {
          cls: 'btn btn--sm',
          text: mv.showImages ? '이미지 숨기기' : '이미지 표시',
          attrs: { type: 'button', 'aria-label': mv.showImages ? '원격 이미지 숨기기' : '원격 이미지 표시' },
          on: { click: toggleMailImages },
        }));
        bar.appendChild(el('span', { text: mv.showImages ? '원격 이미지를 불러옵니다(발신자가 열람을 알 수 있음).' : '개인정보 보호를 위해 원격 이미지는 기본 차단됩니다.', style: 'font-size:11px;color:#a8a29e;' }));
        body.push(bar);
        var frame = el('iframe', {
          cls: 'mail-frame',
          attrs: {
            src: mailViewerSrc(),
            sandbox: '',                 // 스크립트·폼·팝업·동일출처 전면 차단(최대 제한)
            referrerpolicy: 'no-referrer',
            title: '메일 본문',
            'aria-label': '메일 본문(격리 렌더)',
          },
        });
        body.push(frame);
      } else {
        body.push(el('pre', {
          text: (mv.meta.text && mv.meta.text.length) ? mv.meta.text : '(본문 없음)',
          style: 'white-space:pre-wrap;word-break:break-word;font-family:inherit;font-size:13px;line-height:1.65;color:#1c1917;margin:0;',
        })); // L-1: textContent(pre). HTML 파트가 없으면 평문 표시.
      }
    }
    return buildModal({
      titleId: 'mailmsg-title',
      title: (mv.meta && mv.meta.subject) ? mv.meta.subject : '메일',
      subtitle: '안 읽은 메일 본문 미리보기(읽음 표시 안 됨)',
      onClose: closeMailMessage, wide: true, enter: enter, bodyChildren: body,
    });
  }

  /** 홈 진입 시 1회 자동 로드(이후는 카드 클릭/설정에서 갱신). */
  function maybeLoadMailSummary() {
    if (bridgeHas('getMailSummary') && !store.mailSummaryLoaded && !store.busyMailSummary) refreshMailSummary();
  }
  // [백로그2-2] 경량 위젯 이벤트 버스 — 위젯 간 상호작용의 단일 통지 지점(렌더러 내, 외부 egress 아님).
  //   on(event, fn)→unsubscribe, emit(event, data). 구독자 예외는 격리(다른 구독자 영향 0).
  var EV = (function () {
    var map = {};
    return {
      on: function (ev, fn) { (map[ev] || (map[ev] = [])).push(fn); return function () { map[ev] = (map[ev] || []).filter(function (x) { return x !== fn; }); }; },
      emit: function (ev, data) { (map[ev] || []).slice().forEach(function (fn) { try { fn(data); } catch (_) { /* 구독자 예외 격리 */ } }); },
    };
  })();

  var _lastMailSummaryKey = '';
  async function refreshMailSummary(opts) {
    opts = opts || {};
    if (!bridgeHas('getMailSummary') || store.busyMailSummary) return;
    store.busyMailSummary = true;
    // [M11] silent(폴링/push)면 진입 로딩 render 생략 — fetch 동안 이전 메일 목록 유지(깜빡임 0).
    //   최초/수동(silent 아님)은 기존대로 로딩 표시용 render.
    if (!opts.silent && store.state.view === 'home') render();
    var res = await ipc('getMailSummary');
    store.busyMailSummary = false;
    store.mailSummaryLoaded = true;
    store.mailSummary = (res && res.ok && Array.isArray(res.accounts)) ? res.accounts : [];
    // [M11] 완료부 — 데이터 무변경이면 skip, 변경 시 메일 섹션 영역만 patchRegion 교체.
    if (store.state.view === 'home') onMailSummaryFetched();
    maybeFlushCommitRefresh(); // [M10-P1] busyMail 해제 → 보류된 커밋 폴링 따라감
  }
  /** [M11] 메일 요약 fetch 완료부 — diff 키 동일 시 갱신 skip, 변경 시 영역만 patch. */
  function onMailSummaryFetched() {
    var newKey = mailSummaryKey(store.mailSummary);
    if (newKey === _lastMailSummaryKey) { RG.coalesce.flushIfPending(); return; } // 무변경 → 보류분만 소비
    _lastMailSummaryKey = newKey;
    // [백로그2-2] 실제 변화만 위젯 이벤트 버스로 브로드캐스트 — 구독한 위젯(KPI·브리핑·메일)이 상호작용.
    EV.emit('mail:changed', { unread: mailUnreadTotal() });
  }
  function maybeLoadCommitActivity() {
    if (bridgeHas('getCommitActivity') && !store.commitActivityLoaded && !store.busyCommitActivity) refreshCommitActivity();
  }
  // [항목2] Claude Code 로컬 로그 토큰 사용량 — 무거운 스캔이라 홈 진입 시 1회만 자동 로드(수동 새로고침 가능).
  function maybeLoadClaudeUsage() {
    if (bridgeHas('getClaudeUsage') && !store.claudeUsageLoaded && !store.busyClaudeUsage) refreshClaudeUsage();
  }
  /** [연결 모델 사용량 갱신] 브리핑 생성 완료 후 aiUsage만 좁게 다시 읽어 위젯 반영(다른 store 상태 불변).
   *   메인이 생성 시 누적·영속하므로, onDone 시 재조회해야 "연결된 모델" 수치가 늘어난다. */
  async function refreshAiUsage() {
    if (!bridgeHas('getUiState')) return;
    var res = await ipc('getUiState');
    if (!res || res.ok === false || !res.aiUsage || typeof res.aiUsage !== 'object') return;
    var prev = store.aiUsage;
    store.aiUsage = res.aiUsage;
    var changed = !prev || prev.calls !== res.aiUsage.calls || prev.totalTokens !== res.aiUsage.totalTokens;
    if (changed && store.state.view === 'home') render(); // 변경 시에만 위젯 갱신
  }
  async function refreshClaudeUsage() {
    if (!bridgeHas('getClaudeUsage') || store.busyClaudeUsage) return;
    store.busyClaudeUsage = true;
    if (store.state.view === 'home') render();
    var res = await ipc('getClaudeUsage');
    store.busyClaudeUsage = false;
    store.claudeUsageLoaded = true;
    store.claudeUsage = (res && res.ok) ? res : { available: false, totals: null, today: null, byModel: [], lastAt: null, scannedFiles: 0 };
    if (store.state.view === 'home') render();
  }
  /** 언어 분포 추세 baseline 갱신 → store.langPrev(직전 스캔 카운트). */
  async function refreshLangTrend() {
    if (!bridgeHas('updateLangTrend')) return;
    var facets = languageFacets(store.viewModels || []);
    var counts = {};
    facets.forEach(function (f) { counts[f.lang] = f.count; });
    var res = await ipc('updateLangTrend', store._generatedAt || '', counts);
    store.langPrev = (res && res.ok && res.prev && typeof res.prev === 'object') ? res.prev : {};
    if (store.state.view === 'home') render();
  }
  async function refreshCommitActivity(opts) {
    opts = opts || {};
    if (!bridgeHas('getCommitActivity') || store.busyCommitActivity) return;
    store.busyCommitActivity = true;
    // [M10-P1/F-1] silent(폴링/재시도)면 진입 로딩 render 생략 — fetch 동안 이전 차트 유지(깜빡임 0).
    //   최초/수동(silent 아님)은 기존대로 로딩 표시용 render.
    if (!opts.silent && store.state.view === 'home') render();
    var res = await ipc('getCommitActivity');
    store.busyCommitActivity = false;
    store.commitActivityLoaded = true;
    store.commitActivity = (res && res.ok) ? res : { days: [], total: 0, repos: 0 };
    // [M10-P2/P4] 완료부 — 데이터·날짜창 무변경이면 갱신 skip, 변경 시 차트 영역만 patchRegion 교체.
    if (store.state.view === 'home') onCommitActivityFetched();
  }

  /** [M10-P2] commitActivity 데이터 동일성 키(epoch-day prefix + count 시퀀스, 순수·정수만). */
  var _lastCommitActivityKey = '';
  function onCommitActivityFetched() {
    var newKey = commitActivityKey(store.commitActivity);
    if (newKey === _lastCommitActivityKey) return; // [P2] 데이터·날짜창 무변경 → 갱신 skip
    _lastCommitActivityKey = newKey;
    // [P4] 차트 영역만 부분 교체(깜빡임 0). 영역 부재/오류 시 patchCommitChart 내부 fallback=render.
    patchCommitChart();
  }

  function renderHomeDisk(reclaim) {
    var card = el('div', { style: HOME_CARD + 'padding:21px 20px;' });
    var head = el('div', { style: 'display:flex;align-items:baseline;gap:9px;margin-bottom:3px;' });
    head.appendChild(el('div', { text: '디스크 회수', style: 'font-size:15px;font-weight:600;flex:1 1 0%;' }));
    head.appendChild(el('span', { text: reclaim.label, style: 'font-size:22px;font-weight:700;color:#15803d;font-variant-numeric:tabular-nums;letter-spacing:-0.02em;' }));
    card.appendChild(head);
    card.appendChild(el('div', { text: '방치 프로젝트 node_modules 정리 시', style: 'font-size:11.5px;color:#a8a29e;margin-bottom:16px;' }));
    var list = el('div', { style: 'display:flex;flex-direction:column;gap:12px;' });
    if (reclaim.items.length === 0) {
      list.appendChild(el('div', { text: '설정 → 스캔 옵션에서 용량 수집을 켜면 표시됩니다.', style: 'font-size:11.5px;color:#a8a29e;line-height:1.6;' }));
    }
    reclaim.items.forEach(function (it) {
      var box = el('div');
      var r = el('div', { style: 'display:flex;justify-content:space-between;font-size:12px;margin-bottom:5px;' });
      r.appendChild(el('span', { text: it.name, style: 'color:#1c1917;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;' }));
      r.appendChild(el('span', { text: Math.round(it.bytes / 1048576) + ' MB', style: HOME_MONO + 'color:#78716c;flex:0 0 auto;margin-left:8px;' }));
      box.appendChild(r);
      var track = el('div', { style: 'height:6px;background:#f0efed;border-radius:4px;overflow:hidden;' });
      track.appendChild(el('div', { style: 'width:' + (it.bytes / reclaim.max * 100) + '%;height:100%;background:#34d399;border-radius:4px;' }));
      box.appendChild(track);
      list.appendChild(box);
    });
    card.appendChild(list);
    return card;
  }

  /** [항목2·3] 토큰 사용량 — 큰 수 압축 표기(1.2k·3.4M). 음수/비유한은 0. */
  function fmtTokens(n) {
    n = (typeof n === 'number' && isFinite(n) && n > 0) ? Math.floor(n) : 0;
    if (n < 1000) return String(n);
    if (n < 1000000) return (n / 1000).toFixed(n < 10000 ? 1 : 0) + 'k';
    return (n / 1000000).toFixed(2) + 'M';
  }
  /** 라벨/값 스탯 한 줄. */
  function usageStatRow(label, value, strong) {
    var row = el('div', { style: 'display:flex;align-items:baseline;justify-content:space-between;gap:10px;padding:5px 0;' });
    row.appendChild(el('span', { text: label, style: 'font-size:11.5px;color:#78716c;' }));
    row.appendChild(el('span', { text: value, style: HOME_MONO + 'font-size:' + (strong ? '15px;font-weight:700;color:#1c1917' : '12.5px;color:#57534e') + ';font-variant-numeric:tabular-nums;' }));
    return row;
  }
  /** [백로그2-1] 최근 N일 토큰 사용량 막대 차트(자작 SVG, 외부 라이브러리 0).
   *   주간 생산성(커밋) 차트와 동일 인터랙션: 호버·키보드 포커스 시 막대 강조 + 외부 툴팁(날짜·토큰).
   *   [L-1/M-2] 라벨·툴팁은 textContent 만(innerHTML 금지), 치수·색은 sanitize 수치/고정 팔레트로 setAttribute.
   *   전체 render 경로에서만 쓰이므로(부분 patchRegion 아님) 노드 교체 시 리스너는 GC — 별도 destroy 불요. */
  function usageBarChart(daily) {
    var days = Array.isArray(daily) ? daily : [];
    var n = days.length || 1;
    var max = 1;
    for (var i = 0; i < days.length; i++) { var v = (days[i] && days[i].totalTokens) || 0; if (v > max) max = v; }
    var W = 300, H = 46, gap = 1;
    var bw = (W - gap * (n - 1)) / n;
    var svgEl = document.createElementNS(SVG_NS, 'svg');
    svgEl.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    svgEl.setAttribute('width', '100%'); svgEl.setAttribute('height', String(H));
    svgEl.setAttribute('preserveAspectRatio', 'none');
    svgEl.setAttribute('class', 'commit-chart__svg'); // 커밋 차트와 동일 rect 트랜지션·포커스 링 재사용
    svgEl.setAttribute('role', 'img');
    svgEl.setAttribute('aria-label', '최근 ' + n + '일 토큰 사용량');

    // 외부 툴팁 div(SVG 외부, textContent 만) — 커밋 차트와 동일 스타일/위치 로직.
    var tip = el('div', { cls: 'commit-chart__tip' });
    tip.style.display = 'none';
    var wrap = el('div', { cls: 'commit-chart__wrap', style: 'margin:8px 0 4px;' });

    days.forEach(function (d, idx) {
      var val = (d && d.totalTokens) || 0;
      var h = val > 0 ? Math.max(2, Math.round(val / max * (H - 2))) : 1;
      var x = idx * (bw + gap);
      var w = Math.max(0.5, bw);
      var isLast = idx === days.length - 1;
      var baseFill = isLast ? CHART_PALETTE.barLast : (val > 0 ? CHART_PALETTE.bar : CHART_PALETTE.stub);
      var rect = document.createElementNS(SVG_NS, 'rect');
      rect.setAttribute('x', String(x));
      rect.setAttribute('y', String(H - h));
      rect.setAttribute('width', String(w));
      rect.setAttribute('height', String(h));
      rect.setAttribute('rx', '0.6');
      rect.setAttribute('fill', baseFill);
      rect.setAttribute('tabindex', '0');   // 키보드 포커스(접근성)
      rect.setAttribute('role', 'listitem');
      var label = (d && d.date ? d.date : '·') + ' · ' + fmtTokens(val) + ' 토큰';
      var titleEl = document.createElementNS(SVG_NS, 'title');
      titleEl.textContent = label; // L-1 textContent(스크린리더)
      rect.appendChild(titleEl);

      var showTip = function () {
        rect.setAttribute('fill', CHART_PALETTE.barHover);  // 강조(커밋 차트와 동일)
        tip.textContent = label;                             // [M-2] textContent 만
        tip.style.display = 'block';                         // offsetWidth 실측 위해 먼저 표시
        var centerRatio = (x + w / 2) / W;
        var svgRect = svgEl.getBoundingClientRect();
        var wrapRect = wrap.getBoundingClientRect();
        var left = tipLeft(centerRatio, svgRect.left, svgRect.width, wrapRect.left, wrapRect.width, tip.offsetWidth || 80);
        tip.style.left = left + 'px';
        tip.style.transform = 'translateY(-100%)';           // 세로 띄움(F-3b)
      };
      var hideTip = function () { rect.setAttribute('fill', baseFill); tip.style.display = 'none'; };
      rect.addEventListener('mouseenter', showTip);
      rect.addEventListener('mouseleave', hideTip);
      rect.addEventListener('focus', showTip);
      rect.addEventListener('blur', hideTip);
      svgEl.appendChild(rect);
    });

    wrap.appendChild(svgEl);
    wrap.appendChild(tip);
    return wrap;
  }

  /** [항목2·3] 토큰 사용량 인사이트 섹션 — 상단: Claude Code(로컬 로그), 하단: 연결된 모델(브리핑). */
  function renderHomeAiUsage() {
    var card = el('div', { style: HOME_CARD + 'padding:21px 22px;' });

    // 헤더 + Claude Code 수동 새로고침.
    var refresh = el('span', {
      style: 'font-size:12px;font-weight:600;color:#4f46e5;cursor:pointer;' + (store.busyClaudeUsage ? 'opacity:.5;pointer-events:none;' : ''),
      attrs: { role: 'button', tabindex: '0', 'aria-label': 'Claude Code 사용량 새로고침' },
      on: {
        click: function () { store.claudeUsageLoaded = false; refreshClaudeUsage(); },
        keydown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); store.claudeUsageLoaded = false; refreshClaudeUsage(); } },
      },
    });
    refresh.appendChild(el('span', { text: store.busyClaudeUsage ? '집계 중…' : '새로고침' }));
    card.appendChild(homeCardHead(homeTitle('토큰 사용량'), refresh, 6));
    card.appendChild(el('div', { text: 'Claude Code 로컬 로그와 연결된 AI 모델의 토큰 소비량입니다.', style: 'font-size:11.5px;color:#a8a29e;margin-bottom:16px;' }));

    // ── Claude Code(항목2) ──
    var cu = store.claudeUsage;
    card.appendChild(el('div', { text: 'Claude Code', style: 'font-size:12.5px;font-weight:600;color:#1c1917;margin-bottom:4px;' }));
    if (store.busyClaudeUsage && !cu) {
      card.appendChild(el('div', { text: '로컬 로그 집계 중…', style: 'font-size:11.5px;color:#a8a29e;padding:4px 0 14px;' }));
    } else if (!cu || !cu.available) {
      card.appendChild(el('div', { text: '이 PC에서 Claude Code 사용 기록을 찾지 못했습니다.', style: 'font-size:11.5px;color:#a8a29e;padding:4px 0 14px;line-height:1.6;' }));
    } else {
      var tot = cu.totals || {}; var tod = cu.today || {};
      card.appendChild(usageStatRow('총 토큰', fmtTokens(tot.totalTokens), true));
      card.appendChild(usageStatRow('오늘', fmtTokens(tod.totalTokens) + ' 토큰 · ' + (tod.messages || 0) + '회'));
      card.appendChild(usageStatRow('입력 / 출력', fmtTokens(tot.inputTokens) + ' / ' + fmtTokens(tot.outputTokens)));
      card.appendChild(usageStatRow('캐시 읽기', fmtTokens(tot.cacheReadTokens)));
      // [백로그2-1] 최근 30일 일별 사용량 시각화.
      var daily = Array.isArray(cu.daily) ? cu.daily : [];
      if (daily.length) {
        var sum30 = daily.reduce(function (a, d) { return a + ((d && d.totalTokens) || 0); }, 0);
        var dchead = el('div', { style: 'display:flex;align-items:baseline;justify-content:space-between;margin-top:10px;' });
        dchead.appendChild(el('span', { text: '최근 ' + daily.length + '일', style: 'font-size:11px;color:#a8a29e;' }));
        dchead.appendChild(el('span', { text: fmtTokens(sum30) + ' 토큰', style: HOME_MONO + 'font-size:11px;color:#78716c;' }));
        card.appendChild(dchead);
        card.appendChild(usageBarChart(daily));
      }
      // 상위 모델(최대 3).
      var models = Array.isArray(cu.byModel) ? cu.byModel.slice(0, 3) : [];
      models.forEach(function (m) {
        card.appendChild(usageStatRow(String(m.model || '알 수 없음'), fmtTokens(m.totalTokens)));
      });
      card.appendChild(el('div', { text: cu.scannedFiles + '개 세션 로그 기준', style: 'font-size:10.5px;color:#c7c2bd;margin-top:4px;' }));
    }

    card.appendChild(el('div', { style: 'height:1px;background:#f0efed;margin:14px 0;' }));

    // ── 연결된 모델(항목3) — 브리핑 생성 시 누적 ──
    var au = store.aiUsage;
    card.appendChild(el('div', { text: '연결된 모델 (브리핑)', style: 'font-size:12.5px;font-weight:600;color:#1c1917;margin-bottom:4px;' }));
    if (!au || !(au.calls > 0)) {
      card.appendChild(el('div', { text: '설정의 AI 브리핑을 켜고 생성하면 토큰 사용량이 집계됩니다.', style: 'font-size:11.5px;color:#a8a29e;padding:4px 0;line-height:1.6;' }));
    } else {
      card.appendChild(usageStatRow('총 토큰', fmtTokens(au.totalTokens), true));
      card.appendChild(usageStatRow('생성 횟수', String(au.calls || 0) + '회'));
      card.appendChild(usageStatRow('입력 / 출력', fmtTokens(au.promptTokens) + ' / ' + fmtTokens(au.completionTokens)));
      if (au.lastModel) card.appendChild(usageStatRow('모델', String(au.lastModel)));
    }
    return card;
  }

  function renderHomeFeatureAdd() {
    // [위젯 추가/제거] 클릭 시 위젯 갤러리 팝업을 연다(기존 설정 열기 → 위젯 추가로 변경).
    var avail = (store.hiddenWidgets || []).length; // 추가 가능(미적용) 위젯 수
    var openGallery = function () { store.showWidgetGallery = true; render(); };
    var card = el('div', {
      style: 'background:#fafafa;border:1.5px dashed #d6d3d1;border-radius:16px;padding:20px;display:flex;align-items:center;gap:13px;cursor:pointer;',
      attrs: { role: 'button', tabindex: '0', 'aria-label': '위젯 추가' },
      on: { click: openGallery, keydown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openGallery(); } } },
    });
    card.appendChild(el('div', { text: '+', style: 'width:34px;height:34px;border-radius:9px;background:#fff;border:1px solid #e7e5e4;display:flex;align-items:center;justify-content:center;color:#a8a29e;font-size:22px;line-height:1;flex:0 0 auto;' }));
    var t = el('div');
    t.appendChild(el('div', { text: '위젯 추가', style: 'font-size:13px;font-weight:600;color:#57534e;' }));
    t.appendChild(el('div', { text: avail > 0 ? ('추가 가능한 위젯 ' + avail + '개 · 클릭해 선택') : '모든 위젯이 적용됨 · 클릭해 둘러보기', style: 'font-size:11px;color:#a8a29e;margin-top:2px;' }));
    card.appendChild(t);
    return card;
  }

  /** [위젯 추가/제거] 위젯 카드 우상단 제거(×) 버튼 — 호버 시 노출(.home-section:hover .widget-remove). */
  function widgetRemoveBtn(id) {
    var meta = WIDGET_META[id] || { name: id };
    return el('button', {
      cls: 'widget-remove',
      attrs: { type: 'button', 'aria-label': meta.name + ' 위젯 홈에서 제거', title: '홈에서 제거' },
      on: { click: function (e) { e.stopPropagation(); onRemoveWidget(id); } },
      children: [svg([{ t: 'path', d: 'M18 6L6 18M6 6l12 12' }], { size: 13, stroke: '#78716c', sw: 2 })],
    });
  }

  /** [위젯 추가/제거] 위젯 갤러리 팝업 — 모든 토글 위젯을 미리보기로 보여주고, 미적용 위젯을 선택해 홈에 추가. */
  function renderWidgetGallery() {
    var hidden = store.hiddenWidgets || [];
    var close = function () { store.showWidgetGallery = false; render(); };
    var overlay = el('div', {
      cls: 'widget-gallery__overlay',
      on: { click: function (e) { if (e.target === overlay) close(); } },
    });
    var panel = el('div', { cls: 'widget-gallery__panel spip-scroll' });
    var head = el('div', { cls: 'widget-gallery__head' });
    var titleWrap = el('div');
    titleWrap.appendChild(el('div', { text: '위젯 추가', style: 'font-size:17px;font-weight:700;color:#1c1917;' }));
    titleWrap.appendChild(el('div', { text: '홈 대시보드에 표시할 위젯을 고르세요. 이미 적용된 위젯은 카드의 × 로 제거할 수 있습니다.', style: 'font-size:12px;color:#78716c;margin-top:3px;' }));
    head.appendChild(titleWrap);
    head.appendChild(el('button', {
      cls: 'widget-gallery__close', text: '✕', attrs: { type: 'button', 'aria-label': '닫기' }, on: { click: close },
    }));
    panel.appendChild(head);

    var gridGal = el('div', { cls: 'widget-gallery__grid' });
    TOGGLEABLE_WIDGET_IDS.forEach(function (id) {
      var meta = WIDGET_META[id] || { name: id, desc: '' };
      var applied = hidden.indexOf(id) < 0;
      var cardCls = 'widget-card' + (applied ? ' widget-card--applied' : '');
      var actionAttrs = applied ? {} : { role: 'button', tabindex: '0', 'aria-label': meta.name + ' 홈에 추가' };
      var card = el('div', {
        cls: cardCls,
        attrs: actionAttrs,
        on: applied ? {} : {
          click: function () { onAddWidget(id); },
          keydown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onAddWidget(id); } },
        },
      });
      // 미리보기 — 위젯 모양을 대표하는 미니 목업(제목 + 스켈레톤 라인).
      var prev = el('div', { cls: 'widget-card__preview' });
      prev.appendChild(el('div', { cls: 'widget-card__preview-title', text: meta.name }));
      for (var i = 0; i < 3; i++) prev.appendChild(el('div', { cls: 'widget-card__skeleton', style: 'width:' + (90 - i * 18) + '%;' }));
      card.appendChild(prev);
      var body = el('div', { cls: 'widget-card__body' });
      body.appendChild(el('div', { cls: 'widget-card__name', text: meta.name }));
      body.appendChild(el('div', { cls: 'widget-card__desc', text: meta.desc || '' }));
      card.appendChild(body);
      // 상태/액션.
      if (applied) {
        card.appendChild(el('div', { cls: 'widget-card__badge', text: '✓ 적용됨' }));
      } else {
        card.appendChild(el('div', { cls: 'widget-card__add', text: '+ 홈에 추가' }));
      }
      gridGal.appendChild(card);
    });
    panel.appendChild(gridGal);
    overlay.appendChild(panel);
    return overlay;
  }

  /** [위젯 추가/제거] hidden 집합 변경 영속(낙관적) — 메인 normalizeHiddenWidgets가 단일 신뢰 경계. */
  function commitHiddenWidgets(next) {
    store.hiddenWidgets = next;
    render();
    if (!bridgeHas('setHiddenWidgets')) return; // 웹/테스트 graceful
    store.busyWidgets = true;
    ipc('setHiddenWidgets', next).then(function (res) {
      store.busyWidgets = false;
      if (res && res.ok && Array.isArray(res.hiddenWidgets)) { store.hiddenWidgets = res.hiddenWidgets; render(); }
    }).catch(function () { store.busyWidgets = false; });
  }
  function onAddWidget(id) {
    if (TOGGLEABLE_WIDGET_IDS.indexOf(id) < 0) return;
    var next = (store.hiddenWidgets || []).filter(function (x) { return x !== id; }); // 숨김 해제 = 적용
    commitHiddenWidgets(next);
  }
  function onRemoveWidget(id) {
    if (TOGGLEABLE_WIDGET_IDS.indexOf(id) < 0) return;
    var cur = store.hiddenWidgets || [];
    if (cur.indexOf(id) >= 0) return;
    commitHiddenWidgets(cur.concat([id])); // 숨김 추가 = 제거
  }

  /* =====================================================================
   * [SH-2] 즐겨찾기 셸프 위젯 — 홈 카드(셸프 스파인↔펼침). 'shelf'/'shelfWide' 두 변형이 공유.
   *   데이터/로직은 window.spip.shelf.* IPC(api-contract). 표시 메타는 main 이 ShelfBookmarkView 로 완비.
   *   모든 표시 문자열은 el({text}) = textContent(L-1). 배너는 data:URI <img>(img-src 'self' data:) 폴백 그라데이션.
   *   인라인 style 속성 0 — el()/svg() 가 CSSOM(node.style.cssText)으로만 적용(CSP style-src 'self').
   * ===================================================================== */

  // 중첩 네임스페이스(spip.shelf) 어댑터 — briefing 패턴과 동형. 미배포(웹/테스트) 환경 graceful 폴백.
  function shelfBridge() { return (spip && spip.shelf && typeof spip.shelf === 'object') ? spip.shelf : null; }
  function bridgeHasShelf(m) { var b = shelfBridge(); return !!(b && typeof b[m] === 'function'); }
  async function shelfIpc(method) {
    var b = shelfBridge();
    if (!b || typeof b[method] !== 'function') return bridgeMissing();
    var rest = Array.prototype.slice.call(arguments, 1);
    try { return await b[method].apply(b, rest); }
    catch (err) { return { ok: false, code: 'INTERNAL', message: (err && err.message) ? err.message : 'IPC 오류' }; }
  }

  /** 셸프 데이터 1회 적재(홈 진입 시). 부재(웹/테스트) 시 loaded 만 세워 빈 셸프로 graceful. */
  function maybeLoadShelf() {
    if (bridgeHasShelf('list') && !store.shelf.loaded && !store.shelf.busy) refreshShelf();
  }
  async function refreshShelf() {
    if (!bridgeHasShelf('list') || store.shelf.busy) return;
    store.shelf.busy = true;
    var res = await shelfIpc('list');
    store.shelf.busy = false;
    store.shelf.loaded = true;
    var list = (res && res.ok && Array.isArray(res.bookmarks)) ? res.bookmarks.filter(function (b) { return b && typeof b.id === 'string'; }) : [];
    store.shelf.bookmarks = list;
    // [SH-4] list 응답에 동봉된 자동 재크롤 토글 초기 상태 적재(별도 호출 없이 1회 읽힘).
    if (res && typeof res.autoRefresh === 'boolean') store.shelf.autoRefresh = res.autoRefresh;
    if (!list.some(function (b) { return b.id === store.shelf.active; })) store.shelf.active = list.length ? list[0].id : null;
    if (store.state.view === 'home') patchShelfSection();
  }
  /** [SH-4] 자동 재크롤 토글 — 낙관적 반영 후 setSettings 영속. 실패 시 롤백·토스트. boolean 외 main BAD_INPUT. */
  async function shelfSetAutoRefresh(next) {
    next = !!next;
    if (!bridgeHasShelf('setSettings')) { store.shelf.autoRefresh = next; patchShelfSection(); return; } // graceful(영속 불가)
    if (store.shelf.busyAuto) return;
    store.shelf.autoRefresh = next; store.shelf.busyAuto = true; // 낙관적
    patchShelfSection();
    var res = await shelfIpc('setSettings', next);
    store.shelf.busyAuto = false;
    if (res && res.ok && typeof res.autoRefresh === 'boolean') {
      store.shelf.autoRefresh = res.autoRefresh; // 메인 확정값으로 정합
    } else {
      store.shelf.autoRefresh = !next; // 롤백
      toast('설정을 바꾸지 못했어요', true);
    }
    patchShelfSection();
  }
  /** 변경 push(spip:shelf:changed) 구독 — main 신호 시 list() 재조회(onMailUpdated 패턴). */
  function subscribeShelfChanged() {
    if (store.shelf.subscribed) return;
    var b = shelfBridge();
    if (!b || typeof b.onChanged !== 'function') return;
    store.shelf.subscribed = true;
    var unsub = b.onChanged(function () { refreshShelf(); });
    store.shelf.unsub = (typeof unsub === 'function') ? unsub : null;
  }
  function unsubscribeShelfChanged() {
    if (typeof store.shelf.unsub === 'function') { try { store.shelf.unsub(); } catch (_) { /* ignore */ } }
    store.shelf.unsub = null; store.shelf.subscribed = false;
  }

  // ── 컴포저 동작 ──
  function shelfSetType(t) {
    if (t !== 'url' && t !== 'folder' && t !== 'file') return;
    clearTimeout(store.shelf._addTimer); store.shelf._addSeq++; // 보류 add 취소
    store.shelf.cType = t; store.shelf.cState = 'idle'; store.shelf.cErr = null;
    patchShelfSection();
  }
  function shelfOnInput(e) {
    var v = e && e.target ? e.target.value : '';
    clearTimeout(store.shelf._addTimer);
    var type = shelfDetectType(v) || store.shelf.cType;
    store.shelf.cUrl = v; store.shelf.cType = type; store.shelf.cErr = null;
    if (!String(v).trim()) { store.shelf.cState = 'idle'; patchShelfSection(); return; }
    store.shelf.cState = 'loading';
    patchShelfSection();
    var seq = ++store.shelf._addSeq;
    store.shelf._addTimer = setTimeout(function () {
      if (seq !== store.shelf._addSeq) return; // 입력이 더 들어옴 → 취소분
      var t = store.shelf.cType, ref = String(store.shelf.cUrl).trim();
      if (!shelfIsValidInput(t, ref)) { store.shelf.cState = 'error'; store.shelf.cErr = shelfAddErrorMessage('BAD_INPUT', t); patchShelfSection(); return; }
      shelfAdd(t, ref, seq);
    }, 800);
  }
  function shelfOnInputKey(e) {
    if (!e || e.key !== 'Enter') return;
    e.preventDefault();
    clearTimeout(store.shelf._addTimer);
    var t = store.shelf.cType, ref = String(store.shelf.cUrl).trim();
    if (!ref) return;
    if (!shelfIsValidInput(t, ref)) { store.shelf.cState = 'error'; store.shelf.cErr = shelfAddErrorMessage('BAD_INPUT', t); patchShelfSection(); return; }
    store.shelf.cState = 'loading'; patchShelfSection();
    shelfAdd(t, ref, ++store.shelf._addSeq);
  }
  async function shelfAdd(type, ref, seq) {
    if (!bridgeHasShelf('add')) {
      store.shelf.cState = 'error'; store.shelf.cErr = '이 환경에서는 즐겨찾기를 추가할 수 없어요.'; patchShelfSection(); return;
    }
    store.shelf.busy = true;
    var res = await shelfIpc('add', type, ref);
    if (seq !== store.shelf._addSeq) { store.shelf.busy = false; return; } // 사용자가 계속 입력/취소
    store.shelf.busy = false;
    if (res && res.ok && res.bookmark && typeof res.bookmark.id === 'string') {
      var bk = res.bookmark;
      var exists = store.shelf.bookmarks.some(function (b) { return b && b.id === bk.id; });
      store.shelf.bookmarks = exists
        ? store.shelf.bookmarks.map(function (b) { return (b && b.id === bk.id) ? bk : b; })
        : store.shelf.bookmarks.concat([bk]);
      store.shelf.active = bk.id;
      store.shelf._focusPending = true;
      store.shelf.cUrl = ''; store.shelf.cState = 'idle'; store.shelf.cErr = null; store.shelf.loaded = true;
      patchShelfSection();
      toast((bk.name || '즐겨찾기') + ' 셸프에 꽂힘');
    } else {
      store.shelf.cState = 'error';
      store.shelf.cErr = shelfAddErrorMessage(res && res.code, type);
      patchShelfSection();
    }
  }
  // ── 항목 동작 ──
  function shelfSetActive(id) {
    store.shelf.active = id;
    store.shelf._focusPending = true; // 마운트 시 자동 스크롤 1회(활성 클릭 시에도 재중앙)
    patchShelfSection();
  }
  async function shelfRemove(id, name) {
    if (!bridgeHasShelf('remove')) return;
    // 낙관적 제거(즉시 반영) — 응답으로 정합.
    store.shelf.bookmarks = store.shelf.bookmarks.filter(function (b) { return b && b.id !== id; });
    if (store.shelf.active === id) store.shelf.active = store.shelf.bookmarks.length ? store.shelf.bookmarks[0].id : null;
    patchShelfSection();
    toast((name || '즐겨찾기') + ' 삭제됨');
    var res = await shelfIpc('remove', id);
    if (res && res.ok && Array.isArray(res.bookmarks)) {
      store.shelf.bookmarks = res.bookmarks.filter(function (b) { return b && typeof b.id === 'string'; });
      if (!store.shelf.bookmarks.some(function (b) { return b.id === store.shelf.active; })) {
        store.shelf.active = store.shelf.bookmarks.length ? store.shelf.bookmarks[0].id : null;
      }
      patchShelfSection();
    } else if (res && res.ok === false) {
      refreshShelf(); // 실패 → 재조회로 정합 복구
      toast('삭제하지 못했어요', true);
    }
  }
  async function shelfOpen(id) {
    if (!bridgeHasShelf('open')) return;
    var res = await shelfIpc('open', id);
    if (res && res.ok) toast('여는 중…');
    else toast(shelfAddErrorMessage(res && res.code), true);
  }
  // ── 책 제목 인라인 편집(스파인 표시명) ──
  function shelfStartEdit(id) {
    var bm = store.shelf.bookmarks.find(function (b) { return b && b.id === id; });
    store.shelf.active = id; // 펼침 보장(편집 입력은 펼침 면에만 존재)
    store.shelf.editing = id;
    store.shelf._editValue = bm ? (bm.name || '') : '';
    patchShelfSection();
    // patchRegion 재마운트 후 입력에 포커스·전체선택(capture 스냅샷엔 아직 입력이 없으므로 수동 포커스).
    setTimeout(function () {
      if (typeof document === 'undefined') return;
      var inp = document.querySelector('.shelf-region .shelf-edit-input');
      if (inp) { try { inp.focus(); inp.select(); } catch (_) { /* noop */ } }
    }, 0);
  }
  function shelfCancelEdit() {
    store.shelf.editing = null; store.shelf._editValue = null;
    patchShelfSection();
  }
  async function shelfCommitRename(id, value) {
    if (store.shelf.editing !== id) return; // 중복 호출(blur+Enter) 가드
    var name = String(value == null ? '' : value).trim();
    store.shelf.editing = null; store.shelf._editValue = null;
    if (!bridgeHasShelf('rename')) { patchShelfSection(); return; }
    // 낙관적 반영(빈 값이면 응답의 크롤/스캔 name으로 정합).
    store.shelf.bookmarks = store.shelf.bookmarks.map(function (b) {
      return (b && b.id === id) ? Object.assign({}, b, name ? { name: name } : {}) : b;
    });
    patchShelfSection();
    var res = await shelfIpc('rename', id, name);
    if (res && res.ok && res.bookmark && typeof res.bookmark.id === 'string') {
      var bk = res.bookmark;
      store.shelf.bookmarks = store.shelf.bookmarks.map(function (b) { return (b && b.id === bk.id) ? bk : b; });
      patchShelfSection();
      toast('책 제목을 바꿨어요');
    } else if (res && res.ok === false) {
      refreshShelf(); // 실패 → 재조회로 정합 복구
      toast('이름을 바꾸지 못했어요', true);
    }
  }

  /** 셸프 영역만 부분 갱신(.shelf-region). 컴포저 캐럿 보존(.shelf-input ∈ FOCUS_SEL). 위젯 'shelf' 재배선. */
  function patchShelfSection() {
    if (typeof document === 'undefined') { render(); return; }
    var regions = document.querySelectorAll('.shelf-region');
    if (!regions.length) return; // 홈 아님/위젯 숨김 → no-op
    Array.prototype.forEach.call(regions, function (region) {
      RG.preserve.patchRegion(region, function () { return renderShelfCard(); }, {
        widgets: ['shelf'],
        preserveFocus: true,
        fallback: function () { render(); },
      });
    });
  }

  // ── 셸프 행 임퍼러티브 배선(가로 드래그/휠 스크롤 + 활성 자동 스크롤) ──
  function wireShelfSwipe(el) {
    if (!el || el.__shelfSwipe) return;
    el.__shelfSwipe = true;
    var down = false, startX = 0, startScroll = 0, moved = 0, pid = null;
    el.style.cursor = 'grab';
    el.addEventListener('pointerdown', function (e) {
      if (e.button && e.button !== 0) return;
      down = true; moved = 0; startX = e.clientX; startScroll = el.scrollLeft; pid = e.pointerId;
      el.style.cursor = 'grabbing'; el.style.scrollBehavior = 'auto';
    });
    el.addEventListener('pointermove', function (e) {
      if (!down) return;
      var dx = e.clientX - startX;
      if (Math.abs(dx) > 3 && pid != null) { try { el.setPointerCapture(pid); } catch (_) { /* ignore */ } }
      if (Math.abs(dx) > moved) moved = Math.abs(dx);
      el.scrollLeft = startScroll - dx;
    });
    var end = function () { down = false; el.style.cursor = 'grab'; el.style.scrollBehavior = 'smooth'; };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('pointerleave', function () { if (down) end(); });
    // 실제 드래그 뒤따르는 click 억제(스파인 활성 오발동 방지).
    el.addEventListener('click', function (e) { if (moved > 6) { e.preventDefault(); e.stopPropagation(); } }, true);
    // 휠 세로 → 가로 스크롤.
    el.addEventListener('wheel', function (e) {
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) { el.scrollLeft += e.deltaY; e.preventDefault(); }
    }, { passive: false });
  }
  function focusShelfActive(row, id) {
    if (!row || id == null) return;
    var elp = null, kids = row.children;
    for (var i = 0; i < kids.length; i++) {
      if (kids[i].getAttribute && kids[i].getAttribute('data-fid') === String(id)) { elp = kids[i]; break; }
    }
    if (!elp) return;
    var lead = shelfLead(store.shelf.bookmarks.length);
    var target = Math.max(0, Math.min(row.scrollWidth - row.clientWidth, elp.offsetLeft - lead));
    animateShelfScroll(row, target, 460);
  }
  function animateShelfScroll(row, to, dur) {
    var from = row.scrollLeft, dist = to - from;
    if (Math.abs(dist) < 1) return;
    if (typeof requestAnimationFrame !== 'function') { row.scrollLeft = to; return; }
    var t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    row.style.scrollBehavior = 'auto';
    var ease = function (p) { return 1 - Math.pow(1 - p, 3); };
    var step = function (now) {
      var p = Math.min(1, (now - t0) / dur);
      row.scrollLeft = from + dist * ease(p);
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
    // rAF 스로틀돼도 최종 위치 보장.
    clearTimeout(row.__scEnd);
    row.__scEnd = setTimeout(function () { if (Math.abs(row.scrollLeft - to) > 2) row.scrollLeft = to; }, dur + 90);
  }

  // ── 렌더 ──
  function renderHomeShelf() {
    var region = el('div', { cls: 'shelf-region' });
    region.appendChild(renderShelfCard());
    return region;
  }
  function renderShelfCard() {
    var vm = shelfComposerVM(store.shelf);
    var flags = shelfStateFlags(store.shelf.bookmarks, store.shelf.cState);
    var panels = shelfPanelsVM(store.shelf.bookmarks, store.shelf.active);
    var card = el('div', { style: 'background:#fff;border:1px solid #e7e5e4;border-radius:18px;overflow:hidden;box-shadow:0 1px 2px rgba(28,25,23,.04);' });
    card.appendChild(shelfHeader(flags.count));
    card.appendChild(shelfComposer(vm));
    card.appendChild(shelfBody(panels, flags));
    card.appendChild(shelfFooter());
    return card;
  }
  function shelfHeader(count) {
    var head = el('div', { style: 'display:flex;align-items:center;gap:12px;padding:18px 20px 16px;border-bottom:1px solid #f2f1ef;' });
    var ico = el('div', { style: 'width:34px;height:34px;border-radius:10px;background:#eef2ff;display:flex;align-items:center;justify-content:center;flex:none;' });
    ico.appendChild(svg([{ t: 'path', d: 'M4 19.5V5a2 2 0 0 1 2-2h11a1 1 0 0 1 1 1v15' }, { t: 'path', d: 'M6 17h12' }, { t: 'path', d: 'M9 3v14' }], { size: 18, stroke: '#4f46e5', sw: 1.7 }));
    head.appendChild(ico);
    var mid = el('div', { style: 'flex:1;min-width:0;' });
    var titleRow = el('div', { style: 'display:flex;align-items:center;gap:8px;' });
    titleRow.appendChild(el('span', { text: '즐겨찾기 셸프', style: 'font-size:15.5px;font-weight:600;letter-spacing:-.015em;' }));
    titleRow.appendChild(el('span', { text: String(count), style: HOME_MONO + 'font-size:11px;font-weight:600;color:#78716c;background:#f3f2f0;border:1px solid #e7e5e4;padding:1px 7px;border-radius:6px;' }));
    mid.appendChild(titleRow);
    mid.appendChild(el('div', { text: '사이트·폴더·파일을 한 셸프에서 즐겨찾기', style: 'font-size:11.5px;color:#a8a29e;margin-top:2px;' }));
    head.appendChild(mid);
    return head;
  }
  function shelfComposer(vm) {
    var wrap = el('div', { style: 'padding:16px 20px 4px;' });
    var typeRow = el('div', { style: 'display:flex;align-items:center;gap:6px;margin-bottom:9px;' });
    typeRow.appendChild(el('span', { text: '유형', style: 'font-size:9.5px;font-weight:600;letter-spacing:.04em;color:#c0bdb8;margin-right:2px;' }));
    vm.types.forEach(function (t) {
      typeRow.appendChild(el('button', {
        text: t.label,
        attrs: { type: 'button', 'aria-pressed': String(t.active), 'aria-label': '유형 ' + t.label },
        style: 'appearance:none;cursor:pointer;display:inline-flex;align-items:center;gap:5px;font-size:11.5px;font-weight:600;padding:5px 11px;border-radius:8px;transition:all .12s;'
          + (t.active ? 'background:#1c1917;color:#fff;border:1px solid #1c1917;' : 'background:#fff;color:#78716c;border:1px solid #e7e5e4;'),
        on: { click: function () { shelfSetType(t.t); } },
      }));
    });
    wrap.appendChild(typeRow);
    var inputBox = el('div', { style: 'display:flex;align-items:center;gap:10px;background:#fafaf9;border:1.5px solid ' + vm.inputBorder + ';border-radius:12px;padding:0 12px 0 14px;height:46px;transition:border-color .15s;' });
    inputBox.appendChild(svg([{ t: 'path', d: 'M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1' }, { t: 'path', d: 'M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1' }], { size: 17, stroke: '#a8a29e', sw: 2 }));
    var input = el('input', {
      cls: 'shelf-input',
      style: 'flex:1;min-width:0;border:none;background:none;font-size:13.5px;color:#1c1917;height:100%;font-family:Geist,Pretendard,sans-serif;',
      attrs: { type: 'text', 'aria-label': '즐겨찾기 추가 — URL·폴더·파일 경로', placeholder: vm.inputPlaceholder, spellcheck: 'false', autocomplete: 'off' },
      on: { input: shelfOnInput, keydown: shelfOnInputKey },
    });
    input.value = store.shelf.cUrl; // 컨트롤드(캐럿은 patchRegion preserve 로 보존)
    inputBox.appendChild(input);
    if (vm.cLoading) inputBox.appendChild(el('div', { cls: 'shelf-spin', style: 'width:16px;height:16px;border:2px solid #e7e5e4;border-top-color:#4f46e5;border-radius:50%;flex:none;' }));
    else if (vm.cIdle) inputBox.appendChild(el('span', { text: '⌘V', style: HOME_MONO + 'font-size:10px;color:#c9c6c2;letter-spacing:.04em;flex:none;' }));
    wrap.appendChild(inputBox);
    if (vm.cLoading) {
      var ll = el('div', { style: 'display:flex;align-items:center;gap:7px;margin:9px 2px 2px;' + HOME_MONO + 'font-size:11px;color:#a8a29e;' });
      ll.appendChild(el('span', { style: 'width:6px;height:6px;border-radius:50%;background:#4f46e5;flex:none;' }));
      ll.appendChild(el('span', { text: vm.crawlingLabel }));
      wrap.appendChild(ll);
    }
    if (vm.cError) {
      var eb = el('div', { cls: 'shelf-slideup', attrs: { role: 'alert' }, style: 'margin-top:9px;border:1px solid #fde2c8;background:#fff8f0;border-radius:11px;padding:11px 13px;display:flex;align-items:center;gap:10px;' });
      eb.appendChild(svg([{ t: 'path', d: 'M12 9v4M12 17h.01' }, { t: 'path', d: 'M10.3 3.86l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.7-3.14l-8-14a2 2 0 0 0-3.4 0z' }], { size: 16, stroke: '#b45309', sw: 2 }));
      eb.appendChild(el('span', { text: store.shelf.cErr || '', style: 'font-size:12px;color:#92400e;font-weight:500;' }));
      wrap.appendChild(eb);
    }
    return wrap;
  }
  function shelfBody(panels, flags) {
    var wrap = el('div', { style: 'padding:14px 20px 8px;' });
    var loading = store.shelf.cState === 'loading';
    // 최초 list 적재 중(데이터 0) → 스켈레톤 스파인.
    if (!store.shelf.loaded && store.shelf.busy && store.shelf.bookmarks.length === 0) {
      var skRow = el('div', { cls: 'no-sb', style: 'display:flex;gap:6px;height:278px;overflow:hidden;' });
      for (var s = 0; s < 4; s++) skRow.appendChild(shelfLoadingSpine());
      wrap.appendChild(skRow);
      return wrap;
    }
    if (flags.hasItems) {
      var row = el('div', { cls: 'shelf-row no-sb', attrs: { role: 'list', 'aria-label': '즐겨찾기 셸프' }, style: 'position:relative;display:flex;gap:6px;height:278px;overflow-x:auto;overflow-y:hidden;padding-bottom:2px;touch-action:pan-x;' });
      panels.forEach(function (p) { row.appendChild(shelfPanel(p)); });
      if (loading) row.appendChild(shelfLoadingSpine());
      wrap.appendChild(row);
    } else if (flags.isEmpty) {
      wrap.appendChild(shelfEmpty());
    }
    return wrap;
  }
  function shelfPanel(p) {
    var outer = 'position:relative;height:100%;border-radius:13px;overflow:hidden;cursor:pointer;will-change:transform;transition:transform .2s cubic-bezier(.22,1,.36,1),box-shadow .2s ease,filter .2s ease;'
      + (p.expanded
        ? 'flex:1 0 290px;box-shadow:0 14px 30px -12px rgba(28,25,23,.28);border:1px solid #e7e5e4;background:#fff;'
        : 'flex:0 0 ' + p.spineW + 'px;background:' + p.color + ';box-shadow:inset -8px 0 14px -10px rgba(0,0,0,.35);');
    var panel = el('div', {
      cls: 'shelf-panel ' + (p.expanded ? 'shelf-exp' : 'shelf-spine'),
      attrs: { 'data-fid': p.id, role: 'listitem', tabindex: '0', 'aria-expanded': String(p.expanded), 'aria-label': p.name + (p.expanded ? ' (펼침)' : '') },
      style: outer,
      on: {
        click: function () { shelfSetActive(p.id); },
        keydown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); shelfSetActive(p.id); } },
      },
    });
    if (p.collapsed) panel.appendChild(shelfSpineFace(p));
    else panel.appendChild(shelfExpandedFace(p));
    return panel;
  }
  function shelfSpineFace(p) {
    var face = el('div', { style: 'position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;padding:13px 0;' });
    face.appendChild(el('div', { text: p.mono, style: 'width:30px;height:30px;border-radius:9px;background:rgba(255,255,255,.22);backdrop-filter:blur(4px);display:flex;align-items:center;justify-content:center;' + HOME_MONO + 'font-size:15px;font-weight:600;color:#fff;flex:none;' }));
    var nameWrap = el('div', { style: 'flex:1;display:flex;align-items:center;justify-content:center;min-height:0;' });
    nameWrap.appendChild(el('div', { text: p.name, style: 'writing-mode:vertical-rl;font-size:12.5px;font-weight:600;letter-spacing:.01em;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-height:150px;' }));
    face.appendChild(nameWrap);
    face.appendChild(el('div', { style: 'width:7px;height:7px;border-radius:50%;background:rgba(255,255,255,.55);flex:none;' }));
    return face;
  }
  function shelfExpandedFace(p) {
    var exp = el('div', { cls: 'shelf-unroll', style: 'position:absolute;inset:0;display:flex;flex-direction:column;overflow:hidden;' });
    // og 배너(url=data:URI 이미지 / folder·file=색 그라데이션 폴백)
    var bannerBase = 'position:relative;height:92px;flex:none;overflow:hidden;';
    var banner;
    if (p.bannerImage) {
      banner = el('div', { style: bannerBase });
      // SH-5: 이미지 깨짐/지연 graceful — 로드 실패 시 색 그라데이션으로 폴백(빈 배너 방지).
      var bimg = el('img', {
        attrs: { src: p.bannerImage, alt: '', loading: 'lazy' },
        style: 'position:absolute;inset:0;width:100%;height:100%;object-fit:cover;',
        on: { error: function () { bimg.style.display = 'none'; banner.style.background = 'linear-gradient(135deg,' + p.color + ' 0%,' + p.color + 'cc 100%)'; } },
      });
      banner.appendChild(bimg);
    } else {
      banner = el('div', { style: bannerBase + 'background:linear-gradient(135deg,' + p.color + ' 0%,' + p.color + 'cc 100%);' });
    }
    banner.appendChild(el('div', { style: 'position:absolute;inset:0;background:linear-gradient(180deg,rgba(0,0,0,0) 30%,rgba(0,0,0,.28) 100%);' }));
    banner.appendChild(el('span', { text: p.bannerLabel, style: 'position:absolute;left:13px;top:11px;' + HOME_MONO + 'font-size:9px;font-weight:600;letter-spacing:.05em;color:#fff;background:rgba(28,25,23,.4);backdrop-filter:blur(4px);padding:2px 7px;border-radius:6px;' }));
    banner.appendChild(el('div', { text: p.mono, style: 'position:absolute;left:13px;bottom:-19px;width:46px;height:46px;border-radius:12px;background:' + p.color + ';border:3px solid #fff;display:flex;align-items:center;justify-content:center;' + HOME_MONO + 'font-size:20px;font-weight:600;color:#fff;box-shadow:0 4px 10px rgba(28,25,23,.18);' }));
    exp.appendChild(banner);
    // 본문
    var body = el('div', { style: 'flex:1;background:#fff;padding:26px 16px 14px;display:flex;flex-direction:column;min-width:0;overflow:hidden;' });
    var topRow = el('div', { style: 'display:flex;align-items:flex-start;gap:8px;' });
    var titleCol = el('div', { style: 'flex:1;min-width:0;' });
    var editing = store.shelf.editing === p.id;
    if (editing) {
      // 인라인 책 제목 편집(스파인 표시명 = p.name 편집). Enter 저장 · Esc 취소 · 포커스 이탈 시 저장.
      var nameInput = el('input', {
        cls: 'shelf-edit-input',
        style: 'width:100%;box-sizing:border-box;border:1.5px solid #c7d2fe;border-radius:8px;padding:5px 9px;font-size:14px;font-weight:600;color:#1c1917;background:#fff;font-family:Geist,Pretendard,sans-serif;outline:none;',
        attrs: { type: 'text', 'aria-label': '책 제목 편집', maxlength: '120', spellcheck: 'false', placeholder: '책 제목', autocomplete: 'off' },
        on: {
          click: function (e) { e.stopPropagation(); },
          input: function (e) { store.shelf._editValue = e.target.value; },
          keydown: function (e) {
            e.stopPropagation();
            if (e.key === 'Enter') { e.preventDefault(); shelfCommitRename(p.id, e.target.value); }
            else if (e.key === 'Escape') { e.preventDefault(); shelfCancelEdit(); }
          },
          blur: function (e) { if (store.shelf.editing === p.id) shelfCommitRename(p.id, e.target.value); },
        },
      });
      nameInput.value = (store.shelf._editValue != null) ? store.shelf._editValue : (p.name || '');
      titleCol.appendChild(nameInput);
      titleCol.appendChild(el('div', { text: 'Enter 저장 · Esc 취소', style: HOME_MONO + 'font-size:10px;color:#a8a29e;margin-top:4px;' }));
    } else {
      titleCol.appendChild(el('div', { text: p.title, style: 'font-size:14px;font-weight:600;letter-spacing:-.01em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#1c1917;' }));
      titleCol.appendChild(el('div', { text: p.sub, style: HOME_MONO + 'font-size:10.5px;color:#a8a29e;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;' }));
    }
    topRow.appendChild(titleCol);
    if (!editing) {
      var editBtn = el('button', {
        cls: 'shelf-edit', attrs: { type: 'button', title: '책 제목 편집', 'aria-label': p.name + ' 제목 편집' },
        style: 'appearance:none;border:1px solid #e7e5e4;background:#fff;width:26px;height:26px;border-radius:7px;cursor:pointer;color:#a8a29e;display:flex;align-items:center;justify-content:center;flex:none;',
        on: { click: function (e) { e.stopPropagation(); shelfStartEdit(p.id); } },
      });
      editBtn.appendChild(svg([{ t: 'path', d: 'M12 20h9' }, { t: 'path', d: 'M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z' }], { size: 13, stroke: 'currentColor', sw: 2 }));
      topRow.appendChild(editBtn);
    }
    topRow.appendChild(el('span', { text: p.cat, style: 'font-size:10px;font-weight:600;padding:2px 8px;border-radius:6px;background:#f7f7f6;color:#78716c;border:1px solid #ececea;flex:none;white-space:nowrap;' }));
    body.appendChild(topRow);
    body.appendChild(el('p', { text: p.desc, style: 'margin:9px 0 0;font-size:12px;color:#57534e;line-height:1.55;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;' }));
    body.appendChild(el('div', { style: 'flex:1;' }));
    var foot = el('div', { style: 'display:flex;align-items:center;gap:8px;margin-top:12px;padding-top:11px;border-top:1px solid #f4f3f1;' });
    var status = el('span', { style: 'display:inline-flex;align-items:center;gap:5px;' + HOME_MONO + 'font-size:10px;color:#a8a29e;white-space:nowrap;flex:1;min-width:0;' });
    status.appendChild(el('span', { style: 'width:5px;height:5px;border-radius:50%;background:#22c55e;flex:none;' }));
    status.appendChild(el('span', { text: p.status, style: 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0;' }));
    foot.appendChild(status);
    var rm = el('button', {
      cls: 'shelf-rm', attrs: { type: 'button', title: '삭제', 'aria-label': p.name + ' 삭제' },
      style: 'appearance:none;border:1px solid #e7e5e4;background:#fff;width:32px;height:32px;border-radius:9px;cursor:pointer;color:#a8a29e;display:flex;align-items:center;justify-content:center;flex:none;',
      on: { click: function (e) { e.stopPropagation(); shelfRemove(p.id, p.name); } },
    });
    rm.appendChild(svg([{ t: 'path', d: 'M5 7h14M9 7V5h6v2M7 7l1 13h8l1-13' }], { size: 14, stroke: 'currentColor', sw: 2 }));
    foot.appendChild(rm);
    var ob = el('button', {
      cls: 'shelf-open', attrs: { type: 'button', 'aria-label': p.name + ' ' + p.openLabel },
      style: 'appearance:none;border:1px solid #1c1917;background:#1c1917;color:#fff;font-size:12px;font-weight:600;height:32px;padding:0 13px;border-radius:9px;cursor:pointer;flex:none;display:inline-flex;align-items:center;gap:6px;',
      on: { click: function (e) { e.stopPropagation(); shelfOpen(p.id); } },
    });
    ob.appendChild(el('span', { text: p.openLabel }));
    ob.appendChild(svg([{ t: 'path', d: 'M7 17L17 7M9 7h8v8' }], { size: 13, stroke: 'currentColor', sw: 2.4 }));
    foot.appendChild(ob);
    body.appendChild(foot);
    exp.appendChild(body);
    return exp;
  }
  function shelfLoadingSpine() {
    var sp = el('div', { cls: 'shelf-growin', style: 'width:58px;flex:none;border-radius:13px;background:#f1f0ee;border:1.5px dashed #d6d3d1;display:flex;flex-direction:column;align-items:center;padding:13px 0;' });
    sp.appendChild(el('div', { cls: 'shelf-sk', style: 'width:30px;height:30px;border-radius:9px;flex:none;' }));
    var mid = el('div', { style: 'flex:1;display:flex;align-items:center;' });
    mid.appendChild(el('div', { cls: 'shelf-sk', style: 'width:11px;height:96px;border-radius:6px;' }));
    sp.appendChild(mid);
    return sp;
  }
  function shelfEmpty() {
    var box = el('div', { style: 'text-align:center;padding:30px 16px;border:1.5px dashed #e2e0dd;border-radius:14px;background:#fafaf9;' });
    box.appendChild(el('div', { text: '셸프가 비어 있어요', style: 'font-size:13px;font-weight:600;color:#57534e;' }));
    box.appendChild(el('div', { text: 'URL·폴더·파일 경로를 붙여넣어 첫 즐겨찾기를 꽂아보세요', style: 'font-size:11.5px;color:#a8a29e;margin-top:3px;' }));
    return box;
  }
  function shelfFooter() {
    var av = shelfAutoRefreshView(store.shelf.autoRefresh);
    var f = el('div', { style: 'display:flex;align-items:center;gap:10px;padding:12px 20px 14px;border-top:1px solid #f2f1ef;background:#fafaf9;' });
    // 좌: 자동 재크롤 안내(상태에 따라 문구 변경) — 시계 아이콘.
    var hint = el('div', { style: 'display:flex;align-items:center;gap:7px;flex:1;min-width:0;font-size:11px;color:#a8a29e;' });
    hint.appendChild(svg([{ t: 'circle', cx: '12', cy: '12', r: '9' }, { t: 'path', d: 'M12 8v4l3 2' }], { size: 13, stroke: 'currentColor', sw: 2 }));
    hint.appendChild(el('span', { text: av.hint, style: 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0;' }));
    f.appendChild(hint);
    // 우: 자동 재크롤 켜기/끄기 토글(SH-4).
    f.appendChild(shelfAutoToggle(av));
    return f;
  }
  function shelfAutoToggle(av) {
    var wrap = el('div', { style: 'display:flex;align-items:center;gap:7px;flex:none;' });
    wrap.appendChild(el('span', { text: av.label, style: 'font-size:10.5px;font-weight:600;color:#78716c;' }));
    var sw = el('button', {
      cls: av.switchClass,
      attrs: { type: 'button', role: 'switch', 'aria-checked': String(av.on), 'aria-label': av.ariaLabel },
      on: { click: function () { shelfSetAutoRefresh(!store.shelf.autoRefresh); } },
    });
    if (store.shelf.busyAuto) sw.setAttribute('aria-busy', 'true');
    sw.appendChild(el('span', { cls: 'shelf-switch__knob' }));
    wrap.appendChild(sw);
    return wrap;
  }

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
    // 메일 계정 목록도 동기화(설정 오픈 시에만).
    refreshMailAccounts();
    // 업데이트 상태(현재 버전·패키징 여부·마지막 status)도 동기화(설정 오픈 시에만).
    refreshUpdateState();
    // 프로젝트 인식 기준도 동기화(설정 오픈 시에만).
    refreshDetectSignals();
    // [M13 R-39] 브리핑 설정도 동기화(키 평문 없음 — hasApiKey 만).
    refreshBriefingSettings();
  }
  function closeSettings() {
    store.showSettings = false;
    store._settingsShown = false; // 다음 열림에 진입 애니메이션 재적용
    const opener = store._settingsOpener;
    store._settingsOpener = null;
    // [F-1] 오버레이 닫힘(overlayOpen 해제) 지점 — release()로 즉시 1회 반영 + 보류 중이던 push 누적분 소비.
    RG.coalesce.release();
    maybeFlushCommitRefresh(); // [M10-P1] overlayOpen 해제 → 보류된 커밋 폴링 따라감
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

  /** [R-30] 설정 섹션 키 → DOM 노드 빌더. 우측 패널이 활성 카테고리의 sections 키로 디스패치한다.
   *   기존 render*Settings 함수를 그대로 호출 — 항목 동작·저장 로직은 변경 없음(회귀 0). */
  function buildSettingsSection(key) {
    switch (key) {
      case 'roots': return el('div', { cls: 'insight', children: [
        el('div', { cls: 'insight__title', text: '스캔 폴더' }),
        renderRootManager(),
      ]});
      case 'exclude':     return renderExcludeSettings();
      case 'detect':      return renderDetectSettings();
      case 'scanOptions': return renderScanOptions();
      case 'tools':       return renderToolSettings();
      case 'mail':        return renderMailSettings();
      case 'theme':       return renderThemeSettings();
      case 'shortcuts':   return renderShortcutSettings();
      case 'info':        return renderInfoSettings();
      case 'update':      return renderUpdateSettings();
      case 'briefing':    return renderBriefingSettings();
      default:            return null;
    }
  }

  function renderSettings() {
    const enter = !store._settingsShown; store._settingsShown = true; // 진입 애니메이션 1회만
    // [R-30] 활성 카테고리 — 전체 재렌더 후에도 store.settingsTab 보존(미지값은 기본 'scan'으로 보정).
    const activeTab = resolveSettingsTab(store.settingsTab);
    store.settingsTab = activeTab;

    // 좌측: 카테고리 목록(SETTINGS_CATEGORIES 단일 출처). 클릭 시 [M11] 우측 패널만 patchRegion 교체.
    //   (모달 골격·좌측 nav 는 그대로 — is-active class 만 토글. 탭 전환 깜빡임·포커스 트랩 흔들림 0.)
    const nav = el('div', { cls: 'settings-nav', attrs: { role: 'tablist', 'aria-label': '설정 카테고리' } });
    SETTINGS_CATEGORIES.forEach((cat) => {
      const active = cat.id === activeTab;
      nav.appendChild(el('button', {
        cls: 'settings-nav__item' + (active ? ' is-active' : ''),
        text: cat.label,
        attrs: { type: 'button', role: 'tab', 'aria-selected': active ? 'true' : 'false', 'data-settings-tab': cat.id },
        on: { click: () => { switchSettingsTab(cat.id); } },
      }));
    });

    // 우측: 활성 카테고리에 매핑된 섹션만 렌더(나머지 미렌더). .settings-pane 은 스크롤 컨테이너.
    //   activeTab 은 resolveSettingsTab 으로 항상 유효 id → find 는 항상 성공(폴백 가드 불요).
    const pane = el('div', { cls: 'settings-pane spip-scroll', attrs: { role: 'tabpanel' } });
    buildSettingsPaneInto(pane, activeTab);

    const layout = el('div', { cls: 'settings-2pane', children: [nav, pane] });

    return buildModal({
      titleId: 'settings-title',
      title: '설정',
      subtitle: '스캔·연동·외관·단축키·정보를 관리합니다',
      onClose: closeSettings,
      wide: true,
      enter,
      bodyChildren: [layout],
    });
  }

  /** [M11] 활성 탭의 섹션들을 pane 에 채운다(renderSettings·patchSettingsPane 공용). */
  function buildSettingsPaneInto(pane, tabId) {
    const cat = SETTINGS_CATEGORIES.find((c) => c.id === resolveSettingsTab(tabId));
    cat.sections.forEach((key) => { const node = buildSettingsSection(key); if (node) pane.appendChild(node); });
  }

  /** [M11] 설정 카테고리 탭 전환 — 우측 .settings-pane 만 patchRegion 교체(좌측 nav·모달 골격 유지).
   *   설정은 오버레이(showSettings)라 deferred=true 이지만, 탭 전환은 사용자 명시 액션이므로 bypassDefer.
   *   좌측 nav 활성 표시는 class 토글만(전체 재빌드 없음). 포커스 트랩(getTabbables)은 DOM 구조 유지로 보존. */
  function switchSettingsTab(tabId) {
    if (typeof document === 'undefined') return;
    const next = resolveSettingsTab(tabId);
    if (store.settingsTab === next) return; // 동일 탭 — no-op
    store.settingsTab = next;
    // 좌측 nav 활성 표시 동기화(class·aria 토글만).
    const items = document.querySelectorAll('.settings-nav__item[data-settings-tab]');
    items.forEach((btn) => {
      const on = btn.getAttribute('data-settings-tab') === next;
      btn.classList.toggle('is-active', on);
      btn.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    // 우측 패널만 교체. deferred 우회(사용자 액션), 입력 포커스/스크롤 보존, 영역 부재 시 전체 render 폴백.
    const pane = document.querySelector('.settings-pane');
    RG.preserve.patchRegion(pane, function () {
      const frag = el('div'); // 임시 컨테이너 — 자식만 영역으로 옮긴다.
      buildSettingsPaneInto(frag, next);
      return Array.prototype.slice.call(frag.childNodes);
    }, {
      widgets: [],
      preserveFocus: true,         // 설정 입력 포커스·캐럿 보존
      bypassDefer: true,           // [M11] 오버레이 내 사용자 액션 — deferred 게이트 우회
      fallback: function () { render(); },
    });
  }

  /** [R-29] 단축키 안내 — SHORTCUTS 단일 출처를 순회해 키+설명 표 렌더(textContent, L-1).
   *   keydown 디스패치(matchShortcut)·이 표가 동일 SHORTCUTS 를 참조 → 상수 변경 시 양쪽 동시 반영. */
  function renderShortcutSettings() {
    const block = el('div', { cls: 'insight', children: [el('div', { cls: 'insight__title', text: '단축키' })] });
    block.appendChild(el('p', { cls: 'settings__opt-sub', text: '아래 단축키로 자주 쓰는 동작을 빠르게 실행합니다.' }));
    const list = el('div', { cls: 'help__list' });
    SHORTCUTS.forEach((sc) => { list.appendChild(helpRow(sc.keys, sc.label)); });
    block.appendChild(list);
    return block;
  }

  /** [R-28] 정보 — 메뉴 'Project-SPIP 정보' 이관. 버전(하드코딩 금지 — store.update.currentVersion)
   *   + 도움말(스캔 기준·항목 설명) 진입. L-1 textContent. */
  function renderInfoSettings() {
    const block = el('div', { cls: 'insight', children: [el('div', { cls: 'insight__title', text: '정보' })] });
    block.appendChild(el('p', { cls: 'settings__opt-sub', text: 'PC에 흩어진 프로젝트를 스캔해 한눈에 보여주는 로컬 전용 도구입니다.' }));
    const ver = (store.update && store.update.currentVersion) ? ('v' + store.update.currentVersion) : '—';
    const list = el('div', { cls: 'help__list' });
    list.appendChild(helpRow('Project-SPIP', ver));
    block.appendChild(list);
    // 도움말(스캔 기준·항목 설명) 진입 — 모달은 유지하되 진입점을 설정으로 이관(Q5 방향).
    const helpBtn = el('button', {
      cls: 'btn', text: '도움말 보기',
      attrs: { type: 'button', 'aria-label': '스캔 기준·항목 설명 도움말 열기' },
      on: { click: openHelp },
    });
    block.appendChild(helpBtn);
    return block;
  }

  /** 재스캔 옵션 UI: withSize · allDrives(allowAllDrives 게이트) · 정책 표시(getConfig). */
  /** 테마 설정 — 라이트/다크/시스템. segToggle(라이트 테마용) 재사용. */
  function renderThemeSettings() {
    const block = el('div', { cls: 'insight', children: [el('div', { cls: 'insight__title', text: '테마' })] });
    if (!bridgeHas('setTheme')) {
      block.appendChild(el('div', { cls: 'rootmgr__empty', text: '이 환경에서는 테마를 변경할 수 없습니다.' }));
      return block;
    }
    block.appendChild(el('p', { cls: 'settings__opt-sub', text: '밝은 테마 / 어두운 테마 / 시스템 설정 따름 중에서 선택합니다.' }));
    block.appendChild(segToggle([
      ['light', '라이트', store.theme === 'light', () => onSetTheme('light')],
      ['dark', '다크', store.theme === 'dark', () => onSetTheme('dark')],
      ['system', '시스템', store.theme === 'system', () => onSetTheme('system')],
    ]));
    return block;
  }

  /* [M13 R-39] 브리핑 AI 설정 — enabled·baseURL·model·apiKey(쓰기전용)·연결테스트·external 경고·advanced.
   *   apiKey 는 렌더러에 평문 보관/표시 안 함(hasApiKey 불리언만). setSettings shape 은 메인이 재검증. */
  function refreshBriefingSettings() {
    if (!spip || !spip.briefing || typeof spip.briefing.getSettings !== 'function') return;
    Promise.resolve(spip.briefing.getSettings()).then(function (res) {
      var v = briefingSettingsView(res);
      store.briefing.settings = v;
      store.briefing.enabled = v.enabled;
      store.briefing.form = { baseURL: v.baseURL, model: v.model, systemPrompt: v.systemPrompt };
      if (store.showSettings) render();
    }).catch(function () { /* graceful */ });
  }
  function onSetBriefingSettings(patch) {
    if (!spip || !spip.briefing || typeof spip.briefing.setSettings !== 'function') return;
    store.briefing.busySettings = true; render();
    Promise.resolve(spip.briefing.setSettings(patch)).then(function (res) {
      store.briefing.busySettings = false;
      store.briefing.keyInput = ''; // 키 입력 비움(평문 미보관)
      var v = briefingSettingsView(res);
      if (res && res.ok === false) {
        toast(res.code === 'BAD_URL' ? '주소(baseURL)가 올바르지 않습니다.' : '브리핑 설정 저장에 실패했습니다.', true);
      } else {
        store.briefing.settings = v;
        store.briefing.enabled = v.enabled;
        store.briefing.form = { baseURL: v.baseURL, model: v.model, systemPrompt: v.systemPrompt };
      }
      render();
      patchBriefing();
    }).catch(function () { store.briefing.busySettings = false; render(); });
  }
  function onTestBriefingConnection() {
    if (!spip || !spip.briefing || typeof spip.briefing.testConnection !== 'function') return;
    var s = { baseURL: store.briefing.form.baseURL, model: store.briefing.form.model };
    if (store.briefing.keyInput) s.apiKey = store.briefing.keyInput; // 임시 키로 테스트(저장 아님)
    store.briefing.busyTest = true; store.briefing.testResult = null; render();
    Promise.resolve(spip.briefing.testConnection(s)).then(function (res) {
      store.briefing.busyTest = false;
      store.briefing.testResult = (res && typeof res === 'object') ? res : { ok: false, code: 'UNKNOWN' };
      render();
    }).catch(function () { store.briefing.busyTest = false; store.briefing.testResult = { ok: false, code: 'UNKNOWN' }; render(); });
  }

  function renderBriefingSettings() {
    const block = el('div', { cls: 'insight', children: [el('div', { cls: 'insight__title', text: '브리핑 AI' })] });
    if (!spip || !spip.briefing) {
      block.appendChild(el('div', { cls: 'rootmgr__empty', text: '이 환경에서는 브리핑 AI를 설정할 수 없습니다.' }));
      return block;
    }
    const v = store.briefing.settings || briefingSettingsView(null);
    block.appendChild(el('p', { cls: 'settings__opt-sub', text: '로컬 LLM(예: LM Studio·Ollama)에 연결해 홈 상단에 AI 브리핑을 생성합니다. 기본은 꺼짐이며, 모든 요청은 이 PC에서 설정한 서버로만 전송됩니다.' }));

    // enabled 토글
    block.appendChild(optionRow({
      id: 'opt-briefing-enabled', label: 'AI 브리핑 사용', sub: '켜면 홈 브리핑이 AI로 생성됩니다(끄면 기본 요약).',
      checked: v.enabled, disabled: store.briefing.busySettings,
      onChange: function (checked) { onSetBriefingSettings({ enabled: !!checked }); },
    }));

    // baseURL
    const urlField = el('label', { cls: 'mailform__field' });
    urlField.appendChild(el('span', { cls: 'mailform__label', text: '서버 주소(baseURL)' }));
    const urlInput = el('input', { cls: 'rootmgr__input', attrs: { type: 'text', placeholder: 'http://127.0.0.1:1234/v1', autocomplete: 'off', spellcheck: 'false' } });
    urlInput.value = store.briefing.form.baseURL || '';
    urlInput.addEventListener('input', (e) => { store.briefing.form.baseURL = e.target.value || ''; });
    urlField.appendChild(urlInput);
    block.appendChild(urlField);

    // external 경고(M-1)
    if (isExternalBaseURL(store.briefing.form.baseURL)) {
      block.appendChild(el('div', { cls: 'briefing-warn', text: '⚠ 외부 서버로 데이터가 전송됩니다 — 신뢰하는 서버만 사용하세요.' }));
    }

    // model
    const modelField = el('label', { cls: 'mailform__field' });
    modelField.appendChild(el('span', { cls: 'mailform__label', text: '모델 이름' }));
    const modelInput = el('input', { cls: 'rootmgr__input', attrs: { type: 'text', placeholder: '예: exaone-3.5-7.8b-instruct', autocomplete: 'off', spellcheck: 'false' } });
    modelInput.value = store.briefing.form.model || '';
    modelInput.addEventListener('input', (e) => { store.briefing.form.model = e.target.value || ''; });
    modelField.appendChild(modelInput);
    block.appendChild(modelField);

    // 시스템 프롬프트(프롬프트 엔지니어링) — 사용자 편집. 빈 값이면 시드(기본 프롬프트) 사용.
    //   L-1: textarea value 는 textContent 경로(innerHTML 미사용)라 안전. 구조적 인젝션 방어·출력 렌더는
    //   코드 레벨이 계속 강제하므로(편집은 System 지시 텍스트뿐), 편집해도 앱 보안은 유지된다.
    const spField = el('label', { cls: 'mailform__field' });
    spField.appendChild(el('span', { cls: 'mailform__label', text: '시스템 프롬프트 (고급)' }));
    const spInput = el('textarea', {
      cls: 'rootmgr__input briefing-systemprompt',
      attrs: {
        rows: '8', autocomplete: 'off', spellcheck: 'false',
        placeholder: v.defaultSystemPrompt || '비우면 기본 프롬프트를 사용합니다.',
        'aria-label': '브리핑 시스템 프롬프트',
      },
    });
    // 폼 미초기화(undefined)면 settings 값으로 채운다(빈 문자열 = 시드 미적용 상태).
    if (typeof store.briefing.form.systemPrompt !== 'string') store.briefing.form.systemPrompt = v.systemPrompt || '';
    spInput.value = store.briefing.form.systemPrompt;
    spInput.addEventListener('input', (e) => { store.briefing.form.systemPrompt = e.target.value || ''; });
    spField.appendChild(spInput);
    block.appendChild(spField);
    block.appendChild(el('p', {
      cls: 'settings__opt-sub',
      text: '브리핑의 출력 언어·형식·어조 등을 바꿉니다. 비우면 기본 프롬프트를 사용합니다(최대 8000자). 기본 내용을 바탕으로 일부만 고치려면 아래 “기본 프롬프트 불러와 편집”을 누르세요.',
    }));

    // [항목1] AI에 컨텍스트로 전달되는 사용자 DATA 설명 — 무엇을 활용할 수 있는지/무엇이 보호되는지 안내.
    //   접이식(details). 모든 텍스트는 textContent(el)로만 — L-1 유지.
    const liText = (t) => el('li', { text: t });
    const ctx = el('details', { cls: 'briefing-context' });
    ctx.appendChild(el('summary', { cls: 'briefing-context__summary', text: 'AI에 전달되는 데이터 보기 — 무엇을 활용할 수 있나요?' }));
    ctx.appendChild(el('p', { cls: 'settings__opt-sub', text: '프롬프트를 작성할 때 AI는 SPIP가 감지한 아래 항목들을 컨텍스트(DATA)로 받습니다. 모두 신뢰 불가 데이터로 격리되어, 그 안의 지시는 실행되지 않고 요약·설명 대상으로만 쓰입니다.' }));
    ctx.appendChild(el('ul', { cls: 'briefing-context__list', children: [
      liText('항목 이름(label): 프로젝트명·메일 제목 등 사람이 읽는 이름'),
      liText('신호 유형(type): 미커밋(dirty)·미푸시(ahead)·받을 커밋(behind)·새 메일(mail)·마감 임박 할 일 등'),
      liText('중요도(category): must·good·urgent — 시스템이 결정하며 AI가 바꾸지 못합니다'),
      liText('맥락(context): 메일 제목·본문 일부(최대 2000자), 커밋 메시지(최대 500자) 등'),
      liText('미처리 항목(carry-over): 이전 브리핑에서 아직 처리되지 않은 항목'),
    ] }));
    ctx.appendChild(el('p', { cls: 'settings__opt-sub', text: '전달되지 않는 것: API 키·서버 주소·파일 경로·환경변수·내부 해시 식별자(개인정보·자격증명은 프롬프트에 절대 포함되지 않습니다).' }));
    ctx.appendChild(el('p', { cls: 'settings__opt-sub briefing-context__note', text: '출력 형식(JSON 구조)·분류 소유권·표시 전용 안전 규칙은 시스템이 항상 프롬프트 뒤에 자동으로 덧붙이며, 시스템 프롬프트를 어떻게 바꿔도 제거되지 않습니다.' }));
    block.appendChild(ctx);

    // 기본 프롬프트를 편집 칸에 실제 텍스트로 불러온다 — placeholder(흐린 안내)는 입력 시 사라지므로,
    //   "기본에서 일부만 수정" 하려면 먼저 본문을 채워야 한다. 편집 칸이 비어 있을 때만 노출(작성 중 덮어쓰기 방지).
    if (typeof v.defaultSystemPrompt === 'string' && v.defaultSystemPrompt && !store.briefing.form.systemPrompt) {
      block.appendChild(el('button', {
        cls: 'btn btn--sm briefing-systemprompt__load',
        text: '기본 프롬프트 불러와 편집',
        attrs: { type: 'button', 'aria-label': '기본 프롬프트를 편집 칸에 불러오기' },
        on: { click: function () {
          // 시드 텍스트를 폼에 채운 뒤 다시 그려 textarea value 로 표시(이후 일부만 수정 가능).
          store.briefing.form.systemPrompt = v.defaultSystemPrompt;
          render();
        } },
      }));
    }

    // apiKey (쓰기 전용 — 평문 미표시. "설정됨/미설정" + 입력 시 저장 / 비우고 해제)
    const keyField = el('label', { cls: 'mailform__field' });
    keyField.appendChild(el('span', { cls: 'mailform__label', text: 'API 키' + (v.hasApiKey ? ' (설정됨)' : ' (미설정)') }));
    const keyInput = el('input', { cls: 'rootmgr__input', attrs: { type: 'password', placeholder: v.hasApiKey ? '변경하려면 새 키 입력(필요 없으면 비움)' : '필요 시 입력(로컬은 보통 불필요)', autocomplete: 'new-password', spellcheck: 'false' } });
    keyInput.value = store.briefing.keyInput || '';
    keyInput.addEventListener('input', (e) => { store.briefing.keyInput = e.target.value || ''; });
    keyField.appendChild(keyInput);
    block.appendChild(keyField);

    // 액션: 저장 / 연결 테스트 / (키 해제)
    const actions = el('div', { cls: 'briefing-settings__actions' });
    const saveBtn = el('button', {
      cls: 'btn btn--dark', text: store.briefing.busySettings ? '저장 중…' : '저장',
      attrs: { type: 'button', 'aria-label': '브리핑 설정 저장' },
      on: { click: function () {
        const patch = {
          baseURL: store.briefing.form.baseURL,
          model: store.briefing.form.model,
          // 시스템 프롬프트: 항상 전송(빈 문자열 = 시드 복원). 메인이 정제·길이상한 강제.
          systemPrompt: (typeof store.briefing.form.systemPrompt === 'string') ? store.briefing.form.systemPrompt : '',
        };
        if (store.briefing.keyInput) patch.apiKey = store.briefing.keyInput; // 입력 시만 키 전송(미전송=유지)
        onSetBriefingSettings(patch);
      } },
    });
    if (store.briefing.busySettings) saveBtn.disabled = true;
    actions.appendChild(saveBtn);
    const testBtn = el('button', {
      cls: 'btn', text: store.briefing.busyTest ? '테스트 중…' : '연결 테스트',
      attrs: { type: 'button', 'aria-label': '브리핑 서버 연결 테스트' },
      on: { click: onTestBriefingConnection },
    });
    if (store.briefing.busyTest) testBtn.disabled = true;
    actions.appendChild(testBtn);
    // 시스템 프롬프트 기본값 복원 — systemPrompt='' 저장(시드 사용). 폼도 비운다.
    const resetPromptBtn = el('button', {
      cls: 'btn', text: '프롬프트 기본값 복원',
      attrs: { type: 'button', 'aria-label': '시스템 프롬프트 기본값 복원' },
      on: { click: function () { store.briefing.form.systemPrompt = ''; onSetBriefingSettings({ systemPrompt: '' }); } },
    });
    if (store.briefing.busySettings) resetPromptBtn.disabled = true;
    actions.appendChild(resetPromptBtn);
    if (v.hasApiKey) {
      actions.appendChild(el('button', {
        cls: 'btn', text: '키 해제', attrs: { type: 'button', 'aria-label': 'API 키 해제' },
        on: { click: function () { onSetBriefingSettings({ apiKey: null }); } }, // null = 해제
      }));
    }
    block.appendChild(actions);

    // 연결 테스트 결과(L-1 textContent)
    const tr = store.briefing.testResult;
    if (tr) {
      const ok = tr.ok === true;
      const msg = ok
        ? ('연결 성공' + (tr.model ? ' · ' + tr.model : '') + (Number.isFinite(tr.latencyMs) ? ' · ' + tr.latencyMs + 'ms' : ''))
        : ('연결 실패' + (tr.code ? ' · ' + tr.code : ''));
      block.appendChild(el('div', { cls: 'briefing-test ' + (ok ? 'briefing-test--ok' : 'briefing-test--err'), text: msg }));
    }
    return block;
  }

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
      const ul = el('ul', { cls: 'rootmgr__list spip-scroll', attrs: { role: 'list' } });
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
   * 메일 알림 계정(복수 IMAP) — 추가/수정/삭제 + 연결 테스트. 비밀번호는 응답에 없음(공개 뷰).
   * ===================================================================== */
  function renderMailSettings() {
    const block = el('div', { cls: 'insight', children: [el('div', { cls: 'insight__title', text: '메일 알림 계정' })] });
    if (!bridgeHas('getMailAccounts')) {
      block.appendChild(el('div', { cls: 'rootmgr__empty', text: '이 환경에서는 메일 계정을 설정할 수 없습니다.' }));
      return block;
    }
    block.appendChild(el('p', { cls: 'settings__opt-sub', text: 'IMAP 계정을 추가하면 주기적으로 새 메일을 확인해 트레이로 알립니다. 비밀번호는 이 PC의 설정 파일(0600)에만 저장됩니다 — 2단계 인증 계정은 앱 비밀번호를 쓰고, Daum/Naver 등은 메일 설정에서 IMAP 사용을 먼저 켜세요.' }));

    const editing = store.mailEditingId;
    const f = store.mailForm;

    // 입력 폼(이름/서버/포트/아이디/비밀번호)
    const form = el('div', { cls: 'mailform' });
    const mkField = (key, labelText, placeholder, type) => {
      const wrap = el('label', { cls: 'mailform__field' });
      wrap.appendChild(el('span', { cls: 'mailform__label', text: labelText }));
      const input = el('input', {
        cls: 'rootmgr__input',
        attrs: { type: type || 'text', placeholder: placeholder || '', autocomplete: 'off', spellcheck: 'false' },
      });
      input.value = f[key] == null ? '' : String(f[key]);
      input.addEventListener('input', (e) => { store.mailForm[key] = e.target.value || ''; });
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); editing ? onUpdateMail() : onAddMail(); } });
      if (store.busyMail) input.disabled = true;
      wrap.appendChild(input);
      return wrap;
    };
    form.appendChild(mkField('label', '이름(선택)', '예: 회사 메일'));
    form.appendChild(mkField('host', 'IMAP 서버', '예: imap.daum.net'));
    form.appendChild(mkField('port', '포트', '993'));
    form.appendChild(mkField('user', '아이디', '예: me@daum.net'));
    form.appendChild(mkField('pass', editing ? '비밀번호(변경 시에만)' : '비밀번호', editing ? '비워두면 기존 유지' : '앱 비밀번호', 'password'));
    block.appendChild(form);

    const actions = el('div', { cls: 'rootmgr__inputrow' });
    const saveBtn = el('button', {
      cls: 'btn', text: editing ? '저장' : '추가',
      attrs: { type: 'button' }, on: { click: () => (editing ? onUpdateMail() : onAddMail()) },
    });
    const testBtn = el('button', { cls: 'btn', text: '연결 테스트', attrs: { type: 'button' }, on: { click: () => onTestMail() } });
    if (store.busyMail) { saveBtn.disabled = true; testBtn.disabled = true; }
    actions.appendChild(saveBtn);
    actions.appendChild(testBtn);
    if (editing) {
      const cancel = el('button', { cls: 'link-btn', text: '취소', attrs: { type: 'button' }, on: { click: onCancelMailEdit } });
      if (store.busyMail) cancel.disabled = true;
      actions.appendChild(cancel);
    }
    block.appendChild(actions);

    // 목록
    block.appendChild(el('div', { cls: 'rootmgr__label', text: '등록 계정 (' + store.mailAccounts.length + ')' }));
    if (store.mailAccounts.length === 0) {
      block.appendChild(el('div', { cls: 'rootmgr__empty', text: '등록된 메일 계정이 없습니다.' }));
    } else {
      const ul = el('ul', { cls: 'rootmgr__list spip-scroll', attrs: { role: 'list' } });
      for (const a of store.mailAccounts) {
        const li = el('li', { cls: 'rootmgr__item' });
        const desc = (a.label ? a.label + ' · ' : '') + (a.user || '') + ' @ ' + (a.host || '') + ':' + (a.port || 993);
        li.appendChild(el('span', { cls: 'rootmgr__path mono', text: desc, title: desc })); // L-1: textContent
        const test = el('button', {
          cls: 'rootmgr__remove', text: '테스트',
          attrs: { type: 'button', 'aria-label': '연결 테스트: ' + desc }, on: { click: () => onTestMail(a.id) },
        });
        const edit = el('button', {
          cls: 'rootmgr__remove', text: '수정',
          attrs: { type: 'button', 'aria-label': '계정 수정: ' + desc }, on: { click: () => onEditMail(a.id) },
        });
        const rm = el('button', {
          cls: 'rootmgr__remove', text: '삭제',
          attrs: { type: 'button', 'aria-label': '계정 삭제: ' + desc }, on: { click: () => onRemoveMail(a.id) },
        });
        if (store.busyMail) { test.disabled = true; edit.disabled = true; rm.disabled = true; }
        li.appendChild(test); li.appendChild(edit); li.appendChild(rm);
        ul.appendChild(li);
      }
      block.appendChild(ul);
    }
    return block;
  }

  function resetMailForm() {
    store.mailForm = { label: '', host: '', port: '', user: '', pass: '' };
    store.mailEditingId = null;
  }
  function applyMailResult(res) {
    if (res && res.ok && Array.isArray(res.accounts)) { store.mailAccounts = res.accounts; return true; }
    return false;
  }
  function describeMailError(res) {
    switch (res && res.code) {
      case 'INVALID_HOST': return 'IMAP 서버 주소가 올바르지 않습니다.';
      case 'INVALID_USER': return '아이디가 올바르지 않습니다.';
      case 'INVALID_PASS': return '비밀번호를 입력하세요.';
      case 'INVALID_PORT': return '포트는 1~65535 사이여야 합니다.';
      case 'NOT_FOUND': return '계정을 찾을 수 없습니다.';
      case 'LIMIT': return '계정 수가 상한에 도달했습니다.';
      case 'AUTH': return '로그인 실패 — 아이디/비밀번호 또는 IMAP 사용 설정을 확인하세요.';
      case 'NETWORK': return '서버에 연결하지 못했습니다. 주소/포트/네트워크를 확인하세요.';
      default: return '처리에 실패했습니다.';
    }
  }
  async function refreshMailAccounts() {
    if (!bridgeHas('getMailAccounts')) return;
    const res = await ipc('getMailAccounts');
    if (res && res.ok && Array.isArray(res.accounts)) store.mailAccounts = res.accounts;
    render();
  }
  async function onAddMail() {
    if (store.busyMail || !bridgeHas('addMailAccount')) return;
    store.busyMail = true; render();
    const res = await ipc('addMailAccount', store.mailForm);
    store.busyMail = false;
    if (applyMailResult(res)) { resetMailForm(); toast('메일 계정을 추가했습니다.'); }
    else toast(describeMailError(res), true);
    render();
  }
  async function onUpdateMail() {
    if (store.busyMail || !bridgeHas('updateMailAccount') || !store.mailEditingId) return;
    store.busyMail = true; render();
    const res = await ipc('updateMailAccount', store.mailEditingId, store.mailForm);
    store.busyMail = false;
    if (applyMailResult(res)) { resetMailForm(); toast('메일 계정을 저장했습니다.'); }
    else toast(describeMailError(res), true);
    render();
  }
  async function onRemoveMail(id) {
    if (store.busyMail || !bridgeHas('removeMailAccount')) return;
    store.busyMail = true; render();
    const res = await ipc('removeMailAccount', id);
    store.busyMail = false;
    if (applyMailResult(res)) { if (store.mailEditingId === id) resetMailForm(); toast('메일 계정을 삭제했습니다.'); }
    else toast(describeMailError(res), true);
    render();
  }
  function onEditMail(id) {
    const a = store.mailAccounts.find((x) => x && x.id === id);
    if (!a) return;
    store.mailEditingId = id;
    store.mailForm = { label: a.label || '', host: a.host || '', port: a.port ? String(a.port) : '', user: a.user || '', pass: '' };
    render();
  }
  function onCancelMailEdit() { resetMailForm(); render(); }
  async function onTestMail(id) {
    if (store.busyMail || !bridgeHas('testMailAccount')) return;
    // 목록의 '테스트'(id 문자열)면 저장된 계정 자격, 폼의 '연결 테스트'면 입력값(+편집 중이면 id).
    let payload;
    if (typeof id === 'string') {
      const a = store.mailAccounts.find((x) => x && x.id === id) || {};
      payload = { id, label: a.label, host: a.host, port: a.port, user: a.user };
    } else {
      payload = Object.assign({}, store.mailForm, store.mailEditingId ? { id: store.mailEditingId } : {});
    }
    store.busyMail = true; render();
    const res = await ipc('testMailAccount', payload);
    store.busyMail = false;
    if (res && res.ok) {
      const unseen = (res.status && Number.isFinite(res.status.unseen)) ? res.status.unseen : null;
      toast('연결 성공' + (unseen != null ? ' — 읽지 않음 ' + unseen + '통' : '') + '.');
    } else {
      toast(describeMailError(res), true);
    }
    render();
  }

  /* =====================================================================
   * 프로젝트 인식 기준 (detectSignals) — 디렉터리에 이 중 하나라도 있으면 프로젝트로 인식.
   *   이름(package.json) · 글로브(*.csproj) · 정규식(/.../). 추가·삭제·기본값 복원.
   * ===================================================================== */
  function renderDetectSettings() {
    const block = el('div', { cls: 'insight', children: [el('div', { cls: 'insight__title', text: '프로젝트 인식 기준' })] });
    if (!bridgeHas('addDetectSignals')) {
      block.appendChild(el('div', { cls: 'rootmgr__empty', text: '이 환경에서는 인식 기준을 설정할 수 없습니다.' }));
      return block;
    }
    block.appendChild(el('p', { cls: 'settings__opt-sub', text: '폴더 안에 아래 항목이 하나라도 있으면 프로젝트로 인식합니다. 정확한 이름(package.json), 확장자 글로브(*.csproj), 정규식(/패턴/)을 쓸 수 있습니다. 기본값은 시드로 제공되며, 삭제해도 “기본값 복원”으로 되돌릴 수 있습니다.' }));

    // 직접 입력 + 추가
    const inputRow = el('div', { cls: 'rootmgr__inputrow' });
    const input = el('input', {
      cls: 'rootmgr__input',
      attrs: { type: 'text', placeholder: '이름 · *.확장자 · /정규식/', 'aria-label': '인식 기준 추가', autocomplete: 'off', spellcheck: 'false' },
    });
    input.value = store.detectInput;
    input.addEventListener('input', (e) => { store.detectInput = e.target.value || ''; });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); onAddDetect(); } });
    const addBtn = el('button', { cls: 'btn', text: '추가', attrs: { 'aria-label': '인식 기준 추가' }, on: { click: onAddDetect } });
    if (store.busyDetect) { input.disabled = true; addBtn.disabled = true; }
    inputRow.appendChild(input);
    inputRow.appendChild(addBtn);
    block.appendChild(inputRow);

    // 목록 + 기본값 복원
    const head = el('div', { cls: 'detect__head' });
    head.appendChild(el('div', { cls: 'rootmgr__label', text: '인식 기준 (' + store.detectSignals.length + ')' }));
    const restoreBtn = el('button', {
      cls: 'link-btn', text: '기본값 복원', attrs: { type: 'button', 'aria-label': '인식 기준 기본값 복원' },
      on: { click: onRestoreDetect },
    });
    if (store.busyDetect) restoreBtn.disabled = true;
    head.appendChild(restoreBtn);
    block.appendChild(head);

    if (store.detectSignals.length === 0) {
      block.appendChild(el('div', { cls: 'rootmgr__empty', text: '인식 기준이 없습니다 — 어떤 폴더도 프로젝트로 인식되지 않습니다. “기본값 복원”을 누르세요.' }));
    } else {
      const defaultsSet = new Set(store.detectDefaults);
      const ul = el('ul', { cls: 'rootmgr__list spip-scroll', attrs: { role: 'list' } });
      for (const s of store.detectSignals) {
        const li = el('li', { cls: 'rootmgr__item' });
        li.appendChild(el('span', { cls: 'rootmgr__path mono', text: s, title: s }));
        if (defaultsSet.has(s)) li.appendChild(el('span', { cls: 'detect__badge', text: '기본' }));
        const rm = el('button', {
          cls: 'rootmgr__remove', text: '삭제',
          attrs: { type: 'button', 'aria-label': '인식 기준 제거: ' + s },
          on: { click: () => onRemoveDetect(s) },
        });
        if (store.busyDetect) rm.disabled = true;
        li.appendChild(rm);
        ul.appendChild(li);
      }
      block.appendChild(ul);
    }
    return block;
  }

  async function refreshDetectSignals() {
    if (!bridgeHas('getDetectSignals')) return;
    const res = await ipc('getDetectSignals');
    if (res && res.ok) {
      store.detectSignals = Array.isArray(res.detectSignals) ? res.detectSignals.filter((x) => typeof x === 'string') : [];
      store.detectDefaults = Array.isArray(res.defaults) ? res.defaults.filter((x) => typeof x === 'string') : [];
    }
    render();
  }
  function applyDetectResult(res, okMsg) {
    if (res && res.ok && Array.isArray(res.detectSignals)) {
      store.detectSignals = res.detectSignals.filter((x) => typeof x === 'string');
      if (okMsg) toast(okMsg);
      return true;
    }
    return false;
  }
  async function onAddDetect() {
    const v = (store.detectInput || '').trim();
    if (!v) { toast('이름·*.확장자·/정규식/ 중 하나를 입력하세요.', true); return; }
    if (!bridgeHas('addDetectSignals')) return;
    store.busyDetect = true; render();
    const res = await ipc('addDetectSignals', [v]);
    store.busyDetect = false;
    if (applyDetectResult(res, (res.added && res.added.length) ? '인식 기준을 추가했습니다.' : null)) {
      if (res.added && res.added.length) store.detectInput = '';
      else if (res.rejected && res.rejected.some((r) => r.reason === 'BAD_REGEX')) toast('정규식 형식이 올바르지 않습니다.', true);
      else if (res.rejected && res.rejected.length) toast('이미 있거나 추가할 수 없는 항목입니다.', true);
    } else {
      toast('인식 기준 추가에 실패했습니다.', true);
    }
    render();
  }
  async function onRemoveDetect(pattern) {
    if (!bridgeHas('removeDetectSignal')) return;
    store.busyDetect = true; render();
    const res = await ipc('removeDetectSignal', pattern);
    store.busyDetect = false;
    if (!applyDetectResult(res)) toast('인식 기준 삭제에 실패했습니다.', true);
    render();
  }
  async function onRestoreDetect() {
    if (!bridgeHas('restoreDetectSignals')) return;
    store.busyDetect = true; render();
    const res = await ipc('restoreDetectSignals');
    store.busyDetect = false;
    if (!applyDetectResult(res, '기본값으로 복원했습니다.')) toast('기본값 복원에 실패했습니다.', true);
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
      const behind = (typeof p.behind === 'number' ? p.behind : 0);
      const reclaim = stale && nm > 0; if (reclaim) reclaimMB += nm;
      const status = !p.isRepo ? { t: 'Git 아님', c: '#a8a29e' }
        : dirty ? { t: '미커밋', c: '#fbbf24' }
          : ahead > 0 ? { t: '미푸시 ' + ahead, c: '#60a5fa' }
            : behind > 0 ? { t: '받을 ' + behind, c: '#22d3ee' }
              : stale ? { t: '방치', c: '#a8a29e' }
                : { t: '정상', c: '#34d399' };
      const sz = szOf(p);
      return {
        id: p.id, name: p.name, path: p.path, lang: p.language, color: langColor(p.language),
        mod: age, nm, sizePx: 12 + Math.sqrt(sz / maxSz) * 40,
        stale, attention: p.isRepo && (dirty || ahead > 0 || behind > 0), reclaim, status,
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
      const id = orb.menu.id;
      menu.appendChild(el('button', {
        cls: 'orbit__ctxmenu-btn', text: '이 폴더를 제외에 추가', attrs: { type: 'button' },
        on: { click: () => { orb.menu = null; render(); orbExcludeDir(p); } },
      }));
      menu.appendChild(el('button', {
        cls: 'orbit__ctxmenu-btn', text: '경로 열기', attrs: { type: 'button' },
        on: { click: () => { orb.menu = null; render(); openProjectPath(id); } },
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

    // 상단 네비 탭(홈/프로젝트) — 뷰 전환. 궤도 맵은 액션 버튼으로 유지.
    const nav = el('nav', { cls: 'topnav', attrs: { 'aria-label': '주요 화면' } });
    [['home', '홈'], ['dashboard', '프로젝트']].forEach(([view, label]) => {
      const active = store.state.view === view;
      nav.appendChild(el('button', {
        cls: 'topnav__tab' + (active ? ' is-active' : ''),
        text: label,
        attrs: { type: 'button', 'aria-current': active ? 'page' : 'false', 'aria-label': label + ' 화면' },
        on: { click: () => { if (store.state.view !== view) { store.state.view = view; render(); if (view === 'home') maybeLoadMailSummary(); } } },
      }));
    });
    header.appendChild(nav);

    // [R-27] 검색은 프로젝트(대시보드) 화면에서만 노출 — 홈은 미니멀(검색 없음). 뷰별 차이는 이것 하나뿐.
    const { showSearch } = headerViewConfig(store.state.view);
    if (showSearch) {
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
      // [R-25/R-26 RG-4] 검색 갱신은 RG.coalesce 단일 게이트로 일원화(debounce(render,120) 대체 — 동일 120ms).
      //   조합 중(_composing)이면 deferred()=true 라 render 보류(자모 분리 방지), compositionend 시 1회 반영.
      //   헤더 공통 골격으로 재구성 후에도 검색 input 에는 반드시 RG.composition.bind 가 유지된다(IME 회귀 0).
      RG.composition.bind(searchInput);
      searchInput.addEventListener('input', (e) => { store.state.search = e.target.value || ''; RG.coalesce.request(); });
      searchWrap.appendChild(searchInput);
      header.appendChild(searchWrap);
    }

    header.appendChild(el('div', { cls: 'spacer' }));

    // [R-27] 공통 액션 영역 — 홈·프로젝트 두 뷰가 동일 위치·동일 동작으로 공유(early-return 제거).
    //   '마지막 스캔' 보조 텍스트도 두 뷰 공통(홈 미니멀 유지하되 공통 액션 진입점은 노출).
    //   [Q5] 헤더 '도움말' 버튼은 제거 — 도움말/정보 진입은 설정 '정보' 섹션으로 이관됨(P3).
    const actions = el('div', { cls: 'topbar__actions' });
    if (store._snapshotLabel) {
      actions.appendChild(el('span', { cls: 'muted snapshot-label', text: store._snapshotLabel }));
    }

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
    // 경로 열기(탐색기)
    acts.appendChild(openPathButton(vm, 'btn btn--ghost btn--sm'));
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

  /** 경로 열기 버튼 — id로 프로젝트 폴더를 OS 탐색기에서 연다(main이 화이트리스트 검증). */
  function openPathButton(vm, cls) {
    const btn = el('button', {
      cls: cls || 'btn btn--ghost btn--sm', text: '경로 열기',
      attrs: { type: 'button', 'aria-label': '폴더 열기: ' + vm.path },
      on: { click: (e) => { e.stopPropagation(); openProjectPath(vm.id); } },
    });
    return btn;
  }

  /** Git 배지들(카드/표 공용). table=true면 컴팩트 클래스. */
  function appendGitBadges(container, vm, table) {
    const pfx = table ? 'badge--t ' : '';
    if (vm.gitStatus === 'na') { container.appendChild(badge(pfx + 'badge--git-na', 'Git 아님')); return; }
    if (vm.gitStatus === 'dirty') container.appendChild(badge(pfx + 'badge--git-dirty', '미커밋'));
    if (vm.ahead > 0) container.appendChild(badge(pfx + 'badge--git-ahead', '미푸시 ' + vm.ahead));
    if (vm.behind > 0) container.appendChild(badge(pfx + 'badge--git-behind', '받을 ' + vm.behind)); // pull 필요
    if (vm.gitStatus !== 'dirty' && !(vm.ahead > 0) && !(vm.behind > 0)) container.appendChild(badge(pfx + 'badge--git-clean', '정상'));
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
      actWrap.appendChild(openPathButton(vm, 'btn btn--ghost btn--sm')); // 경로 열기(탐색기)
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
    store.editingName = null; store.nameInput = ''; // 이름 편집 상태 정리
    const opener = store._drawerOpener;
    store._drawerOpener = null;
    // [F-1] 드로어 닫힘(overlayOpen 해제) 지점 — release()로 즉시 1회 반영 + 보류 중이던 push 누적분 소비.
    RG.coalesce.release();
    maybeFlushCommitRefresh(); // [M10-P1] overlayOpen 해제 → 보류된 커밋 폴링 따라감
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
    const titlewrap = el('div', { cls: 'drawer__titlewrap' });
    if (store.editingName === vm.id) {
      // 이름 편집 모드 — 입력 + 저장/취소(+별칭 해제).
      const input = el('input', { cls: 'drawer__name-input', attrs: { type: 'text', 'aria-label': '프로젝트 표시 이름', maxlength: '120', autocomplete: 'off', spellcheck: 'false' } });
      input.value = store.nameInput;
      input.addEventListener('input', (e) => { store.nameInput = e.target.value || ''; });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); onSaveName(vm.id); }
        else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onCancelName(); }
      });
      const editRow = el('div', { cls: 'drawer__name-edit', children: [
        input,
        el('button', { cls: 'btn btn--sm btn--dark', text: '저장', attrs: { type: 'button' }, on: { click: () => onSaveName(vm.id) } }),
        el('button', { cls: 'btn btn--sm', text: '취소', attrs: { type: 'button' }, on: { click: onCancelName } }),
      ]});
      titlewrap.appendChild(editRow);
      if (store.projectNames[vm.id]) {
        const det = store.detectedNames[vm.id] || '';
        titlewrap.appendChild(el('button', { cls: 'link-btn drawer__name-reset', text: '감지명으로 복원' + (det ? ' (' + det + ')' : ''), attrs: { type: 'button' }, on: { click: () => onSaveName(vm.id, '') } }));
      }
      titlewrap.appendChild(el('div', { cls: 'drawer__path mono', text: vm.path }));
      setTimeout(() => { try { input.focus(); input.select(); } catch (_) { /* ignore */ } }, 0);
    } else {
      const nameEl = el('div', { cls: 'drawer__name', attrs: { id: titleId } });
      nameEl.appendChild(el('span', { text: vm.name }));
      if (store.projectNames[vm.id]) nameEl.appendChild(el('span', { cls: 'drawer__alias-badge', text: '별칭' }));
      if (bridgeHas('setProjectName')) {
        const editBtn = el('button', { cls: 'drawer__name-edit-btn', attrs: { type: 'button', 'aria-label': '이름 수정', title: '이름 수정' }, on: { click: () => onStartEditName(vm) } });
        editBtn.appendChild(svg([{ t: 'path', d: 'M12 20h9' }, { t: 'path', d: 'M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z' }], { size: 13, sw: 1.8 }));
        nameEl.appendChild(editBtn);
      }
      titlewrap.appendChild(nameEl);
      titlewrap.appendChild(el('div', { cls: 'drawer__path mono', text: vm.path }));
    }
    head.appendChild(titlewrap);
    const close = el('button', { cls: 'drawer__close', text: '×', attrs: { 'aria-label': '닫기' }, on: { click: closeDrawer } });
    head.appendChild(close);
    aside.appendChild(head);

    const bodyWrap = el('div', { cls: 'drawer__body' });

    // open button + desc
    const openBtn = openButton(vm, 'btn btn--dark btn--block');
    openBtn.textContent = store.state.opening[vm.id] ? '여는 중…' : 'VS Code로 열기';
    openBtn.prepend(svg([{ t: 'path', d: 'M5 12h14M13 6l6 6-6 6' }], { size: 14 }));
    bodyWrap.appendChild(openBtn);
    // 경로 열기(탐색기) + 즐겨찾기 토글
    const drawerActs = el('div', { cls: 'drawer__acts' });
    drawerActs.appendChild(openPathButton(vm, 'btn'));
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
        store.showFirstRun = true; // 스캔 결과 0 → 홈 위 스캔 팝업 유지
        await refreshConfig(); // 루트 표시 갱신
      } else {
        store.raw = payload.projects;
        store.viewModels = payload.projects.map(toViewModel);
        store.showFirstRun = false; // 프로젝트 발견 → 팝업 닫음
        captureDetectedNames(); applyProjectNames(); // 감지명 캡처 + 별칭 적용
      }
      // ★ 재스캔/스캔 완료 후 UI 상태(즐겨찾기·수동순서·별칭)를 다시 적재한다. 이전엔 reloadAfterScan이
      //   viewModels만 재구성하고 ui-state를 재로드하지 않아 대시보드 카드에 즐겨찾기 별이 사라졌다
      //   (특히 firstRun→스캔 경로에선 처음부터 미로드). getUiState가 현재 스냅샷 id로 머지·정리도 수행.
      if (bridgeHas('getUiState')) { try { await loadUiState(); } catch (_) { /* graceful */ } }
      // scanning(스캔 done) 또는 dashboard/firstRun(메뉴 새로고침)에서만 결과 뷰로 전환.
      // 그 외(error/loading 등)는 현 뷰 유지 — 사용자 컨텍스트 보존.
      const v = store.state.view;
      // 결과 뷰는 항상 홈(브리핑). 스냅샷 0이면 홈 위 스캔 팝업이 함께 뜬다.
      if (v === 'scanning' || v === 'dashboard' || v === 'firstRun' || v === 'home') store.state.view = 'home';
      store.scan.ownScanId = null; // P2-3 보강: 잔여 구독 재진입 차단(전환 완료 후 리셋)
      render();
    } catch (err) {
      toast('스캔은 끝났지만 결과를 불러오지 못했습니다: ' + (err && err.message ? err.message : '오류'), true);
    }
  }

  // [R-28] 네이티브 메뉴(spip:menu:*) 제거 — subscribeMenu/unsubscribeMenu/onMenuCommand 폐기.
  //   메뉴가 제공하던 기능은 모두 대체 경로로 이관됨:
  //     폴더추가 → 설정 '스캔 폴더' + 단축키 Ctrl+O / 재스캔 → 헤더 '재스캔' 버튼 + 단축키 Ctrl+R
  //     새로고침 → 단축키 F5(refreshDashboard) / 정보(About) → 설정 '정보' 섹션(renderInfoSettings)
  //   preload onMenu 화이트리스트(spip:menu:pickFolders·rescan·refresh·about)도 함께 제거(SEC-L1 양방향).

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

  /* =====================================================================
   * [M12 b3] 권한 상승 경고 배너 — main(elevationGuard)이 보내는 'spip:elevation:warning'
   *   단방향 push 를 받아 상단 고정 배너를 1회 표시한다(textContent 만, L-1). 실제 APPDATA 경로·
   *   프로필명·whoami 출력은 절대 표시하지 않는다(정보노출 차단). 부재(웹/테스트) graceful.
   * ===================================================================== */
  var _elevationUnsub = null;
  var _elevationBannerEl = null;
  // 고정 문구(L-1). 데이터 의존 0 — 어떤 동적값도 섞지 않는다.
  var ELEVATION_BANNER_TEXT = '관리자 권한으로 실행 중입니다. 데이터가 다르게 보일 수 있어 변경 저장이 일시 중단됩니다. 일반 권한으로 다시 실행하세요.';
  function showElevationBanner() {
    if (_elevationBannerEl) return; // 1회만
    if (typeof document === 'undefined' || !document.body) return;
    var banner = el('div', {
      cls: 'elevation-banner',
      attrs: { role: 'alert', 'aria-live': 'assertive' },
      children: [
        el('span', { cls: 'elevation-banner__icon', text: '⚠', attrs: { 'aria-hidden': 'true' } }),
        el('span', { cls: 'elevation-banner__text', text: ELEVATION_BANNER_TEXT }), // L-1: 고정 문구만
      ],
    });
    _elevationBannerEl = banner;
    document.body.insertBefore(banner, document.body.firstChild);
    try { document.body.classList.add('has-elevation-banner'); } catch (_) { /* ignore */ }
  }
  function subscribeElevationWarning() {
    unsubscribeElevationWarning();
    if (!hasBridge() || typeof spip.onElevationWarning !== 'function') return; // graceful
    var unsub = spip.onElevationWarning(function () { showElevationBanner(); });
    _elevationUnsub = (typeof unsub === 'function') ? unsub : null;
  }
  function unsubscribeElevationWarning() {
    if (typeof _elevationUnsub === 'function') {
      try { _elevationUnsub(); } catch (_) { /* ignore */ }
    }
    _elevationUnsub = null;
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

  /* 메일 실시간 갱신 — 새 메일 감지 push(즉시) + 홈 체류 중 주기 갱신(읽음/도착 반영).
   *   편집(할 일 입력)·모달 중에는 보류해 포커스/스크롤 방해를 막는다. */
  function maybeAutoRefreshMail() {
    if (store.state.view !== 'home' || !bridgeHas('getMailSummary')) return;
    if (store.busyMailSummary || store.showSettings || store.showHelp || store.todoAdding) return;
    refreshMailSummary({ silent: true }); // [M11] 폴링/push 는 silent(진입 로딩 render 생략 → 깜빡임 0)
  }
  function subscribeMailUpdated() {
    unsubscribeMailUpdated();
    if (!hasBridge() || typeof spip.onMailUpdated !== 'function') return; // graceful
    const unsub = spip.onMailUpdated(() => maybeAutoRefreshMail());
    store.mailUpdatedUnsubscribe = (typeof unsub === 'function') ? unsub : null;
  }
  function unsubscribeMailUpdated() {
    if (typeof store.mailUpdatedUnsubscribe === 'function') {
      try { store.mailUpdatedUnsubscribe(); } catch (_) { /* ignore */ }
    }
    store.mailUpdatedUnsubscribe = null;
  }
  function startMailAutoRefresh() {
    if (store.mailRefreshTimer || !bridgeHas('getMailSummary')) return;
    store.mailRefreshTimer = setInterval(maybeAutoRefreshMail, 60000);
  }
  function stopMailAutoRefresh() {
    if (store.mailRefreshTimer) { try { clearInterval(store.mailRefreshTimer); } catch (_) { /* ignore */ } store.mailRefreshTimer = null; }
  }

  /* [백로그2-4] 할 일 마감 도래 감시 — 30초 주기. 마감 시각 경과 시 윈도우 토스트 1회(세션 dedupe),
   *   임박/경과 상태가 바뀌면 홈에서 할 일 위젯 색을 갱신(과도 렌더 방지로 상태 시그니처 비교). 뷰 무관 동작(알림은 항상). */
  var _lastDueSig = '';
  function tickTodoDue() {
    var todos = Array.isArray(store.todos) ? store.todos : [];
    var now = Date.now();
    var sig = [];
    for (var i = 0; i < todos.length; i++) {
      var t = todos[i];
      if (!t || t.done || typeof t.dueAt !== 'number' || !isFinite(t.dueAt) || t.dueAt <= 0) continue;
      var info = todoDueInfo(t.dueAt, now);
      if (info) sig.push(t.id + ':' + info.state);
      // 마감 경과 + 미발화 → 토스트 1회.
      if (now >= t.dueAt && !store.notifiedDue.has(t.id)) {
        store.notifiedDue.add(t.id);
        if (bridgeHas('notify')) { try { ipc('notify', '할 일 마감', t.text); } catch (_) { /* graceful */ } }
      }
    }
    var newSig = sig.join('|');
    if (newSig !== _lastDueSig) {
      _lastDueSig = newSig;
      if (store.state.view === 'home') render(); // 임박/경과 색 갱신
    }
  }
  function startTodoDueWatch() {
    if (store._dueTimer) return;
    tickTodoDue();
    store._dueTimer = setInterval(tickTodoDue, 30000);
  }
  function stopTodoDueWatch() {
    if (store._dueTimer) { try { clearInterval(store._dueTimer); } catch (_) { /* ignore */ } store._dueTimer = null; }
  }

  /* [R-31] 커밋 차트 5분 폴링 — 홈 체류 + 창 가시 상태에서만 git 조회. 홈 이탈/비가시 시 타이머 정지(git 호출 0).
   *   메일 60초 폴링 패턴 복제(주기만 300초). 갱신은 refreshCommitActivity(완료 시 RG.coalesce.release 경유).
   *   조합/드래그/오버레이/재진입 중에는 RG.deferred()로 폴링 1회 건너뜀(다음 틱에 반영) — R-25/R-26 정합. */
  var _pendingCommitRefresh = false; // [M10-P1] 보류로 건너뛴 폴링 틱 추적(해제 시 1회 따라감)
  function maybeAutoRefreshCommit() {
    if (store.state.view !== 'home' || !bridgeHas('getCommitActivity')) return;
    if (store.busyCommitActivity) return;            // 재진입 방지(in-flight)
    if (RG.deferred()) {                             // 조합·드래그·오버레이·busy 중엔 보류
      _pendingCommitRefresh = true;                  // [M10-P1] 건너뜀 기록 → 해제 지점에서 따라감
      return;
    }
    _pendingCommitRefresh = false;
    refreshCommitActivity({ silent: true });         // [M10-P1/F-1] 폴링은 silent(진입 로딩 render 생략)
  }
  /** [M10-P1] 보류 해제 지점에서 호출 — 건너뛴 폴링 틱이 있으면 즉시 1회 커밋 갱신(silent).
   *   pending 가드 + busyCommit/deferred 재진입 가드로 이중 발화 방지. 8곳(release/flushIfPending 옆)에 동반. */
  function maybeFlushCommitRefresh() {
    if (!_pendingCommitRefresh) return;
    if (store.state.view !== 'home') { _pendingCommitRefresh = false; return; }
    if (store.busyCommitActivity || RG.deferred()) return; // 아직 보류 중이면 다음 해제 지점에서 재시도
    _pendingCommitRefresh = false;
    refreshCommitActivity({ silent: true });
  }
  function startCommitAutoRefresh() {
    if (store.commitRefreshTimer || !bridgeHas('getCommitActivity')) return;
    store.commitRefreshTimer = setInterval(maybeAutoRefreshCommit, COMMIT_POLL_MS);
  }
  function stopCommitAutoRefresh() {
    if (store.commitRefreshTimer) { try { clearInterval(store.commitRefreshTimer); } catch (_) { /* ignore */ } store.commitRefreshTimer = null; }
  }
  /** [R-31] 홈 뷰/가시성 상태에 따라 커밋 폴링 타이머를 시작/정지하는 단일 게이트.
   *   뷰 전환·visibilitychange 에서 호출 → shouldPollCommit 이 false 면 정지(홈 비활성 시 git 0). */
  function syncHomePolling() {
    const visible = (typeof document !== 'undefined' && typeof document.visibilityState === 'string')
      ? document.visibilityState !== 'hidden'
      : true; // visibilityState 미지원 환경 graceful(가시로 간주)
    if (shouldPollCommit(store.state.view, visible)) startCommitAutoRefresh();
    else stopCommitAutoRefresh();
  }

  /* [M13] 브리핑 AI — 1회 초기화(설정 적재 + carry-over 항목 + push 구독). 홈 진입 시 호출(graceful). */
  function maybeInitBriefing() {
    if (store.briefing.subscribed || !spip || !spip.briefing) return;
    store.briefing.subscribed = true;
    subscribeBriefing();
    // 설정 적재(enabled·hasApiKey — 키 평문 없음).
    if (typeof spip.briefing.getSettings === 'function') {
      Promise.resolve(spip.briefing.getSettings()).then(function (res) {
        var v = briefingSettingsView(res);
        store.briefing.settings = v;
        store.briefing.enabled = v.enabled;
        patchBriefing();
      }).catch(function () { /* graceful — 정적 폴백 유지 */ });
    }
  }
  /** push 구독(onState/onDelta/onDone/onError) — gen 가드로 취소분 무시. 영역만 patch. */
  function subscribeBriefing() {
    if (!spip || !spip.briefing) return;
    var subs = [];
    if (typeof spip.briefing.onState === 'function') subs.push(spip.briefing.onState(function (p) {
      if (!p || typeof p !== 'object') return;
      store.briefing.status = (typeof p.status === 'string') ? p.status : store.briefing.status;
      if (p.status === 'disabled') store.briefing.enabled = false;
      else if (p.status === 'generating') { store.briefing.streamText = ''; store.briefing.streamItems = []; store.briefing.streamMode = 'text'; store.briefing.lastError = null; }
      if (typeof p.code === 'string') store.briefing.lastError = p.code;
      patchBriefing();
    }));
    if (typeof spip.briefing.onDelta === 'function') subs.push(spip.briefing.onDelta(function (p) {
      if (!p || !briefingAcceptsGen(store.briefing.gen, p.gen)) return; // [R-35] 이전 세대 잔여 무시
      if (Number(p.gen) > store.briefing.gen) { store.briefing.gen = Number(p.gen); store.briefing.streamText = ''; store.briefing.streamItems = []; store.briefing.streamMode = 'text'; } // 새 세대 시작 → 버퍼 초기화
      store.briefing.status = 'streaming';
      store.briefing.streamText += (typeof p.chunk === 'string') ? p.chunk : ''; // 평문 모드 표시용 누적
      if (p.mode === 'json' || p.mode === 'text') store.briefing.streamMode = p.mode;
      // JSON 모드: 완성된 부분 항목만 카드로 점진 표시(원문 JSON 숨김). 항목 수 변동 시에만 동봉됨.
      if (Array.isArray(p.items)) store.briefing.streamItems = p.items;
      patchBriefing();
    }));
    if (typeof spip.briefing.onDone === 'function') subs.push(spip.briefing.onDone(function (p) {
      if (!p || !briefingAcceptsGen(store.briefing.gen, p.gen)) return; // [R-35] 이전 세대 잔여 무시
      store.briefing.gen = Number(p.gen);
      store.briefing.status = 'done';
      store.briefing.streamText = '';
      store.briefing.items = Array.isArray(p.items) ? p.items.filter(function (x) { return x && typeof x.key === 'string'; }) : [];
      patchBriefing();
      refreshAiUsage(); // [연결 모델 사용량] 생성 완료 → 누적 토큰 재조회해 위젯 갱신
    }));
    if (typeof spip.briefing.onError === 'function') subs.push(spip.briefing.onError(function (p) {
      if (p && Number.isFinite(p.gen) && !briefingAcceptsGen(store.briefing.gen, p.gen)) return;
      store.briefing.status = 'error';
      store.briefing.lastError = (p && typeof p.code === 'string') ? p.code : 'UNKNOWN';
      patchBriefing();
    }));
    store.briefing._unsubs = subs;
  }
  function unsubscribeBriefing() {
    var subs = store.briefing._unsubs || [];
    for (var i = 0; i < subs.length; i++) { try { if (typeof subs[i] === 'function') subs[i](); } catch (_) {} }
    store.briefing._unsubs = [];
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
    captureDetectedNames(); applyProjectNames(); // 갱신/신규 항목에 감지명 캡처 + 별칭 적용
    // stale KPI 로컬 보정(freshness 변동 반영).
    if (store.stats && typeof store.stats === 'object') {
      store.stats.staleCount = store.viewModels.filter((v) => v && v.isStale).length;
    }
    // [R-25 RG-4] 라이브 뷰면 RG.coalesce 단일 게이트로 위임 — 보류 판정(드래그/오버레이/조합/busyMail 등)은
    //   deferred() 가 일괄 담당(§3.2 매핑표). 보류 중엔 데이터만 병합하고 렌더 보류(모달 깜빡임/포커스 손실 방지),
    //   보류 해제 지점에서 1회 반영. 오버레이 닫힘은 close* 가 직접 render() 하므로 데이터는 즉시 반영된다.
    const liveView = store.state.view === 'dashboard' || store.state.view === 'home';
    if (liveView) RG.coalesce.request();
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

  /* =====================================================================
   * #6 도움말 팝업 — 프로젝트 인식 패턴 + 각 항목(설명·언어·변경일자·Git·크기 등) 산출 기준 설명.
   *   [R-28] 진입점: 헤더 '도움말' 버튼 + 설정 '정보' 섹션의 '도움말 보기'(메뉴 '정보' 이관).
   * ===================================================================== */
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
    // [F-1] 도움말 닫힘(overlayOpen 해제) 지점 — release()로 즉시 1회 반영 + 보류 중이던 push 누적분 소비.
    RG.coalesce.release();
    maybeFlushCommitRefresh(); // [M10-P1] overlayOpen 해제 → 보류된 커밋 폴링 따라감
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
   * 경로 열기 — id로 프로젝트 폴더를 OS 탐색기에서 연다(main이 화이트리스트 검증 후 shell.openPath).
   * ===================================================================== */
  /* =====================================================================
   * 프로젝트 표시 이름(별칭) 편집 — ui-state에 영속(setProjectName).
   * ===================================================================== */
  function onStartEditName(vm) {
    store.editingName = vm.id;
    store.nameInput = store.projectNames[vm.id] || vm.name || '';
    render();
  }
  function onCancelName() {
    store.editingName = null;
    store.nameInput = '';
    render();
  }
  async function onSaveName(id, forceVal) {
    if (!bridgeHas('setProjectName')) { store.editingName = null; render(); return; }
    const val = (forceVal !== undefined) ? forceVal : (store.nameInput || '').trim();
    const res = await ipc('setProjectName', id, val);
    if (res && res.ok && res.names && typeof res.names === 'object') {
      store.projectNames = res.names;
      applyProjectNames();
      store.editingName = null; store.nameInput = '';
      toast(val ? '이름을 변경했습니다.' : '별칭을 해제했습니다(감지명 복원).');
    } else {
      toast('이름 변경에 실패했습니다.', true);
    }
    render();
  }

  async function openProjectPath(id) {
    if (!id) return;
    if (!bridgeHas('openPath')) { toast('이 환경에서는 폴더 열기를 사용할 수 없습니다.', true); return; }
    const res = await ipc('openPath', id);
    if (res && res.ok) toast('폴더를 여는 중…');
    else if (res && res.code === 'PATH_GONE') toast('경로를 찾을 수 없습니다(이동·삭제됨).', true);
    else if (res && res.code === 'PATH_NOT_ALLOWED') toast('허용되지 않은 경로입니다.', true);
    else toast('폴더를 열지 못했습니다.', true);
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
        store._dragging = false; // [R4] 보류 해제는 즉시, 단 render/flush 는 마이크로태스크로(아래).
        const reorder = !!(evt && evt.oldIndex !== evt.newIndex);
        let newIds = [];
        if (reorder) {
          const grid2 = evt.to || grid;
          newIds = Array.prototype.slice.call(grid2.querySelectorAll('[data-card-id]'))
            .map((n) => (n.dataset && n.dataset.cardId) || '')
            .filter((x) => typeof x === 'string' && x);
        }
        // [R4·F-1] onEnd 실행 중 render()가 이 Sortable 인스턴스를 destroy 하지 않도록 마이크로태스크로 지연.
        //   순서가 바뀌었으면 commitReorder(자체 render), 아니면 드래그 중 보류된 push 누적분만 1회 flush.
        Promise.resolve().then(() => {
          if (reorder && newIds.length) commitReorder(newIds);
          else RG.coalesce.flushIfPending();
          maybeFlushCommitRefresh(); // [M10-P1] dragging 해제 → 보류된 커밋 폴링 따라감
        });
      },
    });
  }

  /* =====================================================================
   * [R-32] 홈 섹션 드래그 재정렬 (.home-masonry / .home-section)
   *   카드 Sortable 선례와 동형: ghost 프리뷰 + onEnd 마이크로태스크 지연(R4). 드롭 시 DOM 의
   *   data-home-section enum 순서를 읽어 setHomeLayout 영속 → 응답 정규화 순서를 store 반영.
   *   RG.widget('homeSections')로 render() 1회당 destroy/recreate(중복 인스턴스·핸들러 누적 0).
   * ===================================================================== */
  let homeSortable = null;
  function destroyHomeSortable() {
    if (homeSortable && typeof homeSortable.destroy === 'function') {
      try { homeSortable.destroy(); } catch (_) { /* ignore */ }
    }
    homeSortable = null;
  }
  function initHomeSortable() {
    destroyHomeSortable();
    if (typeof document === 'undefined') return;
    const Sortable = (typeof window !== 'undefined') ? window.Sortable : null;
    if (!Sortable || typeof Sortable.create !== 'function') return; // 라이브러리 부재 — 재정렬 비활성(표시는 정상)
    const grid = document.querySelector('.home-masonry');
    if (!grid) return; // 홈 뷰 아님
    homeSortable = Sortable.create(grid, {
      draggable: '.home-section',
      // 섹션 내부 인터랙티브 컨트롤(버튼/링크/입력)에서 시작하는 포인터다운은 드래그로 잡지 않음(클릭 보존).
      filter: 'button, a, input, select, textarea, .btn',
      preventOnFilter: false,
      animation: prefersReducedMotion() ? 0 : 160,
      easing: 'cubic-bezier(.2,.8,.2,1)',
      ghostClass: 'home-section--ghost',   // placeholder(드롭 위치 미리보기)
      chosenClass: 'home-section--chosen',
      dragClass: 'home-section--drag',
      fallbackTolerance: 4,
      // [R-25] 드래그 동안 라이브 push/폴링 재렌더 보류(_dragging → RG.deferred()).
      onStart: () => { store._dragging = true; },
      onEnd: (evt) => {
        store._dragging = false; // [R4] 보류 해제 즉시, render/flush 는 마이크로태스크로(아래).
        const reorder = !!(evt && evt.oldIndex !== evt.newIndex);
        let ids = [];
        if (reorder) {
          ids = Array.prototype.slice.call(grid.querySelectorAll('[data-home-section]'))
            .map((n) => (n.dataset && n.dataset.homeSection) || '')
            .filter((x) => typeof x === 'string' && x);
        }
        // [R4] onEnd 도중 RG.widget.destroyAll 이 이 Sortable 을 파괴하지 않도록 마이크로태스크 지연.
        Promise.resolve().then(() => {
          if (reorder && ids.length) commitHomeLayout(ids);
          else RG.coalesce.flushIfPending();
          maybeFlushCommitRefresh(); // [M10-P1] dragging 해제 → 보류된 커밋 폴링 따라감
        });
      },
    });
  }
  /** [R-32] 새 섹션 순서 영속 — 낙관적 store 반영 + setHomeLayout IPC → 응답 정규화 순서로 확정.
   *   메인 normalizeHomeLayout 이 단일 신뢰 경계(렌더러 ids 는 enum 필터만, UX 편의). */
  function commitHomeLayout(ids) {
    const next = applyHomeLayout(ids);           // 렌더러 동형 정규화(낙관적)
    store.homeLayout = next;
    render();                                    // 새 순서 즉시 반영(드래그 종료 후 1회)
    if (!bridgeHas('setHomeLayout')) return;      // 웹/테스트 graceful
    ipc('setHomeLayout', next).then((res) => {
      if (res && res.ok && Array.isArray(res.homeLayout)) {
        store.homeLayout = applyHomeLayout(res.homeLayout); // 메인 정규화 최종 순서로 확정
        render();
      }
      // 응답 실패여도 낙관적 순서 유지(다음 getUiState 에서 정합) — 토스트 없음(섹션 순서는 비파괴적).
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
    store.projectNames = uv.names || {};
    store.theme = uv.theme || 'system';
    // 할 일(홈 브리핑) — getUiState 응답에 포함. 형식 무효 시 빈 배열.
    store.todos = (res && res.ok !== false && Array.isArray(res.todos)) ? res.todos.filter((t) => t && typeof t.id === 'string') : [];
    // [R-32] 홈 섹션 순서 — getUiState 응답의 homeLayout 적재(부재/손상 시 동형 정규화로 기본 순서 보충).
    store.homeLayout = applyHomeLayout(res && res.ok !== false ? res.homeLayout : null);
    // [위젯 추가/제거] 숨긴(미적용) 위젯 적재 — 토글 가능 위젯 화이트리스트만(부재/손상 시 빈 = 전부 표시).
    store.hiddenWidgets = (res && res.ok !== false && Array.isArray(res.hiddenWidgets))
      ? res.hiddenWidgets.filter(function (id) { return TOGGLEABLE_WIDGET_IDS.indexOf(id) >= 0; }) : [];
    // [항목3] 연결된 LLM 모델 토큰 사용량 누적 적재(브리핑 생성 시 메인이 누적·영속).
    store.aiUsage = (res && res.ok !== false && res.aiUsage && typeof res.aiUsage === 'object') ? res.aiUsage : null;
    // [M13] 브리핑 carry-over 항목(open) 적재 — 영속 단일 출처. 실시간 생성상태는 push 로 갱신.
    var bf = (res && res.ok !== false && res.briefing && typeof res.briefing === 'object') ? res.briefing : null;
    if (bf) {
      store.briefing.items = Array.isArray(bf.items) ? bf.items.filter((x) => x && typeof x.key === 'string') : [];
      store.briefing.counters = (bf.counters && typeof bf.counters === 'object') ? bf.counters : null;
    }
    applyProjectNames();   // 별칭을 현재 viewModels에 반영
    applyTheme();          // 테마 적용(라이트/다크/시스템)
  }

  /** viewModels 빌드 직후 감지명을 캡처(별칭 해제 시 복원 기준). */
  function captureDetectedNames() {
    const det = {};
    for (const vm of store.viewModels) det[vm.id] = (store.detectedNames[vm.id] != null) ? store.detectedNames[vm.id] : vm.name;
    store.detectedNames = det;
  }
  /** 표시 이름 = 별칭(있으면) || 감지명. vm.name을 덮어써 모든 표시·검색에 일괄 반영(DRY). */
  function applyProjectNames() {
    const names = store.projectNames || {};
    const det = store.detectedNames || {};
    for (const vm of store.viewModels) {
      const alias = names[vm.id];
      vm.name = (typeof alias === 'string' && alias) ? alias : (det[vm.id] != null ? det[vm.id] : vm.name);
    }
  }

  /* =====================================================================
   * 테마 (라이트/다크/시스템) — data-theme 속성 + CSS 변수 오버라이드.
   * ===================================================================== */
  function prefersDark() {
    try { return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches); } catch (_) { return false; }
  }
  function resolveTheme() {
    if (store.theme === 'light' || store.theme === 'dark') return store.theme;
    return prefersDark() ? 'dark' : 'light'; // system
  }
  function applyTheme() {
    try { document.documentElement.setAttribute('data-theme', resolveTheme()); } catch (_) { /* ignore */ }
  }
  /** 테마 변경(낙관적 반영 + IPC 영속). */
  function onSetTheme(theme) {
    store.theme = (theme === 'light' || theme === 'dark' || theme === 'system') ? theme : 'system';
    applyTheme();
    render();
    if (bridgeHas('setTheme')) ipc('setTheme', store.theme);
  }
  /** 시스템 테마 변경 구독(앱 1회) — theme==='system'일 때만 재적용. */
  function subscribeSystemTheme() {
    try {
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      const h = () => { if (store.theme === 'system') applyTheme(); };
      if (typeof mq.addEventListener === 'function') mq.addEventListener('change', h);
      else if (typeof mq.addListener === 'function') mq.addListener(h); // 구형
    } catch (_) { /* matchMedia 부재 graceful */ }
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
   * [R-25] RG — 부분 갱신/재렌더 가드 네임스페이스 (RG-1~RG-4)
   *   설계 m9-design.html §3. 순수 판정 로직(보류 OR식·coalesce 상태기)은
   *   lib/common/renderGuard.js 가 정본이며(ADR-M9-1, node:test), 여기 RG 는 그 알고리즘을
   *   store/DOM 에 잇는 얇은 동형 어댑터다(플래그 수집 + 동일 OR식, 로직 변형 금지).
   *
   *   - composition(RG-1): IME 조합 추적(_composing) + render 게이트 입력.
   *   - deferred()  : 흩어진 보류 조건 6종을 한 곳으로 모아 단일 게이트화(§3.2 매핑표 1:1).
   *   - preserve(RG-2): 기존 FOCUS_SEL/SCROLL_SEL 캡처/복원 흡수(동작 동일). patchRegion 1차 제외.
   *   - widget(RG-3): stateful 위젯 라이프사이클(기존 destroyCardSortable/initCardSortable 일반화).
   *   - coalesce(RG-4): 모든 라이브 트리거의 단일 종착(보류 시 큐, 해제 시 1회 flush) — §3.5 동시성 3규칙.
   * ===================================================================== */
  const RG = (function () {
    // [RG-1] renderGuard.js 의 shouldDeferRender 와 동형(동일 OR식). 플래그 집합 변경 시 양쪽+테스트 동반 수정.
    function shouldDeferRender(f) {
      return !!(f && (f.composing || f.dragging || f.overlayOpen
                  || f.busyMail || f.busyCommit || f.editing));
    }

    /** 모든 라이브 갱신 트리거의 단일 보류 게이트. true 면 호출측은 render() 를 부르지 않는다.
     *  §3.2 매핑표와 1:1 — 기존에 흩어졌던 보류 조건(특히 busyMailSummary)을 빠짐없이 흡수. */
    function deferred() {
      return shouldDeferRender({
        composing:   store._composing === true,
        dragging:    store._dragging === true,
        overlayOpen: !!(store.showSettings || store.showHelp || store.state.selectedId),
        busyMail:    store.busyMailSummary === true,
        busyCommit:  store.busyCommitActivity === true,
        editing:     store.todoAdding === true,
      });
    }

    // ── RG-1: composition(IME 조합) ──
    const composition = {
      isComposing() { return store._composing === true; },
      /** input 요소에 조합 시작/종료를 바인딩. 종료 시 누적분을 1회 반영(flushIfPending). */
      bind(inputEl) {
        if (!inputEl || typeof inputEl.addEventListener !== 'function') return;
        inputEl.addEventListener('compositionstart', () => { store._composing = true; });
        inputEl.addEventListener('compositionend', () => {
          store._composing = false;
          coalesce.flushIfPending(); // 조합 종료 = 보류 해제 지점 → 누적 갱신 1회 반영
          maybeFlushCommitRefresh(); // [M10-P1] composing 해제 → 보류된 커밋 폴링 따라감
        });
      },
    };

    // ── RG-2: preserve(노드 보존 — 포커스/캐럿/스크롤 캡처·복원) ──
    //   기존 render() 인라인 복원 로직을 동작 동일하게 흡수(로직 변경 없이 위치만). 회귀 0.
    const SCROLL_SEL = ['.settings-pane', '.modal__body', '.drawer', '.orbit__panel', '.dash__main', '.mailbox-tree', '.mailbox-list'];
    const FOCUS_SEL = ['.topbar__search-input', '.orbit__search', '.shelf-input', '.shelf-edit-input', '.shelf-switch'];
    const preserve = {
      /** 재렌더 전 스냅샷(활성 입력의 포커스/캐럿 + 스크롤 위치). */
      capture(rootEl) {
        const snap = { scroll: {}, focus: null };
        SCROLL_SEL.forEach((sel) => { const e = rootEl.querySelector(sel); if (e) snap.scroll[sel] = e.scrollTop; });
        const ae = (typeof document !== 'undefined') ? document.activeElement : null;
        for (const sel of FOCUS_SEL) {
          if (ae && rootEl.contains(ae) && typeof ae.matches === 'function' && ae.matches(sel)) {
            snap.focus = { sel, start: ae.selectionStart, end: ae.selectionEnd, dir: ae.selectionDirection };
            break;
          }
        }
        return snap;
      },
      /** 재렌더 후 동일 셀렉터의 새 노드에 스냅샷 복원. */
      restore(rootEl, snap) {
        if (!snap) return;
        SCROLL_SEL.forEach((sel) => {
          if (snap.scroll[sel] != null) { const e = rootEl.querySelector(sel); if (e) e.scrollTop = snap.scroll[sel]; }
        });
        const f = snap.focus;
        if (f) {
          const e = rootEl.querySelector(f.sel);
          if (e && typeof e.focus === 'function') {
            try {
              e.focus({ preventScroll: true });
              if (f.start != null && typeof e.setSelectionRange === 'function') {
                e.setSelectionRange(f.start, f.end, f.dir || 'none');
              }
            } catch (_) { /* setSelectionRange 미지원 입력은 포커스만 */ }
          }
        }
      },
      /** [M10-P3] 특정 영역만 부분 갱신(전체 replaceChildren 대신). 5단계 계약(설계 §2.2).
       *   @param containerEl 교체 대상 DOM 요소. null/미발견이면 fallback(전체 render).
       *   @param builderFn () => Node|Node[]|null. 새 영역 콘텐츠(차트는 빈 호스트만 — 위젯 소유).
       *   @param opts { widgets?:string[], preserveFocus?:boolean(기본 true), fallback?:()=>void(기본 render),
       *                 bypassDefer?:boolean(기본 false) — 사용자 명시 액션(설정 탭 전환 등)은 deferred 게이트 우회 } */
      patchRegion(containerEl, builderFn, opts) {
        opts = opts || {};
        const fallback = (typeof opts.fallback === 'function') ? opts.fallback : render;
        const widgets = Array.isArray(opts.widgets) ? opts.widgets : [];
        const present = !!containerEl && !(typeof document !== 'undefined' && document.body && !document.body.contains(containerEl));
        // [M11] bypassDefer=true 면 deferred 무시(오버레이 내 사용자 액션=설정 탭 전환은 보류 대상 아님).
        //   기본(false)은 M10 그대로 — 배경 갱신은 deferred 시 coalesce 보류.
        const isDeferred = opts.bypassDefer ? false : deferred();
        const plan = patchRegionPlan(present, isDeferred); // 순수 분기 결정(테스트 동형)
        // ① deferred → 부분 갱신 안 하고 coalesce 적재(M9 계약 정합). containerEl 부재 → 전체 render 폴백.
        if (plan === 'defer') { coalesce.request(); return; }
        if (plan === 'fallback') { try { fallback(); } catch (_) { /* ignore */ } return; }
        try {
          // ② 영역 내 위젯만 destroy(전체 destroyAll 아님).
          for (const id of widgets) widget._destroyById(id);
          // ③ 포커스/스크롤 캡처(opt-in).
          const snap = (opts.preserveFocus !== false) ? preserve.capture(containerEl) : null;
          // ④ 빌더 → 영역 교체.
          const built = builderFn ? builderFn() : null;
          const nodes = (built == null) ? [] : (Array.isArray(built) ? built.filter(Boolean) : [built]);
          containerEl.replaceChildren(...nodes);
          // ⑤ 복원 → 영역 내 위젯 mount(containerEl 을 root 로 — 스코프 한정).
          if (snap) preserve.restore(containerEl, snap);
          for (const id of widgets) widget._mountById(id, containerEl);
        } catch (_) {
          // builderFn 예외 등 → 전체 render 폴백.
          try { fallback(); } catch (__) { /* ignore */ }
        }
      },
    };

    // ── RG-3: widget(stateful 위젯 라이프사이클) ──
    //   render() 1회당 destroyAll → 뷰 빌드 → mountAll. 중복 인스턴스·핸들러 누적 0.
    const _specs = [];            // [{ id, init(root)->instance, destroy(instance) }]
    const _instances = {};        // id -> 살아있는 instance
    const widget = {
      define(spec) {
        if (!spec || typeof spec.id !== 'string') return;
        if (_specs.some((s) => s.id === spec.id)) return; // 중복 정의 무시
        _specs.push(spec);
      },
      /** render() 진입부: 살아있는 모든 인스턴스 destroy(노드 교체 전). */
      destroyAll() {
        for (const s of _specs) {
          const inst = _instances[s.id];
          if (inst != null && typeof s.destroy === 'function') {
            try { s.destroy(inst); } catch (_) { /* ignore */ }
          }
          _instances[s.id] = null;
        }
      },
      /** render() 종료부: 현재 DOM 에 매칭되는 위젯만 init(중복 방지). */
      mountAll(rootEl) {
        for (const s of _specs) {
          if (_instances[s.id] != null) continue;       // 이미 살아있으면 skip(중복 방지)
          if (typeof s.init !== 'function') continue;
          let inst = null;
          try { inst = s.init(rootEl); } catch (_) { inst = null; }
          _instances[s.id] = (inst != null) ? inst : null;
        }
      },
      /** [M10-P3] patchRegion 전용: 특정 id 위젯만 destroy. id 불일치/미생성 시 no-op. */
      _destroyById(id) {
        const s = _specs.find((x) => x.id === id);
        const inst = _instances[id];
        if (s && inst != null && typeof s.destroy === 'function') {
          try { s.destroy(inst); } catch (_) { /* ignore */ }
        }
        _instances[id] = null;
      },
      /** [M10-P3] patchRegion 전용: 특정 id 위젯만 mount. 이미 살아있으면 skip. */
      _mountById(id, rootEl) {
        if (_instances[id] != null) return;
        const s = _specs.find((x) => x.id === id);
        if (!s || typeof s.init !== 'function') return;
        let inst = null;
        try { inst = s.init(rootEl); } catch (_) { inst = null; }
        _instances[id] = (inst != null) ? inst : null;
      },
    };

    // ── RG-4: coalesce(라이브 push 단일 종착) ──
    //   순수 상태기는 renderGuard.js 와 동형(발화 순서·pending 단조성 동치 — test/renderGuard.test.js 가 계약).
    //   isDeferred=deferred, flush=debounce(render,120) 의 즉시 render.
    const _coalescer = (function () {
      let pending = false, timer = null;
      function clearTimer() { if (timer != null) { clearTimeout(timer); timer = null; } }
      function onFire() {
        timer = null;
        if (deferred()) return;       // [R2] 발화 직전 보류 시작 → pending 유지, 발화 취소
        if (!pending) return;
        pending = false; render();    // 정확히 1회
      }
      return {
        request() {
          pending = true;
          if (deferred()) { clearTimer(); return; }
          if (timer == null) timer = setTimeout(onFire, 120); // 이미 예약돼 있으면 재예약 안 함(단일 타이머)
        },
        flushIfPending() {
          if (!pending) return;
          if (deferred()) return;     // [R2] 다른 보류 사유 남음 → 마지막 해제자만 발화
          clearTimer();
          pending = false; render();
        },
        // 보류 해제 지점에서 "즉시 1회 반영 + pending/타이머 소비". 기존 직접 render() 를 대체해
        //   잔류 pending 으로 인한 잉여 render 1회를 막는다(F-1). 항상 1회 render(즉시 데이터 반영 보장).
        release() { clearTimer(); pending = false; render(); },
        // teardown: 잔여 디바운스 타이머 정리(unload 중 잉여 render 방지, D-2). pending 보존.
        cancel() { clearTimer(); },
      };
    })();
    const coalesce = {
      request() { _coalescer.request(); },
      flushIfPending() { _coalescer.flushIfPending(); },
      release() { _coalescer.release(); },
      cancel() { _coalescer.cancel(); },
    };

    return { composition, deferred, preserve, widget, coalesce };
  })();

  // [R-25 RG-3] 기존 카드 정렬(.cards)을 위젯 라이프사이클로 등록(동작 보존: 기존 init/destroy 그대로).
  RG.widget.define({
    id: 'cardSortable',
    init: () => { initCardSortable(); return cardSortable; }, // init 은 cardSortable 모듈 변수에 인스턴스 보관
    destroy: () => { destroyCardSortable(); },
  });
  // [R-32] 홈 섹션 드래그 재정렬 위젯. .home-masonry 부재(홈 뷰 아님) 시 init 은 no-op.
  RG.widget.define({
    id: 'homeSections',
    init: () => { initHomeSortable(); return homeSortable; },
    destroy: () => { destroyHomeSortable(); },
  });
  // [R-33] 커밋 차트 위젯(SVG 자작). .commit-chart-host 부재(홈 뷰 아님/생산성 섹션 미표시) 시 no-op.
  //   render() 1회당 destroy/recreate → 호버 핸들러 누수·중복 0. 5분 폴링(R-31) 갱신 시에도 정상 재생성.
  RG.widget.define({
    id: 'commitChart',
    // [M10-P4/F-2] root 스코프로 .commit-chart-host 탐색 — mountAll 은 app, _mountById 는 containerEl(region) 전달.
    //   차트 노드 생성·삽입·destroy 를 위젯이 단독 소유(builderFn 은 빈 호스트만 → 이중 삽입·핸들러 누수 0).
    init: (root) => {
      if (typeof document === 'undefined') return null;
      const scope = root || document;
      const host = (typeof scope.querySelector === 'function') ? scope.querySelector('.commit-chart-host') : null;
      if (!host) return null;
      // 기존과 동일: store.commitActivity.days 최근 7일. 라벨은 homeWeekday(date) — textContent 로만 사용.
      const ca = store.commitActivity || {};
      const src = Array.isArray(ca.days) ? ca.days.slice(-7) : [];
      const days = src.map((d) => ({ count: (d && d.count), label: (d && d.date) ? homeWeekday(d.date) : '' }));
      const chart = chartBars(days, { ariaLabel: '최근 7일 커밋 빈도' });
      host.appendChild(chart.node);
      return chart; // { node, destroy }
    },
    destroy: (inst) => { if (inst && typeof inst.destroy === 'function') { try { inst.destroy(); } catch (_) { /* ignore */ } } },
  });
  // [SH-2] 셸프 행 위젯 — 가로 드래그/휠 스크롤 배선 + 활성 변경 시 자동 스크롤(_focusPending).
  //   행 요소는 render/patch 마다 새로 만들어지므로(__shelfSwipe 가드) 핸들러 누수 0. 스코프 내 .shelf-row
  //   전부 배선(shelf+shelfWide 동시 표시 대응). 인스턴스 미보유(리스너는 노드와 함께 GC) → init 은 null 반환.
  RG.widget.define({
    id: 'shelf',
    init: (root) => {
      if (typeof document === 'undefined') return null;
      const scope = root || document;
      if (typeof scope.querySelectorAll !== 'function') return null;
      const rows = scope.querySelectorAll('.shelf-row');
      if (!rows.length) return null;
      for (let i = 0; i < rows.length; i++) wireShelfSwipe(rows[i]);
      if (store.shelf._focusPending && store.shelf.active != null) {
        for (let j = 0; j < rows.length; j++) focusShelfActive(rows[j], store.shelf.active);
        store.shelf._focusPending = false;
      }
      return null;
    },
    destroy: () => { /* 리스너는 교체된 노드와 함께 GC — 별도 정리 불필요 */ },
  });

  /** [M10-P4] 커밋 차트 영역만 부분 갱신 — builderFn 은 빈 호스트만(차트는 commitChart 위젯 소유).
   *   영역 부재/오류/deferred 시 patchRegion 내부에서 안전 처리(fallback=render / coalesce 보류). */
  function patchCommitChart() {
    if (typeof document === 'undefined') { render(); return; }
    const region = document.querySelector('.commit-chart-region');
    RG.preserve.patchRegion(region, function () {
      // 빈 호스트 컨테이너만 반환 — 차트 노드는 _mountById('commitChart')가 단독 생성/삽입.
      return el('div', { cls: 'commit-chart-host', attrs: { 'aria-label': '최근 7일 커밋 빈도 차트' } });
    }, {
      widgets: ['commitChart'],   // ②_destroyById → ⑤_mountById 가 차트 노드 단독 소유
      preserveFocus: false,       // 차트 영역엔 포커스 입력 없음 — 캡처/복원 생략
      fallback: function () { render(); },
    });
  }

  /** [M11] 메일 섹션 영역만 부분 갱신 — 60초 폴링/push 시 전체 render 대신 .mail-region 만 교체(깜빡임 0).
   *   위젯 없음(메일 행은 클릭 핸들러뿐, 재생성 무해). 영역 부재/오류/deferred 시 patchRegion 내부 안전 처리. */
  function patchMailSection() {
    if (typeof document === 'undefined') { render(); return; }
    const region = document.querySelector('.mail-region');
    RG.preserve.patchRegion(region, function () {
      return renderHomeMailCard(); // 카드 본문만 재빌드(textContent — L-1)
    }, {
      widgets: [],                 // 메일 영역엔 stateful 위젯 없음
      preserveFocus: false,        // 메일 행엔 텍스트 입력 없음 — 캡처/복원 생략(불필요 reflow 절감)
      fallback: function () { render(); },
    });
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

      // 스냅샷이 없어도 홈으로 바로 진입하고, 최초 스캔 팝업을 홈 위에 띄운다(닫기 가능).
      const empty = isEmptySnapshot(payload);
      if (empty) {
        store.raw = [];
        store.viewModels = [];
        store.showFirstRun = true;       // 홈 위 스캔 팝업 표시
        await refreshConfig();           // 팝업의 루트 목록 표시용
      } else {
        store.raw = payload.projects;
        store.viewModels = payload.projects.map(toViewModel);
        store.showFirstRun = false;
      }
      store._generatedAt = (payload && payload.generatedAt) ? String(payload.generatedAt) : '';
      captureDetectedNames(); // 감지명 캡처(별칭은 loadUiState 후 applyProjectNames)
      store.state.view = 'home'; // 기본 랜딩 = 홈(브리핑). 프로젝트 목록은 '프로젝트' 탭으로.
      // 설정 패널/재스캔에서 쓸 config 를 비동기로 미리 적재(렌더 비블로킹)
      ipc('getConfig').then((cfg) => {
        if (cfg && cfg.ok !== false) {
          store.config = cfg;
          store.roots = configView(cfg).scanRoots;
        }
      });
      // R-19/20/21: UI 상태(favorites/order/sortMode) 적재 후 재렌더(비블로킹)
      loadUiState().then(() => { if (store.state.view === 'home' || store.state.view === 'dashboard') render(); });
      render();
      // 홈 진입 시 메일 다이제스트 1회 자동 로드(비블로킹 — 카드만 로딩 표시).
      maybeLoadMailSummary();
      // 언어 추세 baseline 갱신(스캔 간 ▲▼ 비교). 비블로킹 — 끝나면 홈 재렌더.
      refreshLangTrend();
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

  // [R-28/R-29] 전역 단축키 — 네이티브 메뉴 제거로 사라진 accelerator(Ctrl+O·Ctrl+R)와 신설 F5(새로고침)를
  //   렌더러 keydown 으로 처리(globalShortcut 아님 — 앱 비포커스 시 미발화 안전). 매핑은 순수 matchShortcut.
  document.addEventListener('keydown', (e) => {
    const action = matchShortcut(e);
    if (!action) return;
    // [B-1] 편집 가능 요소(input/textarea/contenteditable) 포커스 중에는 Ctrl+O/Ctrl+R 발화 금지
    //   (텍스트 입력 중 의도치 않은 폴더추가/재스캔 방지). F5(refresh)는 텍스트 충돌 없어 그대로 허용.
    if (action !== 'refresh' && isEditableTarget(e.target)) return;
    e.preventDefault();
    switch (action) {
      case 'pickFolders': onPickFolders(); break;
      case 'rescan':      onRescan(); break;
      case 'refresh':     refreshDashboard(); break;
      default: /* close 등은 전역 ESC 핸들러 소관 */ break;
    }
  });

  // R-21: 트레이 push 구독(앱 1회). 부재 시 graceful — subscribeTray 내부 가드.
  subscribeTray();
  // R-24: 상태 주시 라이브 갱신 구독(앱 1회). 부재 시 graceful — 내부 가드.
  subscribeProjectsUpdated();
  // 메일 실시간 갱신: 새 메일 push 구독 + 홈 주기 갱신(앱 1회).
  subscribeMailUpdated();
  startMailAutoRefresh();
  // [SH-2] 셸프 변경 push 구독(앱 1회) — main 신호 시 list() 재조회. 부재 시 graceful no-op.
  subscribeShelfChanged();
  startTodoDueWatch(); // [백로그2-4] 할 일 마감 도래 토스트·시각 알림 감시(앱 1회).
  // [백로그2-2] 메일 변화 이벤트 구독 — 의존 위젯(히어로 KPI '안 읽은 메일'·브리핑)이 즉시 반응.
  //   스트리밍 중엔 스트림을 끊지 않도록 메일·브리핑 영역만 부분 교체, 그 외엔 전체 재구성으로 KPI까지 동시 반영.
  EV.on('mail:changed', function () {
    if (store.state.view !== 'home') { patchMailSection(); return; }
    var streaming = store.briefing && (store.briefing.status === 'streaming' || store.briefing.status === 'generating');
    if (streaming) { patchMailSection(); patchBriefing(); } else { render(); }
  });
  // [R-31] 커밋 차트 폴링 — 창 가시성 변화 시 폴링 시작/정지 동기화(홈 비가시 시 git 0). 뷰 전환은 render()가 동기화.
  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    document.addEventListener('visibilitychange', () => { try { syncHomePolling(); } catch (_) { /* graceful */ } });
  }
  // 자동 업데이트 진행 구독(앱 1회). 부재 시 graceful — 내부 가드.
  subscribeUpdateStatus();
  // [M12 b3] 권한 상승 경고 구독(앱 1회). 비상승·웹·테스트면 push 가 없어 배너 미표시(graceful).
  subscribeElevationWarning();
  // 테마 즉시 적용(시스템 기본) + 시스템 테마 변경 구독. ui-state 적재 시 사용자 설정으로 갱신.
  applyTheme();
  subscribeSystemTheme();

  // teardown: 창 unload 시 구독 해제(누수 방지 — 진행·트레이·주시·업데이트 구독). [R-28] 메뉴 구독 제거됨.
  function teardown() {
    unsubscribeScan();
    unsubscribeTray();
    unsubscribeProjectsUpdated();
    unsubscribeMailUpdated();
    stopMailAutoRefresh();
    unsubscribeShelfChanged(); // [SH-2] 셸프 변경 push 구독 해제
    stopTodoDueWatch(); // [백로그2-4] 마감 감시 타이머 정리
    stopCommitAutoRefresh(); // [R-31] 커밋 폴링 타이머 정리
    unsubscribeBriefing();   // [M13] 브리핑 push 구독 해제
    unsubscribeUpdateStatus();
    unsubscribeElevationWarning(); // [M12 b3] 상승 경고 구독 해제
    RG.coalesce.cancel(); // [D-2] 잔여 디바운스 타이머 정리(unload 중 잉여 render 방지)
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
    // 홈(브리핑) 순수 뷰모델
    homeGreeting,
    isAttentionVm,
    homeKpis,
    homeAttention,
    homeRecentActivity,
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
    // [R-29] 단축키 단일 출처 + keydown 순수 매핑
    SHORTCUTS,
    matchShortcut,
    isEditableTarget,
    // [R-27] 헤더 뷰별 구성(검색 노출 판정)
    headerViewConfig,
    // [R-30] 설정 2-pane 카테고리 단일 출처 + 활성 탭 정규화
    SETTINGS_CATEGORIES,
    resolveSettingsTab,
    // [R-31] 커밋 차트 폴링 게이트(홈 뷰 + 가시성)
    shouldPollCommit,
    // [R-32] 홈 섹션 화이트리스트 + 순서 정규화(렌더러 동형)
    HOME_SECTION_IDS,
    applyHomeLayout,
    // [위젯 추가/제거] 토글 가능 위젯 목록(메인 동형 교차검증용)
    TOGGLEABLE_WIDGET_IDS,
    // [SH-2] 즐겨찾기 셸프 위젯 순수 뷰모델/헬퍼(헤드리스 테스트)
    shelfSpineW,
    shelfLead,
    shelfDetectType,
    shelfHostOf,
    shelfLastSeg,
    shelfIsValidInput,
    shelfAddErrorMessage,
    shelfComposerVM,
    shelfPanelsVM,
    shelfSafeColor,
    shelfStateFlags,
    shelfAutoRefreshView,
    // [R-33] 커밋 차트 기하 모델(순수 — 수치 sanitize·스케일)
    commitChartModel,
    // [M10] 커밋 데이터 동일성 키(diff 가드) + 툴팁 가로위치 + patchRegion 분기(순수)
    commitActivityKey,
    tipLeft,
    patchRegionPlan,
    // [M11] 메일 요약 동일성 키(diff 가드, 순수)
    mailSummaryKey,
    // [M13] 브리핑 AI 순수 로직(gen 가드·항목 그룹·폴백 힌트·external·설정 뷰)
    briefingAcceptsGen,
    briefingGroupItems,
    briefingFallbackHint,
    isExternalBaseURL,
    briefingSettingsView,
    BRIEFING_CATEGORIES,
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
