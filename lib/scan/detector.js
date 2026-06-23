'use strict';
/**
 * lib/scan/detector.js — VS Code 프로젝트 판별 (R-01, N-05)
 *
 * 후보 디렉터리가 프로젝트인지 신호(signals)로 판별한다. 인사이트 수집은 안 함.
 *   신호: .git · package.json · .vscode · 기타 프로젝트 매니페스트
 * 중첩 시 최상위 1건만 프로젝트로 집계한다(하위 프로젝트는 부모가 잡으면 스킵).
 *
 * [N-05] 한 폴더의 신호 검사 실패가 전체 스캔을 죽이지 않도록 try 격리 + warnings 누적.
 *
 * 외부 의존성 0 — fs, path만.
 */

const fs = require('fs');
const path = require('path');
const pathGuard = require('../common/pathGuard');
const config = require('../common/config'); // 기본 시그널(미전달 시 폴백) 단일 원천

/**
 * 시그널 패턴 배열 → 컴파일된 매처. 패턴은 3종(제외 항목과 동일 문법):
 *   · 정규식 `/.../ ` → RegExp(엔트리 이름에 test)
 *   · 확장자 글로브 `*.ext` → 소문자 endsWith
 *   · 그 외 → 정확한 이름(Set)
 * 사용자 설정(config.detectSignals)으로 관리되며, 미설정 시 config.DEFAULTS가 시드.
 * @param {string[]} patterns
 */
function buildSignalMatcher(patterns) {
  const list = Array.isArray(patterns) ? patterns : [];
  const exact = new Set();
  const exts = [];
  const regexes = [];
  for (const p of list) {
    if (typeof p !== 'string' || !p) continue;
    if (/^\/.+\/[gimsuy]*$/.test(p)) {
      const m = /^\/(.+)\/([gimsuy]*)$/.exec(p);
      try { regexes.push(new RegExp(m[1], m[2].replace(/[gy]/g, ''))); } catch (_) { /* 잘못된 정규식 무시 */ }
    } else if (p.startsWith('*.')) {
      exts.push(p.slice(1).toLowerCase());
    } else {
      exact.add(p);
    }
  }
  return { exact, exts, regexes };
}

/**
 * 디렉터리의 직접 자식 엔트리 이름 집합을 안전히 읽는다(격리).
 * @returns {string[]|null}
 */
function readEntryNames(dir, logger) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).map((e) => e.name);
  } catch (_) {
    if (logger) logger.warn('프로젝트 판별용 디렉터리 읽기 실패', { path: dir });
    return null;
  }
}

/**
 * 후보 디렉터리가 프로젝트인지 판별한다(R-01).
 * @param {string} dir canonical 실경로
 * @param {object} [ctx] { logger }
 * @returns {{ isProject:boolean, signals:string[] }}
 */
function detect(dir, ctx) {
  ctx = ctx || {};
  const names = readEntryNames(dir, ctx.logger);
  if (names === null) return { isProject: false, signals: [] };

  // ctx.matcher(미리 컴파일) 우선, 없으면 ctx.signals(또는 기본값)로 즉석 컴파일.
  const matcher = ctx.matcher || buildSignalMatcher(ctx.signals || config.DEFAULTS.detectSignals);
  const nameSet = new Set(names);
  const matched = new Set();

  for (const e of matcher.exact) if (nameSet.has(e)) matched.add(e);
  if (matcher.exts.length || matcher.regexes.length) {
    for (const n of names) {
      if (typeof n !== 'string') continue;
      const low = n.toLowerCase();
      for (const ext of matcher.exts) if (low.endsWith(ext)) matched.add('*' + ext);
      for (const re of matcher.regexes) if (re.test(n)) matched.add('/' + re.source + '/');
    }
  }

  return { isProject: matched.size > 0, signals: Array.from(matched) };
}

/**
 * 후보 스트림에서 프로젝트를 판별하되, 중첩 프로젝트는 최상위 1건만 집계한다.
 * walker가 DFS로 부모를 자식보다 먼저 방출하므로, 이미 등록된 프로젝트의 하위 경로는
 * 건너뛴다(접두사 검사, 폴드 키 기준).
 *
 * @param {Iterable<string>} candidateStream walker.walk() 결과(canonical 실경로)
 * @param {object} [ctx] { logger }
 * @returns {Generator<{ path:string, signals:string[] }>}
 */
function* detectStream(candidateStream, ctx) {
  ctx = ctx || {};
  // 시그널 매처를 1회 컴파일해 detect에 전달(후보마다 정규식 재컴파일 방지).
  const dctx = Object.assign({}, ctx, { matcher: buildSignalMatcher(ctx.signals || config.DEFAULTS.detectSignals) });
  // 이미 확정된 프로젝트 루트의 폴드 키(+구분자) 목록. 하위 경로 스킵용.
  const acceptedPrefixes = [];

  for (const dir of candidateStream) {
    const foldKey = pathGuard.foldForCompare(dir);
    // 이미 등록된 프로젝트의 하위면 스킵(중첩 최상위 1건, R-01).
    let nested = false;
    for (const pref of acceptedPrefixes) {
      if (foldKey === pref || foldKey.startsWith(pref + path.sep) || foldKey.startsWith(pref + '/')) {
        nested = true;
        break;
      }
    }
    if (nested) continue;

    const res = detect(dir, dctx);
    if (res.isProject) {
      acceptedPrefixes.push(foldKey);
      yield { path: dir, signals: res.signals };
    }
  }
}

module.exports = { detect, detectStream, buildSignalMatcher };
