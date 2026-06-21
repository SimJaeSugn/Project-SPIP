'use strict';
/**
 * electron-preload-contract.test.js — preload 노출 표면 ↔ renderer 호출 정합 (NOTE-1 / code P1 테스트공백)
 *
 * 목적(회귀 방지): renderer(public/app.js)가 ipc('<method>')로 호출하는 메서드 집합이
 *   preload(electron/preload.js)가 window.spip에 노출하는 키 집합의 부분집합인지 정적 대조한다.
 *   이 테스트는 P1-1/BUG-1(preload가 'open' 대신 'openInVsCode'로 노출 → spip.open 부재)을
 *   잡는다 — 노출 안 된 메서드를 renderer가 호출하면 FAIL.
 *
 * 추가로 P2-1 onMenu 계약(action 집합·채널·콜백·unsubscribe)과 메뉴 발신(menu.js)의 정합도 본다.
 *
 * Electron 미설치에서도 동작하도록 소스 파일을 **정적 파싱**한다(require 안 함).
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PRELOAD_SRC = fs.readFileSync(path.join(ROOT, 'electron', 'preload.js'), 'utf8');
const APP_SRC = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const MENU_SRC = fs.readFileSync(path.join(ROOT, 'electron', 'menu.js'), 'utf8');

/**
 * preload가 contextBridge.exposeInMainWorld('spip', { ... })에 노출하는 최상위 키를 추출.
 *   - exposeInMainWorld('spip', { ... }) 블록을 잡고, 그 안의 최상위 `key:` 식별자만 수집한다.
 *   - 중첩 객체(예: 콜백 본문) 진입은 깊이 추적으로 제외한다.
 */
function extractPreloadKeys(src) {
  const marker = "exposeInMainWorld('spip'";
  const at = src.indexOf(marker);
  assert.ok(at >= 0, "preload에서 exposeInMainWorld('spip', {...}) 블록을 찾지 못함");
  // 객체 리터럴 시작 '{'를 찾는다.
  const objStart = src.indexOf('{', at);
  assert.ok(objStart >= 0, 'spip 객체 리터럴 시작을 찾지 못함');

  const keys = new Set();
  let depth = 0;
  let i = objStart;
  // 토큰 단위가 아닌 문자 스캐닝 — 깊이 1(객체 최상위)에서 식별자 뒤 ':'만 키로 인정.
  for (; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') {
      depth++;
      continue;
    }
    if (ch === '}') {
      depth--;
      if (depth === 0) break; // spip 객체 종료
      continue;
    }
    // 깊이 1에서만 키 후보를 본다.
    if (depth === 1) {
      // 식별자 시작?
      if (/[A-Za-z_$]/.test(ch)) {
        let j = i;
        while (j < src.length && /[A-Za-z0-9_$]/.test(src[j])) j++;
        const word = src.slice(i, j);
        // 식별자 뒤 공백 무시 후 ':'면 키.
        let k = j;
        while (k < src.length && /\s/.test(src[k])) k++;
        if (src[k] === ':') keys.add(word);
        i = j - 1;
      }
    }
  }
  return keys;
}

