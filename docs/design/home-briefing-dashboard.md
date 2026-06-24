# 통합 대시보드 "홈 · 브리핑" 설계 (v1.6.0 목표)

> 출처 백로그: `docs/ref.md` §통합 대시보드. UI 템플릿: `docs/temp/홈 대시보드 B.html`(번들 export — 시각 참고용).
> 상태: **설계안(구현 전)**. 구현은 마일스톤 단위로 `team-dev` 흐름(없으면 직접) 진행.

## 1. 목표 / 배경

현재 앱의 최상위 화면은 "프로젝트 대시보드"(카드/표 + 궤도 맵)다. 이를 **하위 기능으로 강등**하고,
최상단에 **"홈 · 브리핑"** 화면을 신설한다. 홈은 *지금 무엇을 봐야 하는가*를 한 화면에 요약하는
**인사이트 허브**로, 프로젝트 신호(git·freshness)와 새로 추가된 **메일 알림**, 그리고 경량 **할 일**을
묶어 보여준다. 향후 부가 기능의 인사이트도 이 홈에 카드로 합류한다.

핵심 원칙(유지): 로컬 전용·단일 사용자, 순수 HTML/CSS/JS 프런트(번들러 없음), **새 런타임 의존성 0**
(차트도 canvas/SVG 자작), CommonJS 백엔드, 렌더링은 `textContent`만(L-1), IPC senderFrame 검증,
영속은 OS 앱데이터 0600.

## 2. 템플릿이 의도하는 구성(추출 결과)

`홈 대시보드 B.html`에서 추출한 가시 요소(번들이라 마크업 대신 텍스트 토큰 기준):

- **인사말 + 날짜**: 시간대별("좋은 아침/오후/저녁이에요", "늦은 밤이에요") + 오늘 날짜/요일.
- **오늘의 브리핑(KPI 줄)**: "주의가 필요한 프로젝트 N", "안 읽은 메일 N(회신 필요 N)", "남은 할 일 N".
- **주의가 필요한 프로젝트**: 미커밋/주의 필요(stale·ahead/behind) 프로젝트 추림.
- **안 읽은 메일**: 계정별 안 읽은 메일 수 + 예시 제목("…배포 일정 확인 부탁", "…결제 영수증", "빌드 오류 …"),
  "회신 필요" 표식 → **방금 추가한 복수 메일 계정 기능과 연동**.
- **할 일(To-do)**: "할 일 추가", 남은 할 일 목록(경량 체크리스트).
- **최근 활동 타임라인**: "파일 수정됨 / 커밋 / 브랜치 리베이스" 등 시간순.
- **주간 생산성**: "일 커밋 빈도"(막대), "언어 · 스택 추세"(분포), 주간 회고 메모.

> 템플릿은 더미 데이터가 박힌 시안이다. 본 설계는 **실제로 보유/수집 가능한 데이터로 채울 수 있는
> 범위**를 우선하고, 수집 비용이 큰 항목(아래 §5 "신규 수집 필요")은 별도 마일스톤·옵트인으로 분리한다.

## 3. 정보구조(IA) · 네비게이션

```
상단 네비(탭):  [ 홈 ]   [ 프로젝트 ]   [ 궤도 맵 ]            (우측: 검색 · 도움말 · 설정)
                 ↑기본 랜딩    ↑기존 dashboard뷰   ↑기존 orbit뷰
```

- `store.state.view`에 **`'home'` 신설**. 기존 `'orbit'`이 별도 top-level 뷰로 추가된 선례(`enterOrbit`/
  `exitOrbit`, render() 분기)를 그대로 따른다.
- **기본 랜딩 변경**: 스캔 스냅샷이 있으면 첫 화면을 `'home'`으로(기존 `'dashboard'` → `'home'`).
  스냅샷이 없으면 기존대로 `'firstRun'`.
- 검색은 현재 프로젝트 대시보드 전용 기능이므로, 검색 입력은 **프로젝트 뷰에서만** 노출(홈에서는 숨김).
- 뷰 전환은 헤더의 탭 클릭으로 `store.state.view` 변경 후 `render()`. 스캔/로딩/에러/firstRun은 현행 유지.

## 4. 화면(홈) 구성 · 뷰모델

홈은 카드 그리드. 각 카드는 순수 뷰모델 함수(`homeBriefingVM(snapshot, mail, todos, now)`)가 만든
plain object를 받아 렌더한다(헤드리스 단위테스트 대상, F-3).

