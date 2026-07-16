'use strict';
/**
 * electron/preload.js — contextBridge 최소 allowlist (electron-migration §4·§6.2)
 *
 * window.spip에 §4 채널 함수만 노출한다. ipcRenderer 원본·범용 invoke(channel,…)는
 * 노출하지 않으며 채널명을 하드코딩한다(MUST). 범용 browseDir 채널 없음(드롭) —
 * 탐색기 위젯(spip.explorer.*)은 dialog로 등록한 루트 하위로만 열람이 제한되고,
 * 루트 자체를 문자열로 등록하는 채널은 존재하지 않는다(EXP-H-1).
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

// [M13] 브리핑 설정 인자 1차 고정. apiKey: 미전송=기존 유지(키 누락), null=해제, 문자열=설정(메일 pass 패턴).
//   baseURL/model은 문자열로만 전달(빈 값 생략). main 핸들러가 M-1·shape 재검증.
function _briefingArgs(s) {
  s = (s && typeof s === 'object') ? s : {};
  const out = {};
  if (s.enabled != null) out.enabled = !!s.enabled;
  if (s.baseURL != null) out.baseURL = String(s.baseURL);
  if (s.model != null) out.model = String(s.model);
  if (s.label != null) out.label = String(s.label); // [AI 연결 복수화] 활성 연결 라벨(선택)
  if ('apiKey' in s) out.apiKey = s.apiKey === null ? null : String(s.apiKey); // null=해제
  // 시스템 프롬프트(사용자 편집·신뢰 영역). 빈 문자열/null=시드 복원. main 핸들러가 정제·길이상한 재검증.
  if ('systemPrompt' in s) out.systemPrompt = s.systemPrompt === null ? '' : String(s.systemPrompt);
  if (s.advanced && typeof s.advanced === 'object') {
    const adv = {};
    if (s.advanced.coalesceMs != null && s.advanced.coalesceMs !== '') adv.coalesceMs = Number(s.advanced.coalesceMs);
    if (s.advanced.deadlineH != null && s.advanced.deadlineH !== '') adv.deadlineH = Number(s.advanced.deadlineH);
    out.advanced = adv;
  }
  return out;
}

// [M13] 단방향 push 구독 헬퍼 — 콜백만 받고 ipcRenderer 원본 비노출. unsubscribe 반환(기존 패턴).
function _sub(channel, cb) {
  if (typeof cb !== 'function') return () => {};
  const h = (_evt, payload) => cb(payload);
  ipcRenderer.on(channel, h);
  return () => ipcRenderer.removeListener(channel, h);
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

  // 외부 링크 열기 — 원격지(GitHub 등) URL을 기본 브라우저로(main이 http/https 재검증 후 shell.openExternal).
  openExternal: (url) => ipcRenderer.invoke('spip:openExternal', { url: String(url) }),

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
  // 단건 메일 본문 조회(팝업) — 계정 id + uid + 소속 메일함. 읽음표시 영향 없음(main이 EXAMINE+PEEK).
  getMailMessage: (accountId, uid, mailbox) => ipcRenderer.invoke('spip:getMailMessage', { accountId: String(accountId), uid: Number(uid), mailbox: (mailbox == null ? '' : String(mailbox)) }),
  // 메일 보관함 — 계정별·메일함별 수집 메일(메타) 영속 보관. 로컬 삭제(서버 미접촉).
  getMailArchive: () => ipcRenderer.invoke('spip:getMailArchive'),
  syncMailArchive: () => ipcRenderer.invoke('spip:syncMailArchive'),
  deleteMailArchiveItem: (accountId, mailbox, uid) => ipcRenderer.invoke('spip:deleteMailArchiveItem', {
    accountId: String(accountId),
    mailbox: (mailbox == null ? '' : String(mailbox)),
    uid: (uid == null || uid === '' ? '' : Number(uid)),
  }),
  // 홈 인사이트 — 커밋 빈도 시계열. days 미지정=14일(생산성 위젯), 지정 시 [1,366] 범위(예 365=커밋 히트맵).
  getCommitActivity: (days) => ipcRenderer.invoke('spip:getCommitActivity', (days == null ? {} : { days: Number(days) })),
  // [항목2] 홈 인사이트 — Claude Code 로컬 로그 토큰 사용량 집계(인자 없음·읽기 전용).
  getClaudeUsage: () => ipcRenderer.invoke('spip:getClaudeUsage'),
  // [로드맵 Phase 3·G] 개발 머신 시스템 상태(CPU/RAM/디스크) — 인자 없음·읽기 전용(os + fs.statfs).
  getSystemStatus: () => ipcRenderer.invoke('spip:getSystemStatus'),

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
  // [위젯 인스턴스] 홈 배치 — 배치 단위는 인스턴스({iid,type,name})라 같은 위젯을 여러 개 놓을 수 있다.
  //   읽기는 getUiState 응답의 homeWidgets. 검증은 main normalizeHomeWidgets 단일 경계.
  //   setHomeLayout 은 **순서만** 바꾼다(iid 순열) — 추가/제거/이름은 아래 전용 채널.
  setHomeLayout: (ids) => ipcRenderer.invoke('spip:setHomeLayout', { ids: Array.isArray(ids) ? ids.map(String) : [] }),
  // 새 인스턴스 추가 — iid 는 main 이 발급한다(렌더러가 id 를 주입할 수 없다).
  addWidget: (type, name) => ipcRenderer.invoke('spip:addWidget', {
    type: String(type), name: name == null ? '' : String(name),
  }),
  removeWidget: (iid) => ipcRenderer.invoke('spip:removeWidget', { iid: String(iid) }),
  // 배치별 표시명 — 빈 문자열이면 타입 기본명으로 복귀.
  renameWidget: (iid, name) => ipcRenderer.invoke('spip:renameWidget', { iid: String(iid), name: name == null ? '' : String(name) }),
  // [홈 위젯 크기] 인스턴스별 폭(열 스팬)·높이(px) 맵 { iid:{w,h} }. 읽기는 getUiState 응답의 homeWidgetSizes.
  setHomeWidgetSizes: (sizes) => ipcRenderer.invoke('spip:setHomeWidgetSizes', { sizes: (sizes && typeof sizes === 'object') ? sizes : {} }),
  // [로드맵 Phase 2] 대시보드 프리셋(모드) — 전환/추가/복제/이름변경/삭제. 읽기는 getUiState 응답의 dashboard. 검증은 main 프리셋 CRUD.
  setActivePreset: (id) => ipcRenderer.invoke('spip:setActivePreset', { id: String(id) }),
  addPreset: (name) => ipcRenderer.invoke('spip:addPreset', { name: name == null ? '' : String(name) }),
  duplicatePreset: (id) => ipcRenderer.invoke('spip:duplicatePreset', { id: String(id) }),
  renamePreset: (id, name) => ipcRenderer.invoke('spip:renamePreset', { id: String(id), name: name == null ? '' : String(name) }),
  removePreset: (id) => ipcRenderer.invoke('spip:removePreset', { id: String(id) }),
  // [로드맵 Phase 1·L] 템플릿 갤러리 — 템플릿 구성으로 새 프리셋 추가. 검증은 main 프리셋 정규화.
  addTemplatePreset: (name, template) => ipcRenderer.invoke('spip:addTemplatePreset', { name: name == null ? '' : String(name), template: (template && typeof template === 'object') ? template : {} }),
  // [로드맵 Phase 5·B] 프리폼 — 활성 프리셋 레이아웃 모드(masonry|freeform) + 위젯 좌표 { id:{x,y} }. 검증은 main.
  setLayoutMode: (mode) => ipcRenderer.invoke('spip:setLayoutMode', { mode: String(mode) }),
  setWidgetPositions: (positions) => ipcRenderer.invoke('spip:setWidgetPositions', { positions: (positions && typeof positions === 'object') ? positions : {} }),
  // [로드맵 Phase 5·M] 그룹/섹션 배열 [{id,name,collapsed,members[]}]. 검증은 main normalizeGroups.
  setGroups: (groups) => ipcRenderer.invoke('spip:setGroups', { groups: Array.isArray(groups) ? groups : [] }),
  // [로드맵 Phase 1·K] 대시보드 내보내기(JSON 문자열)/가져오기(백업·공유·기기 이전). 가져오기 검증은 main.
  exportDashboard: () => ipcRenderer.invoke('spip:exportDashboard'),
  importDashboard: (json) => ipcRenderer.invoke('spip:importDashboard', { json: String(json) }),

  // 프로젝트 표시 별칭(빈 문자열이면 해제) + 테마(light|dark|system).
  setProjectName: (id, name) => ipcRenderer.invoke('spip:setProjectName', { id: String(id), name: name == null ? '' : String(name) }),
  setTheme: (theme) => ipcRenderer.invoke('spip:setTheme', { theme: String(theme) }),
  // [로드맵 Phase 1·J] 테마 개인화 — 액센트 색·UI 배율. 검증은 main.
  setThemePrefs: (prefs) => ipcRenderer.invoke('spip:setThemePrefs', {
    accent: (prefs && prefs.accent != null) ? String(prefs.accent) : undefined,
    uiScale: (prefs && prefs.uiScale != null) ? String(prefs.uiScale) : undefined,
  }),
  // [로드맵 Phase 3·G / 위젯 인스턴스] 스크래치패드 메모 — 메모는 위젯 인스턴스별이라 iid 를 함께 보낸다.
  //   읽기는 getUiState 응답의 scratchpads({iid:{text,updatedAt}}). 검증은 메인 normalizeScratchpads.
  setScratchpad: (iid, text) => ipcRenderer.invoke('spip:setScratchpad', {
    iid: String(iid), text: text == null ? '' : String(text),
  }),

  // 할 일(홈 브리핑) — 추가/완료토글/삭제/마감설정. 읽기는 getUiState 응답의 todos.
  //   [백로그2-4] dueAt(ms epoch, 선택)·setTodoDue 추가. 빈/무효 dueAt 은 생략(메인이 null 처리).
  addTodo: (text, dueAt) => ipcRenderer.invoke('spip:addTodo', Object.assign(
    { text: String(text) },
    (dueAt != null && dueAt !== '' && Number.isFinite(Number(dueAt))) ? { dueAt: Number(dueAt) } : {})),
  toggleTodo: (id, done) => ipcRenderer.invoke('spip:toggleTodo', { id: String(id), done: !!done }),
  removeTodo: (id) => ipcRenderer.invoke('spip:removeTodo', { id: String(id) }),
  setTodoDue: (id, dueAt) => ipcRenderer.invoke('spip:setTodoDue', {
    id: String(id),
    dueAt: (dueAt != null && dueAt !== '' && Number.isFinite(Number(dueAt))) ? Number(dueAt) : null,
  }),
  // [백로그2-4] OS 토스트 알림 — 할 일 마감 도래 시 렌더러가 호출(메인이 Electron Notification 표시).
  notify: (title, body) => ipcRenderer.invoke('spip:notify', { title: String(title || ''), body: String(body || '') }),
  // 언어 추세 baseline 갱신(스캔 간 ▲▼ 비교용). counts={lang:n}.
  updateLangTrend: (generatedAt, counts) => ipcRenderer.invoke('spip:updateLangTrend', {
    generatedAt: generatedAt == null ? '' : String(generatedAt),
    counts: (counts && typeof counts === 'object') ? counts : {},
  }),

  // [M13 R-34~R-41] 브리핑 AI — invoke(읽기·액션·설정·연결테스트) + 단방향 구독(onBriefing*).
  //   키는 평문 회송 0(getSettings=hasApiKey). 인자 형태 1차 고정(main 핸들러가 재검증). 채널명 하드코딩.
  briefing: {
    getState: () => ipcRenderer.invoke('spip:briefing:getState'),
    trigger: () => ipcRenderer.invoke('spip:briefing:trigger', { reason: 'manual' }),
    abort: () => ipcRenderer.invoke('spip:briefing:abort'),
    resolveItem: (key, action) => ipcRenderer.invoke('spip:briefing:resolveItem', {
      key: String(key), action: String(action),
    }),
    getSettings: () => ipcRenderer.invoke('spip:briefing:getSettings'),
    setSettings: (s) => ipcRenderer.invoke('spip:briefing:setSettings', _briefingArgs(s)),
    testConnection: (s) => ipcRenderer.invoke('spip:briefing:testConnection', _briefingArgs(s)),

    // [AI 연결 복수화] 연결 목록 CRUD·활성 전환 — 응답에 apiKey 평문 없음(공개뷰).
    getConnections: () => ipcRenderer.invoke('spip:briefing:getConnections'),
    addConnection: (label) => ipcRenderer.invoke('spip:briefing:addConnection', { label: String(label || '') }),
    removeConnection: (id) => ipcRenderer.invoke('spip:briefing:removeConnection', { id: String(id || '') }),
    activateConnection: (id) => ipcRenderer.invoke('spip:briefing:activateConnection', { id: String(id || '') }),

    // 단방향 push 구독 — 콜백만 받고 ipcRenderer 원본 비노출. unsubscribe 반환.
    onState: (cb) => _sub('spip:briefing:state', cb),
    onDelta: (cb) => _sub('spip:briefing:delta', cb),
    onDone: (cb) => _sub('spip:briefing:done', cb),
    onError: (cb) => _sub('spip:briefing:error', cb),
  },

  // [SH-2] 즐겨찾기 셸프 위젯 — main이 전부 재검증(렌더러 비신뢰). 인자 1차 고정(String/Array).
  //   url=urlMeta 크롤(SSRF·og), folder/file=localMeta. main이 전부 재검증·게이트.
  //   채널명 하드코딩(MUST). onChanged는 단방향 push 구독(unsubscribe 반환).
  shelf: {
    list: () => ipcRenderer.invoke('spip:shelf:list'),
    add: (type, ref) => ipcRenderer.invoke('spip:shelf:add', { type: String(type), ref: String(ref) }),
    remove: (id) => ipcRenderer.invoke('spip:shelf:remove', { id: String(id) }),
    rename: (id, name) => ipcRenderer.invoke('spip:shelf:rename', { id: String(id), name: String(name) }),
    reorder: (ids) => ipcRenderer.invoke('spip:shelf:reorder', { ids: Array.isArray(ids) ? ids.map(String) : [] }),
    open: (id) => ipcRenderer.invoke('spip:shelf:open', { id: String(id) }),
    refresh: (id) => ipcRenderer.invoke('spip:shelf:refresh', { id: String(id) }),
    // [SH-4] 자동 재크롤(6시간) 토글 get/set — boolean. list 응답에도 autoRefresh 동봉.
    getSettings: () => ipcRenderer.invoke('spip:shelf:getSettings'),
    setSettings: (autoRefresh) => ipcRenderer.invoke('spip:shelf:setSettings', { autoRefresh: !!autoRefresh }),
    onChanged: (cb) => _sub('spip:shelf:changed', cb),
  },

  // [탐색기 위젯 EXP-H-1] 폴더 탐색기 — 중첩 네임스페이스(shelf/briefing 패턴). 채널명 하드코딩(MUST).
  //   루트 등록은 pickRoot(네이티브 dialog)뿐 — 렌더러가 임의 경로를 루트로 주입할 수 없다.
  //   list/open/… 의 path 는 main 이 매 호출 게이트(canonicalize + 민감경로 deny + 등록 루트 포함)한다.
  //   trash = 휴지통(shell.trashItem). 영구 삭제 표면 없음.
  explorer: {
    getRoots: () => ipcRenderer.invoke('spip:explorer:getRoots'),
    pickRoot: () => ipcRenderer.invoke('spip:explorer:pickRoot'),
    removeRoot: (p) => ipcRenderer.invoke('spip:explorer:removeRoot', { path: String(p) }),
    list: (p) => ipcRenderer.invoke('spip:explorer:list', { path: p == null ? '' : String(p) }),
    open: (p) => ipcRenderer.invoke('spip:explorer:open', { path: String(p) }),
    reveal: (p) => ipcRenderer.invoke('spip:explorer:reveal', { path: String(p) }),
    openWith: (p, toolId) => ipcRenderer.invoke('spip:explorer:openWith', {
      path: String(p),
      toolId: toolId ? String(toolId) : undefined,
    }),
    mkdir: (p, name) => ipcRenderer.invoke('spip:explorer:mkdir', { path: String(p), name: String(name) }),
    rename: (p, name) => ipcRenderer.invoke('spip:explorer:rename', { path: String(p), name: String(name) }),
    trash: (p) => ipcRenderer.invoke('spip:explorer:trash', { path: String(p) }),
  },

  // [MD 편집기 위젯 MD-H-1] 마크다운 편집기 — 중첩 네임스페이스(explorer/shelf 패턴). 채널명 하드코딩(MUST).
  //   문서 CRUD 는 앱 데이터 폴더 안에서만 일어나고 id 는 main 이 발급한다.
  //   파일 접근은 importFile/exportFile 뿐이며 **경로 인자가 없다** — 경로는 오직 네이티브 dialog 가
  //   만든다. 렌더러가 임의 경로를 읽거나 쓰게 하는 표면은 존재하지 않는다.
  //   [문서함 = 위젯 인스턴스] 모든 호출의 첫 인자는 box(편집기 위젯 인스턴스 id)다 — 편집기마다
  //   문서함이 갈린다. 형식 검증·격리(다른 문서함 문서 접근 차단)는 메인이 한다(단일 신뢰 경계).
  md: {
    list: (box) => ipcRenderer.invoke('spip:md:list', { box: String(box) }),
    get: (box, id) => ipcRenderer.invoke('spip:md:get', { box: String(box), id: String(id) }),
    create: (box, title, body) => ipcRenderer.invoke('spip:md:create', {
      box: String(box),
      title: title == null ? '' : String(title),
      body: body == null ? '' : String(body),
    }),
    update: (box, id, title, body) => ipcRenderer.invoke('spip:md:update', {
      box: String(box),
      id: String(id),
      title: title == null ? undefined : String(title),
      body: body == null ? undefined : String(body),
    }),
    remove: (box, id) => ipcRenderer.invoke('spip:md:remove', { box: String(box), id: String(id) }),
    importFile: (box) => ipcRenderer.invoke('spip:md:import', { box: String(box) }),
    exportFile: (box, id) => ipcRenderer.invoke('spip:md:export', { box: String(box), id: String(id) }),
    // [MD-AI-1] AI 마크다운 문법 보정 — 선택/전체 텍스트를 보내면 교정된 텍스트를 돌려준다(경로·문서함 무관).
    correct: (text) => ipcRenderer.invoke('spip:md:correct', { text: text == null ? '' : String(text) }),
  },

  // [AG-1] Agent 위젯 — 자연어 요청을 ReAct 루프로 처리(POC: 할 일 제어). 멀티턴: 이전 대화(history) 전달.
  //   응답: { ok, final, steps, todos, context:{tokens,limit,trimmed,source} }.
  agent: {
    run: (message, history) => ipcRenderer.invoke('spip:agent:run', {
      message: message == null ? '' : String(message),
      history: Array.isArray(history) ? history.slice(-40).map((t) => ({
        role: (t && t.role === 'assistant') ? 'assistant' : 'user',
        content: (t && t.content != null) ? String(t.content) : '',
      })) : [],
    }),
  },

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

  // 메일 갱신 push — main(MailWatcher)이 새 메일 감지 시 보내는 'spip:mailUpdated' 중계.
  //   payload 없음(신호만). 홈이 getMailSummary로 최신 다이제스트를 재조회한다. 해제 함수 반환.
  onMailUpdated: (cb) => {
    if (typeof cb !== 'function') return () => {};
    const h = () => cb();
    ipcRenderer.on('spip:mailUpdated', h);
    return () => ipcRenderer.removeListener('spip:mailUpdated', h);
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

  // [M12 b3] 권한 상승 경고 구독 — main 이 보내는 'spip:elevation:warning' 단방향 push 를 콜백으로 중계.
  //   payload: { elevated:true } 고정 신호만(경로·프로필명·whoami 출력 비노출). 콜백만 받고 ipcRenderer
  //   원본은 노출하지 않음(보안). 렌더러는 고정 문구 배너만 표시한다(L-1). unsubscribe 함수 반환.
  onElevationWarning: (cb) => {
    if (typeof cb !== 'function') return () => {};
    const h = (_evt, payload) => cb(payload);
    ipcRenderer.on('spip:elevation:warning', h);
    return () => ipcRenderer.removeListener('spip:elevation:warning', h);
  },

  // [R-28] onMenu 제거 — 네이티브 메뉴(폴더추가·재스캔·새로고침·정보) 폐기에 따른
  //   죽은 수신 채널 정리(SEC-L1 양방향). 해당 기능은 헤더 버튼·렌더러 단축키(F5/Ctrl+O/Ctrl+R)·
  //   설정 '정보' 섹션으로 이관됨. main(menu.js) 발신 경로도 함께 제거됨.

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
