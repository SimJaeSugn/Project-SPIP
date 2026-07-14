'use strict';
/**
 * electron/ipc/markdown.js — 마크다운 편집기 위젯 IPC 핸들러 (MD-1 / MD-H-1)
 *
 *   spip:md:list    → 문서 목록(메타만 — 본문 제외)
 *   spip:md:get     → 문서 1건(본문 포함)
 *   spip:md:create  → 새 문서(빈 문서 또는 제목·본문 지정). id·시각은 메인이 스탬프
 *   spip:md:update  → 제목·본문 수정
 *   spip:md:remove  → 삭제
 *   spip:md:import  → dialog(openFile) 로 .md 파일 1개를 읽어 새 문서로 적재
 *   spip:md:export  → dialog(saveFile) 로 문서를 .md 파일로 저장
 *
 * 보안 불변식(MD-H-1) — 이 위젯은 프로젝트에서 처음으로 '임의 파일 읽기·쓰기'를 여는 표면이라
 *   아래를 반드시 지킨다:
 *   · **렌더러는 경로 문자열을 주입할 수 없다.** import/export 의 경로는 오직 네이티브 dialog 가
 *     만든다(explorer.pickRoot 와 동일한 결정 — folders.js §4.2 "browseDir 없음"의 최소 완화).
 *     경로를 인자로 받는 read/write 채널은 **존재하지 않는다**.
 *   · 사용자가 dialog 로 고른 경로도 신뢰 근거가 아니다 — 정규 파일 여부·크기 상한을 재검증한다
 *     (tools.js "dialog 필터는 신뢰 근거 아님(M6-M-2)" 와 동형).
 *   · 문서 본문·제목은 mdDocStore 정규화(단일 검증 경계)를 통과해야만 영속된다.
 *   · 실패는 고정 코드만 반환한다(절대경로·errno 문자열 비노출, L-3).
 *   · 덮어쓰기는 dialog 자체 확인(showSaveDialog)에 위임 — 조용한 덮어쓰기 없음.
 *
 * [헤드리스 검증] Electron API 미import — dialog 는 ctx 주입. fs/paths 도 ctx.deps 로 주입 가능.
 * 외부 의존성 0 — Node 내장(fs, path) + 내부(mdDocStore).
 */

const fs = require('fs');
const path = require('path');
const mdDocStore = require('../../lib/common/mdDocStore');
const uiStateStore = require('../../lib/common/uiStateStore');

// 불러오기 허용 확장자 — 텍스트 마크다운 계열만.
const IMPORT_EXTS = ['md', 'markdown', 'mdown', 'mkd', 'txt'];
// 불러올 파일 바이트 상한. 본문 문자 상한(MAX_BODY)보다 넉넉히 잡되(UTF-8 다바이트), 상한 초과는
//   조용히 자르지 않고 LIMIT_SIZE 로 거절한다.
const MAX_IMPORT_BYTES = 2 * 1024 * 1024;

/* ───── 내부 헬퍼 ───── */

function deps(ctx) {
  const d = (ctx && ctx.deps) || {};
  return { fs: d.fs || fs, now: (typeof d.now === 'function') ? d.now : Date.now };
}

/** 저장소 read/write 에 넘길 ctx(테스트에서 mdDocsPath·deps 주입). */
function storeCtx(ctx) {
  return {
    logger: ctx && ctx.logger,
    mdDocsPath: ctx && ctx.mdDocsPath,
    deps: ctx && ctx.deps,
  };
}

/** args 에서 문자열 id 만 꺼낸다(plain object 만). */
function argId(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return null;
  return typeof args.id === 'string' ? args.id : null;
}

/** args 에서 문서함 키(= 편집기 위젯 인스턴스 id) — 형식 불량이면 null(호출부가 BAD_INPUT). */
function argBox(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return null;
  const box = args.box;
  return (typeof box === 'string' && mdDocStore.BOX_RE.test(box)) ? box : null;
}

