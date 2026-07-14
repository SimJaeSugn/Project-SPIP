'use strict';
/**
 * public/markdown.js — GitHub Flavored Markdown 파서 (MD-1)
 *
 * 마크다운 편집기 위젯의 미리보기가 쓰는 파서. **소스 → AST(순수 데이터)** 까지만 담당하고,
 * DOM 조립(렌더)은 app.js 가 createElement + textContent 로만 수행한다(L-1).
 *   → 파서는 문자열/객체만 다루므로 node --test 로 헤드리스 검증 가능하고, 렌더 경로에
 *     innerHTML 이 끼어들 여지가 원천적으로 없다.
 *
 * 런타임 의존성 0 — 외부 마크다운 라이브러리(marked/markdown-it 등)를 쓰지 않는다.
 *   CLAUDE.md '런타임 의존성 최소화' 규약 + CSP(default-src 'none') 하에서 서드파티 파서를
 *   들이는 비용·표면보다 자체 구현이 낫다는 판단.
 *
 * 지원 문법(GitHub 파싱 대상):
 *   블록 — ATX/Setext 제목, 펜스 코드(```/~~~ + info), 들여쓰기 코드, 인용(중첩),
 *          GitHub Alerts(> [!NOTE] 등), 목록(순서/무순서·중첩·느슨/촘촘), 태스크 리스트,
 *          파이프 테이블(정렬), 수평선, 링크 참조 정의, 각주 정의
 *   인라인 — 코드 스팬, 강조(*·_), 강한 강조, 굵은 기울임, 취소선(~~), 링크(인라인·참조·단축),
 *          이미지, 자동 링크(<url>·bare www/http), 각주 참조, 하드 브레이크, 백슬래시 이스케이프
 *
 * 보안(MD-SEC):
 *   · 원시 HTML 은 **렌더하지 않는다** — 텍스트로 이스케이프되어 그대로 보인다. 마크다운 문서가
 *     신뢰할 수 없는 출처(클론 리포의 README 등)일 수 있으므로 HTML 통과는 XSS 표면이다.
 *   · 모든 URL 은 safeUrl() 화이트리스트(http/https/mailto/file/상대/앵커)를 통과해야 한다.
 *     javascript:·vbscript:·data:(이미지 raster 예외) 는 빈 문자열로 떨어져 링크가 되지 않는다.
 *     data:image/svg+xml 은 스크립트 실행 벡터라 제외.
 */

