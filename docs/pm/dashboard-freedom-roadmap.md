# 메인 대시보드 자유도 확장 — 로드맵

> 목적: 앞서 제안한 대시보드 자유도/개인화 방안을 **기능적 충돌 없이 전부 수용**하기 위한 단계별 로드맵.
> 원칙: (1) 데이터 모델을 먼저 통합해 스키마 churn 을 없앤다, (2) 저위험·기반 → 고위험·구조 변경 순으로 쌓는다,
> (3) 각 페이즈는 독립 출시 가능하고 매 단계 테스트 그린을 유지한다.
> 실행: 설계는 `dev-orchestrator`, 구현은 `team-dev` 하네스 경유. 산출물 위치는 `docs/architecture/`·`docs/design/`.

---

## 진행 현황 (2026-07-06 기준, 자율 진행)

| 페이즈 | 상태 | 비고 |
|---|---|---|
| Phase 0 — 통합 모델·마이그레이션 | ✅ 완료 | `normalizeDashboardState`/`migrateLegacyToDashboard`/프리셋 CRIT, reconcile 영속 통합 |
| Phase 1 — 편집 모드(N) | ✅ 완료 | `위젯 편집` 토글 + 핸들·×·셀 윤곽 상시 노출 |
| Phase 1 — 내보내기/가져오기(K) | ✅ **배포(v1.22.0)** | 백엔드(serialize/IPC) + 렌더러 버튼. 육안 확인 완료 |
| Phase 1 — 테마 액센트/밀도(J) | ⛔ 보류 | 하드코딩 색상 다수 → 색상 토큰 리팩터 선행 필요 |
| Phase 1 — 템플릿 갤러리(L) | ⬜ 미착수 | |
| Phase 2 — 프리셋 전환(A) | ✅ **배포(v1.21.0)** | 영속·IPC·렌더러 프리셋 탭(전환/추가/복제/이름변경/삭제). 데이터 E2E + 육안 확인 완료 |
| Phase 3 — 밀도(C) | ✅ **배포(v1.22.0)** | `densityTier(px)→S\|M\|L` + `data-density` 훅 + **메일 위젯 showcase 소비**(S=숫자요약/M=목록·시간숨김/L=목록+시간). 타 위젯은 훅 재사용으로 점진 채택 |
| Phase 3 — 신규 위젯(G) | ✅ **배포(v1.22.0)** | ①스크래치패드 · ②통합 커밋 히트맵 · ③시스템 상태(CPU/RAM/디스크). 셋 다 기본숨김(opt-in)·schemaVersion 3 이행·육안 확인 완료 |
| Phase 4 — 팔레트(D) | ✅ **배포(v1.23.0)** | **액션 레지스트리**(`buildActions` + 순수 `filterActions`/`actionMatchScore`) + **Cmd+K 팔레트**(뷰전환·설정·위젯·프리셋·내보내기·테마·포커스·프로젝트점프, 방향키·부분교체) |
| Phase 4 — 포커스(I)·딥링크(H) | ✅ **배포(v1.23.0)** | I: 위젯 포커스 버튼 + 풀스크린 오버레이(종료 시 masonry 재측정·컨테이너 컨텍스트 재사용). H: 팔레트 **프로젝트 점프**(→상세 드로어). 데이터 드래그(위젯간 DnD)는 후속(SortableJS·리사이즈 충돌 회피 설계 필요) |
| Phase 5 — 프리폼(B) | ✅ **배포(v1.24.0)** | `layoutMode=freeform` + 위젯 좌표(`positions{x,y}`) — 자유 배치 토글·드래그 이동(스냅, 클릭/드래그 임계값)·자동 정렬. featureAdd 포함 배치. 육안 확인 완료 |
| Phase 5 — 그룹(M) | 🔶 육안 대기 | 그룹/섹션(`{id,name,collapsed,members}`) — 전체폭 **접기 밴드** + 추가/이름변경/삭제/멤버 배정·제거. **그룹 내부도 masonry**(멤버 폭·높이 리사이즈·드래그 순서변경) + **그룹 순서 드래그**. `layoutMasonryGrid` 메인/그룹 공용, 리사이즈는 속한 격자 기준. masonry 전용·`normalizeGroups` 단일 신뢰 경계 |
| Phase 5 — 스택(F) | ⬜ 미착수 | 위젯 스택(겹침·로테이션). 최고 난이도 — **다음 작업** |

