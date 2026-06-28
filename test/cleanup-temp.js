'use strict';
/**
 * test/cleanup-temp.js — 테스트가 os.tmpdir()에 남기는 spip-* 임시 디렉터리 정리.
 *
 * 다수의 테스트가 fs.mkdtempSync(os.tmpdir(), 'spip-*')로 임시 폴더를 만들지만
 * 개별 정리가 없어 누적된다. pretest/posttest에서 이 스크립트로 일괄 제거한다.
 * (개발 환경 전용 — 릴리즈 빌드에는 test/가 포함되지 않는다.)
 *
 * 외부 의존성 0.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = os.tmpdir();
let removed = 0;

let entries = [];
try {
  entries = fs.readdirSync(tmp);
} catch (_) {
  process.exit(0);
}

for (const name of entries) {
  if (!name.startsWith('spip-')) continue;
  const p = path.join(tmp, name);
  try {
    if (fs.statSync(p).isDirectory()) {
      fs.rmSync(p, { recursive: true, force: true });
      removed++;
    }
  } catch (_) { /* 사용 중이거나 권한 문제면 건너뜀 (best-effort) */ }
}

console.log(`[cleanup-temp] removed ${removed} spip-* dir(s) from ${tmp}`);
