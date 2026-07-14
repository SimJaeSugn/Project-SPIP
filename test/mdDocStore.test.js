'use strict';
/**
 * mdDocStore.test.js — 마크다운 문서 저장소 (MD-1)
 *
 * 정규화가 단일 검증 경계다 — 렌더러가 보낸 값이 여기서 전부 걸러진다는 걸 고정한다.
 * 영속(원자적 0600 쓰기)은 uiStateStore 와 동형이므로 라운드트립·권한만 확인한다.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('../lib/common/mdDocStore');

let seq = 0;
function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spip-md-test-'));
  return path.join(dir, 'md-docs-' + (seq++) + '.json');
}
/** 유효 id 를 가진 문서(정규화 통과용). */
function doc(over) {
  return Object.assign({ id: store.newId(), title: 't', body: 'b', createdAt: 1000, updatedAt: 2000 }, over || {});
}

/* ───── id ───── */

test('MD-1 newId — 형식(d + hex12)이고 매번 다르다(main 만 발급)', () => {
  const a = store.newId();
  const b = store.newId();
  assert.ok(store.ID_RE.test(a), 'id 형식: ' + a);
  assert.notStrictEqual(a, b);
});

test('MD-1 normalizeDoc — id 가 형식에 맞지 않으면 문서를 버린다(렌더러 id 주입 차단)', () => {
  assert.strictEqual(store.normalizeDoc(doc({ id: '../../etc/passwd' })), null);
  assert.strictEqual(store.normalizeDoc(doc({ id: 'xyz' })), null);
  assert.strictEqual(store.normalizeDoc(doc({ id: 123 })), null);
  assert.strictEqual(store.normalizeDoc(null), null);
  assert.ok(store.normalizeDoc(doc()), '유효 id 는 통과');
});

/* ───── 정제 ───── */

test('MD-1 sanitizeTitle — 개행·제어문자 제거, 길이 상한, 트림(제목은 단일 행)', () => {
  assert.strictEqual(store.sanitizeTitle('  제목  '), '제목');
  assert.strictEqual(store.sanitizeTitle('한\n줄\t로'), '한줄로', '개행·탭 제거');
  assert.strictEqual(store.sanitizeTitle('a' + String.fromCharCode(0) + 'b'), 'ab', 'NUL 제거');
  assert.strictEqual(store.sanitizeTitle('x'.repeat(500)).length, store.MAX_TITLE);
  assert.strictEqual(store.sanitizeTitle(123), '', '비문자열은 빈 문자열');
});

test('MD-1 sanitizeBody — 개행·탭 보존(마크다운의 의미), 그 외 제어문자 제거, 길이 상한', () => {
  assert.strictEqual(store.sanitizeBody('# 제목\n\n- 항목\n\t들여쓰기'), '# 제목\n\n- 항목\n\t들여쓰기');
  assert.strictEqual(store.sanitizeBody('a' + String.fromCharCode(0, 7) + 'b'), 'ab', 'NUL·BEL 제거');
  assert.strictEqual(store.sanitizeBody('x'.repeat(store.MAX_BODY + 100)).length, store.MAX_BODY);
});

test('MD-1 sanitizeBody — HTML 을 이스케이프하지 않는다(렌더가 textContent 라 무해 · L-1)', () => {
  const s = '<script>alert(1)</script>';
  assert.strictEqual(store.sanitizeBody(s), s, '본문은 원문 그대로 보존 — 무해화는 렌더 경로가 책임');
});

/* ───── 배열/상태 정규화 ───── */

test('MD-1 normalizeDocs — 손상 항목 제거·id 중복 제거·개수 상한', () => {
  const dup = store.newId();
  const r = store.normalizeDocs([
    doc({ id: dup, title: '첫째' }),
    doc({ id: dup, title: '중복' }),
    null,
    'string',
    doc({ id: 'bad' }),
    doc({ title: '정상' }),
  ]);
  assert.strictEqual(r.length, 2, '중복·손상 제거');
  assert.strictEqual(r[0].title, '첫째', '먼저 나온 것이 남는다');

  const many = [];
  for (let i = 0; i < store.MAX_DOCS + 20; i++) many.push(doc());
  assert.strictEqual(store.normalizeDocs(many).length, store.MAX_DOCS, '개수 상한');

  assert.deepStrictEqual(store.normalizeDocs(null), [], 'graceful');
  assert.deepStrictEqual(store.normalizeDocs({ a: 1 }), []);
});

