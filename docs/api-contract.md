# Project-SPIP — API 계약 (S4 확정, PM 중재)

> **[현행 전송은 Electron IPC]** 제품이 로컬 웹앱 → Electron 데스크톱 앱으로 이전 완료되어, renderer↔main 통신은 **HTTP가 아니라 Electron IPC**(`window.spip.*` ↔ `ipcMain`)로 이뤄진다. **IPC 채널 계약의 정본은 [`architecture/electron-migration.html`](architecture/electron-migration.html) §4**다(채널 목록·인자 스키마·에러코드·발신자 검증). 아래 HTTP 계약은 **과도기 `npm run start:web`(server.js) 보존분의 레거시 명세**로 남겨둔다(삭제하지 않음 — 후속 제거 예정, 코드리뷰 P2-2). 도메인 응답 shape(Project·stats·health·ScanProgress·에러코드)는 HTTP와 IPC가 동일하게 재사용한다.

> (레거시) 서버(S5, `lib/server/`)와 프론트엔드(S6, `public/`)의 **단일 출처**. 변경은 PM 중재로 양측 통지 후에만(P3-3). 설계 §9 + 백엔드 확정 캐시 스키마를 합의 고정한 문서.

## 공통
- 모든 엔드포인트 **127.0.0.1 전용**. 응답은 JSON(정적 자산 제외), `Content-Type: application/json; charset=utf-8`.
- 상태 변경 POST는 **Host allowlist + Origin 검증 + 세션 토큰**(M-1). `index.html`에 세션 토큰 주입, POST 시 헤더로 전송.
- **세션 토큰 전달 규약(S5 확정)**: 서버가 기동 시 `crypto`로 생성한 토큰을 `index.html` 서빙 시 플레이스홀더 `__SPIP_SESSION_TOKEN__`(메타 태그 `<meta name="spip-session-token" content="__SPIP_SESSION_TOKEN__">`)에 치환 주입하고, 프론트는 상태변경 POST 시 이를 **`X-SPIP-Token` 헤더**로 전송한다. POST는 추가로 `Content-Type: application/json` 보조 검증을 통과해야 한다.
- 스냅샷 부재/손상 시 데이터 조회는 **200 + `hasSnapshot:false` + 빈 배열**(503 폐기, P2-5).

## 엔드포인트

| 메서드 | 경로 | 요청 | 응답 |
|---|---|---|---|
| GET | `/` | — | `public/index.html` |
| GET | `/static/<asset>` | — | `public/<asset>` (MIME 지정, public 밖 차단→404) |
| GET | `/api/projects` | — | `{ schemaVersion, generatedAt, hasSnapshot:boolean, projects: Project[] }` |
| GET | `/api/stats` | — | `{ total, byLanguage:{lang:count}, staleCount, totalBytes:null, generatedAt }` |
| GET | `/api/health` | — | `{ ok:true, hasSnapshot:boolean, codeCli:boolean, git:boolean }` |
| POST | `/api/open` | `{ id: string }` | `{ ok:true, code:"OPENING", message:"VS Code에서 여는 중" }` |
| POST | `/api/rescan` (M4, **구현됨**) | `{ withSize?, allDrives? }` | `202 { ok:true, code:"SCAN_STARTED", scanId, startedAt }` |
| GET | `/api/scan-status` (M4, **구현됨**) | — (X-SPIP-Token 필요) | `200 ScanProgress{ phase, scanId, dirs, found, currentPath, elapsedMs, startedAt, counts, note }` |

### 에러 응답
| 코드 | 조건 | 본문 |
|---|---|---|
| 403 | Host/Origin 불일치·부재, 세션토큰 누락(POST) | `{ ok:false, code:"FORBIDDEN_ORIGIN" }` |
| 404 | `id`가 스냅샷에 없음 | `{ ok:false, code:"ID_NOT_FOUND" }` |
| 403 | id→경로 realpath 화이트리스트 불일치 | `{ ok:false, code:"PATH_NOT_ALLOWED" }` |
| 410/등 | 실경로 소멸 | `{ ok:false, code:"PATH_GONE" }` |
| 200 | `code` CLI 미설치(resolveBin 실패) | `{ ok:false, code:"CODE_CLI_NOT_FOUND" }` (BUG-1) |
| 200 | spawn 시작 실패(기타) | `{ ok:false, code:"OPEN_FAILED" }` (BUG-1) |

