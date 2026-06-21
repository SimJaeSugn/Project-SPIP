'use strict';
/**
 * dashboard-m6.test.js — M6(R-17~R-21) 프론트 순수 로직 + IPC 어댑터 로직 검증(DOM 비의존).
 * 대상: public/app.js 의 M6 추가 함수
 *   R-17  buildCopyText            (복사 텍스트 구성 / XSS·경로 보존)
 *   R-18  toolView/toolViews/toolStatusLabel/describeToolError (tools 표시 매핑 — args 없음)
 *   R-19  applyOrder/moveInOrder/nextSortMode (order 적용·이동·sortMode 전이)
 *   R-20  toggleFavorite/isFavorite/matchesFavoritesFilter (즐겨찾기 토글 상태·필터)
 *   R-21  nextSlideIndex/favoriteViewModels/dispatchTrayAction (슬라이더 인덱스·교집합·onTray 디스패치)
 *   공통  uiStateView             (getUiState 응답 → 초기 상태 graceful)
 * 계약: docs/architecture/m6-design.html §4(IPC), §6~9(UI). tools 응답에 args 없음(M6-H-2).
 */
const { test } = require('node:test');
const assert = require('node:assert');

const {
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
} = require('../public/app.js');

/* ─────────────── R-17: buildCopyText (복사 텍스트 구성) ─────────────── */
test('buildCopyText: 정상 경로는 trim 후 그대로 반환', () => {
  assert.strictEqual(buildCopyText('E:\\projects\\app'), 'E:\\projects\\app');
  assert.strictEqual(buildCopyText('  C:\\x  '), 'C:\\x');
});
test('buildCopyText: 비문자열/빈/공백 → null(복사 생략)', () => {
  assert.strictEqual(buildCopyText(''), null);
  assert.strictEqual(buildCopyText('   '), null);
  assert.strictEqual(buildCopyText(null), null);
  assert.strictEqual(buildCopyText(123), null);
  assert.strictEqual(buildCopyText(undefined), null);
});
test('R-17 XSS: 악성 문자열 경로를 이스케이프/변형하지 않고 보존(클립보드는 텍스트 한정·렌더 textContent)', () => {
  const evil = 'E:\\<img src=x onerror=alert(1)>\\"\';--';
  assert.strictEqual(buildCopyText(evil), evil);
});

/* ─────────────── R-18: tools 표시 매핑 (args 없음) ─────────────── */
test('toolView: 계약 shape 매핑(resolved/source) + label 폴백', () => {
  const v = toolView({ id: 'code', label: 'VS Code', path: 'C:\\Code.exe', resolved: true, source: 'config' });
  assert.strictEqual(v.id, 'code');
  assert.strictEqual(v.label, 'VS Code');
  assert.strictEqual(v.path, 'C:\\Code.exe');
  assert.strictEqual(v.resolved, true);
  assert.strictEqual(v.source, 'config');
  assert.strictEqual(v.needsPathHelp, false);
});
test('toolView: label 비면 id 폴백, path 비면 null', () => {
  const v = toolView({ id: 'code', resolved: false, source: 'none' });
  assert.strictEqual(v.label, 'code');
  assert.strictEqual(v.path, null);
});
test('toolView: resolved=false && source=none → PATH 안내(needsPathHelp)', () => {
  assert.strictEqual(toolView({ id: 'code', resolved: false, source: 'none' }).needsPathHelp, true);
  assert.strictEqual(toolView({ id: 'code', resolved: true, source: 'path' }).needsPathHelp, false);
  assert.strictEqual(toolView({ id: 'code', resolved: false, source: 'config' }).needsPathHelp, false);
});
test('toolView: source 화이트리스트 밖 → none, 비객체 graceful', () => {
  assert.strictEqual(toolView({ id: 'code', source: 'evil' }).source, 'none');
  assert.strictEqual(toolView(null).source, 'none');
  assert.strictEqual(toolView(null).id, '');
});
test('toolView: 응답에 args 가 있어도 뷰모델에 포함하지 않음(M6-H-2)', () => {
  const v = toolView({ id: 'code', path: 'C:\\Code.exe', resolved: true, source: 'config', args: ['--evil'] });
  assert.ok(!('args' in v), 'toolView 에 args 키가 없어야 한다');
});
test('toolViews: 배열 매핑 / 비배열 graceful', () => {
  assert.strictEqual(toolViews([{ id: 'code' }, { id: 'git' }]).length, 2);
  assert.deepStrictEqual(toolViews(null), []);
  assert.deepStrictEqual(toolViews('x'), []);
});
test('toolStatusLabel: 색 외 텍스트 상태 라벨(N-07)', () => {
  assert.match(toolStatusLabel(false, 'none'), /미해결/);
  assert.match(toolStatusLabel(true, 'config'), /지정한 경로/);
  assert.match(toolStatusLabel(true, 'path'), /PATH/);
});
test('describeToolError: 실패 code 한국어(고정 토큰만, L-3)', () => {
  assert.strictEqual(describeToolError({ code: 'INVALID_TOOL_ID' }), '알 수 없는 툴입니다.');
  assert.strictEqual(describeToolError({ code: 'NOT_ABSOLUTE' }), '절대경로를 입력하세요.');
  assert.match(describeToolError({ code: 'NOT_EXECUTABLE' }), /실행 파일이 아닙니다/);
  assert.strictEqual(describeToolError({ code: 'CANCELLED' }), '파일 선택이 취소되었습니다.');
  assert.match(describeToolError({ code: 'WAT' }), /WAT/);
  assert.strictEqual(describeToolError(null), '처리하지 못했습니다.');
});
test('R-18 XSS: toolView 는 label/path 를 변형/이스케이프하지 않고 보존(textContent 전제 L-1)', () => {
  const evil = '<b>x</b>';
  const v = toolView({ id: 'code', label: evil, path: evil, resolved: true, source: 'config' });
  assert.strictEqual(v.label, evil);
  assert.strictEqual(v.path, evil);
});

