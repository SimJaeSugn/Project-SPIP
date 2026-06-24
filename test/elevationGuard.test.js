'use strict';
/**
 * elevationGuard.test.js — lib/common/elevationGuard.js (M12 b3)
 *
 * 판정 전용(부작용 없음) 검증:
 *   · SID High ML 파싱(상승/비상승) — S-1-16-12288 유일 차단 근거(M12-1)
 *   · APPDATA 휴리스틱은 "검사 트리거"로만 — 단독 차단 금지(M12-1b)
 *   · 판정 불가(whoami 미해석/실행 실패) 시 false 폴백(M12-1c, 가용성 우선)
 *   · win32 외 플랫폼 false
 *   · whoami 호출이 고정 절대경로(%SystemRoot%\System32\whoami.exe)·인자 ['/groups']인지(H-2/M12-S-01)
 */
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const guard = require('../lib/common/elevationGuard');

// 기대 %APPDATA%와 "불일치"하는 env(=검사 트리거 ON). homedir 고정.
const HOME = process.platform === 'win32' ? 'C:\\Users\\real' : '/home/real';
function expectedAppdata() { return path.join(HOME, 'AppData', 'Roaming'); }
function mismatchEnv(extra) {
  // 관리자 프로필을 가리키는 APPDATA(불일치) — whoami 검사 유발.
  return Object.assign({ APPDATA: 'C:\\Users\\Administrator\\AppData\\Roaming', SystemRoot: 'C:\\Windows' }, extra || {});
}
function matchEnv() {
  return { APPDATA: expectedAppdata(), SystemRoot: 'C:\\Windows' };
}

const GROUPS_HIGH = [
  'GROUP INFORMATION',
  'Mandatory Label\\High Mandatory Level   Label   S-1-16-12288',
].join('\n');
const GROUPS_MEDIUM = [
  'GROUP INFORMATION',
  'Mandatory Label\\Medium Mandatory Level Label   S-1-16-8192',
].join('\n');

test('detectElevation — High ML SID(S-1-16-12288) → elevated:true (M12-1)', () => {
  const r = guard.detectElevation({
    platform: 'win32',
    env: mismatchEnv(),
    homedir: () => HOME,
    resolveWhoami: () => 'C:\\Windows\\System32\\whoami.exe',
    execGroups: () => GROUPS_HIGH,
  });
  assert.strictEqual(r.elevated, true);
  assert.strictEqual(r.reason, 'high-integrity');
});

test('detectElevation — Medium ML(S-1-16-8192) → elevated:false (M12-1)', () => {
  const r = guard.detectElevation({
    platform: 'win32',
    env: mismatchEnv(),
    homedir: () => HOME,
    resolveWhoami: () => 'C:\\Windows\\System32\\whoami.exe',
    execGroups: () => GROUPS_MEDIUM,
  });
  assert.strictEqual(r.elevated, false);
  assert.strictEqual(r.reason, 'medium-or-below');
});

test('detectElevation — APPDATA 휴리스틱은 트리거만: 불일치라도 SID Medium이면 차단 안 함 (M12-1b)', () => {
  // APPDATA 불일치(트리거 ON)인데 whoami가 Medium → 단독 차단 금지(elevated:false).
  const r = guard.detectElevation({
    platform: 'win32',
    env: mismatchEnv(),
    homedir: () => HOME,
    resolveWhoami: () => 'C:\\Windows\\System32\\whoami.exe',
    execGroups: () => GROUPS_MEDIUM,
  });
  assert.strictEqual(r.elevated, false, 'APPDATA 불일치만으로는 차단하지 않음');
});

test('detectElevation — APPDATA 일치(트리거 없음)면 whoami 검사조차 안 함 → false (no-trigger)', () => {
  let called = false;
  const r = guard.detectElevation({
    platform: 'win32',
    env: matchEnv(),
    homedir: () => HOME,
    resolveWhoami: () => { called = true; return 'C:\\Windows\\System32\\whoami.exe'; },
    execGroups: () => { called = true; return GROUPS_HIGH; },
  });
  assert.strictEqual(r.elevated, false);
  assert.strictEqual(r.reason, 'no-trigger');
  assert.strictEqual(called, false, '트리거 없으면 whoami 비용 0');
});

test('detectElevation — whoami 미해석 시 false 폴백 (M12-1c)', () => {
  const r = guard.detectElevation({
    platform: 'win32',
    env: mismatchEnv(),
    homedir: () => HOME,
    resolveWhoami: () => null, // 고정경로 검증 실패
    execGroups: () => { throw new Error('should not run'); },
  });
  assert.strictEqual(r.elevated, false);
  assert.strictEqual(r.reason, 'whoami-unresolved');
});

