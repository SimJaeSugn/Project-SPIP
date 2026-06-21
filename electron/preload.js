'use strict';
/**
 * electron/preload.js — contextBridge 최소 allowlist (electron-migration §4·§6.2)
 *
 * window.spip에 §4 채널 함수만 노출한다. ipcRenderer 원본·범용 invoke(channel,…)는
 * 노출하지 않으며 채널명을 하드코딩한다(MUST). browseDir 채널 없음(드롭).
 *
 * contextIsolation:true·sandbox:true 환경에서 동작 — 순수 contextBridge + ipcRenderer만 사용.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('spip', {
  // 읽기(invoke/handle)
  getProjects: () => ipcRenderer.invoke('spip:getProjects'),
  getStats: () => ipcRenderer.invoke('spip:getStats'),
  getHealth: () => ipcRenderer.invoke('spip:getHealth'),
  getConfig: () => ipcRenderer.invoke('spip:getConfig'),
  getScanStatus: () => ipcRenderer.invoke('spip:getScanStatus'),

  // 액션 — preload에서 인자 형태를 1차 고정(main이 재검증).
  // 계약(electron-migration §4.1/§4.3): 채널 'spip:openInVsCode'를 renderer 표면 open(id)으로 노출.
  open: (id) => ipcRenderer.invoke('spip:openInVsCode', { id: String(id) }),
  rescan: (o) => ipcRenderer.invoke('spip:rescan', {
    withSize: !!(o && o.withSize),
    allDrives: !!(o && o.allDrives),
  }),

  // 폴더 관리
  pickFolders: () => ipcRenderer.invoke('spip:pickFolders'),
  addRoots: (paths) => ipcRenderer.invoke('spip:addRoots', {
    paths: Array.isArray(paths) ? paths.map((p) => String(p)) : paths,
  }),
  removeRoot: (path) => ipcRenderer.invoke('spip:removeRoot', { path: String(path) }),

  // 이벤트 구독(on/send) — 콜백만 받고 ipcRenderer 원본은 노출하지 않음(보안).
  onScanProgress: (cb) => {
    if (typeof cb !== 'function') return () => {};
    const h = (_evt, payload) => cb(payload);
    ipcRenderer.on('spip:scanProgress', h);
    return () => ipcRenderer.removeListener('spip:scanProgress', h); // 해제 함수 반환
  },

  // 메뉴 명령 구독(P2-1) — main이 보내는 'spip:menu:<action>'를 renderer 콜백으로 중계.
  //   action ∈ pickFolders|rescan|refresh|about (화이트리스트). 채널명 하드코딩(MUST).
  //   콜백 shape: cb({ action }). unsubscribe 함수 반환.
  onMenu: (cb) => {
    if (typeof cb !== 'function') return () => {};
    const actions = ['pickFolders', 'rescan', 'refresh', 'about'];
    const handlers = actions.map((action) => {
      const channel = 'spip:menu:' + action;
      const h = () => cb({ action });
      ipcRenderer.on(channel, h);
      return () => ipcRenderer.removeListener(channel, h);
    });
    return () => { for (const off of handlers) off(); }; // unsubscribe 함수 반환
  },
});
