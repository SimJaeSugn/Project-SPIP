'use strict';

// Claude Code 로컬 토큰 사용량 집계 모듈.
//
// Claude Code(CLI)는 세션 트랜스크립트를 다음 경로의 JSONL 파일로 남긴다:
//   <homeDir>/.claude/projects/<encoded-project>/<session>.jsonl
//
// assistant 메시지 라인의 실제 스키마(검증 완료):
//   {
//     "type": "assistant",
//     "requestId": "req_...",
//     "timestamp": "2026-06-24T00:12:44.069Z",   // ISO, top-level
//     "message": {
//       "model": "claude-opus-4-8",
//       "id": "msg_...",
//       "usage": {
//         "input_tokens": N,
//         "output_tokens": N,
//         "cache_creation_input_tokens": N,
//         "cache_read_input_tokens": N
//       }
//     }
//   }
//
// 같은 usage 레코드가 여러 파일/라인에 중복 기록되므로(실측: 1011줄 중 533줄 중복),
// (message.id, requestId) 키로 dedupe 한다.
//
// 보안/안전:
// - 읽기 전용. 메시지 본문(content)은 절대 노출하지 않고 "숫자"와 "모델명"만 집계.
// - 작업량 상한(MAX_FILES / MAX_FILE_BYTES / MAX_LINE_LEN)을 두고 초과분은 skip.
//   skip 사실은 logger.warn 로 남긴다(무음 절단 금지).
// - 라인/파일 단위 오류는 격리(깨진 JSON은 그 줄만 skip). 손상 입력에 throw 하지 않음.
// - 수치 필드는 유한·음수 아님만 채택, 모델명 길이는 클램프.
// - homeDir/.claude/projects 하위만 읽는다.

const fsDefault = require('fs');
const path = require('path');
const os = require('os');

// 작업량 상한 상수.
const MAX_FILES = 2000; // 스캔할 .jsonl 파일 최대 개수
const MAX_FILE_BYTES = 64 * 1024 * 1024; // 64MB 초과 파일은 통째로 skip
const MAX_LINE_LEN = 4 * 1024 * 1024; // 4MB 초과 라인은 skip
const MAX_MODELS = 50; // byModel 결과 상한
const MAX_MODEL_NAME_LEN = 120; // 모델명 길이 클램프

// daily 시계열 윈도우(일 수) 기본·클램프 범위.
const DEFAULT_DAYS = 30;
const MIN_DAYS = 1;
const MAX_DAYS = 365;

const NOOP_LOGGER = { warn() {} };

// 유한·음수 아닌 정수만 채택, 그 외 0.
function toCount(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

// 모델명 정규화: 문자열·트림·길이 클램프, 비정상은 'unknown'.
function clampModel(v) {
  if (typeof v !== 'string') return 'unknown';
  const s = v.trim();
  if (!s) return 'unknown';
  return s.length > MAX_MODEL_NAME_LEN ? s.slice(0, MAX_MODEL_NAME_LEN) : s;
}

function emptyBucket() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreateTokens: 0,
    cacheReadTokens: 0,
    totalTokens: 0,
    messages: 0,
  };
}

// 한 레코드를 버킷에 누적.
function addToBucket(bucket, rec) {
  bucket.inputTokens += rec.inputTokens;
  bucket.outputTokens += rec.outputTokens;
  bucket.cacheCreateTokens += rec.cacheCreateTokens;
  bucket.cacheReadTokens += rec.cacheReadTokens;
  bucket.totalTokens += rec.totalTokens;
  bucket.messages += 1;
}

// 로컬 기준 'YYYY-MM-DD' 키 (오늘 판정용).
function localDayKey(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// days 옵션 정규화: 유한 정수만, [MIN_DAYS, MAX_DAYS] 로 클램프. 비정상은 기본값.
function clampDays(v) {
  if (v === undefined || v === null) return DEFAULT_DAYS;
  const n = Number(v);
  if (!Number.isFinite(n)) return DEFAULT_DAYS;
  const i = Math.floor(n);
  if (i < MIN_DAYS) return MIN_DAYS;
  if (i > MAX_DAYS) return MAX_DAYS;
  return i;
}

// now(로컬) 기준으로 끝나는 days일치 일별 시계열 골격을 생성.
// oldest→newest, 각 항목 { date, totalTokens, inputTokens, outputTokens, messages }.
// 로컬 캘린더 일자 단위로 하루씩 거슬러 올라가며 빈 버킷을 채운다(연속 축 보장).
// dayKey → 항목 참조 맵도 함께 반환해 누적 시 O(1) 조회.
function buildDailyScaffold(nowMs, days) {
  const arr = new Array(days);
  const byKey = new Map();
  // 로컬 자정 기준 날짜를 만들기 위해 now 의 연/월/일만 사용.
  const base = new Date(nowMs);
  for (let i = 0; i < days; i++) {
    // (days-1-i) 일 전 → 가장 오래된 날부터 채워 oldest→newest.
    const offset = days - 1 - i;
    const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() - offset);
    const key = localDayKey(d);
    const entry = {
      date: key,
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      messages: 0,
    };
    arr[i] = entry;
    byKey.set(key, entry);
  }
  return { arr, byKey };
}

