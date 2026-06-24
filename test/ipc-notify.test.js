'use strict';
/**
 * ipc-notify.test.js — electron/ipc/notify.js (백로그2-4, 헤드리스·showNotification 주입)
 */
const { test } = require('node:test');
const assert = require('node:assert');
const notify = require('../electron/ipc/notify');

test('notify — showNotification 위임 + title/body 정제·길이상한', () => {
  const calls = [];
  const ctx = { showNotification: (a) => calls.push(a) };
  const r = notify.notify({ title: '할 일 마감', body: '배포' + String.fromCharCode(7) + ' 확인' }, ctx);
  assert.ok(r.ok);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].title, '할 일 마감');
  assert.strictEqual(calls[0].body, '배포 확인', '제어문자(BEL) 제거');
  // 길이 상한.
  const long = notify.clean('a'.repeat(500), notify.MAX_BODY);
  assert.strictEqual(long.length, notify.MAX_BODY);
});

test('notify — 빈 입력 EMPTY, 표시자 부재 UNAVAILABLE, 표시 예외 INTERNAL', () => {
  assert.strictEqual(notify.notify({ title: '', body: '' }, { showNotification: () => {} }).code, 'EMPTY');
  assert.strictEqual(notify.notify({ title: 'x' }, {}).code, 'UNAVAILABLE');
  const r = notify.notify({ title: 'x' }, { showNotification: () => { throw new Error('boom'); } });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 'INTERNAL');
});
