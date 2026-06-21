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

// 프로젝트 판별 신호 파일/폴더. 존재 여부만 본다(내용 파싱은 수집기 단계).
const SIGNAL_ENTRIES = Object.freeze([
  { name: '.git', signal: 'git' },
  { name: 'package.json', signal: 'package.json' },
  { name: '.vscode', signal: 'vscode' },
  { name: '*.code-workspace', signal: 'vscode' }, // 글로브가 아니라 확장자 검사로 처리
  { name: 'pyproject.toml', signal: 'python' },
  { name: 'Cargo.toml', signal: 'rust' },
  { name: 'go.mod', signal: 'go' },
  { name: 'pom.xml', signal: 'java' },
  { name: 'build.gradle', signal: 'java' },
  { name: 'composer.json', signal: 'php' },
  { name: 'Gemfile', signal: 'ruby' },
  { name: '*.csproj', signal: 'dotnet' },
  { name: '*.sln', signal: 'dotnet' },
]);

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

  const nameSet = new Set(names);
  const signals = new Set();

  for (const entry of SIGNAL_ENTRIES) {
    if (entry.name.startsWith('*.')) {
      // 확장자 신호: 정확 일치가 아니라 확장자 비교(선형, ReDoS 없음).
      const ext = entry.name.slice(1).toLowerCase(); // '.code-workspace'
      for (const n of names) {
        if (typeof n === 'string' && n.toLowerCase().endsWith(ext)) {
          signals.add(entry.signal);
          break;
        }
      }
    } else if (nameSet.has(entry.name)) {
      signals.add(entry.signal);
    }
  }

  return { isProject: signals.size > 0, signals: Array.from(signals) };
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

    const res = detect(dir, ctx);
    if (res.isProject) {
      acceptedPrefixes.push(foldKey);
      yield { path: dir, signals: res.signals };
    }
  }
}

module.exports = { detect, detectStream, SIGNAL_ENTRIES };