/** renderer(app.js)가 ipc('<method>', ...)로 호출하는 메서드명을 모두 추출. */
function extractRendererMethods(src) {
  const methods = new Set();
  const re = /\bipc\(\s*(['"])([A-Za-z0-9_$]+)\1/g;
  let m;
  while ((m = re.exec(src)) !== null) methods.add(m[2]);
  return methods;
}

test('정합 — renderer ipc() 호출 메서드 ⊆ preload window.spip 노출 키 (P1-1/BUG-1 회귀)', () => {
  const exposed = extractPreloadKeys(PRELOAD_SRC);
  const used = extractRendererMethods(APP_SRC);

  // 사전 조건: 양쪽 모두 비어 있지 않아야 한다(파서 오작동 방어).
  assert.ok(exposed.size > 0, 'preload 노출 키를 하나도 추출하지 못함(파서 점검)');
  assert.ok(used.size > 0, 'renderer ipc() 호출을 하나도 추출하지 못함(파서 점검)');

  const missing = [...used].filter((m) => !exposed.has(m)).sort();
  assert.deepStrictEqual(
    missing,
    [],
    'renderer가 호출하지만 preload에 노출되지 않은 메서드: ' + JSON.stringify(missing)
      + ' | 노출=' + JSON.stringify([...exposed].sort())
      + ' | 호출=' + JSON.stringify([...used].sort()),
  );
});

test('정합 — open이 preload에 노출되고 채널 spip:openInVsCode로 invoke (계약 §4.1/§4.3)', () => {
  const exposed = extractPreloadKeys(PRELOAD_SRC);
  assert.ok(exposed.has('open'), "preload가 'open'을 노출해야 한다(계약 §4.3)");
  assert.ok(!exposed.has('openInVsCode'), "잘못된 'openInVsCode' 키는 제거되어야 한다(NOTE-2)");
  // open이 올바른 채널로 invoke하는지(채널명은 spip:openInVsCode 유지). M6: open(id, toolId?) 확장.
  assert.ok(
    /open\s*:\s*\(\s*id\s*(?:,\s*toolId\s*)?\)\s*=>\s*ipcRenderer\.invoke\(\s*'spip:openInVsCode'/.test(PRELOAD_SRC),
    "open은 'spip:openInVsCode' 채널로 invoke해야 한다",
  );
});

test('정합 — onMenu 계약: action 화이트리스트·채널·unsubscribe (P2-1)', () => {
  const exposed = extractPreloadKeys(PRELOAD_SRC);
  assert.ok(exposed.has('onMenu'), 'preload가 onMenu를 노출해야 한다(P2-1)');

  // onMenu가 4개 action 화이트리스트를 모두 구독하는지.
  for (const action of ['pickFolders', 'rescan', 'refresh', 'about']) {
    assert.ok(
      PRELOAD_SRC.includes("'" + action + "'") || PRELOAD_SRC.includes('spip:menu:'),
      'onMenu가 action을 다뤄야 함: ' + action,
    );
  }
  // 채널 접두 'spip:menu:' 사용 + unsubscribe 함수 반환 형태 확인.
  assert.ok(/spip:menu:/.test(PRELOAD_SRC), "onMenu는 'spip:menu:<action>' 채널을 구독해야 한다");
  assert.ok(/removeListener/.test(PRELOAD_SRC), 'onMenu는 unsubscribe(removeListener) 경로가 있어야 한다');
});

test('정합 — menu.js가 onMenu와 동일 action 집합을 send (dead wiring 해소)', () => {
  // menu.js가 보내는 spip:menu:<action> 채널 집합.
  const sent = new Set();
  const re = /spip:menu:([A-Za-z0-9_$]+)/g;
  let m;
  while ((m = re.exec(MENU_SRC)) !== null) sent.add(m[1]);

  // preload onMenu가 구독하는 action 집합(소스에서 추출).
  const subscribed = new Set();
  const re2 = /spip:menu:([A-Za-z0-9_$]+)/g;
  let m2;
  while ((m2 = re2.exec(PRELOAD_SRC)) !== null) subscribed.add(m2[1]);
  // preload는 배열로 action을 정의하므로 'spip:menu:' + action 형태 — 직접 채널 리터럴이 없을 수 있다.
  // 이 경우 actions 배열 리터럴에서 추출.
  if (subscribed.size === 0) {
    const arrMatch = PRELOAD_SRC.match(/\[\s*('pickFolders'[^\]]*)\]/);
    if (arrMatch) {
      const ids = arrMatch[1].match(/'([A-Za-z0-9_$]+)'/g) || [];
      for (const id of ids) subscribed.add(id.replace(/'/g, ''));
    }
  }

  // menu.js가 보내는 모든 action을 renderer(onMenu)가 구독해야 한다(고아 채널 금지).
  const orphan = [...sent].filter((a) => !subscribed.has(a)).sort();
  assert.deepStrictEqual(
    orphan,
    [],
    'menu.js가 보내지만 onMenu가 구독하지 않는 고아 채널: ' + JSON.stringify(orphan)
      + ' | send=' + JSON.stringify([...sent].sort())
      + ' | onMenu=' + JSON.stringify([...subscribed].sort()),
  );
});
