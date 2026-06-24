'use strict';
/**
 * briefing-front.test.js — M13 브리핑 AI 프런트(R-35/R-39/R-40/R-41, 헤드리스 F-3).
 *   순수 로직(gen 가드·항목 그룹·폴백 힌트·external·설정 뷰) + 보안 정적 검증(innerHTML 0·키 비노출).
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const {
  briefingAcceptsGen, briefingGroupItems, briefingFallbackHint,
  isExternalBaseURL, briefingSettingsView, BRIEFING_CATEGORIES,
} = require('../public/app.js');
const APP_SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

// ── R-35 gen 가드 ──
test('R-35 — briefingAcceptsGen: msgGen >= curGen 수용, 미만(취소분) 무시', () => {
  assert.strictEqual(briefingAcceptsGen(3, 3), true);
  assert.strictEqual(briefingAcceptsGen(3, 4), true);   // 새 세대
  assert.strictEqual(briefingAcceptsGen(3, 2), false);  // 이전 세대 잔여 토큰
  assert.strictEqual(briefingAcceptsGen(0, 0), true);
});
test('R-35 — briefingAcceptsGen: 비수치 gen 무시(graceful)', () => {
  assert.strictEqual(briefingAcceptsGen(1, NaN), false);
  assert.strictEqual(briefingAcceptsGen(1, undefined), false);
  assert.strictEqual(briefingAcceptsGen(1, 'x'), false);
});

// ── R-41 항목 그룹핑 ──
test('R-41 — briefingGroupItems: urgent→must→good 순서, 미지 분류는 good', () => {
  const items = [
    { key: 'a', category: 'good', title: 'G' },
    { key: 'b', category: 'urgent', title: 'U' },
    { key: 'c', category: 'must', title: 'M' },
    { key: 'd', category: 'weird', title: 'W' }, // 미지 → good
  ];
  const groups = briefingGroupItems(items);
  assert.deepStrictEqual(groups.map((g) => g.id), ['urgent', 'must', 'good']);
  assert.deepStrictEqual(groups[2].items.map((i) => i.key).sort(), ['a', 'd']);
});
test('R-41 — briefingGroupItems: 빈 그룹 제외, 비정상 항목 폐기', () => {
  const groups = briefingGroupItems([{ key: 'x', category: 'urgent', title: 'U' }, null, { title: 'no-key' }, 'str']);
  assert.strictEqual(groups.length, 1);
  assert.strictEqual(groups[0].id, 'urgent');
});
test('R-41 — briefingGroupItems: 비배열 → 빈 배열', () => {
  assert.deepStrictEqual(briefingGroupItems(null), []);
  assert.deepStrictEqual(briefingGroupItems(undefined), []);
});
test('R-41 — BRIEFING_CATEGORIES: 3분류 라벨', () => {
  assert.deepStrictEqual(BRIEFING_CATEGORIES.map((c) => c.id), ['urgent', 'must', 'good']);
});

// ── R-40 폴백 힌트 ──
test('R-40 — briefingFallbackHint: disabled / error code 별 문구', () => {
  assert.ok(/꺼져/.test(briefingFallbackHint('disabled')));
  assert.ok(/서버가 실행/.test(briefingFallbackHint('error', 'CONN_REFUSED')));
  assert.ok(/지연/.test(briefingFallbackHint('error', 'TIMEOUT')));
  assert.ok(/해석/.test(briefingFallbackHint('error', 'PARSE')));
  assert.ok(/주소/.test(briefingFallbackHint('error', 'BAD_URL')));
  assert.ok(briefingFallbackHint('error', 'WHATEVER').length > 0); // 기본 문구
});
test('R-40 — briefingFallbackHint: 정상 상태는 빈 문자열(안내 없음)', () => {
  assert.strictEqual(briefingFallbackHint('done'), '');
  assert.strictEqual(briefingFallbackHint('streaming'), '');
  assert.strictEqual(briefingFallbackHint('idle'), '');
});

// ── M-1 external host ──
test('M-1 — isExternalBaseURL: localhost 류는 false, 외부는 true', () => {
  assert.strictEqual(isExternalBaseURL('http://127.0.0.1:1234/v1'), false);
  assert.strictEqual(isExternalBaseURL('http://localhost:1234/v1'), false);
  assert.strictEqual(isExternalBaseURL('http://[::1]:1234/v1'), false);
  assert.strictEqual(isExternalBaseURL('https://api.example.com/v1'), true);
  assert.strictEqual(isExternalBaseURL('http://192.168.0.5:1234'), true);
});
test('M-1 — isExternalBaseURL: 빈/불량 URL → false(차단 아님·경고만)', () => {
  assert.strictEqual(isExternalBaseURL(''), false);
  assert.strictEqual(isExternalBaseURL('not a url'), false);
  assert.strictEqual(isExternalBaseURL(null), false);
});

// ── R-39 설정 뷰(키 평문 없음) ──
test('R-39 — briefingSettingsView: hasApiKey 불리언만, apiKey 평문 미포함', () => {
  const v = briefingSettingsView({ ok: true, enabled: true, baseURL: 'http://127.0.0.1:1234/v1', model: 'm', hasApiKey: true, advanced: { coalesceMs: 2000, deadlineH: 24 } });
  assert.strictEqual(v.enabled, true);
  assert.strictEqual(v.hasApiKey, true);
  assert.strictEqual(v.external, false);
  assert.strictEqual(v.advanced.coalesceMs, 2000);
  assert.ok(!('apiKey' in v), 'apiKey 평문 키 없음');
});
test('R-39 — briefingSettingsView: external 파생, graceful 기본', () => {
  const v = briefingSettingsView({ ok: true, enabled: false, baseURL: 'https://ext.example/v1', hasApiKey: false });
  assert.strictEqual(v.external, true);
  const d = briefingSettingsView(null);
  assert.strictEqual(d.enabled, false);
  assert.strictEqual(d.hasApiKey, false);
  assert.strictEqual(d.baseURL, '');
});

// ── 보안 정적: 모델 출력 textContent 만(innerHTML 0), 키 비노출 ──
function renderBriefingBody() {
  const start = APP_SRC.indexOf('function renderBriefingCard()');
  const end = APP_SRC.indexOf('function patchBriefing()', start);
  return APP_SRC.slice(start, end > start ? end : start + 4000);
}
test('M13 보안 — 브리핑 렌더는 innerHTML/insertAdjacentHTML 미사용(L-1, 마크다운→HTML 0)', () => {
  const b = renderBriefingBody();
  assert.ok(!/innerHTML/.test(b), 'innerHTML 금지');
  assert.ok(!/insertAdjacentHTML/.test(b), 'insertAdjacentHTML 금지');
  assert.ok(/text:\s*String\(it\.title/.test(b) || /text:\s*b\.streamText/.test(b), 'textContent(el text) 경로');
});
test('M13 보안 — 스트림 텍스트는 textContent(streamText)로만', () => {
  const b = renderBriefingBody();
  assert.ok(/cls:\s*'briefing-card__stream',\s*text:\s*b\.streamText/.test(b), 'streamText 는 text(=textContent)');
});
test('M13 보안 — apiKey 평문 store 미보관(keyInput 만, 저장 후 비움)', () => {
  // store.briefing 에 apiKey 평문 필드 없음(keyInput 은 입력 임시값).
  assert.ok(!/store\.briefing\.apiKey/.test(APP_SRC), 'store.briefing.apiKey 평문 보관 없음');
  assert.ok(/store\.briefing\.keyInput\s*=\s*''/.test(APP_SRC), '저장/응답 후 keyInput 비움');
});
test('R-41 — resolveBriefingItem 이 resolveItem(key, action) 호출', () => {
  const start = APP_SRC.indexOf('function resolveBriefingItem(');
  const b = APP_SRC.slice(start, start + 500);
  assert.ok(/spip\.briefing\.resolveItem\(key,\s*action\)/.test(b), 'resolveItem(key, action)');
  assert.ok(/done|dismiss/.test(APP_SRC), "done/dismiss action");
});
test('R-35 — 브리핑 영역은 patchRegion(.briefing-region) 으로 갱신', () => {
  assert.ok(/querySelector\('\.briefing-region'\)/.test(APP_SRC), '.briefing-region 대상');
  assert.ok(/cls:\s*'briefing-region'/.test(APP_SRC), 'renderHome 이 .briefing-region 2단 래퍼');
});
test('R-39 — 설정 integration 카테고리에 briefing 섹션 추가', () => {
  assert.ok(/sections:\s*\['tools',\s*'mail',\s*'briefing'\]/.test(APP_SRC), 'integration 에 briefing');
  assert.ok(/case 'briefing':\s*return renderBriefingSettings\(\)/.test(APP_SRC), 'buildSettingsSection 디스패치');
});
test('M13 — onDelta/onDone 핸들러가 gen 가드(briefingAcceptsGen) 적용', () => {
  assert.ok(/onDelta[\s\S]{0,200}briefingAcceptsGen\(store\.briefing\.gen,\s*p\.gen\)/.test(APP_SRC), 'onDelta gen 가드');
  assert.ok(/onDone[\s\S]{0,200}briefingAcceptsGen\(store\.briefing\.gen,\s*p\.gen\)/.test(APP_SRC), 'onDone gen 가드');
});