// 파싱된 JSON 객체에서 usage 레코드를 추출. 대상 아니면 null.
function extractRecord(obj) {
  if (!obj || typeof obj !== 'object') return null;
  if (obj.type !== 'assistant') return null;
  const message = obj.message;
  if (!message || typeof message !== 'object') return null;
  const usage = message.usage;
  if (!usage || typeof usage !== 'object') return null;

  const inputTokens = toCount(usage.input_tokens);
  const outputTokens = toCount(usage.output_tokens);
  const cacheCreateTokens = toCount(usage.cache_creation_input_tokens);
  const cacheReadTokens = toCount(usage.cache_read_input_tokens);
  const totalTokens = inputTokens + outputTokens + cacheCreateTokens + cacheReadTokens;

  // dedupe 키: message.id + requestId. 둘 다 없으면 dedupe 불가로 null 키.
  const idPart = typeof message.id === 'string' ? message.id : '';
  const reqPart = typeof obj.requestId === 'string' ? obj.requestId : '';
  const dedupeKey = idPart || reqPart ? `${idPart}|${reqPart}` : null;

  // timestamp(ISO) → ms. 유효하지 않으면 null.
  let tsMs = null;
  let tsIso = null;
  if (typeof obj.timestamp === 'string') {
    const t = Date.parse(obj.timestamp);
    if (Number.isFinite(t)) {
      tsMs = t;
      tsIso = obj.timestamp;
    }
  }

  return {
    model: clampModel(message.model),
    inputTokens,
    outputTokens,
    cacheCreateTokens,
    cacheReadTokens,
    totalTokens,
    dedupeKey,
    tsMs,
    tsIso,
  };
}

// 디렉토리에서 .jsonl 파일 경로 목록을 (정렬·상한 적용) 수집.
function collectJsonlFiles(fs, projectsDir, logger) {
  const files = [];
  let projects;
  try {
    projects = fs.readdirSync(projectsDir, { withFileTypes: true });
  } catch (err) {
    return files; // 디렉토리 없음/접근 불가 → 빈 목록
  }

  for (const ent of projects) {
    if (files.length >= MAX_FILES) break;
    let isDir = false;
    try {
      isDir = ent.isDirectory();
    } catch (_) {
      isDir = false;
    }
    if (!isDir) continue;
    const subDir = path.join(projectsDir, ent.name);
    let entries;
    try {
      entries = fs.readdirSync(subDir, { withFileTypes: true });
    } catch (err) {
      logger.warn(`claudeUsage: 하위 디렉토리 읽기 실패 skip: ${subDir}`);
      continue;
    }
    for (const f of entries) {
      if (files.length >= MAX_FILES) {
        logger.warn(`claudeUsage: 파일 수 상한(${MAX_FILES}) 초과로 이후 파일 skip`);
        break;
      }
      let isFile = false;
      try {
        isFile = f.isFile();
      } catch (_) {
        isFile = false;
      }
      if (!isFile) continue;
      if (!f.name.endsWith('.jsonl')) continue;
      files.push(path.join(subDir, f.name));
    }
  }
  return files;
}

// 단일 파일을 처리: dedupe 셋에 추가하며 각 신규 레코드를 onRecord 콜백으로 흘림.
function processFile(fs, filePath, seen, onRecord, logger) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch (err) {
    logger.warn(`claudeUsage: stat 실패 skip: ${filePath}`);
    return;
  }
  if (stat.size > MAX_FILE_BYTES) {
    logger.warn(
      `claudeUsage: 파일 용량 상한(${MAX_FILE_BYTES}B) 초과로 skip: ${filePath} (${stat.size}B)`
    );
    return;
  }

  let content;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    logger.warn(`claudeUsage: 파일 읽기 실패 skip: ${filePath}`);
    return;
  }

  const lines = content.split('\n');
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.length > MAX_LINE_LEN) {
      logger.warn(
        `claudeUsage: 라인 길이 상한(${MAX_LINE_LEN}) 초과로 skip: ${filePath}`
      );
      continue;
    }
    let obj;
    try {
      obj = JSON.parse(line);
    } catch (err) {
      continue; // 깨진 JSON 라인은 조용히 skip(흔함)
    }
    const rec = extractRecord(obj);
    if (!rec) continue;

    // dedupe: 키가 있고 이미 본 레코드면 skip.
    if (rec.dedupeKey !== null) {
      if (seen.has(rec.dedupeKey)) continue;
      seen.add(rec.dedupeKey);
    }
    onRecord(rec);
  }
}

