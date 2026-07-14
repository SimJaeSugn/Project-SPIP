'use strict';
/**
 * markdown-parser.test.js — GFM 파서(public/markdown.js) 단위 테스트 (MD-1 / MD-SEC)
 *
 * 파서는 소스 → AST(순수 데이터)까지만 담당하므로 DOM 없이 헤드리스로 전량 검증할 수 있다.
 * 보안 축(MD-SEC): URL 화이트리스트 · 원시 HTML 미렌더.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const md = require('../public/markdown.js');

/** AST 를 텍스트로 눌러 담아(구조 무시) 내용 단언을 짧게 쓰기 위한 헬퍼. */
function flatten(nodes) {
  let out = '';
  for (const n of nodes || []) {
    if (!n || typeof n !== 'object') continue;
    if (n.type === 'text' || n.type === 'code') out += n.value;
    if (n.children) out += flatten(n.children);
  }
  return out;
}
function blocks(src) { return md.parse(src).blocks; }
function firstBlock(src) { return blocks(src)[0]; }

/* ───── 블록 ───── */

test('MD-1 제목 — ATX(#~######) + Setext(=/-)', () => {
  assert.deepStrictEqual(firstBlock('# 하나'), { type: 'heading', level: 1, inline: [{ type: 'text', value: '하나' }] });
  assert.strictEqual(firstBlock('###### 여섯').level, 6);
  assert.strictEqual(firstBlock('####### 일곱').type, 'paragraph', '7개는 제목이 아니다');
  assert.strictEqual(firstBlock('제목\n===').level, 1, 'Setext H1');
  assert.strictEqual(firstBlock('제목\n---').level, 2, 'Setext H2');
  assert.strictEqual(firstBlock('## 닫는 해시 ##').inline[0].value, '닫는 해시', '후행 # 제거');
});

test('MD-1 펜스 코드 — info(언어) 보존, 내부는 파싱하지 않는다', () => {
  const b = firstBlock('```js\nconst x = **not bold**;\n```');
  assert.deepStrictEqual(b, { type: 'code', lang: 'js', text: 'const x = **not bold**;' });
  assert.strictEqual(firstBlock('~~~\nplain\n~~~').lang, '', '~~~ 펜스도 지원');
  // 미닫힘 펜스는 문서 끝까지 코드(GitHub 동작).
  assert.strictEqual(firstBlock('```\nunclosed').text, 'unclosed');
});

test('MD-1 목록 — 순서/무순서·중첩·태스크리스트·느슨/촘촘', () => {
  const ul = firstBlock('- 하나\n- 둘');
  assert.strictEqual(ul.type, 'list');
  assert.strictEqual(ul.ordered, false);
  assert.strictEqual(ul.tight, true, '빈 줄 없으면 촘촘');
  assert.strictEqual(ul.items.length, 2);

  const ol = firstBlock('3. 셋\n4. 넷');
  assert.strictEqual(ol.ordered, true);
  assert.strictEqual(ol.start, 3, '시작 번호 보존');

  const loose = firstBlock('- 하나\n\n- 둘');
  assert.strictEqual(loose.tight, false, '항목 사이 빈 줄이면 느슨');

  const task = firstBlock('- [ ] 안함\n- [x] 함');
  assert.strictEqual(task.items[0].task, false);
  assert.strictEqual(task.items[1].task, true);
  assert.strictEqual(flatten(task.items[1].children[0].inline), '함', '체크박스 마커는 본문에서 제거');

  const nested = firstBlock('- 부모\n  - 자식');
  assert.strictEqual(nested.items[0].children[1].type, 'list', '중첩 목록');
});

test('MD-1 테이블 — 정렬(:---, :---:, ---:) + 셀 수 정규화', () => {
  const t = firstBlock('| 좌 | 중 | 우 |\n|:---|:--:|---:|\n| a | b | c |');
  assert.strictEqual(t.type, 'table');
  assert.deepStrictEqual(t.align, ['left', 'center', 'right']);
  assert.strictEqual(flatten(t.header[0]), '좌');
  assert.strictEqual(t.rows.length, 1);
  // 헤더보다 셀이 적은 행은 빈 셀로 보충(GFM).
  const short = firstBlock('| a | b |\n|---|---|\n| 1 |');
  assert.strictEqual(short.rows[0].length, 2);
});

