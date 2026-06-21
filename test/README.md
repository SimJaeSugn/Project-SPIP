# 테스트 하니스 (S0)

## 러너 결정: `node:test` 채택 (폴백 불필요)

**판정 기준 (P3-2 반영):** 현재 Node에서 `node --test`로 빈/스모크 스위트가
정상 실행되고 `node:test` + `node:assert` 모듈을 require 할 수 있으면 `node:test`를
채택한다. 미흡(런너 부재/크래시)하면 순수 `assert` 기반 경량 러너로 폴백한다
(어느 쪽이든 외부 의존성 0 — ADR-001).

**실측 결과:** 본 환경 Node `v24.5.0`에서 `node --test`가 정상 동작 확인.
스모크 스위트가 `pass 1 / fail 0`로 통과(`node:test`는 Node 18+에서 stable).
→ **`node:test` 채택.** 경량 폴백 러너는 작성하지 않는다.

`node:test`는 Node 16에서는 experimental(`--experimental-test`)이지만 Node 18+에서
stable이다. 본 리포의 `engines.node`는 `>=16`이나 개발/실행 환경은 18+를 권장한다.

## 실행 방법

```
npm test                          # = node --test "test/**/*.test.js"
node --test "test/**/*.test.js"   # 직접 실행도 동일
```

테스트 파일 네이밍은 `*.test.js`(설계 §7 트리).

> 주의: `node --test test/`(디렉터리 인자)는 일부 Node 버전에서 `test` 모듈
> 스펙으로 오인되어 실패한다. 글로브 패턴(`"test/**/*.test.js"`)으로 고정한다.
> 글로브 인자는 Node 21+에서 지원되며, 본 환경(v24.5.0)에서 정상 동작 확인.

## 현재 스위트 (S0)

- `paths.test.js`  — appDir/configPath/cachePath OS 분기·경로 계약
- `config.test.js` — 병합·폴백·scanRoots 정규화·excludes 상한
- `safeExec.test.js` — resolveBin 절대경로 해석·.bat/.cmd 차단·absBin 강제·in-flight
- `logger.test.js` — sanitizeForUser 경로 마스킹·제어문자 제거·warnings 누적
- `smoke.test.js`  — 모듈 로드 무오류 + 하니스 동작 확인(빈 스위트 대체)
