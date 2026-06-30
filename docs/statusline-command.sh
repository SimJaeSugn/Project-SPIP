#!/bin/sh
# Claude Code 상태바 스크립트 (jq 비의존 · Python 사용 · ANSI 색상 + 유니코드 게이지)
#
# 표시 항목:
#   ◆ 모델명
#   │ ctx ████░░░░ X%        ← 컨텍스트 윈도우 사용률 게이지 (색상: 녹/황/적)
#   │ ↓45k ↑3k               ← 세션 누적 토큰 (transcript 파싱 or cost.total_cost_usd)
#   │ 5h ███░░░ 32%  7d █░░░░░ 15%  ← 구독 한도 게이지 (구독자만)
#
# 색상 구간: 0~50% 녹색, 50~80% 노랑, 80%+ 빨강
python -c "
import sys, json, os, subprocess

# Windows(cp949 등) 환경 인코딩 처리: UTF-8 강제
#  - stdout: 유니코드 게이지(█/░) 출력 시 크래시 방지
#  - stdin : 한글 경로(workspace.current_dir)가 깨져 isdir/git 인식 실패하는 것 방지
try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
except Exception:
    pass
try:
    sys.stdin.reconfigure(encoding='utf-8')
except Exception:
    pass

# ANSI 색상 코드
RESET  = '\033[0m'
GREEN  = '\033[32m'
YELLOW = '\033[33m'
RED    = '\033[31m'
CYAN   = '\033[36m'
BOLD   = '\033[1m'
DIM    = '\033[2m'
SEP    = DIM + ' │ ' + RESET   # 구분자: │

def color_pct(p):
    if p is None: return ''
    if p >= 80: return RED
    if p >= 50: return YELLOW
    return GREEN

def gauge(p, width=8):
    '''유니코드 블록 게이지: █ (U+2588) / ░ (U+2591)'''
    if p is None: return ''
    filled = max(0, min(width, int(round(p / 100.0 * width))))
    bar = '█' * filled + '░' * (width - filled)
    c = color_pct(p)
    return '%s%s%s' % (c, bar, RESET)

def fmt_k(n):
    '''숫자를 간결하게: 1234567 → 1.2M, 45678 → 46k, 999 → 999'''
    if n is None: return '?'
    if n >= 1_000_000: return '%.1fM' % (n / 1_000_000)
    if n >= 1_000:     return '%.0fk' % (n / 1_000)
    return str(n)

try:
    d = json.load(sys.stdin)
except Exception:
    print('Claude Code'); sys.exit(0)

model = (d.get('model') or {}).get('display_name') or 'Unknown'
cw    = d.get('context_window') or {}
size  = cw.get('context_window_size')
pct   = cw.get('used_percentage')

# ── 0. 프로젝트 폴더명 + git 상태 ──────────────────────────────
# JSON 소스: workspace.current_dir > workspace.project_dir > cwd
ws       = d.get('workspace') or {}
# 주의: 셸 더블쿼트 안이라 리터럴 백슬래시/따옴표 사용 금지.
# chr(92)=백슬래시 로 우회하여 경로 구분자를 슬래시로 통일 후 끝 슬래시 제거.
work_dir = (ws.get('current_dir') or ws.get('project_dir') or d.get('cwd') or '').replace(chr(92), '/').rstrip('/')
folder_name = os.path.basename(work_dir) if work_dir else ''

folder_str = (CYAN + folder_name + RESET) if folder_name else None

git_str = None
if work_dir and os.path.isdir(work_dir):
    try:
        branch = subprocess.check_output(
            ['git', 'rev-parse', '--abbrev-ref', 'HEAD'],
            cwd=work_dir, stderr=subprocess.DEVNULL, timeout=2
        ).decode('utf-8', errors='replace').strip()
        dirty_out = subprocess.check_output(
            ['git', 'status', '--porcelain'],
            cwd=work_dir, stderr=subprocess.DEVNULL, timeout=2
        ).decode('utf-8', errors='replace')
        changed = len([l for l in dirty_out.splitlines() if l.strip()])
        if changed:
            # dirty: 노란색 + 변경 파일 수 (±N 형식)
            git_str = YELLOW + '⎇ ' + branch + ' ±' + str(changed) + RESET
        else:
            # clean: 초록색
            git_str = GREEN + '⎇ ' + branch + RESET
    except Exception:
        pass   # git 없거나 저장소 아니면 조용히 생략

