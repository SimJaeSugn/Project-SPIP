'use strict';
/**
 * test/ai/config-briefing.test.js — briefing URL/SSRF 검증·불량 폴백 (R-39·N-08·M-1)
 */
const { test } = require('node:test');
const assert = require('node:assert');
const config = require('../../lib/common/config');
const { Logger } = require('../../lib/common/logger');

function quiet() { return new Logger({ quiet: true }); }

test('M-1 — 자격증명 임베디드 URL 거부', () => {
  assert.strictEqual(config.validateBriefingUrl('http://user:pass@127.0.0.1:1234/v1').ok, false);
  assert.strictEqual(config.validateBriefingUrl('http://user@host/v1').ok, false);
});

test('M-1 — scheme 화이트리스트(http/https만)', () => {
  assert.strictEqual(config.validateBriefingUrl('file:///etc/passwd').ok, false);
  assert.strictEqual(config.validateBriefingUrl('ftp://host/x').ok, false);
  assert.strictEqual(config.validateBriefingUrl('http://127.0.0.1:1234/v1').ok, true);
  assert.strictEqual(config.validateBriefingUrl('https://host/v1').ok, true);
});

test('M-1 — 외부 host 플래그(비-localhost)', () => {
  assert.strictEqual(config.validateBriefingUrl('http://127.0.0.1:1234/v1').external, false);
  assert.strictEqual(config.validateBriefingUrl('http://localhost:1234/v1').external, false);
  assert.strictEqual(config.validateBriefingUrl('http://192.168.1.5:1234/v1').external, true);
  assert.strictEqual(config.validateBriefingUrl('https://api.example.com/v1').external, true);
});

test('M-1 — 길이 상한 초과·비문자열 거부', () => {
  assert.strictEqual(config.validateBriefingUrl('http://h/' + 'a'.repeat(3000)).ok, false);
  assert.strictEqual(config.validateBriefingUrl(42).ok, false);
  assert.strictEqual(config.validateBriefingUrl(null).ok, false);
});

test('R-39 — normalizeBriefing 불량 baseURL → 기본값 폴백', () => {
  const b = config.normalizeBriefing({ baseURL: 'file:///x' }, quiet());
  assert.strictEqual(b.baseURL, config.DEFAULTS.briefing.baseURL);
});

test('R-39 — normalizeBriefing 유효값 채택·키 평문 보존', () => {
  const b = config.normalizeBriefing({
    enabled: true, baseURL: 'http://localhost:5000/v1', model: 'foo', apiKey: 'sk-x',
    temperature: 0.7, maxTokens: 512, advanced: { coalesceMs: 1000, deadlineH: 12 },
  }, quiet());
  assert.strictEqual(b.enabled, true);
  assert.strictEqual(b.baseURL, 'http://localhost:5000/v1');
  assert.strictEqual(b.model, 'foo');
  assert.strictEqual(b.apiKey, 'sk-x');
  assert.strictEqual(b.temperature, 0.7);
  assert.strictEqual(b.advanced.coalesceMs, 1000);
});

test('R-39 — 범위 밖 수치는 기본값(temperature·advanced)', () => {
  const b = config.normalizeBriefing({ temperature: 99, advanced: { coalesceMs: -5 } }, quiet());
  assert.strictEqual(b.temperature, config.DEFAULTS.briefing.temperature);
  assert.strictEqual(b.advanced.coalesceMs, config.DEFAULTS.briefing.advanced.coalesceMs);
});

test('R-39 — 손상/비객체 입력 graceful 기본값', () => {
  const b = config.normalizeBriefing('x', quiet());
  assert.strictEqual(b.enabled, false);
  assert.strictEqual(b.baseURL, config.DEFAULTS.briefing.baseURL);
});

test('R-39 — loadConfig가 briefing 포함', () => {
  const fs = require('fs'); const os = require('os'); const path = require('path');
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'spip-cfgb-')));
  const cfgPath = path.join(dir, 'spip.config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({ scanRoots: [], briefing: { enabled: true, model: 'z' } }));
  const { config: c } = config.loadConfig({ logger: quiet(), configPath: cfgPath });
  assert.strictEqual(c.briefing.enabled, true);
  assert.strictEqual(c.briefing.model, 'z');
});
