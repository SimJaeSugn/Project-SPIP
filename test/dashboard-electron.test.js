'use strict';
/**
 * dashboard-electron.test.js — Electron renderer 적응 순수 로직 검증 (DOM 비의존)
 * 대상: public/app.js 의 Electron 전환 추가 함수
 *   - nextScanAction       (폴링 폐기 → push 진행 상태머신; scanId 대조 M4-L-1)
 *   - sanitizeRescanOpts   (재스캔 옵션 매핑 + allowAllDrives 게이트 강등)
 *   - configView           (getConfig 응답 → 옵션 UI 뷰모델, size shape §4.1)
 *   - parseRootInput       (경로 직접 입력 텍스트 → addRoots 배열)
 *   - summarizeAddResult   (addRoots/pickFolders 결과 요약 + rejected 표시)
 *   - describeRejectReason (거부 사유 고정 토큰 → 한국어)
 *   - XSS: currentPath/path 등 서버/입력 유래 문자열을 순수 함수가 변형하지 않고
 *          그대로 보존(렌더 단계 textContent 가 안전화 — L-1 전제) 검증
 * 계약: docs/architecture/electron-migration.html §4(IPC 계약)·§5(폴더)·§6(보안)
 */
const { test } = require('node:test');
const assert = require('node:assert');

const {
  nextScanAction,
  sanitizeRescanOpts,
  configView,
  parseRootInput,
  summarizeAddResult,
  describeRejectReason,
  progressView,
} = require('../public/app.js');

/* ─────────────── sanitizeRescanOpts (옵션 매핑 + 게이트) ─────────────── */
test('sanitizeRescanOpts: withSize Boolean 강제', () => {
  assert.strictEqual(sanitizeRescanOpts({ withSize: 1 }, null).withSize, true);
  assert.strictEqual(sanitizeRescanOpts({ withSize: 0 }, null).withSize, false);
  assert.strictEqual(sanitizeRescanOpts({}, null).withSize, false);
});

test('sanitizeRescanOpts: allDrives 는 allowAllDrives 게이트 false 면 강등', () => {
  // 게이트 꺼짐 → 사용자가 켰어도 false
  assert.strictEqual(sanitizeRescanOpts({ allDrives: true }, { allowAllDrives: false }).allDrives, false);
  assert.strictEqual(sanitizeRescanOpts({ allDrives: true }, null).allDrives, false);
  // 게이트 켜짐 → 사용자 선택 반영
  assert.strictEqual(sanitizeRescanOpts({ allDrives: true }, { allowAllDrives: true }).allDrives, true);
  assert.strictEqual(sanitizeRescanOpts({ allDrives: false }, { allowAllDrives: true }).allDrives, false);
});

test('sanitizeRescanOpts: 비객체 입력 graceful', () => {
  assert.deepStrictEqual(sanitizeRescanOpts(null, null), { withSize: false, allDrives: false });
  assert.deepStrictEqual(sanitizeRescanOpts('x', { allowAllDrives: true }), { withSize: false, allDrives: false });
});

/* ─────────────── configView (옵션 UI 뷰모델, size shape) ─────────────── */
test('configView: 계약 shape 매핑(size:{enabled,maxBytes,maxEntries})', () => {
  const cv = configView({
    scanRoots: ['E:\\a', 'E:\\b'],
    staleDays: 60,
    allowAllDrives: true,
    size: { enabled: true, maxBytes: 1000, maxEntries: 5000 },
  });
  assert.deepStrictEqual(cv.scanRoots, ['E:\\a', 'E:\\b']);
  assert.strictEqual(cv.rootCount, 2);
  assert.strictEqual(cv.staleDays, 60);
  assert.strictEqual(cv.allowAllDrives, true);
  assert.strictEqual(cv.sizeEnabled, true);
  assert.strictEqual(cv.sizeMaxBytes, 1000);
  assert.strictEqual(cv.sizeMaxEntries, 5000);
});

test('configView: 결측/null graceful (기본값)', () => {
  const cv = configView(null);
  assert.deepStrictEqual(cv.scanRoots, []);
  assert.strictEqual(cv.rootCount, 0);
  assert.strictEqual(cv.staleDays, 90);
  assert.strictEqual(cv.allowAllDrives, false);
  assert.strictEqual(cv.sizeEnabled, false);
  assert.strictEqual(cv.sizeMaxBytes, null);
});

test('configView: scanRoots 비배열/오염 항목 방어', () => {
  const cv = configView({ scanRoots: ['ok', 123, null, ''], size: {} });
  assert.deepStrictEqual(cv.scanRoots, ['ok']);
});

/* ─────────────── parseRootInput (직접 입력 파싱) ─────────────── */
test('parseRootInput: 단일 경로 → 배열 1개', () => {
  assert.deepStrictEqual(parseRootInput('E:\\projects'), ['E:\\projects']);
});

test('parseRootInput: 여러 줄 → trim + 빈줄 제거', () => {
  assert.deepStrictEqual(parseRootInput('E:\\a\n  E:\\b  \n\n\nC:\\c'), ['E:\\a', 'E:\\b', 'C:\\c']);
});

test('parseRootInput: 빈 문자열/비문자열 → 빈 배열', () => {
  assert.deepStrictEqual(parseRootInput(''), []);
  assert.deepStrictEqual(parseRootInput('   \n  '), []);
  assert.deepStrictEqual(parseRootInput(null), []);
});

