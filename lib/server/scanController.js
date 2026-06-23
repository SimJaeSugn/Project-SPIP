'use strict';
/**
 * lib/server/scanController.js — 재스캔 동시성·진행 상태 컨트롤러 (R-16, R-15) — M4
 *
 * 서버 프로세스 내 전역 단일 인스턴스. 재스캔의 동시성·진행을 한 곳에서 관리한다.
 *
 * [동시성 — ADR-M4-1] 전역 단일 in-flight 락(running). 중복 요청은 acquire()가 null을 반환해
 *   호출부(actionHandlers)가 409 SCAN_IN_PROGRESS로 거부한다(대기열 없음).
 *
 * [데드락 방지 — M4-M-3 / C-4 / P1-1] start()는 try/finally로 성공·실패·예외 무관 항상
 *   running=false 해제. 추가로 watchdog(config.scan.watchdogMs) 초과 시 phase='error' +
 *   **락 즉시 강제 해제**(running=false) → 가용성 데드락(영구 409) 방지. scanner.scan이
 *   협조적 취소를 지원하지 않아 무한정 hang하더라도, watchdog 콜백이 running을 직접 풀어
 *   후속 rescan이 즉시 202를 받게 한다. phase='error'에서도 idle로 복귀 가능.
 *
 * [세대(scanId) 가드 — C-4] watchdog가 락을 강제 해제하면 버려진(orphaned) 스캔이 나중에
 *   settle해 finally에 도달할 수 있다. 그 사이 새 스캔이 acquire되어 다른 scanId로 running
 *   중일 수 있으므로, finally·진행 병합·finalizing은 **현재 활성 scanId와 일치할 때만** 상태/락을
 *   건드린다. 즉 버려진 run은 새 스캔의 상태·락을 절대 덮어쓰지 않는다(_isActive 가드).
 *
 * [진행 — R-15] scanner의 onProgress(ScanProgress)로 state를 갱신한다. scanner가 주는
 *   currentPath(절대 실경로)는 currentPathAbs(서버 메모리 전용)로만 보관하고, status() 응답엔
 *   shortenPath로 basename 축약해서만 노출한다(M4-H-1, L-3). scanId·elapsedMs·startedAt·note는
 *   컨트롤러가 자기 state에 합성한다.
 *
 * [scanId — §8.3/M4-L-1] acquire()가 crypto.randomBytes(8).hex(16자) 발급. 인가 아닌 표시·상관용.
 *
 * 외부 의존성 0 — crypto(내장) + 내부(scanner, serializer).
 */

const crypto = require('crypto');
const scanner = require('../scan/scanner');
const serializer = require('../scan/serializer');
const { defaultLogger } = require('../common/logger');

/**
 * [M4-H-1/§3.4] 절대 실경로를 마지막 1~2 세그먼트(basename)로 축약한다.
 * 드라이브 루트·전체 절대경로는 노출하지 않는다. 응답·로그 모두 이 축약값만 쓴다.
 * @param {string|null} abs canonical 절대 실경로
 * @returns {string|null}
 */
function shortenPath(abs) {
  if (typeof abs !== 'string' || !abs) return null;
  const parts = abs.split(/[\\/]+/).filter(Boolean);
  if (parts.length === 0) return null;
  const out = parts.slice(-2).join('/') || null;
  // [보안 L-1] 드라이브 루트 단독(예: shortenPath('C:\\')→"C:")이 드라이브 문자만 노출하지
  //   않도록 일반 placeholder로 치환(빈/루트는 노출 가치 없는 일반 라벨).
  if (out !== null && /^[A-Za-z]:$/.test(out)) return '드라이브 루트';
  return out;
}

class ScanController {
  constructor(opts) {
    opts = opts || {};
    this.logger = opts.logger || defaultLogger;
    this.running = false;
    this._wd = null;
    this._resetState();
  }

  _resetState() {
    this.state = {
      phase: 'idle',
      scanId: null,
      dirs: 0,
      found: 0,
      currentPathAbs: null, // 서버 메모리 전용(응답 미노출)
      startedAtMs: 0,
      startedAt: null,
      counts: null,
      note: null,
    };
  }

  /**
   * 락 시도. 성공 시 scanId 발급·running=true, 실패(이미 running) 시 null.
   * @param {object} [opts] { note }
   * @returns {{ scanId:string, startedAt:string } | null}
   */
  acquire(opts) {
    if (this.running) return null;
    this.running = true;
    const scanId = crypto.randomBytes(8).toString('hex'); // §8.3 16자 hex
    const startedAtMs = Date.now();
    const startedAt = new Date(startedAtMs).toISOString();
    this._resetState();
    this.state.phase = 'scanning';
    this.state.scanId = scanId;
    this.state.startedAtMs = startedAtMs;
    this.state.startedAt = startedAt;
    this.state.note = (opts && opts.note) || null;
    return { scanId, startedAt };
  }