/** 첫 마크다운 편집기 인스턴스의 iid(배치 순서) — 레거시 문서를 흡수할 문서함. 없으면 null. */
function firstEditorBox(ctx) {
  const _ui = (ctx && ctx.deps && ctx.deps.uiState) || uiStateStore;
  let widgets = [];
  try {
    const ui = _ui.read({ logger: ctx && ctx.logger, uiStatePath: ctx && ctx.uiStatePath, deps: ctx && ctx.deps });
    widgets = Array.isArray(ui.homeWidgets) ? ui.homeWidgets : [];
  } catch (_) { return null; }
  const first = widgets.find((w) => w && w.type === 'mdedit');
  return (first && typeof first.iid === 'string') ? first.iid : null;
}

/**
 * [v1 → v2 이행] 전역 문서함 하나였던 시절의 문서(state.legacy)를 **첫 편집기 인스턴스**의
 *   문서함으로 흡수한다. 다른 인스턴스가 먼저 물어봐도 흡수하지 않는다(문서가 엉뚱한 편집기로
 *   가지 않게). 흡수 대상 인스턴스가 아직 배치되지 않았으면 legacy 는 그대로 보존된다(무손실).
 * @returns {object} 흡수 후(또는 그대로의) 상태
 */
function adoptLegacy(state, box, ctx) {
  const legacy = Array.isArray(state.legacy) ? state.legacy : [];
  if (legacy.length === 0) return state;
  if (box !== firstEditorBox(ctx)) return state;

  const merged = legacy.concat(mdDocStore.docsOf(state, box)).slice(0, mdDocStore.MAX_DOCS);
  const next = mdDocStore.withDocs(state, box, merged);
  next.legacy = [];
  return mdDocStore.write(next, storeCtx(ctx));
}

/** 문서함 스코프 상태 읽기 + 레거시 이행. 모든 CRUD 의 단일 진입. */
function readBox(box, ctx) {
  return adoptLegacy(mdDocStore.read(storeCtx(ctx)), box, ctx);
}

/** 목록 응답용 메타(본문 제외) — 본문은 get 으로만. 목록 응답이 수 MB 가 되는 걸 막는다. */
function toMeta(doc) {
  return {
    id: doc.id,
    title: doc.title,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    size: doc.body.length, // 문자수(목록의 부가 표시용)
  };
}

/** 최근 수정 순(없으면 생성 순) 정렬 — 편집기 목록의 기본 순서. */
function sortDocs(docs) {
  return docs.slice().sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0));
}

/** 제목 폴백 — 빈 제목은 목록에서 '제목 없음'이 아니라 본문 첫 제목/첫 줄을 쓰도록 메인에서 파생한다. */
function deriveTitle(title, body) {
  const t = mdDocStore.sanitizeTitle(title);
  if (t) return t;
  const lines = String(body || '').split('\n');
  for (const line of lines) {
    const h = /^ {0,3}#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/.exec(line);
    if (h) return mdDocStore.sanitizeTitle(h[1]);
    if (line.trim()) return mdDocStore.sanitizeTitle(line);
  }
  return '';
}

