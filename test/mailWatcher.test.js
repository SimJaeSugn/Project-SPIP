'use strict';
/**
 * mailWatcher.test.js — lib/mail/mailWatcher.js (clientFactory·setInterval 주입, 헤드리스)
 *   · 기준선(baseline): 최초 폴링은 통지 안 함(폴더별)
 *   · 폴더별 UIDNEXT 증가 → onNewMail(newCount=증가분 합/unseen=폴더 합)
 *   · 비-INBOX 폴더로 분류된 새 메일도 감지(전 폴더 감시)
 *   · 무증가/감소 → 통지 안 함
 *   · 폴링 실패 격리(throw 안 함)
 *   · 재진입(_busy) 가드, start 자격 없음 → false, start/stop 멱등·interval clamp
 */
const { test } = require('node:test');
const assert = require('node:assert');

const { MailWatcher, DEFAULT_INTERVAL_MS, MIN_INTERVAL_MS } = require('../lib/mail/mailWatcher');

const quiet = { error() {}, warn() {}, info() {} };
const CREDS = { host: 'h', port: 993, user: 'u', pass: 'p' };
const noIv = () => ({ unref() {} }); // setInterval 주입(자동 실행 안 함)
const flush = () => new Promise((r) => setImmediate(r));

/** 호출마다 seq의 다음 STATUS 배열(전 폴더)을 반환하는 가짜 클라이언트 팩토리(마지막에서 고정). */
function factory(seq) {
  let i = 0;
  return () => ({ fetchAllStatus: async () => seq[Math.min(i++, seq.length - 1)] });
}
/** INBOX 단독 상태 배열 단축 헬퍼. */
const inbox = (uidnext, unseen) => [{ name: 'INBOX', uidnext, unseen }];

test('tick — 기준선: 최초 폴링은 통지 안 함(폴더별 기준선 설정)', async () => {
  const notes = [];
  const w = new MailWatcher({ logger: quiet, clientFactory: factory([inbox(5, 0)]) });
  w.start({ credentials: CREDS, onNewMail: (x) => notes.push(x), setInterval: noIv });
  await flush();
  assert.strictEqual(notes.length, 0, '기준선은 통지 없음');
  assert.strictEqual(w._lastUidnext.get('INBOX'), 5);
});

test('tick — UIDNEXT 증가 시 onNewMail(newCount/unseen)', async () => {
  const notes = [];
  const w = new MailWatcher({ logger: quiet, clientFactory: factory([inbox(5, 0), inbox(8, 3)]) });
  w.start({ credentials: CREDS, onNewMail: (x) => notes.push(x), setInterval: noIv });
  await flush();                 // 기준선(5)
  const payload = await w.tick(); // 8 → 새 메일 3통
  assert.deepStrictEqual(payload, { newCount: 3, unseen: 3, uidnext: 8 });
  assert.deepStrictEqual(notes, [{ newCount: 3, unseen: 3, uidnext: 8 }]);
});

test('tick — 비-INBOX 폴더로 분류된 새 메일도 감지(전 폴더 감시)', async () => {
  const notes = [];
  const w = new MailWatcher({
    logger: quiet,
    clientFactory: factory([
      [{ name: 'INBOX', uidnext: 5, unseen: 0 }, { name: 'Work', uidnext: 10, unseen: 0 }],
      [{ name: 'INBOX', uidnext: 5, unseen: 0 }, { name: 'Work', uidnext: 13, unseen: 3 }], // Work에 3통
    ]),
  });
  w.start({ credentials: CREDS, onNewMail: (x) => notes.push(x), setInterval: noIv });
  await flush();                  // 폴더별 기준선
  const payload = await w.tick();  // Work +3
  assert.strictEqual(payload.newCount, 3, 'Work 폴더 증가분 감지');
  assert.strictEqual(payload.unseen, 3, '폴더별 unseen 합');
  assert.strictEqual(payload.uidnext, 18, 'UIDNEXT 합(5+13) — 변경 토큰');
});

test('tick — 여러 폴더 동시 증가분 합산', async () => {
  const notes = [];
  const w = new MailWatcher({
    logger: quiet,
    clientFactory: factory([
      [{ name: 'INBOX', uidnext: 5, unseen: 1 }, { name: 'Work', uidnext: 10, unseen: 0 }],
      [{ name: 'INBOX', uidnext: 7, unseen: 2 }, { name: 'Work', uidnext: 12, unseen: 1 }], // +2, +2
    ]),
  });
  w.start({ credentials: CREDS, onNewMail: (x) => notes.push(x), setInterval: noIv });
  await flush();
  const payload = await w.tick();
  assert.strictEqual(payload.newCount, 4, 'INBOX(+2)+Work(+2)');
  assert.strictEqual(payload.unseen, 3, 'unseen 합(2+1)');
});