**배포**: v1.24.0 (Phase 5-B 프리폼/자유 배치 — 드래그 이동·스냅·자동 정렬). 테스트 **1232 그린**. 커밋 `bb490ca`→`2c1bbb4`(master).
직전: v1.23.0 (Phase 4 팔레트·포커스·딥링크, `148ae9e`→`6d0eba2`). v1.22.0 (Phase 1-K + Phase 3, `1a198af`→`63d5ee4`). v1.21.0 (Phase 0~2 + 편집 모드).

> ⏭ **다음 세션 이어가기: 문서 맨 아래 §10 핸드오프 참조.**

## 0. 대상 기능 전체 목록

| # | 기능 | 성격 |
|---|---|---|
| A | 대시보드 모드/프리셋 전환(탭) | 구조(모델) |
| B | 프리폼 스냅 배치(빈 칸 허용) | 레이아웃 엔진 |
| C | 크기=정보 밀도 프리셋(S/M/L) | 렌더링 |
| D | 커맨드 팔레트(Cmd+K) | 상호작용 |
| E | 위젯별 설정(⚙️) | 구조(모델) |
| F | 위젯 스택(겹침·로테이션) | 레이아웃 엔진 |
| G | 새 위젯 팔레트 확장(런처·메모·시스템 상태 등) | 가산(additive) |
| H | 위젯 상호작용/딥링크·데이터 드래그 | 상호작용 |
| I | 풀스크린/포커스 위젯 | 상호작용 |
| J | 테마/개인화(액센트·배경·밀도·폰트) | 렌더링 |
| K | 레이아웃 내보내기/가져오기(JSON) | 구조(모델) |
| L | 레이아웃 템플릿 갤러리 | 가산 |
| M | 섹션/그룹 + 접기 | 레이아웃 엔진 |
| N | 명시적 "편집 모드" 토글 | 상호작용 |

---

## 1. 충돌 지점 분석 & 해소 원칙 (핵심)

전부 수용하려면 아래 **7개 충돌**을 설계로 먼저 봉합해야 한다. 이 원칙들이 페이즈 순서를 결정한다.

