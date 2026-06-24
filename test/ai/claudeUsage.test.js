'use strict';
/**
 * claudeUsage.test.js — Claude Code 로컬 토큰 사용량 집계 모듈 테스트.
 *
 * 임시 픽스처 디렉토리(<tmp>/.claude/projects/...)를 구성해
 * summarizeClaudeUsage 를 검증한다. 실제 ~/.claude 는 절대 건드리지 않는다.
 *
 * 검증 항목:
 *  - totals 합산
 *  - today 필터(고정 now 주입)
 *  - byModel 그룹/정렬
 *  - 깨진 JSON 라인 skip
 *  - 용량 상한 초과 파일 skip + logger.warn
 *  - .claude 없으면 available=false
 *  - (message.id, requestId) dedupe
 *  - daily 일별 시계열(윈도우 길이/버킷 배치/제로 데이/정렬)
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const {
  summarizeClaudeUsage,
  MAX_FILE_BYTES,
  DEFAULT_DAYS,
  MIN_DAYS,
  MAX_DAYS,
} = require('../../lib/ai/claudeUsage');

// ── 픽스처 헬퍼 ──────────────────────────────────────────────
let tmpRoots = [];

function makeTmpHome() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spip-claudeUsage-'));
  tmpRoots.push(root);
  return root;
}

function projectsDir(home) {
  const d = path.join(home, '.claude', 'projects', 'proj-A');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

// assistant usage 라인 1건 생성.
function usageLine({ id, requestId, ts, model, input, output, cacheCreate, cacheRead }) {
  return JSON.stringify({
    type: 'assistant',
    requestId,
    timestamp: ts,
    message: {
      model,
      id,
      content: '비밀 메시지 본문 — 집계에 절대 포함되면 안 됨',
      usage: {
        input_tokens: input,
        output_tokens: output,
        cache_creation_input_tokens: cacheCreate,
        cache_read_input_tokens: cacheRead,
      },
    },
  });
}

function cleanup() {
  for (const r of tmpRoots) {
    try {
      fs.rmSync(r, { recursive: true, force: true });
    } catch (_) {
      /* ignore */
    }
  }
  tmpRoots = [];
}

test.afterEach(cleanup);

// 고정 now: 2026-06-25 (로컬). 픽스처 timestamp 도 같은 날짜를 '오늘'로 본다.
const NOW = new Date('2026-06-25T10:00:00');

// ── 테스트 ───────────────────────────────────────────────────

test('available=false — .claude 디렉토리 없으면 비활성', () => {
  const home = makeTmpHome(); // .claude 미생성
  const r = summarizeClaudeUsage({ homeDir: home, now: NOW, fs });
  assert.strictEqual(r.available, false);
  assert.strictEqual(r.totals.messages, 0);
  assert.strictEqual(r.scannedFiles, 0);
  assert.deepStrictEqual(r.byModel, []);
  assert.strictEqual(r.lastAt, null);
});