  /**
   * [C-4 세대 가드] 주어진 scanId가 현재 활성(running 중인) 스캔과 일치하는지.
   * watchdog로 버려진 run이 나중에 settle해 새 스캔의 상태/락을 덮어쓰지 못하게 한다.
   * @param {string} scanId 해당 run이 acquire 시 받은 scanId
   * @returns {boolean}
   */
  _isActive(scanId) {
    return this.running === true && this.state.scanId === scanId;
  }

  /**
   * scanner의 onProgress(ScanProgress) 콜백 — state에 진행 병합(서버 메모리).
   * scanId·elapsedMs·startedAt·note는 여기서 덮어쓰지 않는다(컨트롤러 소유).
   * [C-4] 버려진(orphaned) run의 늦은 진행 병합은 무시한다(세대 가드).
   */
  _merge(p, scanId) {
    if (!p || typeof p !== 'object') return;
    if (scanId !== undefined && !this._isActive(scanId)) return; // 버려진 run의 진행 무시
    if (typeof p.dirs === 'number') this.state.dirs = p.dirs;
    if (typeof p.found === 'number') this.state.found = p.found;
    if (typeof p.currentPath === 'string') this.state.currentPathAbs = p.currentPath;
    if (p.counts && typeof p.counts === 'object') this.state.counts = p.counts;
  }

  /**
   * watchdog 발화 시 강제 error 진입 + **락 즉시 강제 해제**(C-4/P1-1).
   * scanner.scan이 협조적 취소를 못 하므로 finally를 기다리지 않고 여기서 running을 푼다.
   * 이후 늦게 settle되는 그 run의 finally는 세대 가드(_isActive)로 새 스캔을 건드리지 못한다.
   */
  _forceError(reason) {
    this.state.phase = 'error';
    this.state.note = '스캔 실패';
    this.running = false; // ★ 즉시 락 해제 — 영구 409 데드락 방지(M4-M-3 보증 성립)
    this.logger.error('scan forced error', { reason });
  }