- `totalBytes`는 size 미수집 스냅샷이면 `null`(UI "미측정", P2-2) → **size 수집 스냅샷이면 합계 `number`로 승격(§4.3 구현됨)**.
- POST `/api/open` "성공" = **spawn 시작 성공**(실제 창 오픈 확인은 비범위, P2-3). 서버는 detached spawn으로 `code` 프로세스 종료를 기다리지 않고 즉시 응답한다(R-12 2초 피드백 정합).
- `/api/open`은 `{ok:false, code}`를 **200**으로 반환할 수 있다(CODE_CLI_NOT_FOUND/OPEN_FAILED). 프론트는 `data.ok===false`를 실패로 처리하고 `code`를 한국어 메시지로 매핑한다.

## M4 계약 (재스캔·진행) — 설계: `architecture/m4-design.html`

### POST `/api/rescan` (상태변경, M-1 전체 적용)
- 요청 본문: `{ withSize?:boolean, allDrives?:boolean }`
  - **`withSize`** = 본문으로 켜기 허용(성능 옵션, 예산 제한 내). R-09 size 수집.
  - **`allDrives`** = **config 게이트 전용**(`config.allowAllDrives=true`일 때만 적용, 본문만으로는 못 켬). R-05.
- 동시성: **전역 단일 in-flight 락**(백그라운드 1개). 즉시 응답(완료 대기 안 함).
- 응답:
  | 상태 | 코드 | 본문 |
  |---|---|---|
  | 수락(시작) | 202 | `{ ok:true, code:"SCAN_STARTED", scanId, startedAt }` |
  | 이미 진행 중 | 409 | `{ ok:false, code:"SCAN_IN_PROGRESS", scanId }` |
  | scanRoots 미설정 | 409 | `{ ok:false, code:"NO_SCAN_ROOTS", message }` |
  | Host/Origin/토큰 거부 | 403 | `{ ok:false, code:"FORBIDDEN_ORIGIN" }` |

### GET `/api/scan-status` (진행 폴링, M4-H-1 보안)
- **읽기 게이트 `checkReadAccess`**: Host allowlist + Origin + `X-SPIP-Token` 필요(CT 면제). 무인증 폴러 403. (대시보드는 토큰 보유 → 폴링 가능)
- 응답 `ScanProgress`: `{ phase:"idle"|"scanning"|"finalizing"|"done"|"error", scanId, dirs, found, currentPath, elapsedMs, startedAt, counts, note }`
- **`currentPath`는 basename/축약(최대 2세그먼트)만** 노출 — 절대경로는 서버 메모리 전용(L-3). 프론트는 전 문자열 필드 textContent 렌더(L-1).
- 폴링 주기 1초 권장(비활성 탭 완화).

### `/api/stats.totalBytes` 승격
- MVP는 항상 `null`(미측정). size 수집된 스냅샷이면 합계 `number`로 승격 — UI는 자동으로 실값 표시.

## Project 항목 shape (캐시 = `/api/projects`의 `projects[]`, 백엔드 실측 확정)
```json
{
  "id": "c8a5bfbd4f959cca",
  "path": "E:\\03.프로젝트\\...",
  "name": "project-spip",
  "description": "..." ,
  "signals": ["git","package.json","vscode"],
  "language": { "primary": "Node.js", "breakdown": {"JavaScript":0.706,"HTML":0.294} },
  "freshness": { "lastModified": "ISO|null", "lastCommit": "ISO|null", "isStale": false },
  "git": { "status":"ok|na", "isRepo":true, "branch":"master|null", "dirty":false, "ahead":0, "behind":0 },
  "size": { "status":"skipped", "totalBytes":null, "nodeModulesBytes":null, "deps":null, "devDeps":null }
}
```
- `description`은 `null` 가능.
- `git.status==='na'`이면 `branch/dirty/ahead/behind` 모두 `null`.
- `size.status`(도메인 값)는 size 미수집 시 `'skipped'`, **수집 시 `'ok'|'partial'`(예산 도달 부분측정), 격리 오류 시 `'error'`로 승격(M4 구현됨)**. shape는 불변 — 기존 프론트는 `skipped||totalBytes==null`을 "미측정"으로 처리하던 로직 그대로 호환. `deps/devDeps`는 size 비활성이어도 채워질 수 있음(저비용 수집).

