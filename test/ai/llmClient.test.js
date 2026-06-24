'use strict';
/**
 * test/ai/llmClient.test.js — 스트림·취소·타임아웃·에러 code·로그 누출 0 (R-34·R-40·M-2)
 * chatFactory 주입 모킹 — 네트워크 0.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const { createLlmClient, classifyError, hostOnly, CODE } = require('../../lib/ai/llmClient');

const CFG = { briefing: { baseURL: 'http://127.0.0.1:1234/v1', model: 'm1', apiKey: 'sk-secret-xyz' } };

/** chunk를 yield하는 async 스트림 모킹 ChatOpenAI. */
function fakeChat(chunks, opts) {
  opts = opts || {};
  return () => ({
    async stream(_messages, callOpts) {
      if (opts.throwError) throw opts.throwError;
      return (async function* () {
        for (const c of chunks) {
          if (callOpts && callOpts.signal && callOpts.signal.aborted) {
            const e = new Error('aborted'); e.name = 'AbortError'; throw e;
          }
          yield { content: c };
        }
      })();
    },
  });
}

test('R-34 — 스트림 토큰 누적·onDelta 호출', async () => {
  const got = [];
  const client = createLlmClient({ getConfig: () => CFG, chatFactory: fakeChat(['He', 'llo']) });
  const r = await client.streamBriefing({ system: 's', user: 'u', onDelta: (t) => got.push(t) });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.text, 'Hello');
  assert.deepStrictEqual(got, ['He', 'llo']);
  assert.strictEqual(r.code, CODE.OK);
});

test('R-34 — AbortController 취소 시 ABORTED code·부분 결과 유지', async () => {
  const ctrl = new AbortController();
  const client = createLlmClient({
    getConfig: () => CFG,
    chatFactory: () => ({
      async stream(_m, callOpts) {
        return (async function* () {
          yield { content: 'part' };
          ctrl.abort();
          if (callOpts.signal.aborted) { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
        })();
      },
    }),
  });
  const r = await client.streamBriefing({ system: 's', user: 'u', signal: ctrl.signal });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, CODE.ABORTED);
  assert.strictEqual(r.text, 'part', '부분 결과 보존');
});

test('R-40 — ECONNREFUSED → CONN_REFUSED', async () => {
  const err = new Error('connect ECONNREFUSED'); err.code = 'ECONNREFUSED';
  const client = createLlmClient({ getConfig: () => CFG, chatFactory: fakeChat([], { throwError: err }) });
  const r = await client.streamBriefing({ system: 's', user: 'u' });
  assert.strictEqual(r.code, CODE.CONN_REFUSED);
});

test('R-40 — 타임아웃 → TIMEOUT', async () => {
  const err = new Error('request timed out'); err.code = 'ETIMEDOUT';
  const client = createLlmClient({ getConfig: () => CFG, chatFactory: fakeChat([], { throwError: err }) });
  assert.strictEqual((await client.streamBriefing({})).code, CODE.TIMEOUT);
});

test('R-40 — 401/403 → AUTH, 404 → NO_MODEL', () => {
  assert.strictEqual(classifyError({ status: 401, message: 'x' }), CODE.AUTH);
  assert.strictEqual(classifyError({ status: 403, message: 'x' }), CODE.AUTH);
  assert.strictEqual(classifyError({ status: 404, message: 'x' }), CODE.NO_MODEL);
  assert.strictEqual(classifyError(new Error('weird')), CODE.INTERNAL);
});

test('M-2 — 실패 로그에 apiKey·전체 baseURL 누출 0(host만)', async () => {
  const logged = [];
  const logger = { warn: (reason, meta) => logged.push({ reason, meta }) };
  const err = new Error('connect ECONNREFUSED 127.0.0.1:1234'); err.code = 'ECONNREFUSED';
  const client = createLlmClient({ getConfig: () => CFG, logger, chatFactory: fakeChat([], { throwError: err }) });
  await client.streamBriefing({ system: 's', user: 'u' });
  const all = JSON.stringify(logged);
  assert.ok(!all.includes('sk-secret-xyz'), 'apiKey 미노출');
  assert.ok(!all.includes('/v1'), '전체 baseURL 미노출');
  assert.ok(all.includes('127.0.0.1:1234'), 'host만 노출');
});

test('M-2 — ABORTED는 로그하지 않음', async () => {
  const logged = [];
  const logger = { warn: (r, m) => logged.push({ r, m }) };
  const e = new Error('aborted'); e.name = 'AbortError';
  const client = createLlmClient({ getConfig: () => CFG, logger, chatFactory: fakeChat([], { throwError: e }) });
  await client.streamBriefing({});
  assert.strictEqual(logged.length, 0);
});

test('hostOnly — host 추출·불량 graceful', () => {
  assert.strictEqual(hostOnly('http://127.0.0.1:1234/v1'), '127.0.0.1:1234');
  assert.strictEqual(hostOnly('not a url'), '<invalid>');
});

test('R-39 — testConnection 성공 시 model·latency 반환', async () => {
  const client = createLlmClient({ getConfig: () => CFG, chatFactory: fakeChat(['ok']) });
  const r = await client.testConnection({});
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.model, 'm1');
  assert.ok(typeof r.latencyMs === 'number');
});

// ── [항목3] 토큰 usage 캡처 ──

/** 텍스트 청크들 + 마지막에 usage_metadata만 실린(텍스트 없는) 청크를 yield. */
function fakeChatWithUsage(textChunks, usageMeta) {
  return () => ({
    async stream() {
      return (async function* () {
        for (const c of textChunks) yield { content: c };
        yield { content: '', usage_metadata: usageMeta }; // 마지막 청크(텍스트 없음)
      })();
    },
  });
}

test('[항목3] 스트림 usage_metadata → r.usage(input/output/total 정규화)', async () => {
  const client = createLlmClient({
    getConfig: () => CFG,
    chatFactory: fakeChatWithUsage(['He', 'llo'], { input_tokens: 12, output_tokens: 8, total_tokens: 20 }),
  });
  const r = await client.streamBriefing({ system: 's', user: 'u' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.text, 'Hello', '텍스트는 그대로 누적(빈 usage 청크는 본문에 영향 없음)');
  assert.deepStrictEqual(r.usage, { promptTokens: 12, completionTokens: 8, totalTokens: 20 });
});

test('[항목3] usage 없으면 r.usage=null, total 누락 시 input+output로 보정', async () => {
  const noUsage = createLlmClient({ getConfig: () => CFG, chatFactory: fakeChat(['x']) });
  assert.strictEqual((await noUsage.streamBriefing({})).usage, null);

  const partial = createLlmClient({
    getConfig: () => CFG,
    chatFactory: fakeChatWithUsage(['y'], { input_tokens: 5, output_tokens: 7 }), // total 누락
  });
  const r = await partial.streamBriefing({});
  assert.deepStrictEqual(r.usage, { promptTokens: 5, completionTokens: 7, totalTokens: 12 });
});
