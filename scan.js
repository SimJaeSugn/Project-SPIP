#!/usr/bin/env node
'use strict';
/**
 * scan.js — CLI 스캐너 진입점 (bin: spip) (R-14, R-04, N-05, N-06)
 *
 * 흐름(설계 §4 스캔 페이즈):
 *   1) 설정 로드(CLI 인자 → 파일 → 기본값, config.js)
 *   2) scanRoots가 비면 자동 스캔하지 않고 안내 후 종료(확정 결정, R-04)
 *   3) walker→detector→collectors 오케스트레이션(scanner.js) — 항목 격리(N-05)
 *   4) cache/projects.json에 원자적·0600 쓰기(serializer.js, N-06·M-2)
 *   5) 콘솔 진행/요약 출력
 *
 * 외부 의존성 0 — 내부 모듈만.
 */

const paths = require('./lib/common/paths');
const { loadConfig, writeDefaultConfig } = require('./lib/common/config');
const { Logger } = require('./lib/common/logger');
const scanner = require('./lib/scan/scanner');
const serializer = require('./lib/scan/serializer');
const driveEnum = require('./lib/scan/driveEnum');

/**
 * 아주 단순한 CLI 인자 파서(외부 의존성 0).
 * 지원: --roots <a,b,c>  --stale-days <n>  --config <path>  --quiet  --help
 * @param {string[]} argv process.argv.slice(2)
 */
function parseArgs(argv) {
  const out = { cliArgs: {}, configPath: undefined, quiet: false, help: false, withSize: false, allDrives: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--quiet' || a === '-q') out.quiet = true;
    else if (a === '--roots') {
      const v = argv[++i];
      if (v) out.cliArgs.scanRoots = v.split(',').map((s) => s.trim()).filter(Boolean);
    } else if (a === '--stale-days') {
      const v = argv[++i];
      const n = parseInt(v, 10);
      if (Number.isFinite(n)) out.cliArgs.staleDays = n;
    } else if (a === '--config') {
      out.configPath = argv[++i];
    } else if (a === '--depth') {
      // [M4 R-03] CLI depthLimit. walker가 clamp(1, ABS_MAX_DEPTH)로 강제(약화 금지).
      const v = argv[++i];
      const n = parseInt(v, 10);
      if (Number.isFinite(n) && n > 0) out.cliArgs.depthLimit = n;
    } else if (a === '--with-size') {
      // [M4 R-09] size 용량 측정 활성(예산 내). config.size.enabled를 덮어쓴다.
      out.withSize = true;
    } else if (a === '--all-drives') {
      // [M4 R-05] 전체 드라이브 스캔 요청. config.allowAllDrives 게이트가 true일 때만 적용.
      out.allDrives = true;
    }
  }
  return out;
}

