'use strict';
/**
 * todos-instance-front.test.js — 할 일 위젯 인스턴스화(렌더러 배선) [위젯 인스턴스 v6]
 *
 * 배경: v6 이전 할 일 위젯은 전역 store.todos 하나를 모든 인스턴스가 공유했다. 이제 편집기·탐색기·메모와
 *   동형으로 **인스턴스(iid)마다 독립된 할 일 목록·입력 상태**를 갖는다(getUiState.todoBoxes → wstate[iid]).
 *
 * 이 파일이 고정하는 렌더러 계약(정적 소스 검사 + 순수 로직):
 *   ① makeWState('todos') 가 목록·입력·마감·알림 dedupe 를 전부 인스턴스별로 갖는다(전역 슬롯 폐지).
 *   ② renderHomeTodos(inst) 가 inst.iid 의 박스만 렌더하고 제목은 widgetCardTitle(inst,…).
 *   ③ 핸들러(add/toggle/remove/setDue/dueEditor)가 iid 를 첫 인자로 IPC 를 친다(box-first).
 *   ④ applyTodoResult 가 응답의 box 가 그 인스턴스일 때만 반영(엉뚱한 박스 덮어쓰기 방지).
 *   ⑤ getUiState.todoBoxes 를 각 인스턴스 wstate[iid].todos 로 분배한다.
 *   ⑥ 공유 집계(요약·브리핑·마감 감시)가 전 박스를 합산한다(전역 store.todos 가정 잔존 0).
 *   ⑦ 6조합·반응형 배선 유지(hw-card + hw-cols hw-body — 기존 계약 불변).
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const APP_SRC = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const PRELOAD_SRC = fs.readFileSync(path.join(ROOT, 'electron', 'preload.js'), 'utf8');

/** 함수 본문 근사 추출(정적 배선 검사용) — 이름부터 지정 길이만큼. */
function fnBody(name, len) {
  const start = APP_SRC.indexOf('function ' + name + '(');
  assert.ok(start >= 0, name + ' 함수 존재');
  return APP_SRC.slice(start, start + (len || 1400));
}
/** 주석 제거 소스(전역 슬롯 잔존 검사에서 '폐지'라고 적은 주석에 걸리지 않게). */
function codeOnly(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/* ───── ① 인스턴스별 상태 — 전역 store.todos/입력/알림 슬롯 폐지 ───── */

test('할 일 인스턴스화 — makeWState(todos) 가 목록·입력·마감·알림을 인스턴스별로 갖는다', () => {
  const ws = APP_SRC.slice(APP_SRC.indexOf("if (type === 'todos') {"),
    APP_SRC.indexOf("if (type === 'todos') {") + 900);
  for (const key of ['todos:', 'todoInput:', 'todoAdding:', 'busyTodos:', 'todoDueInput:', 'todoDueEditId:', 'todoDueEditInput:', 'notifiedDue:']) {
    assert.ok(ws.includes(key), 'makeWState(todos) 에 ' + key + ' 인스턴스 슬롯');
  }
});

test('할 일 인스턴스화 — 전역 store.todos/입력/알림 슬롯이 코드에서 사라졌다', () => {
  const code = codeOnly(APP_SRC);
  for (const bad of ['store.todos', 'store.todoInput', 'store.todoAdding', 'store.busyTodos',
    'store.todoDueInput', 'store.todoDueEditId', 'store.todoDueEditInput', 'store.notifiedDue']) {
    assert.ok(!code.includes(bad), '전역 슬롯 잔존 금지: ' + bad);
  }
});

/* ───── ② renderHomeTodos(inst) — 자기 박스만 + 표시명 ───── */

test('할 일 인스턴스화 — renderHomeTodos(inst) 가 inst.iid 의 박스만 렌더', () => {
  const b = fnBody('renderHomeTodos', 4400);
  assert.ok(/function renderHomeTodos\(inst\)/.test(APP_SRC), 'inst 를 받는다');
  assert.ok(/var iid = inst && inst\.iid;[\s\S]{0,60}var st = wstate\(iid\);/.test(b), 'iid → wstate(iid) 로 자기 상태');
  assert.ok(/var todos = Array\.isArray\(st\.todos\)/.test(b), '목록은 st.todos(인스턴스별)');
  assert.ok(b.includes("widgetCardTitle(inst, '할 일')"), '제목은 표시명(widgetCardTitle)');
  // 편집기 상태·추가 폼 표시가 인스턴스 st 기준
  assert.ok(/if \(st\.todoDueEditId\)/.test(b), '마감 편집기 표시는 st.todoDueEditId');
  assert.ok(/if \(st\.todoAdding\)/.test(b), '추가 폼 표시는 st.todoAdding');
});

/* ───── ③ 핸들러 box-first + ④ box 가드 ───── */

test('할 일 인스턴스화 — 핸들러가 iid 를 첫 인자로 box-first IPC 를 친다', () => {
  assert.ok(/async function onAddTodo\(iid\)/.test(APP_SRC), 'onAddTodo(iid)');
  assert.ok(/async function onToggleTodo\(iid, id, done\)/.test(APP_SRC), 'onToggleTodo(iid,…)');
  assert.ok(/async function onRemoveTodo\(iid, id\)/.test(APP_SRC), 'onRemoveTodo(iid,…)');
  assert.ok(/async function onSetTodoDue\(iid, id, dueAt\)/.test(APP_SRC), 'onSetTodoDue(iid,…)');
  assert.ok(/function openTodoDueEditor\(iid, t\)/.test(APP_SRC), 'openTodoDueEditor(iid,…)');
  assert.ok(/function renderTodoDueEditor\(iid, t\)/.test(APP_SRC), 'renderTodoDueEditor(iid,…)');
  // 실제 IPC 호출의 첫 인자가 iid(박스)
  assert.ok(/ipc\('addTodo', iid,/.test(APP_SRC), "ipc('addTodo', iid, …)");
  assert.ok(/ipc\('toggleTodo', iid,/.test(APP_SRC), "ipc('toggleTodo', iid, …)");
  assert.ok(/ipc\('removeTodo', iid,/.test(APP_SRC), "ipc('removeTodo', iid, …)");
  assert.ok(/ipc\('setTodoDue', iid,/.test(APP_SRC), "ipc('setTodoDue', iid, …)");
});

test('할 일 인스턴스화 — preload 표면도 box-first(box,text/id,…)', () => {
  assert.ok(/addTodo: \(box, text, dueAt\)/.test(PRELOAD_SRC), 'preload addTodo(box,…)');
  assert.ok(/toggleTodo: \(box, id, done\)/.test(PRELOAD_SRC), 'preload toggleTodo(box,…)');
  assert.ok(/removeTodo: \(box, id\)/.test(PRELOAD_SRC), 'preload removeTodo(box,…)');
  assert.ok(/setTodoDue: \(box, id, dueAt\)/.test(PRELOAD_SRC), 'preload setTodoDue(box,…)');
});

test('할 일 인스턴스화 — applyTodoResult 는 응답 box 가 그 인스턴스일 때만 반영', () => {
  const b = fnBody('applyTodoResult', 320);
  assert.ok(/function applyTodoResult\(iid, res\)/.test(APP_SRC), 'applyTodoResult(iid,res)');
  assert.ok(/if \(res\.box && res\.box !== iid\) return false;/.test(b), 'box 불일치면 무시(다른 박스 덮어쓰기 방지)');
  assert.ok(/wstate\(iid\)\.todos = res\.todos;/.test(b), '반영은 그 인스턴스 wstate 로');
});

/* ───── ⑤ getUiState 분배 ───── */

test('할 일 인스턴스화 — getUiState.todoBoxes 를 각 인스턴스 wstate 로 분배', () => {
  assert.ok(/function applyTodoBoxes\(input\)/.test(APP_SRC), 'todoBoxes 방어 적재기');
  assert.ok(/store\._todoBoxes = applyTodoBoxes\(ok \? res\.todoBoxes : null\);/.test(APP_SRC), 'getUiState 에서 todoBoxes 보존');
  assert.ok(/distributeTodoBoxes\(\);/.test(APP_SRC), '분배 호출');
  const d = fnBody('distributeTodoBoxes', 500);
  assert.ok(/widgetsOfType\('todos'\)/.test(d), '배치된 todo 위젯 순회');
  assert.ok(/st\.todos = Array\.isArray\(boxes\[w\.iid\]\)/.test(d), '박스 데이터를 wstate.todos 로');
  // wstate 최초 생성 시 시드(프리셋 전환으로 나중에 붙는 위젯도 자기 박스 데이터)
  assert.ok(/type === 'todos' && store\._todoBoxes && Array\.isArray\(store\._todoBoxes\[iid\]\)/.test(APP_SRC),
    'wstate 생성 시 보존된 박스로 시드');
});

/* ───── ⑥ 공유 집계 — 전 박스 합산 ───── */

test('할 일 인스턴스화 — 요약·브리핑이 전 박스를 합산(openTodoCount)', () => {
  assert.ok(/function openTodoCount\(\)/.test(APP_SRC), 'openTodoCount 합산 헬퍼');
  assert.ok(/function allTodos\(\)/.test(APP_SRC) && /function allTodoBoxes\(\)/.test(APP_SRC), '전 박스 순회 헬퍼');
  // 요약 지표·정적 브리핑이 전역 대신 합산 사용
  const sum = fnBody('renderHomeSummary', 200);
  assert.ok(/var todosOpen = openTodoCount\(\);/.test(sum), '요약 지표: 전 박스 합산');
  const brief = fnBody('staticBriefingLine', 300);
  assert.ok(/var todosOpen = openTodoCount\(\);/.test(brief), '브리핑: 전 박스 합산');
});

test('할 일 인스턴스화 — 마감 감시가 전 박스 순회 + 인스턴스별 dedupe', () => {
  const t = fnBody('tickTodoDue', 1200);
  assert.ok(/var boxes = allTodoBoxes\(\);/.test(t), '전 박스 순회');
  assert.ok(/var st = wstate\(iid\);/.test(t) && /st\.notifiedDue\[t\.id\]/.test(t), '알림 dedupe 는 인스턴스별');
  assert.ok(/sig\.push\(iid \+ ':' \+ t\.id/.test(t), '시그니처에 iid 병기(박스별 상태 반영)');
});

test('할 일 인스턴스화 — 라이브 갱신 보류가 전 박스 편집 여부를 OR 합산', () => {
  assert.ok(/function anyTodoEditing\(\)/.test(APP_SRC), 'anyTodoEditing 집계 헬퍼');
  const a = fnBody('anyTodoEditing', 300);
  assert.ok(/widgetsOfType\('todos'\)\.some/.test(a), '어느 박스든 편집 중이면 true');
  // 두 보류 게이트가 헬퍼를 쓴다(전역 store.todoAdding 잔존 금지는 위 슬롯 테스트가 커버)
  assert.ok(/anyTodoEditing\(\) \|\| store\._scratchEditing/.test(APP_SRC), '메일 자동갱신 게이트');
  assert.ok(/editing:\s*anyTodoEditing\(\),/.test(APP_SRC), 'coalesce deferred 게이트');
});

/* ───── ⑦ 6조합·반응형 배선 유지 ───── */

test('할 일 인스턴스화 — 6조합 배선 유지(hw-card + hw-cols hw-body)', () => {
  const b = fnBody('renderHomeTodos', 3200);
  assert.ok(/cls:\s*'hw-card'/.test(b), '카드에 hw-card');
  assert.ok(/hw-cols hw-body/.test(b), '목록에 hw-cols hw-body(위젯 폭 반응 다열)');
});
