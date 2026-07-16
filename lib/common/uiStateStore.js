'use strict';
/**
 * lib/common/uiStateStore.js — UI 상태(즐겨찾기·순서·정렬모드) 저장소 (R-19/R-20, M6-M-4)
 *
 * ui-state.json = { schemaVersion, favorites:[id], order:[id], sortMode:'auto'|'manual' }.
 * GUI 전용(CLI 무관). 손상/부재 시 graceful 빈 상태. 0600 원자적 쓰기.
 *
 * [M6-M-4] read() DoS/손상 방어:
 *   ① 파싱 전 파일 크기 상한(1MB) → 초과 즉시 기본값
 *   ② raw 길이 재확인(symlink·경합 대비)
 *   ③ _safeParse(JSON 깊이/예외 가드, H-3 패턴 재사용) → 실패 시 null
 *   ④ normalizeState로 id 형식·배열 길이 상한·중복 제거·sortMode 화이트리스트·schemaVersion 폴백
 *   어떤 실패든 graceful 빈 상태(DEFAULT_STATE clone), 0600 유지.
 *
 * 외부 의존성 0 — fs, path + 내부(paths). 순수 검증 로직(normalizeState 등)은 fs 없이 단위테스트.
 */

const fs = require('fs');
const path = require('path');
const paths = require('./paths');
const elevationState = require('./elevationState');

// [SH-1 P1] schemaVersion — 신규 위젯 도입 시 승격. 레거시(구버전/부재) state는 normalizeState가
//   그 버전 이후 도입된 위젯을 hiddenWidgets에 union(기본 숨김 — 기존 사용자 갑툭튀 방지)한다.
//   v2: 셸프(shelf/shelfWide). v3: 스크래치패드 메모(scratchpad). v4: 폴더 탐색기(explorer).
//   v5: 마크다운 편집기(mdedit). NEW_HIDDEN_SINCE 단일 출처.
//
// [위젯 인스턴스] v6: 배치 단위가 '타입'에서 '인스턴스'로 바뀌었다 — homeLayout(타입 순열) +
//   hiddenWidgets(숨김 집합) → homeWidgets([{iid,type,name}]). 같은 위젯을 여러 개 배치할 수 있고,
//   배치마다 이름을 붙일 수 있다. NEW_HIDDEN_SINCE/unionNewHidden 은 이제 **v5 이하 이행 경로 전용**이다
//   (v6 부터 신규 위젯 타입은 '기본 숨김'이 아니라 '기본 미배치' — 갤러리에서 추가해야 생긴다).
const SCHEMA_VERSION = 6;
const MAX_UISTATE_BYTES = 1 * 1024 * 1024; // 1MB 상한(M6-M-4)
const MAX_JSON_DEPTH = 32;
const MAX_FAVORITES = 512;
const MAX_ORDER = 4096; // order는 favorites보다 클 수 있음(전체 카드 순서)
const MAX_NAMES = 4096; // 별칭 항목 수 상한
const MAX_NAME_LEN = 120; // 별칭 길이 상한
const MAX_TODOS = 200; // 할 일 항목 수 상한
const MAX_TODO_LEN = 500; // 할 일 텍스트 길이 상한
const MAX_SCRATCHPAD = 8000; // [로드맵 Phase 3·G] 스크래치패드 메모 길이 상한(개행 포함)
const FILE_MODE = 0o600;

const ID_RE = /^[0-9a-f]{1,64}$/; // 스냅샷 id 형태(경로 해시)
const TODO_ID_RE = /^t[0-9a-f]{6,32}$/; // 할 일 id(메인에서 생성)
// [M13 R-38] 브리핑 항목 키(briefingItems.itemKey = sha256 32 hex)·길이 상한.
//   주: lib/ai/briefingConst(MAX_ITEMS·PARSE_*_MAX)와 의도적으로 같은 값을 영속 경계에서 독립 정의한다 —
//   uiStateStore는 lib/ai에 의존하지 않는 영속 신뢰 경계(공격자 입력 정규화)라 자기완결적 상수를 둔다.
//   값이 갈리면 더 작은 쪽이 효과적 상한이 되며 안전엔 영향 없음(둘 다 표시·저장 상한).
const BRIEFING_KEY_RE = /^[0-9a-f]{1,64}$/;
const MAX_BRIEFING_ITEMS = 200;
const MAX_BRIEFING_TITLE = 200;
const MAX_BRIEFING_REASON = 500;
const MAX_BRIEFING_GUIDE = 1600; // 상세 가이드 허용(briefingConst.PARSE_GUIDE_MAX와 동급)
const BRIEFING_STATUSES = new Set(['open', 'done', 'dismissed']);
const BRIEFING_CATEGORIES = new Set(['must', 'good', 'urgent']);
const BRIEFING_SIGNAL_MAX = 32;
const SORT_MODES = new Set(['auto', 'manual']);
// [포스트잇 테마] 코르크보드+스티키노트 홈 스킨('postit'). data-theme 값으로 직접 적용(system 해석 대상 아님).
const THEMES = new Set(['light', 'dark', 'system', 'postit']);
// [로드맵 Phase 1·J] 테마 개인화 — 액센트 색상·UI 배율(밀도/폰트 대체). 전역 스코프. CSS 변수/zoom 으로 적용.
const THEME_ACCENTS = new Set(['indigo', 'blue', 'violet', 'emerald', 'rose', 'amber']);
const UI_SCALES = new Set(['compact', 'normal', 'comfortable', 'large']);

// [SH-1] 셸프 북마크(shelfBookmarks) 영속 정규화 상한·형식. 영속본은 bannerImage 대신 bannerKey만 보관.
const MAX_SHELF = 64; // 셸프 항목 수 상한(PM 확정)
const SHELF_ID_RE = /^b[0-9a-f]{6,32}$/; // 'b'+6~32 hex(main crypto 생성)
const SHELF_TYPES = new Set(['url', 'folder', 'file']);
const SHELF_COLOR_RE = /^#[0-9a-fA-F]{6}$/; // '#RRGGBB'만
const SHELF_BANNER_KEY_RE = /^[0-9a-f]{16,64}$/; // sha256 등 hex 키 또는 null
const MAX_SHELF_REF = 4096; // ref(url/실경로) 길이 상한
const MAX_SHELF_NAME = 120;
const MAX_SHELF_TITLE = 200;
const MAX_SHELF_SUB = 200;
const MAX_SHELF_DESC = 500;
const MAX_SHELF_MONO = 4;
const MAX_SHELF_CAT = 32;
const MAX_SHELF_STATUS = 80;
const SHELF_DEFAULT_COLOR = '#57534e';

const MAX_LANG_ENTRIES = 64;

// [R-32] 홈 섹션 순서 화이트리스트(고정 enum). 실행/경로/해시 의미 없는 표시 메타.
//   renderHome()이 그리는 7섹션과 1:1 일치(public/app.js: attention/productivity/activity/
//   todos/mail/disk/featureAdd). featureAdd 포함(설계 Q-A 기본). 배열 순서 = 기본(하드코딩) 순서.
// [SH-1] 셸프 위젯 2 변형(shelf=일반 컬럼·shelfWide=전체폭 스팬)을 enum에 추가. app.js와 동형 유지.
// [로드맵 Phase 3·G] 스크래치패드(scratchpad)·통합 커밋 히트맵(commitHeatmap)·시스템 상태(systemStatus) 위젯 추가 —
//   featureAdd 앞. app.js HOME_SECTION_IDS와 동형(드리프트 테스트).
// [탐색기 위젯] 폴더 탐색기(explorer) 추가 — 표시 메타일 뿐 경로 의미 없음(경로 게이트는 browsePolicy).
// [MD 편집기 위젯] 마크다운 편집기(mdedit) 추가 — 표시 메타일 뿐(문서 본문은 mdDocStore 가 별도 영속).
// [브리핑 분리] 상단 고정 히어로를 위젯으로 분리 — 'briefing'(인사말+AI 브리핑)·'summary'(KPI 4) 를 맨 앞에.
const HOME_SECTION_IDS = ['briefing', 'summary', 'attention', 'productivity', 'activity', 'todos', 'mail', 'disk', 'aiusage', 'shelf', 'shelfWide', 'scratchpad', 'commitHeatmap', 'systemStatus', 'explorer', 'mdedit', 'agent', 'featureAdd'];
const HOME_SECTION_SET = new Set(HOME_SECTION_IDS);

// [SH-1 P1] schemaVersion<2 이행 시 기본 숨김할 셸프 위젯(레거시 사용자 기본 비노출). 테스트 참조로 유지.
const SHELF_WIDGET_IDS = ['shelf', 'shelfWide'];

