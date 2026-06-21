'use strict';
/**
 * electron/menu.js — 네이티브 메뉴 (electron-migration §7.1 접근성 N-07 보조)
 *
 * 파일(폴더 추가→pickFolders·종료) · 스캔(재스캔) · 보기(새로고침·개발자도구 dev만) · 도움말.
 * 메뉴 동작은 renderer로 명령 이벤트를 보내 app.js의 기존 액션 핸들러를 트리거하거나
 * (재스캔/폴더추가는 IPC 채널 재사용), main이 직접 처리한다.
 *
 * buildMenuTemplate를 순수 함수로 분리해 Electron 미설치에서도 구조를 단위테스트한다.
 */

/**
 * 메뉴 템플릿(plain object 배열)을 만든다. Menu.buildFromTemplate에 그대로 전달 가능.
 * @param {object} deps { onPickFolders, onRescan, getWebContents, isDev }
 * @returns {Array<object>}
 */
function buildMenuTemplate(deps) {
  deps = deps || {};
  const isDev = !!deps.isDev;
  const send = (channel) => () => {
    const wc = typeof deps.getWebContents === 'function' ? deps.getWebContents() : null;
    if (wc && typeof wc.send === 'function') wc.send(channel);
  };

  const template = [
    {
      label: '파일',
      submenu: [
        { label: '폴더 추가…', accelerator: 'CmdOrCtrl+O', click: deps.onPickFolders || send('spip:menu:pickFolders') },
        { type: 'separator' },
        { label: '종료', role: 'quit' },
      ],
    },
    {
      label: '스캔',
      submenu: [
        { label: '재스캔', accelerator: 'CmdOrCtrl+R', click: deps.onRescan || send('spip:menu:rescan') },
      ],
    },
    {
      label: '보기',
      submenu: [
        { label: '새로고침', click: send('spip:menu:refresh') },
        ...(isDev ? [{ type: 'separator' }, { role: 'toggleDevTools' }] : []),
      ],
    },
    {
      label: '도움말',
      submenu: [
        { label: 'Project-SPIP 정보', click: send('spip:menu:about') },
      ],
    },
  ];
  return template;
}

module.exports = { buildMenuTemplate };
