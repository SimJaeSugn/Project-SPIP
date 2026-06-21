'use strict';
/**
 * build/afterPack.js — electron-builder afterPack 훅: Electron fuses 적용 (EM-M-3, §7.2)
 *
 * 빌드 산출물(패킹된 Electron 바이너리)에 fuses를 굽는다:
 *   · RunAsNode                              비활성 — RUN_AS_NODE 악용 차단
 *   · EnableNodeCliInspectArguments          비활성 — --inspect 등 디버그 인자 차단
 *   · OnlyLoadAppFromAsar                     활성  — asar 외 앱 로드 금지
 *   · EnableEmbeddedAsarIntegrityValidation   비활성 — (주의) Windows+electron-builder 24.x 에서
 *       무결성 해시 리소스가 exe에 자동 주입되지 않아, 활성화하면 런타임에
 *       'FindResource failed(0x715)' FATAL 로 앱이 즉시 죽는다(창 안 뜸). 그래서 끈다.
 *       (재활성하려면 electron-builder 의 네이티브 asarIntegrity 지원/신버전 필요.)
 *   · EnableNodeOptionsEnvironmentVariable    비활성 — NODE_OPTIONS 악용 차단
 *
 * @electron/fuses는 devDependency. 미설치 시(설치 실패 환경) 경고만 남기고 빌드를 막지 않는다
 * (코드·설정은 완성, 사용자 로컬에서 npm install 후 정상 적용).
 */

const path = require('path');

exports.default = async function afterPack(context) {
  let flipFuses, FuseVersion, FuseV1Options;
  try {
    ({ flipFuses, FuseVersion, FuseV1Options } = require('@electron/fuses'));
  } catch (_) {
    console.warn('[afterPack] @electron/fuses 미설치 — fuses 적용을 건너뜁니다. ' +
      'npm install 후 재빌드 시 적용됩니다(EM-M-3).');
    return;
  }

  const { electronPlatformName, appOutDir } = context;
  const ext = { darwin: '.app', win32: '.exe', linux: '' }[electronPlatformName] || '';
  const appName = context.packager.appInfo.productFilename;
  const electronBinary = path.join(appOutDir, `${appName}${ext}`);

  await flipFuses(electronBinary, {
    version: FuseVersion.V1,
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
    // Windows+electron-builder 24.x: 무결성 리소스 미주입으로 활성화 시 FindResource FATAL → 끈다.
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: false,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
  });

  console.log('[afterPack] Electron fuses 적용 완료(EM-M-3):', electronBinary);
};
