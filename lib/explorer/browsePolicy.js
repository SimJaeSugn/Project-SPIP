'use strict';
/**
 * lib/explorer/browsePolicy.js — 폴더 탐색기 위젯의 경로 정책·디렉터리 나열 (EXP-H-1)
 *
 * 배경(중요): electron/ipc/folders.js 는 "browseDir 채널 없음 — 임의 디렉터리 열람 표면 제거"를
 *   EM-H-1 결정으로 못박았다. 탐색기 위젯은 그 표면을 **되살리되 최소로 좁혀** 도입한다.
 *   되살리는 근거는 "사용자가 네이티브 dialog 로 명시 선택한 폴더"라는 인가(consent)이고,
 *   좁히는 수단은 아래 3중 게이트다. 임의 경로 문자열 입력 채널은 **여전히 없다**.
 *
 *   ① 열람 루트는 dialog(main 주도)로만 등록된다 — 렌더러가 문자열로 루트를 주입할 수 없다.
 *   ② 모든 경로는 pathPolicy.gate() 로 canonicalize(H-1) + 민감/시스템/자격 디렉토리 deny.
 *      → 등록 루트 안이라도 ~/.ssh, %WINDIR% 하위 등은 열람·조작 불가. 드라이브 루트 등록 불가.
 *   ③ 그 실경로가 등록된 열람 루트(config.explorerRoots)의 하위인지 pathGuard.isWithinRoot 로 검증.
 *      canonicalize 가 심링크/junction 을 먼저 해소하므로 루트 안의 심링크로 밖을 가리켜도 거부된다.
 *
 * 쓰기(mkdir/rename/trash)는 위 게이트를 통과한 경로에만, 그리고 **이름은 별도 sanitizeName** 을
 *   통과한 단일 세그먼트만 허용한다(구분자·'..'·예약문자·제어문자 차단 → 경로 조립 이탈 불가).
 *   삭제는 fs.rm 이 아니라 shell.trashItem(휴지통) — 되돌릴 수 있는 파괴만 허용한다(핸들러 책임).
 *   루트 자기 자신은 rename/trash 대상에서 제외한다(사용자가 루트를 지우면 위젯이 붕괴).
 *
 * 외부 의존성 0 — Node 내장(fs, path) + 내부(pathGuard, pathPolicy)만.
 * fs 는 deps 주입 가능(헤드리스 단위테스트).
 */

const fs = require('fs');
const path = require('path');
const pathGuard = require('../common/pathGuard');
const pathPolicy = require('../common/pathPolicy');

const MAX_PATH_LEN = 4096;   // 입력 경로 1차 상한(folders.js 와 동일)
const MAX_NAME_LEN = 255;    // 단일 세그먼트 이름 상한(대부분 FS의 NAME_MAX)
const MAX_ENTRIES = 2000;    // 한 디렉터리에서 렌더러로 회송할 항목 수 상한(거대 디렉터리 방어)

// 경로 구분자·드라이브 콜론·와일드카드·리다이렉트·제어문자 — 단일 세그먼트 이름에 올 수 없다.
const BAD_NAME_RE = new RegExp('[\\\\/:*?"<>|\\u0000-\\u001f]');
// Windows 예약 장치명(확장자 유무 무관). 대소문자 무시.
const WIN_RESERVED_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;

/**
 * 단일 세그먼트 파일/폴더 이름을 검증한다(생성·이름변경 입력).
 *   경로 조립 이탈('..', 구분자)·예약명·후행 점/공백(Windows 에서 사라짐)을 모두 거부한다.
 * @param {*} raw
 * @returns {string|null} 정규화된 이름 또는 거부 시 null
 */
function sanitizeName(raw) {
  if (typeof raw !== 'string') return null;
  let name;
  try {
    name = raw.normalize('NFC').trim();
  } catch (_) {
    return null;
  }
  if (!name || name.length > MAX_NAME_LEN) return null;
  if (name === '.' || name === '..') return null;
  if (BAD_NAME_RE.test(name)) return null;
  if (WIN_RESERVED_RE.test(name)) return null;
  if (/[. ]$/.test(name)) return null; // Windows 는 후행 점/공백을 조용히 잘라낸다 → 의도치 않은 대상
  return name;
}

/**
 * 열람 대상 경로를 게이트한다 — 길이 → pathPolicy.gate(canonicalize + deny) → 루트 포함 검증.
 * @param {*} rawPath 렌더러가 보낸 원시 경로(비신뢰)
 * @param {string[]} roots config.explorerRoots(canonicalize된 실경로)
 * @returns {{ok:true,real:string,root:string} | {ok:false,code:'BAD_INPUT'|'PATH_GONE'|'PATH_DENIED'|'PATH_NOT_ALLOWED'}}
 */
function gate(rawPath, roots) {
  if (typeof rawPath !== 'string' || rawPath.length === 0 || rawPath.length > MAX_PATH_LEN) {
    return { ok: false, code: 'BAD_INPUT' };
  }
  const g = pathPolicy.gate(rawPath); // ① canonicalize(H-1) ② 시스템/자격/드라이브루트 deny
  if (!g.ok) return { ok: false, code: g.code };
  const root = pathGuard.findContainingRoot(g.real, roots); // ③ 등록 루트 하위인가
  if (!root) return { ok: false, code: 'PATH_NOT_ALLOWED' };
  return { ok: true, real: g.real, root };
}

