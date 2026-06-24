'use strict';
/**
 * electron/tray.js — 트레이 아이콘 + 컨텍스트 메뉴 (R-21, ADR-M6-4)
 *
 * Tray + 컨텍스트 메뉴(대시보드 열기 / 즐겨찾기 / 종료)를 생성한다. 생명주기(close-to-tray·
 * isQuitting·doFinalQuit)는 main.js가 소유하고, 본 모듈은 콜백을 받아 OS 위젯만 구성한다.
 *
 * [헤드리스 검증] 메뉴 템플릿 구성·콜백 디스패치를 buildTrayMenuTemplate 순수 함수로 분리해
 *   Electron 미설치에서도 구조·action 화이트리스트를 단위테스트한다. createTray는 Electron
 *   Tray/Menu/nativeImage를 deps로 주입 가능(기본 require('electron')).
 *
 * 외부 의존성 0 — Electron은 지연 require(헤드리스 테스트 시 deps 주입).
 */

const path = require('path');

// 트레이 메뉴 action 화이트리스트(M6-M-3). renderer push action도 이 집합만.
const TRAY_ACTIONS = Object.freeze(['dashboard', 'favorites']);

/**
 * 트레이 컨텍스트 메뉴 템플릿(plain object 배열)을 만든다.
 * @param {object} cbs { onShowDashboard, onShowFavorites, onQuit }
 * @returns {Array<object>}
 */
function buildTrayMenuTemplate(cbs) {
  cbs = cbs || {};
  const call = (fn) => () => { if (typeof fn === 'function') fn(); };
  const items = [
    { label: '대시보드 열기', click: call(cbs.onShowDashboard) },
    { label: '즐겨찾기', click: call(cbs.onShowFavorites) },
  ];
  // '메일 지금 확인'은 메일 감시가 활성(콜백 주입)일 때만 노출한다.
  if (typeof cbs.onCheckMail === 'function') {
    items.push({ label: '메일 지금 확인', click: call(cbs.onCheckMail) });
  }
  items.push({ type: 'separator' });
  items.push({ label: '종료', click: call(cbs.onQuit) });
  return items;
}

/** 트레이 아이콘 이미지를 해석한다(에셋 부재 시 빈 이미지 폴백 — 트레이 생성은 계속). */
function resolveTrayImage(electron, iconPath) {
  try {
    const ni = electron.nativeImage;
    if (!ni) return undefined;
    if (iconPath) {
      const img = ni.createFromPath(iconPath);
      if (img && !img.isEmpty()) return img;
    }
    return ni.createEmpty();
  } catch (_) {
    return undefined;
  }
}

/**
 * Tray를 생성하고 컨텍스트 메뉴·더블클릭(대시보드 복원)을 wiring한다.
 * @param {object} opts { onShowDashboard, onShowFavorites, onQuit, iconPath?, deps?{Tray,Menu,nativeImage}, tooltip? }
 * @returns {{ tray:object, destroy:Function }}
 */
function createTray(opts) {
  opts = opts || {};
  const electron = opts.deps || require('electron');
  const Tray = electron.Tray;
  const Menu = electron.Menu;
  if (!Tray || !Menu) throw new Error('createTray: Electron Tray/Menu unavailable');

  // 트레이 전용 아이콘. main.js가 패키지/개발 경로를 iconPath로 주입하며, 미주입 시 개발 폴백.
  const iconPath = opts.iconPath || path.join(__dirname, '..', 'build', 'icon-tray.ico');
  const image = resolveTrayImage(electron, iconPath);
  const tray = image !== undefined ? new Tray(image) : new Tray(iconPath);

  tray.setToolTip(opts.tooltip || 'Project-SPIP');
  const menu = Menu.buildFromTemplate(buildTrayMenuTemplate(opts));
  tray.setContextMenu(menu);

  // 더블클릭/클릭 → 대시보드 복원(편의).
  const showDash = () => { if (typeof opts.onShowDashboard === 'function') opts.onShowDashboard(); };
  try { tray.on('double-click', showDash); } catch (_) { /* noop */ }

  const destroy = () => { try { tray.destroy(); } catch (_) { /* noop */ } };
  return { tray, destroy };
}

module.exports = { createTray, buildTrayMenuTemplate, resolveTrayImage, TRAY_ACTIONS };