# ── 1. 컨텍스트 윈도우 사용량 ──────────────────────────────────
# current_usage: 마지막 API 응답 기준 현재 컨텍스트 in/out 토큰
u = cw.get('current_usage') or {}
ctx_used = None
ctx_out  = None   # current_usage.output_tokens (현재 컨텍스트 출력)
if u:
    ctx_used = ((u.get('input_tokens') or 0)
                + (u.get('cache_creation_input_tokens') or 0)
                + (u.get('cache_read_input_tokens') or 0))
    ctx_out  = u.get('output_tokens') or 0
if ctx_used is None:
    # current_usage 없을 때 fallback (첫 응답 이전)
    ctx_used = cw.get('total_input_tokens')

ctx_part = None
if ctx_used is not None and size:
    p = pct if pct is not None else ctx_used / size * 100.0
    c = color_pct(p)
    # ctx_out 은 current_usage 가 있을 때만 표시 (첫 응답 이후)
    if ctx_out is not None:
        detail = ' (↓%s ↑%s)' % (fmt_k(ctx_used), fmt_k(ctx_out))
    else:
        detail = ''
    ctx_part = 'ctx %s %s%.0f%%%s%s' % (gauge(p, 8), c, p, RESET, detail)

# ── 2. 세션 누적 토큰/비용 ─────────────────────────────────────
session_str = None

# 1순위: cost.total_cost_usd
cost = d.get('cost') or {}
total_cost = cost.get('total_cost_usd')
if total_cost is not None:
    session_str = '⇩\$%.4f' % total_cost   # ⇩$0.0123

# 2순위: transcript JSONL 파싱
if session_str is None:
    transcript_path = d.get('transcript_path') or ''
    if transcript_path and os.path.exists(transcript_path):
        cum_in = cum_out = 0
        try:
            with open(transcript_path, 'r', encoding='utf-8', errors='ignore') as f:
                for line in f:
                    line = line.strip()
                    if not line: continue
                    try:
                        entry = json.loads(line)
                    except Exception:
                        continue
                    usage = (entry.get('usage')
                             or (entry.get('message') or {}).get('usage')
                             or {})
                    cum_in  += ((usage.get('input_tokens') or 0)
                                + (usage.get('cache_creation_input_tokens') or 0)
                                + (usage.get('cache_read_input_tokens') or 0))
                    cum_out += (usage.get('output_tokens') or 0)
        except Exception:
            pass
        if cum_in or cum_out:
            # ↓ 입력  ↑ 출력
            session_str = '↓%s ↑%s' % (fmt_k(cum_in), fmt_k(cum_out))

# ── 3. 구독 한도 게이지 (rate_limits) ─────────────────────────
rl = d.get('rate_limits') or {}
fh = rl.get('five_hour') or {}
sd = rl.get('seven_day') or {}
rate_parts = []
if fh.get('used_percentage') is not None:
    fp = fh['used_percentage']
    rate_parts.append('5h %s%s%.0f%%%s' % (gauge(fp, 6), color_pct(fp), fp, RESET))
if sd.get('used_percentage') is not None:
    sp = sd['used_percentage']
    rate_parts.append('7d %s%s%.0f%%%s' % (gauge(sp, 6), color_pct(sp), sp, RESET))
rate_str = '  '.join(rate_parts) if rate_parts else None

# ── 출력 조합 ──────────────────────────────────────────────────
# 1줄: ◆ 모델명 │ 폴더명 ⎇ main ±3
# 2줄: ctx ████░░░░ 6% (↓12k ↑3k) │ ↓45k ↑8k │ 5h ███░░░ 32%  7d █░░░░░ 15%

# 첫째 줄: 모델명 + 폴더/git
line1_parts = [BOLD + '◆ ' + model + RESET]
loc_parts = []
if folder_str: loc_parts.append(folder_str)
if git_str:    loc_parts.append(git_str)
if loc_parts:  line1_parts.append(' '.join(loc_parts))

# 둘째 줄: ctx 사용률 + 누적 토큰 + 구독 한도
line2_parts = []
if ctx_part:    line2_parts.append(ctx_part)
if session_str: line2_parts.append(session_str)
if rate_str:    line2_parts.append(rate_str)

line1 = SEP.join(line1_parts)
if line2_parts:
    line2 = SEP.join(line2_parts)
    sys.stdout.write(line1 + '\n' + line2 + '\n')
else:
    sys.stdout.write(line1 + '\n')
"
