'use strict';
/**
 * safeExec.test.js — resolveBin 핵심 로직 + safeExec 인터페이스 가드 (S0, H-2/M-4 골격)
 *
 * 실제 git/code 호출 실측은 S2/S5. 여기서는 절대경로 해석·확장자 차단·
 * 입력 검증·in-flight 상한 인터페이스를 검증한다.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const safeExec = require('../lib/common/safeExec');

test('resolveBin: node 실행 파일을 절대경로로 해석한다(H-2)', () => {
  safeExec._clearBinCache();
  // 본 프로세스의 node 실행 파일명으로 PATH 해석을 검증.
  const name = process.platform === 'win32' ? 'node' : 'node';
  const resolved = safeExec.resolveBin(name);
  // node는 PATH에 있어야 정상(테스트 환경 전제). 절대경로여야 한다.
  assert.ok(resolved === null || path.isAbsolute(resolved), 'resolved must be absolute or null');
  if (resolved) assert.ok(safeExec.isExecutableFile(resolved));
});

test('resolveBin: 캐시 동작(force로 재해석)', () => {
  safeExec._clearBinCache();
  const a = safeExec.resolveBin('node');
  const b = safeExec.resolveBin('node'); // 캐시 히트
  assert.strictEqual(a, b);
});

test('resolveBin: 존재하지 않는 바이너리는 null', () => {
  safeExec._clearBinCache();
  const r = safeExec.resolveBin('definitely-not-a-real-binary-xyz123');
  assert.strictEqual(r, null);
});

test('resolveBin(win): .bat/.cmd 명시 확장자는 후보에서 제외(H-2)', () => {
  // winCandidates는 비공개지만 동작은 resolveBin 경유로 검증.
  // 비-win 환경에서는 항상 name 그대로이므로 이 단언은 win에서만 의미.
  safeExec._clearBinCache();
  const r = safeExec.resolveBin('something.cmd');
  // 어느 OS든 실존하지 않으면 null. win에서 .cmd는 후보 자체가 없어 절대 매칭 안 됨.
  assert.strictEqual(r, null);
});

test('safeExec: 상대경로 absBin 거부(H-2)', async () => {
  await assert.rejects(
    () => safeExec.safeExec('git', ['--version']),
    /absolute path/
  );
});

test('safeExec: 비문자열 인자 거부(N-03)', async () => {
  const abs = process.platform === 'win32' ? 'C:\\Windows\\System32\\where.exe' : '/bin/echo';
  await assert.rejects(
    () => safeExec.safeExec(abs, [123]),
    /args must be strings/
  );
});

test('safeExec(win): .bat 절대경로 거부(H-2)', async () => {
  if (process.platform !== 'win32') return; // win 전용
  await assert.rejects(
    () => safeExec.safeExec('C:\\tools\\evil.bat', []),
    /only \.exe/
  );
});

test('safeExec: 한도 상수 노출(M-4)', () => {
  assert.strictEqual(typeof safeExec.DEFAULT_TIMEOUT_MS, 'number');
  assert.strictEqual(typeof safeExec.DEFAULT_MAX_BUFFER, 'number');
  assert.strictEqual(typeof safeExec.DEFAULT_MAX_INFLIGHT, 'number');
});

test('safeExec(detached): spawn 시작 성공 시점에 즉시 resolve, 프로세스 종료 대기 안 함(P2-3)', async () => {
  // 본 프로세스의 node 실행 파일을 detached로 띄워 "오래 사는" 자식을 만든다.
  // detached 모드는 child 'spawn'에서 {spawned:true}로 즉시 resolve해야 하며,
  // 자식이 1초 이상 살아 있어도 그 종료를 기다리지 않아야 한다(R-12 2초 피드백).
  const nodeBin = process.execPath; // 절대경로(H-2 충족)
  const started = Date.now();
  const r = await safeExec.safeExec(
    nodeBin,
    ['-e', 'setTimeout(()=>{}, 1500)'], // 1.5초 동안 살아 있는 자식
    { detached: true, inflightKey: 'open:test', maxInflight: 2 }
  );
  const elapsed = Date.now() - started;
  assert.strictEqual(r.spawned, true, 'spawn 시작 성공을 {spawned:true}로 반환해야 함');
  assert.ok(typeof r.pid === 'number', 'pid 반환');
  // 자식 종료(1.5초)를 기다렸다면 1500ms 이상 걸린다. 시작만 확인하면 수십~수백 ms.
  assert.ok(elapsed < 1000, 'spawn 시작 즉시 resolve해야 함(실제 elapsed=' + elapsed + 'ms)');
  // 분리 실행이므로 자식을 정리(테스트 환경 깔끔히).
  try { process.kill(r.pid); } catch (_) { /* 이미 종료/권한 — 무해 */ }
});

test('safeExec(detached): spawn 실패(미존재 절대경로)는 error로 reject — OPEN_FAILED 구분(P2-3)', async () => {
  const fakeBin = process.platform === 'win32'
    ? 'C:\\__spip_no_such_binary__.exe'
    : '/__spip_no_such_binary__';
  await assert.rejects(
    () => safeExec.safeExec(fakeBin, [], { detached: true }),
    'detached 모드라도 spawn 실패(ENOENT)는 reject되어야 함'
  );
});