test('totals 합산 + today 필터 + lastAt — 오늘/과거 혼합', () => {
  const home = makeTmpHome();
  const d = projectsDir(home);
  const lines = [
    // 오늘 2건
    usageLine({ id: 'msg_1', requestId: 'req_1', ts: '2026-06-25T01:00:00.000Z', model: 'claude-opus-4-8', input: 100, output: 10, cacheCreate: 5, cacheRead: 50 }),
    usageLine({ id: 'msg_2', requestId: 'req_2', ts: '2026-06-25T02:00:00.000Z', model: 'claude-opus-4-8', input: 200, output: 20, cacheCreate: 0, cacheRead: 0 }),
    // 과거 1건
    usageLine({ id: 'msg_3', requestId: 'req_3', ts: '2026-06-20T05:00:00.000Z', model: 'claude-sonnet-4', input: 1000, output: 100, cacheCreate: 10, cacheRead: 10 }),
  ];
  fs.writeFileSync(path.join(d, 's1.jsonl'), lines.join('\n') + '\n');

  const r = summarizeClaudeUsage({ homeDir: home, now: NOW, fs });
  assert.strictEqual(r.available, true);
  assert.strictEqual(r.scannedFiles, 1);

  // totals = 3건 합산
  assert.strictEqual(r.totals.messages, 3);
  assert.strictEqual(r.totals.inputTokens, 1300);
  assert.strictEqual(r.totals.outputTokens, 130);
  assert.strictEqual(r.totals.cacheCreateTokens, 15);
  assert.strictEqual(r.totals.cacheReadTokens, 60);
  assert.strictEqual(r.totals.totalTokens, 1300 + 130 + 15 + 60);

  // today = 오늘 2건만
  assert.strictEqual(r.today.messages, 2);
  assert.strictEqual(r.today.inputTokens, 300);
  assert.strictEqual(r.today.outputTokens, 30);
  assert.strictEqual(r.today.totalTokens, 300 + 30 + 5 + 50);

  // lastAt = 가장 최근 timestamp
  assert.strictEqual(r.lastAt, '2026-06-25T02:00:00.000Z');
});

test('byModel — 모델별 그룹/총량 내림차순 정렬', () => {
  const home = makeTmpHome();
  const d = projectsDir(home);
  const lines = [
    usageLine({ id: 'a1', requestId: 'r1', ts: '2026-06-25T01:00:00.000Z', model: 'claude-sonnet-4', input: 50, output: 5, cacheCreate: 0, cacheRead: 0 }),
    usageLine({ id: 'a2', requestId: 'r2', ts: '2026-06-25T01:00:00.000Z', model: 'claude-opus-4-8', input: 500, output: 50, cacheCreate: 0, cacheRead: 0 }),
    usageLine({ id: 'a3', requestId: 'r3', ts: '2026-06-25T01:00:00.000Z', model: 'claude-opus-4-8', input: 100, output: 10, cacheCreate: 0, cacheRead: 0 }),
  ];
  fs.writeFileSync(path.join(d, 's1.jsonl'), lines.join('\n') + '\n');

  const r = summarizeClaudeUsage({ homeDir: home, now: NOW, fs });
  assert.strictEqual(r.byModel.length, 2);
  // opus 총합(660) > sonnet(55) → opus 먼저
  assert.strictEqual(r.byModel[0].model, 'claude-opus-4-8');
  assert.strictEqual(r.byModel[0].messages, 2);
  assert.strictEqual(r.byModel[0].totalTokens, 660);
  assert.strictEqual(r.byModel[1].model, 'claude-sonnet-4');
  assert.strictEqual(r.byModel[1].messages, 1);
  assert.strictEqual(r.byModel[1].totalTokens, 55);
});

test('깨진 JSON 라인/비대상 타입 skip — 정상 라인만 집계', () => {
  const home = makeTmpHome();
  const d = projectsDir(home);
  const content = [
    '{ this is not valid json',
    '', // 빈 줄
    JSON.stringify({ type: 'user', message: { content: 'hi' } }), // 비-assistant
    JSON.stringify({ type: 'assistant', message: { model: 'x', id: 'z' } }), // usage 없음
    usageLine({ id: 'ok1', requestId: 'rq1', ts: '2026-06-25T01:00:00.000Z', model: 'claude-opus-4-8', input: 10, output: 1, cacheCreate: 0, cacheRead: 0 }),
    '}{ broken trailing',
  ].join('\n');
  fs.writeFileSync(path.join(d, 's1.jsonl'), content);

  const r = summarizeClaudeUsage({ homeDir: home, now: NOW, fs });
  assert.strictEqual(r.totals.messages, 1);
  assert.strictEqual(r.totals.inputTokens, 10);
});

