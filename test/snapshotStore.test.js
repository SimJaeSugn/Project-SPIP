'use strict';
/**
 * snapshotStore.test.js — 스냅샷 적재 + 화이트리스트 + graceful (R-10, R-13, H-1, P2-5)
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { SnapshotStore } = require('../lib/server/snapshotStore');
const { Logger } = require('../lib/common/logger');
const pathGuard = require('../lib/common/pathGuard');

function tmpFile(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spip-store-'));
  return path.join(dir, name || 'projects.json');
}
function quiet() { return new Logger({ quiet: true }); }

test('부재 파일 → hasSnapshot:false, 빈 상태 graceful (P2-5)', () => {
  const store = new SnapshotStore();
  const r = store.load({ cachePath: tmpFile('nope.json'), logger: quiet() });
  assert.strictEqual(r.hasSnapshot, false);
  assert.strictEqual(store.hasSnapshot, false);
  assert.deepStrictEqual(store.getProjects(), []);
});

test('손상 JSON → hasSnapshot:false (크래시 없음)', () => {
  const f = tmpFile();
  fs.writeFileSync(f, '{ this is : not json');
  const store = new SnapshotStore();
  const r = store.load({ cachePath: f, logger: quiet() });
  assert.strictEqual(r.hasSnapshot, false);
});

test('정상 스냅샷 적재 + id 역참조 + 화이트리스트 폴드 키 구성 (H-1)', () => {
  // 실제 존재하는 디렉터리를 경로로 사용해 canonicalize/isAllowed 일관 검증.
  const realDir = fs.realpathSync.native
    ? fs.realpathSync.native(os.tmpdir())
    : fs.realpathSync(os.tmpdir());
  const snap = {
    schemaVersion: 1,
    generatedAt: '2026-06-21T00:00:00.000Z',
    projects: [
      { id: 'abc123', path: realDir, name: 'p1', language: { primary: 'Node.js' }, freshness: { isStale: false } },
      { id: 'bad', path: 42 }, // 손상 항목 — 건너뜀
    ],
  };
  const f = tmpFile();
  fs.writeFileSync(f, JSON.stringify(snap));

  const store = new SnapshotStore();
  const r = store.load({ cachePath: f, logger: quiet() });
  assert.strictEqual(r.hasSnapshot, true);
  assert.strictEqual(r.count, 1);
  assert.strictEqual(store.generatedAt, '2026-06-21T00:00:00.000Z');
  assert.ok(store.getById('abc123'));
  assert.strictEqual(store.getById('bad'), null);
  assert.strictEqual(store.getById('missing'), null);

  // 화이트리스트: 등록 경로는 isAllowed true, 임의 경로는 false (H-1).
  assert.strictEqual(pathGuard.isAllowed(realDir, store.getAllowKeySet()), true);
  assert.strictEqual(pathGuard.isAllowed(path.join(realDir, 'definitely-not-here-xyz'), store.getAllowKeySet()), false);
});

test('projects 비배열 → 빈 상태', () => {
  const f = tmpFile();
  fs.writeFileSync(f, JSON.stringify({ schemaVersion: 1, projects: 'oops' }));
  const store = new SnapshotStore();
  const r = store.load({ cachePath: f, logger: quiet() });
  assert.strictEqual(r.hasSnapshot, false);
});
