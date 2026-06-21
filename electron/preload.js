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
  // 계약(electron-migration §4.1/§4.3 · M6 §4.1): 채널 'spip:openInVsCode'를 renderer 표면 open(id, toolId?)으로 노출.
  //   toolId 미지정 시 'code' 하위호환(main). args 없음(M6-H-2).
  open: (id, toolId) => ipcRenderer.invoke('spip:openInVsCode', {
    id: String(id),
    toolId: toolId ? String(toolId) : undefined,
  }),
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

  // [M6 R-17] 경로 복사 — main clipboard.writeText만. 채널명 하드코딩.
  copyText: (t) => ipcRenderer.invoke('spip:copyText', { text: String(t) }),

  // [M6 R-18] 외부 툴 경로 설정. setToolPath는 args 없음(M6-H-2). path=null은 지정 해제.
  getTools: () => ipcRenderer.invoke('spip:getTools'),
  setToolPath: (id, p) => ipcRenderer.invoke('spip:setToolPath', { id: String(id), path: p == null ? null : String(p) }),
  pickToolExecutable: (id) => ipcRenderer.invoke('spip:pickToolExecutable', { id: String(id) }),

  // [M6 R-19/R-20] UI 상태(즐겨찾기·순서·정렬모드).
  getUiState: () => ipcRenderer.invoke('spip:getUiState'),
  setFavorite: (id, on) => ipcRenderer.invoke('spip:setFavorite', { id: String(id), on: !!on }),
  setOrder: (ids) => ipcRenderer.invoke('spip:setOrder', { ids: Array.isArray(ids) ? ids.map(String) : [] }),
  setSortMode: (m) => ipcRenderer.invoke('spip:setSortMode', { mode: String(m) }),

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

  // [M6 R-21] 트레이 명령 구독 — main이 보내는 'spip:tray:<action>'를 renderer 콜백으로 중계.
  //   action ∈ dashboard|favorites (화이트리스트, M6-M-3). 채널명 하드코딩(MUST).
  //   콜백 shape: cb({ action }). unsubscribe 함수 반환. (onMenu와 동일 패턴)
  onTray: (cb) => {
    if (typeof cb !== 'function') return () => {};
    const actions = ['dashboard', 'favorites'];
    const handlers = actions.map((action) => {
      const channel = 'spip:tray:' + action;
      const h = () => cb({ action });
      ipcRenderer.on(channel, h);
      return () => ipcRenderer.removeListener(channel, h);
    });
    return () => { for (const off of handlers) off(); }; // unsubscribe 함수 반환
  },
});
