'use strict';
/**
 * dashboard-m4.test.js — M4 프론트 순수 로직 검증 (DOM 비의존)
 * 대상: public/app.js 의 M4 추가 함수
 *   - nextPollAction (scan-status 폴링 상태머신, scanId 대조 M4-L-1)
 *   - progressView / progressTitle (진행 포맷)
 *   - sizeStatusLabel / sumTotalBytes / sumNodeModulesBytes (size 실값/partial 포맷)
 *   - canSortBySize (용량 정렬 활성 판정)
 *   - classifyRescan (rescan 응답 분류)
 *   - fmtCount / fmtElapsed
 *   - XSS: currentPath/note 등 문자열 필드가 progressView 를 통해 가공만 되고
 *          렌더는 textContent(앱)에서 — 여기선 문자열 보존(이스케이프 안함=textContent 전제) 검증
 * 계약: docs/api-contract.md M4 + docs/architecture/m4-design.html §3/§4/§7
 */
const { test } = require('node:test');
const assert = require('node:assert');

const {
  nextScanAction,
  progressView,
  progressTitle,
  sizeStatusLabel,
  sumTotalBytes,
  sumNodeModulesBytes,
  canSortBySize,
  classifyRescan,
  fmtCount,
  fmtElapsed,
  deriveStats,
  toViewModel,
} = require('../public/app.js');

/* ─────────────── nextScanAction (push 진행 상태머신, 폴링 대체) ─────────────── */
test('nextScanAction: scanning → render (계속 구독)', () => {
  const r = nextScanAction({ ownScanId: 'abc' }, { phase: 'scanning', scanId: 'abc', dirs: 10, found: 2 });
  assert.strictEqual(r.action, 'render');
});

test('nextScanAction: finalizing → render', () => {
  const r = nextScanAction({ ownScanId: 'abc' }, { phase: 'finalizing', scanId: 'abc' });
  assert.strictEqual(r.action, 'render');
});

test('nextScanAction: done → refetch', () => {
  const r = nextScanAction({ ownScanId: 'abc' }, { phase: 'done', scanId: 'abc', counts: { projects: 3 } });
  assert.strictEqual(r.action, 'refetch');
});

test('nextScanAction: error → error', () => {
  const r = nextScanAction({ ownScanId: 'abc' }, { phase: 'error', scanId: 'abc' });
  assert.strictEqual(r.action, 'error');
});

test('nextScanAction: idle → render (push 모델 — 진행 패널 유지)', () => {
  const r = nextScanAction({ ownScanId: 'abc' }, { phase: 'idle', scanId: null });
  assert.strictEqual(r.action, 'render');
});

test('nextScanAction: scanId 불일치 → foreign (다른 스캔 무시, M4-L-1)', () => {
  const r = nextScanAction({ ownScanId: 'abc' }, { phase: 'scanning', scanId: 'xyz' });
  assert.strictEqual(r.action, 'foreign');
});

test('nextScanAction: ownScanId 없으면 대조 생략(이미 진행 중 따라붙기)', () => {
  const r = nextScanAction({ ownScanId: null }, { phase: 'scanning', scanId: 'xyz' });
  assert.strictEqual(r.action, 'render');
});

test('nextScanAction: payload null → render (graceful, 타이머/idle 가드 불필요)', () => {
  const r = nextScanAction({ ownScanId: 'abc' }, null);
  assert.strictEqual(r.action, 'render');
});

test('nextScanAction: 전이 시퀀스 scanning→finalizing→done', () => {
  const ctx = { ownScanId: 's1' };
  assert.strictEqual(nextScanAction(ctx, { phase: 'scanning', scanId: 's1' }).action, 'render');
  assert.strictEqual(nextScanAction(ctx, { phase: 'finalizing', scanId: 's1' }).action, 'render');
  assert.strictEqual(nextScanAction(ctx, { phase: 'done', scanId: 's1' }).action, 'refetch');
});

test('nextScanAction: scanId 불일치는 phase 무관하게 foreign 우선', () => {
  assert.strictEqual(nextScanAction({ ownScanId: 's1' }, { phase: 'done', scanId: 'other' }).action, 'foreign');
  assert.strictEqual(nextScanAction({ ownScanId: 's1' }, { phase: 'error', scanId: 'other' }).action, 'foreign');
});

/* ─────────────── progressView (진행 포맷) ─────────────── */
test('progressView: scanning → indeterminate(pct null), running true', () => {
  const pv = progressView({ phase: 'scanning', dirs: 1240, found: 38, elapsedMs: 12000, currentPath: 'lib/server' });
  assert.strictEqual(pv.running, true);
  assert.strictEqual(pv.pct, null);
  assert.strictEqual(pv.dirs, 1240);
  assert.strictEqual(pv.found, 38);
  assert.strictEqual(pv.elapsedSec, 12);
  assert.strictEqual(pv.currentPath, 'lib/server');
});