| 카드 | 데이터 소스 | 뷰모델 산출 |
|------|-------------|-------------|
| 인사말/날짜 | `store.now`(고정 시각) | 시간대 분기 문자열 + 포맷 날짜 |
| 브리핑 KPI | 아래 3카드 집계 | { attentionCount, unreadMail, todosOpen } |
| 주의 필요 프로젝트 | 스냅샷 `projects[].git/freshness` | dirty·ahead/behind·isStale 필터 → 상위 N, 정렬 |
| 안 읽은 메일 | 신규 `getMailSummary`(§5) | 계정별 { label, unseen } + 합계 |
| 할 일 | 신규 todos 영속(§5) | open/done 목록 |
| 최근 활동 타임라인 | 스냅샷 `freshness.lastModified`·`git.lastCommit` | 시간 내림차순 이벤트 N |
| 주간 생산성(2차) | §5 "신규 수집 필요" | 커밋 빈도/언어 분포(가능 범위) |

모든 텍스트는 `el({text})`=`textContent`로만 렌더(L-1). 메일 제목·프로젝트명 등 신뢰불가 문자열도 동일.

## 5. 백엔드 추가(IPC·영속) — 기존 패턴 재사용

### 5.1 메일 요약 `spip:getMailSummary` (신규, 읽기) — **제목·발신자 포함(결정)**
- 핸들러: `electron/ipc/mailAccounts.js`에 `getMailSummary(ctx)` 추가. 계정별 **안 읽은 메일 수 +
  최근 안 읽은 메일 제목/발신자 미리보기 N건**을 반환. 비밀번호·본문은 미노출(제목/발신자/날짜만).
- **imapClient 확장**: STATUS(unseen) 외에 `SEARCH UNSEEN` → 상위 N UID `UID FETCH (ENVELOPE)`로
  발신자/제목/날짜를 가져온다. ENVELOPE 파서를 `imapProtocol.js`에 순수 함수로 추가(괄호/NIL/quoted/
  literal `{n}` 처리 — 단위테스트). SELECT는 읽기 영향 없도록 `EXAMINE`(read-only) 사용.
- 비용 관리: 미리보기는 **워처가 새 메일 감지 시에만** 갱신하거나, getMailSummary 호출(홈 진입) 시
  계정당 1회 EXAMINE+FETCH(상위 N=5). 제목/발신자는 `clampString`으로 정제 후 textContent 렌더.
- 워처 변경: `MailWatcher.tick()` 성공 시 `{uidnext, unseen}` 보관 → 매니저 `summary()` 집계.
- preload: `getMailSummary()` 채널 추가. register.js guard 등록.

### 5.2 할 일 todos (신규, CRUD·영속)
- `lib/common/uiStateStore.js`에 `todos:[{id,text,done,createdAt}]` 추가(정규화·길이/개수 상한·제어문자
  제거는 기존 `normalizeNames` 방식 차용). ui-state.json(0600)에 영속, schemaVersion 폴백 유지.
- IPC: `electron/ipc/uiState.js`에 `getTodos/addTodo/toggleTodo/removeTodo`. preload 4채널 추가.
- `createdAt`은 main에서 스탬프(렌더러 시각 비신뢰). 텍스트는 sanitize 후 저장.

### 5.3 활동 타임라인 / 생산성 — **git log 추가 수집(결정)**
- 타임라인 1차: 스냅샷의 `freshness.lastModified`·`git.lastCommit`으로 구성(추가 수집 없음).
- 생산성 차트: **신규 수집기 `lib/scan/collectors/commitActivity.js`** — 등록 프로젝트별
  `git -C <path> log --since=<14d> --pretty=%cI`(또는 `--date=short --pretty=%cd | sort | uniq -c`)로
  일자별 커밋 수를 수집해 주간 막대/스파크라인 데이터 산출.
  - 보안: **safeExec 절대경로·`shell:false`·`git -C <path>`(H-2)**, pathGuard.canonicalize 통과 경로만(H-1),
    출력 길이/라인 수 상한·타임아웃(과도 출력 방어). 기존 git 수집기와 동일 실행 규약 재사용.
  - 비용: 홈 진입 또는 주기 워처에서 저빈도 수집. 프로젝트 N개 상한·계정당 타임박스.
