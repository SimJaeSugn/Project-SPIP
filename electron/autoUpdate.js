'use strict';
/**
 * electron/autoUpdate.js — GitHub Releases 기반 자동 업데이트 클라이언트(electron-updater 연동)
 *
 * 방식(사용자 주도): 설치본이 latest.yml(GitHub Releases)을 보고 새 버전을 감지하고, 사용자가
 *   설정 화면의 버튼으로 [확인 → 다운로드 → 재시작 설치]를 직접 트리거한다. 진행 상황은
 *   'spip:update:status' 단방향 push로 렌더러에 실시간 중계한다.
 *
 * 설계 결정:
 *   · autoDownload=false / autoInstallOnAppQuit=false — 모든 단계는 사용자가 버튼으로 명시 트리거.
 *   · app.isPackaged 가드 필수 — dev/미패키징에선 app-update.yml 부재로 throw 하므로 init·각 제어
 *     함수에서 가드하고, IPC는 { ok:false, code:'NOT_PACKAGED' }로 graceful 반환.
 *   · 설치(quitAndInstall): electron-updater 가 인스톨러를 detached 로 동기 spawn 한 뒤 app.quit()
 *     을 부른다(BaseUpdater.install→doInstall 동기 spawn 확인). 트레이 앱은 close-to-tray 라
 *     창 close 가 막히므로, beforeInstall() 콜백으로 isQuitting=true 를 세팅해 정상 종료 경로를
 *     열어준다(doFinalQuit→app.exit(0) 이후에도 detached 인스톨러는 생존).
 *
 * electron-updater 는 CommonJS — 이 프로젝트도 CommonJS(require)라 별도 import 함정 없음.
 */

const { app } = require('electron');
const electronUpdater = require('electron-updater');

// electron-updater 의 `autoUpdater` 는 getter — 접근하는 순간 NsisUpdater 를 인스턴스화하며
//   electron app.getVersion() 을 읽는다. 헤드리스(node --test)에서 모듈 로드 시 접근하면 크래시하므로,
//   반드시 런타임(app.isPackaged 가드 통과 후)에만 지연 접근한다.
function updater() { return electronUpdater.autoUpdater; }

// 렌더러로 중계하는 상태 토큰(고정 집합).
//   idle | checking | available | not-available | downloading | downloaded | error
let _initialized = false;
let _logger = null;
let _getWebContents = null;   // () => webContents (메인창, 지연평가)
let _beforeInstall = null;    // () => void  (설치 직전 main 생명주기 정리 훅)
let _lastStatus = { status: 'idle' };

function log(level, msg, extra) {
  if (_logger && typeof _logger[level] === 'function') _logger[level]('[update] ' + msg, extra);
}

/** 단방향 push: 메인창 webContents 로 'spip:update:status' 전송(파괴 레이스 가드). */
function broadcast(payload) {
  _lastStatus = payload;
  const wc = (typeof _getWebContents === 'function') ? _getWebContents() : null;
  if (wc && typeof wc.isDestroyed === 'function' && !wc.isDestroyed() && typeof wc.send === 'function') {
    try { wc.send('spip:update:status', payload); } catch (_) { /* 창 파괴 레이스 격리 */ }
  }
}

/**
 * 업데이트 클라이언트를 1회 초기화한다(멱등). 패키징 빌드에서만 리스너를 건다.
 * @param {object} deps { logger, getWebContents, beforeInstall }
 */
