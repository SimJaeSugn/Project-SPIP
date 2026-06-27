'use strict';
/**
 * shelf-pathPolicy.test.js — lib/shelf/pathPolicy.js (SH-1, ADR-SH-4 민감경로 deny 게이트)
 *   임시 디렉토리(허용)·시스템/루트(거부)·소멸 경로(PATH_GONE)를 검증.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const pathPolicy = require('../lib/shelf/pathPolicy');

const IS_WIN = process.platform === 'win32';

function tmpDir() {
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'spip-pp-')));
}

test('SH-1 pathPolicy — 일반 임시 디렉토리는 허용(ok)', () => {
  const d = tmpDir();
  const g = pathPolicy.gate(d);
  assert.strictEqual(g.ok, true);
  assert.strictEqual(g.code, null);
  assert.strictEqual(typeof g.real, 'string');
});

test('SH-1 pathPolicy — 소멸 경로는 PATH_GONE(canonicalize 실패)', () => {
  const d = tmpDir();
  const ghost = path.join(d, 'does-not-exist-xyz');
  const g = pathPolicy.gate(ghost);
  assert.strictEqual(g.ok, false);
  assert.strictEqual(g.code, 'PATH_GONE');
});

test('SH-1 pathPolicy — 드라이브/파일시스템 루트 거부', () => {
  const root = IS_WIN ? (process.env.SystemDrive || 'C:') + '\\' : '/';
  assert.strictEqual(pathPolicy.isFsRoot(IS_WIN ? (process.env.SystemDrive || 'C:') + '\\' : '/'), true);
  const g = pathPolicy.gate(root);
  assert.strictEqual(g.ok, false);
  assert.strictEqual(g.code, 'PATH_DENIED');
});

test('SH-1 pathPolicy — OS 시스템 디렉토리 거부(isDenied)', () => {
  if (IS_WIN) {
    const winDir = process.env.WINDIR || 'C:\\Windows';
    assert.strictEqual(pathPolicy.isDenied(winDir), true);
    assert.strictEqual(pathPolicy.isDenied(path.join(winDir, 'System32')), true, '하위도 접두 차단');
  } else {
    assert.strictEqual(pathPolicy.isDenied('/etc'), true);
    assert.strictEqual(pathPolicy.isDenied('/usr/bin'), true);
  }
});

test('SH-1 pathPolicy — 자격 디렉토리 접두 차단(.ssh)', () => {
  const home = os.homedir();
  // 존재 여부와 무관하게 접두 폴드 비교로 차단(resolve 폴백).
  assert.strictEqual(pathPolicy.isDenied(path.join(home, '.ssh')), true);
  assert.strictEqual(pathPolicy.isDenied(path.join(home, '.ssh', 'id_rsa')), true);
});

test('SH-1 pathPolicy — 홈 일반 하위는 허용(자격 디렉토리 아님)', () => {
  // 실제 존재하는 임시 디렉토리로 검증(canonicalize 통과 필요).
  const d = tmpDir();
  assert.strictEqual(pathPolicy.isDenied(d), false);
});

test('SH-1 pathPolicy — 비문자열/빈 입력 거부', () => {
  assert.strictEqual(pathPolicy.isDenied(''), true);
  assert.strictEqual(pathPolicy.isDenied(null), true);
});