test('progressView: done → pct 100, done true', () => {
  const pv = progressView({ phase: 'done', dirs: 1240, found: 38, elapsedMs: 30000, counts: { projects: 38 } });
  assert.strictEqual(pv.done, true);
  assert.strictEqual(pv.pct, 100);
  assert.deepStrictEqual(pv.counts, { projects: 38 });
});

test('progressView: finalizing → pct 100', () => {
  const pv = progressView({ phase: 'finalizing' });
  assert.strictEqual(pv.finalizing, true);
  assert.strictEqual(pv.pct, 100);
});

test('progressView: 결측 graceful (빈 객체)', () => {
  const pv = progressView({});
  assert.strictEqual(pv.dirs, 0);
  assert.strictEqual(pv.found, 0);
  assert.strictEqual(pv.elapsedSec, 0);
  assert.strictEqual(pv.currentPath, null);
  assert.strictEqual(pv.note, null);
});

test('progressView: null 입력 graceful', () => {
  const pv = progressView(null);
  assert.strictEqual(pv.phase, 'idle');
});

test('progressTitle: phase별 한국어 제목', () => {
  assert.strictEqual(progressTitle('scanning'), '프로젝트 스캔 중…');
  assert.strictEqual(progressTitle('finalizing'), '마무리 중…');
  assert.strictEqual(progressTitle('done'), '스캔 완료');
  assert.strictEqual(progressTitle('error'), '스캔 실패');
  assert.strictEqual(progressTitle('idle'), '스캔 준비 중…');
});

/* ─────────────── XSS / textContent 안전 (currentPath·note 보존) ─────────────── */
test('progressView: currentPath 악성 문자열 그대로 보존(이스케이프 안함=textContent 렌더 전제, L-1)', () => {
  const evil = '<img src=x onerror=alert(1)>';
  const pv = progressView({ phase: 'scanning', currentPath: evil, note: evil });
  // 순수 함수는 문자열을 변형/이스케이프하지 않는다. 렌더 단계(app el text)가 textContent 로 안전화.
  assert.strictEqual(pv.currentPath, evil);
  assert.strictEqual(pv.note, evil);
});

test('progressView: currentPath 비문자열 → null (방어)', () => {
  const pv = progressView({ phase: 'scanning', currentPath: { malicious: true }, note: 123 });
  assert.strictEqual(pv.currentPath, null);
  assert.strictEqual(pv.note, null);
});

/* ─────────────── sizeStatusLabel (size 실값/partial) ─────────────── */
test('sizeStatusLabel: ok → 실값', () => {
  assert.strictEqual(sizeStatusLabel('ok', 1288490188), '1.2 GB');
});

test('sizeStatusLabel: partial → "≈ ... (부분)"', () => {
  assert.strictEqual(sizeStatusLabel('partial', 1288490188), '≈ 1.2 GB (부분)');
});

test('sizeStatusLabel: partial + 값 없음 → "부분 측정"', () => {
  assert.strictEqual(sizeStatusLabel('partial', null), '부분 측정');
});

test('sizeStatusLabel: error → "측정 실패"', () => {
  assert.strictEqual(sizeStatusLabel('error', null), '측정 실패');
});

test('sizeStatusLabel: skipped/null → "미측정"', () => {
  assert.strictEqual(sizeStatusLabel('skipped', null), '미측정');
  assert.strictEqual(sizeStatusLabel('ok', null), '미측정'); // ok 인데 값 없으면 미측정
});

/* ─────────────── sum 합계 ─────────────── */
test('sumTotalBytes: 측정 항목만 합산, 모두 미측정이면 null', () => {
  assert.strictEqual(sumTotalBytes([{ totalBytes: 100 }, { totalBytes: 200 }, { totalBytes: null }]), 300);
  assert.strictEqual(sumTotalBytes([{ totalBytes: null }, { totalBytes: null }]), null);
  assert.strictEqual(sumTotalBytes([]), null);
});

test('sumNodeModulesBytes: 측정 항목만 합산', () => {
  assert.strictEqual(sumNodeModulesBytes([{ nodeModulesBytes: 50 }, { nodeModulesBytes: 70 }]), 120);
  assert.strictEqual(sumNodeModulesBytes([{ nodeModulesBytes: null }]), null);
});

