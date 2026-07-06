'use strict';
/**
 * systemStatus.test.js — lib/common/systemStatus.js (로드맵 Phase 3·G ③, 헤드리스)
 *   CPU 사용률·드라이브 루트·디스크 statfs·collect 통합. os/statfs/sleep 주입(외부 프로세스·실디스크 무관).
 */
const { test } = require('node:test');
const assert = require('node:assert');
const ss = require('../lib/common/systemStatus');

test('cpuUsagePercent — idle/total delta 로 사용률(순수·클램프)', () => {
  assert.strictEqual(ss.cpuUsagePercent({ idle: 100, total: 200 }, { idle: 150, total: 300 }), 50); // idle+50 / total+100
  assert.strictEqual(ss.cpuUsagePercent({ idle: 0, total: 0 }, { idle: 10, total: 100 }), 90);
  assert.strictEqual(ss.cpuUsagePercent({ idle: 0, total: 0 }, { idle: 0, total: 0 }), 0); // delta 0 → 0
  assert.strictEqual(ss.cpuUsagePercent({ idle: 50, total: 100 }, { idle: 50, total: 100 }), 0); // 완전 idle
});

test('cpuSnapshot — times 누적(순수·부재 필드 0)', () => {
  const snap = ss.cpuSnapshot([{ times: { user: 10, sys: 5, idle: 85 } }, { times: { user: 20, idle: 80, irq: 0 } }]);
  assert.strictEqual(snap.idle, 165);
  assert.strictEqual(snap.total, 10 + 5 + 85 + 20 + 80);
  assert.deepStrictEqual(ss.cpuSnapshot(null), { idle: 0, total: 0 });
});

test('driveRootOf — Windows 드라이브/POSIX/비문자열', () => {
  assert.strictEqual(ss.driveRootOf('D:\\a\\b'), 'D:\\');
  assert.strictEqual(ss.driveRootOf('c:\\x'), 'C:\\'); // 대문자 정규화
  assert.strictEqual(ss.driveRootOf('/home/x'), '/');
  assert.strictEqual(ss.driveRootOf(''), null);
  assert.strictEqual(ss.driveRootOf(42), null);
});

test('uniqueDriveRoots — 중복 제거·순서 보존·상한·홈 폴백', () => {
  assert.deepStrictEqual(ss.uniqueDriveRoots(['C:\\a', 'c:\\b', 'D:\\x'], 'E:\\home'), ['C:\\', 'D:\\']);
  assert.deepStrictEqual(ss.uniqueDriveRoots([], 'E:\\home'), ['E:\\'], '루트 없으면 홈 드라이브');
  assert.deepStrictEqual(ss.uniqueDriveRoots(null, null), []);
  // 상한.
  const many = [];
  for (let i = 0; i < 20; i++) many.push(String.fromCharCode(65 + i) + ':\\p');
  assert.strictEqual(ss.uniqueDriveRoots(many, null).length, ss.MAX_DISKS);
});

test('diskUsage — statfs → 용량/사용률(bavail 우선) + 오류 격리', async () => {
  const statfs = async () => ({ bsize: 4096, blocks: 1000000, bavail: 250000, bfree: 250000 });
  const d = await ss.diskUsage('C:\\', statfs);
  assert.strictEqual(d.total, 4096 * 1000000);
  assert.strictEqual(d.free, 4096 * 250000);
  assert.strictEqual(d.usagePercent, 75); // used 75%
  // total 0 → null.
  assert.strictEqual(await ss.diskUsage('C:\\', async () => ({ bsize: 0, blocks: 0 })), null);
  // throw → null(격리).
  assert.strictEqual(await ss.diskUsage('C:\\', async () => { throw new Error('x'); }), null);
});

test('collect — os/statfs/sleep 주입으로 통합 스냅샷(외부 무관)', async () => {
  const fakeOs = {
    cpus: () => [{ model: 'Test CPU  ', times: { user: 10, nice: 0, sys: 5, idle: 85, irq: 0 } }],
    totalmem: () => 16e9, freemem: () => 4e9, homedir: () => 'C:\\Users\\x', uptime: () => 3600, platform: () => 'win32',
  };
  const statfs = async () => ({ bsize: 4096, blocks: 1000000, bavail: 100000, bfree: 100000 });
  const r = await ss.collect({ os: fakeOs, statfs, roots: ['C:\\proj', 'C:\\proj2'], sleep: async () => {}, sampleMs: 0 });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.cpu.cores, 1);
  assert.strictEqual(r.cpu.model, 'Test CPU'); // trim
  assert.strictEqual(r.memory.usagePercent, 75); // used 12e9/16e9
  assert.strictEqual(r.disks.length, 1); // C:\ 중복 제거
  assert.strictEqual(r.disks[0].usagePercent, 90);
  assert.strictEqual(r.platform, 'win32');
});

test('collect — statfs 미지원(구 Node)이면 disks 빈 배열 graceful', async () => {
  const fakeOs = { cpus: () => [], totalmem: () => 8e9, freemem: () => 8e9, homedir: () => 'C:\\x', uptime: () => 0, platform: () => 'win32' };
  const r = await ss.collect({ os: fakeOs, statfs: undefined, roots: ['C:\\p'], sleep: async () => {}, sampleMs: 0 });
  assert.deepStrictEqual(r.disks, []);
  assert.strictEqual(r.memory.usagePercent, 0); // used 0
  assert.strictEqual(r.ok, true);
});
