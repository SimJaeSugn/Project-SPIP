'use strict';
/**
 * security-h2.test.js — PATH 하이재킹/cwd 위장 바이너리 차단 회귀 (보안 H-2)
 *
 * 부분신뢰 폴더(TB-B)에 위장 git.exe/git.bat를 심어도 resolveBin/safeExec가
 * 그것을 선택하지 않음을 검증한다. (cwd는 PATH 탐색 대상이 아니며, .bat/.cmd는 차단)
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const safeExec = require('../lib/common/safeExec');
const git = require('../lib/scan/collectors/git');
const { Logger } = require('../lib/common/logger');
const fx = require('./fixtures/build');

function quiet() { return new Logger({ quiet: true }); }

test('H-2: resolveBin은 cwd(".")를 PATH 탐색에서 제외', () => {
  safeExec._clearBinCache();
  // 위장 바이너리를 둔 폴더로 cwd를 옮겨도, resolveBin('git')은 신뢰 PATH의 git만 반환.
  const evilDir = fx.mkRoot('spip-evil-');
  // 위장 git.exe / git.bat 생성(악성 마커).
  fx.writeFile(path.join(evilDir, 'git.exe'), 'MZ fake');
  fx.writeFile(path.join(evilDir, 'git.bat'), '@echo EVIL');

  const realCwd = process.cwd();
  try {
    process.chdir(evilDir);
    safeExec._clearBinCache();
    const resolved = safeExec.resolveBin('git');
    // 절대경로 또는 null. 절대경로라면 evilDir 내부가 아니어야 한다(신뢰 PATH).
    assert.ok(resolved === null || path.isAbsolute(resolved));
    if (resolved) {
      const realEvil = fs.realpathSync(evilDir).toLowerCase();
      assert.ok(!resolved.toLowerCase().startsWith(realEvil), 'cwd 위장 바이너리 미선택');
    }
  } finally {
    process.chdir(realCwd);
    safeExec._clearBinCache();
  }
});

test('H-2: 위장 git.bat가 있는 폴더를 -C로 스캔해도 위장 미실행(graceful na 또는 정상)', async () => {
  // git collector는 절대경로 git + -C <path>를 쓰므로 폴더 내 위장 바이너리를 실행하지 않는다.
  const evilDir = fx.mkRoot('spip-evilrepo-');
  fx.writeFile(path.join(evilDir, 'git.exe'), 'MZ fake');
  fx.writeFile(path.join(evilDir, 'git.bat'), '@echo EVIL > pwned.txt');
  // .git 없음 → 비저장소.
  const res = await git.collect(evilDir, { logger: quiet() });
  // 위장 바이너리가 실행됐다면 pwned.txt가 생겼을 것 — 생기면 안 된다.
  assert.ok(!fs.existsSync(path.join(evilDir, 'pwned.txt')), '위장 바이너리 미실행');
  assert.ok(res.status === 'na' || res.status === 'ok');
});

test('H-2: safeExec는 .bat 절대경로 실행 거부', async () => {
  if (process.platform !== 'win32') return;
  const evilDir = fx.mkRoot('spip-bat-');
  const bat = path.join(evilDir, 'evil.bat');
  fx.writeFile(bat, '@echo x');
  await assert.rejects(() => safeExec.safeExec(bat, []), /only \.exe/);
});