/* ─────────────── canSortBySize (정렬 활성 판정) ─────────────── */
test('canSortBySize: 측정 데이터 있으면 true', () => {
  assert.strictEqual(canSortBySize([{ totalBytes: 100 }, { totalBytes: null }]), true);
});
test('canSortBySize: 전부 미측정이면 false', () => {
  assert.strictEqual(canSortBySize([{ totalBytes: null }, { totalBytes: null }]), false);
  assert.strictEqual(canSortBySize([]), false);
});

/* ─────────────── deriveStats: totalBytes 실값 승격 ─────────────── */
test('deriveStats: stats.totalBytes number 면 실값 표시', () => {
  const s = deriveStats({ total: 3, staleCount: 1, byLanguage: { JS: 3 }, totalBytes: 1288490188 }, []);
  assert.strictEqual(s.totalBytes, '1.2 GB');
  assert.strictEqual(s.totalBytesMeasured, true);
});

test('deriveStats: stats.totalBytes null 이고 vm 합 있으면 폴백 실값', () => {
  const vms = [{ totalBytes: 1073741824, nodeModulesBytes: 536870912, isStale: false }];
  const s = deriveStats({ total: 1, staleCount: 0, byLanguage: {}, totalBytes: null }, vms);
  assert.strictEqual(s.totalBytesMeasured, true);
  assert.strictEqual(s.totalBytes, '1.0 GB');
  assert.strictEqual(s.nodeModulesBytes, '512 MB');
});

test('deriveStats: 미측정이면 "미측정" + measured false (MVP graceful)', () => {
  const vms = [{ totalBytes: null, nodeModulesBytes: null, isStale: false }];
  const s = deriveStats({ total: 1, staleCount: 0, byLanguage: {}, totalBytes: null }, vms);
  assert.strictEqual(s.totalBytes, '미측정');
  assert.strictEqual(s.totalBytesMeasured, false);
});

/* ─────────────── toViewModel: size 실값 매핑(전진 호환) ─────────────── */
test('toViewModel: size.status ok 실값 매핑', () => {
  const vm = toViewModel({
    id: 'x', name: 'p', path: 'C:/p',
    size: { status: 'ok', totalBytes: 1000, nodeModulesBytes: 400, deps: 12, devDeps: 30 },
  });
  assert.strictEqual(vm.sizeStatus, 'ok');
  assert.strictEqual(vm.totalBytes, 1000);
  assert.strictEqual(vm.nodeModulesBytes, 400);
  assert.strictEqual(vm.deps, 12);
  assert.strictEqual(vm.devDeps, 30);
});

test('toViewModel: size.status partial 매핑', () => {
  const vm = toViewModel({ id: 'x', name: 'p', path: 'C:/p', size: { status: 'partial', totalBytes: 999 } });
  assert.strictEqual(vm.sizeStatus, 'partial');
  assert.strictEqual(vm.totalBytes, 999);
});

/* ─────────────── classifyRescan (IPC 반환 1-arg — HTTP status 제거) ─────────────── */
test('classifyRescan: SCAN_STARTED → start + scanId', () => {
  const r = classifyRescan({ ok: true, code: 'SCAN_STARTED', scanId: 'a1b2', startedAt: 'x' });
  assert.strictEqual(r.action, 'start');
  assert.strictEqual(r.scanId, 'a1b2');
});

test('classifyRescan: SCAN_IN_PROGRESS → in-progress + scanId', () => {
  const r = classifyRescan({ ok: false, code: 'SCAN_IN_PROGRESS', scanId: 'cur' });
  assert.strictEqual(r.action, 'in-progress');
  assert.strictEqual(r.scanId, 'cur');
});

test('classifyRescan: NO_SCAN_ROOTS → no-roots', () => {
  const r = classifyRescan({ ok: false, code: 'NO_SCAN_ROOTS', message: '...' });
  assert.strictEqual(r.action, 'no-roots');
});

test('classifyRescan: INTERNAL/기타 → error', () => {
  assert.strictEqual(classifyRescan({ ok: false, code: 'INTERNAL' }).action, 'error');
  assert.strictEqual(classifyRescan({}).action, 'error');
  assert.strictEqual(classifyRescan(null).action, 'error');
});

/* ─────────────── fmtCount / fmtElapsed ─────────────── */
test('fmtCount: 천단위 콤마', () => {
  assert.strictEqual(fmtCount(1240), '1,240');
  assert.strictEqual(fmtCount(0), '0');
  assert.strictEqual(fmtCount(undefined), '0');
});

test('fmtElapsed: 초/분 포맷', () => {
  assert.strictEqual(fmtElapsed(12), '12s');
  assert.strictEqual(fmtElapsed(63), '1m 03s');
  assert.strictEqual(fmtElapsed(0), '0s');
  assert.strictEqual(fmtElapsed(-5), '0s');
});