function initAutoUpdate(deps) {
  if (_initialized) return;
  _initialized = true;
  deps = deps || {};
  _logger = deps.logger || null;
  _getWebContents = (typeof deps.getWebContents === 'function') ? deps.getWebContents : null;
  _beforeInstall = (typeof deps.beforeInstall === 'function') ? deps.beforeInstall : null;

  // dev/미패키징: app-update.yml 부재로 autoUpdater 조작 시 throw → 리스너조차 걸지 않는다.
  //   IPC 제어 함수가 NOT_PACKAGED 로 graceful 반환하므로 설정 UI 는 "개발 모드" 안내만 표시.
  if (!app.isPackaged) {
    log('info', '미패키징 — 자동 업데이트 비활성(설치본에서만 동작)');
    return;
  }

  const au = updater();
  au.autoDownload = false;          // 사용자 주도(버튼)로만 다운로드
  au.autoInstallOnAppQuit = false;  // 종료 시 자동 설치 안 함(install 도 명시 트리거)
  // electron-updater 의 내부 로그를 프로젝트 Logger 로 연결(선택). 과도한 verbose 는 info 로만.
  if (_logger) {
    au.logger = {
      info: (m) => log('info', String(m)),
      warn: (m) => log('warn', String(m)),
      error: (m) => log('error', String(m)),
      debug: () => {},
    };
  }

  au.on('checking-for-update', () => broadcast({ status: 'checking' }));
  au.on('update-available', (info) => broadcast({
    status: 'available', version: info && info.version ? String(info.version) : '',
  }));
  au.on('update-not-available', (info) => broadcast({
    status: 'not-available', version: info && info.version ? String(info.version) : '',
  }));
  au.on('download-progress', (p) => broadcast({
    status: 'downloading',
    percent: p && typeof p.percent === 'number' ? p.percent : 0,
    transferred: p && typeof p.transferred === 'number' ? p.transferred : 0,
    total: p && typeof p.total === 'number' ? p.total : 0,
    bytesPerSecond: p && typeof p.bytesPerSecond === 'number' ? p.bytesPerSecond : 0,
  }));
  au.on('update-downloaded', (info) => broadcast({
    status: 'downloaded', version: info && info.version ? String(info.version) : '',
  }));
  au.on('error', (err) => {
    log('error', '오류', err && err.message ? err.message : err);
    // L-3 정합: 사용자에겐 고정 토큰만(절대경로·스택 비노출).
    broadcast({ status: 'error' });
  });

  log('info', '자동 업데이트 클라이언트 초기화(사용자 주도)');
}

/** dev/미패키징·미초기화면 NOT_PACKAGED. (모든 제어 함수 공통 가드) */
function guardPackaged() {
  return _initialized && app.isPackaged;
}

/** 업데이트 확인. 결과는 이벤트(available/not-available/error)로 push. */
async function checkForUpdates() {
  if (!guardPackaged()) return { ok: false, code: 'NOT_PACKAGED' };
  try {
    await updater().checkForUpdates();
    return { ok: true };
  } catch (err) {
    log('error', 'checkForUpdates 실패', err && err.message);
    broadcast({ status: 'error' });
    return { ok: false, code: 'CHECK_FAILED' };
  }
}

/** 업데이트 다운로드. 진행/완료는 download-progress/update-downloaded 이벤트로 push. */
async function downloadUpdate() {
  if (!guardPackaged()) return { ok: false, code: 'NOT_PACKAGED' };
  try {
    await updater().downloadUpdate();
    return { ok: true };
  } catch (err) {
    log('error', 'downloadUpdate 실패', err && err.message);
    broadcast({ status: 'error' });
    return { ok: false, code: 'DOWNLOAD_FAILED' };
  }
}

/**
 * 다운로드된 업데이트를 설치하고 재시작한다. 트레이 앱의 close-to-tray 를 통과시키기 위해
 *   beforeInstall() 로 isQuitting 을 먼저 세운 뒤 quitAndInstall 을 호출한다.
 *   quitAndInstall 은 인스톨러를 detached 동기 spawn 한 뒤 app.quit() 을 부르므로,
 *   이후 doFinalQuit→app.exit(0) 가 와도 인스톨러는 생존해 설치가 진행된다.
 */
function quitAndInstall() {
  if (!guardPackaged()) return { ok: false, code: 'NOT_PACKAGED' };
  try {
    if (_beforeInstall) {
      try { _beforeInstall(); } catch (e) { log('error', 'beforeInstall 훅 실패', e && e.message); }
    }
    // isSilent=false(설치 UI 표시), isForceRunAfter=true(설치 후 앱 재실행).
    updater().quitAndInstall(false, true);
    return { ok: true };
  } catch (err) {
    log('error', 'quitAndInstall 실패', err && err.message);
    broadcast({ status: 'error' });
    return { ok: false, code: 'INSTALL_FAILED' };
  }
}

/** 현재 상태 스냅샷 + 메타(설정 UI 초기 표시용). */
function getUpdateState() {
  return {
    ok: true,
    packaged: app.isPackaged,
    currentVersion: app.getVersion(),
    status: _lastStatus,
  };
}

module.exports = {
  initAutoUpdate,
  checkForUpdates,
  downloadUpdate,
  quitAndInstall,
  getUpdateState,
};