// [SH-1 PM#3 / 로드맵 Phase 3·G] 신규 위젯 도입 버전 → 그 미만(또는 부재) 사용자에게 기본 숨김할 위젯.
//   신규 설치 시드(DEFAULT_HIDDEN_WIDGETS)와 레거시 이행(union)이 동일 집합을 단일 출처로 공유 →
//   신규/기존 사용자 동작 정합(사용자가 갤러리에서 opt-in). 이미 노출 결정한 위젯은 재숨김하지 않음(멱등).
const NEW_HIDDEN_SINCE = [
  { since: 2, ids: SHELF_WIDGET_IDS },                 // v2: 셸프 2변형
  { since: 3, ids: ['scratchpad', 'commitHeatmap', 'systemStatus'] },  // v3: 스크래치패드 · 커밋 히트맵 · 시스템 상태
  { since: 4, ids: ['explorer'] },                     // v4: 폴더 탐색기(열람 루트 등록 전엔 빈 상태)
  { since: 5, ids: ['mdedit'] },                       // v5: 마크다운 편집기(문서 만들기 전엔 빈 상태)
  { since: 6, ids: ['briefing', 'summary', 'agent'] }, // v6: 히어로 분리(오늘의 브리핑·요약 지표) + Agent 위젯 — 갤러리에서 추가
];
const DEFAULT_HIDDEN_WIDGETS = NEW_HIDDEN_SINCE.reduce((acc, e) => acc.concat(e.ids), []);

/**
 * [R-32] 홈 섹션 순서 정규화 — 단일 신뢰 경계.
 *   화이트리스트(HOME_SECTION_IDS) 외 id 제거, 중복 제거, 누락 섹션은 기본 순서로 자동 보충(끝).
 *   비배열/손상 입력은 graceful — 전부 기본 순서로 복원. 향후 섹션 추가 시 저장값에 자동 합류(마이그레이션 프리).
 *   고정 enum이 길이 상한 역할(별도 상한 불요).
 * @param {*} input
 * @returns {string[]} HOME_SECTION_IDS의 순열(항상 7개)
 */
