'use strict';
/**
 * mock-spip-preload.js — 헤드리스 스모크 전용 window.spip 모의(preload).
 *
 * 실제 electron/preload-favorites.js 의 6채널과 동형(getUiState·getProjects·open·
 * copyText·setFavorite·onFavoritesChanged) 이지만, IPC 대신 메모리 고정 데이터를 반환한다.
 * favorites.js 의 refresh() 가 getUiState→getProjects 로 카드 데이터를 적재하므로,
 * 이 모의가 favorites 3개 + 매칭 projects 3개를 돌려주면 .fav-card 3장이 렌더되어야 한다.
 *
 * 주의: 이 preload 는 스모크에서만 사용(sandbox:false). 프로덕션 preload 는 변경하지 않는다.
 */
const { contextBridge } = require('electron');

const PROJECTS = [
  { id: 'a', name: 'Alpha', path: 'E:\\proj\\alpha', language: { primary: 'JavaScript' },
    git: { isRepo: true, branch: 'main', dirty: true, ahead: 1, behind: 0 } },
  { id: 'b', name: 'Beta', path: 'E:\\proj\\beta', language: { primary: 'Python' },
    git: { isRepo: true, branch: 'dev' } },
  { id: 'c', name: 'Gamma', path: 'E:\\proj\\gamma', language: { primary: 'Go' },
    git: { status: 'na' } },
];
const FAVORITES = ['a', 'b', 'c'];

contextBridge.exposeInMainWorld('spip', {
  getUiState: async () => ({ ok: true, favorites: FAVORITES.slice() }),
  getProjects: async () => ({ ok: true, projects: PROJECTS.map((p) => ({ ...p })) }),
  open: async () => ({ ok: true }),
  copyText: async () => ({ ok: true }),
  setFavorite: async (id, on) => ({
    ok: true,
    favorites: on ? FAVORITES.slice() : FAVORITES.filter((x) => x !== id),
  }),
  onFavoritesChanged: () => () => {},
});