test('MD-1 인용 + GitHub Alerts(> [!NOTE] 등)', () => {
  const q = firstBlock('> 인용문');
  assert.strictEqual(q.type, 'blockquote');
  assert.strictEqual(q.alert, null);
  assert.strictEqual(flatten(q.children[0].inline), '인용문');

  const a = firstBlock('> [!WARNING]\n> 조심하세요');
  assert.strictEqual(a.alert, 'WARNING');
  assert.strictEqual(flatten(a.children[0].inline), '조심하세요', 'alert 마커 줄은 본문에서 제거');
});

test('MD-1 수평선 — ***/---/___ (목록 마커보다 우선)', () => {
  for (const s of ['---', '***', '___', '- - -']) {
    assert.strictEqual(firstBlock(s).type, 'hr', s + ' 는 수평선');
  }
});

/* ───── 인라인 ───── */

test('MD-1 강조 — *em* / **strong** / ***both*** / ~~del~~ / `code`', () => {
  const p = firstBlock('*a* **b** ***c*** ~~d~~ `e`').inline;
  const types = p.filter((n) => n.type !== 'text').map((n) => n.type);
  assert.deepStrictEqual(types, ['em', 'strong', 'strong', 'del', 'code']);
  const both = p.find((n) => n.type === 'strong' && n.children[0].type === 'em');
  assert.ok(both, '*** 는 strong(em(...))');
  assert.strictEqual(p.find((n) => n.type === 'code').value, 'e', '코드 스팬 내용은 원문 그대로');
});

test('MD-1 강조 — _ 는 단어 내부에서 강조가 아니다(snake_case 보존)', () => {
  const p = firstBlock('snake_case_here').inline;
  assert.strictEqual(flatten(p), 'snake_case_here');
  assert.strictEqual(p.filter((n) => n.type === 'em').length, 0, 'em 생성 금지');
  // 단어 경계에서는 정상 강조.
  assert.ok(firstBlock('_강조_').inline.some((n) => n.type === 'em'));
});

test('MD-1 코드 스팬 안의 마크다운은 파싱하지 않는다', () => {
  const p = firstBlock('`**not bold**`').inline;
  assert.strictEqual(p.length, 1);
  assert.deepStrictEqual(p[0], { type: 'code', value: '**not bold**' });
});

test('MD-1 링크 — 인라인/참조/단축/자동링크(<url>·bare www)', () => {
  const inline = firstBlock('[t](https://a.b "제목")').inline[0];
  assert.strictEqual(inline.type, 'link');
  assert.strictEqual(inline.href, 'https://a.b');
  assert.strictEqual(inline.title, '제목');

  const ref = firstBlock('[t][r]\n\n[r]: https://ref.example').inline[0];
  assert.strictEqual(ref.href, 'https://ref.example', '참조형 링크');

  const auto = firstBlock('<https://auto.example>').inline[0];
  assert.strictEqual(auto.href, 'https://auto.example');

  const bare = firstBlock('보세요 www.bare.example 입니다').inline.find((n) => n.type === 'link');
  assert.strictEqual(bare.href, 'https://www.bare.example', 'GFM 확장 자동링크(www → https)');

  const mail = firstBlock('<a@b.co>').inline[0];
  assert.strictEqual(mail.href, 'mailto:a@b.co');
});

test('MD-1 이미지 + 하드 브레이크 + 백슬래시 이스케이프', () => {
  const img = firstBlock('![대체텍스트](https://x/y.png)').inline[0];
  assert.deepStrictEqual(img, { type: 'image', src: 'https://x/y.png', alt: '대체텍스트', title: '' });

  assert.ok(firstBlock('a  \nb').inline.some((n) => n.type === 'break'), '공백 2칸 + 개행 = 하드 브레이크');
  assert.strictEqual(flatten(firstBlock('\\*리터럴\\*').inline), '*리터럴*', '이스케이프된 * 는 강조가 아니다');
});

test('MD-1 각주 — 정의 순서대로 번호를 매기고 본문 참조를 연결', () => {
  const doc = md.parse('본문[^a] 과[^b]\n\n[^a]: 첫째\n[^b]: 둘째');
  const refs = doc.blocks[0].inline.filter((n) => n.type === 'fnref');
  assert.deepStrictEqual(refs.map((r) => r.index), [1, 2]);
  assert.strictEqual(doc.footnotes.length, 2);
  assert.strictEqual(flatten(doc.footnotes[0].children[0].inline), '첫째');
  // 정의 줄은 본문 블록에 남지 않는다.
  assert.ok(!blocks('[^a]: 정의만').length, '각주 정의만 있는 문서는 본문 블록 0');
});