test('MD-1 normalizeState — 손상 입력도 기본 상태로 흡수, schemaVersion 은 항상 최신', () => {
  assert.deepStrictEqual(store.normalizeState(null), { schemaVersion: store.SCHEMA_VERSION, boxes: {}, legacy: [] });
  assert.deepStrictEqual(store.normalizeState({ boxes: 'nope' }).boxes, {});
  assert.deepStrictEqual(store.normalizeState({ docs: 'nope' }).legacy, []);
  assert.strictEqual(store.normalizeState({ schemaVersion: 999 }).schemaVersion, store.SCHEMA_VERSION);
});

/* ───── [v2] 위젯 인스턴스별 문서함(boxes) ───── */

test('MD-BOX normalizeBoxes — 키(iid) 형식 화이트리스트, 문서함마다 문서 수 상한', () => {
  const d = (t) => doc({ title: t });
  const r = store.normalizeBoxes({
    mdedit: [d('a')],
    w7: [d('b')],
    'BAD KEY': [d('c')],   // 형식 불량 → 제거
    '../x': [d('d')],      // 경로 흉내 → 제거
    w8: 'nope',            // 배열 아님 → 빈 문서함
  });
  assert.deepStrictEqual(Object.keys(r).sort(), ['mdedit', 'w7', 'w8']);
  assert.strictEqual(r.mdedit.length, 1);
  assert.deepStrictEqual(r.w8, []);
});

test('MD-BOX docsOf/withDocs — 한 문서함만 갈아끼우고 다른 문서함은 건드리지 않는다', () => {
  const s0 = store.normalizeState({ boxes: { mdedit: [doc({ title: 'A' })], w7: [doc({ title: 'B' })] } });
  assert.strictEqual(store.docsOf(s0, 'mdedit').length, 1);
  assert.deepStrictEqual(store.docsOf(s0, '없는문서함'), []);

  const s1 = store.withDocs(s0, 'mdedit', []);
  assert.deepStrictEqual(store.docsOf(s1, 'mdedit'), [], '이 문서함만 비었다');
  assert.strictEqual(store.docsOf(s1, 'w7').length, 1, '다른 편집기의 문서함은 그대로');
  assert.strictEqual(store.docsOf(s0, 'mdedit').length, 1, '원본 상태는 불변');
});

test('MD-BOX 이행 — v1(전역 docs)은 legacy 로 보존된다(흡수는 IPC 가 첫 편집기에게만)', () => {
  const s = store.normalizeState({ schemaVersion: 1, docs: [doc({ title: '옛 문서' })] });
  assert.strictEqual(s.schemaVersion, 2);
  assert.deepStrictEqual(s.boxes, {}, '아직 어느 문서함의 것도 아니다');
  assert.strictEqual(s.legacy.length, 1, '유실 없이 보존');
  assert.strictEqual(s.legacy[0].title, '옛 문서');
});

/* ───── 영속 ───── */

test('MD-1 write/read — 라운드트립 보존(본문 개행 포함) + 파일 부재는 기본 상태', () => {
  const file = tmpFile();
  assert.deepStrictEqual(store.read({ mdDocsPath: file }), store.defaultState(), '부재 시 graceful');

  const d = doc({ title: '회의록', body: '# 회의록\n\n- 항목 1\n- 항목 2\n' });
  const w = store.write({ boxes: { mdedit: [d] } }, { mdDocsPath: file });
  assert.strictEqual(store.docsOf(w, 'mdedit').length, 1);

  const back = store.read({ mdDocsPath: file });
  const got = store.docsOf(back, 'mdedit');
  assert.strictEqual(got[0].body, '# 회의록\n\n- 항목 1\n- 항목 2\n', '개행 보존(키 안 버려짐)');
  assert.strictEqual(got[0].title, '회의록');
});

test('MD-1 read — 손상 JSON·과대 파일은 기본 상태(앱이 죽지 않는다)', () => {
  const file = tmpFile();
  fs.writeFileSync(file, '{ 깨진 json');
  assert.deepStrictEqual(store.read({ mdDocsPath: file }), store.defaultState());
});

test('MD-1 write — 저장 파일은 소유자 전용(0600) 권한 (M-2)', { skip: process.platform === 'win32' ? 'POSIX 권한 없음' : false }, () => {
  const file = tmpFile();
  store.write({ docs: [doc()] }, { mdDocsPath: file });
  assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
});

test('MD-1 write — 상승(elevated) 세션이면 디스크에 쓰지 않는다 (M12 b3)', () => {
  const file = tmpFile();
  const r = store.write({ boxes: { mdedit: [doc({ title: '비밀' })] } }, {
    mdDocsPath: file,
    deps: { elevationState: { isElevated: () => true } },
  });
  assert.strictEqual(store.docsOf(r, 'mdedit')[0].title, '비밀', '정규화 메모리 결과는 반환');
  assert.strictEqual(fs.existsSync(file), false, '관리자 프로필에 문서가 떨어지지 않는다');
});
