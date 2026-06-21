'use strict';
/**
 * dashboard.test.js — S6 프론트엔드 순수 로직 검증 (DOM 비의존)
 * 대상: public/app.js 의 매핑/필터/정렬/검색/통계/상대시간/언어퍼센트/에러매핑/XSS-안전 입력 처리.
 * 요구ID: R-10(매핑/통계) · R-11(필터·정렬·검색).
 * 실 API 매핑 검증: git.dirty boolean / size 미측정 / na 처리 / breakdown 퍼센트 환산.
 */
const { test } = require('node:test');
const assert = require('node:assert');

const {
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
} = require('../public/app.js');

// 계약 shape 기반 목 데이터(실 캐시 shape와 동일)
function mkProject(over = {}) {
  return Object.assign({
    id: 'id-' + Math.random().toString(16).slice(2),
    path: 'C:\\repos\\sample',
    name: 'sample',
    description: 'a sample project',
    signals: ['git'],
    language: { primary: 'Node.js', breakdown: { JavaScript: 0.706, HTML: 0.294 } },
    freshness: { lastModified: '2026-01-01T00:00:00.000Z', lastCommit: null, isStale: false },
    git: { status: 'ok', isRepo: true, branch: 'master', dirty: false, ahead: 0, behind: 0 },
    size: { status: 'skipped', totalBytes: null, nodeModulesBytes: null, deps: null, devDeps: null },
  }, over);
}

/* ─────────────── toViewModel ─────────────── */
test('toViewModel: 정상 매핑', () => {
  const vm = toViewModel(mkProject());
  assert.strictEqual(vm.name, 'sample');
  assert.strictEqual(vm.language, 'Node.js');
  assert.strictEqual(vm.gitStatus, 'clean');
  assert.strictEqual(vm.branch, 'master');
  assert.strictEqual(vm.isStale, false);
  assert.deepStrictEqual(vm.breakdown, { JavaScript: 0.706, HTML: 0.294 });
});

test('toViewModel: git.status==="na" → 브랜치/ahead/behind null, gitStatus na', () => {
  const vm = toViewModel(mkProject({
    git: { status: 'na', isRepo: false, branch: null, dirty: null, ahead: null, behind: null },
  }));
  assert.strictEqual(vm.gitStatus, 'na');
  assert.strictEqual(vm.isRepo, false);
  assert.strictEqual(vm.branch, null);
  assert.strictEqual(vm.ahead, null);
  assert.strictEqual(vm.behind, null);
  assert.strictEqual(vm.dirty, null);
});

test('toViewModel: dirty=true(boolean) → gitStatus dirty (개수 아님)', () => {
  const vm = toViewModel(mkProject({
    git: { status: 'ok', isRepo: true, branch: 'dev', dirty: true, ahead: 2, behind: 1 },
  }));
  assert.strictEqual(vm.gitStatus, 'dirty');
  assert.strictEqual(vm.dirty, true);
  assert.strictEqual(vm.ahead, 2);
  assert.strictEqual(vm.behind, 1);
});

test('toViewModel: size.status=skipped & 전부 null → totalBytes 등 null 보존(미측정 표시 위함)', () => {
  const vm = toViewModel(mkProject());
  assert.strictEqual(vm.sizeStatus, 'skipped');
  assert.strictEqual(vm.totalBytes, null);
  assert.strictEqual(vm.nodeModulesBytes, null);
  assert.strictEqual(vm.deps, null);
  assert.strictEqual(vm.devDeps, null);
});

test('toViewModel: description=null/공백 graceful', () => {
  assert.strictEqual(toViewModel(mkProject({ description: null })).description, null);
  assert.strictEqual(toViewModel(mkProject({ description: '   ' })).description, null);
});

test('toViewModel: language.primary 없으면 "알 수 없음"', () => {
  const vm = toViewModel(mkProject({ language: { primary: null, breakdown: {} } }));
  assert.strictEqual(vm.language, '알 수 없음');
});