| 충돌 | 문제 | 해소 원칙 |
|---|---|---|
| **B ↔ 현행 masonry** | 자동 팩킹과 자유 배치는 동시 성립 불가 | 레이아웃을 **프리셋별 `layoutMode`(`masonry`\|`freeform`)** 로 분기. 동시 적용 금지. 프리폼에 "자동 정렬" = masonry 팩킹 1회 실행 버튼 제공 |
| **C ↔ 자유 px 리사이즈** | 이산(S/M/L) vs 연속(px/열) 크기 모델 충돌 | 크기의 **단일 진실은 연속값(현행 `homeWidgetSizes`)** 유지. 밀도 tier 는 측정 크기에서 **파생(렌더링)** — 이미 깔린 `@container` 기반 확장. 별도 크기 모델 추가 안 함 |
| **A ↔ 나머지 전부** | 프리셋마다 무엇이 달라지고 무엇이 공유되는지 미정이면 이후 전 기능이 스키마를 흔듦 | **§2 전역 vs 프리셋 스코프 표를 먼저 확정**. A 를 모델 기반(Phase 0)으로 앞당김 |
| **E·A·B·M ↔ K(내보내기)** | 모델이 흔들리면 export 스키마가 매 페이즈 깨짐 | **버전드 단일 `dashboardState` 스키마(Phase 0)** 를 먼저 고정. K 는 스키마 안정 후. `schemaVersion` + 마이그레이터 |
| **F·E ↔ 리사이즈 핸들(우하단)** | 셀 우하단은 리사이즈 핸들 예약(현 UI 규약). 스택 컨트롤·설정 톱니가 코너 충돌 | **코너 예약 규약(§3)** 확정: × 우상단, ⚙️ 우상단(× 좌측), 리사이즈 우하단(현행), 스택 인디케이터 하단중앙/상단. SortableJS 드래그 필터에 신규 컨트롤 추가 |
| **M ↔ 평면 `homeLayout` 배열·masonry** | 그룹은 위젯 위에 계층을 추가 → 평면 배열/팩킹과 상충 | 모델을 **그룹 노드가 위젯 배열을 감싸는 형태**로 확장(Phase 0 에서 자리만 확보, Phase 5 에서 구현). masonry/freeform 은 "그룹 내부"에서 동작 |
| **D·H ↔ 산재한 액션** | 팔레트·딥링크가 각 위젯 로직에 흩어지면 재사용 불가 | **액션 레지스트리(Phase 0 스캐폴딩)** 단일화. D(팔레트)·H(딥링크)·N(편집모드)·L(템플릿) 모두 이 레지스트리를 소비 |

> 결론: **모델(A·E·K 기반) + 액션 레지스트리 + 편집 모드**를 먼저 세우고, 레이아웃 엔진 확장(B·F·M)을 **맨 마지막**에 둔다.

---

## 2. 전역(Global) vs 프리셋(Per-preset) 스코프 (Phase 0 에서 확정)

| 항목 | 스코프 | 근거 |
|---|---|---|
| 위젯 순서(`layout`) | **프리셋** | 모드마다 다른 배치가 목적 |
| 위젯 크기(`sizes` w/h) | **프리셋** | 배치와 함께 움직임 |
| 프리폼 좌표(`positions`) | **프리셋** | layoutMode=freeform 일 때만 |
| 숨김 위젯(`hidden`) | **프리셋** | 모드별로 다른 위젯 노출 |
| `layoutMode`(masonry/freeform) | **프리셋** | 모드별 배치 방식 |
| 그룹/섹션 구조 | **프리셋** | 배치의 일부 |
| 위젯별 콘텐츠 설정(⚙️: 메일 개수 등) | **전역** | "무엇을 보여줄지"는 프리셋과 직교 — 중복 관리 회피 |
| 런처 핀·즐겨찾기(shelf) | **전역** | 데이터 자산 |
| 테마(액센트·배경·밀도·폰트) | **전역** | 앱 전체 톤 |
| 팔레트/액션 히스토리 | **전역** | |

---

## 3. UI 컨트롤 배치 규약 (충돌 방지, CLAUDE.md UI 규약에 추가)

- **우상단**: 제거(×) — 그 좌측에 위젯 설정(⚙️). 둘 다 호버/편집모드 시 노출.
- **우하단**: 리사이즈 핸들(현행 `.home-resize`) — 예약 고정.
- **하단중앙/상단**: 위젯 스택 인디케이터(점·화살표). 우하단·우상단 침범 금지.
- **편집 모드(N)** 진입 시에만 그리드 라인·모든 핸들·드롭존 강조. 평소엔 깔끔.
- SortableJS `filter` 목록에 신규 인터랙티브 컨트롤(⚙️, 스택 화살표, 프리폼 드래그) 모두 등록해 재정렬 드래그와 분리.

---

## 4. 페이즈별 로드맵

각 항목: **목표 · 포함 · 선행 · 충돌해소 · 검증**. 페이즈는 순서대로지만 같은 페이즈 내부는 병렬 가능.

