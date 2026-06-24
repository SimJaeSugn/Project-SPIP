'use strict';
/**
 * electron/preload-favorites.js — 즐겨찾기 위젯 전용 축소 allowlist (M7 §5·§6.2 · SEC-M3)
 *
 * 위젯 창(app://favorites.html)의 renderer에 window.spip로 즐겨찾기 표시·액션에 필요한
 * 7개 함수만 노출한다(메인 preload.js의 부분집합). openDashboard는 메인창 show/focus만 하는
 * 약한 네비게이션 채널(강력 채널 아님 — SEC-M3 표면 축소 원칙 유지).
 *
 * SEC-M3 MUST:
 *   ① ipcRenderer 원본 비노출.
 *   ② generic invoke(임의 채널 호출) 비노출.
 *   ③ 채널명 하드코딩(메인 preload.js와 동일 패턴).
 *
 * 강력 채널(setToolPath·pickToolExecutable·setOrder·setSortMode·rescan·addRoots·removeRoot·
 *   pickFolders·getStats·getHealth·getConfig·getScanStatus·getTools·onScanProgress·onTray)은
 *   단 하나도 노출하지 않는다(표면 축소·체크리스트 §11.1). [R-28] onMenu 채널은 폐기됨.
 *
 * focus 게이팅(SEC-H2): 부수효과 액션(open·copyText·setFavorite) 실행을 위젯 focus 시에만 활성화
 *   하는 책임은 위젯 renderer(public/favorites.js)에 있다(여기서는 채널만 고정).
 *
 * contextIsolation:true·sandbox:true 환경에서 동작 — 순수 contextBridge + ipcRenderer만 사용.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('spip', {
  // 읽기(invoke) — 즐겨찾기 표시 데이터 적재.
  getUiState: () => ipcRenderer.invoke('spip:getUiState'),
  getProjects: () => ipcRenderer.invoke('spip:getProjects'),

  // 액션 — preload에서 인자 형태를 1차 고정(main이 재검증·SEC-M4).
  //   open(id, toolId?) → 'spip:openInVsCode'. toolId 미지정 시 main이 'code' 하위호환.
  open: (id, toolId) => ipcRenderer.invoke('spip:openInVsCode', {
    id: String(id),
    toolId: toolId ? String(toolId) : undefined,
  }),
  copyText: (t) => ipcRenderer.invoke('spip:copyText', { text: String(t) }),
  setFavorite: (id, on) => ipcRenderer.invoke('spip:setFavorite', { id: String(id), on: !!on }),

  // [M8-DESIGN] 헤더 '대시보드 열기' — 메인 대시보드 창 show/focus. 인자 없음(강력 채널 아님).
  openDashboard: () => ipcRenderer.invoke('spip:openDashboard'),

  // 동기화 구독(on/send) — main→renderer 단방향 push 'spip:favorites-changed' { favorites:string[] }.
  //   채널명 하드코딩, ipcRenderer 원본 비노출. unsubscribe 함수 반환.
  onFavoritesChanged: (cb) => {
    if (typeof cb !== 'function') return () => {};
    const h = (_evt, payload) => cb(payload);
    ipcRenderer.on('spip:favorites-changed', h);
    return () => ipcRenderer.removeListener('spip:favorites-changed', h);
  },
});