function printHelp() {
  console.log('spip — VS Code 프로젝트 스캐너');
  console.log('');
  console.log('사용법: spip [옵션]');
  console.log('  --roots <a,b,c>     스캔할 루트 디렉터리(쉼표 구분, 설정 파일보다 우선)');
  console.log('  --stale-days <n>    stale 판정 기준일(기본 90)');
  console.log('  --depth <n>         순회 깊이 상한(기본 24, 절대 상한 64)');
  console.log('  --with-size         규모(용량) 측정 활성화(opt-in, 예산 내)');
  console.log('  --all-drives        전체 드라이브 스캔(설정 allowAllDrives=true 필요)');
  console.log('  --config <path>     설정 파일 경로 지정');
  console.log('  --quiet, -q         진행 로그 억제');
  console.log('  --help, -h          도움말');
  console.log('');
  console.log('설정 파일: ' + paths.configPath());
  console.log('캐시 파일: ' + paths.cachePath());
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.help) {
    printHelp();
    return 0;
  }

  const logger = new Logger({ quiet: parsed.quiet });

  const { config, sourcePath, fileExisted } = loadConfig({
    cliArgs: parsed.cliArgs,
    configPath: parsed.configPath,
    logger,
  });

  // [M4 R-05] all-drives 모드 — config.allowAllDrives 게이트가 true일 때만 드라이브 열거.
  let scanRoots = config.scanRoots;
  let effectiveAllDrives = false;
  if (parsed.allDrives) {
    if (config.allowAllDrives === true) {
      const enumerated = driveEnum.enumerateRoots({ logger });
      if (enumerated.length > 0) {
        scanRoots = enumerated;
        effectiveAllDrives = true;
        // [R-05 §5.4] 시작 전 안전 고지(--quiet여도 출력).
        console.warn('전체 드라이브 스캔은 디스크 규모에 따라 수 분 이상 걸릴 수 있습니다. 진행 상황은 콘솔/대시보드에서 확인하세요.');
      }
    } else {
      console.warn('--all-drives는 설정 allowAllDrives=true 일 때만 적용됩니다(무시).');
    }
  }

  // scanRoots가 비면 자동 스캔하지 않고 안내 후 종료(R-04 확정 결정).
  if (!scanRoots || scanRoots.length === 0) {
    console.log('');
    console.log('스캔할 루트가 설정되어 있지 않습니다.');
    if (!fileExisted) {
      try {
        const created = writeDefaultConfig(sourcePath);
        console.log('기본 설정 파일을 생성했습니다: ' + created);
      } catch (_) {
        console.log('설정 파일 경로: ' + sourcePath);
      }
    } else {
      console.log('설정 파일: ' + sourcePath);
    }
    console.log('설정의 "scanRoots"에 스캔할 폴더 경로를 추가한 뒤 다시 실행하세요.');
    console.log('또는 일회성으로: spip --roots <폴더1,폴더2>');
    console.log('');
    return 0;
  }

  logger.info('스캔 시작 — 루트 ' + scanRoots.length + '개');
  for (const r of scanRoots) logger.info('  · ' + r);

  let lastReport = 0;
  const snapshot = await scanner.scan({
    roots: scanRoots,
    excludes: config.excludes,
    staleDays: config.staleDays,
    depthLimit: config.depthLimit,
    allDrives: effectiveAllDrives,
    withSize: parsed.withSize,
    size: config.size,
    maxDirs: config.scan && config.scan.maxDirs,
    timeBudgetMs: config.scan && config.scan.timeBudgetMs,
    logger,
    // [P1-1] onProgress는 ScanProgress 객체를 받는다(number 시그니처 폐기). p.found 사용.
    onProgress: (p) => {
      const now = Date.now();
      if (!parsed.quiet && now - lastReport > 500) {
        const found = p && typeof p.found === 'number' ? p.found : 0;
        const dirs = p && typeof p.dirs === 'number' ? p.dirs : 0;
        process.stdout.write('\r  순회 ' + dirs + ' · 탐지된 프로젝트: ' + found + '   ');
        lastReport = now;
      }
    },
  });

  if (!parsed.quiet) process.stdout.write('\r');

  let written;
  try {
    written = serializer.writeSnapshot(snapshot, { logger });
  } catch (_) {
    console.error('스냅샷 저장에 실패했습니다. 디스크 권한·용량을 확인하세요.');
    return 1;
  }

  // 콘솔 요약(R-14).
  console.log('');
  console.log('스캔 완료');
  console.log('  프로젝트: ' + snapshot.counts.projects + '개');
  console.log('  stale(' + config.staleDays + '일+): ' + snapshot.counts.stale + '개');
  console.log('  오류 격리: ' + snapshot.counts.errors + '건');
  console.log('  경고: ' + snapshot.warnings.length + '건');
  console.log('  소요: ' + snapshot.durationMs + 'ms');
  console.log('  저장: ' + written.path + ' (' + written.bytes + ' bytes)');
  console.log('');
  console.log('서버 실행: npm run start  (또는 node server.js)');
  return 0;
}

// 직접 실행 시에만 동작(require 시 부작용 없음).
if (require.main === module) {
  main()
    .then((code) => process.exit(typeof code === 'number' ? code : 0))
    .catch((err) => {
      console.error('예기치 않은 오류로 스캔을 중단했습니다.');
      if (process.env.SPIP_DEBUG) console.error(err && err.stack);
      process.exit(1);
    });
}

module.exports = { parseArgs, main };