- 언어 분포는 스냅샷 `projects[].language`로 즉시 산출(추가 수집 불필요).

## 6. 렌더러(app.js) 변경 요약

1. `render()` 디스패치에 `else if (v === 'home') app.appendChild(renderHome())` 추가.
2. `renderHeader()`에 네비 탭(홈/프로젝트/궤도) 추가, 검색은 프로젝트 뷰에서만 렌더.
3. 신규: `renderHome()` + 카드별 `renderBriefingKpis/renderAttentionProjects/renderMailDigest/
   renderTodos/renderActivity` + 순수 VM 함수들.
4. 기본 랜딩 분기 변경(스냅샷 보유 시 `'home'`). firstRun→스캔 완료 후에도 `'home'`.
5. store 확장: `home`(필요 시 캐시), `todos`, `mailSummary`, `todoInput`, `busyTodos`.
6. 라이브 갱신(R-24 `onProjectsUpdated`)·메일 폴링 결과가 홈 카드에도 반영되도록 홈 뷰에서 재렌더 트리거.

## 7. 보안 · 규약 체크리스트(불변식 유지)

- 렌더는 `textContent`만(L-1) — 메일 제목/프로젝트명/할 일 텍스트 포함.
- 새 IPC는 register.js `guard`(senderFrame 정확 일치) 경유, 고정 에러코드(L-3).
- 비밀번호·자격은 렌더러로 미노출(메일 요약은 unseen·label만).
- 영속은 0600 원자적 쓰기(persistConfigKeys/uiStateStore serializer 재사용).
- 새 런타임 의존성 0: 차트는 canvas 또는 인라인 SVG로 자작(스파크라인/막대).
- CommonJS·바닐라 유지. 버전 문자열 하드코딩 금지(package.json).

## 8. 마일스톤(증분 구현 — 각 단계 테스트 동반)

- **M1 — 셸/네비/홈 골격**: `'home'` 뷰 + 헤더 탭 + 기본 랜딩 변경. 홈은 빈 카드 그리드(자리만).
  프로젝트/궤도 뷰 회귀 없음 확인.
- **M2 — 프로젝트 인사이트**: 인사말/날짜, 주의 필요 프로젝트, 최근 활동(보유 데이터). 순수 VM 단위테스트.
- **M3 — 메일 다이제스트**: `getMailSummary` + 워처 unseen 캐시 + 홈 카드 연동(계정 기능 재사용).
- **M4 — 할 일**: uiStateStore.todos + IPC + 홈 카드(추가/완료/삭제).
- **M5 — 생산성 차트**: 보유 데이터 기반 근사(커밋 빈도/언어 분포). 추가 수집은 옵트인 검토.

각 마일스톤은 독립 PR/커밋 가능하도록 분리. M1~M4는 보유 데이터/저비용이라 우선, M5는 선택.

## 9. 테스트 전략

- 순수 VM(인사말 분기·주의 필터·KPI 집계·타임라인 정렬·todos 정규화)은 `node --test` 헤드리스 단위테스트.
- 신규 IPC(getMailSummary/todos)는 ctx 주입 모킹으로 검증(persist·공개뷰·검증 코드), 마커 컨벤션 병기.
- 뷰 전환/렌더 wiring은 수동 GUI 스모크(F-3) — app.js는 자동 단위테스트 비대상.
- 회귀: 기존 dashboard/orbit/scan 뷰 동작·전체 스위트 그린 유지.

## 10. 결정 사항(확정)

1. **메일 미리보기**: ✅ **제목·발신자까지** 표시(ENVELOPE FETCH). imapProtocol에 ENVELOPE 파서 추가,
   읽기영향 없는 EXAMINE 사용. §5.1 반영.
2. **생산성 차트**: ✅ **git log 추가 수집**(`commitActivity` 수집기, safeExec 절대경로·타임박스). §5.3 반영.
3. **할 일 범위**: ✅ **단순 체크리스트**(텍스트+완료+삭제, uiStateStore 영속). §5.2.
4. **네비 형태**: ✅ **상단 탭**(헤더 확장, 최소 변경). §3.

> 결정에 따라 M3(메일)·M5(차트)의 구현 분량이 늘어난다. M3는 IMAP ENVELOPE 파싱, M5는 신규 git
> 수집기를 포함하므로 각각 단위테스트(파서·수집기)를 동반한다.
