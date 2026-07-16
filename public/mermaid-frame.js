'use strict';
/*
 * public/mermaid-frame.js — 격리 mermaid 렌더러(app://index.html?mermaid=1 문서에서만 로드)
 *
 * 이 스크립트는 메인 앱 문서가 아니라 **격리 iframe** 안에서만 돈다(스코프 CSP: style 'unsafe-inline',
 * script 'unsafe-eval' — security.js buildMermaidCsp). 부모(app://index.html)와 postMessage 로만 통신:
 *   수신 { type:'mmd:render', id, code, theme }  → mermaid 로 렌더
 *   회신 { type:'mmd:done', id, ok, svg(data:URI), w, h }  또는  { ok:false, error }
 * 메인 문서엔 iframe/인라인스타일이 새지 않고, 결과 SVG 는 data:URI 이미지로만 표시된다(무해).
 *
 * 보안: securityLevel 'strict'(라벨 HTML/클릭 JS 차단). 입력은 사용자 자신의 다이어그램 텍스트(DATA)뿐이고
 *   결과는 이미지다. 부모 외 출처 메시지는 무시(ev.source !== window.parent).
 */
(function () {
  var mermaid = window.mermaid;
  var seq = 0;

  function post(target, origin, msg) {
    try { target.postMessage(msg, origin || '*'); } catch (_) { /* noop */ }
  }

  var BASE_CFG = {
    startOnLoad: false,
    securityLevel: 'strict',   // 라벨 내 HTML·클릭 스크립트 차단
    htmlLabels: false,         // SVG <text> 로 라벨(<img> 로 표시돼도 안 깨짐; foreignObject 회피)
    flowchart: { htmlLabels: false, useMaxWidth: true, curve: 'basis', padding: 8 },
    sequence: { useMaxWidth: true },
    gantt: { useMaxWidth: true },
    theme: 'default',
    // SVG 를 <img> 로 표시하므로 웹폰트(Pretendard 등)는 렌더에 못 쓴다(측정↔렌더 불일치도 유발) →
    //   시스템 폰트만. 라틴은 Segoe UI/Helvetica 로, 한글만 Malgun Gothic/Apple SD Gothic Neo 로 떨어지게
    //   **라틴 폰트를 앞에** 둔다(Malgun Gothic 을 앞에 두면 라틴까지 투박하게 그려져 어색해짐).
    fontFamily: '"Segoe UI","Helvetica Neue",Arial,"Malgun Gothic","Apple SD Gothic Neo",sans-serif',
    fontSize: 13,
    // themeVariables 로도 폰트를 못박는다 — 일부 테마 CSS 가 "trebuchet ms" 를 하드코딩해 config.fontFamily
    //   만으론 안 바뀌는 경우가 있다(그 폰트가 없으면 라틴/한글이 투박하게 폴백돼 어색).
    themeVariables: { fontFamily: '"Segoe UI","Helvetica Neue",Arial,"Malgun Gothic","Apple SD Gothic Neo",sans-serif' },
  };
  var curTheme = 'default';
  function ensureTheme(theme) {
    var t = (theme === 'dark' || theme === 'forest' || theme === 'neutral' || theme === 'default' || theme === 'base') ? theme : 'default';
    if (t === curTheme) return;
    curTheme = t;
    var cfg = Object.assign({}, BASE_CFG, { theme: t });
    try { mermaid.initialize(cfg); } catch (_) { /* 렌더 시 에러로 드러남 */ }
  }

  if (!mermaid || typeof mermaid.render !== 'function') {
    // 라이브러리 로드 실패 — 첫 요청에 에러로 답하도록 플래그만 두고 리턴.
    window.__mmdReady = false;
  } else {
    window.__mmdReady = true;
    try { mermaid.initialize(BASE_CFG); } catch (_) { /* 초기화 실패는 렌더 시 에러로 드러남 */ }
  }

  /** SVG 문자열 → { dataUri, w, h }. viewBox 로 자연 크기 산출, width/height 를 px 로 고정(<img> 사이징). */
  function svgToImage(svg) {
    var w = 0, h = 0;
    var vb = /viewBox\s*=\s*"([\d.eE+\- ]+)"/.exec(svg);
    if (vb) {
      var p = vb[1].trim().split(/\s+/);
      if (p.length === 4) { w = Math.round(parseFloat(p[2])) || 0; h = Math.round(parseFloat(p[3])) || 0; }
    }
    if (!w) { var mw = /\bwidth\s*=\s*"(\d+(?:\.\d+)?)"/.exec(svg); if (mw) w = Math.round(parseFloat(mw[1])); }
    if (!h) { var mh = /\bheight\s*=\s*"(\d+(?:\.\d+)?)"/.exec(svg); if (mh) h = Math.round(parseFloat(mh[1])); }
    // width="100%" 등 비수치 크기는 <img> 에서 접히므로, viewBox 기반 px 를 명시한다.
    var fixed = svg;
    if (w && h) {
      fixed = fixed
        .replace(/(<svg[^>]*?)\swidth\s*=\s*"[^"]*"/, '$1')
        .replace(/(<svg[^>]*?)\sheight\s*=\s*"[^"]*"/, '$1')
        .replace(/<svg\b/, '<svg width="' + w + '" height="' + h + '"');
    }
    return { dataUri: 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(fixed), w: w, h: h };
  }

  function handle(ev) {
    if (ev.source !== window.parent) return;            // 부모(app://index.html) 외 무시
    var msg = ev.data;
    if (!msg || typeof msg !== 'object' || msg.type !== 'mmd:render') return;
    var id = msg.id;
    var code = (typeof msg.code === 'string') ? msg.code : '';
    var reply = function (m) { m.type = 'mmd:done'; m.id = id; post(ev.source, ev.origin, m); };

    if (!window.__mmdReady) { reply({ ok: false, error: 'mermaid 라이브러리를 불러오지 못했습니다.' }); return; }
    if (!code.trim()) { reply({ ok: false, error: '빈 다이어그램' }); return; }

    ensureTheme(msg.theme); // 앱 테마(라이트/다크)에 맞춰 다이어그램 색 적용
    var renderId = 'mmd-r' + (++seq);
    try {
      var out = mermaid.render(renderId, code); // v10: Promise<{svg}>
      Promise.resolve(out).then(function (res) {
        var svg = (res && typeof res.svg === 'string') ? res.svg : String(res || '');
        var img = svgToImage(svg);
        reply({ ok: true, svg: img.dataUri, w: img.w, h: img.h });
      }).catch(function (err) {
        reply({ ok: false, error: String((err && err.message) || err || '렌더 실패') });
      });
    } catch (err) {
      reply({ ok: false, error: String((err && err.message) || err || '렌더 실패') });
    }
  }

  window.addEventListener('message', handle);
  // 준비 완료를 부모에 알림(부모는 이 신호 후 큐를 흘려보낸다).
  post(window.parent, '*', { type: 'mmd:ready', ok: !!window.__mmdReady });
})();