/* ─────────────── summarizeAddResult (채택/거부 요약) ─────────────── */
test('summarizeAddResult: 추가 성공 → kind added + roots 반영', () => {
  const s = summarizeAddResult({ ok: true, added: ['E:\\a'], rejected: [], roots: ['E:\\a'] });
  assert.strictEqual(s.ok, true);
  assert.strictEqual(s.kind, 'added');
  assert.strictEqual(s.addedCount, 1);
  assert.deepStrictEqual(s.roots, ['E:\\a']);
  assert.match(s.message, /1개 폴더를 추가/);
});

test('summarizeAddResult: 일부 거부 → rejected 라벨 포함', () => {
  const s = summarizeAddResult({
    ok: true, added: ['E:\\a'],
    rejected: [{ path: 'C:\\Windows', reason: 'SYSTEM_DIR' }, { path: 'E:\\a', reason: 'DUP' }],
    roots: ['E:\\a'],
  });
  assert.strictEqual(s.addedCount, 1);
  assert.strictEqual(s.rejected.length, 2);
  assert.strictEqual(s.rejected[0].label, '시스템 폴더는 추가할 수 없음');
  assert.strictEqual(s.rejected[1].label, '이미 추가된 폴더');
  assert.match(s.message, /거부/);
});

test('summarizeAddResult: 전부 거부 → kind none', () => {
  const s = summarizeAddResult({ ok: true, added: [], rejected: [{ path: 'x', reason: 'NOT_FOUND' }], roots: [] });
  assert.strictEqual(s.kind, 'none');
  assert.strictEqual(s.addedCount, 0);
});

test('summarizeAddResult: CANCELLED → kind cancelled', () => {
  const s = summarizeAddResult({ ok: false, code: 'CANCELLED' });
  assert.strictEqual(s.ok, false);
  assert.strictEqual(s.kind, 'cancelled');
});

test('summarizeAddResult: INVALID_PATH → kind error', () => {
  const s = summarizeAddResult({ ok: false, code: 'INVALID_PATH' });
  assert.strictEqual(s.kind, 'error');
  assert.match(s.message, /경로 형식/);
});

test('summarizeAddResult: 오염 항목 방어(rejected 비객체/누락 path 무시)', () => {
  const s = summarizeAddResult({ ok: true, added: ['a', 123], rejected: [null, { reason: 'x' }, { path: 'p', reason: 'DUP' }], roots: ['a'] });
  assert.deepStrictEqual(s.roots, ['a']);
  assert.strictEqual(s.addedCount, 1); // 123 걸러짐
  assert.strictEqual(s.rejected.length, 1); // path 있는 것만
});

/* ─────────────── describeRejectReason (고정 토큰 매핑) ─────────────── */
test('describeRejectReason: 고정 토큰 → 한국어', () => {
  assert.match(describeRejectReason('NOT_FOUND'), /찾을 수 없/);
  assert.match(describeRejectReason('NOT_DIR'), /폴더가 아님/);
  assert.match(describeRejectReason('SYSTEM_DIR'), /시스템 폴더/);
  assert.match(describeRejectReason('DUP'), /이미 추가/);
  assert.match(describeRejectReason('UNKNOWN_TOKEN'), /거부/);
});

/* ─────────────── XSS / textContent 안전 (path / currentPath 보존) ─────────────── */
test('XSS: summarizeAddResult 는 rejected.path 를 이스케이프하지 않고 보존(textContent 렌더 전제, L-1)', () => {
  const evil = '<img src=x onerror=alert(1)>';
  const s = summarizeAddResult({ ok: true, added: [], rejected: [{ path: evil, reason: 'NOT_FOUND' }], roots: [] });
  // 순수 함수는 문자열을 변형/이스케이프하지 않는다. 렌더 단계(el text)가 textContent 로 안전화.
  assert.strictEqual(s.rejected[0].path, evil);
});

test('XSS: progressView 는 currentPath 악성 문자열을 그대로 보존(textContent 전제)', () => {
  const evil = '"><script>alert(1)</script>';
  const pv = progressView({ phase: 'scanning', currentPath: evil });
  assert.strictEqual(pv.currentPath, evil);
});

test('XSS: configView 는 scanRoots 경로 문자열을 변형하지 않음(textContent 전제)', () => {
  const evil = 'E:\\<svg/onload=alert(1)>';
  const cv = configView({ scanRoots: [evil], size: {} });
  assert.strictEqual(cv.scanRoots[0], evil);
});

/* ─────────────── nextScanAction: push 모델 회귀 가드(요약) ─────────────── */
test('nextScanAction: 진행 단계는 render, 완료/오류/타스캔 분기 유지', () => {
  assert.strictEqual(nextScanAction({ ownScanId: 's' }, { phase: 'scanning', scanId: 's' }).action, 'render');
  assert.strictEqual(nextScanAction({ ownScanId: 's' }, { phase: 'done', scanId: 's' }).action, 'refetch');
  assert.strictEqual(nextScanAction({ ownScanId: 's' }, { phase: 'error', scanId: 's' }).action, 'error');
  assert.strictEqual(nextScanAction({ ownScanId: 's' }, { phase: 'scanning', scanId: 'z' }).action, 'foreign');
});