// 메인 진입점.
// opts: { homeDir?, now?, fs?, logger? }
//   homeDir: 기본 os.homedir()
//   now: ms(number) | Date | () => (ms|Date). 기본 Date.now()
//   fs: 주입 가능한 fs 구현(테스트용). 기본 node:fs
//   logger: { warn(msg) }. 기본 무음
function summarizeClaudeUsage(opts = {}) {
  const fs = opts.fs || fsDefault;
  const logger = opts.logger || NOOP_LOGGER;
  const homeDir = opts.homeDir || os.homedir();

  // now 정규화 → ms.
  let nowMs;
  let nowVal = opts.now;
  if (typeof nowVal === 'function') nowVal = nowVal();
  if (nowVal instanceof Date) nowMs = nowVal.getTime();
  else if (typeof nowVal === 'number' && Number.isFinite(nowVal)) nowMs = nowVal;
  else nowMs = Date.now();
  const todayKey = localDayKey(new Date(nowMs));

  // daily 시계열 윈도우(일 수)와 골격 생성.
  const days = clampDays(opts.days);
  const { arr: daily, byKey: dailyByKey } = buildDailyScaffold(nowMs, days);

  const projectsDir = path.join(homeDir, '.claude', 'projects');

  // .claude 디렉토리 자체 존재 여부 → available.
  let available = false;
  try {
    available = fs.existsSync(path.join(homeDir, '.claude'));
  } catch (_) {
    available = false;
  }

  const totals = emptyBucket();
  const today = emptyBucket();
  const byModelMap = new Map(); // model → bucket
  let lastMs = null;
  let lastIso = null;
  let scannedFiles = 0;

  if (available) {
    const files = collectJsonlFiles(fs, projectsDir, logger);
    const seen = new Set();

    const onRecord = (rec) => {
      addToBucket(totals, rec);

      // 모델별.
      let mb = byModelMap.get(rec.model);
      if (!mb) {
        mb = emptyBucket();
        byModelMap.set(rec.model, mb);
      }
      addToBucket(mb, rec);

      // 오늘(로컬 일자) 필터.
      if (rec.tsMs !== null) {
        const dayKey = localDayKey(new Date(rec.tsMs));
        if (dayKey === todayKey) {
          addToBucket(today, rec);
        }
        // daily 윈도우 안에 드는 날이면 해당 버킷에 누적(윈도우 밖은 무시).
        const dEntry = dailyByKey.get(dayKey);
        if (dEntry) {
          dEntry.totalTokens += rec.totalTokens;
          dEntry.inputTokens += rec.inputTokens;
          dEntry.outputTokens += rec.outputTokens;
          dEntry.messages += 1;
        }
        if (lastMs === null || rec.tsMs > lastMs) {
          lastMs = rec.tsMs;
          lastIso = rec.tsIso;
        }
      }
    };

    for (const filePath of files) {
      processFile(fs, filePath, seen, onRecord, logger);
      scannedFiles += 1;
    }
  }

  // byModel: 총량 내림차순 정렬 + 상한.
  const byModel = Array.from(byModelMap.entries())
    .map(([model, b]) => ({ model, totalTokens: b.totalTokens, messages: b.messages }))
    .sort((a, b) => b.totalTokens - a.totalTokens || b.messages - a.messages)
    .slice(0, MAX_MODELS);

  return {
    available,
    totals,
    today,
    daily,
    byModel,
    lastAt: lastIso,
    scannedFiles,
  };
}

module.exports = {
  summarizeClaudeUsage,
  // 테스트/재사용을 위해 상수와 내부 헬퍼 일부 노출.
  MAX_FILES,
  MAX_FILE_BYTES,
  MAX_LINE_LEN,
  MAX_MODELS,
  MAX_MODEL_NAME_LEN,
  DEFAULT_DAYS,
  MIN_DAYS,
  MAX_DAYS,
};