test('toViewModel: 최상위 p가 null/원시값이어도 throw 없이 안전 기본값 (P2-5)', () => {
  for (const bad of [null, undefined, 42, 'string', true]) {
    const vm = toViewModel(bad);
    assert.strictEqual(vm.id, '');
    assert.strictEqual(vm.name, '(이름 없음)');
    assert.strictEqual(vm.path, '(이름 없음)');
    assert.strictEqual(vm.description, null);
    assert.strictEqual(vm.language, '알 수 없음');
    assert.strictEqual(vm.isStale, false);
    assert.strictEqual(vm.gitStatus, 'clean');
    assert.strictEqual(vm.totalBytes, null);
  }
});

test('toViewModel: 비정상 항목이 섞인 배열도 map으로 전체 깨지지 않음 (P2-5)', () => {
  const arr = [mkProject({ name: 'ok' }), null, undefined, mkProject({ name: 'ok2' })];
  const vms = arr.map(toViewModel);
  assert.strictEqual(vms.length, 4);
  assert.strictEqual(vms[0].name, 'ok');
  assert.strictEqual(vms[1].name, '(이름 없음)');
  assert.strictEqual(vms[3].name, 'ok2');
});

/* ─────────────── describeError (Electron: IPC 반환 객체 1-arg, 구 (status,data) 호환) ─────────────── */
test('describeError: 계약 에러 code → 사용자 친화 한국어 매핑 (BUG-2)', () => {
  // IPC 반환 객체 1-arg
  assert.match(describeError({ ok: false, code: 'CODE_CLI_NOT_FOUND' }), /VS Code CLI/);
  assert.match(describeError({ ok: false, code: 'OPEN_FAILED' }), /실행에 실패/);
  assert.match(describeError({ ok: false, code: 'PATH_GONE' }), /더 이상 존재하지 않/);
  assert.match(describeError({ ok: false, code: 'ID_NOT_FOUND' }), /찾을 수 없/);
  assert.match(describeError({ ok: false, code: 'PATH_NOT_ALLOWED' }), /허용되지 않은 경로/);
  assert.match(describeError({ ok: false, code: 'NOT_FOUND' }), /찾을 수 없/);
  // Electron 신규 code
  assert.match(describeError({ ok: false, code: 'NO_SCAN_ROOTS' }), /폴더/);
  assert.match(describeError({ ok: false, code: 'INVALID_PATH' }), /경로 형식/);
  assert.match(describeError({ ok: false, code: 'INTERNAL' }), /내부 오류/);
});

test('describeError: 구 (status, data) 시그니처도 객체 인자를 찾아 매핑(호환)', () => {
  assert.match(describeError(200, { ok: false, code: 'CODE_CLI_NOT_FOUND' }), /VS Code CLI/);
  // "HTTP 200" 같은 무의미 메시지 없음
  assert.doesNotMatch(describeError(200, { ok: false, code: 'CODE_CLI_NOT_FOUND' }), /HTTP 200/);
});

test('describeError: 미매핑 code는 code 포함 폴백, code 없으면 일반 메시지', () => {
  assert.match(describeError({ ok: false, code: 'SOME_NEW_CODE' }), /SOME_NEW_CODE/);
  assert.match(describeError({}), /처리하지 못했/);
  assert.match(describeError(null), /처리하지 못했/);
});

/* ─────────────── XSS 안전(L-1) ─────────────── */
test('XSS-안전: 악성 name/description/branch가 가공 없이 문자열로 보존(렌더 시 textContent 이스케이프)', () => {
  const evil = '<img src=x onerror=alert(1)>';
  const vm = toViewModel(mkProject({
    name: evil,
    description: '"><script>alert(2)</script>',
    git: { status: 'ok', isRepo: true, branch: evil, dirty: false, ahead: 0, behind: 0 },
  }));
  assert.strictEqual(vm.name, evil);
  assert.ok(vm.description.includes('<script>'));
  assert.strictEqual(vm.branch, evil);
  // app.js의 el()/badge()/dot()는 textContent만 사용 → innerHTML 데이터 결합 없음(정적 보증).
});