/* ─────────────── R-20: 즐겨찾기 토글 상태 ─────────────── */
test('toggleFavorite: 추가/제거(중복 없음·순서 보존)', () => {
  assert.deepStrictEqual(toggleFavorite([], 'a', true), ['a']);
  assert.deepStrictEqual(toggleFavorite(['a'], 'a', true), ['a']); // 이미 있으면 그대로
  assert.deepStrictEqual(toggleFavorite(['a', 'b'], 'a', false), ['b']);
  assert.deepStrictEqual(toggleFavorite(['a', 'b'], 'c', false), ['a', 'b']); // 없는 것 제거 무해
});
test('toggleFavorite: 원본 불변(새 배열 반환)', () => {
  const src = ['a'];
  const out = toggleFavorite(src, 'b', true);
  assert.deepStrictEqual(src, ['a']);
  assert.deepStrictEqual(out, ['a', 'b']);
});
test('toggleFavorite: 비유효 id/비배열 graceful', () => {
  assert.deepStrictEqual(toggleFavorite(null, 'a', true), ['a']);
  assert.deepStrictEqual(toggleFavorite(['a'], '', true), ['a']);
  assert.deepStrictEqual(toggleFavorite(['a'], 123, true), ['a']);
});
test('isFavorite: 멤버십', () => {
  assert.strictEqual(isFavorite(['a', 'b'], 'a'), true);
  assert.strictEqual(isFavorite(['a', 'b'], 'c'), false);
  assert.strictEqual(isFavorite(null, 'a'), false);
});
test('matchesFavoritesFilter: favoritesOnly off → 전부 통과 / on → 즐겨찾기만', () => {
  const vm = { id: 'a' };
  assert.strictEqual(matchesFavoritesFilter(vm, false, []), true);
  assert.strictEqual(matchesFavoritesFilter(vm, true, ['a']), true);
  assert.strictEqual(matchesFavoritesFilter(vm, true, ['b']), false);
});

