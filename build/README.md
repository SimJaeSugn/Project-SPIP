# build/ — 패키징 리소스

electron-builder가 사용하는 빌드 리소스 폴더(`directories.buildResources`).

## 필요한 에셋 (디자인 단계 산출)

- `icon.ico` — Windows 앱/설치본 아이콘. **현재 자리 비어 있음(placeholder)** — 디자이너가
  실제 `.ico`(256x256 포함 멀티해상도)를 이 경로에 두면 `electron-builder.yml`의 `win.icon`이
  자동 사용한다. 부재 시 electron-builder가 기본 Electron 아이콘으로 폴백한다(빌드는 가능).

## afterPack.js

`build/afterPack.js`는 빌드 산출물에 Electron fuses(EM-M-3: RunAsNode off·OnlyLoadAppFromAsar·
asar integrity 등)를 적용한다. `@electron/fuses`(devDependency)가 설치돼 있어야 적용된다.
