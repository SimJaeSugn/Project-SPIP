'use strict';
/**
 * favorites-smoke.electron.js — 헤드리스 Electron 스모크(실 렌더 검증).
 *
 * 목적(원 버그 봉인): "위젯을 열면 관리/조회 버튼만 보이고 즐겨찾기 카드가 전혀 안 떴다."
 *   순수함수 테스트만으로는 이 버그가 샜으므로(jsdom 0-의존), 실제 Chromium DOM에
 *   public/favorites.html(=favorites.js) 를 로드하고 window.spip 를 모의한 뒤
 *   .fav-card 가 실제로 렌더되는지 webContents.executeJavaScript 로 단언한다.
 *
 * 실행: node_modules/.bin/electron test/headless/favorites-smoke.electron.js
 *   - 성공 시 stdout 에 "SMOKE_OK" 한 줄 + 프로세스 종료코드 0.
 *   - 단언 실패/오류 시 "SMOKE_FAIL:<이유>" + 종료코드 1.
 *
 * 이 파일은 node:test 가 아니라(electron 런타임 필요) 별도 러너이며,
 * test/favorites-smoke.test.js 가 electron 가용 시 이 러너를 spawn 해 결과를 단언한다.
 *
 * window.spip 모의(축소 preload 6채널과 동형):
 *   getUiState → { ok:true, favorites:['a','b','c'] }
 *   getProjects → { ok:true, projects:[a,b,c] }
 *   open/copyText/setFavorite → no-op ok
 *   onFavoritesChanged → 콜백 보관(push 시뮬레이션은 미사용)
 */
const path = require('path');
const { app, BrowserWindow } = require('electron');

app.disableHardwareAcceleration();

const PRELOAD = path.join(__dirname, 'mock-spip-preload.js');
const FAV_HTML = path.join(__dirname, '..', '..', 'public', 'favorites.html');

function fail(reason) {
  process.stdout.write('SMOKE_FAIL:' + reason + '\n');
  try { app.exit(1); } catch (_) { process.exit(1); }
}
function ok(detail) {
  process.stdout.write('SMOKE_DETAIL:' + detail + '\n');
  process.stdout.write('SMOKE_OK\n');
  try { app.exit(0); } catch (_) { process.exit(0); }
}

app.whenReady().then(async () => {
  let win;
  try {
    win = new BrowserWindow({
      show: false,
      width: 360,
      height: 220,
      webPreferences: {
        offscreen: true,
        preload: PRELOAD,
        contextIsolation: true,
        sandbox: false, // 스모크 전용 — 모의 preload 가 require 없이 동작하도록
        nodeIntegration: false,
      },
    });

    // file:// 로 실제 favorites.html 로드(=favorites.css + favorites.js 적용).
    await win.loadFile(FAV_HTML);

    // favorites.js 는 defer + refresh() 가 비동기(call→render). DOM 안정화 대기.
    const result = await win.webContents.executeJavaScript(`
      (async () => {
        // refresh()(getUiState→getProjects→render) 가 끝날 때까지 카드 등장을 폴링.
        function sleep(ms){ return new Promise(r=>setTimeout(r, ms)); }
        let cards = [];
        for (let i = 0; i < 40; i++) {
          cards = Array.from(document.querySelectorAll('.fav-card'));
          if (cards.length >= 1) break;
          await sleep(25);
        }
        const root = document.getElementById('fav-widget');
        const buttons = Array.from(root ? root.querySelectorAll('button') : []);
        const cardCount = cards.length;
        const names = cards.map(c => {
          const n = c.querySelector('.fav-card__name');
          return n ? n.textContent : '';
        });
        // 신규 모델: 카드는 단일 드래그 트랙에 모두 배치(페이징 슬라이드 없음).
        const current = document.querySelectorAll('.fav-carousel__track .fav-card');
        // 경로/언어 본문이 비어있지 않은지(클리핑 회귀 아님 — 본문 존재).
        const firstName = names[0] || '';
        const firstPath = (cards[0] && cards[0].querySelector('.fav-card__path'))
          ? cards[0].querySelector('.fav-card__path').textContent : '';
        // 본문 가시 지오메트리(원 버그=본문 클리핑 회귀 차단): 첫 카드 본문이 실제 높이를 가짐.
        const curBody = document.querySelector('.fav-card .fav-card__body');
        const bodyRect = curBody ? curBody.getBoundingClientRect() : { width: 0, height: 0 };
        const curName = document.querySelector('.fav-card .fav-card__name');
        const nameRect = curName ? curName.getBoundingClientRect() : { width: 0, height: 0 };
        return {
          cardCount,
          currentVisible: current.length,
          buttonCount: buttons.length,
          names,
          firstName,
          firstPath,
          bodyW: Math.round(bodyRect.width), bodyH: Math.round(bodyRect.height),
          nameW: Math.round(nameRect.width), nameH: Math.round(nameRect.height),
        };
      })()
    `);

    // ── 단언 ──
    if (!result || typeof result !== 'object') return fail('executeJavaScript returned non-object');
    if (!(result.cardCount >= 1)) {
      return fail('cardCount<1 (버튼만 보이고 카드 없음 — 원 버그 재현) cards=' + result.cardCount + ' buttons=' + result.buttonCount);
    }
    if (!(result.currentVisible >= 1)) {
      return fail('현재 슬라이드 가시 카드 없음 currentVisible=' + result.currentVisible);
    }
    if (!(result.buttonCount > 0)) {
      return fail('버튼이 전혀 없음 buttonCount=0');
    }
    // "버튼만 있고 카드 없음" 상태가 아님을 명시 — 카드가 버튼과 함께 존재.
    if (result.cardCount === 0 && result.buttonCount > 0) {
      return fail('버튼만 있고 카드 0 — 원 버그');
    }
    if (!result.firstName) {
      return fail('카드 이름(본문) 비어있음 — 본문 클리핑 회귀');
    }
    // 본문/이름이 실제로 보이는 높이를 가져야 함(원 버그=본문 압착으로 안 보임).
    if (!(result.bodyH >= 24 && result.bodyW >= 80)) {
      return fail('카드 본문 가시 높이 부족(클리핑 회귀) bodyW=' + result.bodyW + ' bodyH=' + result.bodyH);
    }
    if (!(result.nameH >= 10)) {
      return fail('카드 이름 가시 높이 부족 nameH=' + result.nameH);
    }
    return ok('cards=' + result.cardCount + ' current=' + result.currentVisible +
      ' buttons=' + result.buttonCount + ' name=' + JSON.stringify(result.firstName) +
      ' path=' + JSON.stringify(result.firstPath) +
      ' bodyWxH=' + result.bodyW + 'x' + result.bodyH + ' nameH=' + result.nameH);
  } catch (err) {
    return fail((err && err.message) || String(err));
  }
});

app.on('window-all-closed', () => { try { app.quit(); } catch (_) {} });
// 안전망: 15초 내 미완료 시 실패.
setTimeout(() => fail('timeout(15s)'), 15000).unref();
