'use strict';
/**
 * lib/common/paths.js — OS 앱 데이터 폴더 단일 해석 (N-06, ADR-003, P1-2, §8.2)
 *
 * 단일 OS 앱 데이터 디렉터리 아래 용도별 하위로 설정/캐시를 둔다.
 *   Win   : %APPDATA%\spip\
 *   macOS : ~/Library/Application Support/spip/
 *   Linux : $XDG_CONFIG_HOME/spip/  (없으면 ~/.config/spip/)
 *
 * 계약:
 *   appDir()      -> 앱 데이터 루트 절대경로
 *   configPath()  -> <appDir>/config/spip.config.json
 *   cachePath()   -> <appDir>/cache/projects.json
 *
 * [M-2] 디렉터리는 소유자 전용 권한(POSIX 0700)으로 생성한다. Windows ACL은
 *   별도 보장이 필요하나 본 모듈은 mode를 넘겨 생성하고(무시될 수 있음) 상세
 *   ACL 적용은 serializer/저장 단계에서 다룬다(S3). 여기서는 경로 해석과
 *   안전 권한 생성만 책임진다.
 *
 * 외부 의존성 0 — Node 내장 모듈만(os, path, fs).
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

const APP_NAME = 'spip';

// 소유자 전용 디렉터리 권한(POSIX). Windows에서는 무시될 수 있다.
const DIR_MODE = 0o700;

/**
 * OS별 앱 데이터 루트를 단일 해석한다.
 * 환경변수를 우선 사용하되, 부재 시 OS 규약 기본 경로로 폴백한다.
 * @returns {string} 앱 데이터 루트 절대경로(<root>/spip)
 */
function appDir() {
  const home = os.homedir();
  let base;

  if (process.platform === 'win32') {
    // %APPDATA%(Roaming). 부재 시 홈 하위 폴백.
    base = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
  } else if (process.platform === 'darwin') {
    base = path.join(home, 'Library', 'Application Support');
  } else {
    // Linux/기타 POSIX: XDG_CONFIG_HOME 우선, 없으면 ~/.config
    base = process.env.XDG_CONFIG_HOME && process.env.XDG_CONFIG_HOME.trim()
      ? process.env.XDG_CONFIG_HOME
      : path.join(home, '.config');
  }

  return path.join(base, APP_NAME);
}

/** 설정 파일 절대경로 — <appDir>/config/spip.config.json (§8.2) */
function configPath() {
  return path.join(appDir(), 'config', 'spip.config.json');
}

/** 스냅샷(캐시) 파일 절대경로 — <appDir>/cache/projects.json (§8.1, N-06) */
function cachePath() {
  return path.join(appDir(), 'cache', 'projects.json');
}

/** UI 상태(즐겨찾기·순서·정렬모드) 파일 절대경로 — <appDir>/ui-state/ui-state.json (M6 §3.2) */
function uiStatePath() {
  return path.join(appDir(), 'ui-state', 'ui-state.json');
}

/** 메일 보관함(계정별·메일함별 수집 메일 메타데이터) 파일 절대경로 — <appDir>/mail/mail-archive.json
 *   ui-state.json(1MB 상한)과 분리해 대용량 메일 메타가 UI 상태를 오염/초과시키지 않게 한다. */
function mailArchivePath() {
  return path.join(appDir(), 'mail', 'mail-archive.json');
}

/**
 * 주어진 파일 경로의 상위 디렉터리를 소유자 전용 권한으로 보장 생성한다(M-2).
 * 이미 존재하면 권한 변경을 시도하지 않는다(idempotent).
 * @param {string} filePath 파일 절대경로
 * @returns {string} 생성/확인된 디렉터리 경로
 */
function ensureDirFor(filePath) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  return dir;
}

module.exports = { appDir, configPath, cachePath, uiStatePath, mailArchivePath, ensureDirFor, APP_NAME, DIR_MODE };
