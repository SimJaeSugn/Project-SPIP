'use strict';
/**
 * lib/shelf/pathPolicy.js — 임의 경로 북마크 보안 정책 (SH-1, ADR-SH-4)
 *
 * 셸프의 folder/file 북마크는 프로젝트가 아니므로 scanRoots 화이트리스트 강제가 부적절하다
 * (사용자가 직접 추가). 대신 다음 3중 정책을 적용한다(설계 §10).
 *   ① pathGuard.canonicalize(H-1) — 심링크/junction 해소·NFC·절대경로화. 실패 시 PATH_GONE.
 *   ② 민감/시스템 경로 deny 게이트 — 드라이브 루트·OS 시스템 디렉토리·자격(비밀) 디렉토리 차단.
 *        통과(=거부) 시 PATH_DENIED.
 * gate(ref)는 add·open 양쪽에서 호출해 재게이트한다(TOCTOU 축소). 저장 후 경로가 시스템
 * 디렉토리로 바뀌었으면 열기 시점에 거부된다.
 *
 * 비교는 pathGuard.foldForCompare로 폴드(대소문자 비민감 FS 일관). 시스템/자격 디렉토리는
 * 접두(하위 포함) 매칭으로 차단하되, 사용자 홈의 일반 하위(프로젝트·문서 등)는 허용한다.
 *
 * 외부 의존성 0 — Node 내장(os, path) + 내부(pathGuard)만.
 */

const os = require('os');
const path = require('path');
const pathGuard = require('../common/pathGuard');

const IS_WIN = process.platform === 'win32';
const IS_DARWIN = process.platform === 'darwin';

/**
 * deny 접두 디렉토리 목록을 OS·환경에 맞춰 구성한다.
 *   - 시스템 디렉토리(접두 매칭, 하위 포함)
 *   - 사용자 홈의 자격/비밀 디렉토리(.ssh/.aws/.gnupg/.config/gh 등)
 * @returns {string[]} 원시 경로 목록(폴드 비교는 isDenied에서)
 */
function denyDirs() {
  const home = os.homedir();
  const dirs = [];

  if (IS_WIN) {
    const winDir = process.env.WINDIR || process.env.SystemRoot || 'C:\\Windows';
    const pf = process.env.ProgramFiles || 'C:\\Program Files';
    const pfx86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const progData = process.env.ProgramData || 'C:\\ProgramData';
    dirs.push(winDir, pf, pfx86, progData);
  } else {
    dirs.push('/etc', '/sys', '/proc', '/dev', '/usr', '/bin', '/sbin', '/boot', '/lib', '/var');
    if (IS_DARWIN) {
      dirs.push('/System', '/Library', '/private/etc', '/private/var');
    }
  }

  if (home) {
    // 자격/비밀 디렉토리 — 접두 차단(폴드). 플랫폼 공통.
    dirs.push(
      path.join(home, '.ssh'),
      path.join(home, '.aws'),
      path.join(home, '.gnupg'),
      path.join(home, '.gcloud'),
      path.join(home, '.azure'),
      path.join(home, '.kube'),
      path.join(home, '.docker'),
      path.join(home, '.config', 'gh'),
    );
  }

  return dirs;
}

/** deny 디렉토리를 비교용 폴드 키로 변환(존재하면 realpath, 없으면 resolve). */
function foldDir(d) {
  const c = pathGuard.canonicalize(d) || path.resolve(d);
  return pathGuard.foldForCompare(c);
}

/** 드라이브/파일시스템 루트인가(C:\, D:\, /). real은 canonicalize된 실경로. */
function isFsRoot(real) {
  const key = pathGuard.foldForCompare(real);
  if (!key) return true;
  if (IS_WIN) return /^[a-z]:$/.test(key); // foldForCompare가 후행 구분자 제거 → 'c:'
  return key === '/' || key === '';
}

/**
 * 실경로가 민감/시스템/자격 경로(또는 그 하위)인지 판정한다(거부 대상이면 true).
 * @param {string} real canonicalize된 실경로(원형)
 * @returns {boolean} true=거부(민감), false=허용
 */
function isDenied(real) {
  if (typeof real !== 'string' || !real) return true;
  const key = pathGuard.foldForCompare(real);
  if (!key) return true;
  if (isFsRoot(real)) return true;

  const sep = IS_WIN ? '\\' : '/';
  for (const d of denyDirs()) {
    const dk = foldDir(d);
    if (!dk) continue;
    // 정확 일치(디렉토리 자체) 또는 접두 하위(dk + 구분자) — 부분 토큰 오탐 방지.
    if (key === dk || key.startsWith(dk + sep)) return true;
    // POSIX 루트(/) 접미는 dk가 이미 '/x' 형태라 위 분기로 충분. Windows는 sep='\\'.
  }
  return false;
}

/**
 * 북마크 경로를 게이트한다 — canonicalize(H-1) → deny 게이트.
 * @param {string} rawRef 원시 경로(저장된 ref 또는 사용자 입력)
 * @returns {{ ok:boolean, real:string|null, code:string|null }}
 *   ok=true면 real(실경로) 사용 가능. ok=false면 code∈{'PATH_GONE','PATH_DENIED'}.
 */
function gate(rawRef) {
  const real = pathGuard.canonicalize(rawRef);
  if (real === null) return { ok: false, real: null, code: 'PATH_GONE' };
  if (isDenied(real)) return { ok: false, real: null, code: 'PATH_DENIED' };
  return { ok: true, real, code: null };
}

module.exports = { gate, isDenied, isFsRoot, denyDirs };
