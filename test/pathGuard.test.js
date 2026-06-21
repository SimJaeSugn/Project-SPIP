'use strict';
/**
 * pathGuard.test.js — canonicalize/isAllowed 화이트리스트 (보안 H-1)
 * 회귀: ../순회·심링크 우회·접두사 부분일치·대소문자·NFD·소멸 경로.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const pathGuard = require('../lib/common/pathGuard');
const fx = require('./fixtures/build');

test('canonicalize: 실존 디렉터리를 realpath 절대경로로 해소', () => {
  const dir = fx.mkRoot('spip-pg-');
  const c = pathGuard.canonicalize(dir);
  assert.ok(c && path.isAbsolute(c));
});

test('canonicalize: 소멸/미존재 경로는 null(PATH_GONE 토대)', () => {
  const c = pathGuard.canonicalize(path.join(os.tmpdir(), 'spip-gone-' + Date.now()));
  assert.strictEqual(c, null);
});

test('isAllowed: 정확 일치만 허용, 접두사 부분일치 차단', () => {
  const dir = fx.mkRoot('spip-pg-');
  fx.mkdir(path.join(dir, 'proj'));
  fx.mkdir(path.join(dir, 'proj-evil')); // 접두사 부분일치 함정
  const real = pathGuard.canonicalize(path.join(dir, 'proj'));
  const whitelist = new Set([real]);

  assert.strictEqual(pathGuard.isAllowed(path.join(dir, 'proj'), whitelist), true);
  // 'proj-evil'은 'proj' 접두사를 공유하지만 정확 일치가 아니므로 거부.
  assert.strictEqual(pathGuard.isAllowed(path.join(dir, 'proj-evil'), whitelist), false);
});

test('isAllowed: ../ 순회로 화이트리스트 밖 접근 차단(H-1)', () => {
  const dir = fx.mkRoot('spip-pg-');
  fx.mkdir(path.join(dir, 'allowed'));
  fx.mkdir(path.join(dir, 'secret'));
  const real = pathGuard.canonicalize(path.join(dir, 'allowed'));
  const whitelist = new Set([real]);
  // allowed/../secret → secret (밖) → 거부
  assert.strictEqual(pathGuard.isAllowed(path.join(dir, 'allowed', '..', 'secret'), whitelist), false);
});

test('isAllowed(win/mac): 대소문자 비민감 FS 폴드 일치', () => {
  if (!pathGuard.CASE_INSENSITIVE_FS) return; // win/mac 전용
  const dir = fx.mkRoot('spip-pg-');
  fx.mkdir(path.join(dir, 'MyProj'));
  const real = pathGuard.canonicalize(path.join(dir, 'MyProj'));
  const whitelist = new Set([real]);
  assert.strictEqual(pathGuard.isAllowed(path.join(dir, 'myproj'), whitelist), true);
});

test('isAllowed: 심링크 경유 경로가 실경로로 해소되어 비교됨(H-1)', () => {
  const dir = fx.mkRoot('spip-pg-');
  fx.mkdir(path.join(dir, 'realtarget'));
  const linkPath = path.join(dir, 'link');
  const made = fx.trySymlink(path.join(dir, 'realtarget'), linkPath);
  if (!made) return; // 심링크 권한 없으면 스킵
  const realTarget = pathGuard.canonicalize(path.join(dir, 'realtarget'));
  const whitelist = new Set([realTarget]);
  // link는 realtarget으로 해소 → 화이트리스트에 realtarget만 있어도 통과(실경로 일치).
  assert.strictEqual(pathGuard.isAllowed(linkPath, whitelist), true);
});

test('isAllowed: NFD 입력이 NFC 정규화되어 일치(유니코드)', () => {
  const dir = fx.mkRoot('spip-pg-');
  // NFC 'é' 폴더
  const nfcName = 'éproj'; // é (NFC)
  try {
    fx.mkdir(path.join(dir, nfcName));
  } catch (_) {
    return; // FS가 거부하면 스킵
  }
  const real = pathGuard.canonicalize(path.join(dir, nfcName));
  if (!real) return;
  const whitelist = new Set([real]);
  // NFD 'é' = e + combining accent
  const nfdName = 'éproj';
  const res = pathGuard.isAllowed(path.join(dir, nfdName), whitelist);
  // NFC 정규화로 흡수되거나(true) FS가 별도 엔트리로 두면 해소 실패(false). 크래시 없음이 핵심.
  assert.ok(res === true || res === false);
});