test('detectElevation — whoami 실행/파싱 실패(null) 시 false 폴백 (M12-1c, 가용성 우선)', () => {
  const r = guard.detectElevation({
    platform: 'win32',
    env: mismatchEnv(),
    homedir: () => HOME,
    resolveWhoami: () => 'C:\\Windows\\System32\\whoami.exe',
    execGroups: () => null, // execFileSync throw 등 → null
  });
  assert.strictEqual(r.elevated, false);
  assert.strictEqual(r.reason, 'whoami-failed');
});

test('detectElevation — win32 외 플랫폼은 항상 false', () => {
  for (const platform of ['darwin', 'linux']) {
    const r = guard.detectElevation({
      platform,
      env: mismatchEnv(),
      homedir: () => HOME,
      execGroups: () => GROUPS_HIGH,
    });
    assert.strictEqual(r.elevated, false);
    assert.strictEqual(r.reason, 'non-win32');
  }
});

test('detectElevation — whoami는 고정 절대경로·인자 [\'/groups\'] (H-2/M12-S-01)', () => {
  // resolveWhoami 를 실제 구현(resolveWhoamiBin)으로 두되, 그 결과 경로를 검사.
  //   resolveBin은 실존 파일만 통과시키므로 결과가 null일 수도 있다 → 둘 다 허용하되
  //   "PATH 검색이 아니라 %SystemRoot%\System32\whoami.exe 고정 경로를 검증"함을 확인.
  let resolvedArg = null;
  let execArgs = null;
  guard.detectElevation({
    platform: 'win32',
    env: mismatchEnv(),
    homedir: () => HOME,
    // resolveWhoami 미주입 → 내부 resolveWhoamiBin 사용. execGroups로 호출 bin·args 캡처.
    execGroups: (bin, env) => { resolvedArg = bin; return GROUPS_MEDIUM; },
  });
  // resolveWhoamiBin은 실파일 검증을 통과하면 절대경로를 반환. 미존재 환경에선 null이라
  //   execGroups가 호출되지 않으므로 resolvedArg가 null일 수 있다. 호출됐다면 경로 형태를 검증.
  if (resolvedArg !== null) {
    assert.ok(/whoami\.exe$/i.test(resolvedArg), '고정 whoami.exe 절대경로');
    assert.ok(/System32/i.test(resolvedArg), 'System32 고정 경로');
    assert.ok(path.isAbsolute(resolvedArg), '절대경로(PATH 검색 아님)');
  }

  // 별도로 직접 resolveWhoamiBin·hasHighIntegritySid 단위 검증.
  assert.strictEqual(guard.hasHighIntegritySid(GROUPS_HIGH), true);
  assert.strictEqual(guard.hasHighIntegritySid(GROUPS_MEDIUM), false);
  assert.strictEqual(guard.hasHighIntegritySid(''), false);
  assert.strictEqual(guard.hasHighIntegritySid(null), false);
  // SYSTEM ML(S-1-16-16384)도 상승으로 간주.
  assert.strictEqual(guard.hasHighIntegritySid('x S-1-16-16384 y'), true);

  // execGroups가 args ['/groups'] 고정으로 호출됨을 보장하는 계약: 내부 execWhoamiGroups가
  //   execFileSync(bin, ['/groups'], …)를 쓰는지 모킹 검증.
  const childProcess = require('child_process');
  const orig = childProcess.execFileSync;
  try {
    childProcess.execFileSync = (bin, args, opts) => {
      execArgs = { bin, args, opts };
      return GROUPS_HIGH;
    };
    const out = guard.execWhoamiGroups('C:\\Windows\\System32\\whoami.exe', { SystemRoot: 'C:\\Windows' });
    assert.strictEqual(out, GROUPS_HIGH);
    assert.deepStrictEqual(execArgs.args, ['/groups'], '인자 [\'/groups\'] 고정');
    assert.strictEqual(execArgs.opts.shell, false, 'shell:false (H-2)');
    assert.strictEqual(execArgs.bin, 'C:\\Windows\\System32\\whoami.exe', '고정 절대경로');
  } finally {
    childProcess.execFileSync = orig;
  }
});

test('appdataMismatch — 일치/불일치/부재 (트리거 신호)', () => {
  assert.strictEqual(guard.appdataMismatch({ homedir: () => HOME, env: matchEnv() }), false);
  assert.strictEqual(guard.appdataMismatch({ homedir: () => HOME, env: mismatchEnv() }), true);
  assert.strictEqual(guard.appdataMismatch({ homedir: () => HOME, env: {} }), true, 'APPDATA 부재도 트리거');
});
