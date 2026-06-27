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

// [SH-1 P1] schemaVersion 2 — 셸프 위젯 도입. 레거시(v<2 또는 부재) state는 normalizeState가
//   신규 위젯(shelf/shelfWide)을 hiddenWidgets에 union(기본 숨김 — 기존 사용자 갑툭튀 방지)한다.
const SCHEMA_VERSION = 2;
const MAX_UISTATE_BYTES = 1 * 1024 * 1024; // 1MB 상한(M6-M-4)
const MAX_JSON_DEPTH = 32;
const MAX_FAVORITES = 512;
const MAX_ORDER = 4096; // order는 favorites보다 클 수 있음(전체 카드 순서)
const MAX_NAMES = 4096; // 별칭 항목 수 상한
const MAX_NAME_LEN = 120; // 별칭 길이 상한
const MAX_TODOS = 200; // 할 일 항목 수 상한
const MAX_TODO_LEN = 500; // 할 일 텍스트 길이 상한
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
const THEMES = new Set(['light', 'dark', 'system']);

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
const HOME_SECTION_IDS = ['attention', 'productivity', 'activity', 'todos', 'mail', 'disk', 'aiusage', 'shelf', 'shelfWide', 'featureAdd'];
const HOME_SECTION_SET = new Set(HOME_SECTION_IDS);

// [SH-1 P1] schemaVersion<2 이행 시 기본 숨김할 신규 위젯(레거시 사용자 기본 비노출).
const SHELF_WIDGET_IDS = ['shelf', 'shelfWide'];

// [SH-1 PM#3] 신규 설치도 셸프 2변형은 기본 숨김(사용자가 위젯 갤러리에서 추가). 레거시 이행(union)과
//   동일 집합을 단일 출처로 공유해 신규/기존 사용자 동작을 정합화한다(defaultState 시드 = 이행 union 대상).
const DEFAULT_HIDDEN_WIDGETS = SHELF_WIDGET_IDS;

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
const TOGGLEABLE_WIDGET_IDS = HOME_SECTION_IDS.filter((id) => id !== 'featureAdd');
const TOGGLEABLE_WIDGET_SET = new Set(TOGGLEABLE_WIDGET_IDS);

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

function defaultState() {
  // [M13 C-M-1 ①] briefing 기본값 — carry-over 항목·카운터. 누락 시 normalizeBriefing이 graceful 폴백.
  return { schemaVersion: SCHEMA_VERSION, favorites: [], order: [], sortMode: 'auto', names: {}, theme: 'system', todos: [], langTrend: { generatedAt: null, prev: {}, cur: {} }, homeLayout: HOME_SECTION_IDS.slice(), hiddenWidgets: DEFAULT_HIDDEN_WIDGETS.slice(), briefing: defaultBriefing(), aiUsage: defaultAiUsage(), shelfBookmarks: [] };
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
  const todos = normalizeTodos(obj.todos);
  const langTrend = normalizeLangTrend(obj.langTrend);
  const homeLayout = normalizeHomeLayout(obj.homeLayout); // [R-32/C-M-1] 필수 — 누락 시 write가 키를 버림
  let hiddenWidgets = normalizeHiddenWidgets(obj.hiddenWidgets); // [위젯 추가/제거] 숨긴 위젯 집합
  // [SH-1 P1] schemaVersion 이행 — 레거시(v<2 또는 부재)면 신규 위젯을 기본 숨김 union(멱등).
  //   ⚠️ undefined < 2 === false 함정 — 부재(undefined)를 명시적으로 레거시로 분기한다.
  //   이미 v2 사용자가 위젯을 직접 노출(un-hide)했다면 재숨김하지 않는다(no-op).
  const inputVer = (typeof obj.schemaVersion === 'number' && Number.isFinite(obj.schemaVersion)) ? obj.schemaVersion : undefined;
  const isLegacy = (inputVer === undefined) || (inputVer < 2);
  if (isLegacy) hiddenWidgets = unionShelfHidden(hiddenWidgets);
  const briefing = normalizeBriefing(obj.briefing); // [M13 C-M-1 ②] 필수 — 누락 시 write가 키를 버림
  const aiUsage = normalizeAiUsage(obj.aiUsage); // [항목3] 필수 — 누락 시 write가 키를 버림
  const shelfBookmarks = normalizeShelfBookmarks(obj.shelfBookmarks); // [SH-1] 셸프 북마크
  return { schemaVersion: SCHEMA_VERSION, favorites, order, sortMode, names, theme, todos, langTrend, homeLayout, hiddenWidgets, briefing, aiUsage, shelfBookmarks };
}

/** [SH-1 P1] 신규 위젯(shelf/shelfWide)을 hiddenWidgets에 멱등 union(중복 미추가, 토글 화이트리스트 내). */
function unionShelfHidden(hidden) {
  const out = hidden.slice();
  for (const id of SHELF_WIDGET_IDS) {
    if (TOGGLEABLE_WIDGET_SET.has(id) && out.indexOf(id) < 0) out.push(id);
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
  normalizeHomeLayout,
  normalizeHiddenWidgets,
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
  HOME_SECTION_IDS,
  HOME_SECTION_SET,
  TOGGLEABLE_WIDGET_IDS,
  TOGGLEABLE_WIDGET_SET,
  BRIEFING_KEY_RE,
  MAX_BRIEFING_ITEMS,
  SHELF_WIDGET_IDS,
  DEFAULT_HIDDEN_WIDGETS,
  MAX_SHELF,
  SHELF_ID_RE,
  SHELF_TYPES,
  FILE_MODE,
};