## 프론트엔드 보안 필수 (L-1)
- `path`/`name`/`description`/`branch` 등 모든 스캔 유래 문자열은 **반드시 `textContent`로 렌더**(innerHTML 결합 금지). 악성 리포 메타데이터 저장형 XSS 차단(RC-2).
- `index.html`에 **CSP 메타**(`default-src 'self'`, 인라인 스크립트 금지). 자산은 동일 출처 `/static/*`에서만.
- 액션은 **`id` 기반**으로 식별(경로를 클라이언트에서 다루지 않음).
- 필터/정렬/검색은 **클라이언트 메모리에서** 처리(R-11, `/api/projects` 1회 fetch).

---

## 즐겨찾기 셸프 위젯 — IPC 계약 (`window.spip.shelf.*`)

> 설계 단일 진실: [`architecture/shelf-widget-design.html`](architecture/shelf-widget-design.html) §8. 본 절은 backend↔frontend **합의 정본**(경계면 단일 진실). 모든 채널은 `register.js`의 `guard(channel,fn)` 경유(senderFrame origin=`app://` 정확 일치, 고정 `{ok,code}`). preload는 채널명을 하드코딩해 `window.spip.shelf`로 노출하고 인자를 1차 고정(`String`/`Array`), **main이 전부 재검증**(렌더러 비신뢰). 기존 프로젝트 즐겨찾기(`spip:favorites-changed`·`uiState.setFavorite`)와 **완전 분리** — 신규 네임스페이스 `spip:shelf:*`·신규 영속 키 `shelfBookmarks`.

### 채널 표

| 채널 | preload 표면 | 요청 shape | 응답 shape | main 동작·검증 |
|---|---|---|---|---|
| `spip:shelf:list` | `shelf.list()` | — | `{ ok:true, bookmarks: ShelfBookmarkView[], autoRefresh:boolean }` | read → 각 항목에 `bannerImage`(data:URI 또는 null) 부착. **`autoRefresh`(자동 재크롤 토글) 동봉** — 프론트 초기 상태 1회 적재. 실패 graceful `{ok:true,bookmarks:[],autoRefresh}`. |
| `spip:shelf:add` | `shelf.add(type, ref)` | `{ type:string, ref:string }` | `{ ok:true, bookmark: ShelfBookmarkView }` \| `{ ok:false, code }` | ① type∈`{url,folder,file}` ② `detectType` 재확인 ③ url→`crawl`(SSRF·og) / folder·file→`localMeta`(canonicalize+pathPolicy) ④ 메타 채워 정규화 영속 ⑤ 상한 초과=`LIMIT`. |
| `spip:shelf:remove` | `shelf.remove(id)` | `{ id:string }` | `{ ok:true, bookmarks: ShelfBookmarkView[] }` \| `{ ok:false, code }` | id 형식검증→항목 제거→영속. bannerKey 이미지 캐시 GC 대상. |
| `spip:shelf:reorder` | `shelf.reorder(ids)` | `{ ids:string[] }` | `{ ok:true }` \| `{ ok:false, code }` | 현존 id의 순열만 채택(누락/외래 무시)→배열 재배열→영속. |
| `spip:shelf:open` | `shelf.open(id)` | `{ id:string }` | `{ ok:true, code:'OPENING' }` \| `{ ok:false, code }` | id 역참조→type 분기. **url**=`shell.openExternal(ref)` + http/https 재검증(임의 스킴 차단). **folder**=재-canonicalize+pathPolicy 재게이트 후 `safeExec(resolveTool('code'),[real],{shell:false,detached:true})`(VS Code, H-2). **file**=재게이트 후 `shell.openPath(real)`(OS 기본앱). 인자 `[real]` 고정·in-flight 상한. |
| `spip:shelf:refresh` | `shelf.refresh(id)` | `{ id:string }` | `{ ok:true, bookmark: ShelfBookmarkView }` \| `{ ok:false, code }` | 단건 재크롤/재스캔→메타·`lastChecked` 스탬프→영속. 성공 시 `spip:shelf:changed` push(타 창 동기화). in-flight 상한(urlMeta 전역 세마포어 공유). |
| `spip:shelf:getSettings` (SH-4) | `shelf.getSettings()` | — | `{ ok:true, autoRefresh:boolean }` | 자동 재크롤 토글(`config.shelfAutoRefresh`, 기본 `true`) 조회. |
| `spip:shelf:setSettings` (SH-4) | `shelf.setSettings({autoRefresh})` | `{ autoRefresh:boolean }` | `{ ok:true, autoRefresh:boolean }` \| `{ ok:false, code:'BAD_INPUT' }` | boolean만 허용. `config` 라이브 갱신(스케줄러 다음 tick 즉시 반영) + `persistConfigKeys` 0600 영속. |
| `spip:shelf:changed` (push) | `shelf.onChanged(cb)` | — | **payload 없음(신호만)** | 스케줄러(6h 재크롤)/수동 refresh로 메타 변경 시 main이 **메인창 wc에만** 단방향 push(broadcastShelf 화이트리스트). 렌더러는 콜백에서 `list()` 재조회(onMailUpdated 패턴) — payload를 신뢰/소비하지 않음. |