### Phase 0 — 기반: 통합 데이터 모델 · 액션 레지스트리 · 편집 모드
> 이후 모든 페이즈가 기대는 뼈대. 사용자 가시 기능은 적지만 충돌을 원천 차단.

- **포함**
  - 버전드 `dashboardState` 스키마 설계: `{ schemaVersion, theme, widgetSettings, presets:[{id,name,layout,sizes,positions,hidden,layoutMode,groups}], activePreset }`.
  - 메인 프로세스 **단일 신뢰 경계 정규화** 확장(`normalizeDashboardState`) — 기존 `normalizeHomeLayout`/`normalizeHomeWidgetSizes` 흡수, 화이트리스트·클램프·마이그레이션.
  - 기존 `homeLayout`/`homeWidgetSizes`/`hiddenWidgets` → 단일 프리셋으로 **무손실 마이그레이션**.
  - 액션 레지스트리 스캐폴딩(id·label·run·컨텍스트) — 지금 흩어진 홈 액션 일부를 등록.
  - 편집 모드(N) 상태 + 토글(그리드/핸들 강조 CSS 훅).
- **선행**: 없음
- **충돌해소**: §1 의 모델·스코프·규약을 코드로 고정. `schemaVersion`+마이그레이터로 K 대비.
- **검증**: 정규화 순수 로직 테스트(화이트리스트·클램프·마이그레이션 동형), 렌더 배선 정적 테스트. 보안: 상태 파일 0600·textContent 유지.

### Phase 1 — 개인화 & 운영 (저위험·즉효)
> 모델 안정 직후, 직교·저위험 기능으로 체감 자유도부터 확보.

- **포함**: 테마(J: 액센트 색·배경 그라데이션·밀도 컴팩트/여유·폰트 크기, CSS 변수), 위젯별 설정(E) 프레임워크 + ⚙️ 컨트롤(§3), **내보내기/가져오기 JSON(K)**(스키마 고정됨), 레이아웃 템플릿 갤러리(L: 미니멀/올인원/집중 프리셋 시드).
- **선행**: Phase 0
- **충돌해소**: E 는 전역 스코프(§2). K 는 `dashboardState` 통째 직렬화 + 가져오기 시 `normalizeDashboardState` 통과(신뢰 못 할 입력 방어).
- **검증**: 테마 변수 적용·밀도 스냅샷 배선, export→import 라운드트립 동형 테스트, 가져오기 악성 입력 정규화 테스트.

### Phase 2 — 대시보드 모드/프리셋 전환 (A)
> Phase 0 모델 위에 프리셋 다중화 + 탭 UI.

- **포함**: 프리셋 CRUD(생성/복제/이름변경/삭제/재정렬), 상단 탭 전환, 활성 프리셋 영속, 프리셋별 layout/sizes/positions/hidden/layoutMode 로딩.
- **선행**: Phase 0 (스코프 표 §2)
- **충돌해소**: 전역 항목(테마·⚙️설정)은 프리셋 전환에도 유지. 프리셋별 항목만 스왑.
- **검증**: 프리셋 전환 시 전역/프리셋 분리 유지 테스트, 최소 1개 프리셋 불변식(삭제 가드).

### Phase 3 — 정보 밀도(C) & 새 위젯 팔레트 확장(G)
> 렌더링·가산 위주, 레이아웃 엔진은 아직 건드리지 않음.

- **포함**
  - C: 위젯 크기(측정값)→밀도 tier(S/M/L) 파생 → 크기별 콘텐츠 분기(예: 메일 S=숫자, M=3건, L=목록+미리보기). 기존 `@container` 확장.
  - G: 신규 위젯 — 빠른 실행 런처(핀), 스크래치패드 메모, 전 프로젝트 통합 커밋 히트맵, npm 스크립트 러너, 개발 머신 시스템 상태(CPU/RAM/디스크), 최근 연 파일, 릴리즈/배포 상태.