/* ─────────────── R-19: order 적용 / 이동 / sortMode 전이 ─────────────── */
const VMS = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
test('applyOrder: manual 이면 order 순서로 정렬, 신규는 뒤 append', () => {
  const out = applyOrder(VMS, 'manual', ['c', 'a']); // b 는 order 에 없음
  assert.deepStrictEqual(out.map((v) => v.id), ['c', 'a', 'b']);
});
test('applyOrder: manual + order 에 있으나 스냅샷에 없는 id 는 skip', () => {
  const out = applyOrder(VMS, 'manual', ['zzz', 'b', 'a', 'c']);
  assert.deepStrictEqual(out.map((v) => v.id), ['b', 'a', 'c']);
});
test('applyOrder: order 중복 제거(첫 등장만)', () => {
  const out = applyOrder(VMS, 'manual', ['a', 'a', 'b']);
  assert.deepStrictEqual(out.map((v) => v.id), ['a', 'b', 'c']);
});
test('applyOrder: 빈 order(manual) → 원래 순서 유지', () => {
  assert.deepStrictEqual(applyOrder(VMS, 'manual', []).map((v) => v.id), ['a', 'b', 'c']);
});
test('moveInOrder: from→to 이동(새 배열·원본 불변)', () => {
  const src = ['a', 'b', 'c', 'd'];
  assert.deepStrictEqual(moveInOrder(src, 0, 2), ['b', 'c', 'a', 'd']);
  assert.deepStrictEqual(moveInOrder(src, 3, 0), ['d', 'a', 'b', 'c']);
  assert.deepStrictEqual(src, ['a', 'b', 'c', 'd']); // 불변
});
test('moveInOrder: 범위 밖/동일 인덱스/비정수 → 원본 복제', () => {
  const src = ['a', 'b'];
  assert.deepStrictEqual(moveInOrder(src, 0, 0), ['a', 'b']);
  assert.deepStrictEqual(moveInOrder(src, -1, 1), ['a', 'b']);
  assert.deepStrictEqual(moveInOrder(src, 0, 9), ['a', 'b']);
  assert.deepStrictEqual(moveInOrder(src, 0.5, 1), ['a', 'b']);
});
test('nextSortMode: 드래그/이동(reorder) → manual 강제', () => {
  assert.deepStrictEqual(nextSortMode('auto', 'reorder'), { sortMode: 'manual', changed: true });
  assert.deepStrictEqual(nextSortMode('manual', 'reorder'), { sortMode: 'manual', changed: false });
});
test('nextSortMode: 정렬 셀렉터(sortSelect) → auto 복귀', () => {
  assert.deepStrictEqual(nextSortMode('manual', 'sortSelect'), { sortMode: 'auto', changed: true });
  assert.deepStrictEqual(nextSortMode('auto', 'sortSelect'), { sortMode: 'auto', changed: false });
});
test('nextSortMode: 알 수 없는 trigger → 현 상태 유지', () => {
  assert.deepStrictEqual(nextSortMode('manual', 'wat'), { sortMode: 'manual', changed: false });
});

/* ─────────────── R-21: 슬라이더 인덱스 / 교집합 / onTray 디스패치 ─────────────── */
test('nextSlideIndex: 좌/우 이동(래핑)', () => {
  assert.strictEqual(nextSlideIndex(0, 1, 3), 1);
  assert.strictEqual(nextSlideIndex(2, 1, 3), 0); // 우 끝 → 처음
  assert.strictEqual(nextSlideIndex(0, -1, 3), 2); // 좌 처음 → 끝
});
test('nextSlideIndex: 빈/단일 목록 graceful', () => {
  assert.strictEqual(nextSlideIndex(0, 1, 0), 0);
  assert.strictEqual(nextSlideIndex(5, 1, 1), 0);
});
test('nextSlideIndex: 범위 밖 cur 보정', () => {
  assert.strictEqual(nextSlideIndex(9, 0, 3), 0); // 9 % 3 = 0, dir 0
  assert.strictEqual(nextSlideIndex(-1, 0, 3), 2);
});
test('favoriteViewModels: favorites ∩ 스냅샷 (favorites 순서, 소멸 id skip)', () => {
  const out = favoriteViewModels(VMS, ['c', 'zzz', 'a']);
  assert.deepStrictEqual(out.map((v) => v.id), ['c', 'a']);
});
test('favoriteViewModels: 빈 favorites / 비배열 graceful', () => {
  assert.deepStrictEqual(favoriteViewModels(VMS, []), []);
  assert.deepStrictEqual(favoriteViewModels(VMS, null), []);
  assert.deepStrictEqual(favoriteViewModels(null, ['a']), []);
});
test('dispatchTrayAction: dashboard 단일 화이트리스트 매핑 (M7 §8.1·R4)', () => {
  // ★M7: 트레이 '즐겨찾기'는 main 이 위젯 창을 직접 열고 메인창에 push 하지 않는다 →
  //   onTray 화이트리스트를 'dashboard' 단일로 축소(SEC-L1). 과거 'favorites' 는 null.
  assert.strictEqual(dispatchTrayAction({ action: 'dashboard' }).handler, 'dashboard');
  assert.strictEqual(dispatchTrayAction({ action: 'favorites' }).handler, null);
});
test('dispatchTrayAction: 화이트리스트 밖/비정상 → null(graceful)', () => {
  assert.strictEqual(dispatchTrayAction({ action: 'quit' }).handler, null);
  assert.strictEqual(dispatchTrayAction({ action: '' }).handler, null);
  assert.strictEqual(dispatchTrayAction(null).handler, null);
  assert.strictEqual(dispatchTrayAction('favorites').handler, null);
  assert.strictEqual(dispatchTrayAction({ action: 123 }).handler, null);
});
test('dispatchTrayAction: 항상 {handler} shape(부수효과 없음 — 순수)', () => {
  assert.deepStrictEqual(Object.keys(dispatchTrayAction({ action: 'dashboard' })), ['handler']);
});

