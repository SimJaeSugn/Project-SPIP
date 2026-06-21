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
