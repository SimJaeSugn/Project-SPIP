'use strict';
/**
 * lib/ai/llmClient.js — LLM 클라이언트 (L2·Langchain 격리 단일 경계)
 *
 * 설계 ②(R-34). Langchain(@langchain/openai)의 **유일 import 지점**. 호출마다 현재 config로
 * ChatOpenAI를 새로 구성한다(설정 변경이 재시작 없이 다음 호출에 반영). 스트리밍·AbortController·
 * timeout·에러 분류(고정 code)를 제공한다.
 *
 * 보안(M-2): apiKey·전체 baseURL을 로그/에러 payload에 **절대 남기지 않는다**(host만, 키 생략).
 *   logger는 자동 마스킹이 없으므로 호출처에서 키/URL을 로그 인자로 넘기지 않는 것이 규칙.
 *   에러는 고정 enum code만 반환(message·url·key·스택 비노출).
 *
 * 헤드리스 테스트(R-34 수용 기준): chatFactory 주입으로 ChatOpenAI 모킹(네트워크 0).
 *   기본은 require('@langchain/openai')의 ChatOpenAI. fetchImpl은 configuration.fetch로 전달.
 */

const C = require('./briefingConst');

// 에러 분류 code(설계 ② 표). 고정 enum — payload·로그에 이것만 노출.
const CODE = Object.freeze({
  OK: 'OK',
  DISABLED: 'DISABLED',
  CONN_REFUSED: 'CONN_REFUSED',
  TIMEOUT: 'TIMEOUT',
  AUTH: 'AUTH',
  NO_MODEL: 'NO_MODEL',
  PARSE: 'PARSE',
  ABORTED: 'ABORTED',
  INTERNAL: 'INTERNAL',
});

/** 원시 오류를 고정 code로 분류(message·url·key 비노출). */
function classifyError(err) {
  if (!err) return CODE.INTERNAL;
  if (err.name === 'AbortError' || err.code === 'ABORT_ERR' || /abort/i.test(err.message || '')) return CODE.ABORTED;
  const msg = String(err.message || '');
  const status = err.status || err.statusCode || (err.response && err.response.status);
  if (err.code === 'ECONNREFUSED' || /ECONNREFUSED|connect.*refused|fetch failed/i.test(msg)) return CODE.CONN_REFUSED;
  if (err.code === 'ETIMEDOUT' || err.name === 'TimeoutError' || /timeout|timed out/i.test(msg)) return CODE.TIMEOUT;
  if (status === 401 || status === 403 || /401|403|unauthor|forbidden/i.test(msg)) return CODE.AUTH;
  if (status === 404 || /404|not found|no.*model|model.*not/i.test(msg)) return CODE.NO_MODEL;
  return CODE.INTERNAL;
}

/** baseURL host만 추출(로그용 — 전체 URL·키 비노출). 실패 시 '<invalid>'. */
function hostOnly(baseURL) {
  try { return new URL(String(baseURL)).host; } catch (_) { return '<invalid>'; }
}

/**
 * LLM 클라이언트를 생성한다.
 * @param {object} deps { getConfig, logger?, chatFactory?, fetchImpl? }
 *   - getConfig() => config(briefing 포함). 호출 시점 스냅샷.
 *   - chatFactory(args) => ChatOpenAI 인스턴스(테스트 모킹). 기본 @langchain/openai.
 *   - fetchImpl: configuration.fetch 주입(헤드리스 모킹).
 */