function normalizeHomeLayout(input) {
  const out = [];
  const seen = new Set();
  if (Array.isArray(input)) {
    for (const id of input) {
      if (typeof id !== 'string' || !HOME_SECTION_SET.has(id) || seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
  }
  for (const id of HOME_SECTION_IDS) if (!seen.has(id)) out.push(id); // 누락 섹션 기본 순서로 보충
  return out;
}

// [위젯 추가/제거] 토글 가능한 콘텐츠 위젯(=HOME_SECTION_IDS에서 'featureAdd' 제외 — featureAdd는 추가 트리거라 항상 표시).
//   [위젯 인스턴스] 이제 이 배열은 '배치 가능한 위젯 **타입**'의 고정 enum이다(배치 단위는 인스턴스).
const TOGGLEABLE_WIDGET_IDS = HOME_SECTION_IDS.filter((id) => id !== 'featureAdd');
const TOGGLEABLE_WIDGET_SET = new Set(TOGGLEABLE_WIDGET_IDS);

/* ── [위젯 인스턴스 · v6] 같은 위젯을 여러 개 배치 + 배치별 이름 ─────────────────────────────
 *
 * v5 까지 배치 단위는 '위젯 타입 id'였다 — homeLayout(타입 순열) + hiddenWidgets(숨김 집합)로
 * "어떤 타입이 몇 번째에 보이는가"만 표현할 수 있었고, 같은 타입을 둘 놓으면 크기·좌표·그룹이
 * 서로를 덮어썼다(키가 타입 하나뿐이라).
 *
 * v6 부터 배치 단위는 **인스턴스**다: homeWidgets = [{ iid, type, name }].
 *   · 배열 순서 = 배치 순서. 목록에 없으면 미배치(= 옛 '숨김'). 같은 type 이 여러 번 올 수 있다.
 *   · iid 는 sizes/positions/groups.members 의 키다 — 그래서 인스턴스마다 크기·좌표·그룹이 독립한다.
 *   · name 은 사용자 지정 표시명. 빈 문자열이면 렌더러가 타입 기본명을 쓴다.
 *
 * 이행(v5 → v6): 레거시 **타입 id 를 그대로 첫 인스턴스의 iid 로 승격**한다('mdedit' → iid 'mdedit').
 *   그래서 기존 sizes/positions/groups 의 키를 하나도 바꾸지 않고 배치가 무손실로 넘어온다.
 *   두 번째 인스턴스부터 'w1', 'w2' … 를 발급한다(nextWidgetIid — 결정적, 무작위성 배제).
 */
const IID_RE = /^[a-z][a-zA-Z0-9]{0,31}$/; // 레거시 타입 id('mdedit')도 그대로 만족 → 승격 가능
const MAX_WIDGETS = 48;      // 프리셋당 배치 위젯 인스턴스 상한
const MAX_WIDGET_NAME = 40;  // 배치별 표시명 길이 상한

/**
 * [위젯 인스턴스] homeWidgets 정규화 — 단일 신뢰 경계.
 *   형태: [{ iid, type, name }]. iid 형식·중복 제거, type 은 고정 enum(TOGGLEABLE_WIDGET_IDS)만,
 *   name 은 sanitize + 길이 상한, 개수 상한. 비배열/손상 입력은 [](graceful).
 *   iid 공간은 그룹 id(GROUP_ID_RE)와 겹치지 않는다 — 둘 다 sizes/positions 의 키라 충돌하면 안 된다.
 * @param {*} input
 * @returns {Array<{iid:string,type:string,name:string}>}
 */
function normalizeHomeWidgets(input) {
  const out = [];
  const seen = new Set();
  if (!Array.isArray(input)) return out;
  for (const w of input) {
    if (out.length >= MAX_WIDGETS) break;
    if (!isPlainObject(w)) continue;
    const iid = (typeof w.iid === 'string' && IID_RE.test(w.iid)) ? w.iid : null;
    if (!iid || seen.has(iid) || GROUP_ID_RE.test(iid)) continue; // 그룹 id 공간 침범 금지
    if (typeof w.type !== 'string' || !TOGGLEABLE_WIDGET_SET.has(w.type)) continue; // 타입은 고정 enum
    seen.add(iid);
    out.push({ iid, type: w.type, name: sanitizeBriefingText(w.name, MAX_WIDGET_NAME) });
  }
  return out;
}

/** 미사용 인스턴스 id 발급 — 'w'+최소 정수(base36). 결정적(무작위성 배제 — 정규화 멱등성 보존). */
function nextWidgetIid(widgets) {
  const used = new Set((Array.isArray(widgets) ? widgets : []).map((w) => w && w.iid));
  let n = 1;
  while (used.has('w' + n.toString(36))) n++;
  return 'w' + n.toString(36);
}

/** 신규 설치 기본 배치 — 기본 숨김 위젯을 제외한 타입 각 1개(타입 id 를 iid 로). */
function defaultHomeWidgets() {
  const hidden = new Set(DEFAULT_HIDDEN_WIDGETS);
  return TOGGLEABLE_WIDGET_IDS
    .filter((t) => !hidden.has(t))
    .map((t) => ({ iid: t, type: t, name: '' }));
}

/**
 * [v5 → v6 이행] 레거시 layout(타입 순열) + hidden(숨김 집합) → 인스턴스 목록.
 *   표시 중이던 타입만, 레거시 순서대로, **타입 id 를 iid 로 승격**(sizes/positions/groups 키 무손실).
 * @param {string[]} layout normalizeHomeLayout 결과
 * @param {string[]} hidden normalizeHiddenWidgets 결과(unionNewHidden 적용 후)
 * @returns {Array<{iid:string,type:string,name:string}>}
 */
function migrateLegacyWidgets(layout, hidden) {
  const hiddenSet = new Set(Array.isArray(hidden) ? hidden : []);
  const out = [];
  for (const type of (Array.isArray(layout) ? layout : [])) {
    if (type === 'featureAdd') continue;       // 추가 카드는 인스턴스가 아니다(렌더러가 항상 끝에 그린다)
    if (!TOGGLEABLE_WIDGET_SET.has(type)) continue;
    if (hiddenSet.has(type)) continue;         // 숨김이었으면 미배치
    out.push({ iid: type, type, name: '' });
  }
  return out;
}

/**
 * 프리셋/상태에서 위젯 인스턴스 목록을 얻는다 — v6 필드가 있으면 그대로, 없으면 레거시에서 이행.
 *   v6 필드명이 최상위 상태('homeWidgets')와 프리셋('widgets')에서 다르므로 키를 인자로 받는다.
 * @param {object} o 상태 또는 프리셋
 * @param {number|undefined} inputVer 저장된 schemaVersion(부재=최고참 레거시)
 * @param {{key:string, layoutKey:string, hiddenKey:string}} keys 필드명
 */
function resolveHomeWidgets(o, inputVer, keys) {
  if (Array.isArray(o[keys.key])) return normalizeHomeWidgets(o[keys.key]);
  // 배치 정보가 아예 없다(v6 키도, 레거시 키도) → 신규 설치 기본 배치.
  //   ⚠️ 이 분기가 없으면 v6 상태에서 배치 키가 빠졌을 때 unionNewHidden 이 no-op(이미 아는 버전)이라
  //     '모든 타입이 배치된' 상태로 복구돼 버린다(기본 숨김 위젯까지 갑툭튀).
  if (!Array.isArray(o[keys.layoutKey]) && !Array.isArray(o[keys.hiddenKey])) return defaultHomeWidgets();
  const layout = normalizeHomeLayout(o[keys.layoutKey]);
  // 저장된 버전 이후 도입된 위젯은 '숨김'으로 간주 → 미배치(기존 사용자에게 갑툭튀 금지). v6 부터는
  //   신규 타입이 그냥 인스턴스로 만들어지지 않으므로 이 union 은 이행 경로에서만 쓰인다.
  const hidden = unionNewHidden(normalizeHiddenWidgets(o[keys.hiddenKey]), inputVer);
  return migrateLegacyWidgets(layout, hidden);
}

/**
 * [위젯 추가/제거] 숨긴(미적용) 위젯 집합 정규화 — 토글 가능 위젯 화이트리스트만, 중복 제거.
 *   homeLayout(순서)와 직교: 표시 = homeLayout에 있고 hidden이 아닌 위젯. featureAdd는 숨길 수 없다.
 *   비배열/손상 입력은 빈 집합(graceful — 전부 표시). 고정 enum이 길이 상한 역할.
 * @param {*} input
 * @returns {string[]} TOGGLEABLE_WIDGET_IDS의 부분집합
 */
function normalizeHiddenWidgets(input) {
  const out = [];
  const seen = new Set();
  if (Array.isArray(input)) {
    for (const id of input) {
      if (typeof id !== 'string' || !TOGGLEABLE_WIDGET_SET.has(id) || seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

// [홈 위젯 크기] 폭(열 스팬)·높이(px) 상한/하한. homeLayout(순서)·hiddenWidgets(표시)와 직교인 별도 필드.
const HOME_MAX_COLS = 4;   // 폭 스팬 상한(홈 레이아웃 반응형 최대 열 수와 일치)
const HOME_H_MIN = 120;    // 사용자 지정 높이 하한(px)
const HOME_H_MAX = 1600;   // 상한(px) — 비정상 값 방어

/**
 * [홈 위젯 크기] homeWidgetSizes 정규화 — 단일 신뢰 경계.
 *   형태: { [iid]: { w, h } }.
 *   w = [1, HOME_MAX_COLS] 정수(열 스팬). h = [HOME_H_MIN, HOME_H_MAX] 정수 또는 null(자동 높이).
 *   손상/미지 항목은 제거. homeWidgets(배치·순서·이름)와 직교 — 리사이즈만 관장.
 *
 * [위젯 인스턴스] 키는 **배치된 인스턴스 id**(+ 그룹 id)만 허용한다 — 타입 화이트리스트가 아니다.
 *   그래서 같은 타입 위젯 두 개가 각자의 크기를 갖는다. 배치에서 사라진 iid 의 크기는 여기서 정리된다.
 * @param {*} input
 * @param {Set<string>} [allowed] 배치된 iid 집합(미전달 시 iid 형식만 검사 — 순서 의존 회피용 폴백)
 * @returns {Object<string,{w:number,h:(number|null)}>}
 */
function normalizeHomeWidgetSizes(input, allowed) {
  const out = {};
  if (!isPlainObject(input)) return out;
  for (const id of Object.keys(input)) {
    // [로드맵 Phase 5·M] 그룹 id(GROUP_ID_RE)도 허용 — 프리폼에서 그룹 블록 폭 조절. 그 외 미지 id 제거.
    //   featureAdd(추가 카드)는 리사이즈 대상이 아니다 — iid 형식은 만족하지만 명시 제외.
    if (id === 'featureAdd') continue;
    const okId = GROUP_ID_RE.test(id) || (allowed ? allowed.has(id) : IID_RE.test(id));
    if (!okId) continue;
    const v = input[id];
    if (!isPlainObject(v)) continue;
    let w = Number(v.w);
    w = Number.isFinite(w) ? Math.min(HOME_MAX_COLS, Math.max(1, Math.round(w))) : 1;
    let h = null;
    if (v.h !== null && v.h !== undefined) {
      const hn = Number(v.h);
      if (Number.isFinite(hn)) h = Math.min(HOME_H_MAX, Math.max(HOME_H_MIN, Math.round(hn)));
    }
    out[id] = { w, h };
  }
  return out;
}

// ── [대시보드 자유도 로드맵 · Phase 0] 통합 대시보드 상태 모델(프리셋) ─────────────────────
//   기존 homeLayout/hiddenWidgets/homeWidgetSizes 를 '프리셋' 단위로 감싸 다중 대시보드/모드를 수용한다.
//   ⚠️ 이 계층은 아직 read/write 영속 경로에 연결되지 않은 '순수 정규화'다(하위 호환: 런타임 동작 불변).
//   레거시(단일 레이아웃) → 프리셋 무손실 이행은 migrateLegacyToDashboard 가 담당. layout/hidden/sizes 는
//   기존 단일 신뢰 경계(normalizeHomeLayout/…)를 재사용해 정규화 출처를 이원화하지 않는다.
const DASHBOARD_SCHEMA_VERSION = 1;
const MAX_PRESETS = 12;            // 대시보드(모드) 개수 상한
const MAX_PRESET_NAME = 40;        // 프리셋 표시명 길이 상한
const PRESET_ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/; // 슬러그(소문자·숫자·_-, 1~32)
const LAYOUT_MODES = new Set(['masonry', 'freeform']);
const MAX_POS = 200;               // 프리폼 좌표(그리드 셀) 상한 — 비정상 값 방어
const DEFAULT_PRESET_ID = 'default';
// [로드맵 Phase 5·M/F] 그룹/섹션·스택 — { id, name, collapsed, members[], mode, active }. 위젯은 한 그룹에만 소속.
//   mode='section'(전체폭 밴드·모두 표시)|'stack'(한 자리 겹침·active 하나만 표시·로테이션). active=표시 인덱스.
const GROUP_ID_RE = /^g[0-9a-z]{4,32}$/; // 'g'+영숫자(렌더러 생성, main 검증)
const MAX_GROUPS = 12;             // 프리셋당 그룹 상한
const MAX_GROUP_NAME = 60;
const GROUP_MODES = new Set(['section', 'stack']);

/** [로드맵 Phase 5·M/F] 그룹 배열 정규화(순수·신뢰 경계) — id 형식·중복 제거·이름 sanitize·members(배치된
 *   위젯 인스턴스, 그룹 간 유일·그룹 내 중복 제거)·collapsed bool·mode(section|stack)·active(멤버 범위 클램프)·개수 상한.
 *   [위젯 인스턴스] members 는 **iid**다 — 같은 타입 위젯 둘 중 하나만 그룹에 넣을 수 있다.
 *   graceful []. @param {Set<string>} [allowed] 배치된 iid 집합 */
function normalizeGroups(input, allowed) {
  if (!Array.isArray(input)) return [];
  const out = [];
  const seenIds = new Set();
  const claimed = new Set(); // 한 위젯 인스턴스는 한 그룹에만
  for (const g of input) {
    if (out.length >= MAX_GROUPS) break;
    if (!isPlainObject(g)) continue;
    const id = (typeof g.id === 'string' && GROUP_ID_RE.test(g.id)) ? g.id : null;
    if (!id || seenIds.has(id)) continue;
    seenIds.add(id);
    const name = sanitizeBriefingText(g.name, MAX_GROUP_NAME) || '그룹';
    const collapsed = !!g.collapsed;
    const members = [];
    if (Array.isArray(g.members)) {
      for (const m of g.members) {
        // featureAdd(추가 카드)는 그룹 멤버가 될 수 없다 — iid 형식은 만족하지만 명시 제외.
        const okMember = typeof m === 'string' && m !== 'featureAdd'
          && (allowed ? allowed.has(m) : IID_RE.test(m));
        if (okMember && !claimed.has(m) && members.indexOf(m) < 0) { members.push(m); claimed.add(m); }
      }
    }
    const mode = (typeof g.mode === 'string' && GROUP_MODES.has(g.mode)) ? g.mode : 'section';
    let active = Number(g.active);
    active = (Number.isFinite(active) && active >= 0) ? Math.min(Math.floor(active), Math.max(0, members.length - 1)) : 0;
    out.push({ id, name, collapsed, members, mode, active });
  }
  return out;
}

/** [로드맵 Phase 5·B] 위젯 좌표 맵 정규화 — { [iid]: {x,y} }. x/y 정수 [0,MAX_POS].
 *   [위젯 인스턴스] 키는 배치된 iid + 그룹 id + 'featureAdd'(프리폼에서 추가 카드도 자유 배치).
 *   @param {Set<string>} [allowed] 배치된 iid 집합 */
function normalizeWidgetPositions(input, allowed) {
  const out = {};
  if (!isPlainObject(input)) return out;
  for (const id of Object.keys(input)) {
    // [로드맵 Phase 5·M] 배치된 위젯 + 그룹 id + featureAdd(추가 카드) 허용. 그 외 미지 키 제거.
    const okId = id === 'featureAdd' || GROUP_ID_RE.test(id) || (allowed ? allowed.has(id) : IID_RE.test(id));
    if (!okId) continue;
    const v = input[id];
    if (!isPlainObject(v)) continue;
    const x = Number(v.x); const y = Number(v.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    out[id] = { x: Math.min(MAX_POS, Math.max(0, Math.round(x))), y: Math.min(MAX_POS, Math.max(0, Math.round(y))) };
  }
  return out;
}

/**
 * 단일 프리셋 정규화 — id(슬러그)·name·widgets·sizes·positions·layoutMode·groups.
 *   [위젯 인스턴스 v6] layout(타입 순열)+hidden(숨김) → widgets([{iid,type,name}]) 로 대체됐다.
 *   레거시 프리셋(layout/hidden 만 있는)은 여기서 인스턴스로 이행한다(타입 id → iid 승격).
 *   sizes/positions/groups 는 **배치된 iid 집합**을 기준으로 정규화된다 — 배치에서 사라진 위젯의
 *   잔여 크기·좌표·그룹 소속은 여기서 정리된다(고아 키 0).
 * @param {*} input 프리셋 후보
 * @param {string} fallbackId id 손상 시 대체 id(호출측이 유일성 보장)
 * @param {number|undefined} [inputVer] 저장된 schemaVersion — 레거시 이행 시 '신규 위젯 미배치' 판정에 쓴다
 */
function normalizePreset(input, fallbackId, inputVer) {
  const o = isPlainObject(input) ? input : {};
  const id = (typeof o.id === 'string' && PRESET_ID_RE.test(o.id)) ? o.id : fallbackId;
  const name = sanitizeBriefingText(o.name, MAX_PRESET_NAME) || '대시보드';
  const layoutMode = (typeof o.layoutMode === 'string' && LAYOUT_MODES.has(o.layoutMode)) ? o.layoutMode : 'masonry';
  const widgets = resolveHomeWidgets(o, inputVer, { key: 'widgets', layoutKey: 'layout', hiddenKey: 'hidden' });
  const allowed = new Set(widgets.map((w) => w.iid));
  return {
    id,
    name,
    widgets,
    sizes: normalizeHomeWidgetSizes(o.sizes, allowed),
    positions: normalizeWidgetPositions(o.positions, allowed),
    layoutMode,
    groups: normalizeGroups(o.groups, allowed), // [로드맵 Phase 5·M] 그룹/섹션 노드
  };
}

/** 기본 프리셋 1개(신규 설치 기본 배치)로 구성된 기본 대시보드 상태. */
function defaultDashboardState() {
  return {
    schemaVersion: DASHBOARD_SCHEMA_VERSION,
    activePreset: DEFAULT_PRESET_ID,
    presets: [{
      id: DEFAULT_PRESET_ID, name: '기본',
      widgets: defaultHomeWidgets(),
      sizes: {},
      positions: {},
      layoutMode: 'masonry',
      groups: [],
    }],
  };
}

/**
 * 통합 대시보드 상태 정규화 — 단일 신뢰 경계.
 *   presets>=1(빈/손상 → 기본), id 중복 제거·개수 상한(MAX_PRESETS), activePreset 은 실재 프리셋 참조
 *   (dangling 이면 첫 프리셋). 비객체/presets 비배열 입력은 graceful 기본 상태.
 * @param {*} input
 * @returns {{schemaVersion:number,activePreset:string,presets:Array}}
 */
function normalizeDashboardState(input, inputVer) {
  if (!isPlainObject(input) || !Array.isArray(input.presets)) return defaultDashboardState();
  const presets = [];
  const seen = new Set();
  for (let i = 0; i < input.presets.length; i++) {
    if (presets.length >= MAX_PRESETS) break;
    const p = normalizePreset(input.presets[i], 'p' + i, inputVer);
    if (seen.has(p.id)) continue; // id 중복 제거(첫 항목 우선)
    seen.add(p.id);
    presets.push(p);
  }
  if (presets.length === 0) return defaultDashboardState();
  let activePreset = (typeof input.activePreset === 'string') ? input.activePreset : '';
  if (!presets.some((p) => p.id === activePreset)) activePreset = presets[0].id;
  return { schemaVersion: DASHBOARD_SCHEMA_VERSION, activePreset, presets };
}

/**
 * 레거시 단일 레이아웃 상태 → 대시보드(프리셋 1개) 무손실 이행.
 *   legacy = { homeWidgets(v6) 또는 homeLayout/hiddenWidgets(v5 이하), homeWidgetSizes }.
 *   기존 사용자의 배치·크기를 '기본' 프리셋으로 승격한다(정보 손실 0).
 * @param {*} legacy
 * @param {number|undefined} [inputVer] 저장된 schemaVersion — v5 이하 이행 시 신규 위젯 미배치 판정에 쓴다
 * @returns {{schemaVersion:number,activePreset:string,presets:Array}}
 */
function migrateLegacyToDashboard(legacy, inputVer) {
  const o = isPlainObject(legacy) ? legacy : {};
  const widgets = resolveHomeWidgets(o, inputVer, { key: 'homeWidgets', layoutKey: 'homeLayout', hiddenKey: 'hiddenWidgets' });
  const allowed = new Set(widgets.map((w) => w.iid));
  return {
    schemaVersion: DASHBOARD_SCHEMA_VERSION,
    activePreset: DEFAULT_PRESET_ID,
    presets: [{
      id: DEFAULT_PRESET_ID, name: '기본',
      widgets,
      sizes: normalizeHomeWidgetSizes(o.homeWidgetSizes, allowed),
      positions: {},
      layoutMode: 'masonry',
      groups: [],
    }],
  };
}

// ── [로드맵 Phase 2 기반] 프리셋 CRUD (순수·결정적 — 렌더러가 소비해 IPC 로 영속) ──────────
/** 미사용 프리셋 id 생성(결정적·무작위성 배제 — write 캐시/리줌 안전) — 'p'+최소 정수(base36). */
function nextPresetId(presets) {
  const used = new Set(presets.map((p) => p.id));
  let n = 1;
  while (used.has('p' + n.toString(36))) n++;
  return 'p' + n.toString(36);
}

/** 프리셋 추가 — 새 기본 배치 프리셋을 끝에 추가하고 활성으로 지정. {state,id}. 상한 초과 시 id=null·무변경. */
function presetAdd(state, name) {
  const s = normalizeDashboardState(state);
  if (s.presets.length >= MAX_PRESETS) return { state: s, id: null };
  const id = nextPresetId(s.presets);
  const preset = { id, name: sanitizeBriefingText(name, MAX_PRESET_NAME) || '새 대시보드', widgets: defaultHomeWidgets(), sizes: {}, positions: {}, layoutMode: 'masonry', groups: [] };
  return { state: { schemaVersion: DASHBOARD_SCHEMA_VERSION, activePreset: id, presets: s.presets.concat([preset]) }, id };
}

/** 프리셋 복제 — 대상을 복사(새 id)해 뒤에 삽입, 활성으로 지정. 없거나 상한이면 id=null·무변경. */
function presetDuplicate(state, id) {
  const s = normalizeDashboardState(state);
  const idx = s.presets.findIndex((p) => p.id === id);
  if (idx < 0 || s.presets.length >= MAX_PRESETS) return { state: s, id: null };
  const src = s.presets[idx];
  const nid = nextPresetId(s.presets);
  const copy = normalizePreset(Object.assign({}, src, { id: nid, name: (src.name + ' 복사').slice(0, MAX_PRESET_NAME) }), nid);
  const presets = s.presets.slice();
  presets.splice(idx + 1, 0, copy);
  return { state: { schemaVersion: DASHBOARD_SCHEMA_VERSION, activePreset: nid, presets }, id: nid };
}

/** 프리셋 이름 변경(빈 이름은 무시). */
function presetRename(state, id, name) {
  const s = normalizeDashboardState(state);
  const presets = s.presets.map((p) => p.id === id ? Object.assign({}, p, { name: sanitizeBriefingText(name, MAX_PRESET_NAME) || p.name }) : p);
  return { schemaVersion: DASHBOARD_SCHEMA_VERSION, activePreset: s.activePreset, presets };
}

/** 프리셋 삭제 — 최소 1개 보장(마지막은 삭제 불가). 활성 삭제 시 인접으로 이동. */
function presetRemove(state, id) {
  const s = normalizeDashboardState(state);
  if (s.presets.length <= 1) return s; // 마지막 프리셋 보존
  const idx = s.presets.findIndex((p) => p.id === id);
  if (idx < 0) return s;
  const presets = s.presets.slice(); presets.splice(idx, 1);
  let active = s.activePreset;
  if (active === id) active = presets[Math.min(idx, presets.length - 1)].id;
  return { schemaVersion: DASHBOARD_SCHEMA_VERSION, activePreset: active, presets };
}

/** 활성 프리셋 지정 — 존재할 때만 반영. */
function presetSetActive(state, id) {
  const s = normalizeDashboardState(state);
  if (!s.presets.some((p) => p.id === id)) return s;
  return { schemaVersion: DASHBOARD_SCHEMA_VERSION, activePreset: id, presets: s.presets };
}

/** 프리셋 내용 갱신(렌더러 편집 영속용) — widgets/sizes/positions/layoutMode/groups 부분 패치(정규화).
 *   ⚠️ 여기 화이트리스트에 없는 키는 normalizePreset 이 조용히 버린다 — 새 프리셋 필드를 만들면 반드시 추가. */
function presetUpdate(state, id, patch) {
  const s = normalizeDashboardState(state);
  const p0 = isPlainObject(patch) ? patch : {};
  const presets = s.presets.map((p) => {
    if (p.id !== id) return p;
    // [위젯 인스턴스] widgets 를 먼저 확정해야(패치본 우선) sizes/positions/groups 가 그 iid 집합으로 검증된다.
    const nextWidgets = (p0.widgets !== undefined) ? p0.widgets : p.widgets;
    return normalizePreset({
      id: p.id,
      name: p.name,
      widgets: nextWidgets, // v6 필드 — 레거시(layout/hidden) 이행 경로를 타지 않는다
      sizes: (p0.sizes !== undefined) ? p0.sizes : p.sizes,
      positions: (p0.positions !== undefined) ? p0.positions : p.positions,
      layoutMode: (p0.layoutMode !== undefined) ? p0.layoutMode : p.layoutMode,
      groups: (p0.groups !== undefined) ? p0.groups : p.groups,
    }, p.id);
  });
  return { schemaVersion: DASHBOARD_SCHEMA_VERSION, activePreset: s.activePreset, presets };
}

// ── [로드맵 Phase 1 · K] 대시보드 내보내기/가져오기 직렬화 (순수·방어) ────────────────────
/** 대시보드 상태 → 버전드 JSON 문자열(백업·공유·기기 이전). 내부에서 정규화 후 직렬화. */
function serializeDashboard(dashboard) {
  return JSON.stringify({ kind: 'spip-dashboard', schemaVersion: DASHBOARD_SCHEMA_VERSION, dashboard: normalizeDashboardState(dashboard) }, null, 2);
}
/** JSON 문자열 → 정규화된 대시보드 상태(신뢰 못 할 입력 방어). 래퍼({kind,dashboard})·베어 모두 허용.
 *   비문자열/과대/파싱실패는 null. 그 외는 항상 유효한 대시보드(normalizeDashboardState 폴백). */
function deserializeDashboard(json) {
  if (typeof json !== 'string' || json.length > MAX_UISTATE_BYTES) return null;
  const parsed = _safeParse(json); // 깊이/예외 가드(H-3)
  if (!isPlainObject(parsed)) return null;
  const d = isPlainObject(parsed.dashboard) ? parsed.dashboard : parsed;
  return normalizeDashboardState(d);
}

function defaultState() {
  // [M13 C-M-1 ①] briefing 기본값 — carry-over 항목·카운터. 누락 시 normalizeBriefing이 graceful 폴백.
  // [위젯 인스턴스 v6] homeLayout/hiddenWidgets 는 homeWidgets([{iid,type,name}])로 대체됐다.
  return { schemaVersion: SCHEMA_VERSION, favorites: [], order: [], sortMode: 'auto', names: {}, theme: 'system', accent: 'indigo', uiScale: 'normal', todos: [], langTrend: { generatedAt: null, prev: {}, cur: {} }, homeWidgets: defaultHomeWidgets(), homeWidgetSizes: {}, briefing: defaultBriefing(), aiUsage: defaultAiUsage(), shelfBookmarks: [], scratchpads: {}, dashboard: defaultDashboardState() };
}

/** briefing 신규 키 기본값. */
function defaultBriefing() {
  return { items: [], lastGenAt: null, lastSnapshotHash: null, lastSnapshot: null, counters: { generated: 0, done: 0, dismiss: 0 } };
}

/** [항목3] 연결된 LLM 모델 토큰 사용량 누적 기본값. lastModel은 표시용(짧게 clamp). */
function defaultAiUsage() {
  return { calls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, lastModel: '', lastAt: null };
}

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** 객체/배열 중첩 깊이 가드(H-3 패턴, JSON 폭탄 차단). 명시 스택으로 스택오버플로 회피. */
function depthWithinLimit(value, maxDepth) {
  const stack = [{ v: value, d: 1 }];
  while (stack.length > 0) {
    const { v, d } = stack.pop();
    if (d > maxDepth) return false;
    if (v && typeof v === 'object') {
      if (Array.isArray(v)) {
        for (let i = 0; i < v.length; i++) stack.push({ v: v[i], d: d + 1 });
      } else {
        for (const k in v) {
          if (Object.prototype.hasOwnProperty.call(v, k)) stack.push({ v: v[k], d: d + 1 });
        }
      }
    }
  }
  return true;
}

/** 가드를 거친 JSON 파싱(H-3 ③). 실패 시 null. */
function _safeParse(raw) {
  if (typeof raw !== 'string') return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_) {
    return null;
  }
  if (!depthWithinLimit(parsed, MAX_JSON_DEPTH)) return null;
  return parsed;
}

/** id 배열을 형식 검증·중복 제거·개수 상한 적용. */
function normalizeIdArray(input, maxLen) {
  if (!Array.isArray(input)) return [];
  const out = [];
  const seen = new Set();
  for (const item of input) {
    if (out.length >= maxLen) break;
    if (typeof item !== 'string' || !ID_RE.test(item)) continue;
    if (seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

/**
 * 파싱된 객체(또는 임의 값)를 검증·정규화해 안전한 상태 객체로 만든다.
 * schemaVersion 불일치·잘못된 타입은 폴백. id 형식·길이 상한·중복 제거·sortMode 화이트리스트.
 * @param {*} obj
 * @returns {{schemaVersion:number,favorites:string[],order:string[],sortMode:string}}
 */
function normalizeState(obj) {
  if (!isPlainObject(obj)) return defaultState();
  const favorites = normalizeIdArray(obj.favorites, MAX_FAVORITES);
  const order = normalizeIdArray(obj.order, MAX_ORDER);
  const sortMode = (typeof obj.sortMode === 'string' && SORT_MODES.has(obj.sortMode)) ? obj.sortMode : 'auto';
  const names = normalizeNames(obj.names);
  const theme = (typeof obj.theme === 'string' && THEMES.has(obj.theme)) ? obj.theme : 'system';
  const accent = (typeof obj.accent === 'string' && THEME_ACCENTS.has(obj.accent)) ? obj.accent : 'indigo'; // [Phase 1·J]
  const uiScale = (typeof obj.uiScale === 'string' && UI_SCALES.has(obj.uiScale)) ? obj.uiScale : 'normal';
  const todos = normalizeTodos(obj.todos);
  const langTrend = normalizeLangTrend(obj.langTrend);
  // [위젯 인스턴스 v6] 배치 = homeWidgets([{iid,type,name}]). v5 이하 저장본은 homeLayout+hiddenWidgets 에서
  //   이행한다(타입 id → iid 승격 — sizes/positions/groups 키 무손실). [C-M-1] 필수 — 누락 시 write가 키를 버림.
  //   ⚠️ undefined < N === false 함정 — schemaVersion 부재(undefined)를 명시적으로 최고참 레거시로 분기한다.
  const inputVer = (typeof obj.schemaVersion === 'number' && Number.isFinite(obj.schemaVersion)) ? obj.schemaVersion : undefined;
  const homeWidgets = resolveHomeWidgets(obj, inputVer, { key: 'homeWidgets', layoutKey: 'homeLayout', hiddenKey: 'hiddenWidgets' });
  const placed = new Set(homeWidgets.map((w) => w.iid));
  const briefing = normalizeBriefing(obj.briefing); // [M13 C-M-1 ②] 필수 — 누락 시 write가 키를 버림
  const aiUsage = normalizeAiUsage(obj.aiUsage); // [항목3] 필수 — 누락 시 write가 키를 버림
  const shelfBookmarks = normalizeShelfBookmarks(obj.shelfBookmarks); // [SH-1] 셸프 북마크
  const homeWidgetSizes = normalizeHomeWidgetSizes(obj.homeWidgetSizes, placed); // 배치된 iid 의 폭·높이만
  const scratchpads = migrateScratchpads(obj); // [위젯 인스턴스] 인스턴스별 메모 { iid: {text,updatedAt} }
  // [로드맵 Phase 2] 대시보드(프리셋) — 레거시 키(homeWidgets/sizes)가 '활성 뷰'의 권위(authoritative).
  //   normalizeState 는 활성 프리셋을 현재 키에 맞춰 reconcile 하고, 나머지 프리셋 내용은 dashboard 에
  //   보존한다. dashboard 부재(레거시 사용자)면 현재 키로 이행.
  //   프리셋 전환은 IPC 가 최상위 키를 대상 프리셋 내용으로 스왑 → 렌더 경로/데이터 하위호환.
  const dashboardNorm = normalizeDashboardState(isPlainObject(obj.dashboard)
    ? obj.dashboard
    : migrateLegacyToDashboard({ homeWidgets, homeWidgetSizes }, inputVer), inputVer);
  const dashboard = presetUpdate(dashboardNorm, dashboardNorm.activePreset, { widgets: homeWidgets, sizes: homeWidgetSizes });
  return { schemaVersion: SCHEMA_VERSION, favorites, order, sortMode, names, theme, accent, uiScale, todos, langTrend, homeWidgets, homeWidgetSizes, briefing, aiUsage, shelfBookmarks, scratchpads, dashboard };
}

/** [SH-1 P1 / 로드맵 Phase 3·G] inputVer 이후 도입된 신규 위젯을 hiddenWidgets에 멱등 union.
 *   중복 미추가, 토글 화이트리스트 내만. inputVer 부재(undefined)는 모든 신규 위젯 대상(최고참 레거시). */
function unionNewHidden(hidden, inputVer) {
  const out = hidden.slice();
  for (const entry of NEW_HIDDEN_SINCE) {
    if (inputVer !== undefined && inputVer >= entry.since) continue; // 이미 이 위젯을 아는 버전 — 숨김 강제 안 함
    for (const id of entry.ids) {
      if (TOGGLEABLE_WIDGET_SET.has(id) && out.indexOf(id) < 0) out.push(id);
    }
  }
  return out;
}

/**
 * [SH-1] 셸프 북마크 배열 정규화 — 영속·신뢰 경계(공격자/손상 입력 방어).
 *   id 형식(SHELF_ID_RE)·중복 제거·type 화이트리스트·ref 길이·색 형식·텍스트 sanitize·개수 상한(MAX_SHELF).
 *   필드 화이트리스트만 채택(미지 필드 드롭). 표시 문자열은 제어문자 제거+trim+길이상한(L-1 표시 안전).
 *   영속본은 bannerKey(hex)만 — og:image 바이트는 ui-state 밖 캐시. addedAt 부재 시 null(핸들러가 스탬프).
 * @param {*} input
 * @returns {Array<object>} ShelfBookmark 저장 형태 배열
 */
function normalizeShelfBookmarks(input) {
  if (!Array.isArray(input)) return [];
  const out = [];
  const seen = new Set();
  for (const it of input) {
    if (out.length >= MAX_SHELF) break;
    if (!isPlainObject(it)) continue;
    const id = (typeof it.id === 'string' && SHELF_ID_RE.test(it.id)) ? it.id : null;
    if (!id || seen.has(id)) continue;
    if (typeof it.type !== 'string' || !SHELF_TYPES.has(it.type)) continue;
    const ref = (typeof it.ref === 'string') ? it.ref : '';
    if (!ref || ref.length > MAX_SHELF_REF) continue;
    const color = (typeof it.color === 'string' && SHELF_COLOR_RE.test(it.color))
      ? ('#' + it.color.slice(1).toLowerCase()) : SHELF_DEFAULT_COLOR;
    const bannerKey = (typeof it.bannerKey === 'string' && SHELF_BANNER_KEY_RE.test(it.bannerKey)) ? it.bannerKey : null;
    seen.add(id);
    out.push({
      id,
      type: it.type,
      ref,
      name: sanitizeBriefingText(it.name, MAX_SHELF_NAME),
      // 사용자 지정 책 제목(스파인 표시명). 비면 크롤/스캔 name 사용. refresh가 덮지 않는다.
      customName: sanitizeBriefingText(it.customName, MAX_SHELF_NAME),
      title: sanitizeBriefingText(it.title, MAX_SHELF_TITLE),
      sub: sanitizeBriefingText(it.sub, MAX_SHELF_SUB),
      desc: sanitizeBriefingText(it.desc, MAX_SHELF_DESC),
      color,
      mono: sanitizeBriefingText(it.mono, MAX_SHELF_MONO),
      cat: sanitizeBriefingText(it.cat, MAX_SHELF_CAT),
      status: sanitizeBriefingText(it.status, MAX_SHELF_STATUS),
      bannerKey,
      lastChecked: (typeof it.lastChecked === 'number' && Number.isFinite(it.lastChecked)) ? it.lastChecked : null,
      addedAt: (typeof it.addedAt === 'number' && Number.isFinite(it.addedAt)) ? it.addedAt : null,
    });
  }
  return out;
}

/**
 * [항목3] 연결된 LLM 모델 토큰 사용량 누적 정규화 — 음 아닌 정수·표시 문자열·타임스탬프.
 *   누락/손상 graceful 기본값. 수치는 nonNegInt(비유한·음수 → 0).
 * @param {*} input
 * @returns {{calls,promptTokens,completionTokens,totalTokens,lastModel,lastAt}}
 */
function normalizeAiUsage(input) {
  if (!isPlainObject(input)) return defaultAiUsage();
  return {
    calls: nonNegInt(input.calls),
    promptTokens: nonNegInt(input.promptTokens),
    completionTokens: nonNegInt(input.completionTokens),
    totalTokens: nonNegInt(input.totalTokens),
    lastModel: sanitizeBriefingText(input.lastModel, MAX_BRIEFING_TITLE),
    lastAt: (typeof input.lastAt === 'number' && Number.isFinite(input.lastAt)) ? input.lastAt : null,
  };
}

/** 텍스트 정제(제어문자 제거·trim·길이 상한, L-1 표시 안전). */
function sanitizeBriefingText(v, max) {
  if (typeof v !== 'string') return '';
  return Array.from(v)
    .filter(function (ch) { var c = ch.charCodeAt(0); return c >= 32 && c !== 127; })
    .join('').trim().slice(0, max);
}

/**
 * [로드맵 Phase 3·G] 스크래치패드 메모 텍스트 정규화(순수·신뢰 경계).
 *   개행(\n)·탭(\t)은 보존(메모 서식), 그 외 제어문자·DEL 제거, 길이 상한. trim 안 함(선행/후행 공백 보존).
 *   L-1: 렌더는 textContent — 저장값은 표시 안전(마크업 해석 없음).
 */
function sanitizeScratchpad(v) {
  if (typeof v !== 'string') return '';
  return Array.from(v)
    .filter(function (ch) { var c = ch.charCodeAt(0); return c === 9 || c === 10 || (c >= 32 && c !== 127); })
    .join('').slice(0, MAX_SCRATCHPAD);
}

/** 스크래치패드 상태 정규화 — { text, updatedAt }. 손상/부재 graceful 기본값. */
function normalizeScratchpad(input) {
  const o = isPlainObject(input) ? input : {};
  const text = sanitizeScratchpad(o.text);
  const updatedAt = (typeof o.updatedAt === 'number' && Number.isFinite(o.updatedAt) && o.updatedAt > 0) ? Math.floor(o.updatedAt) : null;
  return { text, updatedAt };
}

/** 스크래치패드 기본값(빈 메모). */
function defaultScratchpad() { return { text: '', updatedAt: null }; }

/**
 * [위젯 인스턴스] 스크래치패드는 이제 **인스턴스별 메모**다 — { [iid]: {text,updatedAt} }.
 *   메모 위젯을 2개 놓으면 서로 다른 메모를 쓴다(같은 텍스트를 두 번 보여주는 건 중복 배치의 의미가 없다).
 *
 * ⚠️ 배치된 iid 로 **게이트하지 않는다** — 위젯을 잠깐 지웠다고 메모 본문을 날리면 사용자 데이터 유실이다.
 *   크기·좌표(재생성 가능한 배치 메타)와 달리 메모는 콘텐츠다. 형식·상한만 검증하고 고아 메모는 남겨둔다.
 * @param {*} input
 * @returns {Object<string,{text:string,updatedAt:(number|null)}>}
 */
function normalizeScratchpads(input) {
  const out = {};
  if (!isPlainObject(input)) return out;
  let n = 0;
  for (const iid of Object.keys(input)) {
    if (n >= MAX_WIDGETS) break; // 개수 상한(무한 증식 방어)
    if (!IID_RE.test(iid)) continue;
    out[iid] = normalizeScratchpad(input[iid]);
    n++;
  }
  return out;
}

/** [v5 → v6 이행] 단일 scratchpad → 인스턴스 맵. 레거시 메모는 승격된 'scratchpad' 인스턴스(타입 id → iid)가 이어받는다. */
function migrateScratchpads(obj) {
  if (isPlainObject(obj.scratchpads)) return normalizeScratchpads(obj.scratchpads);
  const legacy = normalizeScratchpad(obj.scratchpad);
  if (!legacy.text) return {};
  return { scratchpad: legacy };
}

/**
 * [M13 R-38/C-M-1] briefing 신규 키 정규화 — carry-over 항목·카운터.
 *   항목 키 형식·status/category 화이트리스트·텍스트 sanitize·개수 상한. 누락/구버전 graceful 기본값.
 * @param {*} input
 * @returns {{items:Array,lastGenAt:number|null,lastSnapshotHash:string|null,counters:object}}
 */
function normalizeBriefing(input) {
  if (!isPlainObject(input)) return defaultBriefing();
  const items = [];
  const seen = new Set();
  if (Array.isArray(input.items)) {
    for (const it of input.items) {
      if (items.length >= MAX_BRIEFING_ITEMS) break;
      if (!isPlainObject(it)) continue;
      const key = (typeof it.key === 'string' && BRIEFING_KEY_RE.test(it.key)) ? it.key : null;
      if (!key || seen.has(key)) continue;
      const signalType = (typeof it.signalType === 'string') ? sanitizeBriefingText(it.signalType, BRIEFING_SIGNAL_MAX) : '';
      if (!signalType) continue;
      seen.add(key);
      items.push({
        key,
        signalType,
        targetId: sanitizeBriefingText(it.targetId, MAX_BRIEFING_TITLE),
        category: BRIEFING_CATEGORIES.has(it.category) ? it.category : 'good',
        title: sanitizeBriefingText(it.title, MAX_BRIEFING_TITLE),
        reason: sanitizeBriefingText(it.reason, MAX_BRIEFING_REASON),
        guide: sanitizeBriefingText(it.guide, MAX_BRIEFING_GUIDE),
        ref: sanitizeBriefingText(it.ref, MAX_BRIEFING_TITLE),
        status: BRIEFING_STATUSES.has(it.status) ? it.status : 'open',
        createdAt: (typeof it.createdAt === 'number' && Number.isFinite(it.createdAt)) ? it.createdAt : null,
        resolvedAt: (typeof it.resolvedAt === 'number' && Number.isFinite(it.resolvedAt)) ? it.resolvedAt : null,
      });
    }
  }
  const c = isPlainObject(input.counters) ? input.counters : {};
  const counters = {
    generated: nonNegInt(c.generated),
    done: nonNegInt(c.done),
    dismiss: nonNegInt(c.dismiss),
  };
  return {
    items,
    lastGenAt: (typeof input.lastGenAt === 'number' && Number.isFinite(input.lastGenAt)) ? input.lastGenAt : null,
    lastSnapshotHash: (typeof input.lastSnapshotHash === 'string' && input.lastSnapshotHash.length <= 128) ? input.lastSnapshotHash : null,
    // [M13 code-review #1] 필요성 판정 기준점 — 재시작 후 prev=null 과트리거 방지. 정규화 후 영속.
    lastSnapshot: normalizeBriefingSnapshot(input.lastSnapshot),
    counters,
  };
}

/**
 * [M13] 브리핑 스냅샷 정규화 — 영속용(프로젝트 git·mail·disk·scan). 키 형식·개수 상한.
 *   null=미보유(첫 생성). briefingPolicy.normalizeSnapshot와 필드 호환.
 */
function normalizeBriefingSnapshot(input) {
  if (!isPlainObject(input)) return null;
  const projects = [];
  if (Array.isArray(input.projects)) {
    const seen = new Set();
    for (const p of input.projects) {
      if (projects.length >= MAX_BRIEFING_ITEMS) break;
      if (!isPlainObject(p) || typeof p.id !== 'string' || !ID_RE.test(p.id) || seen.has(p.id)) continue;
      seen.add(p.id);
      projects.push({
        id: p.id,
        dirty: p.dirty === true,
        ahead: nonNegInt(p.ahead),
        behind: nonNegInt(p.behind),
        attention: p.attention === true,
      });
    }
  }
  // [브리핑 일정] 할 일 마감 — 트리거 dedup(직전 임박 여부 비교) 기준점. id·dueAt·done만 영속(name은 표시용이라 불요).
  const deadlines = [];
  if (Array.isArray(input.deadlines)) {
    const seenD = new Set();
    for (const d of input.deadlines) {
      if (deadlines.length >= MAX_BRIEFING_ITEMS) break;
      if (!isPlainObject(d) || typeof d.id !== 'string' || !TODO_ID_RE.test(d.id) || seenD.has(d.id)) continue;
      seenD.add(d.id);
      deadlines.push({
        id: d.id,
        dueAt: (typeof d.dueAt === 'number' && Number.isFinite(d.dueAt)) ? d.dueAt : null,
        done: d.done === true,
      });
    }
  }
  const mail = isPlainObject(input.mail) ? input.mail : {};
  const disk = isPlainObject(input.disk) ? input.disk : {};
  const scan = isPlainObject(input.scan) ? input.scan : {};
  return {
    projects,
    deadlines, // [브리핑 일정] id·dueAt·done 영속(직전 임박 비교용)
    mail: {
      unseen: nonNegInt(mail.unseen),
      latestUid: (typeof mail.latestUid === 'string' && mail.latestUid.length <= 128) ? mail.latestUid : null,
    },
    disk: { reclaimBytes: nonNegInt(disk.reclaimBytes) },
    scan: { generatedAt: (typeof scan.generatedAt === 'string' && scan.generatedAt.length <= 64) ? scan.generatedAt : null },
  };
}

function nonNegInt(v) {
  return (typeof v === 'number' && Number.isFinite(v) && v >= 0) ? Math.floor(v) : 0;
}

/** 언어 카운트 맵 정규화 — { 언어: 음 아닌 정수 }, 개수 상한. */
function normalizeLangCounts(input) {
  if (!isPlainObject(input)) return {};
  const out = {};
  let n = 0;
  for (const k in input) {
    if (!Object.prototype.hasOwnProperty.call(input, k)) continue;
    if (n >= MAX_LANG_ENTRIES) break;
    if (typeof k !== 'string' || !k || k.length > 64) continue;
    const v = input[k];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) continue;
    out[k] = Math.floor(v);
    n += 1;
  }
  return out;
}

/** 언어 추세 baseline 정규화 — { generatedAt, prev, cur }. */
function normalizeLangTrend(input) {
  if (!isPlainObject(input)) return { generatedAt: null, prev: {}, cur: {} };
  const ga = (typeof input.generatedAt === 'string' && input.generatedAt.length <= 64) ? input.generatedAt : null;
  return { generatedAt: ga, prev: normalizeLangCounts(input.prev), cur: normalizeLangCounts(input.cur) };
}

/** 할 일 텍스트 정제 — 제어문자 제거 + trim + 길이 상한(L-1 표시 안전). 빈 문자열이면 ''. */
function sanitizeTodoText(v) {
  if (typeof v !== 'string') return '';
  return Array.from(v)
    .filter(function (ch) { var c = ch.charCodeAt(0); return c >= 32 && c !== 127; })
    .join('').trim().slice(0, MAX_TODO_LEN);
}

/** 할 일 배열 정규화 — {id,text,done,createdAt,dueAt}. id 형식·중복·개수 상한, 빈 텍스트 폐기.
 *   [백로그2-4] dueAt: 마감 일시(ms epoch) 또는 null(미설정). 유한·양수만 허용. */
function normalizeTodos(input) {
  if (!Array.isArray(input)) return [];
  const out = [];
  const seen = new Set();
  for (const item of input) {
    if (out.length >= MAX_TODOS) break;
    if (!isPlainObject(item)) continue;
    const id = (typeof item.id === 'string' && TODO_ID_RE.test(item.id)) ? item.id : null;
    if (!id || seen.has(id)) continue;
    const text = sanitizeTodoText(item.text);
    if (!text) continue;
    const createdAt = (typeof item.createdAt === 'number' && Number.isFinite(item.createdAt)) ? item.createdAt : null;
    const dueAt = (typeof item.dueAt === 'number' && Number.isFinite(item.dueAt) && item.dueAt > 0) ? Math.floor(item.dueAt) : null;
    seen.add(id);
    out.push({ id, text, done: item.done === true, createdAt, dueAt });
  }
  return out;
}

/** 별칭 맵 정규화 — 키는 id 형식, 값은 sanitize된 비어있지 않은 문자열. 개수·길이 상한. */
function normalizeNames(input) {
  if (!isPlainObject(input)) return {};
  const out = {};
  let count = 0;
  for (const k in input) {
    if (!Object.prototype.hasOwnProperty.call(input, k)) continue;
    if (count >= MAX_NAMES) break;
    if (!ID_RE.test(k)) continue;
    const v = input[k];
    if (typeof v !== 'string') continue;
    // 제어문자 제거 + trim + 길이 상한(L-1: 표시 안전).
    const clean = Array.from(v).filter(function (ch) { var c = ch.charCodeAt(0); return c >= 32 && c !== 127; }).join('').trim().slice(0, MAX_NAME_LEN);
    if (!clean) continue;
    out[k] = clean;
    count++;
  }
  return out;
}

/**
 * 현재 프로젝트 id 집합에 맞춰 즐겨찾기·수동순서를 정리(재스캔 머지) — 존재하는 것만 유지.
 *   별칭(names)은 보존(일시적 미검출 후 재등장 시 재적용). validIdSet이 비면 정리하지 않는다(안전).
 * @param {object} state 정규화된 상태
 * @param {Set<string>} validIdSet 현재 스냅샷 프로젝트 id 집합
 * @returns {{ state:object, changed:boolean }}
 */
function reconcileState(state, validIdSet) {
  const s = normalizeState(state);
  if (!(validIdSet instanceof Set) || validIdSet.size === 0) return { state: s, changed: false };
  const favorites = s.favorites.filter((id) => validIdSet.has(id));
  const order = s.order.filter((id) => validIdSet.has(id));
  const changed = favorites.length !== s.favorites.length || order.length !== s.order.length;
  return { state: Object.assign({}, s, { favorites, order }), changed };
}

/**
 * ui-state.json을 읽어 정규화된 상태를 반환한다. 부재/손상/거대/깊은중첩 모두 graceful 빈 상태(M6-M-4).
 * @param {object} [ctx] { logger, uiStatePath?, deps?{fs,paths} }
 * @returns {{schemaVersion:number,favorites:string[],order:string[],sortMode:string}}
 */
function read(ctx) {
  ctx = ctx || {};
  const _fs = (ctx.deps && ctx.deps.fs) || fs;
  const _paths = (ctx.deps && ctx.deps.paths) || paths;
  const file = ctx.uiStatePath || _paths.uiStatePath();
  try {
    const st = _fs.statSync(file);
    if (!st.isFile()) return defaultState();
    if (st.size > MAX_UISTATE_BYTES) return defaultState();   // ① 크기 상한
    const raw = _fs.readFileSync(file, 'utf8');
    if (typeof raw !== 'string' || raw.length > MAX_UISTATE_BYTES) return defaultState(); // ② 길이 재확인
    const obj = _safeParse(raw);                              // ③ 깊이/예외 가드
    if (!isPlainObject(obj)) return defaultState();
    return normalizeState(obj);                              // ④ 정규화 재적용
  } catch (_) {
    return defaultState(); // 부재/손상/권한 → graceful
  }
}

/**
 * 상태 객체를 정규화 후 0600 원자적 쓰기로 영속한다(임시파일→fsync→rename→0600).
 *
 * [M12 b3] 중앙 elevated 플래그(상승 세션)면 디스크 write 를 no-op 한다 — 즐겨찾기·정렬·테마·
 *   할일·homeLayout·별칭이 관리자 프로필에 떨어지지 않게 한다. 정규화 메모리 결과는 그대로 반환.
 *   deps.elevationState 주입 가능(테스트).
 * @param {object} state
 * @param {object} [ctx] { logger, uiStatePath?, deps?{fs,paths,elevationState} }
 * @returns {{schemaVersion:number,favorites:string[],order:string[],sortMode:string}} 영속된 정규화 상태
 */
function write(state, ctx) {
  ctx = ctx || {};
  const _fs = (ctx.deps && ctx.deps.fs) || fs;
  const _paths = (ctx.deps && ctx.deps.paths) || paths;
  const _elev = (ctx.deps && ctx.deps.elevationState) || elevationState;
  const file = ctx.uiStatePath || _paths.uiStatePath();
  const logger = ctx.logger;

  const normalized = normalizeState(state);

  // [M12 b3] 상승 세션이면 디스크 write 보류(no-op) — 정규화 메모리 결과만 반환.
  if (_elev.isElevated()) {
    if (logger) logger.warn('상승 세션 — ui-state 디스크 저장 보류(메모리 유지)');
    return normalized;
  }

  const body = JSON.stringify(normalized, null, 2);

  const dir = _paths.ensureDirFor(file); // 0700 보장(M-2)
  const tmp = path.join(dir, '.' + path.basename(file) + '.' + process.pid + '.' + Date.now() + '.tmp');

  let fd;
  try {
    fd = _fs.openSync(tmp, 'wx', FILE_MODE);
    _fs.writeFileSync(fd, body, { encoding: 'utf8' });
    try { _fs.fsyncSync(fd); } catch (_) { /* noop */ }
    _fs.closeSync(fd);
    fd = undefined;
    try { _fs.chmodSync(tmp, FILE_MODE); } catch (_) { /* noop */ }
    _fs.renameSync(tmp, file);
    try { _fs.chmodSync(file, FILE_MODE); } catch (_) { /* noop */ }
  } catch (err) {
    if (fd !== undefined) { try { _fs.closeSync(fd); } catch (_) { /* noop */ } }
    try { if (_fs.existsSync(tmp)) _fs.unlinkSync(tmp); } catch (_) { /* noop */ }
    if (logger) logger.error('ui-state 영속화 실패', err);
    throw err;
  }
  return normalized;
}

module.exports = {
  read,
  write,
  normalizeState,
  normalizeIdArray,
  normalizeNames,
  normalizeTodos,
  sanitizeTodoText,
  normalizeLangCounts,
  normalizeLangTrend,
  // [레거시 v5 이하] 타입 순열/숨김 집합 — 이제 v6 이행 경로에서만 쓰인다(배치의 진실은 homeWidgets).
  normalizeHomeLayout,
  normalizeHiddenWidgets,
  normalizeHomeWidgetSizes,
  // [위젯 인스턴스 v6] 배치 단위 = 인스턴스({iid,type,name}) — 같은 타입 중복 배치 + 배치별 이름.
  normalizeHomeWidgets,
  defaultHomeWidgets,
  migrateLegacyWidgets,
  nextWidgetIid,
  IID_RE,
  MAX_WIDGETS,
  MAX_WIDGET_NAME,
  // [로드맵 Phase 3·G] 스크래치패드 메모(전역 콘텐츠) 정규화·기본값·상한.
  normalizeScratchpad,
  sanitizeScratchpad,
  defaultScratchpad,
  // [위젯 인스턴스] 인스턴스별 메모 맵 { iid: {text,updatedAt} } + v5 단일 메모 이행.
  normalizeScratchpads,
  migrateScratchpads,
  MAX_SCRATCHPAD,
  // [대시보드 자유도 로드맵 · Phase 0] 통합 대시보드 상태 모델(순수 — 아직 영속 미연결).
  normalizeDashboardState,
  normalizePreset,
  normalizeWidgetPositions,
  normalizeGroups,
  GROUP_ID_RE,
  GROUP_MODES,
  MAX_GROUPS,
  MAX_GROUP_NAME,
  migrateLegacyToDashboard,
  defaultDashboardState,
  // [Phase 2 기반] 프리셋 CRUD(순수).
  nextPresetId,
  presetAdd,
  presetDuplicate,
  presetRename,
  presetRemove,
  presetSetActive,
  presetUpdate,
  serializeDashboard,
  deserializeDashboard,
  DASHBOARD_SCHEMA_VERSION,
  MAX_PRESETS,
  MAX_PRESET_NAME,
  PRESET_ID_RE,
  LAYOUT_MODES,
  DEFAULT_PRESET_ID,
  normalizeBriefing,
  normalizeBriefingSnapshot,
  normalizeAiUsage,
  normalizeShelfBookmarks,
  sanitizeBriefingText,
  reconcileState,
  _safeParse,
  depthWithinLimit,
  defaultState,
  defaultBriefing,
  defaultAiUsage,
  SCHEMA_VERSION,
  MAX_UISTATE_BYTES,
  MAX_FAVORITES,
  MAX_ORDER,
  MAX_NAMES,
  MAX_NAME_LEN,
  MAX_TODOS,
  MAX_TODO_LEN,
  ID_RE,
  TODO_ID_RE,
  SORT_MODES,
  THEMES,
  THEME_ACCENTS,
  UI_SCALES,
  HOME_SECTION_IDS,
  HOME_SECTION_SET,
  TOGGLEABLE_WIDGET_IDS,
  TOGGLEABLE_WIDGET_SET,
  HOME_MAX_COLS,
  HOME_H_MIN,
  HOME_H_MAX,
  BRIEFING_KEY_RE,
  MAX_BRIEFING_ITEMS,
  SHELF_WIDGET_IDS,
  DEFAULT_HIDDEN_WIDGETS,
  MAX_SHELF,
  SHELF_ID_RE,
  SHELF_TYPES,
  FILE_MODE,
};