/* ─────────────── 공통: uiStateView (getUiState 초기 상태) ─────────────── */
test('uiStateView: 계약 shape 매핑', () => {
  const v = uiStateView({ ok: true, favorites: ['a'], order: ['a', 'b'], sortMode: 'manual' });
  assert.deepStrictEqual(v, { favorites: ['a'], order: ['a', 'b'], sortMode: 'manual' });
});
test('uiStateView: sortMode 화이트리스트 밖 → auto', () => {
  assert.strictEqual(uiStateView({ sortMode: 'evil' }).sortMode, 'auto');
  assert.strictEqual(uiStateView({}).sortMode, 'auto');
});
test('uiStateView: 비배열/비문자열 항목 graceful 필터', () => {
  const v = uiStateView({ favorites: ['a', 1, null], order: 'x', sortMode: 'manual' });
  assert.deepStrictEqual(v.favorites, ['a']);
  assert.deepStrictEqual(v.order, []);
});
test('uiStateView: null/손상 → 기본값', () => {
  assert.deepStrictEqual(uiStateView(null), { favorites: [], order: [], sortMode: 'auto' });
});

/* ─────────────── IPC 어댑터 로직 (window.spip 모킹) ─────────────── */
// 신규 채널은 호출부가 ipc(varMethod) 로 호출하므로 정합 테스트(리터럴 대조)와 충돌하지 않는다.
// 여기서는 어댑터의 낙관적 반영·graceful 폴백 본질을 모킹으로 재현해 회귀를 고정한다.

test('IPC: copyText 어댑터 — 성공/INVALID_TEXT/부재(graceful) 분기', async () => {
  // 어댑터 본질: buildCopyText 로 텍스트 구성 후 ok 여부로 토스트 분기.
  const calls = [];
  const spip = { copyText: async (t) => { calls.push(t); return { ok: true }; } };
  const text = buildCopyText('E:\\x');
  assert.ok(text);
  const res = await spip.copyText(text);
  assert.strictEqual(res.ok, true);
  assert.deepStrictEqual(calls, ['E:\\x']);

  // 부재(웹/테스트): 함수 없음 → 호출부가 bridgeHas 로 가드(여기선 함수 부재만 확인)
  const noBridge = {};
  assert.strictEqual(typeof noBridge.copyText, 'undefined');
});

test('IPC: setFavorite 어댑터 — 낙관적 반영 후 서버 favorites 로 동기화', async () => {
  // 낙관적: toggleFavorite 로 즉시 메모리 반영
  let mem = ['a'];
  mem = toggleFavorite(mem, 'b', true);
  assert.deepStrictEqual(mem, ['a', 'b']);
  // 서버 응답으로 정합 동기화(서버가 정렬/정리한 결과 우선)
  const spip = { setFavorite: async (id, on) => ({ ok: true, favorites: ['b', 'a'] }) };
  const res = await spip.setFavorite('b', true);
  assert.deepStrictEqual(res.favorites, ['b', 'a']);
});

test('IPC: setOrder 어댑터 — manual 전환 + order 영속(응답 우선)', async () => {
  const display = ['a', 'b', 'c'];
  const moved = moveInOrder(display, 0, 2); // ['b','c','a']
  const spip = { setOrder: async (ids) => ({ ok: true, order: ids, sortMode: 'manual' }) };
  const res = await spip.setOrder(moved);
  assert.strictEqual(res.sortMode, 'manual');
  assert.deepStrictEqual(res.order, ['b', 'c', 'a']);
});

test('IPC: getTools 어댑터 — 응답 → toolViews 매핑(args 무시)', async () => {
  const spip = { getTools: async () => ({ ok: true, tools: [
    { id: 'code', label: 'VS Code', path: null, resolved: false, source: 'none', args: ['x'] },
  ] }) };
  const res = await spip.getTools();
  const views = toolViews(res.tools);
  assert.strictEqual(views.length, 1);
  assert.strictEqual(views[0].needsPathHelp, true);
  assert.ok(!('args' in views[0]));
});

test('IPC: onTray 구독 — dashboard 디스패치(M7 favorites 제외) + unsubscribe 계약', () => {
  const routed = [];
  function onTrayCommand(msg) {
    const { handler } = dispatchTrayAction(msg);
    if (handler) routed.push(handler);
  }
  let registered = null;
  let unsubscribed = false;
  const onTray = (cb) => { registered = cb; return () => { unsubscribed = true; }; };

  const unsub = onTray(onTrayCommand);
  registered({ action: 'favorites' }); // ★M7: 더 이상 라우팅 안 됨(위젯 창은 main 직접 열기)
  registered({ action: 'dashboard' });
  registered({ action: 'bogus' }); // 무시
  assert.deepStrictEqual(routed, ['dashboard']);
  assert.strictEqual(typeof unsub, 'function');
  unsub();
  assert.strictEqual(unsubscribed, true);
});