/* ─────────────── 검색/필터 ─────────────── */
test('matchesSearch: 이름·경로 부분일치(대소문자 무시)', () => {
  const vm = toViewModel(mkProject({ name: 'MyApp', path: 'D:\\work\\proj' }));
  assert.strictEqual(matchesSearch(vm, 'myapp'), true);
  assert.strictEqual(matchesSearch(vm, 'WORK'), true);
  assert.strictEqual(matchesSearch(vm, 'nope'), false);
  assert.strictEqual(matchesSearch(vm, ''), true);
});

test('gitKeys: na→norepo / clean / dirty / ahead 복합', () => {
  assert.deepStrictEqual(gitKeys(toViewModel(mkProject({ git: { status: 'na', branch: null, dirty: null, ahead: null, behind: null } }))), ['norepo']);
  assert.deepStrictEqual(gitKeys(toViewModel(mkProject())), ['clean']);
  const dirtyAhead = toViewModel(mkProject({ git: { status: 'ok', isRepo: true, branch: 'm', dirty: true, ahead: 3, behind: 0 } }));
  assert.deepStrictEqual(gitKeys(dirtyAhead).sort(), ['ahead', 'dirty']);
  const aheadClean = toViewModel(mkProject({ git: { status: 'ok', isRepo: true, branch: 'm', dirty: false, ahead: 2, behind: 0 } }));
  assert.deepStrictEqual(gitKeys(aheadClean), ['ahead']);
});

test('matchesFilters: 다중선택 언어 OR, 빈 배열 통과', () => {
  const vm = toViewModel(mkProject({ language: { primary: 'Python' } }));
  assert.strictEqual(matchesFilters(vm, { languages: ['Python', 'Go'] }), true);
  assert.strictEqual(matchesFilters(vm, { languages: ['Node.js'] }), false);
  assert.strictEqual(matchesFilters(vm, { languages: [] }), true);
  assert.strictEqual(matchesFilters(vm, {}), true);
});

test('matchesFilters: 신선도 active/stale', () => {
  const stale = toViewModel(mkProject({ freshness: { lastModified: null, lastCommit: null, isStale: true } }));
  const active = toViewModel(mkProject());
  assert.strictEqual(matchesFilters(stale, { freshness: ['stale'] }), true);
  assert.strictEqual(matchesFilters(stale, { freshness: ['active'] }), false);
  assert.strictEqual(matchesFilters(active, { freshness: ['active'] }), true);
});

test('matchesFilters: git OR + 카테고리 간 AND', () => {
  const dirty = toViewModel(mkProject({ git: { status: 'ok', isRepo: true, branch: 'm', dirty: true, ahead: 0, behind: 0 }, language: { primary: 'Python' } }));
  assert.strictEqual(matchesFilters(dirty, { git: ['dirty'] }), true);
  assert.strictEqual(matchesFilters(dirty, { git: ['clean'] }), false);
  // 언어 AND git
  assert.strictEqual(matchesFilters(dirty, { languages: ['Python'], git: ['dirty'] }), true);
  assert.strictEqual(matchesFilters(dirty, { languages: ['Go'], git: ['dirty'] }), false);
});

/* ─────────────── 정렬 ─────────────── */
test('sortViewModels: 이름순', () => {
  const list = ['banana', 'apple', 'cherry'].map((n) => toViewModel(mkProject({ name: n })));
  assert.deepStrictEqual(sortViewModels(list, 'name').map((v) => v.name), ['apple', 'banana', 'cherry']);
});

test('sortViewModels: modified=최근수정순(내림차순), null 말단', () => {
  const list = [
    toViewModel(mkProject({ name: 'a', freshness: { lastModified: '2026-01-01T00:00:00Z', isStale: false } })),
    toViewModel(mkProject({ name: 'b', freshness: { lastModified: '2026-06-01T00:00:00Z', isStale: false } })),
    toViewModel(mkProject({ name: 'c', freshness: { lastModified: null, isStale: false } })),
  ];
  assert.deepStrictEqual(sortViewModels(list, 'modified').map((v) => v.name), ['b', 'a', 'c']);
});

