'use strict';
/**
 * shelf-widget.test.js — [SH-2] 즐겨찾기 셸프 위젯 순수 뷰모델/헬퍼(헤드리스).
 *   public/app.js 가 내보내는 순수 함수만 검증한다(DOM 비의존). 표시 메타는 main 이 ShelfBookmarkView
 *   로 완비하므로(api-contract) 프론트 VM 은 레이아웃·상태 분기·입력 감지·에러 매핑만 책임진다.
 */
const { test } = require('node:test');
const assert = require('node:assert');

const {
  HOME_SECTION_IDS,
  TOGGLEABLE_WIDGET_IDS,
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
} = require('../public/app.js');

// ── enum 등록 ──────────────────────────────────────────────────────────────
test('SH-2 — HOME_SECTION_IDS 에 shelf·shelfWide 가 featureAdd 앞에 등록', () => {
  assert.ok(HOME_SECTION_IDS.includes('shelf'));
  assert.ok(HOME_SECTION_IDS.includes('shelfWide'));
  const iShelf = HOME_SECTION_IDS.indexOf('shelf');
  const iWide = HOME_SECTION_IDS.indexOf('shelfWide');
  const iFeat = HOME_SECTION_IDS.indexOf('featureAdd');
  assert.ok(iShelf < iWide && iWide < iFeat, 'shelf < shelfWide < featureAdd');
});
test('SH-2 — 두 변형 모두 토글 가능(갤러리에서 추가/제거)', () => {
  assert.ok(TOGGLEABLE_WIDGET_IDS.includes('shelf'));
  assert.ok(TOGGLEABLE_WIDGET_IDS.includes('shelfWide'));
});

// ── spineW / lead 기하 ───────────────────────────────────────────────────────
test('SH-2 — shelfSpineW: 6개까지 58px, 초과분마다 3px 좁힘(최소 42)', () => {
  assert.strictEqual(shelfSpineW(0), 58);
  assert.strictEqual(shelfSpineW(6), 58);
  assert.strictEqual(shelfSpineW(7), 55);
  assert.strictEqual(shelfSpineW(10), 46);
  assert.strictEqual(shelfSpineW(100), 42); // 최소 클램프
  assert.strictEqual(shelfSpineW(-5), 58);  // 음수 graceful
});
test('SH-2 — shelfLead: 펼침이 3번째에 오도록 스파인 2칸 lead = 2*(spineW+6)', () => {
  assert.strictEqual(shelfLead(6), 2 * (58 + 6));
  assert.strictEqual(shelfLead(10), 2 * (46 + 6));
});

// ── detectType ───────────────────────────────────────────────────────────────
test('SH-2 — shelfDetectType: url/folder/file 감지(초안 규칙)', () => {
  assert.strictEqual(shelfDetectType('https://github.com'), 'url');
  assert.strictEqual(shelfDetectType('http://x.io/a'), 'url');
  assert.strictEqual(shelfDetectType('github.com'), 'url');     // 스킴 없는 호스트
  assert.strictEqual(shelfDetectType('example.com/path'), 'url');
  assert.strictEqual(shelfDetectType('/Users/dev/projects/app'), 'folder');
  assert.strictEqual(shelfDetectType('/Users/dev/notes/todo.md'), 'file');
  assert.strictEqual(shelfDetectType('C:\\work\\repo'), 'folder');
  assert.strictEqual(shelfDetectType('C:\\work\\a.txt'), 'file');
  assert.strictEqual(shelfDetectType('~/work/design/'), 'folder'); // 끝 슬래시 → folder
  assert.strictEqual(shelfDetectType('  '), null);
  assert.strictEqual(shelfDetectType(''), null);
  assert.strictEqual(shelfDetectType('just text'), null);
});

// ── hostOf / lastSeg ─────────────────────────────────────────────────────────
test('SH-2 — shelfHostOf: www 제거·스킴 보정·실패 graceful', () => {
  assert.strictEqual(shelfHostOf('https://www.github.com/a/b'), 'github.com');
  assert.strictEqual(shelfHostOf('github.com'), 'github.com');
  assert.strictEqual(shelfHostOf(''), '');
  assert.strictEqual(shelfHostOf(null), '');
});
test('SH-2 — shelfLastSeg: 마지막 세그먼트(끝 구분자 무시)', () => {
  assert.strictEqual(shelfLastSeg('/a/b/c'), 'c');
  assert.strictEqual(shelfLastSeg('/a/b/c/'), 'c');
  assert.strictEqual(shelfLastSeg('C:\\x\\y\\z.txt'), 'z.txt');
  assert.strictEqual(shelfLastSeg(''), '');
});