test('용량 상한 초과 파일 skip + logger.warn 경고', () => {
  const home = makeTmpHome();
  const d = projectsDir(home);

  const warnings = [];
  const logger = { warn: (m) => warnings.push(m) };

  // 정상 파일.
  fs.writeFileSync(
    path.join(d, 'small.jsonl'),
    usageLine({ id: 'ok', requestId: 'r', ts: '2026-06-25T01:00:00.000Z', model: 'm', input: 7, output: 1, cacheCreate: 0, cacheRead: 0 }) + '\n'
  );

  // 용량 상한을 초과하는 fake fs 로 stat 만 키워 skip 유도(실제 64MB 안 만듦).
  const bigPath = path.join(d, 'big.jsonl');
  fs.writeFileSync(bigPath, '{}');
  const fakeFs = Object.create(fs);
  fakeFs.statSync = (p) => {
    const real = fs.statSync(p);
    if (p === bigPath) {
      return { ...real, size: MAX_FILE_BYTES + 1, isFile: () => true, isDirectory: () => false };
    }
    return real;
  };

  const r = summarizeClaudeUsage({ homeDir: home, now: NOW, fs: fakeFs, logger });
  // big.jsonl 은 집계 제외 → 정상 1건만.
  assert.strictEqual(r.totals.messages, 1);
  assert.strictEqual(r.totals.inputTokens, 7);
  assert.ok(warnings.some((w) => w.includes('big.jsonl') && w.includes('상한')));
});

test('dedupe — 같은 (message.id, requestId) 중복은 1건만 집계', () => {
  const home = makeTmpHome();
  const d = projectsDir(home);
  const same = usageLine({ id: 'dup_msg', requestId: 'dup_req', ts: '2026-06-25T01:00:00.000Z', model: 'claude-opus-4-8', input: 100, output: 10, cacheCreate: 0, cacheRead: 0 });

  // 같은 레코드를 같은 파일 2회 + 다른 파일 1회 = 총 3회 등장.
  fs.writeFileSync(path.join(d, 's1.jsonl'), same + '\n' + same + '\n');
  fs.writeFileSync(path.join(d, 's2.jsonl'), same + '\n');

  const r = summarizeClaudeUsage({ homeDir: home, now: NOW, fs });
  assert.strictEqual(r.scannedFiles, 2);
  assert.strictEqual(r.totals.messages, 1); // 중복 제거 → 1건
  assert.strictEqual(r.totals.inputTokens, 100);
});

test('수치/모델명 robustness — 음수·비유한 0 처리, 모델명 길이 클램프', () => {
  const home = makeTmpHome();
  const d = projectsDir(home);
  const longModel = 'm'.repeat(500);
  const lines = [
    JSON.stringify({
      type: 'assistant',
      requestId: 'r1',
      timestamp: '2026-06-25T01:00:00.000Z',
      message: {
        model: longModel,
        id: 'm1',
        usage: { input_tokens: -5, output_tokens: 'NaN', cache_creation_input_tokens: 3, cache_read_input_tokens: null },
      },
    }),
  ];
  fs.writeFileSync(path.join(d, 's1.jsonl'), lines.join('\n') + '\n');

  const r = summarizeClaudeUsage({ homeDir: home, now: NOW, fs });
  assert.strictEqual(r.totals.messages, 1);
  assert.strictEqual(r.totals.inputTokens, 0); // 음수 → 0
  assert.strictEqual(r.totals.outputTokens, 0); // 'NaN' → 0
  assert.strictEqual(r.totals.cacheCreateTokens, 3);
  assert.strictEqual(r.totals.cacheReadTokens, 0); // null → 0
  // 모델명 길이 클램프.
  assert.ok(r.byModel[0].model.length <= 120);
});

test('now 미주입 시 Date.now() 기본 — 예외 없이 동작', () => {
  const home = makeTmpHome();
  projectsDir(home);
  const r = summarizeClaudeUsage({ homeDir: home, fs });
  assert.strictEqual(r.available, true);
  assert.strictEqual(typeof r.totals.messages, 'number');
});

// ── daily 시계열 테스트 ───────────────────────────────────────