test('sortViewModels: size 정렬은 데이터 없으면 최근수정 폴백', () => {
  const list = [
    toViewModel(mkProject({ name: 'a', freshness: { lastModified: '2026-01-01T00:00:00Z', isStale: false } })),
    toViewModel(mkProject({ name: 'b', freshness: { lastModified: '2026-06-01T00:00:00Z', isStale: false } })),
  ];
  // totalBytes 전부 null → modified-desc 폴백
  assert.deepStrictEqual(sortViewModels(list, 'size').map((v) => v.name), ['b', 'a']);
});

test('canSortBySize: 모두 null이면 false', () => {
  const list = [toViewModel(mkProject()), toViewModel(mkProject())];
  assert.strictEqual(canSortBySize(list), false);
  list[0].totalBytes = 1234;
  assert.strictEqual(canSortBySize(list), true);
});

test('applyQuery: 다중필터+검색+정렬 결합', () => {
  const vms = [
    toViewModel(mkProject({ name: 'web-node', language: { primary: 'Node.js' } })),
    toViewModel(mkProject({ name: 'py-tool', language: { primary: 'Python' } })),
    toViewModel(mkProject({ name: 'web-py', language: { primary: 'Python' } })),
  ];
  const out = applyQuery(vms, { search: 'web', sort: 'name', filters: { languages: ['Python'], freshness: [], git: [] } });
  assert.deepStrictEqual(out.map((v) => v.name), ['web-py']);
});

test('applyQuery: 원본 배열 불변', () => {
  const vms = [toViewModel(mkProject({ name: 'z' })), toViewModel(mkProject({ name: 'a' }))];
  const before = vms.map((v) => v.name);
  applyQuery(vms, { sort: 'name', filters: {} });
  assert.deepStrictEqual(vms.map((v) => v.name), before);
});

/* ─────────────── 통계/패싯 ─────────────── */
test('deriveStats: totalBytes/node_modules는 항상 "미측정", active=total-stale', () => {
  const vms = [
    toViewModel(mkProject({ freshness: { isStale: true } })),
    toViewModel(mkProject({ freshness: { isStale: false } })),
  ];
  const s = deriveStats({ total: 5, byLanguage: { 'Node.js': 3, Python: 2 }, staleCount: 1, totalBytes: null }, vms);
  assert.strictEqual(s.total, 5);
  assert.strictEqual(s.staleCount, 1);
  assert.strictEqual(s.activeCount, 4);
  assert.strictEqual(s.languageCount, 2);
  assert.strictEqual(s.totalBytes, '미측정');
  assert.strictEqual(s.nodeModulesBytes, '미측정');
});

test('deriveStats: stats 누락 시 뷰모델 기반 폴백', () => {
  const vms = [toViewModel(mkProject({ freshness: { isStale: true } })), toViewModel(mkProject())];
  const s = deriveStats(null, vms);
  assert.strictEqual(s.total, 2);
  assert.strictEqual(s.staleCount, 1);
});

test('languageFacets: 개수 내림차순', () => {
  const vms = [
    toViewModel(mkProject({ language: { primary: 'Python' } })),
    toViewModel(mkProject({ language: { primary: 'Node.js' } })),
    toViewModel(mkProject({ language: { primary: 'Python' } })),
  ];
  assert.deepStrictEqual(languageFacets(vms), [{ lang: 'Python', count: 2 }, { lang: 'Node.js', count: 1 }]);
});

