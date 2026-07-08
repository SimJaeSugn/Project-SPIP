'use strict';
/**
 * electron/ipc/explorer.js — 폴더 탐색기 위젯 IPC 핸들러 (EXP-H-1 / EXP-H-2)
 *
 *   spip:explorer:getRoots  → 등록된 열람 루트 목록
 *   spip:explorer:pickRoot  → dialog(openDirectory) 로 열람 루트 1개 등록(렌더러 경로 주입 불가)
 *   spip:explorer:removeRoot→ 등록 해제(정확 일치)
 *   spip:explorer:list      → 디렉터리 나열(루트 하위만)
 *   spip:explorer:open      → OS 기본 연결 프로그램으로 열기(shell.openPath)
 *   spip:explorer:reveal    → OS 파일 탐색기에서 보기(shell.showItemInFolder)
 *   spip:explorer:openWith  → 등록 툴(VS Code 등)로 열기(safeExec, 절대경로·shell:false·인자 [real])
 *   spip:explorer:mkdir     → 새 폴더
 *   spip:explorer:rename    → 이름 변경(덮어쓰기 금지)
 *   spip:explorer:trash     → 휴지통으로 보내기(shell.trashItem — 되돌릴 수 있는 파괴만)
 *
 * 보안 불변식(folders.js §4.2 의 "browseDir 없음" 결정을 최소로 완화한 대가로 반드시 유지):
 *   · EXP-H-1 — 모든 경로 인자는 browsePolicy.gate(canonicalize + 민감경로 deny + 등록 루트 포함)
 *       를 매 호출 통과한다. TOCTOU 축소를 위해 저장값이 아니라 **호출 시점**에 재게이트한다.
 *   · 렌더러는 열람 루트를 문자열로 등록할 수 없다 — pickRoot(dialog) 만이 루트를 만든다.
 *   · EXP-H-2 — 외부 실행은 safeExec(resolveBin·shell:false·인자 [real] 고정). 셸 인터폴레이션 0.
 *   · 쓰기(mkdir/rename)의 이름은 browsePolicy.sanitizeName 단일 세그먼트만. 삭제는 휴지통만.
 *   · 열람 루트 자기 자신은 rename/trash 불가(위젯 붕괴·의도치 않은 대규모 삭제 방지).
 *   · 실패는 고정 코드만 반환한다(절대경로·errno 문자열 비노출, L-3).
 *
 * [헤드리스 검증] Electron API 미import — dialog/shell/safeExec/resolveBin 은 ctx 주입(기본 실제 모듈).
 * 외부 의존성 0 — Node 내장(fs, path) + 내부(config, browsePolicy, toolRegistry, safeExec).
 */

const fs = require('fs');
const path = require('path');
const config = require('../../lib/common/config');
const pathGuard = require('../../lib/common/pathGuard');
const browsePolicy = require('../../lib/explorer/browsePolicy');
const toolRegistry = require('../../lib/common/toolRegistry');
const { resolveBin, safeExec } = require('../../lib/common/safeExec');

const MAX_ROOTS = config.LIMITS.maxExplorerRoots;
const MAX_INFLIGHT_OPEN = 2; // 경로별 열기 in-flight 상한(M-4, actions.js 동형)

/* ───── 내부 헬퍼 ───── */

/** ctx.config.explorerRoots(항상 배열). */
function rootsOf(ctx) {
  const r = ctx && ctx.config && ctx.config.explorerRoots;
  return Array.isArray(r) ? r : [];
}

/** ctx.config.explorerRoots 메모리 갱신 + 0600 원자적 영속. */
function persistRoots(roots, ctx) {
  config.persistConfigKeys({ explorerRoots: roots }, ctx);
  if (ctx && ctx.config) ctx.config.explorerRoots = roots;
}

/** args 에서 path 문자열만 꺼낸다(plain object 만). */
function argPath(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return null;
  return typeof args.path === 'string' ? args.path : null;
}

/** 경로 게이트 후 fs 로 디렉터리 여부까지 확인. deps.fs 주입 가능. */
function gateDir(raw, ctx) {
  const g = browsePolicy.gate(raw, rootsOf(ctx));
  if (!g.ok) return g;
  const _fs = (ctx && ctx.deps && ctx.deps.fs) || fs;
  try {
    if (!_fs.statSync(g.real).isDirectory()) return { ok: false, code: 'NOT_DIR' };
  } catch (_) {
    return { ok: false, code: 'PATH_GONE' };
  }
  return g;
}

/* ───── 루트 관리 ───── */

/** spip:explorer:getRoots — 등록된 열람 루트(실경로). */
function getRoots(_args, ctx) {
  return { ok: true, roots: rootsOf(ctx).slice(), max: MAX_ROOTS };
}

