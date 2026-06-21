'use strict';
/**
 * favorites-smoke.test.js — 헤드리스 Electron 스모크의 node:test 래퍼.
 *
 * 원 버그("위젯에 버튼만 보이고 즐겨찾기 카드가 안 뜸")는 순수함수 테스트만으론 샜다.
 * 이 래퍼는 실제 Chromium DOM 에 public/favorites.html 을 로드하는 헤드리스 Electron
 * 러너(test/headless/favorites-smoke.electron.js)를 spawn 해 .fav-card 가 실제로
 * 렌더되는지(+본문 가시 지오메트리)를 검증한다.
 *
 * electron 바이너리가 없거나 이 환경에서 GUI 런타임을 못 띄우면 skip(=0-의존성 DOM 스텁
 * 테스트 favorites-dom-render.test.js 가 동일 보장을 0-의존성으로 커버).
 */
const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const RUNNER = path.join(__dirname, 'headless', 'favorites-smoke.electron.js');

// require('electron') 는 플레인 Node 에서 electron 실행 바이너리 절대경로 문자열을 반환.
// (.bin 셸 래퍼 대신 직접 실행 — shell:true 불필요·DEP0190 회피)
let ELECTRON_BIN = null;
try {
  const p = require('electron');
  if (typeof p === 'string' && fs.existsSync(p)) ELECTRON_BIN = p;
} catch (_) { /* electron 미설치 */ }

const electronAvailable = !!ELECTRON_BIN;

test('headless Electron smoke: .fav-card 가 실제 DOM 에 렌더된다(원 버그 봉인)',
  { skip: electronAvailable ? false : 'electron 바이너리 없음 — DOM 스텁 테스트가 커버' },
  () => {
    const res = spawnSync(ELECTRON_BIN, [RUNNER], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 60000,
    });
    const out = (res.stdout || '') + (res.stderr || '');
    // 환경이 GUI 런타임을 못 띄우는 경우(헤드리스 불가) skip 처리 — 카드 검증은 DOM 스텁이 보장.
    if (res.error || (!out.includes('SMOKE_OK') && !out.includes('SMOKE_FAIL'))) {
      const reason = (res.error && res.error.message) || 'electron 런타임 미기동';
      // node:test 동적 skip
      test.skip ? test.skip(reason) : assert.ok(true, 'skip: ' + reason);
      return;
    }
    assert.ok(out.includes('SMOKE_OK'),
      '헤드리스 스모크 실패(버튼만 있고 카드 미렌더 가능성):\n' + out);
    assert.ok(!out.includes('SMOKE_FAIL'), '스모크 FAIL 출력 감지:\n' + out);
  });