### `ShelfBookmarkView` shape (응답 — list/add/refresh)

```jsonc
{
  "id": "b1a2b3c4d5",        // 'b'+6~32 hex. main 생성(crypto.randomBytes). 렌더러 시각 비신뢰
  "type": "url",             // 'url' | 'folder' | 'file'
  "ref": "https://github.com", // url=검증된 http/https / folder·file=canonicalize 실경로(저장값)
  // ── 표시 메타(전부 sanitize·길이상한 · 렌더러 textContent 전용 L-1) ──
  "name": "GitHub",          // 스파인 라벨 ≤120
  "title": "GitHub · 코드 호스팅", // 배너 제목 ≤200
  "sub": "github.com",       // host 또는 tidy 경로 ≤200
  "desc": "레포 호스팅…",     // 설명 ≤500
  "color": "#1c1917",        // '#RRGGBB'만(정규식) — 배너/스파인 배경
  "mono": "G",               // 1~4자 모노 라벨
  "cat": "개발",             // 카테고리 칩 ≤32
  "status": "200 · 120ms",   // url=상태/지연, folder='128개 파일 · 12MB', file='3.2KB · 수정 …' ≤80
  "bannerImage": "data:image/png;base64,…", // og:image data:URI(≤100KB·SVG 제외) 또는 null → 그라데이션 폴백
  "lastChecked": 1719446400000, // ms epoch 또는 null
  "addedAt": 1719446400000   // ms epoch
}
```

- **저장본(`ui-state.json`의 `shelfBookmarks`)은 `bannerImage` 대신 `bannerKey`(sha256 32hex 또는 null)만 보관** — og:image 바이트는 ui-state 밖 appData 캐시(0600). `list/add/refresh` 응답에서만 `imageCache.toDataUri(bannerKey)`로 `bannerImage` 부착. (지연 로드 시 스파인=색만·펼친 항목만 data:URI 가능 — 2차 최적화)
- 표시 순서 = 배열 순서(별도 order 필드 없음, 프로젝트 `setOrder`와 동형). 정규화는 `uiStateStore.normalizeShelfBookmarks` 단일 경계, `MAX_SHELF=64`.

### 고정 에러코드 (L-3 — 내부정보 비노출, 스택·실경로·해소 IP는 로그 전용)

`FORBIDDEN`, `INTERNAL`, `BAD_INPUT`, `LIMIT`, `NOT_FOUND`, `UNSUPPORTED_TYPE`, `CRAWL_FAILED`, `BLOCKED_HOST`(SSRF 차단), `PATH_GONE`, `PATH_DENIED`(민감/시스템 경로), `OPEN_FAILED`.

### 구현 현황 (backend, SH-4 기준)