var SpipMarkdown = (function () {
  /* ───── URL 화이트리스트(MD-SEC) ───── */

  var SAFE_SCHEMES = { http: 1, https: 1, mailto: 1, file: 1 };
  // 래스터 이미지 data URI 만 허용(svg+xml 은 스크립트 실행 벡터라 제외).
  var DATA_IMAGE_RE = /^data:image\/(?:png|jpeg|jpg|gif|webp|bmp|x-icon);base64,[a-z0-9+/=\s]+$/i;

  /**
   * URL 을 화이트리스트로 정제한다. 허용 불가면 '' 를 돌려주며, 호출부는 링크/이미지 대신
   * 텍스트로만 렌더한다(빈 href 로 클릭 가능한 요소를 만들지 않는다).
   * @param {*} raw
   * @param {boolean} [allowDataImage] 이미지 src 자리에서만 true
   * @returns {string}
   */
  function safeUrl(raw, allowDataImage) {
    var s = String(raw == null ? '' : raw).trim();
    if (!s) return '';
    // 제어문자(개행·탭·NUL 등)는 스킴 위장('java\nscript:')에 쓰이므로 먼저 제거한다.
    s = s.replace(/[\x00-\x1f\x7f]/g, '');
    if (!s) return '';
    var colon = s.indexOf(':');
    var slash = s.indexOf('/');
    var hasScheme = colon > 0 && (slash < 0 || colon < slash) && /^[a-z][a-z0-9+.-]*$/i.test(s.slice(0, colon));
    if (!hasScheme) return s; // 상대경로 · #앵커 · ?쿼리
    var scheme = s.slice(0, colon).toLowerCase();
    if (SAFE_SCHEMES[scheme] === 1) return s;
    if (allowDataImage && scheme === 'data' && DATA_IMAGE_RE.test(s)) return s;
    return '';
  }

  /* ───── 공통 유틸 ───── */

  function isBlank(line) { return !line || !line.trim(); }

  /** 수평선 — *** / --- / ___ (3개 이상, 사이 공백 허용). */
  function isHr(line) {
    return /^ {0,3}(?:\*[ \t]*){3,}$|^ {0,3}(?:-[ \t]*){3,}$|^ {0,3}(?:_[ \t]*){3,}$/.test(line);
  }

  /** 목록 항목 시작 판정 → { ordered, start, delim, contentIndent, text } 또는 null. */
  function matchListItem(line) {
    var m = /^( {0,3})(?:([-*+])|(\d{1,9})([.)]))(?:([ \t]+)(.*)|)$/.exec(line);
    if (!m) return null;
    var indent = m[1].length;
    var markerLen = m[2] ? 1 : (m[3].length + 1);
    var spaces = m[5] ? m[5].replace(/\t/g, '    ').length : 1; // 내용 없는 빈 항목은 1칸으로 간주
    // 내용이 5칸 이상 떨어지면 그건 (항목 안의) 들여쓰기 코드 — 내용 들여쓰기는 1칸으로 본다.
    if (spaces > 4) spaces = 1;
    return {
      ordered: !m[2],
      start: m[3] ? parseInt(m[3], 10) : 1,
      delim: m[2] || m[4],
      contentIndent: indent + markerLen + spaces,
      text: m[6] || '',
    };
  }

  /** 새 블록을 여는 줄인가(문단 lazy 연속을 끊는 것들). */
  function isBlockStart(line) {
    if (isBlank(line)) return true;
    if (isHr(line)) return true;
    if (/^ {0,3}#{1,6}(?:[ \t]|$)/.test(line)) return true;
    if (/^ {0,3}(?:`{3,}|~{3,})/.test(line)) return true;
    if (/^ {0,3}>/.test(line)) return true;
    if (matchListItem(line)) return true;
    return false;
  }

  /** 테이블 구분행 — |---|:--:|---:| */
  function isTableDelim(line) {
    if (typeof line !== 'string' || line.indexOf('-') < 0) return false;
    return /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/.test(line);
  }

  /** 파이프 행 → 셀 배열. 이스케이프된 \| 는 셀 구분자가 아니다. */
  function splitTableRow(line) {
    var s = line.trim();
    if (s.charAt(0) === '|') s = s.slice(1);
    if (s.charAt(s.length - 1) === '|' && s.charAt(s.length - 2) !== '\\') s = s.slice(0, -1);
    var cells = [];
    var cur = '';
    for (var i = 0; i < s.length; i++) {
      var c = s.charAt(i);
      if (c === '\\' && s.charAt(i + 1) === '|') { cur += '|'; i++; continue; }
      if (c === '|') { cells.push(cur.trim()); cur = ''; continue; }
      cur += c;
    }
    cells.push(cur.trim());
    return cells;
  }

  // GitHub Alerts — > [!NOTE] 등. 인용의 변형(시각적 강조).
  var ALERT_RE = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*$/i;

  /* ───── 전처리: 링크 참조 정의 · 각주 정의 추출 ───── */

  /**
   * 최상위에서 링크 참조 정의([id]: url "title")와 각주 정의([^id]: 내용)를 걷어내고,
   * 나머지 줄만 돌려준다. 두 정의는 문서 어디에 있든 문서 전체에서 참조 가능하므로 선행 처리한다.
   */
  function extractDefinitions(lines) {
    var rest = [];
    var refs = Object.create(null);
    var footnotes = [];   // [{ label, lines[] }] — 등장 순서(정의 순서)
    var i = 0;
    while (i < lines.length) {
      var line = lines[i];

      // 각주 정의 — 이어지는 들여쓰기(4칸) 줄과 blank 는 같은 각주에 속한다.
      var fm = /^ {0,3}\[\^([^\]\s]+)\]:[ \t]*(.*)$/.exec(line);
      if (fm) {
        var body = fm[2] ? [fm[2]] : [];
        i++;
        while (i < lines.length) {
          if (isBlank(lines[i])) {
            // blank 다음이 들여쓰기 줄이면 각주 계속, 아니면 종료.
            if (i + 1 < lines.length && /^ {4,}\S/.test(lines[i + 1])) { body.push(''); i++; continue; }
            break;
          }
          if (/^ {4,}/.test(lines[i])) { body.push(lines[i].slice(4)); i++; continue; }
          break;
        }
        footnotes.push({ label: fm[1], lines: body });
        continue;
      }

      // 링크 참조 정의 — [id]: <url> "title" / 'title' / (title)
      var rm = /^ {0,3}\[([^\]^][^\]]*)\]:[ \t]*(<[^>]*>|\S+)(?:[ \t]+(?:"([^"]*)"|'([^']*)'|\(([^)]*)\)))?[ \t]*$/.exec(line);
      if (rm) {
        var key = rm[1].trim().toLowerCase();
        var dest = rm[2];
        if (dest.charAt(0) === '<' && dest.charAt(dest.length - 1) === '>') dest = dest.slice(1, -1);
        if (!(key in refs)) refs[key] = { href: dest, title: rm[3] || rm[4] || rm[5] || '' };
        i++;
        continue;
      }

      rest.push(line);
      i++;
    }
    return { lines: rest, refs: refs, footnotes: footnotes };
  }

  /* ───── 블록 파서 ───── */

  /**
   * 줄 배열 → 블록 노드 배열.
   * @param {string[]} lines
   * @param {object} ctx { refs, fnIndex } — fnIndex: label → 1-based 번호(참조 렌더용)
   */
  function parseBlocks(lines, ctx) {
    var out = [];
    var i = 0;

    while (i < lines.length) {
      var line = lines[i];

      if (isBlank(line)) { i++; continue; }

      // ── 펜스 코드 ──
      var fm = /^( {0,3})(`{3,}|~{3,})[ \t]*(.*)$/.exec(line);
      if (fm && !(fm[2].charAt(0) === '`' && fm[3].indexOf('`') >= 0)) {
        var indent = fm[1].length;
        var fence = fm[2];
        var info = fm[3].trim();
        var body = [];
        i++;
        // 닫는 펜스가 없으면 문서 끝까지를 코드로 본다(GitHub 동작) — 별도 처리 불필요.
        while (i < lines.length) {
          var cm = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(lines[i]);
          if (cm && cm[1].charAt(0) === fence.charAt(0) && cm[1].length >= fence.length) { i++; break; }
          // 여는 펜스의 들여쓰기만큼 각 줄에서 제거(CommonMark).
          var l = lines[i];
          var strip = 0;
          while (strip < indent && l.charAt(strip) === ' ') strip++;
          body.push(l.slice(strip));
          i++;
        }
        out.push({ type: 'code', lang: info.split(/\s+/)[0] || '', text: body.join('\n') });
        continue;
      }

      // ── 수평선 ── (목록 항목 '- ' 보다 먼저 — '---' 는 hr)
      if (isHr(line)) { out.push({ type: 'hr' }); i++; continue; }

      // ── ATX 제목 ──
      var hm = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/.exec(line);
      if (hm) {
        var htext = (hm[2] || '').replace(/[ \t]+#+[ \t]*$/, '');
        out.push({ type: 'heading', level: hm[1].length, inline: parseInline(htext, ctx) });
        i++;
        continue;
      }

      // ── 인용 / GitHub Alert ──
      if (/^ {0,3}>/.test(line)) {
        var q = [];
        while (i < lines.length) {
          var ql = lines[i];
          if (/^ {0,3}>/.test(ql)) {
            q.push(ql.replace(/^ {0,3}> ?/, ''));
            i++;
            continue;
          }
          // lazy 연속 — 인용 안 문단의 이어지는 줄.
          if (!isBlank(ql) && !isBlockStart(ql)) { q.push(ql); i++; continue; }
          break;
        }
        var alert = null;
        if (q.length && ALERT_RE.test(q[0].trim())) {
          alert = ALERT_RE.exec(q[0].trim())[1].toUpperCase();
          q.shift();
        }
        out.push({ type: 'blockquote', alert: alert, children: parseBlocks(q, ctx) });
        continue;
      }

      // ── 테이블 ── (헤더행 + 구분행)
      if (line.indexOf('|') >= 0 && i + 1 < lines.length && isTableDelim(lines[i + 1])) {
        var header = splitTableRow(line);
        var delims = splitTableRow(lines[i + 1]);
        if (delims.length === header.length) {
          var align = delims.map(function (d) {
            var left = d.charAt(0) === ':';
            var right = d.charAt(d.length - 1) === ':';
            if (left && right) return 'center';
            if (right) return 'right';
            if (left) return 'left';
            return '';
          });
          i += 2;
          var rows = [];
          while (i < lines.length && !isBlank(lines[i]) && lines[i].indexOf('|') >= 0 && !isHr(lines[i])) {
            var cells = splitTableRow(lines[i]);
            // 헤더 열 수에 맞춰 절단/보충(GFM).
            while (cells.length < header.length) cells.push('');
            if (cells.length > header.length) cells = cells.slice(0, header.length);
            rows.push(cells.map(function (c) { return parseInline(c, ctx); }));
            i++;
          }
          out.push({
            type: 'table',
            align: align,
            header: header.map(function (c) { return parseInline(c, ctx); }),
            rows: rows,
          });
          continue;
        }
      }

      // ── 목록 ──
      if (matchListItem(line)) {
        var listRes = parseList(lines, i, ctx);
        out.push(listRes.node);
        i = listRes.next;
        continue;
      }

      // ── 들여쓰기 코드(4칸) ──
      if (/^ {4}/.test(line)) {
        var ic = [];
        while (i < lines.length && (/^ {4}/.test(lines[i]) || isBlank(lines[i]))) {
          // 뒤가 코드가 아니면 blank 는 코드에 포함하지 않는다.
          if (isBlank(lines[i])) {
            var j = i;
            while (j < lines.length && isBlank(lines[j])) j++;
            if (j >= lines.length || !/^ {4}/.test(lines[j])) break;
            for (var k = i; k < j; k++) ic.push('');
            i = j;
            continue;
          }
          ic.push(lines[i].slice(4));
          i++;
        }
        out.push({ type: 'code', lang: '', text: ic.join('\n') });
        continue;
      }

      // ── 문단 (+ Setext 제목) ──
      var para = [];
      var setext = 0;
      while (i < lines.length) {
        var pl = lines[i];
        if (isBlank(pl)) { i++; break; }
        // Setext 밑줄 — 이미 모아둔 문단이 있어야 성립. 문단 바로 뒤의 '---' 는 수평선이 아니라
        //   H2 밑줄이다(CommonMark/GitHub 우선순위). 사이에 공백이 낀 '- - -' 는 여기 매치되지 않아
        //   위쪽 isHr 분기가 그대로 수평선으로 처리한다.
        if (para.length && /^ {0,3}=+[ \t]*$/.test(pl)) { setext = 1; i++; break; }
        if (para.length && /^ {0,3}-+[ \t]*$/.test(pl)) { setext = 2; i++; break; }
        // 다른 블록이 시작하면 문단 종료(lazy 연속 아님).
        if (para.length && isBlockStart(pl)) break;
        if (para.length && pl.indexOf('|') >= 0 && i + 1 < lines.length && isTableDelim(lines[i + 1])) break;
        para.push(pl);
        i++;
      }
      if (para.length) {
        var ptext = para.join('\n').replace(/^[ \t]+/, '');
        if (setext) out.push({ type: 'heading', level: setext, inline: parseInline(ptext, ctx) });
        else out.push({ type: 'paragraph', inline: parseInline(ptext, ctx) });
      }
    }

    return out;
  }

  /**
   * 목록 파싱 — 같은 종류(ordered 여부)의 연속 항목을 하나의 list 노드로.
   *   느슨(loose): 항목 사이에 빈 줄이 있거나 항목 내부에 빈 줄로 분리된 블록이 있을 때.
   *   촘촘(tight): 각 항목의 단일 문단을 인라인으로 펼쳐 렌더(렌더러가 list.tight 로 판단).
   */
  function parseList(lines, start, ctx) {
    var first = matchListItem(lines[start]);
    var ordered = first.ordered;
    var items = [];
    var loose = false;
    var i = start;

    while (i < lines.length) {
      var m = matchListItem(lines[i]);
      if (!m || m.ordered !== ordered) break;

      var contentIndent = m.contentIndent;
      var itemLines = [m.text];
      i++;
      var sawBlank = false;

      while (i < lines.length) {
        var l = lines[i];
        if (isBlank(l)) { itemLines.push(''); sawBlank = true; i++; continue; }
        var ind = /^ */.exec(l)[0].length;
        if (ind >= contentIndent) { itemLines.push(l.slice(contentIndent)); i++; continue; }
        if (matchListItem(l)) break;                 // 형제(또는 다른 종류) 항목
        if (sawBlank || isBlockStart(l)) break;      // 빈 줄 뒤 비들여쓰기 = 목록 종료
        itemLines.push(l);                           // lazy 연속(문단 이어짐)
        i++;
      }

      // 항목 끝의 빈 줄 제거 — 뒤에 형제 항목이 더 있으면 그 빈 줄은 '느슨' 신호.
      var trailingBlank = false;
      while (itemLines.length && !itemLines[itemLines.length - 1].trim()) { itemLines.pop(); trailingBlank = true; }
      var moreItems = i < lines.length && !!matchListItem(lines[i]) && matchListItem(lines[i]).ordered === ordered;
      if (trailingBlank && moreItems) loose = true;
      // 항목 내부에 빈 줄이 남아 있으면(= 블록이 둘 이상) 느슨.
      for (var t = 0; t < itemLines.length; t++) if (!itemLines[t].trim()) { loose = true; break; }

      // 태스크 리스트 — 항목 첫 줄의 [ ] / [x]
      var task = null;
      var tm = /^\[([ xX])\][ \t]+(.*)$/.exec(itemLines[0] || '');
      if (tm) {
        task = tm[1] !== ' ';
        itemLines[0] = tm[2];
      }

      items.push({ task: task, children: parseBlocks(itemLines, ctx) });
    }

    return {
      node: { type: 'list', ordered: ordered, start: ordered ? first.start : 1, tight: !loose, items: items },
      next: i,
    };
  }

  /* ───── 인라인 파서 ───── */

  var ESCAPABLE = '\\`*_{}[]()#+-.!>~|"\'$&,/:;<=?@^';
  // GFM 확장 자동링크 — 맨 URL. 끝의 문장부호는 링크에서 제외한다.
  var BARE_URL_RE = /^(?:https?:\/\/|www\.)[^\s<]+/i;

  /** 코드 스팬을 건너뛴 위치(스캔 보조) — 강조 짝 찾기에서 코드 안 문자를 무시하기 위함. */
  function skipCodeSpan(text, i) {
    var m = /^(`+)/.exec(text.slice(i));
    if (!m) return -1;
    var close = text.indexOf(m[1], i + m[1].length);
    if (close < 0) return -1;
    return close + m[1].length;
  }

  /** 여는 대괄호 i 에 대응하는 ']' 위치(중첩·이스케이프·코드 스팬 고려). 없으면 -1. */
  function findCloseBracket(text, i) {
    var depth = 0;
    for (var j = i; j < text.length; j++) {
      var c = text.charAt(j);
      if (c === '\\') { j++; continue; }
      if (c === '`') { var s = skipCodeSpan(text, j); if (s > 0) { j = s - 1; continue; } }
      if (c === '[') depth++;
      else if (c === ']') { depth--; if (depth === 0) return j; }
    }
    return -1;
  }

  /** '(' 에서 시작하는 인라인 링크 목적지 파싱 → { href, title, end } 또는 null. */
  function parseLinkDest(text, i) {
    if (text.charAt(i) !== '(') return null;
    var j = i + 1;
    while (j < text.length && /[\s]/.test(text.charAt(j))) j++;
    var href = '';
    if (text.charAt(j) === '<') {
      var gt = text.indexOf('>', j + 1);
      if (gt < 0) return null;
      href = text.slice(j + 1, gt);
      j = gt + 1;
    } else {
      var depth = 0;
      while (j < text.length) {
        var c = text.charAt(j);
        if (c === '\\' && j + 1 < text.length) { href += text.charAt(j + 1); j += 2; continue; }
        if (/\s/.test(c)) break;
        if (c === '(') depth++;
        if (c === ')') { if (depth === 0) break; depth--; }
        href += c;
        j++;
      }
    }
    while (j < text.length && /\s/.test(text.charAt(j))) j++;
    var title = '';
    var tc = text.charAt(j);
    if (tc === '"' || tc === "'" || tc === '(') {
      var closeCh = tc === '(' ? ')' : tc;
      var te = text.indexOf(closeCh, j + 1);
      if (te > 0) { title = text.slice(j + 1, te); j = te + 1; }
    }
    while (j < text.length && /\s/.test(text.charAt(j))) j++;
    if (text.charAt(j) !== ')') return null;
    return { href: href, title: title, end: j + 1 };
  }

  /**
   * 인라인 문자열 → 인라인 노드 배열.
   * 강조 짝짓기는 CommonMark 의 delimiter-run 알고리즘을 단순화했다 —
   * 여는 런과 같은 길이 이상의 닫는 런을 앞에서부터 찾고, '_' 는 단어 내부(snake_case)에서
   * 강조로 보지 않는다. 실무 문서에서 흔한 형태(*em*, **strong**, ***both***, 중첩)를 다룬다.
   */
  function parseInline(text, ctx) {
    ctx = ctx || {};
    var out = [];
    var buf = '';
    var i = 0;
    var n = text.length;

    function flush() { if (buf) { out.push({ type: 'text', value: buf }); buf = ''; } }

    while (i < n) {
      var c = text.charAt(i);

      // 백슬래시 이스케이프 · 하드 브레이크(\ + 개행)
      if (c === '\\') {
        var nx = text.charAt(i + 1);
        if (nx === '\n') { flush(); out.push({ type: 'break' }); i += 2; continue; }
        if (nx && ESCAPABLE.indexOf(nx) >= 0) { buf += nx; i += 2; continue; }
        buf += c; i++;
        continue;
      }

      // 하드 브레이크(공백 2칸 + 개행) / 소프트 개행
      if (c === '\n') {
        if (/ {2,}$/.test(buf)) { buf = buf.replace(/ +$/, ''); flush(); out.push({ type: 'break' }); }
        else { buf += '\n'; }
        i++;
        continue;
      }

      // 코드 스팬
      if (c === '`') {
        var cm = /^(`+)/.exec(text.slice(i));
        var ticks = cm[1];
        var close = text.indexOf(ticks, i + ticks.length);
        // 더 긴 런은 닫는 런이 아니다 — 정확히 같은 길이의 런을 찾는다.
        while (close >= 0 && text.charAt(close + ticks.length) === '`') {
          close = text.indexOf(ticks, close + ticks.length);
        }
        if (close >= 0) {
          flush();
          var code = text.slice(i + ticks.length, close).replace(/\n/g, ' ');
          if (code.length > 2 && code.charAt(0) === ' ' && code.charAt(code.length - 1) === ' ' && code.trim()) {
            code = code.slice(1, -1);
          }
          out.push({ type: 'code', value: code });
          i = close + ticks.length;
          continue;
        }
        buf += c; i++;
        continue;
      }

      // 이미지 ![alt](src)
      if (c === '!' && text.charAt(i + 1) === '[') {
        var ib = findCloseBracket(text, i + 1);
        if (ib > 0) {
          var alt = text.slice(i + 2, ib);
          var idest = parseLinkDest(text, ib + 1);
          if (idest) {
            var isrc = safeUrl(idest.href, true);
            flush();
            if (isrc) out.push({ type: 'image', src: isrc, alt: alt, title: idest.title });
            else out.push({ type: 'text', value: alt }); // 차단된 URL — alt 만 텍스트로
            i = idest.end;
            continue;
          }
          // 참조형 이미지 ![alt][id] / ![alt]
          var iref = resolveRef(text, ib, alt, ctx);
          if (iref) {
            flush();
            var rsrc = safeUrl(iref.href, true);
            if (rsrc) out.push({ type: 'image', src: rsrc, alt: alt, title: iref.title });
            else out.push({ type: 'text', value: alt });
            i = iref.end;
            continue;
          }
        }
        buf += c; i++;
        continue;
      }

      // 각주 참조 [^label] · 링크 [text](url) / [text][id] / [id]
      if (c === '[') {
        var fnm = /^\[\^([^\]\s]+)\]/.exec(text.slice(i));
        if (fnm && ctx.fnIndex && ctx.fnIndex[fnm[1].toLowerCase()]) {
          flush();
          out.push({ type: 'fnref', label: fnm[1], index: ctx.fnIndex[fnm[1].toLowerCase()] });
          i += fnm[0].length;
          continue;
        }
        var cb = findCloseBracket(text, i);
        if (cb > 0) {
          var label = text.slice(i + 1, cb);
          var dest = parseLinkDest(text, cb + 1);
          if (dest) {
            var href = safeUrl(dest.href, false);
            flush();
            var kids = parseInline(label, ctx);
            if (href) out.push({ type: 'link', href: href, title: dest.title, children: kids });
            else out.push.apply(out, kids); // 차단된 URL — 링크 없이 내용만
            i = dest.end;
            continue;
          }
          var ref = resolveRef(text, cb, label, ctx);
          if (ref) {
            var rhref = safeUrl(ref.href, false);
            flush();
            var rkids = parseInline(label, ctx);
            if (rhref) out.push({ type: 'link', href: rhref, title: ref.title, children: rkids });
            else out.push.apply(out, rkids);
            i = ref.end;
            continue;
          }
        }
        buf += c; i++;
        continue;
      }

      // 자동 링크 <https://…> · <a@b.c>  /  원시 HTML 은 텍스트로 이스케이프(MD-SEC)
      if (c === '<') {
        var am = /^<((?:https?|mailto|file):[^>\s]+)>/i.exec(text.slice(i));
        if (am) {
          var au = safeUrl(am[1], false);
          flush();
          if (au) out.push({ type: 'link', href: au, title: '', children: [{ type: 'text', value: am[1] }] });
          else out.push({ type: 'text', value: am[0] });
          i += am[0].length;
          continue;
        }
        var em = /^<([^\s<>@]+@[^\s<>@.]+\.[^\s<>@]+)>/.exec(text.slice(i));
        if (em) {
          flush();
          out.push({ type: 'link', href: 'mailto:' + em[1], title: '', children: [{ type: 'text', value: em[1] }] });
          i += em[0].length;
          continue;
        }
        buf += c; i++;   // 그 외 '<' 는 그냥 문자 — 태그로 해석하지 않는다(HTML 미렌더)
        continue;
      }

      // 취소선 ~~ (GFM). 단일 ~ 도 GitHub 은 취소선으로 본다.
      if (c === '~') {
        var trun = /^~{1,2}/.exec(text.slice(i))[0];
        var tclose = findCloser(text, i + trun.length, '~', trun.length);
        if (tclose > 0) {
          flush();
          out.push({ type: 'del', children: parseInline(text.slice(i + trun.length, tclose), ctx) });
          i = tclose + trun.length;
          continue;
        }
        buf += c; i++;
        continue;
      }

      // 강조 * _
      if (c === '*' || c === '_') {
        var run = /^\*+|^_+/.exec(text.slice(i))[0];
        if (run.length > 3) run = run.slice(0, 3);
        var after = text.charAt(i + run.length);
        var before = i > 0 ? text.charAt(i - 1) : '';
        var opens = after && !/\s/.test(after);
        // '_' 는 단어 내부에서 강조가 아니다(snake_case, a_b_c).
        if (c === '_' && /[0-9a-z]/i.test(before)) opens = false;
        if (opens) {
          var eclose = findCloser(text, i + run.length, c, run.length);
          if (eclose > 0) {
            var afterClose = text.charAt(eclose + run.length);
            if (!(c === '_' && afterClose && /[0-9a-z]/i.test(afterClose))) {
              flush();
              var inner = parseInline(text.slice(i + run.length, eclose), ctx);
              var node;
              if (run.length === 3) node = { type: 'strong', children: [{ type: 'em', children: inner }] };
              else if (run.length === 2) node = { type: 'strong', children: inner };
              else node = { type: 'em', children: inner };
              out.push(node);
              i = eclose + run.length;
              continue;
            }
          }
        }
        buf += c; i++;
        continue;
      }

      // GFM 확장 자동링크 — 맨 URL(www. / http(s)://). 단어 중간에서는 링크로 보지 않는다.
      if ((c === 'h' || c === 'w' || c === 'H' || c === 'W') && !/[0-9a-z/@._-]/i.test(i > 0 ? text.charAt(i - 1) : '')) {
        var bm = BARE_URL_RE.exec(text.slice(i));
        if (bm) {
          var raw = bm[0].replace(/[.,;:!?)"'\]]+$/, ''); // 문장부호는 링크 밖으로
          var burl = safeUrl(raw.charAt(0).toLowerCase() === 'w' ? 'https://' + raw : raw, false);
          if (burl) {
            flush();
            out.push({ type: 'link', href: burl, title: '', children: [{ type: 'text', value: raw }] });
            i += raw.length;
            continue;
          }
        }
      }

      buf += c;
      i++;
    }

    flush();
    return out;
  }

  /**
   * 참조형 링크/이미지 해석 — [text][id] · [text][] · [text].
   * @returns {{href,title,end}|null}  end = 소비한 끝 인덱스
   */
  function resolveRef(text, closeBracket, label, ctx) {
    var refs = (ctx && ctx.refs) || {};
    var after = text.slice(closeBracket + 1);
    var m = /^\[([^\]]*)\]/.exec(after);
    var key;
    var end;
    if (m) {
      key = (m[1].trim() || label.trim()).toLowerCase();
      end = closeBracket + 1 + m[0].length;
    } else {
      key = label.trim().toLowerCase();
      end = closeBracket + 1;
    }
    var def = refs[key];
    if (!def) return null;
    return { href: def.href, title: def.title, end: end };
  }

  /**
   * 위치 from 부터 같은 문자 ch 의 길이 >= len 인 '닫는 런'을 찾는다.
   *   · 닫는 런 직전 문자는 공백이 아니어야 한다(빈 강조 방지).
   *   · 코드 스팬 내부와 이스케이프된 문자는 건너뛴다.
   * @returns {number} 닫는 런 시작 인덱스, 없으면 -1
   */
  function findCloser(text, from, ch, len) {
    for (var j = from; j < text.length; j++) {
      var c = text.charAt(j);
      if (c === '\\') { j++; continue; }
      if (c === '`') { var s = skipCodeSpan(text, j); if (s > 0) { j = s - 1; continue; } }
      if (c !== ch) continue;
      var k = j;
      while (k < text.length && text.charAt(k) === ch) k++;
      var runLen = k - j;
      if (runLen < len) { j = k - 1; continue; }
      if (j === from) { j = k - 1; continue; }            // 내용이 비었다
      if (/\s/.test(text.charAt(j - 1))) { j = k - 1; continue; } // '* foo *' 는 강조 아님
      return j;
    }
    return -1;
  }

  /* ───── 진입점 ───── */

  /**
   * 마크다운 소스 → 문서 AST.
   * @param {string} src
   * @returns {{blocks: object[], footnotes: object[]}}
   *   footnotes: [{ label, index, children }] — 문서 하단 각주 목록(참조된 것만 아니라 정의 순서 전부)
   */
  function parse(src) {
    var text = String(src == null ? '' : src)
      .replace(/\r\n?/g, '\n')
      .replace(/\t/g, '    ');
    var lines = text.split('\n');

    var pre = extractDefinitions(lines);

    // 각주 번호(정의 순서 기준) — 인라인 파서가 [^label] 을 번호로 바꿀 때 쓴다.
    var fnIndex = Object.create(null);
    pre.footnotes.forEach(function (f, idx) { fnIndex[f.label.toLowerCase()] = idx + 1; });

    var ctx = { refs: pre.refs, fnIndex: fnIndex };
    var blocks = parseBlocks(pre.lines, ctx);
    var footnotes = pre.footnotes.map(function (f, idx) {
      return { label: f.label, index: idx + 1, children: parseBlocks(f.lines, ctx) };
    });

    return { blocks: blocks, footnotes: footnotes };
  }

  /** 문서 제목 추출 — 첫 H1(없으면 첫 제목). 문서 목록의 표시명 폴백에 쓴다(순수). */
  function firstHeading(src) {
    var lines = String(src == null ? '' : src).replace(/\r\n?/g, '\n').split('\n');
    var inFence = false;
    for (var i = 0; i < lines.length; i++) {
      var l = lines[i];
      if (/^ {0,3}(`{3,}|~{3,})/.test(l)) { inFence = !inFence; continue; }
      if (inFence) continue;
      var m = /^ {0,3}(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/.exec(l);
      if (m) return m[2].trim();
      if (i + 1 < lines.length && l.trim() && /^ {0,3}=+[ \t]*$/.test(lines[i + 1])) return l.trim();
    }
    return '';
  }

  return { parse: parse, parseInline: parseInline, safeUrl: safeUrl, firstHeading: firstHeading };
})();

// node --test(헤드리스)에서 require 가능하도록 — 브라우저에선 전역 SpipMarkdown 으로 접근.
if (typeof module !== 'undefined' && module.exports) module.exports = SpipMarkdown;