/**
 * 열람 루트 등록 후보를 게이트한다 — gate() 와 같되 루트 포함 검증(③)은 하지 않는다.
 *   호출부(핸들러)는 dialog 결과만 넘긴다. 디렉터리 여부까지 확인한다.
 * @param {*} rawPath
 * @param {object} [deps] { fs }
 * @returns {{ok:true,real:string} | {ok:false,code:'BAD_INPUT'|'PATH_GONE'|'PATH_DENIED'|'NOT_DIR'}}
 */
function gateRoot(rawPath, deps) {
  const _fs = (deps && deps.fs) || fs;
  if (typeof rawPath !== 'string' || rawPath.length === 0 || rawPath.length > MAX_PATH_LEN) {
    return { ok: false, code: 'BAD_INPUT' };
  }
  const g = pathPolicy.gate(rawPath);
  if (!g.ok) return { ok: false, code: g.code };
  try {
    if (!_fs.statSync(g.real).isDirectory()) return { ok: false, code: 'NOT_DIR' };
  } catch (_) {
    return { ok: false, code: 'PATH_GONE' };
  }
  return { ok: true, real: g.real };
}

/** 실경로가 등록된 열람 루트 자기 자신인가(rename/trash 보호 대상). */
function isRootItself(real, roots) {
  const key = pathGuard.foldForCompare(real);
  if (!key) return false;
  const list = Array.isArray(roots) ? roots : [];
  return list.some((r) => pathGuard.foldForCompare(r) === key);
}

/**
 * 상위 디렉터리 실경로. 루트 자신이거나 FS 최상단이면 null(위로 못 올라감).
 * @param {string} real gate() 통과 실경로(디렉터리)
 * @param {string[]} roots
 * @returns {string|null}
 */
function parentOf(real, roots) {
  if (isRootItself(real, roots)) return null;
  const up = path.dirname(real);
  if (!up || up === real) return null;
  return up;
}

/**
 * 항목 종류 판정 — 심링크는 **따라가지 않고**(lstat 기준) symlink 로 표시한다.
 *   심링크 대상이 루트 밖이면 진입 시 gate()가 거부하므로, 여기서는 표시만 한다.
 */
function classify(dirent) {
  if (dirent.isSymbolicLink()) return 'symlink';
  if (dirent.isDirectory()) return 'dir';
  if (dirent.isFile()) return 'file';
  return 'other';
}

/**
 * 디렉터리를 나열한다. 정렬: 폴더 먼저 → 이름(로케일) 오름차순.
 *   size/mtime 은 lstat(심링크 미추적)로 수집하고, 실패한 항목은 null 로 남긴다(개별 실패 무시).
 *   MAX_ENTRIES 초과 시 잘라내고 truncated=true — 조용한 절단을 만들지 않는다.
 *
 * @param {string} real gate() 통과 디렉터리 실경로
 * @param {object} [deps] { fs }
 * @returns {{ok:true,entries:Array,truncated:boolean,total:number} | {ok:false,code:'PATH_GONE'|'NOT_DIR'|'READ_FAILED'}}
 */
function listDir(real, deps) {
  const _fs = (deps && deps.fs) || fs;
  let dirents;
  try {
    dirents = _fs.readdirSync(real, { withFileTypes: true });
  } catch (err) {
    const code = err && err.code;
    if (code === 'ENOENT') return { ok: false, code: 'PATH_GONE' };
    if (code === 'ENOTDIR') return { ok: false, code: 'NOT_DIR' };
    return { ok: false, code: 'READ_FAILED' }; // EPERM/EACCES 등 — 내부정보 비노출(L-3)
  }

  const total = dirents.length;
  const truncated = total > MAX_ENTRIES;
  const slice = truncated ? dirents.slice(0, MAX_ENTRIES) : dirents;

  const entries = slice.map((d) => {
    const kind = classify(d);
    let size = null;
    let mtime = null;
    try {
      const st = _fs.lstatSync(path.join(real, d.name));
      size = (kind === 'file') ? st.size : null;
      mtime = st.mtimeMs;
    } catch (_) { /* 개별 stat 실패는 무시(항목은 이름만으로 표시) */ }
    return { name: d.name, kind, size, mtime, hidden: d.name.charAt(0) === '.' };
  });

  entries.sort((a, b) => {
    const ad = a.kind === 'dir' ? 0 : 1;
    const bd = b.kind === 'dir' ? 0 : 1;
    if (ad !== bd) return ad - bd;
    return a.name.localeCompare(b.name, 'ko');
  });

  return { ok: true, entries, truncated, total };
}

module.exports = {
  gate,
  gateRoot,
  isRootItself,
  parentOf,
  listDir,
  sanitizeName,
  MAX_PATH_LEN,
  MAX_NAME_LEN,
  MAX_ENTRIES,
};