/** 파일명으로 안전한 제목 — 경로 구분자·예약문자 제거(내보내기 기본 파일명 제안용). */
function safeFileName(title) {
  const base = String(title || '').replace(/[\\/:*?"<>|\x00-\x1f]/g, '').trim() || '문서';
  return base.slice(0, 80) + '.md';
}

/* ───── CRUD ───── */

/** spip:md:list — 그 문서함(위젯 인스턴스)의 문서 목록(메타만). */
function list(args, ctx) {
  const box = argBox(args);
  if (!box) return { ok: false, code: 'BAD_INPUT' };
  const state = readBox(box, ctx);
  return { ok: true, docs: sortDocs(mdDocStore.docsOf(state, box)).map(toMeta), max: mdDocStore.MAX_DOCS };
}

/** spip:md:get — 문서 1건(본문 포함). 다른 문서함의 문서는 보이지 않는다(인스턴스 격리). */
function get(args, ctx) {
  const box = argBox(args);
  const id = argId(args);
  if (!box || !id || !mdDocStore.ID_RE.test(id)) return { ok: false, code: 'BAD_INPUT' };
  const state = readBox(box, ctx);
  const doc = mdDocStore.docsOf(state, box).find((d) => d.id === id);
  if (!doc) return { ok: false, code: 'NOT_FOUND' };
  return { ok: true, doc };
}

/**
 * spip:md:create — 새 문서. id·createdAt·updatedAt 은 **메인이 스탬프**한다(렌더러 주입 불가).
 * @param {object} args { title?, body? }
 */
function create(args, ctx) {
  const box = argBox(args);
  if (!box) return { ok: false, code: 'BAD_INPUT' };

  const d = deps(ctx);
  const sctx = storeCtx(ctx);
  const state = readBox(box, ctx);
  const docs = mdDocStore.docsOf(state, box);
  if (docs.length >= mdDocStore.MAX_DOCS) return { ok: false, code: 'LIMIT_DOCS' };

  const rawTitle = (typeof args.title === 'string') ? args.title : '';
  const rawBody = (typeof args.body === 'string') ? args.body : '';
  // 조용한 절단 금지 — 본문 상한 초과는 거절한다.
  if (rawBody.length > mdDocStore.MAX_BODY) return { ok: false, code: 'LIMIT_SIZE' };

  const now = d.now();
  const doc = {
    id: mdDocStore.newId(),
    title: deriveTitle(rawTitle, rawBody),
    body: rawBody,
    createdAt: now,
    updatedAt: now,
  };
  const next = mdDocStore.write(mdDocStore.withDocs(state, box, docs.concat([doc])), sctx);
  const saved = mdDocStore.docsOf(next, box).find((x) => x.id === doc.id);
  if (!saved) return { ok: false, code: 'WRITE_FAILED' };
  return { ok: true, doc: saved, docs: sortDocs(mdDocStore.docsOf(next, box)).map(toMeta) };
}

/**
 * spip:md:update — 제목·본문 수정. updatedAt 은 메인이 스탬프.
 * @param {object} args { id, title?, body? } — 주어진 필드만 갱신
 */
function update(args, ctx) {
  const box = argBox(args);
  const id = argId(args);
  if (!box || !id || !mdDocStore.ID_RE.test(id)) return { ok: false, code: 'BAD_INPUT' };

  const d = deps(ctx);
  const sctx = storeCtx(ctx);
  const state = readBox(box, ctx);
  const cur0 = mdDocStore.docsOf(state, box);
  const idx = cur0.findIndex((x) => x.id === id);
  if (idx < 0) return { ok: false, code: 'NOT_FOUND' }; // 다른 문서함의 문서는 못 고친다(격리)

  const cur = cur0[idx];
  const hasBody = typeof args.body === 'string';
  const hasTitle = typeof args.title === 'string';
  if (hasBody && args.body.length > mdDocStore.MAX_BODY) return { ok: false, code: 'LIMIT_SIZE' };

  const body = hasBody ? args.body : cur.body;
  // 제목을 명시하지 않았거나 비웠으면 본문에서 다시 파생(첫 제목/첫 줄) — 제목 없는 문서를 막는다.
  const title = hasTitle ? deriveTitle(args.title, body) : (cur.title || deriveTitle('', body));

  const docs = cur0.slice();
  docs[idx] = { id: cur.id, title, body, createdAt: cur.createdAt, updatedAt: d.now() };

  const next = mdDocStore.write(mdDocStore.withDocs(state, box, docs), sctx);
  const saved = mdDocStore.docsOf(next, box).find((x) => x.id === id);
  if (!saved) return { ok: false, code: 'WRITE_FAILED' };
  return { ok: true, doc: saved, docs: sortDocs(mdDocStore.docsOf(next, box)).map(toMeta) };
}

/** spip:md:remove — 삭제(그 문서함의 정확 id 일치 1건). */
function remove(args, ctx) {
  const box = argBox(args);
  const id = argId(args);
  if (!box || !id || !mdDocStore.ID_RE.test(id)) return { ok: false, code: 'BAD_INPUT' };

  const sctx = storeCtx(ctx);
  const state = readBox(box, ctx);
  const cur = mdDocStore.docsOf(state, box);
  const docs = cur.filter((x) => x.id !== id);
  if (docs.length === cur.length) return { ok: false, code: 'NOT_FOUND' };

  const next = mdDocStore.write(mdDocStore.withDocs(state, box, docs), sctx);
  return { ok: true, docs: sortDocs(mdDocStore.docsOf(next, box)).map(toMeta) };
}

/* ───── 불러오기 / 내보내기 (경로는 dialog 만이 만든다 — MD-H-1) ───── */

/**
 * spip:md:import — dialog(openFile) 로 마크다운 파일 1개를 읽어 새 문서로 적재.
 *   렌더러는 경로를 주입할 수 없다. dialog 결과도 재검증한다(정규 파일·크기 상한).
 */
async function importFile(args, ctx) {
  const box = argBox(args);
  if (!box) return { ok: false, code: 'BAD_INPUT' };

  const dialog = ctx && ctx.dialog;
  if (!dialog || typeof dialog.showOpenDialog !== 'function') return { ok: false, code: 'CANCELLED' };

  const d = deps(ctx);
  const state = readBox(box, ctx);
  if (mdDocStore.docsOf(state, box).length >= mdDocStore.MAX_DOCS) return { ok: false, code: 'LIMIT_DOCS' };

  const res = await dialog.showOpenDialog(ctx.win, {
    title: '마크다운 파일 불러오기',
    properties: ['openFile'],
    filters: [{ name: 'Markdown', extensions: IMPORT_EXTS }],
  });
  if (!res || res.canceled || !Array.isArray(res.filePaths) || res.filePaths.length === 0) {
    return { ok: false, code: 'CANCELLED' };
  }

  const picked = res.filePaths[0];

  // ★ dialog 필터는 신뢰 근거가 아니다 — 정규 파일·크기를 직접 재검증한다(M6-M-2 동형).
  let raw;
  try {
    const st = d.fs.statSync(picked);
    if (!st.isFile()) return { ok: false, code: 'NOT_FILE' };
    if (st.size > MAX_IMPORT_BYTES) return { ok: false, code: 'LIMIT_SIZE' };
    raw = d.fs.readFileSync(picked, 'utf8');
  } catch (_) {
    return { ok: false, code: 'READ_FAILED' }; // errno·절대경로 비노출(L-3)
  }

  // BOM 제거 후 정규화 — 상한 초과는 조용히 자르지 않고 거절.
  const body = String(raw).replace(/^﻿/, '');
  if (body.length > mdDocStore.MAX_BODY) return { ok: false, code: 'LIMIT_SIZE' };

  const fileTitle = path.basename(picked).replace(/\.[^.]+$/, '');
  return create({ box, title: deriveTitle('', body) || fileTitle, body }, ctx);
}

/**
 * spip:md:export — dialog(saveFile) 로 문서를 .md 파일로 저장.
 *   덮어쓰기 확인은 showSaveDialog 가 담당(조용한 덮어쓰기 없음). 성공 응답에 절대경로를 담지
 *   않는다 — 렌더러엔 파일명만 돌려준다(L-3).
 */
async function exportFile(args, ctx) {
  const box = argBox(args);
  const id = argId(args);
  if (!box || !id || !mdDocStore.ID_RE.test(id)) return { ok: false, code: 'BAD_INPUT' };

  const dialog = ctx && ctx.dialog;
  if (!dialog || typeof dialog.showSaveDialog !== 'function') return { ok: false, code: 'CANCELLED' };

  const d = deps(ctx);
  const state = readBox(box, ctx);
  const doc = mdDocStore.docsOf(state, box).find((x) => x.id === id);
  if (!doc) return { ok: false, code: 'NOT_FOUND' };

  const res = await dialog.showSaveDialog(ctx.win, {
    title: '마크다운 파일로 내보내기',
    defaultPath: safeFileName(doc.title),
    filters: [{ name: 'Markdown', extensions: ['md'] }],
  });
  if (!res || res.canceled || typeof res.filePath !== 'string' || !res.filePath) {
    return { ok: false, code: 'CANCELLED' };
  }

  try {
    d.fs.writeFileSync(res.filePath, doc.body, { encoding: 'utf8' });
  } catch (_) {
    return { ok: false, code: 'WRITE_FAILED' }; // errno·절대경로 비노출(L-3)
  }
  return { ok: true, name: path.basename(res.filePath) };
}

module.exports = {
  list,
  get,
  create,
  update,
  remove,
  importFile,
  exportFile,
  adoptLegacy,
  firstEditorBox,
  deriveTitle,
  safeFileName,
  sortDocs,
  toMeta,
  IMPORT_EXTS,
  MAX_IMPORT_BYTES,
};