- **선행**: Phase 0(위젯 계약·⚙️ 프레임워크), Phase 1(설정)
- **충돌해소**: C 는 연속 크기 진실 위에 파생만(§1). 신규 위젯은 반응형 계약(자기 폭·높이 대응) + 코너 규약(§3) 준수.
- **검증**: 밀도 tier 경계 순수 함수 테스트, 신규 위젯별 반응형/보안(경로 pathGuard·safeExec·textContent) 테스트.

### Phase 4 — 상호작용: 커맨드 팔레트(D) · 딥링크(H) · 포커스(I)
> Phase 0 액션 레지스트리를 소비하는 상호작용 계층.

- **포함**: Cmd+K 팔레트(위젯 추가/이동, 프리셋 전환, 프로젝트 점프, 액션 실행), 위젯 간 딥링크·데이터 드래그(attention→todos, 프로젝트→shelf), 풀스크린/포커스 위젯(오버레이).
- **선행**: Phase 0(레지스트리), Phase 2(프리셋 액션), Phase 3(위젯 액션)
- **충돌해소**: 모든 진입점이 **동일 액션 레지스트리** 사용(로직 중복 0). 포커스 오버레이 종료 시 masonry 재측정 보장.
- **검증**: 액션 레지스트리 등록/실행 단위 테스트, 팔레트 검색·키보드 접근성, 포커스 복귀 후 레이아웃 무결성.

### Phase 5 — 레이아웃 엔진 확장: 프리폼(B) · 그룹(M) · 스택(F) [최고 난이도·최후]
> 가장 충돌 위험이 큰 구조 변경. 앞 페이즈들의 안정 모델·편집 모드·밀도 위에서 진행.

- **포함**
  - B: 프리셋 `layoutMode=freeform` — 스냅 그리드, 빈 칸 허용, 임의 x/y 고정, "자동 정렬"(masonry 1회) 버튼. `masonry` 모드는 현행 그대로 유지(기본값).
  - M: 그룹/섹션 노드(라벨·접기) — masonry/freeform 이 그룹 내부에서 동작.
  - F: 위젯 스택(셀 내 겹침·로테이션) — 하단 인디케이터(§3), 리사이즈 핸들과 공존.
- **선행**: Phase 0~4 전부
- **충돌해소**: §1 의 layoutMode 분기·그룹 래핑·코너 규약을 여기서 실체화. 프리폼↔masonry 전환 시 좌표↔순서 상호 변환 규칙 명시.
- **검증**: layoutMode 전환 무손실(순서↔좌표) 테스트, 그룹 접기/이동 불변식, 스택 로테이션·핸들 비충돌, 대량 위젯 성능(rAF·ResizeObserver).

---

## 5. 의존 그래프 요약

```
Phase 0 (모델·레지스트리·편집모드)
  ├─ Phase 1 (테마·⚙️설정·export/import·템플릿)
  ├─ Phase 2 (프리셋 전환)
  │     └─ Phase 4 (팔레트·딥링크·포커스)  ← Phase 3 도 선행
  └─ Phase 3 (밀도·신규 위젯)
                 └─ Phase 4
Phase 5 (프리폼·그룹·스택)  ← Phase 0~4 전부 선행
```

---

## 6. 전 페이즈 공통 불변식 (매 단계 유지)

- **보안**: 렌더 `textContent`만(L-1), 경로 `pathGuard`(H-1), 외부 프로세스 `safeExec`(H-2), 상태 파일 0600, **가져오기/신규 위젯 입력은 메인 단일 신뢰 경계에서 정규화**.
- **테스트**: `node --test`, 기능·보안 불변식 마커 병기, 반응형 배선 테스트 동반, 전 통과 유지.
- **UI 규약**: 홈 위젯 반응형(자기 영역 폭·높이 대응) + 코너 배치 규약(§3) 준수.
- **런타임 의존성 최소화**: 신규 런타임 의존성 지양(프리폼/스택도 바닐라 우선; GridStack·Muuri 는 코드 참고만).
- **출시 단위**: 각 페이즈 독립 릴리즈(버전 단조 증가), 큰 빅뱅 금지.

