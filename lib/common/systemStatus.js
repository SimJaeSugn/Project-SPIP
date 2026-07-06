'use strict';
/**
 * lib/common/systemStatus.js — 개발 머신 시스템 상태(CPU·RAM·디스크) 수집 (로드맵 Phase 3·G ③)
 *
 * 외부 프로세스 0 — Node 내장 os(코어·부하·메모리) + fs.statfs(디스크)만 사용한다(safeExec 불요).
 *   · CPU 사용률: os.cpus() 누적 tick 을 짧은 간격으로 2회 샘플링해 idle 대비로 산출(순수 계산 cpuUsagePercent).
 *   · RAM: os.totalmem()/freemem().
 *   · 디스크: 등록 스캔 루트가 위치한 드라이브 루트(중복 제거·상한)만 fs.statfs. 렌더러가 임의 경로를 주지 않음
 *     (인자 없는 읽기 채널) → 경로 인젝션 표면 0. 드라이브 루트는 config 유래로만 도출.
 *
 * [헤드리스 검증, F-3] os/statfs/sleep/roots 를 ctx 로 주입 가능 — 순수 계산 로직 단위테스트.
 *
 * 외부 의존성 0 — os, fs(promises.statfs) + 주입 가능 deps.
 */

const os = require('os');
const fs = require('fs');

const MAX_DISKS = 8;          // 디스크 표시 상한
const SAMPLE_MS = 180;        // CPU 2회 샘플 간격

function clampPct(n) {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

/** os.cpus() 배열 → 누적 tick 스냅샷 { idle, total }(순수). */
function cpuSnapshot(cpus) {
  let idle = 0;
  let total = 0;
  for (const c of (Array.isArray(cpus) ? cpus : [])) {
    const t = (c && c.times) || {};
    idle += t.idle || 0;
    total += (t.user || 0) + (t.nice || 0) + (t.sys || 0) + (t.idle || 0) + (t.irq || 0);
  }
  return { idle, total };
}

/** 두 스냅샷 사이 CPU 사용률 %(순수). 총 delta 0 이하면 0. */
function cpuUsagePercent(a, b) {
  a = a || { idle: 0, total: 0 };
  b = b || { idle: 0, total: 0 };
  const idleDelta = b.idle - a.idle;
  const totalDelta = b.total - a.total;
  if (totalDelta <= 0) return 0;
  return clampPct((1 - idleDelta / totalDelta) * 100);
}

/** 경로 → 드라이브 루트(Windows 'C:\', POSIX '/'). 비문자열은 null. */
function driveRootOf(p) {
  if (typeof p !== 'string' || !p) return null;
  const m = /^([a-zA-Z]):/.exec(p);
  if (m) return m[1].toUpperCase() + ':\\';
  if (p[0] === '/') return '/';
  return null;
}

/** 루트 경로 배열 → 고유 드라이브 루트 목록(순서 보존·상한). 비면 [] (호출측이 폴백). */
function uniqueDriveRoots(roots, homedir) {
  const out = [];
  const seen = new Set();
  const push = (p) => {
    const r = driveRootOf(p);
    if (r && !seen.has(r)) { seen.add(r); out.push(r); }
  };
  if (Array.isArray(roots)) for (const p of roots) { if (out.length >= MAX_DISKS) break; push(p); }
  if (out.length === 0 && homedir) push(homedir); // 등록 루트 없으면 홈 드라이브 폴백
  return out.slice(0, MAX_DISKS);
}

/** 단일 드라이브 statfs → { mount, total, free, used, usagePercent } | null(오류·미지원 graceful). */
async function diskUsage(root, statfs) {
  try {
    const st = await statfs(root);
    const bsize = Number(st.bsize) || 0;
    const total = bsize * Number(st.blocks || 0);
    const free = bsize * Number(st.bavail != null ? st.bavail : st.bfree || 0);
    if (!(total > 0)) return null;
    const used = Math.max(0, total - free);
    return { mount: root, total: total, free: free, used: used, usagePercent: clampPct((used / total) * 100) };
  } catch (_) {
    return null; // 미지원(구 Node)·권한·소멸 — 격리
  }
}

/** 기본 sleep(주입 가능). */
function defaultSleep(ms) { return new Promise((res) => setTimeout(res, ms)); }

/**
 * 시스템 상태 수집. 절대 throw 안 함 — 부분 실패는 각 항목 graceful.
 * @param {object} [ctx] { os?, statfs?, sleep?, roots?, sampleMs? } (테스트 주입)
 * @returns {Promise<{ok:true, cpu, memory, disks, uptime, platform}>}
 */
async function collect(ctx) {
  ctx = ctx || {};
  const _os = ctx.os || os;
  // statfs 는 키가 명시되면 그 값을 그대로(테스트가 '미지원'을 주입 가능), 아니면 실제 fs.promises.statfs.
  const statfs = Object.prototype.hasOwnProperty.call(ctx, 'statfs') ? ctx.statfs : (fs.promises && fs.promises.statfs);
  const sleep = ctx.sleep || defaultSleep;
  const sampleMs = (typeof ctx.sampleMs === 'number' && ctx.sampleMs >= 0) ? ctx.sampleMs : SAMPLE_MS;

  // CPU — 2회 샘플.
  let cpus1 = [];
  try { cpus1 = _os.cpus() || []; } catch (_) { cpus1 = []; }
  const snap1 = cpuSnapshot(cpus1);
  await sleep(sampleMs);
  let cpus2 = [];
  try { cpus2 = _os.cpus() || []; } catch (_) { cpus2 = []; }
  const snap2 = cpuSnapshot(cpus2);
  const cores = Array.isArray(cpus2) && cpus2.length ? cpus2.length : (Array.isArray(cpus1) ? cpus1.length : 0);
  const model = (Array.isArray(cpus2) && cpus2[0] && typeof cpus2[0].model === 'string') ? cpus2[0].model.trim() : '';
  const cpu = { cores: cores, model: model, usagePercent: cpuUsagePercent(snap1, snap2) };

  // RAM.
  let total = 0;
  let free = 0;
  try { total = Number(_os.totalmem()) || 0; } catch (_) { total = 0; }
  try { free = Number(_os.freemem()) || 0; } catch (_) { free = 0; }
  const usedMem = Math.max(0, total - free);
  const memory = { total: total, free: free, used: usedMem, usagePercent: total > 0 ? clampPct((usedMem / total) * 100) : 0 };

  // 디스크 — 등록 루트 드라이브(+홈 폴백).
  let homedir = '';
  try { homedir = _os.homedir ? _os.homedir() : ''; } catch (_) { homedir = ''; }
  const roots = uniqueDriveRoots(ctx.roots, homedir);
  const disks = [];
  if (typeof statfs === 'function') {
    for (const r of roots) {
      const d = await diskUsage(r, statfs); // eslint-disable-line no-await-in-loop
      if (d) disks.push(d);
    }
  }

  let uptime = 0;
  try { uptime = Number(_os.uptime()) || 0; } catch (_) { uptime = 0; }
  let platform = '';
  try { platform = _os.platform ? String(_os.platform()) : ''; } catch (_) { platform = ''; }

  return { ok: true, cpu: cpu, memory: memory, disks: disks, uptime: uptime, platform: platform };
}

module.exports = {
  collect,
  cpuSnapshot,
  cpuUsagePercent,
  driveRootOf,
  uniqueDriveRoots,
  diskUsage,
  clampPct,
  MAX_DISKS,
  SAMPLE_MS,
};
