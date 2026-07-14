'use strict';
/**
 * mdedit-widget.test.js — 마크다운 편집기 위젯 배선·반응형 (MD-1 / MD-SEC / 6조합 계약)
 *
 * 렌더러는 DOM 없이는 실행할 수 없으므로, 탐색기 위젯 테스트와 동일하게
 *   ① 순수 함수(레지스트리·크기 계약)는 require 로 직접 호출하고
 *   ② 렌더 경로의 불변식(innerHTML 금지, 고정 코드, 코너 규약, @container 반응형)은
 *      **정적 소스 대조**로 고정한다.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const {
  HOME_SECTION_IDS, TOGGLEABLE_WIDGET_IDS, homeDefaultSpan, homeWidgetMinH, homeHRow, HOME_MAX_COLS,
} = require('../public/app.js');

const ROOT = path.join(__dirname, '..');
const APP_SRC = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const CSS = fs.readFileSync(path.join(ROOT, 'public', 'styles.css'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const PRELOAD_SRC = fs.readFileSync(path.join(ROOT, 'electron', 'preload.js'), 'utf8');
const REGISTER_SRC = fs.readFileSync(path.join(ROOT, 'electron', 'ipc', 'register.js'), 'utf8');
const STORE_SRC = fs.readFileSync(path.join(ROOT, 'lib', 'common', 'uiStateStore.js'), 'utf8');

/** app.js 에서 MD 편집기 위젯 섹션만 잘라낸다(주석 마커 기준). */
function mdSection() {
  const start = APP_SRC.indexOf('/* ===== [MD 편집기 위젯] 마크다운 편집기 =====');
  assert.ok(start >= 0, 'MD 편집기 위젯 섹션 시작 주석이 있어야 한다');
  const end = APP_SRC.indexOf('/* ===== [MD 편집기 위젯] 끝 =====', start);
  assert.ok(end > start, '섹션 끝 주석을 찾아야 한다');
  return APP_SRC.slice(start, end);
}
/** 주석을 걷어낸 실행 코드(설명 주석의 단어가 오탐되지 않게). */
function mdCode() {
  return mdSection().replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}