test('tick — 새로 나타난 폴더는 기준선만(오탐 방지)', async () => {
  const notes = [];
  const w = new MailWatcher({
    logger: quiet,
    clientFactory: factory([
      inbox(5, 0),
      [{ name: 'INBOX', uidnext: 5, unseen: 0 }, { name: 'New', uidnext: 99, unseen: 9 }], // New 폴더 첫 등장
    ]),
  });
  w.start({ credentials: CREDS, onNewMail: (x) => notes.push(x), setInterval: noIv });
  await flush();
  const payload = await w.tick();
  assert.strictEqual(payload, null, '처음 본 폴더의 과거 메일은 통지 안 함');
  assert.strictEqual(w._lastUidnext.get('New'), 99, '다음부터 기준선으로 사용');
});

test('tick — UIDNEXT 무증가면 통지 안 함', async () => {
  const notes = [];
  const w = new MailWatcher({ logger: quiet, clientFactory: factory([inbox(7), inbox(7)]) });
  w.start({ credentials: CREDS, onNewMail: (x) => notes.push(x), setInterval: noIv });
  await flush();
  const payload = await w.tick();
  assert.strictEqual(payload, null);
  assert.strictEqual(notes.length, 0);
});

test('tick — UIDNEXT 감소(메일함 재생성)는 기준선 재설정·미통지', async () => {
  const notes = [];
  const w = new MailWatcher({ logger: quiet, clientFactory: factory([inbox(20), inbox(4)]) });
  w.start({ credentials: CREDS, onNewMail: (x) => notes.push(x), setInterval: noIv });
  await flush();
  await w.tick();
  assert.strictEqual(notes.length, 0);
  assert.strictEqual(w._lastUidnext.get('INBOX'), 4, '줄어든 값으로 기준선 갱신');
});

test('tick — 일시(네트워크) 오류는 격리·감시 유지(재시도)', async () => {
  const notes = [];
  const w = new MailWatcher({
    logger: quiet,
    clientFactory: () => ({ fetchAllStatus: async () => { throw new Error('network down'); } }),
  });
  w.start({
    credentials: CREDS, onNewMail: (x) => notes.push(x),
    onAuthError: () => { throw new Error('일시 오류엔 onAuthError 호출 금지'); },
    setInterval: noIv,
  });
  await flush();
  const payload = await w.tick();
  assert.strictEqual(payload, null);
  assert.strictEqual(notes.length, 0);
  assert.strictEqual(w.isRunning(), true, '일시 오류엔 감시 유지');
});

test('tick — 인증 실패 시 감시 중단 + onAuthError 1회 + 이후 tick no-op', async () => {
  const authErr = () => { const e = new Error('IMAP NO: invalid'); e.authFailed = true; return e; };
  let calls = 0;
  const w = new MailWatcher({
    logger: quiet,
    clientFactory: () => ({ fetchAllStatus: async () => { throw authErr(); } }),
  });
  assert.strictEqual(w.start({ credentials: CREDS, onAuthError: () => { calls++; }, setInterval: noIv }), true);
  await flush();                    // 즉시 tick에서 인증 실패
  assert.strictEqual(w.isRunning(), false, '인증 실패 → 감시 중단');
  assert.strictEqual(calls, 1, 'onAuthError 1회');
  const r = await w.tick();         // 추가 호출은 즉시 no-op
  assert.strictEqual(r, null);
  assert.strictEqual(calls, 1, 'onAuthError 재호출 없음');
});

test('tick — 재진입(_busy) 가드: 진행 중 두 번째 호출은 즉시 null', async () => {
  let release;
  const w = new MailWatcher({
    logger: quiet,
    clientFactory: () => ({ fetchAllStatus: () => new Promise((r) => { release = () => r(inbox(5)); }) }),
  });
  // start 없이 직접 자격만 세팅(즉시 tick 미발생 통제).
  w._credentials = CREDS;
  const p1 = w.tick();          // 진행(pending)
  const r2 = await w.tick();    // _busy → 즉시 null
  assert.strictEqual(r2, null);
  release();
  await p1;
});

test('start — 자격 없으면 false 반환·미시작', () => {
  const w = new MailWatcher({ logger: quiet, clientFactory: factory([inbox(1)]) });
  assert.strictEqual(w.start({ setInterval: noIv }), false);
  assert.strictEqual(w.isRunning(), false);
});

test('start/stop — 멱등 + interval clamp + 기본값', () => {
  const w = new MailWatcher({ logger: quiet, intervalMs: 1000, clientFactory: factory([inbox(1)]) });
  assert.strictEqual(w.intervalMs, MIN_INTERVAL_MS, 'MIN 미만은 clamp');
  let scheduled = 0;
  const fakeIv = () => { scheduled++; return { unref() {} }; };
  assert.strictEqual(w.start({ credentials: CREDS, setInterval: fakeIv }), true);
  assert.strictEqual(w.isRunning(), true);
  w.start({ credentials: CREDS, setInterval: fakeIv }); // 멱등
  assert.strictEqual(scheduled, 1, 'start 멱등: 타이머 1회');
  w.stop();
  assert.strictEqual(w.isRunning(), false);
  w.stop(); // 멱등
  assert.strictEqual(w.isRunning(), false);

  const def = new MailWatcher({ logger: quiet });
  assert.strictEqual(def.intervalMs, DEFAULT_INTERVAL_MS);
});