function createLlmClient(deps) {
  deps = deps || {};
  const getConfig = typeof deps.getConfig === 'function' ? deps.getConfig : () => ({});
  const logger = deps.logger || null;
  const chatFactory = typeof deps.chatFactory === 'function'
    ? deps.chatFactory
    : (args) => {
      // Langchain 격리 — 유일 import 지점(지연 require: 헤드리스 테스트는 chatFactory 주입으로 우회).
      const { ChatOpenAI } = require('@langchain/openai');
      return new ChatOpenAI(args);
    };

  /** 호출 시점 config로 ChatOpenAI 인스턴스 구성. */
  function buildModel() {
    const cfg = getConfig() || {};
    const b = (cfg.briefing && typeof cfg.briefing === 'object') ? cfg.briefing : {};
    const configuration = { baseURL: b.baseURL };
    if (deps.fetchImpl) configuration.fetch = deps.fetchImpl;
    return chatFactory({
      model: b.model,
      apiKey: b.apiKey || 'not-needed', // 로컬은 보통 불필요. 키는 메인 메모리에만.
      temperature: (typeof b.temperature === 'number') ? b.temperature : C.DEFAULT_TEMPERATURE,
      maxTokens: (typeof b.maxTokens === 'number') ? b.maxTokens : C.DEFAULT_MAX_TOKENS,
      streaming: true,
      timeout: (typeof b.timeoutMs === 'number') ? b.timeoutMs : C.DEFAULT_TIMEOUT_MS,
      configuration,
    });
  }

  /** chunk에서 텍스트 추출(Langchain AIMessageChunk·문자열 호환). */
  function chunkText(chunk) {
    if (chunk == null) return '';
    if (typeof chunk === 'string') return chunk;
    const c = chunk.content;
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) return c.map((x) => (typeof x === 'string' ? x : (x && x.text) || '')).join('');
    return '';
  }

  /**
   * 스트리밍 1회 호출. onDelta(token)로 부분 토큰 전달. signal로 취소.
   * @param {object} args { system, user, signal?, onDelta? }
   * @returns {Promise<{ok:boolean, text:string, code:string}>}
   */
  async function streamBriefing(args) {
    args = args || {};
    const onDelta = typeof args.onDelta === 'function' ? args.onDelta : () => {};
    const messages = [
      { role: 'system', content: String(args.system || '') },
      { role: 'user', content: String(args.user || '') },
    ];
    // [security L-1] 외부 signal을 내부 컨트롤러로 체인 — 상한 초과 시 업스트림 stream을 abort.
    const inner = new AbortController();
    const onExternalAbort = () => { try { inner.abort(); } catch (_) { /* noop */ } };
    if (args.signal) {
      if (args.signal.aborted) inner.abort();
      else if (typeof args.signal.addEventListener === 'function') args.signal.addEventListener('abort', onExternalAbort);
    }
    let text = '';
    let capped = false;
    try {
      const model = buildModel();
      const stream = await model.stream(messages, { signal: inner.signal });
      for await (const chunk of stream) {
        const t = chunkText(chunk);
        if (!t) continue;
        // 상한 초과분만 잘라 담고 스트림 중단(부분 결과는 안전하게 보존·표시).
        const remaining = C.MAX_STREAM_CHARS - text.length;
        if (remaining <= 0) { capped = true; onExternalAbort(); break; }
        const piece = t.length > remaining ? t.slice(0, remaining) : t;
        text += piece;
        try { onDelta(piece); } catch (_) { /* 구독자 예외 격리 */ }
        if (text.length >= C.MAX_STREAM_CHARS) { capped = true; onExternalAbort(); break; }
      }
      if (args.signal && typeof args.signal.removeEventListener === 'function') args.signal.removeEventListener('abort', onExternalAbort);
      // capped여도 부분 결과로 정상 종료(done) — 무한 스트림 방어가 사용자 경험을 깨지 않게.
      if (logger && capped) logger.warn('브리핑 스트림 상한 도달 — 안전 절단', { code: CODE.OK });
      return { ok: true, text, code: CODE.OK };
    } catch (err) {
      if (args.signal && typeof args.signal.removeEventListener === 'function') args.signal.removeEventListener('abort', onExternalAbort);
      // 상한 도달로 우리가 abort한 경우 — 부분 결과를 정상 종료로 취급(서버측 무한 스트림 방어).
      if (capped) return { ok: true, text, code: CODE.OK };
      const code = classifyError(err);
      // M-2: host만 로그(키·전체 URL 비노출). 부분 결과는 보존(text).
      if (logger && code !== CODE.ABORTED) {
        const cfg = getConfig() || {};
        const host = hostOnly(cfg.briefing && cfg.briefing.baseURL);
        logger.warn('브리핑 LLM 호출 실패', { code, host });
      }
      return { ok: false, text, code };
    }
  }

  /**
   * R-39 연결 테스트 — 짧은 핑 호출. 모델명·지연·code 반환.
   * @param {object} args { signal? }
   * @returns {Promise<{ok:boolean, model?:string, latencyMs?:number, code:string}>}
   */
  async function testConnection(args) {
    args = args || {};
    const cfg = getConfig() || {};
    const b = (cfg.briefing && typeof cfg.briefing === 'object') ? cfg.briefing : {};
    const t0 = Date.now();
    const r = await streamBriefing({
      system: 'ping',
      user: 'Reply with: ok',
      signal: args.signal,
    });
    if (r.ok) return { ok: true, model: typeof b.model === 'string' ? b.model : '', latencyMs: Date.now() - t0, code: CODE.OK };
    return { ok: false, latencyMs: Date.now() - t0, code: r.code };
  }

  return { streamBriefing, testConnection };
}

module.exports = { createLlmClient, classifyError, hostOnly, CODE };