---

## 7. 다음 액션

1. 본 로드맵 승인 후 **Phase 0 를 `dev-orchestrator`로 정식 설계**(`dashboardState` 스키마·마이그레이션·정규화·레지스트리 ADR).
2. 설계 확정 → `team-dev`로 Phase 0 구현(마이그레이션 무손실 + 테스트 그린).
3. 이후 Phase 1~5 순차 진행, 각 페이즈 착수 전 스코프 표(§2)·규약(§3) 재확인.

---

## 10. 다음 세션 이어가기 (Handoff — cold start)

> 이 절만 읽어도 새 세션에서 바로 이어갈 수 있게 정리. 배포 시점: **v1.21.0** (Phase 0~2 완료).

### 10.1 완료된 것의 코드 지도 (건드릴 때 이해 필수)
- **모델·영속** `lib/common/uiStateStore.js`
  - `normalizeDashboardState` / `normalizePreset` / `normalizeWidgetPositions` / `migrateLegacyToDashboard` / `defaultDashboardState`
  - 프리셋 CRUD(순수): `presetAdd` `presetDuplicate` `presetRename` `presetRemove` `presetSetActive` `presetUpdate` `nextPresetId`
  - 직렬화: `serializeDashboard` / `deserializeDashboard`
  - **★ 핵심 불변식**: 레거시 키(`homeLayout`/`hiddenWidgets`/`homeWidgetSizes`)가 '활성 뷰의 권위'.
    `normalizeState`가 매 read/write마다 **활성 프리셋을 레거시 키에 reconcile**(`presetUpdate`)하고,
    비활성 프리셋 내용은 `dashboard`에 보존. **프리셋 전환 IPC가 레거시 키를 대상 프리셋 내용으로 스왑**.
    → 렌더 경로/기존 데이터 하위호환. 이 모델을 깨지 말 것.
  - 프리셋 스키마: `{id(slug),name,layout,hidden,sizes,positions,layoutMode('masonry'|'freeform'),groups[]}`.
    `positions`=프리폼 예약(Phase 5), `groups`=항상 `[]`로 정규화(Phase 5에서 스키마 확정).
- **IPC** `electron/ipc/uiState.js` — `setActivePreset`/`addPreset`/`duplicatePreset`/`renamePreset`/`removePreset`/
  `exportDashboard`/`importDashboard`. 전환·추가·복제·삭제·import는 `writeWithActive`(레거시 스왑). 이름변경은 스왑 불요.
  응답 `toResponse`에 `dashboard` 포함. 등록: `electron/ipc/register.js`, 노출: `electron/preload.js`.
- **렌더러** `public/app.js`
  - `applyDashboard(res.dashboard)`(방어 적재, 탭 표시용 {id,name,layoutMode}만) — export됨(테스트).
  - `loadUiState`: `store.dashboard = applyDashboard(...)` 하이드레이션.
  - `renderHome`: 프리셋 탭 바(`.preset-tabs`) — 프리셋>1개 또는 편집모드일 때만 표시. 편집모드에서 ✎/⧉/✕/+.
  - 핸들러: `onSwitchPreset`/`onAddPreset`/`onDuplicatePreset`/`onRenamePreset`/`onRemovePreset` → `applyPresetResponse`.
  - 편집 모드: `store.editMode` + `home-masonry--editing` 클래스(CSS: 핸들·×·윤곽 상시).
  - 상태 키: `store.dashboard` `store.editMode` `store._presetRenameId` `store._presetRenameVal`.
  - CSS: `public/styles.css`의 `.preset-tab*` / `.home-editmode` / `.home-masonry--editing`.