/* ───── 보안(MD-SEC) ───── */

test('MD-SEC safeUrl — javascript:/vbscript:/data:(svg) 차단, http(s)/mailto/file/상대 허용', () => {
  for (const bad of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'vbscript:x', 'data:text/html;base64,AAA', 'data:image/svg+xml;base64,AAA']) {
    assert.strictEqual(md.safeUrl(bad, true), '', '차단되어야 함: ' + bad);
  }
  for (const ok of ['https://a.b', 'http://a.b', 'mailto:a@b.c', 'file:///c/x.md', '/rel/path', './rel', '#anchor', '?q=1']) {
    assert.strictEqual(md.safeUrl(ok, false), ok, '허용되어야 함: ' + ok);
  }
  // 래스터 이미지 data URI 는 이미지 자리에서만 허용.
  assert.strictEqual(md.safeUrl('data:image/png;base64,AAA', true), 'data:image/png;base64,AAA');
  assert.strictEqual(md.safeUrl('data:image/png;base64,AAA', false), '', '링크 자리에선 data URI 불허');
});

test('MD-SEC safeUrl — 제어문자로 스킴을 위장해도 차단(java\\nscript:)', () => {
  assert.strictEqual(md.safeUrl('java\nscript:alert(1)', true), '');
  assert.strictEqual(md.safeUrl('java\tscript:alert(1)', true), '');
  assert.strictEqual(md.safeUrl(' javascript:alert(1)', true), '');
});

test('MD-SEC 차단된 URL 은 링크/이미지가 되지 않고 텍스트로만 남는다', () => {
  const p = firstBlock('[클릭](javascript:alert(1))').inline;
  assert.strictEqual(p.filter((n) => n.type === 'link').length, 0, '링크 노드 0');
  assert.strictEqual(flatten(p), '클릭', '내용은 텍스트로 보존');

  const img = firstBlock('![x](javascript:alert(1))').inline;
  assert.strictEqual(img.filter((n) => n.type === 'image').length, 0, '이미지 노드 0');
  assert.strictEqual(flatten(img), 'x', 'alt 만 텍스트로');
});

test('MD-SEC 원시 HTML 은 렌더하지 않는다 — 텍스트 노드로만 남는다(XSS 차단)', () => {
  for (const src of ['<script>alert(1)</script>', '<img src=x onerror=alert(1)>', '<iframe src="evil"></iframe>', '<div onclick="x">a</div>']) {
    const doc = md.parse(src);
    const json = JSON.stringify(doc);
    // AST 에는 text 노드만 — 어떤 html/raw 타입도 만들지 않는다.
    const types = new Set();
    (function walk(ns) {
      for (const n of ns || []) {
        if (!n || typeof n !== 'object') continue;
        types.add(n.type);
        walk(n.children); walk(n.inline);
      }
    })(doc.blocks);
    assert.ok(!types.has('html') && !types.has('raw'), 'html/raw 노드 타입이 존재하지 않는다: ' + src);
    assert.ok(json.indexOf('"type":"text"') >= 0, '텍스트로 보존: ' + src);
  }
});

/* ───── 부가 ───── */

test('MD-1 firstHeading — 첫 제목 추출(펜스 코드 안의 # 은 무시)', () => {
  assert.strictEqual(md.firstHeading('```\n# 코드 안\n```\n\n# 진짜 제목'), '진짜 제목');
  assert.strictEqual(md.firstHeading('본문만 있음'), '');
  assert.strictEqual(md.firstHeading('제목\n===='), '제목', 'Setext 도 인식');
});

test('MD-1 파서는 어떤 입력에도 예외를 던지지 않는다(graceful)', () => {
  for (const src of [null, undefined, '', '\n\n\n', '*'.repeat(500), '['.repeat(200), '|'.repeat(200), '`'.repeat(100), '> '.repeat(100)]) {
    assert.doesNotThrow(() => md.parse(src), '입력: ' + JSON.stringify(String(src).slice(0, 20)));
  }
});