// 로컬 캘린더 기준 NOW 에서 offsetDays 일 전의 로컬 'YYYY-MM-DD' 키.
function localDayKeyOf(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function dayKeyAgo(offsetDays) {
  const d = new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() - offsetDays);
  return localDayKeyOf(d);
}
// offsetDays 일 전 로컬 정오의 ISO 문자열(로컬→UTC 변환, 로컬 일자 안정적).
function localNoonIso(offsetDays) {
  const d = new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() - offsetDays, 12, 0, 0);
  return d.toISOString();
}

test('daily — 기본 길이(30)와 커스텀 길이(7)', () => {
  const home = makeTmpHome();
  projectsDir(home);

  const def = summarizeClaudeUsage({ homeDir: home, now: NOW, fs });
  assert.strictEqual(def.daily.length, DEFAULT_DAYS);
  assert.strictEqual(def.daily.length, 30);

  const seven = summarizeClaudeUsage({ homeDir: home, now: NOW, days: 7, fs });
  assert.strictEqual(seven.daily.length, 7);
});

test('daily — 버킷이 올바른 로컬 날짜에 배치 + oldest→newest 정렬', () => {
  const home = makeTmpHome();
  projectsDir(home);

  const r = summarizeClaudeUsage({ homeDir: home, now: NOW, days: 7, fs });
  // 마지막 버킷 = 오늘, 첫 버킷 = 6일 전.
  assert.strictEqual(r.daily[6].date, dayKeyAgo(0));
  assert.strictEqual(r.daily[0].date, dayKeyAgo(6));

  // oldest→newest: date 가 단조 증가.
  for (let i = 1; i < r.daily.length; i++) {
    assert.ok(r.daily[i - 1].date < r.daily[i].date, `정렬 위반: ${r.daily[i - 1].date} < ${r.daily[i].date}`);
  }
});

test('daily — 오늘 레코드는 마지막 버킷이며 today.totalTokens 와 일치', () => {
  const home = makeTmpHome();
  const d = projectsDir(home);
  const lines = [
    usageLine({ id: 'm_today', requestId: 'r_today', ts: localNoonIso(0), model: 'claude-opus-4-8', input: 100, output: 10, cacheCreate: 5, cacheRead: 50 }),
    usageLine({ id: 'm_today2', requestId: 'r_today2', ts: localNoonIso(0), model: 'claude-opus-4-8', input: 200, output: 20, cacheCreate: 0, cacheRead: 0 }),
  ];
  fs.writeFileSync(path.join(d, 's1.jsonl'), lines.join('\n') + '\n');

  const r = summarizeClaudeUsage({ homeDir: home, now: NOW, days: 7, fs });
  const last = r.daily[r.daily.length - 1];
  assert.strictEqual(last.date, dayKeyAgo(0));
  assert.strictEqual(last.messages, 2);
  // daily 의 totalTokens 는 today.totalTokens 와 일치.
  assert.strictEqual(last.totalTokens, r.today.totalTokens);
  assert.strictEqual(last.inputTokens, 300);
  assert.strictEqual(last.outputTokens, 30);
});

test('daily — N일 전 레코드는 올바른 버킷에 배치', () => {
  const home = makeTmpHome();
  const d = projectsDir(home);
  // 3일 전 레코드.
  fs.writeFileSync(
    path.join(d, 's1.jsonl'),
    usageLine({ id: 'm_3', requestId: 'r_3', ts: localNoonIso(3), model: 'claude-opus-4-8', input: 70, output: 7, cacheCreate: 0, cacheRead: 0 }) + '\n'
  );

  const r = summarizeClaudeUsage({ homeDir: home, now: NOW, days: 7, fs });
  // days=7, oldest→newest: index 4 가 3일 전(=6-3).
  const target = r.daily.find((e) => e.date === dayKeyAgo(3));
  assert.ok(target, '3일 전 버킷 존재');
  assert.strictEqual(target.messages, 1);
  assert.strictEqual(target.inputTokens, 70);
  assert.strictEqual(target.outputTokens, 7);
  assert.strictEqual(target.totalTokens, 77);
  // 오늘 버킷은 비어있음.
  assert.strictEqual(r.daily[r.daily.length - 1].messages, 0);
});