  /**
   * 백그라운드 스캔 시작. 대기하지 않는다(호출부는 즉시 202 반환).
   * @param {object} opts { config, withSize, allDrives, roots, store, logger, cachePath, onProgress }
   *   - onProgress?: (snapshot) => void  [F-1] 선택적 진행 구독 콜백. 매 진행마다
   *     status()(shortenPath 축약, M4-H-1)를 인자로 호출한다. main이 webContents.send로
   *     renderer에 push하는 용도. 사적 _merge는 외부에서 호출하지 않는다(캡슐화 보존).
   */
  start(opts) {
    opts = opts || {};
    const config = opts.config || {};
    const logger = opts.logger || this.logger;
    const watchdogMs = (config.scan && config.scan.watchdogMs) || 10 * 60 * 1000;
    // [C-4 세대 가드] 이 run이 소유한 scanId. acquire가 발급한 현재 활성 scanId를 캡처한다.
    //   finally·finalizing·진행 병합은 이 scanId가 여전히 활성일 때만 상태/락을 건드린다.
    const myScanId = this.state.scanId;
    const cachePath = opts.cachePath; // [P2-2] 커스텀 cachePath 전파(미지정이면 기본 경로)

    // [BUGFIX] 진행 push는 scanner.scan의 onProgress(=scanning phase)에서만 발생했고,
    //   finalizing→done(및 error) 전이는 push되지 않았다. push 모델(R-15)에는 폴링이 없어
    //   renderer가 done을 영영 못 받아 scanning 뷰에 갇힌다(무한 로딩). 터미널 phase 전이도
    //   자기 세대가 활성일 때 한 번 더 emit한다. 구독자 예외는 격리(스캔 진행 무영향).
    const emit = () => {
      if (typeof opts.onProgress === 'function' && this._isActive(myScanId)) {
        try { opts.onProgress(this.status()); } catch (_) { /* 구독자 예외 격리 */ }
      }
    };

    // 백그라운드 비동기 실행 — 의도적으로 await하지 않는다(202 즉시 반환).
    const run = async () => {
      let wdFired = false;
      const wd = setTimeout(() => {
        wdFired = true;
        // [C-4] watchdog는 자기 세대가 아직 활성일 때만 강제 해제(이미 정상 종료/교체됐으면 무동작).
        if (this._isActive(myScanId)) this._forceError('WATCHDOG_TIMEOUT');
      }, watchdogMs);
      this._wd = wd;
      try {
        const snap = await scanner.scan({
          roots: opts.roots || config.scanRoots || [],
          excludes: config.excludes || [],
          detectSignals: config.detectSignals, // 프로젝트 인식 기준(설정)
          staleDays: config.staleDays,
          depthLimit: config.depthLimit,
          allDrives: opts.allDrives === true,
          withSize: opts.withSize === true,
          size: config.size,
          maxDirs: config.scan && config.scan.maxDirs,
          timeBudgetMs: config.scan && config.scan.timeBudgetMs,
          logger,
          // [F-1 / electron-migration §4.3] onProgress 래핑:
          //   기존 내부 _merge 동작은 그대로 보존(무변경)하고, 호출부가 start(opts)에
          //   선택적 opts.onProgress를 넘기면 자기 세대가 활성일 때만 그 콜백을 추가 호출한다.
          //   콜백에는 status()(shortenPath 축약된 currentPath만 노출)를 전달한다(M4-H-1).
          //   구독자 콜백 예외는 격리해 스캔 진행을 방해하지 않는다.
          onProgress: (p) => {
            this._merge(p, myScanId);
            if (typeof opts.onProgress === 'function' && this._isActive(myScanId)) {
              try { opts.onProgress(this.status()); } catch (_) { /* 구독자 예외 격리 */ }
            }
          },
        });

        // [C-4] watchdog가 발화했거나(버려짐) 다른 스캔이 락을 가져갔으면 결과를 버린다.
        //   늦게 settle된 orphaned run이 새 스캔의 상태/스냅샷을 덮어쓰지 못하게 한다.
        if (wdFired || !this._isActive(myScanId)) return;

        // finalizing: writeSnapshot + store.load() 구간(§3.3).
        this.state.phase = 'finalizing';
        this.state.counts = snap.counts || null;
        emit(); // [BUGFIX] finalizing phase push(진행 패널 마무리 표시).
        // [P2-2] cachePath 일관 전파 — 커스텀 경로 기동 시 write/load 양쪽 동일 경로.
        serializer.writeSnapshot(snap, { logger, cachePath }); // 원자 0600(M-2)
        if (opts.store && typeof opts.store.load === 'function') {
          opts.store.load({ logger, cachePath }); // graceful·idempotent(P2-5) 무중단 교체
        }
        // finalizing 도중 watchdog가 발화했을 수 있으니 다시 확인 후 done 전이.
        if (this._isActive(myScanId)) {
          this.state.phase = 'done';
          emit(); // [BUGFIX] done phase push → renderer refetch 트리거(무한 로딩 해소).
        }
      } catch (err) {
        // [C-4] 자기 세대가 활성일 때만 error 상태 기록(버려진 run은 새 스캔을 안 건드림).
        if (this._isActive(myScanId)) {
          this.state.phase = 'error';
          this.state.note = '스캔 실패'; // 내부정보 비노출(L-3)
          emit(); // [BUGFIX] error phase push → renderer 오류 화면 전환.
        }
        logger.error('background scan failed', err);
      } finally {
        clearTimeout(wd);
        if (this._wd === wd) this._wd = null;
        // [C-4 세대 가드] 자기 세대가 여전히 활성일 때만 락 해제. watchdog가 이미 풀고
        //   새 스캔이 시작됐다면 여기서 running을 건드리면 새 스캔의 락을 부수므로 금지.
        if (this._isActive(myScanId)) this.running = false; // 정상 경로 해제(M4-M-3)
      }
    };

    run().catch((err) => {
      // run 자체가 throw하는 경우(이론상 없음)도 자기 세대 락만 해제.
      if (this._isActive(myScanId)) {
        this.state.phase = 'error';
        this.running = false;
      }
      try { clearTimeout(this._wd); } catch (_) { /* noop */ }
      if (this._wd) this._wd = null;
      logger.error('scan run wrapper failed', err);
    });
  }

  /**
   * [P2-4] 리소스 정리 — 앱 종료/창 파괴 시 호출한다. 진행 중 watchdog 타이머를 해제해
   *   장시간 hang 스캔에서도 프로세스가 매달리지 않게 한다(타이머 leak 방지).
   *   진행 중인 백그라운드 scanner.scan은 협조적 취소를 지원하지 않으므로 강제 중단하지
   *   않으나, 타이머는 unref/clear해 깔끔한 종료 경로를 보장한다. 멱등.
   */
  dispose() {
    try { if (this._wd) clearTimeout(this._wd); } catch (_) { /* noop */ }
    this._wd = null;
  }

  /**
   * 현재 진행 스냅샷(ScanProgress). 락 없으면 phase는 마지막 종료 상태(done/error) 또는 idle.
   * currentPath는 shortenPath(currentPathAbs)로 basename 축약(M4-H-1).
   */
  status() {
    const s = this.state;
    const elapsedMs = s.startedAtMs ? Date.now() - s.startedAtMs : 0;
    return {
      phase: s.phase,
      scanId: s.scanId,
      dirs: s.dirs,
      found: s.found,
      currentPath: shortenPath(s.currentPathAbs),
      elapsedMs,
      startedAt: s.startedAt,
      counts: s.counts,
      note: s.note,
    };
  }
}

module.exports = { ScanController, shortenPath };