// ── isValidInput(클라 1차 가드) ─────────────────────────────────────────────
test('SH-2 — shelfIsValidInput: url=호스트형태 / folder·file=경로구분자', () => {
  assert.ok(shelfIsValidInput('url', 'github.com'));
  assert.ok(!shelfIsValidInput('url', 'abc'));
  assert.ok(shelfIsValidInput('folder', '/a/b'));
  assert.ok(shelfIsValidInput('file', 'C:\\x\\y.txt'));
  assert.ok(!shelfIsValidInput('folder', 'noslash'));
});

// ── 에러 메시지 매핑(L-3 고정 enum → 사용자 친화) ───────────────────────────
test('SH-2 — shelfAddErrorMessage: 고정 에러코드 → 한국어 매핑', () => {
  // SH-3에서 url 크롤이 실연결돼 CRAWL_PENDING 은 도달 불가(잔재 제거) — 실패는 CRAWL_FAILED/BLOCKED_HOST 등.
  assert.match(shelfAddErrorMessage('CRAWL_FAILED', 'url'), /연결할 수 없어요/);
  assert.match(shelfAddErrorMessage('BLOCKED_HOST', 'url'), /보안/);
  assert.match(shelfAddErrorMessage('PATH_GONE', 'folder'), /폴더/);
  assert.match(shelfAddErrorMessage('PATH_GONE', 'file'), /파일/);
  assert.match(shelfAddErrorMessage('LIMIT', 'url'), /가득/);
  // 미지 코드 → 유형별 기본 폴백(빈 문자열 아님).
  assert.ok(shelfAddErrorMessage('SOMETHING_NEW', 'folder').length > 0);
});
test('BUG-SHELF-01 — CRAWL_PENDING 잔재 없음("곧 지원" 문구 미존재)', () => {
  // 어떤 코드/유형 조합으로도 "곧 지원" 류 안내가 나오지 않아야 한다(사실과 반대 문구 제거).
  for (const code of ['CRAWL_PENDING', 'CRAWL_FAILED', 'BLOCKED_HOST', 'PATH_GONE', 'PATH_DENIED',
    'UNSUPPORTED_TYPE', 'LIMIT', 'BAD_INPUT', 'NOT_FOUND', 'OPEN_FAILED', 'INTERNAL', 'FORBIDDEN', 'ZZZ', undefined]) {
    for (const type of ['url', 'folder', 'file']) {
      assert.doesNotMatch(shelfAddErrorMessage(code, type), /곧 지원/, 'code=' + code + ' type=' + type);
    }
  }
});

// ── composer 뷰모델 ──────────────────────────────────────────────────────────
test('SH-2 — shelfComposerVM: 유형 active 토글 + placeholder + 상태 플래그', () => {
  const vm = shelfComposerVM({ cType: 'folder', cUrl: '/a/b', cState: 'loading' });
  assert.strictEqual(vm.cType, 'folder');
  assert.deepStrictEqual(vm.types.map((t) => t.active), [false, true, false]);
  assert.match(vm.inputPlaceholder, /폴더 경로/);
  assert.ok(vm.cLoading && !vm.cIdle && !vm.cError);
  assert.match(vm.crawlingLabel, /스캔 중/);     // 폴더/파일=스캔
  assert.strictEqual(vm.inputBorder, '#c7d2fe'); // loading 테두리
});
test('SH-2 — shelfComposerVM: url 은 크롤링 라벨·호스트, idle 기본 테두리', () => {
  const vm = shelfComposerVM({ cType: 'url', cUrl: 'https://github.com', cState: 'idle' });
  assert.match(vm.crawlingLabel, /크롤링 중 · github\.com/);
  assert.ok(vm.cIdle);
  assert.strictEqual(vm.inputBorder, '#e7e5e4');
});
test('SH-2 — shelfComposerVM: 잘못된 유형/상태 graceful 정규화', () => {
  const vm = shelfComposerVM({ cType: 'xxx', cUrl: '', cState: 'weird' });
  assert.strictEqual(vm.cType, 'url');
  assert.ok(vm.cIdle);
});