/** preload 의 md:{} 블록이 노출하는 메서드명 집합. */
function preloadMdKeys() {
  const m = /\bmd:\s*\{([\s\S]*?)\n  \},/.exec(PRELOAD_SRC);
  assert.ok(m, 'preload 에 md 네임스페이스 블록이 있어야 한다');
  const keys = new Set();
  const re = /(\w+):\s*\(/g;
  let k;
  while ((k = re.exec(m[1])) !== null) keys.add(k[1]);
  return keys;
}

/* ───── 레지스트리 배선 ───── */

test('MD-1 — 위젯 id 가 세 레지스트리에 모두 배선(HOME_SECTION_IDS / WIDGET_META / switch)', () => {
  assert.ok(HOME_SECTION_IDS.includes('mdedit'), 'HOME_SECTION_IDS 에 mdedit');
  assert.ok(TOGGLEABLE_WIDGET_IDS.includes('mdedit'), '갤러리에서 추가/제거 가능(토글 위젯)');
  assert.ok(/mdedit:\s*\{\s*name:\s*'마크다운 편집기'/.test(APP_SRC), 'WIDGET_META 에 표시 메타');
  // [위젯 인스턴스] 렌더 함수는 인스턴스({iid,type,name})를 받는다 — 편집기 2개가 다른 문서를 연다.
  assert.ok(/case 'mdedit':\s*return renderHomeMdEdit\(inst\);/.test(APP_SRC), 'renderHomeSection switch 배선(인스턴스 전달)');
  assert.ok(/maybeLoadMdEdit\(\);/.test(APP_SRC), 'renderHome 에서 지연 적재 호출');
});

test('MD-1 — 렌더러 HOME_SECTION_IDS 가 메인 uiStateStore 와 동형(드리프트 0)', () => {
  const m = STORE_SRC.match(/HOME_SECTION_IDS\s*=\s*\[([^\]]*)\]/);
  const mainIds = (m[1].match(/'([a-zA-Z]+)'/g) || []).map((s) => s.replace(/'/g, ''));
  assert.deepStrictEqual(mainIds, HOME_SECTION_IDS);
  assert.ok(mainIds.includes('mdedit'));
});

test('MD-1 — 신규 위젯은 기본 미배치(갤러리 opt-in) — 레거시 사용자에게 갑툭튀 금지', () => {
  const store = require('../lib/common/uiStateStore');
  // [위젯 인스턴스 v6] '숨김'이 '미배치'로 바뀌었다 — 기본 배치에 mdedit 인스턴스가 없다.
  assert.ok(store.DEFAULT_HIDDEN_WIDGETS.includes('mdedit'), '신규 설치 시드에서 기본 미배치');
  assert.ok(!store.defaultHomeWidgets().some((w) => w.type === 'mdedit'), '기본 배치에 없음');
  // 레거시(v4) 사용자에게도 갑툭튀하지 않는다.
  const migrated = store.normalizeState({ schemaVersion: 4, hiddenWidgets: [] });
  assert.ok(!migrated.homeWidgets.some((w) => w.type === 'mdedit'), 'v4 사용자에게 미배치');
  // 사용자가 추가하면 배치된다(그리고 여러 개 추가할 수 있다).
  const added = store.normalizeState({
    schemaVersion: store.SCHEMA_VERSION,
    homeWidgets: [{ iid: 'w1', type: 'mdedit', name: '회의록' }, { iid: 'w2', type: 'mdedit', name: 'TODO' }],
  });
  assert.strictEqual(added.homeWidgets.filter((w) => w.type === 'mdedit').length, 2, '중복 배치 가능');
});

test('MD-1 — 숨김 위젯이면 IPC 0(불필요한 디스크 읽기 회피)', () => {
  const m = APP_SRC.match(/function maybeLoadMdEdit\(\)\s*\{[\s\S]*?\n  \}/);
  assert.ok(m, 'maybeLoadMdEdit 정의');
  assert.ok(/homeWidgetVisible\('mdedit'\)/.test(m[0]), '표시 중일 때만 적재');
});

/* ───── IPC 표면 정합 ───── */

test('MD-1 — preload 표면(spip.md.*) ↔ 렌더러 mdIpc 호출 정합', () => {
  const exposed = preloadMdKeys();
  const called = new Set();
  const re = /mdIpc\('([A-Za-z0-9_$]+)'/g;
  let m;
  while ((m = re.exec(APP_SRC)) !== null) called.add(m[1]);
  assert.ok(called.size > 0, '렌더러가 mdIpc 를 사용해야 한다');
  for (const c of called) assert.ok(exposed.has(c), 'preload 에 노출되지 않은 메서드 호출: ' + c);
  for (const need of ['list', 'get', 'create', 'update', 'remove', 'importFile', 'exportFile']) {
    assert.ok(exposed.has(need), 'preload 노출 누락: ' + need);
  }
});

test('MD-1 — preload 채널명 ↔ register.js 등록 채널 정합(드리프트 0)', () => {
  const chans = new Set();
  const re = /'(spip:md:[A-Za-z]+)'/g;
  let m;
  while ((m = re.exec(PRELOAD_SRC)) !== null) chans.add(m[1]);
  assert.strictEqual(chans.size, 7, 'preload 가 7개 md 채널을 호출');
  for (const c of chans) assert.ok(REGISTER_SRC.includes("guard('" + c + "'"), 'register.js 미등록 채널: ' + c);
});

test('MD-H-1 — 렌더러가 경로를 주입할 표면이 없다(import/export 는 경로 인자 없음)', () => {
  const m = /\bmd:\s*\{([\s\S]*?)\n  \},/.exec(PRELOAD_SRC);
  const block = m[1];
  assert.ok(/importFile:\s*\(\)\s*=>/.test(block), 'importFile 은 인자 0');
  assert.ok(/exportFile:\s*\(id\)\s*=>/.test(block), 'exportFile 은 문서 id 만');
  assert.ok(!/path/.test(block), 'md 네임스페이스에 path 인자를 넘기는 채널이 없어야 한다');
  // 경로를 받는 범용 read/write 채널을 새로 열지 않았는지 — register 에도 없어야 한다.
  assert.ok(!/spip:md:(read|write|readFile|writeFile)/.test(REGISTER_SRC), '임의 경로 read/write 채널 금지');
});

/* ───── 보안: 렌더 경로(L-1 / MD-SEC) ───── */

test('MD-SEC — L-1: 미리보기 렌더 경로에 innerHTML 없음(전부 textContent/el)', () => {
  const code = mdCode();
  assert.ok(!/innerHTML/.test(code), 'MD 편집기 섹션 실행 코드에 innerHTML 금지');
  assert.ok(!/insertAdjacentHTML|outerHTML|document\.write/.test(code), 'HTML 문자열 주입 API 금지');
  assert.ok(/createTextNode\(n\.value\)/.test(code), '텍스트 노드는 createTextNode 로');
  assert.ok(/el\('code', \{ cls: 'md-code', text: n\.value \}\)/.test(code), '코드 스팬은 el({text}) → textContent');
});

test('MD-SEC — 파서가 만든 AST 노드 타입만 렌더한다(html/raw 렌더 분기 없음)', () => {
  const code = mdCode();
  assert.ok(!/case 'html'|case 'raw'/.test(code), '원시 HTML 렌더 분기가 존재하지 않는다');
  // 파서도 html/raw 노드를 만들지 않는다(이중 확인).
  const md = require('../public/markdown.js');
  const json = JSON.stringify(md.parse('<img src=x onerror=alert(1)>'));
  assert.ok(json.indexOf('"type":"image"') < 0, 'HTML img 태그는 이미지 노드가 되지 않는다');
});

test('MD-SEC — 링크는 openExternal(main 재검증)로만 연다(렌더러 네비게이션 금지)', () => {
  const code = mdCode();
  const fn = code.slice(code.indexOf('function mdOpenLink'));
  assert.ok(/openExternal/.test(fn), '외부 링크는 openExternal 로');
  assert.ok(/e\.preventDefault\(\)/.test(code), '기본 네비게이션 차단');
  assert.ok(!/location\s*=|location\.href|window\.open/.test(code), '렌더러 직접 네비게이션 금지');
});

test('MD-1 — L-3: 실패 코드 → 고정 문구 매핑(내부 경로·errno 비노출)', () => {
  const src = mdSection();
  assert.ok(/var MD_CODES = \{/.test(src), '고정 코드 매핑 테이블');
  for (const code of ['NOT_FOUND', 'LIMIT_DOCS', 'LIMIT_SIZE', 'READ_FAILED', 'WRITE_FAILED', 'CANCELLED']) {
    assert.ok(new RegExp(code + ':').test(src), 'MD_CODES 누락: ' + code);
  }
  assert.ok(/function mdMessage\(code\)/.test(src), '미지 코드는 기본 문구로 폴백');
});

test('MD-1 — 파괴적 동작(삭제)은 확인 모달을 거친다', () => {
  const src = mdSection();
  const rm = src.slice(src.indexOf('function mdRemoveDoc'));
  assert.ok(/askConfirm\(\{/.test(rm), '삭제는 askConfirm');
  assert.ok(/danger: true/.test(rm), '위험 액션 표시');
  assert.ok(/내보내/.test(rm), '되돌릴 수 없음 + 내보내기 안내');
});

/* ───── 크기 계약(6조합) ───── */

test('6조합 — mdedit 최소 크기: 최소 폭 1열 + 최소 높이(툴바+문서바+에디터)', () => {
  assert.strictEqual(homeWidgetMinH('mdedit'), 240, '편집 영역이 사라지지 않는 높이 하한');
  assert.strictEqual(homeDefaultSpan('mdedit'), 2, '기본 폭은 2열(편집+미리보기 2단이 펴지는 폭)');
  assert.ok(homeDefaultSpan('mdedit') <= HOME_MAX_COLS);
});

test('6조합 — (1,1)~(1,4)·(2,1)·(3,1) 전부 유효한 크기로 표현된다', () => {
  const minH = homeWidgetMinH('mdedit');
  // (가로 열 스팬, 세로 높이 배수) 6조합 — 폭은 1..HOME_MAX_COLS, 높이는 최소 높이의 1~4배.
  const COMBOS = [[1, 1], [1, 2], [1, 3], [1, 4], [2, 1], [3, 1]];
  for (const [w, hMul] of COMBOS) {
    assert.ok(w >= 1 && w <= HOME_MAX_COLS, '폭 스팬 유효: ' + w);
    const h = minH * hMul;
    assert.strictEqual(homeHRow('mdedit', h), hMul, '(' + w + ',' + hMul + ') → data-hrow=' + hMul);
  }
  // 최소 미만으로는 줄일 수 없다(리사이즈 하한이 잘림을 막는다).
  const { applyHomeWidgetSizes } = require('../public/app.js');
  assert.strictEqual(applyHomeWidgetSizes({ mdedit: { w: 1, h: 10 } }).mdedit.h, minH, '최소 높이로 상향 클램프');
});

/* ───── 반응형 CSS(@container hw — 위젯 자신의 폭 기준) ───── */

test('6조합 — CSS: 카드는 hw-card, 본문은 hw-body(높이 지정 시 내부 스크롤로 흡수)', () => {
  assert.ok(/cls: 'md-card hw-card'/.test(mdSection()), '카드에 hw-card');
  assert.ok(/cls: 'md-main hw-body'/.test(mdSection()), '본문에 hw-body');
  // 헤더/문서바/푸터는 고정(flex: 0 0 auto) — 본문만 남는 높이를 먹는다.
  assert.ok(/\.md-head \{[^}]*flex: 0 0 auto/.test(CSS));
  assert.ok(/\.md-docs \{[^}]*flex: 0 0 auto/.test(CSS));
  assert.ok(/\.md-foot \{[^}]*flex: 0 0 auto/.test(CSS));
});

test('6조합 — CSS: 넓으면 2단, 좁으면 접는다 — 전부 @container hw(뷰포트 @media 아님)', () => {
  assert.ok(/\.md-card\[data-view="split"\] \.md-main \{ grid-template-columns: 1fr 1fr; \}/.test(CSS), '2단');
  // 좁아지면(≤560px) 2단을 세로 스택으로 — 세로가 넉넉한 1×2·1×3·1×4 에서 두 패널을 모두 살린다.
  assert.ok(/@container hw \(max-width: 560px\)[\s\S]*?grid-template-rows: minmax\(110px, 1fr\) minmax\(110px, 1fr\)/.test(CSS));
  // 세로도 최소(1행)면 편집만 — 상하 스택이 두 패널을 뭉개지 않게.
  assert.ok(/@container hw \(max-width: 560px\)[\s\S]*?\.home-section\[data-hrow="1"\] \.md-card\[data-view="split"\] \.md-pane--preview \{ display: none; \}/.test(CSS));
  // 극단적으로 좁으면(≤380px) 제목·메타·2단 토글을 접는다.
  assert.ok(/@container hw \(max-width: 380px\)[\s\S]*?\.md-seg__btn--split \{ display: none/.test(CSS));

  // MD 편집기 스타일에 뷰포트 미디어쿼리를 쓰지 않았는지 — @media 블록 안에 .md- 셀렉터가 없어야 한다.
  //   주석(설명문에 '@media' 라는 낱말이 나온다)은 먼저 걷어내고 본다.
  const cssCode = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
  const mediaBlocks = cssCode.match(/@media[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g) || [];
  for (const b of mediaBlocks) {
    assert.ok(!/\.md-/.test(b), 'MD 편집기 스타일은 뷰포트 @media 가 아니라 @container 로 반응해야 한다');
  }
});

test('6조합 — CSS: 어떤 조합에서도 콘텐츠가 카드 밖으로 새지 않는다(내부 스크롤/줄바꿈)', () => {
  // 높이를 줄이면 편집기·미리보기의 기본 최소높이 캡이 풀려 실제 높이에 반응한다.
  assert.ok(/\.home-section__content--sized \.md-editor,\s*\.home-section__content--sized \.md-preview \{ min-height: 0; \}/.test(CSS));
  assert.ok(/\.md-preview \{[^}]*overflow-y: auto/.test(CSS), '미리보기 내부 스크롤');
  assert.ok(/\.md-editor \{[^}]*overflow: auto/.test(CSS), '편집기 내부 스크롤');
  // 넓은 콘텐츠(코드·표·이미지·긴 URL)는 자기 안에서 흡수한다.
  assert.ok(/\.md-pre \{[^}]*overflow-x: auto/.test(CSS), '코드블록 가로 스크롤');
  assert.ok(/\.md-tablewrap \{ overflow-x: auto/.test(CSS), '표 가로 스크롤');
  assert.ok(/\.md-img \{ max-width: 100%/.test(CSS), '이미지 축소');
  assert.ok(/\.md-rendered \{[^}]*overflow-wrap: anywhere/.test(CSS), '긴 URL 줄바꿈');
  // 문서 바는 세로로 쌓지 않고 가로 스크롤 — 높이를 편집 영역에 양보.
  assert.ok(/\.md-docs \{[^}]*overflow-x: auto/.test(CSS));
});

test('6조합 — §3 코너 규약: 위젯 우하단을 점유하는 상시 컨트롤 없음(리사이즈 핸들과 충돌 금지)', () => {
  assert.ok(!/\.md-[a-z-]*\s*\{[^}]*position: absolute[^}]*bottom: 0[^}]*right: 0/.test(CSS), '우하단 고정 컨트롤 금지');
  assert.ok(/\.md-tools \{/.test(CSS), '액션은 상단 툴바');
  // 편집기 자체 리사이저(우하단 그립)도 끈다 — .home-resize 와 충돌한다.
  assert.ok(/\.md-editor \{[^}]*resize: none/.test(CSS), 'textarea 기본 리사이저 비활성');
});

/* ───── 편집 UX 배선 ───── */

test('MD-1 — 편집 중 전체 render() 를 부르지 않는다(textarea 캐럿 유실 방지)', () => {
  const code = mdCode();
  const fn = code.slice(code.indexOf('function mdOnInput'), code.indexOf('function mdSaveNow'));
  assert.ok(!/\brender\(\)/.test(fn), 'mdOnInput 은 전체 render 를 부르지 않는다');
  assert.ok(/mdUpdatePreview\(iid\)/.test(fn), '미리보기만 부분 갱신(그 인스턴스의 것만)');
  assert.ok(/setTimeout\(/.test(fn), '디바운스 자동 저장');
});

test('MD-1 — 문서 전환·내보내기 전에 미저장 변경을 확정 저장한다(유실 방지)', () => {
  const code = mdCode();
  assert.ok(/await mdFlushSave\(iid\)/.test(code.slice(code.indexOf('function mdOpenDoc'))), '문서 전환 전 flush');
  assert.ok(/await mdFlushSave\(iid\)/.test(code.slice(code.indexOf('function mdExportDoc'))), '내보내기 전 flush');
  assert.ok(/blur: function \(\) \{ mdFlushSave\(iid\); \}/.test(code), '포커스 이탈 시 flush');
});

test('위젯 인스턴스 — 편집기 2개가 서로 다른 문서를 연다(부분 갱신은 그 셀 안에서만)', () => {
  const code = mdCode();
  // 열린 문서·본문·뷰 모드는 인스턴스별(wstate). 전역 store.mdedit 은 '문서 목록'만 공유한다.
  assert.ok(/var st = wstate\(iid\)/.test(code), '인스턴스별 상태(wstate)를 쓴다');
  assert.ok(!/store\.mdedit\.activeId/.test(code), '열린 문서는 전역 슬롯이 아니다');
  assert.ok(/store\.mdedit\.docs/.test(code), '문서 목록은 전역 공유(하나의 라이브러리)');
  // document 전역 조회 금지 — 편집기가 여럿이면 첫 셀만 고쳐 나머지가 멈춘 화면으로 남는다.
  const patchFns = code.slice(code.indexOf('function mdUpdatePreview'), code.indexOf('function mdInlineNodes'));
  assert.ok(!/document\.querySelector/.test(patchFns), '부분 갱신에 document 전역 조회 금지');
  assert.ok(/cellQuery\(iid,/.test(patchFns), '그 인스턴스의 셀 안에서만 찾는다');
});

test('MD-1 — 편집 모드 재정렬 드래그(SortableJS)와 분리(pointerdown stopPropagation)', () => {
  const code = mdCode();
  assert.ok(/pointerdown: function \(e\) \{ e\.stopPropagation\(\); \}/.test(code),
    'SortableJS 드래그가 편집기/문서칩 조작을 삼키지 않도록 분리');
});

test('MD-1 — textarea 본문은 value 프로퍼티로 넣는다(setAttribute 는 개행을 깨뜨린다)', () => {
  assert.ok(/ta\.value = st\.body;/.test(mdSection()), 'value 프로퍼티 대입(인스턴스별 본문)');
});

/* ───── 파서 로드 ───── */

test('MD-1 — 파서는 app.js 보다 먼저 로드되고, 미로드 환경에서도 죽지 않는다', () => {
  const scripts = HTML.match(/<script src="\.\/([\w.-]+)\.js"/g) || [];
  const order = scripts.map((s) => /src="\.\/([\w.-]+)\.js"/.exec(s)[1]);
  assert.ok(order.indexOf('markdown') >= 0, 'index.html 이 markdown.js 를 로드');
  assert.ok(order.indexOf('markdown') < order.indexOf('app'), 'app.js 보다 먼저');
  // 전역 부재(테스트·웹)에서도 app.js 가 죽지 않게 지연 참조한다.
  assert.ok(/function mdParser\(\) \{ return \(typeof SpipMarkdown !== 'undefined'\)/.test(APP_SRC),
    '파서 전역은 지연 참조(top-level 참조 금지)');
});