test('gitFacetCounts / gitChangeCounts: dirty·ahead·clean·norepo 집계', () => {
  const vms = [
    toViewModel(mkProject({ git: { status: 'ok', isRepo: true, branch: 'm', dirty: true, ahead: 0, behind: 0 } })),
    toViewModel(mkProject({ git: { status: 'ok', isRepo: true, branch: 'm', dirty: false, ahead: 2, behind: 0 } })),
    toViewModel(mkProject({ git: { status: 'ok', isRepo: true, branch: 'm', dirty: false, ahead: 0, behind: 0 } })),
    toViewModel(mkProject({ git: { status: 'na', branch: null, dirty: null, ahead: null, behind: null } })),
  ];
  const fc = gitFacetCounts(vms);
  assert.strictEqual(fc.dirty, 1);
  assert.strictEqual(fc.ahead, 1);
  assert.strictEqual(fc.clean, 1);
  assert.strictEqual(fc.norepo, 1);
  const cc = gitChangeCounts(vms);
  assert.strictEqual(cc.dirty, 1);
  assert.strictEqual(cc.ahead, 1);
});

test('isEmptySnapshot: hasSnapshot=false / 빈 배열 / 누락 (P2-5)', () => {
  assert.strictEqual(isEmptySnapshot({ hasSnapshot: false, projects: [] }), true);
  assert.strictEqual(isEmptySnapshot({ hasSnapshot: true, projects: [] }), true);
  assert.strictEqual(isEmptySnapshot({ hasSnapshot: true }), true);
  assert.strictEqual(isEmptySnapshot(null), true);
  assert.strictEqual(isEmptySnapshot({ hasSnapshot: true, projects: [mkProject()] }), false);
});

/* ─────────────── 언어 퍼센트 환산(breakdown 0~1 → %) ─────────────── */
test('langPercents: breakdown(0~1) → 퍼센트 내림차순', () => {
  const vm = toViewModel(mkProject({ language: { primary: 'Node.js', breakdown: { JavaScript: 0.706, HTML: 0.294 } } }));
  assert.deepStrictEqual(langPercents(vm), [{ name: 'JavaScript', pct: 71 }, { name: 'HTML', pct: 29 }]);
});

test('langPercents: 빈 breakdown이면 primary 100%', () => {
  const vm = toViewModel(mkProject({ language: { primary: 'Rust', breakdown: {} } }));
  assert.deepStrictEqual(langPercents(vm), [{ name: 'Rust', pct: 100 }]);
});

test('langColor: 알려진 언어 색, 미지정은 중립색', () => {
  assert.strictEqual(langColor('Python'), '#3572A5');
  assert.strictEqual(langColor('완전새언어'), '#a8a29e');
});

/* ─────────────── 상대시간 / 날짜 / 용량 ─────────────── */
test('relTime: 오늘/어제/N일/N주/N개월/N년, null→N/A', () => {
  const now = new Date('2026-06-21T12:00:00Z');
  assert.strictEqual(relTime('2026-06-21T01:00:00Z', now), '오늘');
  assert.strictEqual(relTime('2026-06-20T01:00:00Z', now), '어제');
  assert.strictEqual(relTime('2026-06-18T01:00:00Z', now), '3일 전');
  assert.strictEqual(relTime('2026-06-07T01:00:00Z', now), '2주 전');
  assert.strictEqual(relTime('2026-04-21T01:00:00Z', now), '2개월 전');
  assert.strictEqual(relTime('2024-06-21T01:00:00Z', now), '2년 전');
  assert.strictEqual(relTime(null, now), 'N/A');
});

test('fmtDate: ISO→YYYY-MM-DD, null→—', () => {
  assert.strictEqual(fmtDate('2026-02-26T14:05:36.173Z').length, 10);
  assert.strictEqual(fmtDate(null), '—');
  assert.match(fmtDate('2026-02-26T00:00:00Z'), /^2026-02-26$/);
});

test('sizeLabel: 미측정(null)·바이트·MB·GB', () => {
  assert.strictEqual(sizeLabel(null), '미측정');
  assert.strictEqual(sizeLabel(undefined), '미측정');
  assert.strictEqual(sizeLabel(512), '512 B');
  assert.strictEqual(sizeLabel(5 * 1024 * 1024), '5 MB');
  assert.strictEqual(sizeLabel(2 * 1024 * 1024 * 1024), '2.0 GB');
});