/**
 * spip:explorer:pickRoot — 네이티브 dialog 로 폴더 1개 선택 → 게이트 → 등록.
 *   렌더러가 경로를 주입하는 경로는 존재하지 않는다(EXP-H-1 ①).
 * @returns {Promise<{ok:true,roots:string[],added:string} | {ok:false,code:string}>}
 */
async function pickRoot(_args, ctx) {
  const dialog = ctx && ctx.dialog;
  if (!dialog || typeof dialog.showOpenDialog !== 'function') return { ok: false, code: 'CANCELLED' };

  const current = rootsOf(ctx);
  if (current.length >= MAX_ROOTS) return { ok: false, code: 'LIMIT' };

  const res = await dialog.showOpenDialog(ctx.win, {
    title: '탐색기에서 열람할 폴더 선택',
    properties: ['openDirectory'],
  });
  if (!res || res.canceled || !Array.isArray(res.filePaths) || res.filePaths.length === 0) {
    return { ok: false, code: 'CANCELLED' };
  }

  const g = browsePolicy.gateRoot(res.filePaths[0], ctx && ctx.deps);
  if (!g.ok) return { ok: false, code: g.code };

  // 중복(폴드 일치) — 이미 등록된 루트면 조용히 성공 처리(사용자가 같은 폴더를 다시 고른 경우).
  if (browsePolicy.isRootItself(g.real, current)) return { ok: true, roots: current.slice(), added: g.real };

  const next = current.concat([g.real]);
  persistRoots(next, ctx);
  return { ok: true, roots: next, added: g.real };
}

/** spip:explorer:removeRoot — 폴드 정확 일치 1건 해제(소멸한 루트도 해제 가능). */
function removeRoot(args, ctx) {
  const raw = argPath(args);
  if (raw === null || !raw || raw.length > browsePolicy.MAX_PATH_LEN) return { ok: false, code: 'BAD_INPUT' };
  const real = pathGuard.canonicalize(raw);
  const reqKey = pathGuard.foldForCompare(real || path.resolve(raw));

  const current = rootsOf(ctx);
  let matched = false;
  const next = [];
  for (const r of current) {
    if (!matched && pathGuard.foldForCompare(r) === reqKey) { matched = true; continue; }
    next.push(r);
  }
  if (!matched) return { ok: false, code: 'NOT_FOUND' };
  persistRoots(next, ctx);
  return { ok: true, roots: next };
}

/* ───── 열람 ───── */

/**
 * spip:explorer:list — 디렉터리 나열. path 미지정/빈 문자열이면 첫 루트로 폴백.
 * @returns {{ok:true,path,parent,root,entries,truncated,total} | {ok:false,code:string}}
 */
function list(args, ctx) {
  const roots = rootsOf(ctx);
  let raw = argPath(args);
  if (!raw) {
    if (roots.length === 0) return { ok: false, code: 'NO_ROOTS' };
    raw = roots[0];
  }
  const g = gateDir(raw, ctx);
  if (!g.ok) return g;

  const r = browsePolicy.listDir(g.real, ctx && ctx.deps);
  if (!r.ok) return r;
  return {
    ok: true,
    path: g.real,
    root: g.root,
    parent: browsePolicy.parentOf(g.real, roots),
    entries: r.entries,
    truncated: r.truncated,
    total: r.total,
  };
}

/* ───── 열기 액션 ───── */

/** spip:explorer:open — OS 기본 연결 프로그램(파일)·탐색기(폴더)로 연다. */
async function open(args, ctx) {
  const g = browsePolicy.gate(argPath(args), rootsOf(ctx));
  if (!g.ok) return g;
  const shell = ctx && ctx.shell;
  if (!shell || typeof shell.openPath !== 'function') return { ok: false, code: 'INTERNAL' };
  try {
    const err = await shell.openPath(g.real); // 성공 시 빈 문자열(throw 아님)
    if (err) return { ok: false, code: 'OPEN_FAILED' };
    return { ok: true, code: 'OPENING' };
  } catch (_) {
    return { ok: false, code: 'OPEN_FAILED' };
  }
}

/** spip:explorer:reveal — OS 파일 탐색기에서 항목을 선택된 상태로 보여준다. */
function reveal(args, ctx) {
  const g = browsePolicy.gate(argPath(args), rootsOf(ctx));
  if (!g.ok) return g;
  const shell = ctx && ctx.shell;
  if (!shell || typeof shell.showItemInFolder !== 'function') return { ok: false, code: 'INTERNAL' };
  try {
    shell.showItemInFolder(g.real); // 반환값 없음
    return { ok: true, code: 'OPENING' };
  } catch (_) {
    return { ok: false, code: 'OPEN_FAILED' };
  }
}

/**
 * spip:explorer:openWith — 등록된 외부 툴(기본 'code')로 연다.
 *   EXP-H-2: resolveTool 이 spawn 직전 force 재검증, 인자는 [real] 고정(사용자 args 없음).
 */
