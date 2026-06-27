'use strict';
/**
 * lib/shelf/localMeta.js — 폴더/파일 로컬 메타 수집 (SH-2)
 *
 * canonicalize(pathGuard) 통과한 실경로에서 표시 메타(name/title/sub/desc/color/mono/cat/status)를
 * 수집한다. 초안(favorites-shelf-widget.dc.html)의 folderMeta/fileMeta 표시필드 의도를 따르되,
 * 더미 메타(DB/random) 대신 실제 fs 수집으로 대체한다.
 *   - folder: 얕은 순회로 파일 수·용량 근사(size 수집기 measureTree 규약 차용 — deadline/maxDepth/
 *     maxEntries 예산·심링크 미추적), stack 추정(이름 휴리스틱), 수정시각.
 *   - file: 확장자→언어/모노/색, 크기·수정시각.
 *
 * 메타 문자열의 sanitize·길이상한은 영속 경계(uiStateStore.normalizeShelfBookmarks)가 단일
 * 책임으로 적용한다 — 본 모듈은 원시 표시값만 생성한다(L-1 최종 방어는 normalize + 렌더러 textContent).
 *
 * 외부 의존성 0 — Node 내장(fs, path, os)만.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

// 폴더 메타 수집 예산(저비용 근사). size 수집기보다 보수적(즉시성 우선).
const FOLDER_BUDGET_MS = 800;
const FOLDER_MAX_DEPTH = 4;
const FOLDER_MAX_ENTRIES = 20000;

// 폴더 이름 휴리스틱 → 카테고리/색/설명(초안 folderMeta 포팅).
const FOLDER_STACKS = [
  { k: /react|next|web|ui|design|front/i, cat: 'React · TS', color: '#2563eb', desc: 'React/프론트엔드 계열 디렉토리' },
  { k: /py|python|ml|data|tool/i, cat: 'Python', color: '#2f8f4e', desc: 'Python/데이터 계열 디렉토리' },
  { k: /api|server|go|svc|backend/i, cat: 'Backend', color: '#0e7490', desc: '백엔드/서비스 디렉토리' },
  { k: /.*/, cat: '폴더', color: '#6d28d9', desc: '로컬 디렉토리' },
];

// 확장자 → 언어/모노/색(초안 fileMeta 포팅 + 확장).
const FILE_EXT_MAP = {
  ts: { lang: 'TypeScript', mono: 'TS', color: '#2563eb' },
  tsx: { lang: 'TypeScript', mono: 'TSX', color: '#2563eb' },
  js: { lang: 'JavaScript', mono: 'JS', color: '#a98a13' },
  jsx: { lang: 'JavaScript', mono: 'JSX', color: '#a98a13' },
  mjs: { lang: 'JavaScript', mono: 'JS', color: '#a98a13' },
  cjs: { lang: 'JavaScript', mono: 'JS', color: '#a98a13' },
  py: { lang: 'Python', mono: 'PY', color: '#2f8f4e' },
  md: { lang: 'Markdown', mono: 'MD', color: '#525252' },
  json: { lang: 'JSON', mono: '{}', color: '#9a6700' },
  css: { lang: 'CSS', mono: 'CSS', color: '#0e7490' },
  scss: { lang: 'SCSS', mono: 'SCS', color: '#c4477f' },
  html: { lang: 'HTML', mono: '<>', color: '#c4502e' },
  go: { lang: 'Go', mono: 'GO', color: '#0e7490' },
  rs: { lang: 'Rust', mono: 'RS', color: '#b7410e' },
  sh: { lang: 'Shell', mono: 'SH', color: '#3f6212' },
  java: { lang: 'Java', mono: 'JV', color: '#b07219' },
  c: { lang: 'C', mono: 'C', color: '#555555' },
  cpp: { lang: 'C++', mono: 'C++', color: '#f34b7d' },
  yml: { lang: 'YAML', mono: 'YML', color: '#6d28d9' },
  yaml: { lang: 'YAML', mono: 'YML', color: '#6d28d9' },
  txt: { lang: 'Text', mono: 'TXT', color: '#57534e' },
};

/** 경로 마지막 세그먼트. */
function lastSeg(p) {
  return String(p || '').replace(/[/\\]+$/, '').split(/[/\\]/).pop() || '';
}

/** 홈 디렉토리를 ~로 치환해 표시용 경로를 정돈. */
function tidyPath(p) {
  const s = String(p || '');
  const home = os.homedir();
  if (!home) return s;
  const lower = s.toLowerCase();
  const hl = home.toLowerCase();
  if (lower === hl) return '~';
  if (lower.startsWith(hl + path.sep.toLowerCase()) || lower.startsWith(hl + '/')) {
    return '~' + s.slice(home.length);
  }
  return s;
}

/** 바이트를 사람이 읽는 단위로(0B/12KB/3.4MB). */
function humanBytes(n) {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return '0B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i += 1; }
  return (i === 0 ? String(Math.round(v)) : v.toFixed(1)) + u[i];
}

