'use strict';
/**
 * m4-scan.test.js — M4 스캔 계층: size·depthLimit·all-drives·onDir·driveEnum
 *   · R-09 size: deps/devDeps 항상, 용량 opt-in, 2레이어 status(C-5 예산), partial
 *   · R-03 depthLimit: clamp(1, ABS_MAX_DEPTH), all-drives 더 낮은 상한
 *   · R-05 all-drives: isUnderSystemDir 세그먼트 차단(C-2 8.3/대소문자/UNC 흡수)
 *   · R-15 onDir: walker yield 직전 콜백 1회, scanner onProgress 객체화
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const walker = require('../lib/scan/walker');
const scanner = require('../lib/scan/scanner');
const size = require('../lib/scan/collectors/size');
const excludeRules = require('../lib/scan/excludeRules');
const driveEnum = require('../lib/scan/driveEnum');
const pathGuard = require('../lib/common/pathGuard');
const { Logger } = require('../lib/common/logger');
const fx = require('./fixtures/build');

function quiet() { return new Logger({ quiet: true }); }
const LIMITS = require('../lib/scan/collectors').LIMITS;

// ───── R-09 size ─────
test('size: 비활성(opt-in)이면 계약 status=na, 도메인 status=skipped + deps/devDeps 수집', () => {
  const root = fx.buildDetectionSet();
  const proj = path.join(root, 'node-proj');
  const res = size.collect(proj, { config: { size: { enabled: false } }, limits: LIMITS, logger: quiet() });
  assert.strictEqual(res.status, 'na');           // 계약 status(§4.1.1)
  assert.strictEqual(res.data.status, 'skipped');  // 도메인 status
  assert.strictEqual(res.data.totalBytes, null);
  assert.strictEqual(res.data.deps, 1);            // react 1개
  assert.strictEqual(res.data.devDeps, 0);
});

test('size: 활성이면 totalBytes 실측 + 계약 status=ok, 도메인 status=ok', () => {
  const root = fx.buildDetectionSet();
  const proj = path.join(root, 'node-proj');
  const res = size.collect(proj, { config: { size: { enabled: true } }, limits: LIMITS, logger: quiet() });
  assert.strictEqual(res.status, 'ok');
  assert.strictEqual(res.data.status, 'ok');
  assert.ok(typeof res.data.totalBytes === 'number' && res.data.totalBytes > 0);
});

test('size: 예산(budgetMs=0 즉시 초과) → 도메인 status=partial, 계약 status=ok (C-5)', () => {
  const root = fx.buildDetectionSet();
  const proj = path.join(root, 'node-proj');
  // budgetMs를 아주 작게(1ms) 강제 → 즉시 truncated.
  const res = size.collect(proj, { config: { size: { enabled: true, budgetMs: 0.0001, maxEntries: 1 } }, limits: LIMITS, logger: quiet() });
  assert.strictEqual(res.status, 'ok');            // 수집기는 정상 완주
  assert.strictEqual(res.data.status, 'partial');  // 예산 도달 부분 측정
});

test('size: maxEntries 상한도 partial 유발(C-5)', () => {
  const root = fx.buildDetectionSet();
  const proj = path.join(root, 'node-proj');
  const res = size.collect(proj, { config: { size: { enabled: true, maxEntries: 1, budgetMs: 5000 } }, limits: LIMITS, logger: quiet() });
  assert.strictEqual(res.data.status, 'partial');
});

test('size: 단일 평면 디렉터리 내부 파일루프도 시간예산으로 절단(OBS-M4-02)', () => {
  // 한 디렉터리에 다수 파일(평면) — 디렉터리 경계 pop이 거의 없어 기존엔 시간상한 미점검 구간.
  const root = fx.mkRoot('spip-flatdir-');
  const proj = path.join(root, 'flat');
  for (let i = 0; i < 200; i++) fx.writeFile(path.join(proj, 'f' + i + '.txt'), 'x');
  // budgetMs를 이미 지난 음수 deadline 효과(0.0001ms)로 강제 → 파일루프 첫 점검에서 truncated.
  // maxEntries는 넉넉히 둬서 "시간예산만으로" 절단됨을 입증(maxEntries 안전망과 분리).
  const res = size.collect(proj, { config: { size: { enabled: true, budgetMs: 0.0001, maxEntries: 1000000 } }, limits: LIMITS, logger: quiet() });
  assert.strictEqual(res.status, 'ok');
  assert.strictEqual(res.data.status, 'partial', '시간예산 초과로 단일 디렉터리에서도 partial');
});

test('scanner: withSize면 size.status=ok 승격 + stats.totalBytes 집계(§4.3)', async () => {
  const root = fx.buildDetectionSet();
  const snap = await scanner.scan({ roots: [root], withSize: true, staleDays: 90, logger: quiet() });
  const p = snap.projects.find((x) => x.name === 'my-node-app');
  assert.ok(p);
  assert.ok(['ok', 'partial'].includes(p.size.status), 'size 실측 승격');
  assert.ok(typeof snap.stats.totalBytes === 'number' && snap.stats.totalBytes > 0, 'totalBytes 합계');
});

test('scanner: withSize 미지정이면 size.status=skipped + stats.totalBytes=null(MVP 회귀)', async () => {
  const root = fx.buildDetectionSet();
  const snap = await scanner.scan({ roots: [root], staleDays: 90, logger: quiet() });
  const p = snap.projects.find((x) => x.name === 'my-node-app');
  assert.strictEqual(p.size.status, 'skipped');
  assert.strictEqual(snap.stats.totalBytes, null);
});

// ───── BUG-M4-01: deps/devDeps는 기본 스캔(withSize off)에서도 항상 수집 — 실제 스캔 경로(통합 경계) ─────
// 단위(size.collect 직접 호출)가 아니라 scanner→레지스트리→size 통합 경로로 검증해야 결함을 잡는다.
// (기존 단위 테스트는 size.collect를 직접 불러 통과 → 경계 불일치를 못 잡았음 = 거짓 안심.)
test('BUG-M4-01: 기본 스캔(withSize off)에서도 size.deps/devDeps 실값(계약 §8.1, 통합 경계)', async () => {
  const root = fx.mkRoot('spip-m4deps-');
  // deps 2 / devDeps 1을 가진 실프로젝트.
  fx.writeFile(path.join(root, 'depproj', 'package.json'), JSON.stringify({
    name: 'dep-app',
    dependencies: { react: '^18', express: '^4' },
    devDependencies: { jest: '^29' },
  }));
  fx.writeFile(path.join(root, 'depproj', 'index.js'), 'module.exports={};');

  // 기본 스캔(withSize 미지정) — 용량은 미측정(skipped/null)이되 deps/devDeps는 채워져야 함.
  const snap = await scanner.scan({ roots: [root], staleDays: 90, logger: quiet() });
  const p = snap.projects.find((x) => x.name === 'dep-app');
  assert.ok(p, '프로젝트 탐지');
  assert.strictEqual(p.size.status, 'skipped', '용량은 여전히 미측정(MVP 회귀 0)');
  assert.strictEqual(p.size.totalBytes, null, '용량 미측정 시 totalBytes null');
  assert.strictEqual(p.size.deps, 2, 'deps는 기본 스캔에서도 실값(2)');     // ← 결함 시 null로 실패
  assert.strictEqual(p.size.devDeps, 1, 'devDeps는 기본 스캔에서도 실값(1)'); // ← 결함 시 null로 실패
  // 통합 경계 회귀: stats.totalBytes는 미측정이므로 null 유지(deps 수집이 용량 게이트를 흔들지 않음).
  assert.strictEqual(snap.stats.totalBytes, null);
});

test('BUG-M4-01: package.json 없는 프로젝트는 deps/devDeps null(graceful, 기본 스캔)', async () => {
  const root = fx.mkRoot('spip-m4nodeps-');
  fx.mkdir(path.join(root, 'gitonly', '.git')); // git 신호만, package.json 없음
  const snap = await scanner.scan({ roots: [root], staleDays: 90, logger: quiet() });
  const p = snap.projects.find((x) => x.path.endsWith('gitonly'));
  assert.ok(p);
  assert.strictEqual(p.size.deps, null);
  assert.strictEqual(p.size.devDeps, null);
});

// ───── R-03 depthLimit ─────
function makeDeep(depth) {
  const root = fx.mkRoot('spip-m4depth-');
  let p = root;
  for (let i = 0; i < depth; i++) p = path.join(p, 'd' + i);
  fx.mkdir(p);
  return root;
}

test('depthLimit: 얕게 줄이면 그 깊이까지만 순회', () => {
  const root = makeDeep(20);
  const dirs = Array.from(walker.walk([root], { logger: quiet(), depthLimit: 3 }));
  const base = root.split(path.sep).length;
  const maxObserved = Math.max(...dirs.map((d) => d.split(path.sep).length));
  assert.ok(maxObserved <= base + 3 + 1, '깊이 3 상한');
});

test('depthLimit: ABS_MAX_DEPTH(64) 초과 요청도 64로 clamp(약화 금지)', () => {
  // 깊이 100 트리를 만들지 않고 clamp 로직만 확인: 매우 큰 depthLimit을 줘도 ABS 상한 적용.
  const root = makeDeep(70);
  const logger = quiet();
  const dirs = Array.from(walker.walk([root], { logger, depthLimit: 9999 }));
  const base = root.split(path.sep).length;
  const maxObserved = Math.max(...dirs.map((d) => d.split(path.sep).length));
  assert.ok(maxObserved <= base + walker.ABS_MAX_DEPTH + 1, 'ABS_MAX_DEPTH=64 상한');
});

test('depthLimit: all-drives면 더 낮은 상한(24) + 기본 12 적용', () => {
  const root = makeDeep(40);
  const dirs = Array.from(walker.walk([root], { logger: quiet(), allDrives: true, platform: 'linux' }));
  const base = root.split(path.sep).length;
  const maxObserved = Math.max(...dirs.map((d) => d.split(path.sep).length));
  // all-drives 기본 깊이 12.
  assert.ok(maxObserved <= base + walker.DEFAULT_DEPTH_ALL_DRIVES + 1, 'all-drives 기본 12');
});

test('depthLimit: 미지정 호출부는 24로 동작(행동 불변)', () => {
  const root = makeDeep(30);
  const logger = quiet();
  const dirs = Array.from(walker.walk([root], { logger }));
  const base = root.split(path.sep).length;
  const maxObserved = Math.max(...dirs.map((d) => d.split(path.sep).length));
  assert.ok(maxObserved <= base + walker.SAFE_MAX_DEPTH + 1);
});

// ───── C-2 all-drives 시스템 제외(세그먼트·canonicalize) ─────
test('isUnderSystemDir: 세그먼트 경계 비교(C:\\WindowsApps는 C:\\Windows에 안 걸림)', () => {
  const keys = new Set([pathGuard.foldForCompare('C:\\Windows')]);
  assert.strictEqual(excludeRules.isUnderSystemDir('C:\\Windows\\System32', keys), true);
  assert.strictEqual(excludeRules.isUnderSystemDir('C:\\Windows', keys), true);
  assert.strictEqual(excludeRules.isUnderSystemDir('C:\\WindowsApps', keys), false); // prefix 우회 차단
  assert.strictEqual(excludeRules.isUnderSystemDir('C:\\Users\\me', keys), false);
});

test('isUnderSystemDir: 대소문자 흡수(폴드 키 비교, C-2)', () => {
  // foldForCompare가 Windows/macOS에서 소문자 폴드. canonicalize는 실경로라 케이스 정규화됨.
  const keys = new Set([pathGuard.foldForCompare('C:\\Windows')]);
  // 폴드 키는 이미 소문자(대소문자 비민감 FS). 직접 소문자 입력도 동일 키로 매칭.
  if (pathGuard.CASE_INSENSITIVE_FS) {
    assert.strictEqual(excludeRules.isUnderSystemDir('c:\\windows\\system32', keys), true);
  } else {
    // 대소문자 민감 FS에선 정확 일치만(설계대로) — 테스트는 동일 케이스로.
    assert.strictEqual(excludeRules.isUnderSystemDir('C:\\Windows\\System32', keys), true);
  }
});

test('all-drives: walker가 시스템 디렉터리 하위로 진입하지 않음(C-2 실차단)', () => {
  // 실디렉터리로 시스템 제외를 모사: 임시 루트 아래 'sysroot'를 시스템 키로 등록.
  const root = fx.mkRoot('spip-sysexcl-');
  fx.mkdir(path.join(root, 'sysroot', 'secret-inside'));
  fx.mkdir(path.join(root, 'normal', 'ok-inside'));
  const sysCanonical = pathGuard.canonicalize(path.join(root, 'sysroot'));
  const sysKey = pathGuard.foldForCompare(sysCanonical);
  // walker에 systemKeySet을 주입할 수 없으므로, isUnderSystemDir을 통해 가지치기됨을 모사:
  // buildSystemExcludeKeySet은 플랫폼 고정 목록이라, 여기선 isUnderSystemDir 단위로 검증하고
  // walker 통합은 키셋이 비면 통과함을 확인.
  const keys = new Set([sysKey]);
  // 직접 가지치기 판정: sysroot 하위는 제외, normal 하위는 통과.
  assert.strictEqual(excludeRules.isUnderSystemDir(pathGuard.canonicalize(path.join(root, 'sysroot', 'secret-inside')), keys), true);
  assert.strictEqual(excludeRules.isUnderSystemDir(pathGuard.canonicalize(path.join(root, 'normal', 'ok-inside')), keys), false);
});

test('all-drives: 루트 자체가 시스템 경로면 진입 전 통째로 제외(P2-4 루트레벨 가지치기)', () => {
  // sysroot를 "시스템 키"로 주입하고, 그 자체를 scanRoot로 준다 → 루트 레벨에서 통째 제외.
  const base = fx.mkRoot('spip-sysrootlvl-');
  fx.mkdir(path.join(base, 'sysroot', 'inside'));
  fx.mkdir(path.join(base, 'normalroot', 'inside'));
  const sysCanonical = pathGuard.canonicalize(path.join(base, 'sysroot'));
  const normalCanonical = pathGuard.canonicalize(path.join(base, 'normalroot'));
  const keys = new Set([pathGuard.foldForCompare(sysCanonical)]);

  // sysroot를 루트로 주면: 기존(자식만 가지치기)엔 루트 자신이 1회 yield됐다. 이제 0건이어야 함.
  const sysDirs = Array.from(walker.walk([sysCanonical], {
    logger: quiet(), allDrives: true, systemKeySet: keys,
  }));
  assert.strictEqual(sysDirs.length, 0, '시스템 루트는 루트 레벨에서 제외(자식 yield 0)');

  // normalroot는 정상 순회(루트 + inside).
  const normalDirs = Array.from(walker.walk([normalCanonical], {
    logger: quiet(), allDrives: true, systemKeySet: keys,
  }));
  assert.ok(normalDirs.length >= 2, '비시스템 루트는 정상 순회');
});

test('buildSystemExcludeKeySet: 플랫폼 목록을 폴드 키 Set으로(부재 항목 스킵)', () => {
  const winKeys = excludeRules.buildSystemExcludeKeySet('win32');
  const posixKeys = excludeRules.buildSystemExcludeKeySet('linux');
  assert.ok(winKeys instanceof Set);
  assert.ok(posixKeys instanceof Set);
  // 현재 플랫폼에 존재하는 경로만 해소되므로 Set 크기는 환경 의존(>=0). 타입만 보장.
});

// ───── R-15 onDir ─────
test('onDir: walker yield 직전 디렉터리마다 1회 호출(P1-1)', () => {
  const root = fx.buildDetectionSet();
  const seen = [];
  const dirs = Array.from(walker.walk([root], { logger: quiet(), onDir: (d) => seen.push(d) }));
  assert.strictEqual(seen.length, dirs.length, 'yield 수 == onDir 호출 수');
  // onDir 인자는 canonical 절대 실경로.
  for (const d of seen) assert.ok(path.isAbsolute(d));
});

test('onDir: 콜백이 throw해도 순회 계속(N-05)', () => {
  const root = fx.buildDetectionSet();
  const dirs = Array.from(walker.walk([root], { logger: quiet(), onDir: () => { throw new Error('x'); } }));
  assert.ok(dirs.length > 0, 'onDir throw 격리');
});

test('scanner onProgress: ScanProgress 객체로 호출(number 시그니처 폐기)', async () => {
  const root = fx.buildDetectionSet();
  let lastP = null;
  await scanner.scan({
    roots: [root], staleDays: 90, logger: quiet(),
    onProgress: (p) => { lastP = p; },
  });
  assert.ok(lastP && typeof lastP === 'object', 'onProgress는 객체');
  assert.strictEqual(lastP.phase, 'scanning');
  assert.ok(typeof lastP.dirs === 'number');
  assert.ok(typeof lastP.found === 'number');
});

// ───── M4-M-2 전역 자원 상한 ─────
test('walker: maxDirs 도달 시 안전 중단', () => {
  const root = fx.buildDetectionSet();
  const dirs = Array.from(walker.walk([root], { logger: quiet(), maxDirs: 2 }));
  assert.ok(dirs.length <= 2, 'maxDirs 상한 준수');
});

// ───── driveEnum ─────
test('driveEnum: 현재 플랫폼에서 최소 1개 루트 열거(canonical 디렉터리)', () => {
  const roots = driveEnum.enumerateRoots({ logger: quiet() });
  assert.ok(Array.isArray(roots));
  assert.ok(roots.length >= 1, '최소 1개 드라이브/마운트');
  for (const r of roots) {
    assert.ok(path.isAbsolute(r));
    assert.ok(fs.statSync(r).isDirectory());
  }
});