- **folder/file 완전 동작**: `add`/`open`/`refresh`가 `pathPolicy`(canonicalize+민감경로 deny) 게이트 후 `localMeta`로 메타 수집·열기. `open`은 file=`shell.openPath`(OS 기본앱), folder=VS Code(`safeExec`, 도구 미설정 시 `openPath` 폴백). id·`addedAt`은 main이 `crypto`로 스탬프.
- **URL 크롤 동작(SH-3)**: `add('url', …)`·url `refresh`는 `urlMeta.crawl`로 실제 크롤한다 — `validateHttpUrl`(scheme/자격/길이) → `ssrfGuard`(DNS resolve 후 IP 분류 차단·IP 핀·hop마다 재검증) → `ogParse`(ReDoS 안전 메타 추출) → og:image도 동일 게이트 재진입 → `imageCache`(content-type/매직바이트/≤100KB·SVG 제외·0600). 실패는 고정 코드(`BLOCKED_HOST`/`CRAWL_FAILED`/`BAD_INPUT`).
- **`bannerImage`**: 저장본은 `bannerKey`(sha256 32hex)만, `list`/`add`/`refresh` 응답에서만 `imageCache.toDataUri(bannerKey)`로 `data:image/*;base64` 부착(키 없음/캐시미스/SVG는 `null` → 그라데이션 폴백). 렌더러는 `<img src="data:…">` 속성으로만(L-1).
- **영속 키**: `ui-state.json`의 `shelfBookmarks`(신규). `uiStateStore.normalizeShelfBookmarks` 단일 경계(정규화·`MAX_SHELF=64`·필드 화이트리스트·sanitize). schemaVersion 1→2 이행 시 레거시 사용자는 `shelf`/`shelfWide` 위젯이 `hiddenWidgets`에 기본 union(숨김), 신규 설치도 `defaultState` 시드로 기본 숨김(PM #3).
- **HOME enum 동형**: `HOME_SECTION_IDS = ['attention','productivity','activity','todos','mail','disk','aiusage','shelf','shelfWide','featureAdd']`(backend `uiStateStore` ↔ 렌더러 `app.js` 동형 — `homeLayout-equivalence`/`-front` 테스트가 교차검증).
- **자동 재크롤(SH-4)**: `lib/shelf/scheduler.js`가 6시간 주기로 url 북마크 재크롤(앱 실행 중·첫 tick 지연). 토글 `config.shelfAutoRefresh`(기본 `true`). **D-SCHED-1**: off면 tick 진입 즉시 return(egress 0). **D-SCHED-2**: elevated 세션 스킵. **D-RES-4**: 동시 크롤은 `urlMeta` 전역 세마포어(`MAX_CONCURRENT_CRAWLS=3`)로 상한 — 수동 add/refresh와 공유. 변경 시 `spip:shelf:changed` push. 토글 IPC: `spip:shelf:getSettings`/`setSettings` + `list` 응답 `autoRefresh`.

### preload 인자 1차 고정 (예시 — main 재검증)

```js
shelf: {
  list:      () => invoke('spip:shelf:list'),
  add:       (type, ref) => invoke('spip:shelf:add', { type: String(type), ref: String(ref) }),
  remove:    (id) => invoke('spip:shelf:remove', { id: String(id) }),
  reorder:   (ids) => invoke('spip:shelf:reorder', { ids: Array.isArray(ids) ? ids.map(String) : [] }),
  open:      (id) => invoke('spip:shelf:open', { id: String(id) }),
  refresh:   (id) => invoke('spip:shelf:refresh', { id: String(id) }),
  getSettings: () => invoke('spip:shelf:getSettings'),                         // SH-4 토글 조회
  setSettings: (autoRefresh) => invoke('spip:shelf:setSettings', { autoRefresh: !!autoRefresh }), // SH-4 토글 설정
  onChanged: (cb) => _sub('spip:shelf:changed', cb), // unsubscribe 반환
}
```

### 보안 불변식 (계약 준수 필수)

- **L-1**: 모든 표시 문자열(name/title/sub/desc/status/cat)은 렌더러에서 `textContent`로만. 배너는 `<img src="data:…">`(속성, 마크업 주입 아님). innerHTML 금지.
- **CSP 무변경**: 렌더러 `connect-src 'none'` 유지 — 모든 egress는 main IPC. 배너 data:URI는 기존 `img-src 'self' data:`로 동작.
- **SSRF**: URL·og:image 모두 scheme/자격/길이 + DNS IP 분류 게이트 + IP 핀 + hop 재검증. 응답 한도 본문 512KB·이미지 100KB·타임아웃 8s·리다이렉트 3·압축 미요청.
- **경로(H-1/H-2)**: folder/file은 add·open 양쪽 canonicalize+pathPolicy 재게이트. 열기는 절대경로·`shell:false`·인자 `[real]` 고정.
- **영속**: `uiStateStore.write` 0600·상승세션 보류·1MB/깊이 상한 재사용. 새 런타임 의존성 0(node 내장만).