/** ms epoch → 'YYYY-MM-DD'(표시용). 무효 시 ''. */
function fmtDate(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '';
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + day;
}

/** 폴더명 휴리스틱 → stack 메타. */
function stackMeta(name) {
  return FOLDER_STACKS.find((x) => x.k.test(name)) || FOLDER_STACKS[FOLDER_STACKS.length - 1];
}

/** 확장자 → 파일 메타(미지 확장자는 확장자 대문자/기본 색). */
function fileMeta(ext) {
  const d = FILE_EXT_MAP[ext];
  if (d) return d;
  return {
    lang: ext ? ext.toUpperCase() : '파일',
    mono: ext ? ext.slice(0, 3).toUpperCase() : 'F',
    color: '#57534e',
  };
}

/**
 * 폴더를 얕게 순회해 파일 수·총 바이트를 근사한다(예산·깊이·entry 상한, 심링크 미추적).
 *   size 수집기(measureTree)와 동일 규약. 상한 도달 시 truncated=true(부분 측정 신호).
 * @param {string} root canonical 실경로
 * @returns {{ files:number, bytes:number, truncated:boolean }}
 */
function walkFolder(root) {
  const deadlineTs = Date.now() + FOLDER_BUDGET_MS;
  let files = 0;
  let bytes = 0;
  let entries = 0;
  let truncated = false;
  const stack = [{ dir: root, depth: 0 }];

  while (stack.length > 0) {
    if (entries >= FOLDER_MAX_ENTRIES || Date.now() > deadlineTs) { truncated = true; break; }
    const { dir, depth } = stack.pop();
    let list;
    try {
      list = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      continue; // 권한 거부 등 격리
    }
    for (const ent of list) {
      if (entries >= FOLDER_MAX_ENTRIES || Date.now() > deadlineTs) { truncated = true; break; }
      entries += 1;
      if (ent.isSymbolicLink()) continue; // 미추적(루프·이중계상 방지)
      if (ent.isDirectory()) {
        if (depth >= FOLDER_MAX_DEPTH) { truncated = true; continue; }
        stack.push({ dir: path.join(dir, ent.name), depth: depth + 1 });
        continue;
      }
      if (!ent.isFile()) continue;
      files += 1;
      try {
        const st = fs.lstatSync(path.join(dir, ent.name));
        if (st.isFile()) bytes += st.size;
      } catch (_) { /* 격리 */ }
    }
  }
  return { files, bytes, truncated };
}

/**
 * 폴더 메타 수집. real은 canonicalize·deny 게이트를 통과한 실경로(디렉토리)여야 한다.
 * @param {string} real
 * @returns {object} { name,title,sub,desc,color,mono,cat,status }
 */
function collectFolder(real) {
  const name = lastSeg(real) || real;
  const sm = stackMeta(name);
  let mtime = null;
  try { mtime = fs.statSync(real).mtimeMs; } catch (_) { /* graceful */ }
  let res = { files: 0, bytes: 0, truncated: false };
  try { res = walkFolder(real); } catch (_) { res.truncated = true; }
  const sizeStr = humanBytes(res.bytes) + (res.truncated ? '+' : '');
  const dateStr = mtime ? ' · 수정 ' + fmtDate(mtime) : '';
  return {
    name,
    title: name,
    sub: tidyPath(real),
    desc: sm.desc,
    color: sm.color,
    mono: (name.charAt(0) || 'D').toUpperCase(),
    cat: sm.cat,
    status: res.files + '개 파일 · ' + sizeStr + dateStr,
  };
}

/**
 * 파일 메타 수집. real은 canonicalize·deny 게이트를 통과한 실경로(파일)여야 한다.
 * @param {string} real
 * @returns {object} { name,title,sub,desc,color,mono,cat,status }
 */
function collectFile(real) {
  const name = lastSeg(real) || real;
  const ext = (name.indexOf('.') >= 0 ? name.split('.').pop() : '').toLowerCase();
  const m = fileMeta(ext);
  let size = 0;
  let mtime = null;
  try {
    const st = fs.statSync(real);
    size = st.size;
    mtime = st.mtimeMs;
  } catch (_) { /* graceful */ }
  const dateStr = mtime ? ' · 수정 ' + fmtDate(mtime) : '';
  return {
    name,
    title: name,
    sub: tidyPath(real),
    desc: m.lang + ' 파일',
    color: m.color,
    mono: m.mono,
    cat: m.lang,
    status: humanBytes(size) + dateStr,
  };
}

/**
 * 유형별 메타 수집 디스패치.
 * @param {string} real canonical 실경로
 * @param {'folder'|'file'} type
 * @returns {object} 표시 메타
 */
function collect(real, type) {
  if (type === 'folder') return collectFolder(real);
  return collectFile(real);
}

module.exports = {
  collect,
  collectFolder,
  collectFile,
  walkFolder,
  humanBytes,
  fmtDate,
  tidyPath,
  lastSeg,
  stackMeta,
  fileMeta,
};
