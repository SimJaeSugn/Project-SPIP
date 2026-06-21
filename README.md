# Project-SPIP

PC에 흩어진 VS Code 프로젝트를 스캔해, 간략한 설명과 함께 한눈에 보여주는 **로컬 대시보드**입니다.

여러 폴더에 흩어져 있는 프로젝트들을 일일이 찾아 열 필요 없이, 한 화면에서 목록·설명을 확인하고 바로 VS Code로 열 수 있도록 돕는 것을 목표로 합니다.

## 주요 기능

- **자동 스캔** — 지정한 경로 아래의 VS Code 프로젝트(`.git`, `package.json`, `.vscode` 등 보유 폴더)를 탐색
- **요약 정보** — 프로젝트명, 경로, 설명(`package.json`/`README` 기반), 최종 수정 시각 등을 정리
- **로컬 대시보드** — 브라우저에서 목록을 카드/리스트로 확인
- **CLI 제공** — `spip` 명령으로 어디서든 스캔 실행

## 요구 사항

- [Node.js](https://nodejs.org/) **16 이상** (`engines.node >= 16`)

## 설치

```bash
git clone https://github.com/SimJaeSugn/Project-SPIP.git
cd Project-SPIP
npm install
```

## 사용법

```bash
# 1) 프로젝트 스캔 (결과 데이터 생성)
npm run scan

# 2) 대시보드 서버 실행
npm run start

# 스캔 후 서버 실행을 한 번에
npm run dev
```

| 스크립트 | 명령 | 설명 |
| --- | --- | --- |
| `scan` | `node scan.js` | PC를 스캔해 프로젝트 목록 데이터를 생성 |
| `start` | `node server.js` | 대시보드 웹 서버 실행 |
| `dev` | `node scan.js && node server.js` | 스캔 후 서버를 연속 실행 |

### CLI

`bin`에 `spip`가 등록되어 있어, 전역 설치 또는 `npm link` 후 명령으로 사용할 수 있습니다.

```bash
npm link      # 로컬 개발 시 전역 링크
spip          # 스캔 실행 (scan.js)
```

## 동작 방식

1. `scan.js` — 설정된 루트 경로들을 순회하며 VS Code 프로젝트를 탐지하고 메타데이터를 수집
2. `server.js` — 수집된 데이터를 읽어 로컬 웹 대시보드로 제공

> 구현 진행 중인 프로젝트입니다. 현재 `package.json`에 스크립트 구조가 정의되어 있으며, `scan.js`·`server.js`는 개발 예정입니다.

## 라이선스

[MIT](LICENSE)