// ── panels 뷰모델 ────────────────────────────────────────────────────────────
const SAMPLE = [
  { id: 'b1', type: 'url', name: 'GitHub', title: 'GitHub', sub: 'github.com', desc: 'd', color: '#1c1917', mono: 'G', cat: '개발', status: '200', bannerImage: 'data:image/png;base64,AAAA' },
  { id: 'b2', type: 'folder', name: 'app', title: 'app', sub: '~/app', desc: 'd', color: '#2563eb', mono: 'A', cat: 'React', status: '12개', bannerImage: null },
  { id: 'b3', type: 'file', name: 'todo.md', title: 'todo.md', sub: '~/todo.md', desc: 'd', color: 'nothex', mono: 'MD', cat: 'Markdown', status: '3KB' },
];
test('SH-2 — shelfPanelsVM: 활성 1개만 expanded, 나머지 collapsed', () => {
  const panels = shelfPanelsVM(SAMPLE, 'b2');
  assert.deepStrictEqual(panels.map((p) => p.expanded), [false, true, false]);
  assert.deepStrictEqual(panels.map((p) => p.collapsed), [true, false, true]);
});
test('SH-2 — shelfPanelsVM: 활성 id 부재 시 첫 항목으로 폴백', () => {
  const panels = shelfPanelsVM(SAMPLE, 'nope');
  assert.strictEqual(panels[0].expanded, true);
});
test('SH-2 — shelfPanelsVM: bannerImage 는 data:image 만 채택, 그 외 null(그라데이션 폴백)', () => {
  const panels = shelfPanelsVM(SAMPLE, 'b1');
  assert.strictEqual(panels[0].bannerImage, 'data:image/png;base64,AAAA');
  assert.strictEqual(panels[1].bannerImage, null);
  assert.strictEqual(panels[2].bannerImage, null);
});
test('SH-2 — shelfPanelsVM: 유형별 배너 라벨·열기 라벨', () => {
  const panels = shelfPanelsVM(SAMPLE, 'b1');
  assert.strictEqual(panels[0].bannerLabel, 'og:image');
  assert.strictEqual(panels[1].bannerLabel, '디렉토리');
  assert.strictEqual(panels[2].bannerLabel, '파일');
  assert.strictEqual(panels[0].openLabel, '열기');
  assert.strictEqual(panels[1].openLabel, 'VS Code에서 열기');
  assert.strictEqual(panels[2].openLabel, '편집기에서 열기');
});
test('SH-2 — shelfPanelsVM: 모든 패널 동일 spineW(개수 기반)', () => {
  const panels = shelfPanelsVM(SAMPLE, 'b1');
  panels.forEach((p) => assert.strictEqual(p.spineW, shelfSpineW(SAMPLE.length)));
});

// ── color sanitize(속성 인젝션 차단) ────────────────────────────────────────
test('SH-2 — shelfSafeColor: #RRGGBB 만 허용, 그 외 indigo 폴백', () => {
  assert.strictEqual(shelfSafeColor('#1c1917'), '#1c1917');
  assert.strictEqual(shelfSafeColor('red'), '#4f46e5');
  assert.strictEqual(shelfSafeColor('#fff'), '#4f46e5');            // 3자리 불허
  assert.strictEqual(shelfSafeColor('#1c1917;background:url(x)'), '#4f46e5'); // 인젝션 차단
  assert.strictEqual(shelfSafeColor(null), '#4f46e5');
});
test('SH-2 — shelfPanelsVM: 비정상 color 는 안전 폴백으로 정규화', () => {
  const panels = shelfPanelsVM(SAMPLE, 'b3');
  assert.strictEqual(panels[2].color, '#4f46e5'); // 'nothex' → 폴백
});

// ── 상태 분기 ────────────────────────────────────────────────────────────────
test('SH-2 — shelfStateFlags: empty/few/loading 분기', () => {
  assert.deepStrictEqual(shelfStateFlags([], 'idle'), { count: 0, hasItems: false, isEmpty: true });
  assert.deepStrictEqual(shelfStateFlags([], 'loading'), { count: 0, hasItems: true, isEmpty: false }); // 추가 중 행 유지
  assert.deepStrictEqual(shelfStateFlags(SAMPLE, 'idle'), { count: 3, hasItems: true, isEmpty: false });
});

// ── [SH-4] 자동 재크롤 토글 뷰모델 ──────────────────────────────────────────
test('SH-4 — shelfAutoRefreshView: 기본 ON(undefined/true → on, 힌트=갱신 안내)', () => {
  const on = shelfAutoRefreshView(true);
  assert.strictEqual(on.on, true);
  assert.match(on.hint, /6시간마다/);
  assert.ok(on.switchClass.includes('shelf-switch--on'));
  assert.match(on.ariaLabel, /켜짐/);
  // undefined(미적재) 도 기본 ON 으로 취급(list 전 graceful).
  assert.strictEqual(shelfAutoRefreshView(undefined).on, true);
});
test('SH-4 — shelfAutoRefreshView: OFF(false → off, 힌트=꺼짐 안내, 클래스 미포함)', () => {
  const off = shelfAutoRefreshView(false);
  assert.strictEqual(off.on, false);
  assert.match(off.hint, /꺼져 있어요/);
  assert.ok(!off.switchClass.includes('--on'));
  assert.match(off.ariaLabel, /꺼짐/);
  assert.match(off.ariaLabel, /켜기/); // 클릭 시 동작 안내
});