test('daily — 윈도우보다 오래된 레코드는 daily 제외, totals 에는 포함', () => {
  const home = makeTmpHome();
  const d = projectsDir(home);
  const lines = [
    // 윈도우 안(2일 전).
    usageLine({ id: 'm_in', requestId: 'r_in', ts: localNoonIso(2), model: 'm', input: 10, output: 1, cacheCreate: 0, cacheRead: 0 }),
    // 윈도우 밖(10일 전, days=7).
    usageLine({ id: 'm_old', requestId: 'r_old', ts: localNoonIso(10), model: 'm', input: 1000, output: 100, cacheCreate: 0, cacheRead: 0 }),
  ];
  fs.writeFileSync(path.join(d, 's1.jsonl'), lines.join('\n') + '\n');

  const r = summarizeClaudeUsage({ homeDir: home, now: NOW, days: 7, fs });

  // daily 합계 = 윈도우 안 1건만.
  const dailyMsgs = r.daily.reduce((s, e) => s + e.messages, 0);
  const dailyTokens = r.daily.reduce((s, e) => s + e.totalTokens, 0);
  assert.strictEqual(dailyMsgs, 1);
  assert.strictEqual(dailyTokens, 11);
  // 오래된 날짜 키는 daily 에 없음.
  assert.strictEqual(r.daily.some((e) => e.date === dayKeyAgo(10)), false);

  // totals 에는 둘 다 포함.
  assert.strictEqual(r.totals.messages, 2);
  assert.strictEqual(r.totals.totalTokens, 11 + 1100);
});

test('daily — 활동 없는 날도 0 으로 존재(연속 축)', () => {
  const home = makeTmpHome();
  const d = projectsDir(home);
  // 오늘만 1건.
  fs.writeFileSync(
    path.join(d, 's1.jsonl'),
    usageLine({ id: 'm0', requestId: 'r0', ts: localNoonIso(0), model: 'm', input: 5, output: 1, cacheCreate: 0, cacheRead: 0 }) + '\n'
  );

  const r = summarizeClaudeUsage({ homeDir: home, now: NOW, days: 5, fs });
  assert.strictEqual(r.daily.length, 5);
  // 마지막(오늘) 제외 모든 버킷은 0.
  for (let i = 0; i < r.daily.length - 1; i++) {
    assert.strictEqual(r.daily[i].messages, 0);
    assert.strictEqual(r.daily[i].totalTokens, 0);
    assert.strictEqual(r.daily[i].inputTokens, 0);
    assert.strictEqual(r.daily[i].outputTokens, 0);
  }
});

test('daily — days 클램프(범위 밖/비정상 입력)', () => {
  const home = makeTmpHome();
  projectsDir(home);

  // 0 → MIN_DAYS.
  assert.strictEqual(summarizeClaudeUsage({ homeDir: home, now: NOW, days: 0, fs }).daily.length, MIN_DAYS);
  // 음수 → MIN_DAYS.
  assert.strictEqual(summarizeClaudeUsage({ homeDir: home, now: NOW, days: -5, fs }).daily.length, MIN_DAYS);
  // 과대 → MAX_DAYS.
  assert.strictEqual(summarizeClaudeUsage({ homeDir: home, now: NOW, days: 99999, fs }).daily.length, MAX_DAYS);
  // 비유한/비숫자 → 기본값.
  assert.strictEqual(summarizeClaudeUsage({ homeDir: home, now: NOW, days: NaN, fs }).daily.length, DEFAULT_DAYS);
  assert.strictEqual(summarizeClaudeUsage({ homeDir: home, now: NOW, days: 'abc', fs }).daily.length, DEFAULT_DAYS);
  // 소수 → 내림.
  assert.strictEqual(summarizeClaudeUsage({ homeDir: home, now: NOW, days: 3.9, fs }).daily.length, 3);
});