async function openWith(args, ctx) {
  const g = browsePolicy.gate(argPath(args), rootsOf(ctx));
  if (!g.ok) return g;

  const rawToolId = (args && typeof args === 'object') ? args.toolId : undefined;
  const toolId = (rawToolId === undefined || rawToolId === null || rawToolId === '') ? 'code' : rawToolId;
  if (!toolRegistry.isKnownToolId(toolId)) return { ok: false, code: 'TOOL_NOT_FOUND' };

  const rb = (ctx && typeof ctx.resolveBin === 'function') ? ctx.resolveBin : resolveBin;
  const exec = (ctx && typeof ctx.safeExec === 'function') ? ctx.safeExec : safeExec;
  const r = toolRegistry.resolveTool(toolId, (ctx && ctx.config) || {}, { resolveBin: rb });
  if (!r.bin) return { ok: false, code: toolId === 'code' ? 'CODE_CLI_NOT_FOUND' : 'TOOL_NOT_FOUND' };

  try {
    await exec(r.bin, [g.real], {
      shell: false,
      detached: true,
      inflightKey: 'explorer:open:' + toolId + ':' + g.real,
      maxInflight: MAX_INFLIGHT_OPEN,
    });
    return { ok: true, code: 'OPENING' };
  } catch (_) {
    return { ok: false, code: 'OPEN_FAILED' };
  }
}

/* ───── 쓰기 액션 ───── */

/**
 * spip:explorer:mkdir — path(디렉터리) 아래에 name 폴더 생성.
 *   name 은 단일 세그먼트만(sanitizeName) → 조립 경로가 부모 밖으로 나갈 수 없다.
 */
function mkdir(args, ctx) {
  const g = gateDir(argPath(args), ctx);
  if (!g.ok) return g;
  const name = browsePolicy.sanitizeName(args && args.name);
  if (name === null) return { ok: false, code: 'BAD_NAME' };

  const _fs = (ctx && ctx.deps && ctx.deps.fs) || fs;
  const target = path.join(g.real, name);
  try {
    if (_fs.existsSync(target)) return { ok: false, code: 'EXISTS' };
    _fs.mkdirSync(target);
  } catch (_) {
    return { ok: false, code: 'WRITE_FAILED' };
  }
  return { ok: true, path: target, name };
}

/**
 * spip:explorer:rename — path 항목의 이름을 name 으로 변경(같은 디렉터리 안).
 *   덮어쓰기 금지(fs.renameSync 는 기존 파일을 조용히 덮어쓴다 — 사전 존재 검사 필수).
 *   등록 루트 자기 자신은 대상에서 제외.
 */
function rename(args, ctx) {
  const roots = rootsOf(ctx);
  const g = browsePolicy.gate(argPath(args), roots);
  if (!g.ok) return g;
  if (browsePolicy.isRootItself(g.real, roots)) return { ok: false, code: 'ROOT_PROTECTED' };

  const name = browsePolicy.sanitizeName(args && args.name);
  if (name === null) return { ok: false, code: 'BAD_NAME' };

  const _fs = (ctx && ctx.deps && ctx.deps.fs) || fs;
  const target = path.join(path.dirname(g.real), name);
  if (target === g.real) return { ok: true, path: target, name }; // 변화 없음

  try {
    if (_fs.existsSync(target)) return { ok: false, code: 'EXISTS' };
    _fs.renameSync(g.real, target);
  } catch (_) {
    return { ok: false, code: 'WRITE_FAILED' };
  }
  return { ok: true, path: target, name };
}

/**
 * spip:explorer:trash — 항목을 휴지통으로 보낸다(shell.trashItem).
 *   영구 삭제(fs.rm) 표면은 만들지 않는다 — 되돌릴 수 있는 파괴만 허용.
 *   등록 루트 자기 자신은 대상에서 제외.
 */
async function trash(args, ctx) {
  const roots = rootsOf(ctx);
  const g = browsePolicy.gate(argPath(args), roots);
  if (!g.ok) return g;
  if (browsePolicy.isRootItself(g.real, roots)) return { ok: false, code: 'ROOT_PROTECTED' };

  const shell = ctx && ctx.shell;
  if (!shell || typeof shell.trashItem !== 'function') return { ok: false, code: 'INTERNAL' };
  try {
    await shell.trashItem(g.real);
  } catch (_) {
    return { ok: false, code: 'TRASH_FAILED' };
  }
  return { ok: true, path: g.real };
}

module.exports = {
  getRoots,
  pickRoot,
  removeRoot,
  list,
  open,
  reveal,
  openWith,
  mkdir,
  rename,
  trash,
  MAX_ROOTS,
  MAX_INFLIGHT_OPEN,
};