- **테스트**: `test/dashboardState.test.js`(모델·CRUD·직렬화·reconcile), `test/ipc-uistate.test.js`(프리셋·export/import IPC),
  `test/homeLayout-front.test.js`(편집모드·프리셋 탭 배선). 총 1201 그린.

### 10.2 다음 작업 (우선순위 순)
1. ~~**Phase 1-K 렌더러 버튼**~~ ✅ **완료**: 편집 모드 우측 편집바에 `내보내기`/`가져오기` 버튼 →
   `renderDashboardIOModal`(buildModal 재사용). 내보내기=`exportDashboard`→readonly textarea + `복사`(copyText)·`파일로 저장`(Blob 다운로드).
   가져오기=textarea 붙여넣기/`파일 선택`(FileReader)→`importDashboard`→`applyPresetResponse`(활성 프리셋 레거시 스왑).
   배선 테스트 `test/homeLayout-front.test.js`('로드맵 Phase 1·K') 추가. **남은 것: `npm start` 육안 검증**(헤드리스 불가).
2. **Phase 3 — 밀도(C) + 신규 위젯(G)** ← **다음 작업**:
   - 밀도: `densityTier(측정폭)→'S'|'M'|'L'` 순수 함수부터(헤드리스). 위젯이 크기별 콘텐츠 분기(예 메일 S=숫자/M=3건/L=목록). 기존 `@container` 확장.
   - 신규 위젯: 런처(핀)·스크래치패드·통합 커밋 히트맵·npm 스크립트 러너·시스템 상태·최근 파일 등.
   - **★ 위젯 추가 절차**: `HOME_SECTION_IDS`를 `lib/common/uiStateStore.js`와 `public/app.js` **양쪽에 동형 추가**
     (드리프트 테스트가 잡음) + `renderHomeSection` case + `WIDGET_META` + 반응형 계약(자기 폭·높이) +
     보안(pathGuard/safeExec/textContent) + 배선 테스트. 프리셋 모델은 새 enum을 자동 수용(마이그레이션 프리).
3. **Phase 1-J 테마 액센트**: 하드코딩 색상(`#4f46e5` 등) 다수 → **색상 토큰(CSS 변수) 리팩터 선행**. 별도 서브프로젝트로.
4. **Phase 4 — 팔레트·딥링크·포커스**: ⚠️ **액션 레지스트리는 로드맵 Phase 0에 명시했으나 실제 미구현**. Phase 4 착수 시 먼저 만들 것.
5. **Phase 5 — 프리폼·그룹·스택**: 최고 난이도. `layoutMode='freeform'`·`positions`는 모델에 준비됨. `groups`는 예약(`[]`)만. §1 충돌 해소·§3 코너 규약 실체화. 검증 루프 필수.

### 10.3 검증 방법 (다음 세션)
- `npm test` → 1201+ 그린 유지(신규 작업마다 배선/순수 테스트 추가).
- **실디스크 E2E 스모크**: 이번 세션 스크립트는 스크래치패드(임시)라 세션 종료 시 소멸.
  → 재작성하거나 `npm run smoke:dashboard`로 리포에 상주화 권장(레거시 시드→마이그레이션→프리셋 독립→export/import 왕복).
- **렌더러는 헤드리스 시각검증 불가**(메모리 기록) → 렌더러 변경 시 `npm start` 육안 필수.

### 10.4 주의(정직)
- 액션 레지스트리 **미구현**(Phase 4 전제).
- Phase 1-K 렌더러 버튼 **구현 완료** — 단 렌더러라 **육안 검증 미완**(`npm start`로 내보내기 복사·파일저장 / 가져오기 붙여넣기·파일선택 왕복 확인 필요).
- Phase 2 렌더러 프리셋 UI는 헤드리스 검증 불가분 — 변경 시 반드시 육안.
- 릴리즈 절차: `docs/temp/RELEASE_DEPLOY_PROMPT.md` §7, 버전 단조 증가, 미서명 SmartScreen 정상.
