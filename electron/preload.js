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

// 메일 계정 입력(label/host/port/user/pass) 형태 고정 헬퍼. 빈 필드는 생략해 main 검증에 위임.
//   pass는 빈 문자열도 의미가 있어(수정 시 기존 유지) 항상 문자열로 전달.
function _mailArgs(a) {
  a = (a && typeof a === 'object') ? a : {};
  const out = {};
  if (a.label != null) out.label = String(a.label);
  if (a.host != null) out.host = String(a.host);
  if (a.port != null && a.port !== '') out.port = Number(a.port);
  if (a.user != null) out.user = String(a.user);
  out.pass = a.pass == null ? '' : String(a.pass);
  return out;
}

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

  // 제외 항목(#4: 폴더명 또는 절대경로). 인자 형태를 preload에서 1차 고정(main이 재검증).
  getExcludes: () => ipcRenderer.invoke('spip:getExcludes'),
  addExcludes: (patterns) => ipcRenderer.invoke('spip:addExcludes', {
    patterns: Array.isArray(patterns) ? patterns.map((p) => String(p)) : patterns,
  }),
  removeExclude: (pattern) => ipcRenderer.invoke('spip:removeExclude', { pattern: String(pattern) }),

  // 프로젝트 인식 기준(detectSignals: 이름/글로브/정규식) — 조회·추가·삭제·기본값 복원.
  getDetectSignals: () => ipcRenderer.invoke('spip:getDetectSignals'),
  addDetectSignals: (patterns) => ipcRenderer.invoke('spip:addDetectSignals', {
    patterns: Array.isArray(patterns) ? patterns.map((p) => String(p)) : patterns,
  }),
  removeDetectSignal: (pattern) => ipcRenderer.invoke('spip:removeDetectSignal', { pattern: String(pattern) }),
  restoreDetectSignals: () => ipcRenderer.invoke('spip:restoreDetectSignals'),

  // [M6 R-17] 경로 복사 — main clipboard.writeText만. 채널명 하드코딩.
  copyText: (t) => ipcRenderer.invoke('spip:copyText', { text: String(t) }),

  // 경로 열기 — id로 프로젝트 폴더를 OS 탐색기에서 연다(main이 화이트리스트 검증 후 shell.openPath).
  openPath: (id) => ipcRenderer.invoke('spip:openPath', { id: String(id) }),

  // [M6 R-18] 외부 툴 경로 설정. setToolPath는 args 없음(M6-H-2). path=null은 지정 해제.
  getTools: () => ipcRenderer.invoke('spip:getTools'),
  setToolPath: (id, p) => ipcRenderer.invoke('spip:setToolPath', { id: String(id), path: p == null ? null : String(p) }),
  pickToolExecutable: (id) => ipcRenderer.invoke('spip:pickToolExecutable', { id: String(id) }),

  // 메일 계정(복수 IMAP) 관리 — 인자 형태를 preload에서 1차 고정(main이 재검증).
  //   응답엔 비밀번호가 없다(공개 뷰). 수정 시 pass를 비우면 기존 비밀번호 유지.
  getMailAccounts: () => ipcRenderer.invoke('spip:getMailAccounts'),
  addMailAccount: (a) => ipcRenderer.invoke('spip:addMailAccount', _mailArgs(a)),
  updateMailAccount: (id, a) => ipcRenderer.invoke('spip:updateMailAccount', Object.assign({ id: String(id) }, _mailArgs(a))),
  removeMailAccount: (id) => ipcRenderer.invoke('spip:removeMailAccount', { id: String(id) }),
  testMailAccount: (a) => ipcRenderer.invoke('spip:testMailAccount', Object.assign(
    (a && a.id != null) ? { id: String(a.id) } : {}, _mailArgs(a))),
  // 홈 브리핑용 — 계정별 안 읽은 메일 수 + 제목·발신자 미리보기(인자 없음).
  getMailSummary: () => ipcRenderer.invoke('spip:getMailSummary'),
  // 홈 인사이트 — 최근 14일 커밋 빈도 시계열(인자 없음).
  getCommitActivity: () => ipcRenderer.invoke('spip:getCommitActivity'),

  // 자동 업데이트(사용자 주도) — 확인/다운로드/설치 트리거 + 상태 스냅샷. 인자 없음(main이 검증).
  //   진행 상황은 onUpdateStatus(cb) 구독으로 받는다. 채널명 하드코딩(MUST).
  getUpdateState: () => ipcRenderer.invoke('spip:getUpdateState'),
  checkForUpdate: () => ipcRenderer.invoke('spip:checkForUpdate'),
  downloadUpdate: () => ipcRenderer.invoke('spip:downloadUpdate'),
  installUpdate: () => ipcRenderer.invoke('spip:installUpdate'),

  // [M6 R-19/R-20] UI 상태(즐겨찾기·순서·정렬모드).
  getUiState: () => ipcRenderer.invoke('spip:getUiState'),
  setFavorite: (id, on) => ipcRenderer.invoke('spip:setFavorite', { id: String(id), on: !!on }),
  setOrder: (ids) => ipcRenderer.invoke('spip:setOrder', { ids: Array.isArray(ids) ? ids.map(String) : [] }),
  setSortMode: (m) => ipcRenderer.invoke('spip:setSortMode', { mode: String(m) }),

  // 프로젝트 표시 별칭(빈 문자열이면 해제) + 테마(light|dark|system).
  setProjectName: (id, name) => ipcRenderer.invoke('spip:setProjectName', { id: String(id), name: name == null ? '' : String(name) }),
  setTheme: (theme) => ipcRenderer.invoke('spip:setTheme', { theme: String(theme) }),

  // 할 일(홈 브리핑) — 추가/완료토글/삭제. 읽기는 getUiState 응답의 todos.
  addTodo: (text) => ipcRenderer.invoke('spip:addTodo', { text: String(text) }),
  toggleTodo: (id, done) => ipcRenderer.invoke('spip:toggleTodo', { id: String(id), done: !!done }),
  removeTodo: (id) => ipcRenderer.invoke('spip:removeTodo', { id: String(id) }),
  // 언어 추세 baseline 갱신(스캔 간 ▲▼ 비교용). counts={lang:n}.
  updateLangTrend: (generatedAt, counts) => ipcRenderer.invoke('spip:updateLangTrend', {
    generatedAt: generatedAt == null ? '' : String(generatedAt),
    counts: (counts && typeof counts === 'object') ? counts : {},
  }),

  // 이벤트 구독(on/send) — 콜백만 받고 ipcRenderer 원본은 노출하지 않음(보안).
  onScanProgress: (cb) => {
    if (typeof cb !== 'function') return () => {};
    const h = (_evt, payload) => cb(payload);
    ipcRenderer.on('spip:scanProgress', h);
    return () => ipcRenderer.removeListener('spip:scanProgress', h); // 해제 함수 반환
  },

  // [R-24 상태 주시] 라이브 갱신 구독 — main이 보내는 'spip:projectsUpdated'를 renderer 콜백으로 중계.
  //   payload: { projects:[<§8.1 project(갱신분)>] }. 채널명 하드코딩(MUST). unsubscribe 함수 반환.
  onProjectsUpdated: (cb) => {
    if (typeof cb !== 'function') return () => {};
    const h = (_evt, payload) => cb(payload);
    ipcRenderer.on('spip:projectsUpdated', h);
    return () => ipcRenderer.removeListener('spip:projectsUpdated', h); // 해제 함수 반환
  },

  // 자동 업데이트 진행 상황 구독 — main(autoUpdate.js)이 보내는 'spip:update:status'를 콜백으로 중계.
  //   payload: { status, version?, percent?, transferred?, total?, bytesPerSecond? }. 채널명 하드코딩.
  //   콜백만 받고 ipcRenderer 원본은 노출하지 않음(보안). unsubscribe 함수 반환.
  onUpdateStatus: (cb) => {
    if (typeof cb !== 'function') return () => {};
    const h = (_evt, payload) => cb(payload);
    ipcRenderer.on('spip:update:status', h);
    return () => ipcRenderer.removeListener('spip:update:status', h);
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

  // [M6 R-21 / M7 R4·§8.1] 트레이 명령 구독 — main이 보내는 'spip:tray:<action>'를 renderer 콜백으로 중계.
  //   ★M7: 트레이 '즐겨찾기'가 메인창 push가 아닌 favoritesWidget.show()로 바뀌어 'spip:tray:favorites'
  //   push가 사라진다 → action을 ['dashboard']로 축소(SEC-L1: 죽은 수신 채널 잔존 방지).
  //   채널명 하드코딩(MUST). 콜백 shape: cb({ action }). unsubscribe 함수 반환. (onMenu와 동일 패턴)
  onTray: (cb) => {
    if (typeof cb !== 'function') return () => {};
    const actions = ['dashboard'];
    const handlers = actions.map((action) => {
      const channel = 'spip:tray:' + action;
      const h = () => cb({ action });
      ipcRenderer.on(channel, h);
      return () => ipcRenderer.removeListener(channel, h);
    });
    return () => { for (const off of handlers) off(); }; // unsubscribe 함수 반환
  },
});
