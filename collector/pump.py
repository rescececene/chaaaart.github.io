"""펌핑 후보 — 업비트 원화 전 종목(시총·거래대금과 상관없이)의 '3일(72시간) 안 펌핑' 가능성 점수 · 예상 % · 근거 · 위험 ·
과거 검증 · 실제 신호 기록

    python collector/pump.py                         # 매 실행(표준 라이브러리만): 시간봉 갱신 → 점수 → pump.json · pump_log.json
    python collector/pump.py --offline               # 받지 않고 저장된 봉으로만 (시험)
    python collector/pump.py --train                 # 하루 1번(numpy·pandas·scikit-learn·lightgbm): 워크포워드 검증 + 최종 학습
    python collector/pump.py --train --if-stale 20   # 20시간 안에 학습했으면 numpy 없이 바로 끝 (Actions 용)

정의 (신호 시점 가격에 산다고 볼 때)
  펌핑 = 다음 72시간 안 최고가가 +15% 이상 · 급락 = 다음 72시간 안 최저가가 −15% 이하.
  업비트 원화 코인 2024-03~2026-10 기준선: 펌핑 10.6% · 급락 6.2% · 72시간 최고 상승폭 중앙값 +4.1% (pump_stats.json 의 base 가 최신 값).
  +10% 는 기준선 20%(너무 흔함), +20% 는 6%(표본이 적음)라 +15% 를 그대로 쓴다.

점수(0~100, '펌핑 가능성 점수') — 하나의 모델에서 점수와 예상 % 가 같이 나온다
  1) 하루 단위 봉(24시간 묶음)으로 만든 특징 45개 → 펌핑 확률 = 로지스틱 회귀(설명용) 와 LightGBM 의 로그 오즈 평균
  2) 점수 = 그 확률이 과거 표본 밖 예측(워크포워드)들 중 몇 % 보다 높은지 (90 = 과거 코인·시점의 상위 10%)
  3) 예상 % = 과거 표본 밖에서 같은 점수였던 자리들이 실제로 낸 결과의 분위 (점수가 높을수록 커지도록 단조 보정)
       '3일 안 최고 +X% 예상' = 72시간 최고 상승폭의 중앙값 · '3일 뒤 예상 +Y%' = 72시간 뒤 종가 수익의 중앙값(점수×변동성 칸)
       '10번 중 8번은 A ~ B' = 같은 칸의 10~90% 범위 · 펌핑·급락 확률 = 같은 점수대의 실제 비율(보정)
  4) 영역 점수(응축·매물대·거래대금·거래량·차트 …) = 로지스틱 부분에서 그 영역이 확률을 올린 정도의 백분위(50 = 보통)
  5) 급락 확률 = 변동성 로지스틱 + 시장 공통 특징을 뺀 LightGBM (로그 오즈 평균) → 같은 칸의 실제 급락 비율로 보정
  6) 후보 점수(0~100, 화면의 큰 숫자·목록 기본 순서·실제 신호 기준) = '펌핑 확률 − W_NET × 급락 확률'이 과거 표본 밖 자리 중
     몇 % 보다 큰지. 펌핑 점수 순 상위는 급락도 잦았다(검증 숫자는 stats.orders · stats.bucketsCand).
     '이럴 땐' 경고: 시장 7일 펌핑 빈도가 지난 분포 상위 1/3 이거나 비트코인 7일 하락이면 화면 맨 위 경고 + 순서 고정(stats.regimes).
  모델 부분은 fit_parts(학습) · predict_parts(검증용 예측) · export_model(JSON) · score_one(매 실행 점수) 로 나뉘어 있어
  새 방법을 끼워 넣으려면 이 넷과 walk_forward 의 비교표(compare_table)만 고치면 된다.

시간 맞추기: 학습은 업비트 일봉(매일 09:00 KST 에 끝나는 24시간 봉) 기준이고, 매 실행에서는 지금 시각에서 24시간씩 거꾸로 묶은
  '굴러가는 하루 봉'으로 같은 특징을 계산한다(최근 21일은 시간봉으로 정확히, 그 전은 일봉으로 — 오래된 봉의 몇 시간 어긋남은 무시).
  그래서 점수는 매시간 바뀌고, 점수 이력은 한 시간에 하나씩 쌓인다.

데이터 (모두 공개 API, 로그인 없음, 정직한 User-Agent, 업비트는 초당 4회 이하·429 면 기다렸다 재시도)
  - 일봉: collect.py 가 같은 실행에서 만든 web/public/data/candles/upbit/*.json (200일). 없거나 오래되면 직접 받는다.
  - 시간봉: 업비트 /v1/candles/minutes/60 — web/public/data/pump_bars.json 에 코인당 약 23일 쌓아 두고, 실행마다 새 봉만(코인당 1건).
    처음엔 코인당 1건(200시간)으로 시작해 남는 요청으로 조금씩 과거를 채운다. (한 실행 요청 상한 MAX_REQ)
    collector/.history 는 예측 엔진이 돌 때만 복원돼서 매 실행 상태는 데이터 캐시(web/public/data)에 둔다.
  - 공지: 업비트 공지 목록 1쪽(api-manager.upbit.com, robots.txt 금지 없음) — 입출금 일시 중단 공지는 근거 줄로만.
  - 위험: 업비트 투자유의·주의 표시(market/all), 상폐·해킹 소식(news_state.json), 상장 30일 미만.

출력
  web/public/data/pump.json        사이트용 — 상위 30개(근거·위험·영역 점수·점수 이력·매물대 요약) + 전 종목 요약
  web/public/data/pump_log.json    실제 신호 기록 — 후보 점수가 SIG_THR 이상으로 올라선 순간(같은 코인 72시간에 한 번) → 72시간 뒤 채점
  web/public/data/pump_stats.json  과거 검증(워크포워드) — --train 이 만든다
  web/public/data/pump_model.json  학습된 계수·나무·대응표 (사이트는 읽지 않음)
  web/public/data/pump_state.json  점수 이력·신호·AI 문장 캐시 (사이트는 읽지 않음)
  web/public/data/pump_bars.json   시간봉 저장소 (사이트는 읽지 않음)
  collector/pump/model.json · stats.json · events.json   저장소에 올려 두는 처음용(캐시가 비었을 때) 모델·검증·공지 이력
"""
import argparse
import bisect
import json
import math
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
DATA = HERE.parent / "web" / "public" / "data"
HIST = HERE / ".history" / "upbit"
BOOT = HERE / "pump"
F_OUT = DATA / "pump.json"
F_LOG = DATA / "pump_log.json"
F_STATS = DATA / "pump_stats.json"
F_MODEL = DATA / "pump_model.json"
F_STATE = DATA / "pump_state.json"
F_BARS = DATA / "pump_bars.json"
KST = timezone(timedelta(hours=9))
DAY, HOUR = 86400, 3600

H_DAYS = 3              # 72시간
PUMP, DUMP = 0.15, -0.15
FEE = 0.001             # 업비트 왕복 수수료 0.05% × 2
MIN_BARS = 60           # 점수를 매기는 최소 하루 봉 수 (그보다 짧으면 '상장 60일 미만'으로 점수 없이 위험 표시)
SIG_THR = 90            # 실제 신호 기록 기준 점수
W_NET = 2.0             # '급락 위험 뺀 순' = 펌핑 확률 − W_NET × 급락 확률 (1·1.5·2 중 선택 구간 성적으로 고름, 보류 구간에서 확인)
SIG_GAP = 72 * HOUR     # 같은 코인은 72시간 안에 다시 신호를 쌓지 않는다 (백테스트의 '첫 신호만'과 같은 규칙)
TOP_N = 30
HIST_H = 14 * 24        # 점수 이력 (시간)
KEEP_H = 560            # 시간봉 보관 (시간) — 정확한 최근 21일 + 이음매 하루 + 여유
K_EXACT = 21            # 시간봉으로 정확히 만드는 최근 하루 봉 수
MAX_REQ = 420           # 한 실행 요청 상한 (업비트)
MAX_ANCHORS = 6         # 한 실행에서 빠진 시각을 채워 계산하는 최대 개수
LOG_KEEP = 400
LIQ_PCT = 0.30          # '거래가 적어요' 칩 = 업비트 원화 20일 거래대금 하위 30% … (순위 정리 담당과 같은 기준)
LIQ_MIN = 1e8           # … 또는 24시간 거래대금 1억 원 미만
LIQ_THIN = 10e8         # 10억 원 미만 = 위험 칸 '높음' — 예상 % 를 실제로 얻기 어려울 수 있음 (호가 공백·미끄러짐)
UA = "chaaaart-pump/1.0 (+https://github.com/rescececene/chaaaart.github.io)"
STABLE = {"USDT", "USDC", "USDE", "USD1", "USDS", "DAI", "PYUSD", "RLUSD", "FDUSD", "TUSD", "BUSD", "USDP", "EURC",
          "USDG", "GUSD", "FRAX", "USDD", "LUSD", "AUSD", "USD0", "USDQ", "EURQ", "USDF", "KRWQ", "UST", "USTC", "XUSD"}

# 특징 묶음 — (키, 화면 이름, 특징들). 앞 5개가 사용자가 말한 영역, 나머지도 모델에 들어간다.
GROUPS = (
    ("energy", "응축된 에너지", ("bbw_pct", "atr_pct", "sq_len")),
    ("profile", "매물대", ("ov15", "ov30", "bel15", "poc", "gap", "vpos")),
    ("value", "거래대금 추세", ("lval1", "lval5", "vr1_20", "vr5_20", "vr20_60", "vslope20", "vrank", "vrank_chg")),
    ("volume", "거래량 패턴", ("spike_max10", "spike_hold", "obv20")),
    ("chart", "차트", ("hi60", "hi120", "lo60", "c_ma20", "ma5_20", "ma20_60", "hl1", "hl2")),
    ("vol", "변동성", ("atrp", "vol20", "bbw", "atr_xs")),
    ("heat", "최근 흐름", ("rsi", "ret1", "ret3", "ret7", "ret14", "ret30", "run30", "dd30")),
    ("own", "이 코인 성향", ("own_mfe60", "own_pump120", "own_pump30", "lage")),
    ("market", "시장 분위기", ("mkt_ret1", "mkt_ret3", "breadth", "mkt_vr", "mkt_pump3", "mkt_atr",
                            "btc_ret1", "btc_ret7", "btc_ret30", "btc_vol20")),
)
FEATS = tuple(f for _, _, fs in GROUPS for f in fs)
GROUP_OF = {f: g for g, _, fs in GROUPS for f in fs}
VOL_FEATS = ("atrp", "vol20", "bbw")
XS_FEATS = ("atr_xs", "vrank", "vrank_chg", "mkt_ret1", "mkt_ret3", "breadth", "mkt_vr", "mkt_pump3", "mkt_atr",
            "btc_ret1", "btc_ret7", "btc_ret30", "btc_vol20", "vr1_rank")
# 늘 계산해 두는 시험용 특징 (모델에 넣을지는 워크포워드로 정한다 — FEATS 에 있어야 쓰인다)
EXTRA = ("range1", "since_surge")
LN = math.log
B_STEP = math.log(1.02)                 # 매물대 가격 칸 = 2% (로그)
K15 = int(math.ceil(math.log(1.15) / B_STEP))
K30 = int(math.ceil(math.log(1.30) / B_STEP))
VP_WIN = 120


def log(msg):
    print(f"{datetime.now().strftime('%H:%M:%S')} [펌핑] {msg}", flush=True)


def iso(ts):
    return datetime.fromtimestamp(int(ts), timezone.utc).isoformat(timespec="seconds")


def kst_label(ts):
    d = datetime.fromtimestamp(int(ts), KST)
    return f"{d.month}/{d.day} {d.hour:02d}:{d.minute:02d}"


def rnd(x, sig=5):
    if x is None or not isinstance(x, (int, float)) or not math.isfinite(x):
        return None
    return float(f"{x:.{sig}g}")


def read_json(path, default=None):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default


def write_json(path, obj):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    tmp.write_text(json.dumps(obj, ensure_ascii=False, separators=(",", ":"), allow_nan=False), encoding="utf-8")
    os.replace(tmp, path)


# ── 요청 (호스트별 간격 · 429 면 기다렸다 재시도) ─────────────────────────────
GAP = {"api.upbit.com": 0.27, "api-manager.upbit.com": 1.2}   # 업비트 시세: 초당 4회 이하
NET = {"n": 0, "fail": 0, "429": 0, "by": {}}
_last = {}


def http_json(url, timeout=10, tries=4):
    host = urllib.parse.urlsplit(url).hostname
    for a in range(tries):
        gap = GAP.get(host, 0.5)
        wait = _last.get(host, 0.0) + gap - time.monotonic()
        if wait > 0:
            time.sleep(wait)
        _last[host] = time.monotonic()
        NET["n"] += 1
        NET["by"][host] = NET["by"].get(host, 0) + 1
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            if e.code == 429 or e.code >= 500:
                NET["429" if e.code == 429 else "fail"] += 1
                ra = e.headers.get("Retry-After") if e.headers else None
                try:
                    pause = float(ra) if ra else 1.5 * (a + 1)
                except ValueError:
                    pause = 1.5 * (a + 1)
                time.sleep(min(10.0, max(1.0, pause)))
                continue
            raise
        except (urllib.error.URLError, TimeoutError, ConnectionError, OSError):
            NET["fail"] += 1
            time.sleep(1.0 + a)
    raise RuntimeError(f"요청 실패: {url}")


# ── 봉 다루기 ─────────────────────────────────────────────────────────────
def agg(rows, prev_c=None):
    """시간봉 묶음 → 하루 봉 (o,h,l,c,v). 거래가 없던 시간은 빠져 있다. 묶음이 비면 직전 종가로 평평한 봉."""
    if not rows:
        return (prev_c, prev_c, prev_c, prev_c, 0.0) if prev_c else None
    o = rows[0][1]
    h = max(r[2] for r in rows)
    lo = min(r[3] for r in rows)
    return (o, h, lo, rows[-1][4], sum(r[5] for r in rows))


def rolling_bars(daily, hourly, cov_from, T, kmax=K_EXACT):
    """지금 시각 T 에서 24시간씩 거꾸로 묶은 하루 봉 [(t,o,h,l,c,v)] (오래된 것부터, 마지막 봉이 T 에 끝난다)
    daily: 끝난 일봉(00:00 UTC 시작), hourly: 끝난 시간봉, cov_from: 시간봉이 빠짐없이 받아진 시작 시각.
    최근 K 개는 시간봉으로 정확히, 그 앞 이음매(T 의 시각만큼 짧은 틈)는 가장 오래된 굴러가는 봉에 붙이고, 더 앞은 일봉.
    시간봉이 하루치도 없으면 (None, 일봉만) — 기준 시각이 오늘 00:00 UTC 로 물러난다."""
    day0 = T - T % DAY
    old = [d for d in daily if d[0] + DAY <= day0]
    if cov_from is None:
        return None, old
    K = min(kmax, int((day0 - cov_from) // DAY))
    if K < 1:
        return None, old
    S = T - K * DAY
    junction = S - S % DAY
    hs = [r for r in hourly if junction <= r[0] < T]
    out = [d for d in daily if d[0] + DAY <= junction]
    prev_c = out[-1][4] if out else (hs[0][1] if hs else None)
    j = 0
    for k in range(K - 1, -1, -1):
        a, b = T - (k + 1) * DAY, T - k * DAY
        lo_t = junction if k == K - 1 else a
        rows = []
        while j < len(hs) and hs[j][0] < b:
            if hs[j][0] >= lo_t:
                rows.append(hs[j])
            j += 1
        bar = agg(rows, prev_c)
        if bar is None:
            continue
        out.append((a,) + bar)
        prev_c = bar[3]
    return T, out


# ── 특징 (표준 라이브러리, 학습·매 실행이 같은 코드를 쓴다) ───────────────────────
def _sorted_window_rank(xs, win, min_n):
    """xs[j] 가 직전 win-1 개(자기 제외) 중 아래에서 몇 % (0 = 가장 낮음). None 은 건너뛴다."""
    out = [None] * len(xs)
    sw = []
    q = []
    for j, x in enumerate(xs):
        if x is not None and len(sw) >= min_n:
            out[j] = bisect.bisect_left(sw, x) / len(sw)
        q.append(x)
        if x is not None:
            bisect.insort(sw, x)
        if len(q) > win - 1:
            y = q.pop(0)
            if y is not None:
                del sw[bisect.bisect_left(sw, y)]
    return out


def _median(xs):
    n = len(xs)
    if not n:
        return None
    s = sorted(xs)
    return s[n // 2] if n % 2 else 0.5 * (s[n // 2 - 1] + s[n // 2])


def outcomes(h, l, c, t=None, i=None):
    """i 에서 산다면 (72시간 최고 상승폭, 최저 하락폭, 24시간 수익, 72시간 수익) — 봉 3개가 이어져 있어야"""
    n = len(c)
    if i + H_DAYS >= n:
        return None
    if t is not None and t[i + H_DAYS] - t[i] != H_DAYS * DAY:
        return None
    c0 = c[i]
    return (max(h[i + 1:i + 1 + H_DAYS]) / c0 - 1.0, min(l[i + 1:i + 1 + H_DAYS]) / c0 - 1.0,
            c[i + 1] / c0 - 1.0, c[i + H_DAYS] / c0 - 1.0)


def series_features(o, h, l, c, v, want=None):
    """하루 봉 한 줄 → {특징: [want 순서의 값]} (+ 횡단면 계산용 _lval5_20, _pump_m3, _code 는 밖에서)
    모든 값은 그 봉 종가까지의 정보만 쓴다. 계산이 안 되면 None."""
    n = len(c)
    if want is None:
        want = list(range(MIN_BARS - 1, n))
    want = [i for i in want if 0 <= i < n]
    F = {f: [] for f in tuple(FEATS) + EXTRA if f not in XS_FEATS}
    F["_lval5_20"] = []
    F["_pump_m3"] = []
    F["_pump7"] = []
    F["_lval20"] = []
    F["_age"] = []
    if not want:
        return F
    val = [v[j] * (h[j] + l[j] + c[j]) / 3.0 for j in range(n)]
    lc = [LN(x) for x in c]
    r = [None] + [lc[j] - lc[j - 1] for j in range(1, n)]
    pc = [0.0] * (n + 1)
    pv = [0.0] * (n + 1)
    ptr = [0.0] * (n + 1)
    tr = [h[0] - l[0]] + [max(h[j] - l[j], abs(h[j] - c[j - 1]), abs(l[j] - c[j - 1])) for j in range(1, n)]
    for j in range(n):
        pc[j + 1] = pc[j] + c[j]
        pv[j + 1] = pv[j] + val[j]
        ptr[j + 1] = ptr[j] + tr[j]

    def mc(i, k):
        return (pc[i + 1] - pc[i + 1 - k]) / k if i + 1 - k >= 0 else None

    def mv(i, k):
        return (pv[i + 1] - pv[i + 1 - k]) / k if i + 1 - k >= 0 else None

    atrp = [((ptr[j + 1] - ptr[j - 13]) / 14.0 / c[j]) if j >= 14 else None for j in range(n)]
    bbw = [None] * n
    for j in range(19, n):
        m = (pc[j + 1] - pc[j - 19]) / 20.0
        s2 = 0.0
        for x in c[j - 19:j + 1]:
            s2 += (x - m) * (x - m)
        bbw[j] = 4.0 * math.sqrt(s2 / 20.0) / m if m > 0 else None
    bbw_pct = _sorted_window_rank(bbw, 120, 59)
    atr_pct = _sorted_window_rank(atrp, 120, 59)
    sq = [0] * n
    run = 0
    for j in range(n):
        bp = bbw_pct[j]
        run = run + 1 if (bp is not None and bp <= 0.25) else 0
        sq[j] = min(run, 60)
    lv = [LN(x) if x > 1.0 else 0.0 for x in val]
    vr1 = [None] * n
    for j in range(19, n):
        m20 = mv(j, 20)
        vr1[j] = lv[j] - LN(m20) if m20 and m20 > 1.0 else None
    obv = [0.0] * n
    for j in range(1, n):
        obv[j] = obv[j - 1] + (val[j] if r[j] > 0 else -val[j] if r[j] < 0 else 0.0)
    au = ad = 0.0
    rsi = [None] * n
    for j in range(1, n):
        u = r[j] if r[j] > 0 else 0.0
        d = -r[j] if r[j] < 0 else 0.0
        au = au + (u - au) / 14.0
        ad = ad + (d - ad) / 14.0
        rsi[j] = 100.0 * au / (au + ad + 1e-12) if j >= 14 else None
    mfe = [None] * n
    for j in range(n - H_DAYS):
        mfe[j] = max(h[j + 1:j + 1 + H_DAYS]) / c[j] - 1.0
    since = [90] * n  # 마지막 급등(고가가 전날 종가보다 +15% 이상)에서 지난 날 (90 상한)
    last_s = None
    for j in range(1, n):
        if h[j] >= 1.15 * c[j - 1]:
            last_s = j
        since[j] = min(90, j - last_s) if last_s is not None else 90
    wset = set(want)
    # 자기 과거 성향: 결과가 확정된 신호(i-3 까지)의 72시간 최고 상승폭
    own_med = {}
    sw, q = [], []
    for i in range(n):
        j = i - H_DAYS
        if j >= 0:
            x = mfe[j]
            q.append(x)
            if x is not None:
                bisect.insort(sw, x)
            if len(q) > 60:
                y = q.pop(0)
                if y is not None:
                    del sw[bisect.bisect_left(sw, y)]
        if i in wset and len(sw) >= 20:
            m = len(sw)
            own_med[i] = sw[m // 2] if m % 2 else 0.5 * (sw[m // 2 - 1] + sw[m // 2])
    pumpflag = [None if x is None else (1.0 if x >= PUMP else 0.0) for x in mfe]
    ppf = [0.0] * (n + 1)
    pcn = [0] * (n + 1)
    for j in range(n):
        ppf[j + 1] = ppf[j] + (pumpflag[j] or 0.0)
        pcn[j + 1] = pcn[j] + (pumpflag[j] is not None)
    # 매물대 (최근 120봉, 2% 로그 칸, 봉 거래대금을 고가~저가 칸에 고르게) — 연속한 i 는 더하고 빼며 굴린다
    lb = [int(math.floor(LN(x) / B_STEP)) for x in l]
    hb = [int(math.floor(LN(x) / B_STEP)) for x in h]
    prof = {}
    tot = 0.0
    last_i = None

    def add(j, sgn):
        nonlocal tot
        k = hb[j] - lb[j] + 1
        per = sgn * val[j] / k
        for b in range(lb[j], hb[j] + 1):
            x = prof.get(b, 0.0) + per
            if sgn < 0 and x <= abs(per) * 1e-9:  # 빼고 남은 부동소수 찌꺼기는 칸째 지운다
                prof.pop(b, None)
            else:
                prof[b] = x
        tot += sgn * val[j]

    for i in want:
        if i < MIN_BARS - 1:
            for f in F:
                F[f].append(None)
            continue
        # 매물대 창 굴리기
        if last_i is not None and i == last_i + 1:
            add(i, 1)
            if i - VP_WIN >= 0:
                add(i - VP_WIN, -1)
        else:
            prof.clear()
            tot = 0.0
            for j in range(max(0, i - VP_WIN + 1), i + 1):
                add(j, 1)
        last_i = i
        ci = c[i]
        g = F
        g["_age"].append(i + 1)
        # 변동성
        g["atrp"].append(atrp[i])
        rr = r[i - 19:i + 1] if i >= 20 else None
        if rr:
            mu = sum(rr) / 20.0
            g["vol20"].append(math.sqrt(sum((x - mu) * (x - mu) for x in rr) / 19.0))
        else:
            g["vol20"].append(None)
        g["bbw"].append(bbw[i])
        # 응축
        g["bbw_pct"].append(bbw_pct[i])
        g["atr_pct"].append(atr_pct[i])
        g["sq_len"].append(float(sq[i]))
        # 매물대
        cb = int(math.floor(lc[i] / B_STEP))
        if tot > 0 and prof:
            up15 = sum(prof.get(b, 0.0) for b in range(cb + 1, cb + 1 + K15))
            up30 = sum(prof.get(b, 0.0) for b in range(cb + 1, cb + 1 + K30))
            dn15 = sum(prof.get(b, 0.0) for b in range(cb - K15, cb))
            keys = [b for b, x in prof.items() if x > tot * 1e-12]
            lo_b, hi_b = min(keys), max(keys)
            pb = max(keys, key=lambda b: prof[b])
            below = sum(x for b, x in prof.items() if b < cb)
            heavy = 1.5 * tot / (hi_b - lo_b + 1)
            gp = 0
            for b in range(cb + 1, cb + 26):
                if prof.get(b, 0.0) >= heavy:
                    break
                gp += 1
            g["ov15"].append(max(0.0, up15 / tot))
            g["ov30"].append(max(0.0, up30 / tot))
            g["bel15"].append(max(0.0, dn15 / tot))
            g["poc"].append((pb - cb) * B_STEP)
            g["gap"].append(gp * B_STEP)
            g["vpos"].append(min(1.0, max(0.0, below / tot)))
        else:
            for f in ("ov15", "ov30", "bel15", "poc", "gap", "vpos"):
                g[f].append(None)
        # 거래대금
        m5, m20, m60 = mv(i, 5), mv(i, 20), mv(i, 60)
        g["lval1"].append(lv[i])
        g["_lval20"].append(LN(m20) if m20 and m20 > 1.0 else 0.0)
        g["lval5"].append(LN(m5) if m5 and m5 > 1.0 else 0.0)
        g["vr1_20"].append(vr1[i])
        g["vr5_20"].append(LN(m5 / m20) if m5 and m20 and m5 > 1.0 and m20 > 1.0 else None)
        g["vr20_60"].append(LN(m20 / m60) if m20 and m60 and m20 > 1.0 and m60 > 1.0 else None)
        sxy = 0.0
        for k in range(20):
            sxy += (k - 9.5) * lv[i - 19 + k]
        g["vslope20"].append(sxy / 665.0)
        j20 = i - 20
        m5p = mv(j20, 5) if j20 >= 4 else None
        g["_lval5_20"].append(LN(m5p) if m5p and m5p > 1.0 else (0.0 if m5p is not None else None))
        # 거래량 패턴
        best, bj = None, None
        for j in range(i - 9, i + 1):
            x = vr1[j]
            if x is not None and (best is None or x > best):
                best, bj = x, j
        g["spike_max10"].append(best)
        g["spike_hold"].append(lc[i] - lc[bj] if bj is not None else None)
        g["obv20"].append((obv[i] - obv[i - 20]) / (m20 * 20.0) if m20 and m20 > 1.0 else None)
        # 차트
        hh60 = max(h[i - 59:i + 1])
        hh120 = max(h[max(0, i - 119):i + 1])
        ll60 = min(l[i - 59:i + 1])
        g["hi60"].append(lc[i] - LN(hh60))
        g["hi120"].append(lc[i] - LN(hh120))
        g["lo60"].append(lc[i] - LN(ll60))
        a5, a20, a60 = mc(i, 5), mc(i, 20), mc(i, 60)
        g["c_ma20"].append(LN(ci / a20))
        g["ma5_20"].append(LN(a5 / a20))
        g["ma20_60"].append(LN(a20 / a60))
        l10 = min(l[i - 9:i + 1])
        l10b = min(l[i - 19:i - 9])
        l10c = min(l[i - 29:i - 19]) if i >= 29 else None
        g["hl1"].append(LN(l10 / l10b))
        g["hl2"].append(LN(l10b / l10c) if l10c else None)
        # 최근 흐름
        g["rsi"].append(rsi[i])
        for k in (1, 3, 7, 14, 30):
            g[f"ret{k}"].append(lc[i] - lc[i - k] if i - k >= 0 else None)
        hh30 = max(h[i - 29:i + 1])
        g["run30"].append(LN(hh30) - lc[i - 30] if i >= 30 else None)
        g["dd30"].append(lc[i] - LN(hh30))
        # 이 코인 성향
        g["own_mfe60"].append(own_med.get(i))
        a0, b0 = max(0, i - H_DAYS - 119), i - H_DAYS + 1
        cnt = pcn[b0] - pcn[a0] if b0 > a0 else 0
        g["own_pump120"].append((ppf[b0] - ppf[a0]) / cnt if cnt >= 30 else None)
        a1 = max(0, i - H_DAYS - 29)
        cnt1 = pcn[b0] - pcn[a1] if b0 > a1 else 0
        g["own_pump30"].append(ppf[b0] - ppf[a1] if cnt1 >= 10 else None)
        g["lage"].append(LN(min(i + 1, 180)))
        if "range1" in g:
            g["range1"].append(LN(h[i] / l[i]) if l[i] > 0 else None)
        if "since_surge" in g:
            g["since_surge"].append(float(since[i]))
        g["_pump_m3"].append(pumpflag[i - H_DAYS] if i - H_DAYS >= 0 else None)
        pf = [pumpflag[j] for j in range(max(0, i - H_DAYS - 6), i - H_DAYS + 1) if pumpflag[j] is not None]
        g["_pump7"].append(sum(pf) / len(pf) if len(pf) >= 4 else None)
    return F


def _pct_ranks(xs):
    """None 이 아닌 값의 평균 순위 백분위 (pandas rank(pct=True) 와 같은 규칙)"""
    idx = [k for k, x in enumerate(xs) if x is not None]
    out = [None] * len(xs)
    if not idx:
        return out
    srt = sorted(idx, key=lambda k: xs[k])
    n = len(srt)
    p = 0
    while p < n:
        q = p
        while q + 1 < n and xs[srt[q + 1]] == xs[srt[p]]:
            q += 1
        rk = (p + q) / 2.0 + 1.0
        for z in range(p, q + 1):
            out[srt[z]] = rk / n
        p = q + 1
    return out


def cross_section(rows, btc_code="KRW-BTC"):
    """같은 시각 코인들의 특징 dict 목록에 횡단면·시장 특징을 채운다 (rows 를 직접 고친다)"""
    if not rows:
        return
    atr = _pct_ranks([x.get("atrp") for x in rows])
    vr1r = _pct_ranks([x.get("vr1_20") for x in rows])
    v20r = _pct_ranks([x.get("_lval20") for x in rows])
    vr = _pct_ranks([x.get("lval5") for x in rows])
    vr20 = _pct_ranks([x.get("_lval5_20") for x in rows])

    def med(key):
        return _median([x[key] for x in rows if x.get(key) is not None])

    above = [x["c_ma20"] > 0 for x in rows if x.get("c_ma20") is not None]
    pm = [x["_pump_m3"] for x in rows if x.get("_pump_m3") is not None]
    p7 = [x["_pump7"] for x in rows if x.get("_pump7") is not None]
    mk = {"mkt_ret1": med("ret1"), "mkt_ret3": med("ret3"), "mkt_vr": med("vr5_20"), "mkt_atr": med("atrp"),
          "breadth": (sum(above) / len(above)) if above else None, "mkt_pump3": (sum(pm) / len(pm)) if pm else None,
          "mkt_pump7": (sum(p7) / len(p7)) if p7 else None}
    btc = next((x for x in rows if x.get("_code") == btc_code), None)
    for k, (src) in (("btc_ret1", "ret1"), ("btc_ret7", "ret7"), ("btc_ret30", "ret30"), ("btc_vol20", "vol20")):
        mk[k] = btc.get(src) if btc else None
    for k, x in enumerate(rows):
        x["atr_xs"] = atr[k]
        x["vr1_rank"] = vr1r[k]
        x["_v20rank"] = v20r[k]
        x["vrank"] = vr[k]
        x["vrank_chg"] = (vr[k] - vr20[k]) if (vr[k] is not None and vr20[k] is not None) else None
        x.update(mk)


# ── 모델 점수 (표준 라이브러리) ─────────────────────────────────────────────
def _sig(z):
    return 1.0 / (1.0 + math.exp(-max(-30.0, min(30.0, z))))


def _logit(p):
    p = min(max(p, 1e-6), 1 - 1e-6)
    return math.log(p / (1 - p))


def _interp(x, xs, ys):
    if x <= xs[0]:
        return ys[0]
    if x >= xs[-1]:
        return ys[-1]
    k = bisect.bisect_right(xs, x)
    x0, x1 = xs[k - 1], xs[k]
    return ys[k - 1] + (ys[k] - ys[k - 1]) * ((x - x0) / (x1 - x0) if x1 > x0 else 0.0)


def lin_parts(lr, x):
    """로지스틱: 표준화 z → 특징별 기여 (로그 오즈)"""
    out = {}
    for k, f in enumerate(lr["feats"]):
        val = x.get(f)
        if val is None:
            z = 0.0
        else:
            val = min(max(val, lr["lo"][k]), lr["hi"][k])
            z = (val - lr["mu"][k]) / lr["sd"][k]
        out[f] = lr["w"][k] * z
    return out


def tree_raw(gb, x):
    """LightGBM 나무 합 (로그 오즈). 빈 값은 학습 때의 중앙값으로 채운다."""
    feats, fill = gb["feats"], gb["fill"]
    xv = [x.get(f) if x.get(f) is not None else fill[k] for k, f in enumerate(feats)]
    s = 0.0
    for tr in gb["trees"]:
        f, th, lft, rgt, val = tr
        nd = 0
        while f[nd] >= 0:
            nd = lft[nd] if xv[f[nd]] <= th[nd] else rgt[nd]
        s += val[nd]
    return s


def score_one(M, x):
    """특징 dict → 점수·예상치·영역 기여"""
    P, D = M["pump"], M["dump"]
    parts = lin_parts(P["lr"], x)
    z_lr = P["lr"]["b"] + sum(parts.values())
    z_gb = tree_raw(P["gb"], x)
    w = P["w_gb"]
    pp = _sig((1 - w) * z_lr + w * z_gb)
    dz_lr = D["lr"]["b"] + sum(lin_parts(D["lr"], x).values())
    dz_gb = tree_raw(D["gb"], x) if D.get("gb") and D.get("w_gb") else 0.0
    pdr = _sig((1 - D["w_gb"]) * dz_lr + D["w_gb"] * dz_gb)
    ref = M["ref"]
    score = 100.0 * _interp(_logit(pp), ref["z"], ref["q"])
    mp = M["map"]
    s = score
    out = {"score": score, "pRaw": pp, "pPump": _interp(s, mp["s"], mp["pump"]),
           "mfe": [_interp(s, mp["s"], mp["mfe10"]), _interp(s, mp["s"], mp["mfe50"]), _interp(s, mp["s"], mp["mfe90"])],
           "pDump": _interp(_logit(pdr), M["dumpCal"]["z"], M["dumpCal"]["p"])}
    # 후보 점수 = 펌핑 확률 − W_NET × 급락 확률 의 과거 백분위 (화면의 큰 숫자 · 기본 순서 · 실제 신호 기준)
    out["net"] = out["pPump"] - M.get("wNet", W_NET) * out["pDump"]
    nr = M.get("netRef")
    out["cand"] = 100.0 * _interp(out["net"], nr["x"], nr["q"]) if nr else score
    # 3일 뒤 수익: 점수 × 변동성 칸
    rb = M["rmap"]
    a = x.get("atrp")
    bi = 0 if a is None else min(len(rb["edges"]), bisect.bisect_right(rb["edges"], a))
    row = rb["rows"][bi]
    out["r72"] = [_interp(s, rb["s"], row["r10"]), _interp(s, rb["s"], row["r50"]), _interp(s, rb["s"], row["r90"])]
    out["r24"] = _interp(s, rb["s"], row["r24"])
    # 영역 점수: 영역 기여의 백분위 (50 = 보통)
    gsum = {}
    for f, cval in parts.items():
        gsum[GROUP_OF[f]] = gsum.get(GROUP_OF[f], 0.0) + cval
    gp = {}
    for g, cval in gsum.items():
        q = M["groupRef"].get(g)
        gp[g] = 100.0 * _interp(cval, q, [k / (len(q) - 1) for k in range(len(q))]) if q else 50.0
    out["parts"] = gp
    out["contrib"] = parts
    return out


# ── 학습·검증 (--train: numpy·pandas·scikit-learn·lightgbm, 하루 1번) ─────────────
# 아래 설정은 선택 구간(2025-01~09)의 표본 밖 성적으로만 골랐다 (잎 7·15·31, 나무 150~500, C 0.01~1, 섞는 비율 0.3~0.7 비교)
LGB_PARAMS = dict(num_leaves=7, n_estimators=300, learning_rate=0.03, min_child_samples=500, subsample=0.7,
                  subsample_freq=1, colsample_bytree=0.7, reg_lambda=5.0, verbose=-1, n_jobs=4)
LR_C = 0.01
W_GB = 0.5            # 펌핑 확률 = (1-W)·로지스틱 + W·LightGBM (로그 오즈)
# 급락 = 변동성 로지스틱 + 시장 공통 특징을 뺀 LightGBM (로그 오즈 평균). 시장 특징까지 넣은 LightGBM 은 '언제' 맞히기에
# 과적합해 시점 전체 AUC 가 0.58 로 떨어졌고, 빼면 최근 구간 0.68·같은 날 0.83 이었다. '급락 위험 뺀 순' 정렬에도 쓴다.
W_GB_DUMP = 0.5
WF_START = "2025-01-01"   # 표본 밖 검증 시작 (그 전 약 9개월은 첫 학습용)
HOLD_FROM = "2025-10-01"  # 특징·설정을 고를 때 보지 않고 남겨 둔 최근 구간
EMBARGO = 4 * DAY         # 학습 끝 ~ 검증 시작 사이 (결과 72시간 + 하루) — 미래 정보가 섞이지 않게
SCORE_BINS = (0, 10, 20, 30, 40, 50, 60, 70, 80, 85, 90, 93, 96, 98, 100)
R_SCORE_BINS = (0, 30, 60, 80, 90, 95, 98, 100)
BUCKETS = ((90, 101, "90 이상"), (80, 90, "80~90"), (60, 80, "60~80"), (0, 60, "60 미만"))


def clean_rows(rows):
    out = []
    for t, o, h, l, c, v in rows:
        try:
            c = float(c)
        except (TypeError, ValueError):
            continue
        if not (c > 0 and math.isfinite(c)):
            continue
        o = o if (o or 0) > 0 else c
        h = max(h, o, c) if (h or 0) > 0 else max(o, c)
        l = min(l, o, c) if (l or 0) > 0 else min(o, c)
        v = v if (v or 0) > 0 and math.isfinite(v) else 0.0
        out.append((int(t), float(o), float(h), float(l), c, float(v)))
    out.sort()
    ded = []
    for r in out:
        if ded and ded[-1][0] == r[0]:
            ded[-1] = r
        else:
            ded.append(r)
    return ded


def load_history(hist_dir=HIST):
    """collector/.history/upbit/*.npz (예측 엔진이 쌓는 1000일 일봉) → [(이름, [(t,o,h,l,c,v)])]
    10일 넘는 공백·하루 8배 넘는 점프(티커 재사용 등)에서 끊어 따로 본다. 스테이블코인 제외."""
    import io
    import numpy as np
    out = []
    for p in sorted(Path(hist_dir).glob("KRW-*.npz")):
        code = p.stem
        if code.split("-", 1)[1] in STABLE:
            continue
        try:
            with open(p, "rb") as f:
                raw = f.read()
            with np.load(io.BytesIO(raw)) as z:
                a = {k: z[k] for k in ("t", "o", "h", "l", "c", "v")}
        except Exception:
            continue
        rows = clean_rows(zip(a["t"].astype("int64").tolist(), *(a[k].astype(float).tolist() for k in "ohlcv")))
        segs, cur = [], []
        for r in rows:
            if cur and (r[0] - cur[-1][0] > 10 * DAY or abs(LN(r[4] / cur[-1][4])) > LN(8)):
                segs.append(cur)
                cur = []
            cur.append(r)
        if cur:
            segs.append(cur)
        for k, s in enumerate(segs):
            if len(s) >= MIN_BARS + H_DAYS + 1:
                out.append((code if k == len(segs) - 1 else f"{code}#{len(segs) - 1 - k}", s))
    return out


def _setups_flags(s):
    """기존 전략 탭 '분출 임박'(setups.squeeze_breakout) · '과열 주의'(setups.overheat) — 비교 기준선·위험 검증용"""
    try:
        import setups
    except ImportError:
        return [0.0] * len(s), [0.0] * len(s)
    cs = [{"o": r[1], "h": r[2], "l": r[3], "c": r[4], "v": r[5]} for r in s]
    S = setups.prepare(cs)
    P = setups.params("upbit", 199)
    sq, heat = [], []
    for i in range(len(s)):
        for out, fn in ((sq, setups.squeeze_breakout), (heat, setups.overheat)):
            try:
                out.append(1.0 if fn(S, i, P, False) is not None else 0.0)
            except (TypeError, ZeroDivisionError, ValueError, IndexError):
                out.append(0.0)
    return sq, heat


def build_dataset(series, log=log):
    """시계열들 → 표 (특징 + 결과 + 기준선 표시). 횡단면 특징은 같은 날짜끼리 cross_section 으로 (매 실행과 같은 코드)."""
    import pandas as pd
    t0 = time.time()
    cols = {k: [] for k in tuple(FEATS) + EXTRA if k not in XS_FEATS}
    for k in ("_lval5_20", "_pump_m3", "_pump7", "_lval20", "_age", "t", "code", "y_mfe", "y_mae", "y_r24", "y_r72", "st_sq",
              "st_heat",
              "close"):
        cols[k] = []
    for name, s in series:
        t = [r[0] for r in s]
        o, h, l, c, v = ([r[k] for r in s] for k in range(1, 6))
        want = list(range(MIN_BARS - 1, len(s)))
        F = series_features(o, h, l, c, v, want)
        st, sh = _setups_flags(s)
        for k in F:
            cols[k].extend(F[k])
        for i in want:
            y = outcomes(h, l, c, t, i)
            cols["t"].append(t[i])
            cols["code"].append(name)
            cols["close"].append(c[i])
            cols["st_sq"].append(st[i])
            cols["st_heat"].append(sh[i])
            for kk, val in zip(("y_mfe", "y_mae", "y_r24", "y_r72"), y or (None,) * 4):
                cols[kk].append(val)
    df = pd.DataFrame(cols)
    log(f"학습 표: {len(series)}개 시계열 · {len(df):,}줄 · 특징 {time.time() - t0:.0f}초")
    need = ("atrp", "lval5", "_lval5_20", "ret1", "ret3", "ret7", "ret30", "vol20", "vr5_20", "vr1_20", "c_ma20", "_pump_m3",
            "_pump7", "_lval20")
    xs = {k: [None] * len(df) for k in XS_FEATS + ("mkt_pump7", "_v20rank")}
    recs = df[list(need) + ["code"]].to_dict("records")
    for _, idx in df.groupby("t").indices.items():
        rows = []
        for i in idx:
            d = {k: (None if (isinstance(x, float) and math.isnan(x)) else x) for k, x in recs[i].items()}
            d["_code"] = d.pop("code")
            rows.append(d)
        cross_section(rows)
        for i, d in zip(idx, rows):
            for k in xs:
                xs[k][i] = d.get(k)
    for k in xs:
        df[k] = pd.to_numeric(pd.Series(xs[k], dtype=object), errors="coerce").astype(float).values
    for k in tuple(FEATS) + EXTRA:
        df[k] = pd.to_numeric(df[k], errors="coerce").astype(float)
    for k in ("y_mfe", "y_mae", "y_r24", "y_r72"):
        df[k] = pd.to_numeric(df[k], errors="coerce").astype(float)
    log(f"횡단면 포함 {time.time() - t0:.0f}초")
    return df


class Std:
    """1~99% 로 자르고 표준화. 빈 값은 0(평균)."""

    def __init__(self, X):
        import numpy as np
        self.lo = np.nanpercentile(X, 1, axis=0)
        self.hi = np.nanpercentile(X, 99, axis=0)
        Xc = np.clip(X, self.lo, self.hi)
        self.mu = np.nanmean(Xc, axis=0)
        self.sd = np.nanstd(Xc, axis=0) + 1e-9
        for a in (self.lo, self.hi, self.mu):
            a[~np.isfinite(a)] = 0.0

    def __call__(self, X):
        import numpy as np
        return np.nan_to_num((np.clip(X, self.lo, self.hi) - self.mu) / self.sd)


def fit_parts(tr, feats=FEATS):
    """한 번의 학습 — 펌핑(로지스틱+LightGBM) · 급락(변동성 로지스틱+LightGBM) · 비교용 변동성만 로지스틱"""
    import numpy as np
    import lightgbm as lgb
    from sklearn.linear_model import LogisticRegression
    feats = list(feats)
    X = tr[feats].values.astype(float)
    yp = (tr.y_mfe.values >= PUMP).astype(int)
    yd = (tr.y_mae.values <= DUMP).astype(int)
    st = Std(X)
    lr_p = LogisticRegression(C=LR_C, max_iter=3000).fit(st(X), yp)
    fill = np.nanmedian(X, axis=0)
    fill[~np.isfinite(fill)] = 0.0
    Xg = np.where(np.isnan(X), fill, X)
    gb_p = lgb.LGBMClassifier(**LGB_PARAMS).fit(Xg, yp)
    di = [k for k, f in enumerate(feats) if GROUP_OF.get(f) != "market"]
    gb_d = lgb.LGBMClassifier(**LGB_PARAMS).fit(Xg[:, di], yd) if W_GB_DUMP > 0 else None
    vi = [feats.index(f) for f in VOL_FEATS]
    Xv = X[:, vi]
    sv = Std(Xv)
    lr_d = LogisticRegression(C=1.0, max_iter=3000).fit(sv(Xv), yd)
    lr_v = LogisticRegression(C=1.0, max_iter=3000).fit(sv(Xv), yp)
    return {"feats": feats, "st": st, "lr_p": lr_p, "fill": fill, "gb_p": gb_p, "gb_d": gb_d, "di": di, "vi": vi, "sv": sv,
            "lr_d": lr_d, "lr_v": lr_v}


def _sig_np(z):
    import numpy as np
    return 1 / (1 + np.exp(-np.clip(z, -30, 30)))


def predict_parts(m, te):
    import numpy as np
    X = te[m["feats"]].values.astype(float)
    z_lr = m["lr_p"].decision_function(m["st"](X))
    Xg = np.where(np.isnan(X), m["fill"], X)
    z_gb = m["gb_p"].predict(Xg, raw_score=True)
    zd_gb = m["gb_d"].predict(Xg[:, m["di"]], raw_score=True) if m["gb_d"] is not None else 0.0
    Zv = m["sv"](X[:, m["vi"]])
    zd_lr = m["lr_d"].decision_function(Zv)
    zv = m["lr_v"].decision_function(Zv)
    return {"p_lr": _sig_np(z_lr), "p_gb": _sig_np(z_gb), "p": _sig_np((1 - W_GB) * z_lr + W_GB * z_gb),
            "d": _sig_np((1 - W_GB_DUMP) * zd_lr + W_GB_DUMP * zd_gb), "p_vol": _sig_np(zv)}


def walk_forward(df, log=log, months=1):
    """월별(기본) 표본 밖 예측 — 학습은 검증 시작 4일 전까지(엠바고), 같은 날짜의 코인들은 늘 같은 쪽"""
    import pandas as pd
    lab = df[df.y_mfe.notna() & df.y_mae.notna() & df.y_r72.notna()]
    last_t = int(lab.t.max())
    starts = pd.date_range(WF_START, datetime.fromtimestamp(last_t, timezone.utc).strftime("%Y-%m-%d"),
                           freq=f"{months}MS")
    parts = []
    t0 = time.time()
    for s in starts:
        ts = int(s.timestamp())
        te_end = int((s + pd.offsets.MonthBegin(months)).timestamp())
        tr = lab[lab.t <= ts - EMBARGO]
        te = lab[(lab.t >= ts) & (lab.t < te_end)]
        if len(te) == 0 or len(tr) < 20000:
            continue
        m = fit_parts(tr)
        pr = predict_parts(m, te)
        o = te[["t", "code", "y_mfe", "y_mae", "y_r24", "y_r72", "atrp", "st_sq", "st_heat", "lval1", "_age", "mkt_pump7",
                "btc_ret7", "_v20rank"]].copy()
        for k, v in pr.items():
            o[k] = v
        o["fold"] = ts
        parts.append(o)
        log(f"  검증 {s.strftime('%Y-%m')}: 학습 {len(tr):,} → 검증 {len(te):,} ({time.time() - t0:.0f}초)")
    return pd.concat(parts, ignore_index=True)


# 대응표 — 표본 밖 예측(확률)을 점수·예상 % 로 바꾸는 표. 모두 '과거 같은 점수였던 자리의 실제 결과'다.
def _logit_np(p):
    import numpy as np
    p = np.clip(np.asarray(p, dtype=float), 1e-6, 1 - 1e-6)
    return np.log(p / (1 - p))


def _strict(xs):
    out = []
    for x in xs:
        x = float(x)
        out.append(x if not out or x > out[-1] else out[-1] + 1e-9)
    return out


def make_ref(p):
    """점수 = 이 확률이 과거 표본 밖 예측 중 몇 % 보다 높은가 (101개 분위)"""
    import numpy as np
    q = np.linspace(0, 1, 101)
    return {"z": _strict(np.quantile(_logit_np(p), q)), "q": [round(float(x), 2) for x in q]}


def apply_ref(ref, p):
    import numpy as np
    return 100.0 * np.interp(_logit_np(p), ref["z"], ref["q"])


def make_net_ref(net):
    """후보 점수 = '펌핑 확률 − W_NET × 급락 확률'(둘 다 보정된 값)이 과거 표본 밖 자리 중 몇 % 보다 큰가 (101개 분위)"""
    import numpy as np
    q = np.linspace(0, 1, 101)
    return {"x": _strict(np.quantile(np.asarray(net, dtype=float), q)), "q": [round(float(v), 2) for v in q]}


def apply_net_ref(nref, net):
    import numpy as np
    return 100.0 * np.interp(np.asarray(net, dtype=float), nref["x"], nref["q"])


def make_map(score, y_mfe):
    """점수 칸 → 펌핑 비율 · 72시간 최고 상승폭 10/50/90% — 점수가 높을수록 줄지 않게(누적 최대)"""
    import numpy as np
    s, pu, m10, m50, m90, n = [], [], [], [], [], []
    for a, b in zip(SCORE_BINS[:-1], SCORE_BINS[1:]):
        sel = (score >= a) & (score < b if b < 100 else score <= b)
        if sel.sum() < 40:
            continue
        y = y_mfe[sel]
        s.append(float(np.median(score[sel])))
        pu.append(float((y >= PUMP).mean()))
        m10.append(float(np.quantile(y, 0.1)))
        m50.append(float(np.quantile(y, 0.5)))
        m90.append(float(np.quantile(y, 0.9)))
        n.append(int(sel.sum()))
    mono = lambda xs: [float(x) for x in np.maximum.accumulate(np.array(xs))]
    return {"s": _strict(s), "pump": mono(pu), "mfe10": mono(m10), "mfe50": mono(m50), "mfe90": mono(m90), "n": n}


def make_rmap(score, atrp, y_r72, y_r24):
    """(점수 칸 × 변동성 10분위) → 72시간 뒤 수익 10/50/90% · 24시간 뒤 중앙값. 표본이 적은 칸은 그 변동성 칸 전체 값."""
    import numpy as np
    edges = [float(x) for x in np.quantile(atrp[np.isfinite(atrp)], np.linspace(0.1, 0.9, 9))]
    bins = np.searchsorted(edges, np.nan_to_num(atrp, nan=0.0), side="right")
    centers = [(a + b) / 2 for a, b in zip(R_SCORE_BINS[:-1], R_SCORE_BINS[1:])]
    rows = []
    for k in range(len(edges) + 1):
        sb = bins == k
        allv = {"r10": float(np.quantile(y_r72[sb], 0.1)), "r50": float(np.quantile(y_r72[sb], 0.5)),
                "r90": float(np.quantile(y_r72[sb], 0.9)), "r24": float(np.quantile(y_r24[sb], 0.5))}
        row = {"r10": [], "r50": [], "r90": [], "r24": [], "n": []}
        for a, b in zip(R_SCORE_BINS[:-1], R_SCORE_BINS[1:]):
            sel = sb & (score >= a) & (score < b if b < 100 else score <= b)
            if sel.sum() >= 150:
                row["r10"].append(float(np.quantile(y_r72[sel], 0.1)))
                row["r50"].append(float(np.quantile(y_r72[sel], 0.5)))
                row["r90"].append(float(np.quantile(y_r72[sel], 0.9)))
                row["r24"].append(float(np.quantile(y_r24[sel], 0.5)))
            else:
                for kk in ("r10", "r50", "r90", "r24"):
                    row[kk].append(allv[kk])
            row["n"].append(int(sel.sum()))
        rows.append(row)
    return {"edges": edges, "s": centers, "rows": rows}


def make_dumpcal(d, y_mae):
    """급락 모델 확률 → 같은 칸의 실제 급락 비율 (20칸, 누적 최대로 단조)"""
    import numpy as np
    z = _logit_np(d)
    qs = np.unique(np.quantile(z, np.linspace(0, 1, 21)))
    xs, ps = [], []
    for a, b in zip(qs[:-1], qs[1:]):
        sel = (z >= a) & (z <= b)
        if sel.sum() < 40:
            continue
        xs.append(float(np.median(z[sel])))
        ps.append(float((y_mae[sel] <= DUMP).mean()))
    return {"z": _strict(xs), "p": [float(x) for x in np.maximum.accumulate(np.array(ps))]}


def _map_apply(mp, rm, dc, score, atrp, d):
    import numpy as np
    out = {"pPump": np.interp(score, mp["s"], mp["pump"])}
    for k in ("mfe10", "mfe50", "mfe90"):
        out[k] = np.interp(score, mp["s"], mp[k])
    bins = np.searchsorted(rm["edges"], np.nan_to_num(atrp, nan=0.0), side="right")
    for k in ("r10", "r50", "r90", "r24"):
        v = np.zeros(len(score))
        for b in range(len(rm["rows"])):
            sel = bins == b
            v[sel] = np.interp(score[sel], rm["s"], rm["rows"][b][k])
        out[k] = v
    out["pDump"] = np.interp(_logit_np(d), dc["z"], dc["p"])
    return out


def honest_preds(oos, log=log, min_rows=15000):
    """검증 성적용 — 달마다 '그 전 달들의 표본 밖 결과'로만 점수 기준·대응표를 만들어 이번 달에 적용 (두 겹 워크포워드)"""
    import numpy as np
    import pandas as pd
    folds = sorted(oos.fold.unique())
    parts = []
    for f in folds:
        prev = oos[(oos.fold < f) & (oos.t <= f - EMBARGO)]
        cur = oos[oos.fold == f]
        if len(prev) < min_rows:
            continue
        ref = make_ref(prev.p.values)
        sp = apply_ref(ref, prev.p.values)
        mp = make_map(sp, prev.y_mfe.values)
        rm = make_rmap(sp, prev.atrp.values, prev.y_r72.values, prev.y_r24.values)
        dc = make_dumpcal(prev.d.values, prev.y_mae.values)
        sc = apply_ref(ref, cur.p.values)
        o = cur.copy()
        o["score"] = sc
        for k, v in _map_apply(mp, rm, dc, sc, cur.atrp.values, cur.d.values).items():
            o[k] = v
        pv = _map_apply(mp, rm, dc, sp, prev.atrp.values, prev.d.values)
        nref = make_net_ref(pv["pPump"] - W_NET * pv["pDump"])
        o["cand"] = apply_net_ref(nref, o["pPump"].values - W_NET * o["pDump"].values)
        # 비교용: 그 전 달들의 무조건 분위(아무 정보 없이 맞히기)
        o["b_mfe50"] = float(np.quantile(prev.y_mfe, 0.5))
        for q, k in ((0.1, "b_r10"), (0.5, "b_r50"), (0.9, "b_r90")):
            o[k] = float(np.quantile(prev.y_r72, q))
        parts.append(o)
    return pd.concat(parts, ignore_index=True) if parts else None


def dedup_signals(d, sel):
    """같은 코인은 신호 뒤 72시간 안의 신호를 뺀다 (겹치는 표본 제거 = 첫 신호만)"""
    import numpy as np
    sub = d[sel].sort_values(["code", "t"])
    keep = []
    last = {}
    for i, c, t in zip(sub.index, sub.code.values, sub.t.values):
        if c in last and t - last[c] < H_DAYS * DAY:
            continue
        last[c] = t
        keep.append(i)
    return d.loc[keep]


def _pinball(y, q, tau):
    import numpy as np
    e = y - q
    return float(np.mean(np.maximum(tau * e, (tau - 1) * e)))


def _daily_auc(t, y, p):
    import numpy as np
    from sklearn.metrics import roc_auc_score
    import pandas as pd
    d = pd.DataFrame({"t": t, "y": y, "p": p})
    a = [roc_auc_score(g.y, g.p) for _, g in d.groupby("t") if g.y.nunique() == 2 and len(g) >= 30]
    return float(np.mean(a)) if a else None


def compare_table(o):
    """모델 비교 (표본 밖) — 펌핑 AUC(전체·같은 날 코인끼리), 날마다 상위 10% 의 펌핑·급락 비율, 3일 뒤 수익 중앙값"""
    import numpy as np
    from sklearn.metrics import roc_auc_score
    yp = (o.y_mfe.values >= PUMP).astype(int)
    yd = (o.y_mae.values <= DUMP).astype(int)
    base = float(yp.mean())
    rows = []
    for key, name, col in (("setups", "기존 '분출 임박' 표시", "st_sq"), ("vol", "변동성만 (ATR·표준편차·밴드 폭)", "p_vol"),
                           ("lr", f"로지스틱 회귀 (특징 {len(FEATS)}개)", "p_lr"), ("gb", f"LightGBM (특징 {len(FEATS)}개)", "p_gb"),
                           ("blend", "섞기 = 이 화면의 점수", "p")):
        p = o[col].values.astype(float)
        if key == "setups":
            on = p > 0.5
            top_p, top_d = float(yp[on].mean()) if on.any() else None, float(yd[on].mean()) if on.any() else None
            top_r = float(np.median(o.y_r72.values[on])) - FEE if on.any() else None
            rows.append({"key": key, "name": name, "auc": None, "dailyAuc": None, "top10Pump": top_p,
                         "lift": top_p / base if top_p is not None else None, "top10Dump": top_d, "top10R72": top_r,
                         "n": int(on.sum()), "note": "켜진 날만 (전체의 {:.1f}%)".format(on.mean() * 100)})
            continue
        thr = o.assign(p_=p).groupby("t").p_.transform(lambda x: x.quantile(0.9)).values
        top = p >= thr
        rows.append({"key": key, "name": name, "auc": float(roc_auc_score(yp, p)),
                     "dailyAuc": _daily_auc(o.t.values, yp, p), "top10Pump": float(yp[top].mean()),
                     "lift": float(yp[top].mean()) / base, "top10Dump": float(yd[top].mean()),
                     "top10R72": float(np.median(o.y_r72.values[top])) - FEE, "n": int(top.sum())})
    return rows


def _bucket_rows(h, base, col="score"):
    import numpy as np
    out = []
    for lo, hi, name in BUCKETS:
        sel = (h[col].values >= lo) & (h[col].values < hi)
        s = dedup_signals(h, sel)
        if len(s) == 0:
            out.append({"lo": lo, "hi": min(hi, 100), "name": name, "n": 0})
            continue
        pu = float((s.y_mfe >= PUMP).mean())
        du = float((s.y_mae <= DUMP).mean())
        out.append({"lo": lo, "hi": min(hi, 100), "name": name, "n": int(len(s)), "coins": int(s.code.nunique()),
                    "pump": pu, "dump": du, "lift": pu / base["pump"] if base["pump"] else None,
                    "dumpLift": du / base["dump"] if base["dump"] else None,
                    "medMfe": float(np.median(s.y_mfe)), "predMfe": float(np.median(s.mfe50)),
                    "medR24": float(np.median(s.y_r24)) - FEE, "medR72": float(np.median(s.y_r72)) - FEE,
                    "meanR72": float(np.mean(np.clip(s.y_r72, -0.5, 1.0))) - FEE,
                    "win72": float((s.y_r72 > FEE).mean())})
    return out


def _base(h):
    import numpy as np
    return {"n": int(len(h)), "pump": float((h.y_mfe >= PUMP).mean()), "dump": float((h.y_mae <= DUMP).mean()),
            "medMfe": float(np.median(h.y_mfe)), "medR24": float(np.median(h.y_r24)) - FEE,
            "medR72": float(np.median(h.y_r72)) - FEE}


def _calib(h):
    """예측 성적 — 예상값 구간별 실제 (두 겹 워크포워드라 대응표도 미래를 못 봄)"""
    import numpy as np
    from scipy.stats import spearmanr
    out = {"mfe": [], "r72": [], "pump": [], "dump": []}
    for lo, hi in ((-1, 0.03), (0.03, 0.05), (0.05, 0.08), (0.08, 0.12), (0.12, 0.2), (0.2, 9)):
        sel = (h.mfe50 >= lo) & (h.mfe50 < hi)
        if sel.sum() >= 50:
            out["mfe"].append({"lo": lo, "hi": hi, "n": int(sel.sum()), "pred": float(h.mfe50[sel].median()),
                               "act": float(h.y_mfe[sel].median()), "mean": float(np.clip(h.y_mfe[sel], 0, 1.0).mean()),
                               "pump": float((h.y_mfe[sel] >= PUMP).mean())})
    for lo, hi in ((-1, -0.03), (-0.03, -0.015), (-0.015, -0.005), (-0.005, 0.005), (0.005, 9)):
        sel = (h.r50 >= lo) & (h.r50 < hi)
        if sel.sum() >= 50:
            out["r72"].append({"lo": lo, "hi": hi, "n": int(sel.sum()), "pred": float(h.r50[sel].median()),
                               "act": float(h.y_r72[sel].median())})
    for lo, hi in ((0, 0.05), (0.05, 0.1), (0.1, 0.15), (0.15, 0.2), (0.2, 0.3), (0.3, 1.01)):
        sel = (h.pPump >= lo) & (h.pPump < hi)
        if sel.sum() >= 50:
            out["pump"].append({"lo": lo, "hi": hi, "n": int(sel.sum()), "pred": float(h.pPump[sel].mean()),
                                "act": float((h.y_mfe[sel] >= PUMP).mean())})
        sel = (h.pDump >= lo) & (h.pDump < hi)
        if sel.sum() >= 50:
            out["dump"].append({"lo": lo, "hi": hi, "n": int(sel.sum()), "pred": float(h.pDump[sel].mean()),
                                "act": float((h.y_mae[sel] <= DUMP).mean())})
    y, ym = h.y_r72.values, h.y_mfe.values
    out["cover80"] = float(((y >= h.r10) & (y <= h.r90)).mean())
    out["coverMfe80"] = float(((ym >= h.mfe10) & (ym <= h.mfe90)).mean())
    out["mfeIc"] = float(spearmanr(h.mfe50, ym).correlation)
    out["r72Ic"] = float(spearmanr(h.r50, y).correlation)
    out["mfeSkill"] = 1 - _pinball(ym, h.mfe50.values, 0.5) / _pinball(ym, h.b_mfe50.values, 0.5)
    rq = np.mean([_pinball(y, h[k].values, t) for k, t in (("r10", 0.1), ("r50", 0.5), ("r90", 0.9))])
    rb = np.mean([_pinball(y, h[k].values, t) for k, t in (("b_r10", 0.1), ("b_r50", 0.5), ("b_r90", 0.9))])
    out["r72Skill"] = float(1 - rq / rb)
    return out


def _signal_rule(h, thr=SIG_THR, col="cand"):
    """실제 신호 기록과 같은 규칙을 과거에: 후보 점수가 thr 이상으로 올라선 날(전날 thr 미만) · 같은 코인 72시간에 한 번"""
    import numpy as np
    d = h.sort_values(["code", "t"])
    keep, last_sig, prev = [], {}, {}
    for i, c, t, s in zip(d.index, d.code.values, d.t.values, d[col].values):
        p = prev.get(c)
        prev[c] = (t, s)
        crossed = s >= thr and (p is None or p[0] != t - DAY or p[1] < thr)
        if crossed and t - last_sig.get(c, -10 ** 12) >= H_DAYS * DAY:
            last_sig[c] = t
            keep.append(i)
    s = h.loc[keep]
    if len(s) < 30:
        return None
    return {"thr": thr, "n": int(len(s)), "coins": int(s.code.nunique()), "pump": float((s.y_mfe >= PUMP).mean()),
            "dump": float((s.y_mae <= DUMP).mean()), "medMfe": float(np.median(s.y_mfe)),
            "predMfe": float(np.median(s.mfe50)), "medR72": float(np.median(s.y_r72)) - FEE,
            "medR24": float(np.median(s.y_r24)) - FEE, "win72": float((s.y_r72 > FEE).mean())}


def _order_stats(h):
    """목록 정렬 비교 — 날마다 상위 k 개를 '펌핑 점수 순' 과 '급락 위험 뺀 순(펌핑 확률 − 급락 확률)' 으로 골랐다면
    (두 겹 워크포워드 확률). 3일 뒤 수익은 같은 날 전 종목 중앙값과의 차(시장 대비)도 본다."""
    import numpy as np
    d = h.assign(net=h.pPump - W_NET * h.pDump)
    d["ex"] = d.y_r72 - d.groupby("t").y_r72.transform("median")
    out = []
    for k in (5, 10):
        row = {"k": k}
        picks = {}
        for key, col in (("score", "pPump"), ("net", "net")):
            r = d.sort_values(["t", col], ascending=[True, False]).groupby("t").head(k)
            picks[key] = r
            row[key] = {"n": int(len(r)), "pump": float((r.y_mfe >= PUMP).mean()), "dump": float((r.y_mae <= DUMP).mean()),
                        "medMfe": float(np.median(r.y_mfe)), "medR72": float(np.median(r.y_r72)) - FEE,
                        "ex": float(r.ex.mean())}
        diff = (picks["net"].groupby("t").ex.mean() - picks["score"].groupby("t").ex.mean()).dropna().values
        if len(diff) >= 60:  # 5일 묶음 부트스트랩 95% 구간
            rng = np.random.default_rng(0)
            nb = len(diff) // 5
            boots = [diff[np.concatenate([np.arange(a, a + 5) for a in rng.integers(0, len(diff) - 5, nb)])].mean()
                     for _ in range(1000)]
            row["exDiff"] = float(diff.mean())
            row["exDiffCi"] = [float(np.percentile(boots, 2.5)), float(np.percentile(boots, 97.5))]
        out.append(row)
    return out


def _regime_stats(h, df):
    """'이럴 땐' — 시장에 펌핑이 잦은 때(최근 7일 펌핑 빈도가 그날 이전 분포의 상위 1/3)·비트코인 7일 하락 때,
    날마다 상위 5개를 펌핑 점수 순 / 급락 위험 뺀 순으로 골랐다면 (국면 판정은 그 시점까지의 값만)"""
    import numpy as np
    dmp = df.groupby("t")["mkt_pump7"].first().sort_index()
    thr = dmp.expanding(min_periods=60).quantile(2 / 3).shift(1)
    hot = (dmp >= thr).to_dict()
    d = h.assign(hot=h.t.map(hot).fillna(False).astype(bool), down=(h.btc_ret7 < 0), net=h.pPump - W_NET * h.pDump)
    d["ex"] = d.y_r72 - d.groupby("t").y_r72.transform("median")

    def side(x, col):
        r = x.sort_values(["t", col], ascending=[True, False]).groupby("t").head(5)
        return {"pump": float((r.y_mfe >= PUMP).mean()), "dump": float((r.y_mae <= DUMP).mean()),
                "medR72": float(np.median(r.y_r72)) - FEE, "ex": float(r.ex.mean())}

    out = []
    for key, name, sel in (("hot", "시장에 펌핑이 잦은 때(최근 7일 펌핑 빈도가 지난 분포의 상위 1/3)", d.hot),
                           ("btcdown", "비트코인이 7일 동안 내린 때", d.down),
                           ("calm", "둘 다 아닐 때", ~d.hot & ~d.down)):
        x = d[sel]
        if x.t.nunique() < 20:
            continue
        out.append({"key": key, "name": name, "days": int(x.t.nunique()), "score": side(x, "pPump"), "net": side(x, "net")})
    return out


def _risk_stats(h):
    """위험 표시가 과거에 실제로 뜻이 있었나 (첫 신호만)"""
    import numpy as np
    out = {}
    val = np.exp(h.lval1.values)
    v20 = h["_v20rank"].values if "_v20rank" in h else np.ones(len(h))
    for key, name, sel in (("heat", "과열 주의 (RSI 75 이상 · 20일 평균보다 20% 넘게 위)", h.st_heat.values > 0.5),
                           ("thin", "거래가 적어요 (20일 거래대금 하위 30% 또는 하루 1억 원 미만)", (v20 < LIQ_PCT) | (val < LIQ_MIN)),
                           ("thin10", "하루 거래대금 10억 원 미만", val < LIQ_THIN),
                           ("dumpHi", "급락 확률 15% 이상으로 표시된 자리", h.pDump.values >= 0.15)):
        s = dedup_signals(h, sel)
        if len(s) >= 30:
            out[key] = {"name": name, "n": int(len(s)), "pump": float((s.y_mfe >= PUMP).mean()),
                        "dump": float((s.y_mae <= DUMP).mean()), "medR72": float(np.median(s.y_r72)) - FEE}
    return out


def _pp(x, d=1):
    return f"{x * 100:+.{d}f}%".replace("-", "−")


def _p0(x):
    return f"{x * 100:.0f}%"


def stat_lines(st):
    """화면 맨 위·예측 성적 문장 (숫자가 들어간 쉬운 말)"""
    b = st["base"]
    top = st["bucketsCand"][0]
    tp = st["buckets"][0]
    lines = []
    verdict = "none"
    if top.get("n", 0) >= 100:
        lift = top["lift"] or 0
        verdict = "ok" if lift >= 1.5 else "weak"
        head = (f"후보 점수 90 이상(과거 코인·시점의 상위 10%) {top['n']:,}번 중 {_p0(top['pump'])}가 3일 안에 +15% 넘게 올랐어요"
                f" — 평소({_p0(b['pump'])})의 {lift:.1f}배예요. −15% 급락은 {_p0(top['dump'])}(평소 {_p0(b['dump'])}), "
                f"3일 뒤 수익 중앙값은 {_pp(top['medR72'])}(수수료 뺌, 평소 {_pp(b['medR72'])})였어요.")
        lines.append(head)
        if tp.get("n"):
            lines.append(f"급락 위험을 빼지 않은 펌핑 점수 90 이상은 펌핑 {_p0(tp['pump'])}였지만 급락도 {_p0(tp['dump'])}"
                         f"(평소의 {tp['dumpLift']:.1f}배)였어요 — 펌핑 확률만 높은 코인은 위로도 아래로도 크게 흔들려요.")
    else:
        lines.append("검증 표본이 모자라 점수의 효과를 말하기 어려워요.")
    c = st.get("calib") or {}
    for row in c.get("mfe", []):
        if row["lo"] >= 0.05:
            rng = f"{_pp(row['lo'], 0)}~{_pp(row['hi'], 0)}" if row["hi"] < 1 else f"{_pp(row['lo'], 0)} 넘게"
            lines.append(f"예측 성적: ‘3일 안 최고 {rng} 예상’ {row['n']:,}번 → 실제 3일 최고 중앙값 {_pp(row['act'])}")
    if c.get("cover80") is not None:
        lines.append(f"예측 성적: ‘10번 중 8번은 A ~ B’ 범위에 실제 3일 뒤 수익이 들어온 비율 {_p0(c['cover80'])} (목표 80%)")
    if c.get("r72Ic") is not None:
        ic = f"{c['r72Ic']:+.2f}".replace("-", "−")
        lines.append(f"예측 성적: ‘3일 뒤 예상 %’의 순위 상관 {ic} — "
                     f"{'방향은 거의 맞히지 못해요' if abs(c['r72Ic']) < 0.05 else '방향 예측은 약해요'}. 범위(흔들림 크기)를 보세요.")
    return verdict, lines


def build_stats(oos, h, df, events=None):
    import numpy as np
    hold = int(datetime.fromisoformat(HOLD_FROM).replace(tzinfo=timezone.utc).timestamp())
    st = {"version": 1, "updatedAt": iso(time.time()),
          "def": {"h": 72, "pump": PUMP, "dump": DUMP, "fee": FEE, "sigThr": SIG_THR},
          "from": iso(int(h.t.min()))[:10], "to": iso(int(h.t.max()) + DAY)[:10], "holdFrom": HOLD_FROM,
          "data": {"coins": int(df.code.str.split("#").str[0].nunique()), "rows": int(df.y_mfe.notna().sum()),
                   "from": iso(int(df.t.min()))[:10], "to": iso(int(df.t.max()) + DAY)[:10]},
          "base": _base(h)}
    st["buckets"] = _bucket_rows(h, st["base"])
    st["bucketsCand"] = _bucket_rows(h, st["base"], "cand")
    hr = h[h.t >= hold]
    st["recent"] = ({"from": HOLD_FROM, "base": _base(hr), "buckets": _bucket_rows(hr, _base(hr)),
                     "bucketsCand": _bucket_rows(hr, _base(hr), "cand")} if len(hr) > 1000 else None)
    st["calib"] = _calib(h)
    st["risk"] = _risk_stats(h)
    st["signalRule"] = [x for x in (_signal_rule(h, SIG_THR), _signal_rule(h, 80)) if x]
    st["orders"] = _order_stats(h)
    st["regimes"] = _regime_stats(h, df)
    st["compare"] = {"all": compare_table(oos), "recent": compare_table(oos[oos.t >= hold]),
                     "from": iso(int(oos.t.min()))[:10]}
    st["events"] = events
    st["verdict"], st["lines"] = stat_lines(st)
    st["method"] = [
        f"업비트 원화 코인의 하루 봉(매일 09:00 끝)마다 특징 {len(FEATS)}개를 만들고, 그 시점 가격에 샀다면 72시간 안에 +15% 이상 올랐는지(펌핑)·−15% 이하로 내렸는지(급락)를 맞히게 했어요.",
        f"검증은 시간 순서대로만 했어요: {WF_START[:7]}부터 한 달씩, 그 달 시작 4일 전까지의 데이터로만 학습하고 그 달을 맞혀 봤어요(워크포워드, 72시간 결과가 겹치지 않게 4일 띄움).",
        "점수·예상 %의 대응표도 그 달 이전의 표본 밖 결과로만 만들어 적용했어요. 같은 코인이 72시간 안에 다시 켜진 신호는 겹치는 표본이라 뺐어요.",
        f"특징·설정은 {HOLD_FROM[:7]} 이전 구간에서만 골랐고, 그 뒤는 따로 '최근 구간'으로 보여 줘요.",
        "수수료(왕복 0.1%)는 뺐고, 미끄러짐(호가 공백)·세금은 빼지 않았어요.",
    ]
    st["limits"] = [
        "이력에는 지금(그리고 최근 1년 안에) 업비트 원화 마켓에 있는 코인만 있어요. 그 전에 상장폐지된 코인은 빠져 있어서(생존 편향) 과거 급락 비율이 실제보다 낮게 나왔을 수 있어요.",
        "신호를 본 뒤 실제로 사기까지 걸리는 시간(사이트 갱신 40~70분 간격)은 반영하지 않았어요.",
        "거래가 아주 적은 코인은 호가가 비어 있어 표시된 가격에 사고팔기 어려워요.",
        "새로 상장한 지 60일이 안 된 코인은 점수를 매기지 않아요(위험 표시만).",
    ]
    return st


def export_trees(booster):
    dm = booster.dump_model()
    trees = []
    for ti in dm["tree_info"]:
        f, th, L, R, V = [], [], [], [], []

        def walk(node):
            k = len(f)
            f.append(-1)
            th.append(0.0)
            L.append(-1)
            R.append(-1)
            V.append(0.0)
            if "leaf_value" in node:
                V[k] = float(f"{node['leaf_value']:.8g}")
                return k
            if node.get("decision_type", "<=") != "<=":
                raise ValueError("숫자 나눔만 지원")
            f[k] = int(node["split_feature"])
            th[k] = float(node["threshold"])
            V[k] = float(f"{node.get('internal_value', 0.0):.8g}")
            L[k] = walk(node["left_child"])
            R[k] = walk(node["right_child"])
            return k

        walk(ti["tree_structure"])
        trees.append([f, th, L, R, V])
    return trees


def _lr_json(lr, std, feats):
    return {"feats": list(feats), "lo": [float(x) for x in std.lo], "hi": [float(x) for x in std.hi],
            "mu": [float(x) for x in std.mu], "sd": [float(x) for x in std.sd],
            "w": [float(x) for x in lr.coef_[0]], "b": float(lr.intercept_[0])}


def export_model(m, df_lab, oos):
    import numpy as np
    feats = m["feats"]
    P = {"lr": _lr_json(m["lr_p"], m["st"], feats),
         "gb": {"feats": feats, "fill": [float(x) for x in m["fill"]], "trees": export_trees(m["gb_p"].booster_)},
         "w_gb": W_GB}
    D = {"lr": _lr_json(m["lr_d"], m["sv"], VOL_FEATS), "w_gb": W_GB_DUMP}
    if m["gb_d"] is not None:
        D["gb"] = {"feats": [feats[k] for k in m["di"]], "fill": [float(m["fill"][k]) for k in m["di"]],
                   "trees": export_trees(m["gb_d"].booster_)}
    ref = make_ref(oos.p.values)
    so = apply_ref(ref, oos.p.values)
    M = {"version": 1, "trainedAt": iso(time.time()), "feats": feats, "groups": [[g, n, list(fs)] for g, n, fs in GROUPS],
         "dataTo": iso(int(df_lab.t.max()) + DAY)[:10], "rows": int(len(df_lab)), "pump": P, "dump": D, "ref": ref,
         "map": make_map(so, oos.y_mfe.values),
         "rmap": make_rmap(so, oos.atrp.values, oos.y_r72.values, oos.y_r24.values),
         "dumpCal": make_dumpcal(oos.d.values, oos.y_mae.values), "wNet": W_NET}
    pv = _map_apply(M["map"], M["rmap"], M["dumpCal"], so, oos.atrp.values, oos.d.values)
    M["netRef"] = make_net_ref(pv["pPump"] - W_NET * pv["pDump"])
    # 영역 기여 분포 (학습 표 전체, 로지스틱 부분)
    X = df_lab[feats].values.astype(float)
    Z = m["st"](X) * m["lr_p"].coef_[0]
    gref = {}
    for g, _, fs in GROUPS:
        idx = [feats.index(f) for f in fs]
        gref[g] = [float(x) for x in np.quantile(Z[:, idx].sum(axis=1), np.linspace(0, 1, 21))]
    M["groupRef"] = {g: _strict(v) for g, v in gref.items()}
    dmp = df_lab.groupby("t")["mkt_pump7"].first().dropna()
    M["regime"] = {"pump7Thr": float(np.quantile(dmp, 2 / 3)) if len(dmp) else None, "wNet": W_NET}
    # 특징 평소 값 (근거 문장의 '평소' 비교용)
    M["featRef"] = {f: [float(np.nanquantile(df_lab[f], q)) for q in (0.1, 0.5, 0.9)] for f in feats}
    # 순수 파이썬 계산이 학습 결과와 같은지 확인
    smp = df_lab.sample(min(400, len(df_lab)), random_state=1)
    rec = smp[feats].to_dict("records")
    got = []
    for r in rec:
        x = {k: (None if (isinstance(v, float) and math.isnan(v)) else v) for k, v in r.items()}
        got.append(tree_raw(P["gb"], x))
    Xs = smp[feats].values.astype(float)
    want = m["gb_p"].predict(np.where(np.isnan(Xs), m["fill"], Xs), raw_score=True)
    err = float(np.max(np.abs(np.array(got) - want)))
    zl = [P["lr"]["b"] + sum(lin_parts(P["lr"], {k: (None if (isinstance(v, float) and math.isnan(v)) else v)
                                                  for k, v in r.items()}).values()) for r in rec]
    err_lr = float(np.max(np.abs(np.array(zl) - m["lr_p"].decision_function(m["st"](Xs)))))
    if D.get("gb"):
        gd = [tree_raw(D["gb"], {k: (None if (isinstance(v, float) and math.isnan(v)) else v) for k, v in r.items()}) for r in rec]
        wd = m["gb_d"].predict(np.where(np.isnan(Xs), m["fill"], Xs)[:, m["di"]], raw_score=True)
        err = max(err, float(np.max(np.abs(np.array(gd) - wd))))
    M["check"] = {"treeErr": err, "lrErr": err_lr}
    if err > 1e-4 or err_lr > 1e-6:
        raise RuntimeError(f"순수 파이썬 점수가 학습 결과와 달라요: 나무 {err:.2e} · 로지스틱 {err_lr:.2e}")
    return M


def load_events():
    """업비트 공지 이벤트 (code, kind, ts) — 저장소의 처음 목록 + 매 실행이 모은 것"""
    ev = {}
    for src in (read_json(BOOT / "events.json", {}) or {}, (read_json(F_STATE, {}) or {}).get("events") or {}):
        for k, v in (src.get("items") if isinstance(src, dict) and "items" in src else src).items():
            ev[k] = v
    return ev


def event_stats(h, ev):
    """입출금 일시 중단 공지 그날·다음 날 — 실제 펌핑 비율 vs 점수가 말한 비율 (점수에는 넣지 않음)"""
    import numpy as np
    if not ev:
        return None
    keys = set()
    for v in ev.values():
        if v.get("k") != "suspend":
            continue
        d0 = int(v["ts"]) // DAY * DAY
        for code in v.get("c") or []:
            keys.add((code, d0))
            keys.add((code, d0 + DAY))
    sel = np.array([(c, int(t)) in keys for c, t in zip(h.code.values, h.t.values)])
    if sel.sum() < 30:
        return None
    s = h[sel]
    return {"suspend": {"n": int(sel.sum()), "pump": float((s.y_mfe >= PUMP).mean()), "pred": float(s.pPump.mean()),
                        "dump": float((s.y_mae <= DUMP).mean()), "predDump": float(s.pDump.mean())}}


def train(args):
    if args.if_stale:
        old = read_json(F_MODEL) or read_json(BOOT / "model.json")
        try:
            age = (time.time() - datetime.fromisoformat(old["trainedAt"]).timestamp()) / 3600
        except (TypeError, KeyError, ValueError):
            age = 1e9
        if age < args.if_stale and F_STATS.exists():
            log(f"학습 {age:.1f}시간 전 — 건너뜀")
            return 0
    import numpy as np  # noqa: F401
    t0 = time.time()
    series = load_history(Path(args.hist) if args.hist else HIST)
    if len(series) < 50:
        log(f"일봉 이력이 모자라요 ({len(series)}개) — 이전 모델을 그대로 써요")
        return 0
    df = build_dataset(series)
    lab = df[df.y_mfe.notna() & df.y_mae.notna() & df.y_r72.notna()].copy()
    oos = walk_forward(df)
    log(f"표본 밖 {len(oos):,}줄 ({time.time() - t0:.0f}초)")
    if args.save_oos:  # 연구용: 표본 밖 예측을 파일로
        oos.to_pickle(args.save_oos)
    h = honest_preds(oos)
    ev = load_events()
    st = build_stats(oos, h, df, None)
    st["events"] = event_stats(h, ev)
    m = fit_parts(lab)
    M = export_model(m, lab, oos)
    M["stats"] = {"auc": next(r["auc"] for r in st["compare"]["all"] if r["key"] == "blend"), "verdict": st["verdict"]}
    write_json(F_MODEL, M)
    write_json(F_STATS, st)
    if args.boot:
        write_json(BOOT / "model.json", M)
        write_json(BOOT / "stats.json", st)
    top = st["buckets"][0]
    tc = st["bucketsCand"][0]
    log(f"후보 점수 90+ 펌핑 {tc.get('pump', 0):.3f} 급락 {tc.get('dump', 0):.3f} 3일 뒤 {tc.get('medR72', 0):+.4f} n={tc.get('n')}")
    log(f"학습 끝 {time.time() - t0:.0f}초 · 펌핑 점수 90+ 펌핑 {top.get('pump', 0):.3f}(평소 {st['base']['pump']:.3f}) "
        f"급락 {top.get('dump', 0):.3f}(평소 {st['base']['dump']:.3f}) n={top.get('n')} · 나무 오차 {M['check']['treeErr']:.1e}")
    return 0


# ── 매 실행 (표준 라이브러리) ─────────────────────────────────────────────────
def load_model():
    cands = []
    for p in (F_MODEL, BOOT / "model.json"):
        m = read_json(p)
        if isinstance(m, dict) and m.get("version") == 1 and m.get("pump") and m.get("ref"):
            cands.append(m)
    return max(cands, key=lambda m: m.get("trainedAt") or "") if cands else None


def load_stats():
    for p in (F_STATS, BOOT / "stats.json"):
        s = read_json(p)
        if isinstance(s, dict) and s.get("buckets"):
            if p != F_STATS:
                write_json(F_STATS, s)  # 캐시가 비었을 때 사이트가 읽을 수 있게
            return s
    return None


def upbit_markets():
    out = {}
    for m in http_json("https://api.upbit.com/v1/market/all?isDetails=true"):
        code = m.get("market") or ""
        if not code.startswith("KRW-"):
            continue
        ev = m.get("market_event") or {}
        cau = ev.get("caution") or {}
        out[code] = {"name": m.get("korean_name") or code[4:], "en": m.get("english_name") or "",
                     "warn": bool(ev.get("warning")), "caution": sorted(k for k, v in cau.items() if v)}
    return out


def upbit_tickers(codes):
    out = {}
    for i in range(0, len(codes), 100):
        for t in http_json("https://api.upbit.com/v1/ticker?markets=" + ",".join(codes[i:i + 100])):
            out[t["market"]] = {"price": float(t["trade_price"]), "val24": float(t.get("acc_trade_price_24h") or 0.0),
                                "chg": float(t.get("signed_change_rate") or 0.0) * 100}
    return out


def _utc_str(ts):
    return datetime.fromtimestamp(ts, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def fetch_hourly(code, count, to):
    """끝난 시간봉 (to 직전까지, 오래된 것부터)"""
    url = f"https://api.upbit.com/v1/candles/minutes/60?market={code}&count={int(count)}&to={_utc_str(to)}"
    rows = []
    for k in http_json(url) or []:
        t = int(datetime.fromisoformat(k["candle_date_time_utc"]).replace(tzinfo=timezone.utc).timestamp())
        rows.append([t, float(f"{k['opening_price']:.10g}"), float(f"{k['high_price']:.10g}"),
                     float(f"{k['low_price']:.10g}"), float(f"{k['trade_price']:.10g}"),
                     float(f"{float(k['candle_acc_trade_volume'] or 0):.8g}")])
    rows.sort()
    return [r for r in rows if r[0] + HOUR <= to]


def fetch_daily(code):
    rows = []
    for k in http_json(f"https://api.upbit.com/v1/candles/days?market={code}&count=200") or []:
        t = int(datetime.strptime(k["candle_date_time_utc"][:10], "%Y-%m-%d").replace(tzinfo=timezone.utc).timestamp())
        rows.append((t, k["opening_price"], k["high_price"], k["low_price"], k["trade_price"], k["candle_acc_trade_volume"]))
    return clean_rows(rows)


def update_hourly(codes, store, T, budget, deadline):
    """코인마다 새 시간봉만 받는다(1건). 남는 요청으로 모자란 과거를 채운다(가장 덜 채워진 코인부터).
    from = 그 시각부터 지금까지 빠짐없이 받은 구간의 시작 (그 안에 없는 시간 = 거래 없음). upto = 끝난 봉을 다 받은 시각."""
    coins = store.setdefault("coins", {})
    cut = T - KEEP_H * HOUR
    used = fail = 0

    def save(code, st, b):
        st["b"] = [x for x in b if x[0] >= cut]
        st["from"] = max(int(st.get("from") or 0), cut)
        st["upto"] = T
        coins[code] = st

    for code in codes:
        if used >= budget or time.time() > deadline:
            break
        st = coins.get(code) or {}
        b = st.get("b") or []
        try:
            if b and st.get("upto"):
                need = (T - int(st["upto"])) // HOUR
                if need <= 0:
                    continue
                rows = fetch_hourly(code, min(200, need + 1), T)
                used += 1
                if need + 1 > 200:  # 너무 오래 못 받았으면 구멍이 생긴다 → 받은 구간부터 다시
                    b = []
                    st["from"] = rows[0][0] if len(rows) >= 200 else 0
                m = {r[0]: r for r in b}
                for r in rows:
                    m[r[0]] = r
                b = [m[k] for k in sorted(m)]
            else:
                rows = fetch_hourly(code, 200, T)
                used += 1
                st = {"from": rows[0][0] if len(rows) >= 200 else 0}
                b = rows
        except Exception as e:  # 한 코인 실패는 건너뛴다 (다음 실행에서 다시)
            fail += 1
            if fail <= 3:
                log(f"시간봉 실패 {code}: {e}")
            continue
        save(code, st, b)
    filled = 0
    for code in sorted((c for c in codes if c in coins), key=lambda c: -(coins[c].get("from") or 0)):
        st = coins[code]
        f = int(st.get("from") or 0)
        if f <= cut + HOUR or st.get("upto") != T:
            continue
        if used >= budget or time.time() > deadline:
            break
        try:
            rows = fetch_hourly(code, 200, f)
            used += 1
        except Exception:
            fail += 1
            continue
        st["from"] = rows[0][0] if len(rows) >= 200 else 0
        m = {r[0]: r for r in rows}
        for r in st["b"]:
            m[r[0]] = r
        save(code, st, [m[k] for k in sorted(m)])
        filled += 1
    store["at"] = T
    return used, fail, filled


def daily_rows(code, store, T, allow_fetch):
    """끝난 일봉 — collect.py 가 같은 실행에서 쓴 candles/upbit/*.json (200일). 그저께까지 없으면 직접 받아 캐시."""
    day0 = T - T % DAY
    p = DATA / "candles" / "upbit" / (re.sub(r"[^A-Za-z0-9._-]", "_", code) + ".json")
    rows = []
    d = read_json(p)
    if d and d.get("c"):
        try:
            written = p.stat().st_mtime
        except OSError:
            written = 0
        rows = [r for r in clean_rows(tuple(x[:6]) for x in d["c"] if len(x) >= 6) if r[0] + DAY <= written - 60]
    if rows and rows[-1][0] >= day0 - 2 * DAY:
        return [r for r in rows if r[0] + DAY <= day0], 0
    cache = (store.get("daily") or {}).get(code)
    if cache and cache.get("at", 0) >= day0:
        return [tuple(r) for r in cache["b"] if r[0] + DAY <= day0], 0
    if not allow_fetch:
        return [r for r in rows if r[0] + DAY <= day0], 0
    rows = fetch_daily(code)
    store.setdefault("daily", {})[code] = {"at": T, "b": [list(r) for r in rows]}
    return [r for r in rows if r[0] + DAY <= day0], 1


def notices_events(state):
    """업비트 공지 1쪽 → 이벤트 (입출금 일시 중단·유의 지정·거래지원 종료·신규 거래지원 …)"""
    ev = state.setdefault("events", {})
    try:
        d = http_json("https://api-manager.upbit.com/api/v1/announcements?os=web&page=1&per_page=20&category=all")
    except Exception as e:
        log(f"공지 실패: {e}")
        return
    for n in ((d or {}).get("data") or {}).get("notices") or []:
        k = notice_kind(n.get("title") or "", n.get("category") or "")
        if not k:
            continue
        codes = sorted("KRW-" + x for x in set(re.findall(r"\(([A-Z0-9]{2,12})\)", n.get("title") or "")) - {"KRW", "BTC", "USDT"})
        if not codes:
            continue
        try:
            ts = int(datetime.fromisoformat(n.get("first_listed_at") or n.get("listed_at")).timestamp())
        except (TypeError, ValueError):
            continue
        ev[str(n.get("id"))] = {"k": k, "c": codes, "ts": ts, "title": (n.get("title") or "")[:80]}
    cut = time.time() - 60 * DAY
    for key in [k for k, v in ev.items() if v.get("ts", 0) < cut]:
        ev.pop(key, None)


def notice_kind(t, cat=""):
    if "거래지원 종료" in t:
        return "delist"
    if "유의" in t and "지정" in t and "해제" not in t and "기간 연장" not in t:
        return "warn"
    if "유의" in t and "해제" in t:
        return "warn_off"
    if "신규 거래지원" in t and "KRW" in t:
        return "listing"
    if "일시 중단" in t and ("입출금" in t or "입금" in t or "출금" in t):
        return "suspend"
    if "재개" in t and ("입출금" in t or "입금" in t or "출금" in t):
        return "resume"
    return None


def anchor_rows(A, data):
    """기준 시각 A 의 전 종목 특징 (굴러가는 하루 봉) + 횡단면. 시간봉이 A 까지 없으면 그 코인의 마지막 시각으로."""
    rows, young = [], {}
    for code, d in data.items():
        at = min(A, d["upto"]) if d.get("upto") else A
        a, bars = rolling_bars(d["daily"], d["hourly"], d["from"], at)
        if a is None:
            a = at - at % DAY
            bars = [r for r in d["daily"] if r[0] + DAY <= a]
        if len(bars) < MIN_BARS:
            young[code] = len(bars)
            continue
        cols = list(zip(*bars))
        F = series_features(*(list(cols[k]) for k in range(1, 6)), want=[len(bars) - 1])
        x = {k: v[0] for k, v in F.items()}
        x["_code"] = code
        x["_anchor"] = a
        x["_close"] = bars[-1][4]
        rows.append(x)
    cross_section(rows)
    return rows, young


def vp_display(bars, price, nb=24):
    """매물대 그림용 — 최근 120봉 거래대금을 가격 칸(로그 간격 nb 개)에 나눠 0~100 으로"""
    w = bars[-VP_WIN:]
    lo = min(r[3] for r in w)
    hi = max(r[2] for r in w)
    if not (lo > 0 and hi > lo):
        return None
    a, b = LN(lo), LN(hi)
    step = (b - a) / nb
    vol = [0.0] * nb
    for r in w:
        val = r[5] * (r[2] + r[3] + r[4]) / 3.0
        x0, x1 = LN(r[3]), LN(r[2])
        if x1 <= x0:
            k = min(nb - 1, int((x0 - a) / step))
            vol[k] += val
            continue
        for k in range(max(0, int((x0 - a) / step)), min(nb, int((x1 - a) / step) + 1)):
            seg_lo, seg_hi = a + k * step, a + (k + 1) * step
            ov = min(x1, seg_hi) - max(x0, seg_lo)
            if ov > 0:
                vol[k] += val * ov / (x1 - x0)
    mx = max(vol) or 1.0
    poc = max(range(nb), key=lambda k: vol[k])
    return {"lo": rnd(lo, 6), "hi": rnd(hi, 6), "b": [int(round(100 * x / mx)) for x in vol], "poc": poc,
            "cur": rnd(price, 6)}


def _eok(x):
    """원 → '1,234억 원' / '5.3억 원' / '8,500만 원'"""
    if x is None:
        return "–"
    if x >= 1e12:
        return f"{x / 1e12:.1f}조 원"
    if x >= 1e10:
        return f"{x / 1e8:,.0f}억 원"
    if x >= 1e8:
        return f"{x / 1e8:.1f}억 원"
    return f"{x / 1e4:,.0f}만 원"


def _sp(x, d=1):
    """분수 → '+1.2%' (U+2212)"""
    return f"{x * 100:+.{d}f}%".replace("-", "−")


def _ex(x):
    return math.exp(x) - 1.0


def _updn(x, up="위예요", dn="아래예요"):
    """로그 차 → '12.3% 위예요' / '4.5% 아래예요'"""
    v = _ex(x)
    if abs(v) < 0.0005:
        return "거의 같아요"
    return f"{abs(v) * 100:.1f}% {up if v > 0 else dn}"


def _ratio(v):
    """배율 → '4.1배' · 1배 아래는 '35% 수준' ('0.0배'처럼 보이지 않게)"""
    if v >= 0.95:
        return f"{v:.1f}배"
    return f"{max(1, round(v * 100))}% 수준" if v >= 0.005 else "1%도 안 되는 수준"


def _ratio_is(v):
    """'4.1배예요' · '35% 수준이에요'"""
    return _ratio(v) + ("예요" if v >= 0.95 else "이에요")


def reason_text(f, x, X):
    """특징 하나의 값 → 숫자가 들어간 쉬운 문장 (방향은 붙이는 쪽에서)"""
    if x is None:
        return None
    if f == "bbw_pct":
        return f"볼린저밴드 폭이 최근 120일 중 {'하위' if x <= 0.5 else '상위'} {max(1, round((x if x <= 0.5 else 1 - x) * 100))}%예요"
    if f == "atr_pct":
        return f"하루 변동폭(ATR)이 최근 120일 중 {'하위' if x <= 0.5 else '상위'} {max(1, round((x if x <= 0.5 else 1 - x) * 100))}%예요"
    if f == "sq_len":
        return f"밴드가 좁은 상태(120일 중 하위 25%)가 {x:.0f}일째예요" if x >= 1 else "밴드가 좁은 구간이 아니에요"
    if f == "ov15":
        return f"지금 가격 위 +15% 안에 최근 120일 거래의 {x * 100:.0f}%가 쌓여 있어요"
    if f == "ov30":
        return f"지금 가격 위 +30% 안 매물이 최근 120일 거래의 {x * 100:.0f}%예요"
    if f == "bel15":
        return f"아래 −15% 안에 받쳐 주는 매물이 {x * 100:.0f}%예요"
    if f == "poc":
        return f"가장 많이 거래된 가격대(매물 최대)가 지금보다 {_sp(_ex(x), 0)} 자리에 있어요"
    if f == "gap":
        return f"위로 {_ex(x) * 100:.0f}%까지 매물이 얇은 구간이에요" if x > 0 else "바로 위에 매물이 두꺼워요"
    if f == "vpos":
        return f"최근 120일 거래의 {x * 100:.0f}%가 지금 가격보다 아래에서 이뤄졌어요"
    if f == "lval1":
        return f"최근 24시간 거래대금이 {_eok(math.exp(x))}이에요"
    if f == "lval5":
        return f"최근 5일 하루 평균 거래대금이 {_eok(math.exp(x))}이에요(작을수록 크게 출렁여요)"
    if f == "vr1_20":
        return f"최근 24시간 거래대금이 20일 평균의 {_ratio_is(math.exp(x))}"
    if f == "vr5_20":
        return f"최근 5일 거래대금이 20일 평균의 {_ratio_is(math.exp(x))}"
    if f == "vr20_60":
        return f"최근 20일 거래대금이 60일 평균의 {_ratio_is(math.exp(x))}"
    if f == "vslope20":
        return f"20일 거래대금 추세가 하루 {_sp(_ex(x))}씩이에요"
    if f == "vrank":
        return f"거래대금 순위가 업비트 원화 코인 중 상위 {max(1, round((1 - x) * 100))}%예요"
    if f == "vrank_chg":
        return f"거래대금 순위가 20일 전보다 {x * 100:+.0f}%p {'올라갔어요' if x > 0 else '내려갔어요'}".replace("-", "−")
    if f == "spike_max10":
        return f"최근 10일 중 하루 거래대금이 20일 평균의 {_ratio(math.exp(x))}까지 붙었어요"
    if f == "spike_hold":
        return f"거래가 가장 많던 날보다 지금 가격이 {_sp(_ex(x))}예요"
    if f == "obv20":
        return f"20일 동안 오른 날 거래대금이 내린 날보다 {'많았어요' if x > 0 else '적었어요'}(OBV {x:+.2f})".replace("-", "−")
    if f == "hi60":
        return f"60일 고점보다 {(1 - math.exp(x)) * 100:.0f}% 아래예요" if x < -0.005 else "60일 고점 자리예요"
    if f == "hi120":
        return f"120일 고점보다 {(1 - math.exp(x)) * 100:.0f}% 아래예요" if x < -0.005 else "120일 고점 자리예요"
    if f == "lo60":
        return f"60일 저점보다 {_ex(x) * 100:.0f}% 위예요"
    if f == "c_ma20":
        return f"20일 평균 가격보다 {_updn(x)}"
    if f == "ma5_20":
        return f"5일 평균선이 20일선보다 {_updn(x)}"
    if f == "ma20_60":
        return f"20일 평균선이 60일선보다 {_updn(x)}"
    if f == "hl1":
        return f"최근 10일 저점이 그 전 10일 저점보다 {_updn(x, '높아요', '낮아요')}"
    if f == "hl2":
        return f"10~20일 전 저점이 그 전 10일보다 {_updn(x, '높아요', '낮아요')}"
    if f == "atrp":
        return f"하루 평균 변동폭(ATR)이 {x * 100:.1f}%예요"
    if f == "vol20":
        return f"하루 수익률이 보통 ±{x * 100:.1f}% 흔들려요(20일 표준편차)"
    if f == "bbw":
        return f"볼린저밴드 폭이 가격의 {x * 100:.0f}%예요"
    if f == "atr_xs":
        return f"변동성이 업비트 원화 코인 중 상위 {max(1, round((1 - x) * 100))}%예요"
    if f == "rsi":
        return f"RSI {x:.0f}"
    if f in ("ret1", "ret3", "ret7", "ret14", "ret30"):
        span = {"ret1": "최근 24시간", "ret3": "최근 3일", "ret7": "최근 7일", "ret14": "최근 14일", "ret30": "최근 30일"}[f]
        return f"{span} {_sp(_ex(x))}"
    if f == "run30":
        return f"30일 안 최고가가 30일 전 가격보다 {_sp(_ex(x), 0)}였어요"
    if f == "dd30":
        return f"30일 최고가보다 {(1 - math.exp(x)) * 100:.0f}% 내려와 있어요" if x < -0.005 else "30일 최고가 자리예요"
    if f == "own_mfe60":
        return f"이 코인의 평소(최근 60일) ‘3일 안 최고’ 중앙값은 {_sp(x)}예요"
    if f == "own_pump120":
        return f"최근 120일 중 {x * 100:.0f}%의 날이 그 뒤 3일 안 +15% 올랐어요"
    if f == "own_pump30":
        return f"최근 30일 중 {x:.0f}일이 그 뒤 3일 안 +15% 올랐어요"
    if f == "lage":
        n = math.exp(x)
        return "상장(또는 기록 시작) 180일이 넘었어요" if n >= 179.5 else f"상장 {n:.0f}일째예요"
    if f == "mkt_pump3":
        return f"시장 분위기: 3일 전 기준 업비트 코인의 {x * 100:.0f}%가 3일 안 +15% 펌핑했어요"
    if f == "breadth":
        return f"시장 분위기: 20일 평균 위에 있는 코인이 {x * 100:.0f}%예요"
    if f == "mkt_vr":
        return f"시장 전체 거래대금(5일/20일)이 {math.exp(x):.2f}배예요"
    if f == "mkt_ret1":
        return f"코인 전체 24시간 중앙값 {_sp(_ex(x))}"
    if f == "mkt_ret3":
        return f"코인 전체 3일 중앙값 {_sp(_ex(x))}"
    if f == "mkt_atr":
        return f"시장 평균 하루 변동폭 {x * 100:.1f}%"
    if f in ("btc_ret1", "btc_ret7", "btc_ret30"):
        span = {"btc_ret1": "24시간", "btc_ret7": "7일", "btc_ret30": "30일"}[f]
        return f"비트코인 {span} {_sp(_ex(x))}"
    if f == "btc_vol20":
        return f"비트코인 하루 흔들림 ±{x * 100:.1f}%"
    return None


def make_reasons(res, x):
    """로지스틱 부분의 기여가 큰 특징 → 근거 (올린 쪽 3개 + 내린 쪽 2개, 시장 분위기는 하나만)"""
    con = res["contrib"]
    ups = sorted((f for f in con if con[f] > 0.02), key=lambda f: -con[f])
    dns = sorted((f for f in con if con[f] < -0.02), key=lambda f: con[f])
    out = []
    for lst, tone, cap in ((ups, "up", 3), (dns, "down", 2)):
        n = mk = 0
        for f in lst:
            if n >= cap:
                break
            if GROUP_OF[f] == "market":
                if mk:
                    continue
                mk = 1
            t = reason_text(f, x.get(f), x)
            if not t:
                continue
            out.append({"k": f, "g": GROUP_OF[f], "t": t, "tone": tone, "w": rnd(con[f], 3)})
            n += 1
    return out


def make_risks(x, res, info, tick, news, ages, stats, ev_recent):
    """위험 — 점수와 별개. lv 1 = 주의, 2 = 높음"""
    out = []
    risk = (stats or {}).get("risk") or {}
    rsi = x.get("rsi")
    cm = x.get("c_ma20")
    r3 = x.get("ret3")
    if rsi is not None and cm is not None and rsi >= 75 and _ex(cm) >= 0.20:
        h = risk.get("heat")
        extra = f" — 과거 이런 자리의 72시간 급락 비율 {h['dump'] * 100:.0f}%(평소 {stats['base']['dump'] * 100:.0f}%)" if h else ""
        out.append({"k": "heat", "lv": 2, "t": f"과열: RSI {rsi:.0f}, 20일 평균보다 {_sp(_ex(cm), 0)}{extra}"})
    elif (rsi is not None and rsi >= 70) or (r3 is not None and _ex(r3) >= 0.30):
        out.append({"k": "heat", "lv": 1, "t": f"많이 올랐어요: RSI {rsi:.0f}, 최근 3일 {_sp(_ex(r3 or 0), 0)}"})
    v24 = (tick or {}).get("val24")
    v20 = x.get("_v20rank")
    thin = (v20 is not None and v20 < LIQ_PCT) or (v24 is not None and v24 < LIQ_MIN)
    why = []
    if v20 is not None and v20 < LIQ_PCT:
        why.append(f"20일 거래대금 업비트 원화 하위 {max(1, round(v20 * 100))}%")
    if v24 is not None:
        why.append(f"24시간 {_eok(v24)}")
    if v24 is not None and v24 < LIQ_THIN:
        out.append({"k": "liq", "lv": 2, "chip": thin, "t": f"거래가 아주 적어요({' · '.join(why)}) — 호가가 비어 있어 예상 %대로 "
                                                             "사고팔기 어려울 수 있어요(미끄러짐)"})
    elif thin:
        out.append({"k": "liq", "lv": 1, "chip": True, "t": f"거래가 적어요({' · '.join(why)})"})
    pdm = res.get("pDump") or 0
    if pdm >= 0.15:
        out.append({"k": "dump", "lv": 2, "t": f"급락 위험: 과거 같은 자리의 {pdm * 100:.0f}%가 72시간 안에 −15% 넘게 빠졌어요"
                                              f"(평소 {((stats or {}).get('base') or {}).get('dump', 0.06) * 100:.0f}%)"})
    elif pdm >= 0.10:
        out.append({"k": "dump", "lv": 1, "t": f"급락 확률 {pdm * 100:.0f}%(72시간 안 −15%)"})
    run, dd = x.get("run30"), x.get("dd30")
    if run is not None and dd is not None and _ex(run) >= 0.5 and _ex(dd) <= -0.3:
        out.append({"k": "pumpdump", "lv": 1, "t": f"최근 30일 {_sp(_ex(run), 0)} 오른 뒤 고점에서 {_sp(_ex(dd), 0)} — 펌핑 뒤 급락 이력"})
    age = ages.get(x["_code"])
    if age is not None and age < 30:
        out.append({"k": "new", "lv": 2, "t": f"상장 {age}일째 — 업비트 신규 상장 코인은 과거 7일 수익 중앙값이 −11%였어요"})
    if info.get("warn"):
        out.append({"k": "warn", "lv": 2, "t": "업비트 투자유의 종목이에요(거래지원 종료 가능성)"})
    cau = {"PRICE_FLUCTUATIONS": "가격 급등락", "TRADING_VOLUME_SOARING": "거래량 급등", "DEPOSIT_AMOUNT_SOARING": "입금량 급등",
           "GLOBAL_PRICE_DIFFERENCES": "해외 가격과 차이", "CONCENTRATION_OF_SMALL_ACCOUNTS": "소수 계정 거래 집중"}
    cs = [cau.get(k, k) for k in info.get("caution") or []]
    if cs:
        out.append({"k": "caution", "lv": 1, "t": "업비트 주의 표시: " + "·".join(cs)})
    tags = set((news or {}).get("tags") or [])
    if tags & {"delist", "hack"}:
        out.append({"k": "news", "lv": 2, "t": "최근 상폐·유의·해킹 관련 소식이 있어요"})
    for e in ev_recent:
        if e["k"] in ("delist", "warn"):
            out.append({"k": "notice", "lv": 2, "t": f"업비트 공지({kst_label(e['ts'])}): {e['title']}"})
    return out


AI_SYS = ("너는 업비트 코인 데이터를 쉬운 한국어로 설명하는 사람이야. 해요체로 1~2문장, 130자 안으로 써. "
          "주어진 숫자만 쓰고 새 숫자를 지어내지 마. '사세요·파세요·오를 거예요·추천' 같은 권유나 장담은 절대 하지 마. "
          "왜 점수가 높은지(근거)와 조심할 점(위험)을 함께 말해. 이모지·느낌표 쓰지 마. "
          "점수를 말할 때는 화면의 큰 숫자인 '후보 점수'(급락 위험을 뺀 점수)를 써. 펌핑 점수와의 차이는 '두 점수 차이' 항목이 있을 때만, "
          "그 항목에 적힌 방향 그대로 말해(방향을 바꾸거나 지어내지 마).")
AI_VER = "v2"  # 문장 규칙(AI_SYS·facts)을 바꾸면 올린다 — 예전 규칙으로 쓴 저장 문장을 다시 쓰게
AI_BAN = ("사세요", "매수하", "파세요", "매도하", "오를 거", "오를 것", "추천", "확실", "보장", "!")


RISK_TAIL = {"heat": "과열 구간이에요", "liq": "거래가 적어 표시된 값에 사고팔기 어려울 수 있어요", "pumpdump": "최근 펌핑 뒤 급락한 이력이 있어요",
             "new": "상장한 지 얼마 안 됐어요", "warn": "업비트 투자유의 종목이에요", "caution": "업비트 주의 표시가 붙어 있어요",
             "news": "상폐·해킹 관련 소식이 있어요", "notice": "상폐·유의 관련 공지가 있어요"}


def rule_text(it, stats):
    """AI 가 없을 때의 설명 — 점수를 올린 근거 두 개 + 가장 큰 위험(없으면 급락 확률)"""
    ups = [r["t"] for r in it["reasons"] if r["tone"] == "up"][:2] or ["여러 지표가 고르게 펌핑 쪽이에요"]
    rk = sorted(it["risks"], key=lambda r: -r["lv"])
    if rk and rk[0]["k"] in RISK_TAIL:
        tail = RISK_TAIL[rk[0]["k"]]
    else:
        tail = f"72시간 안 −15% 급락 확률도 {it['pDump'] * 100:.0f}%예요"
    return " ".join(u.rstrip(".") + "." for u in ups) + f" 다만 {tail}."


def _gap_text(it):
    """후보 점수와 펌핑 점수가 10점 넘게 다를 때 그 방향과 까닭 (AI 가 방향을 거꾸로 말하지 않게 코드가 정한다)"""
    d = it["cand"] - it["score"]
    if d >= 10:
        return f"후보 점수({round(it['cand'])})가 펌핑 점수({round(it['score'])})보다 높아요 — 급락 확률이 다른 코인보다 낮아서예요"
    if d <= -10:
        return f"후보 점수({round(it['cand'])})가 펌핑 점수({round(it['score'])})보다 낮아요 — 급락 확률이 다른 코인보다 높아서예요"
    return None


def ai_texts(items, state, stats, now, max_calls=5):
    """상위 10개(화면 순서대로) — 후보 점수 10점 칸·앞쪽 근거 2개·위험 단계가 바뀌었거나 48시간이 지났을 때만 새로 쓴다
    (ai.write: 클로드 하이쿠 → 안 되면 무료 Gemma → 둘 다 안 되면 None 이라 규칙 문장). 한 실행 최대 max_calls 번."""
    try:
        import ai  # 클로드 연결 담당의 collector/ai.py
    except Exception:
        ai = None
    cache = state.setdefault("ai", {})
    calls = 0
    top = ((stats or {}).get("bucketsCand") or [{}])[0]
    for it in items:
        key = "|".join([AI_VER, str(int(it["cand"] // 10)), ",".join(r["k"] for r in it["reasons"][:2]),
                        str(max([r["lv"] for r in it["risks"]] or [0]))])
        c = cache.get(it["code"])
        if c and c.get("key") == key and now - c.get("at", 0) < 48 * HOUR and c.get("by") != "rule":
            it["ai"], it["aiBy"] = c["text"], c.get("by")
            continue
        text, by = None, "rule"
        if ai is not None and calls < max_calls and now - state.get("aiFail", 0) > 2 * HOUR:
            facts = {"코인": f"{it['name']}({it['code'][4:]})", "후보 점수(0~100, 화면의 큰 숫자 · 급락 위험을 뺀 점수)": round(it["cand"]),
                     "펌핑 점수(0~100, 급락 위험 빼기 전)": round(it["score"]),
                     "두 점수 차이": _gap_text(it),
                     "3일 안 최고 예상(중앙값)": _sp(it["mfe"][1]),
                     "3일 뒤 예상": f"{_sp(it['r72'][1])} (10번 중 8번은 {_sp(it['r72'][0], 0)} ~ {_sp(it['r72'][2], 0)})",
                     "72시간 안 +15% 펌핑 확률": f"{it['pPump'] * 100:.0f}%", "72시간 안 −15% 급락 확률": f"{it['pDump'] * 100:.0f}%",
                     "근거": [r["t"] for r in it["reasons"]], "위험": [r["t"] for r in it["risks"]],
                     "과거 후보 점수 90 이상": (f"펌핑 {top['pump'] * 100:.0f}% · 급락 {top['dump'] * 100:.0f}% · "
                                     f"3일 뒤 중앙값 {_sp(top['medR72'])}") if top.get("pump") is not None else None}
            try:
                calls += 1
                text = ai.write(who="pump", system=AI_SYS, user=json.dumps(facts, ensure_ascii=False), max_tokens=300)
            except Exception as e:
                log(f"AI 문장 실패: {e}")
                text = None
            if isinstance(text, str):
                text = re.sub(r"\s+", " ", text).strip().strip('"')
                if not text or len(text) > 220 or any(b in text for b in AI_BAN):
                    text = None
            else:
                text = None
            if text:
                try:
                    by = (ai.last("pump") or {}).get("provider") or "ai"
                except Exception:
                    by = "ai"
                cache[it["code"]] = {"key": key, "text": text, "by": by, "at": now}
            else:
                state["aiFail"] = now  # 실패하면 2시간 쉬었다가 (규칙 문장으로)
        if not text:
            text = rule_text(it, stats)
        it["ai"], it["aiBy"] = text, by
    for code in [c for c, v in cache.items() if now - v.get("at", 0) > 7 * DAY]:
        cache.pop(code, None)
    return calls


def grade_log(lg, store, now):
    """72시간이 지난 신호를 시간봉으로 채점"""
    coins = store.get("coins") or {}
    for it in lg["items"]:
        if it.get("status") != "wait":
            continue
        t = it["t"]
        if now < t + 72 * HOUR + 600:
            continue
        b = [r for r in (coins.get(it["code"]) or {}).get("b") or [] if t <= r[0] < t + 72 * HOUR]
        st = coins.get(it["code"]) or {}
        if not b or (st.get("upto") or 0) < t + 72 * HOUR:
            if now > t + 10 * DAY:
                it["status"] = "na"
            continue
        p0 = it["price"]
        mfe = max(r[2] for r in b) / p0 - 1
        mae = min(r[3] for r in b) / p0 - 1
        r72 = b[-1][4] / p0 - 1
        b24 = [r for r in b if r[0] < t + 24 * HOUR]
        r24 = b24[-1][4] / p0 - 1 if b24 else None
        kind = "both" if (mfe >= PUMP and mae <= DUMP) else "pump" if mfe >= PUMP else "dump" if mae <= DUMP else "none"
        it["res"] = {"mfe": rnd(mfe, 4), "mae": rnd(mae, 4), "r72": rnd(r72, 4), "r24": rnd(r24, 4), "kind": kind}
        it["status"] = "done"


def log_summary(lg):
    done = [x for x in lg["items"] if x.get("status") == "done"]
    if not done:
        return {"n": len(lg["items"]), "graded": 0}
    k = [x["res"]["kind"] for x in done]
    r72 = sorted(x["res"]["r72"] for x in done)
    mfe = sorted(x["res"]["mfe"] for x in done)
    pred = sorted(x["mfe"][1] for x in done)
    return {"n": len(lg["items"]), "graded": len(done), "pump": sum(z in ("pump", "both") for z in k) / len(done),
            "dump": sum(z in ("dump", "both") for z in k) / len(done), "medR72": _median(r72) - FEE,
            "medMfe": _median(mfe), "predMfe": _median(pred)}


def placeholder(reason):
    write_json(F_OUT, {"version": 1, "updatedAt": iso(time.time()), "asOf": None, "items": [], "all": [], "young": [],
                       "note": reason})


def run(args):
    t0 = time.time()
    now = time.time()
    T = int(now // HOUR * HOUR)
    M = load_model()
    if not M:
        placeholder("펌핑 점수 모델을 준비하고 있어요.")
        log("모델 없음 — 자리 표시만")
        return 0
    stats = load_stats()
    state = read_json(F_STATE, {}) or {}
    store = read_json(F_BARS, {}) or {}
    deadline = t0 + args.minutes * 60
    offline = args.offline
    # 1) 종목·시세·공지
    if offline:
        cj = read_json(DATA / "coins.json", {}) or {}
        markets = {c: {"name": v[0], "en": v[1], "warn": bool(v[2]) if len(v) > 2 else False, "caution": []}
                   for c, v in (cj.get("upbit") or {}).items()}
        scr = {r["sym"].split(":", 1)[1]: r for r in (read_json(DATA / "screener" / "upbit.json", {}) or {}).get("rows") or []}
        ticks = {c: {"price": r.get("price"), "val24": r.get("vol"), "chg": r.get("chg")} for c, r in scr.items()}
    else:
        markets = upbit_markets()
        ticks = upbit_tickers(sorted(markets))
        notices_events(state)
    codes = [c for c in markets if c[4:] not in STABLE]
    codes.sort(key=lambda c: -((ticks.get(c) or {}).get("val24") or 0))
    # 2) 시간봉 (코인당 1건 + 남는 요청으로 과거 채우기) · 일봉
    used = fail = filled = 0
    max_req = args.max_req or MAX_REQ
    if not offline:
        used, fail, filled = update_hourly(codes, store, T, max_req - NET["n"] - 5, deadline)
    data, n_daily = {}, 0
    coins_store = store.get("coins") or {}
    for c in codes:
        allow = (not offline) and NET["n"] < max_req + 260 and time.time() < deadline + 120
        try:
            daily, k = daily_rows(c, store, T, allow)
        except Exception as e:
            log(f"일봉 실패 {c}: {e}")
            continue
        n_daily += k
        st = coins_store.get(c) or {}
        data[c] = {"daily": daily, "hourly": [tuple(r) for r in st.get("b") or []],
                   "from": st.get("from") if st.get("b") is not None else None, "upto": st.get("upto"), "nd": len(daily)}
    ages = {c: d["nd"] for c, d in data.items() if d["nd"] < 190}  # 일봉 파일(200개)보다 짧으면 = 상장 뒤 날수
    log(f"요청 {NET['n']}건(시간봉 {used} · 과거 채움 {filled} · 일봉 {n_daily} · 실패 {fail} · 429 {NET['429']}) "
        f"{time.time() - t0:.0f}초")
    # 3) 계산할 기준 시각들 — 빠진 시간도 최대 MAX_ANCHORS 개 채운다. 처음이면 지난 14일 매일 09시(일봉)도.
    hist = state.setdefault("hist", {})
    last = state.get("lastAnchor")
    anchors = [T] if not last or int(last) >= T else \
        list(range(max(int(last) + HOUR, T - (MAX_ANCHORS - 1) * HOUR), T + HOUR, HOUR))
    if not hist:
        day0 = T - T % DAY
        for k in range(14, 0, -1):
            A = day0 - (k - 1) * DAY if k > 1 else day0
            if A >= T:
                continue
            dd = {c: {**d, "from": None, "upto": None} for c, d in data.items()}
            rows, _ = anchor_rows(A, dd)
            for x in rows:
                r0 = score_one(M, x)
                hist.setdefault(x["_code"], []).append([A, round(r0["cand"], 1), round(r0["score"], 1)])
        log(f"점수 이력 처음 채움: 지난 14일 매일 09시 {sum(len(v) for v in hist.values())}점")
    lg = read_json(F_LOG, {}) or {}
    lg.setdefault("items", [])
    sig = state.setdefault("sig", {})
    latest = None
    for A in anchors:
        rows, young = anchor_rows(A, data)
        res = {}
        for x in rows:
            r = score_one(M, x)
            res[x["_code"]] = (x, r)
            hh = hist.setdefault(x["_code"], [])
            if hh and hh[-1][0] >= A:  # 같은 시각을 다시 계산하면 바꿔 쓴다
                while hh and hh[-1][0] >= A:
                    hh.pop()
            prev = hh[-1][1] if hh else None
            hh.append([A, round(r["cand"], 1), round(r["score"], 1)])
            # 실제 신호: 후보 점수가 기준 이상으로 올라선 순간 (같은 코인 72시간에 한 번) — 백테스트 signalRule 과 같은 규칙
            if (r["cand"] >= SIG_THR and (prev is None or prev < SIG_THR) and A - int(sig.get(x["_code"], 0)) >= SIG_GAP
                    and A >= T - MAX_ANCHORS * HOUR and x["_anchor"] == A):
                sig[x["_code"]] = A
                info = markets.get(x["_code"]) or {}
                lg["items"].append({"code": x["_code"], "name": info.get("name") or x["_code"][4:], "t": A,
                                    "seen": int(now), "price": rnd(x["_close"], 8), "score": round(r["cand"], 1),
                                    "pumpScore": round(r["score"], 1),
                                    "mfe": [rnd(v, 4) for v in r["mfe"]], "r72": [rnd(v, 4) for v in r["r72"]],
                                    "pPump": rnd(r["pPump"], 3), "pDump": rnd(r["pDump"], 3), "status": "wait"})
        latest = (A, rows, res, young)
    state["lastAnchor"] = T
    cutoff = T - HIST_H * HOUR
    for c in list(hist):
        hist[c] = [p for p in hist[c] if p[0] > cutoff]
        if not hist[c]:
            hist.pop(c)
    # 4) 상위 30개 자세히
    A, rows, res, young = latest
    news = (read_json(DATA / "news_state.json", {}) or {}).get("coins") or {}
    ev = state.get("events") or {}
    ranked = sorted(res.values(), key=lambda p: -p[1]["score"])
    # 기본 순서: 후보 점수(= 펌핑 확률 − W_NET × 급락 확률 의 백분위) — 둘 다 같은 점수대의 실제 비율로 보정된 값
    net_rank = {p[0]["_code"]: k for k, p in enumerate(sorted(res.values(), key=lambda p: (-p[1]["cand"], -p[1]["net"])), 1)}
    items, allrows = [], []
    for rank, (x, r) in enumerate(ranked, 1):
        code = x["_code"]
        info = markets.get(code) or {}
        tick = ticks.get(code) or {}
        ev_recent = sorted((e for e in ev.values() if code in (e.get("c") or []) and now - e["ts"] < 3 * DAY),
                           key=lambda e: -e["ts"])
        risks = make_risks(x, r, info, tick, news.get(code[4:]), ages, stats, ev_recent)
        lv = max([k["lv"] for k in risks] or [0])
        allrows.append([code, info.get("name") or code[4:], round(r["cand"], 1), round(r["score"], 1), rnd(r["mfe"][1], 3),
                        rnd(r["r72"][1], 3), rnd(r["pPump"], 3), rnd(r["pDump"], 3), lv, rnd(tick.get("val24"), 4)])
        if rank > TOP_N and net_rank[code] > TOP_N:
            continue
        reasons = make_reasons(r, x)
        for e in ev_recent:
            if e["k"] == "suspend":
                es = ((stats or {}).get("events") or {}).get("suspend")
                extra = (f" — 과거 이런 공지 뒤 2일 펌핑 비율 {es['pump'] * 100:.0f}%(점수가 말한 {es['pred'] * 100:.0f}%, {es['n']}건)"
                         if es else "")
                reasons.append({"k": "notice", "g": "notice", "t": f"업비트 입출금 일시 중단 공지({kst_label(e['ts'])}){extra}",
                                "tone": "flat"})
                break
        hh = hist.get(code) or []
        grid, gridp = [None] * HIST_H, [None] * HIST_H
        t_first = T - (HIST_H - 1) * HOUR
        for p_ in hh:
            k = (p_[0] - t_first) // HOUR
            if 0 <= k < HIST_H:
                grid[k] = int(round(p_[1]))
                if len(p_) > 2:
                    gridp[k] = int(round(p_[2]))
        d = data[code]
        a2, bars = rolling_bars(d["daily"], d["hourly"], d["from"], min(A, d["upto"] or A))
        if a2 is None:
            bars = [b for b in d["daily"] if b[0] + DAY <= A - A % DAY]
        h24 = [p for p in hh if p[0] <= A - 24 * HOUR]
        items.append({
            "code": code, "sym": "upbit:" + code, "name": info.get("name") or code[4:], "en": info.get("en"), "rank": rank,
            "rankNet": net_rank[code], "net": rnd(r["net"], 3), "cand": round(r["cand"], 1),
            "d24": round(r["cand"] - h24[-1][1], 1) if h24 else None,
            "score": round(r["score"], 1), "d24p": round(r["score"] - h24[-1][2], 1) if h24 and len(h24[-1]) > 2 else None,
            "mfe": [rnd(v, 4) for v in r["mfe"]], "r72": [rnd(v, 4) for v in r["r72"]], "r24": rnd(r["r24"], 4),
            "pPump": rnd(r["pPump"], 3), "pDump": rnd(r["pDump"], 3), "own": rnd(x.get("own_mfe60"), 4),
            "price": rnd(x["_close"], 8), "val24": rnd(tick.get("val24"), 4), "chg24": rnd(tick.get("chg"), 4),
            "parts": {g: int(round(v)) for g, v in r["parts"].items()}, "reasons": reasons, "risks": risks, "riskLv": lv,
            # 점수 이력: 쉼표로 이은 글자 (빈 칸 = 그 시간 값 없음) — JSON null 보다 작다
            "hist": ",".join("" if v is None else str(v) for v in grid),
            "histP": ",".join("" if v is None else str(v) for v in gridp), "vp": vp_display(bars, x["_close"]) if bars else None,
            "stale": (A - (d["upto"] or A)) >= 3 * HOUR,
            "anchor": x["_anchor"]})
    # 화면 기본 순서(급락 위험 뺀 순 = rankNet)의 위쪽부터 문장을 쓴다 — 펌핑 점수 순 위쪽은 그다음
    targets = sorted((it for it in items if it["rank"] <= 10 or it["rankNet"] <= 10),
                     key=lambda it: (it["rankNet"] > 10, it["rankNet"], it["rank"]))
    calls = ai_texts(targets, state, stats, now) if not args.no_ai else 0
    if args.no_ai:
        for it in targets:
            it["ai"], it["aiBy"] = rule_text(it, stats), "rule"
    # 5) 신호 채점 · 기록
    grade_log(lg, store, now)
    lg["items"] = lg["items"][-LOG_KEEP:]
    lg.update({"version": 1, "updatedAt": iso(now), "thr": SIG_THR, "summary": log_summary(lg),
               "backtest": next((b for b in ((stats or {}).get("signalRule") or [])), None)})
    young_list = [{"code": c, "name": (markets.get(c) or {}).get("name") or c[4:], "days": n,
                   "val24": rnd((ticks.get(c) or {}).get("val24"), 4)} for c, n in sorted(young.items(), key=lambda z: z[1])]
    mk = rows[0] if rows else {}
    rthr = (M.get("regime") or {}).get("pump7Thr")
    hot = bool(rthr is not None and mk.get("mkt_pump7") is not None and mk["mkt_pump7"] >= rthr)
    down = bool(mk.get("btc_ret7") is not None and mk["btc_ret7"] < 0)
    regime = {"hot": hot, "btcDown": down, "warn": hot or down, "mktPump7": rnd(mk.get("mkt_pump7"), 4), "thr": rnd(rthr, 4),
              "btc7": rnd(mk.get("btc_ret7"), 4),
              "stats": [x for x in ((stats or {}).get("regimes") or []) if (x["key"] == "hot" and hot) or (x["key"] == "btcdown" and down)]}
    out = {
        "version": 1, "updatedAt": iso(now), "asOf": iso(A), "asOfKst": kst_label(A),
        "def": {"h": 72, "pump": PUMP, "dump": DUMP, "fee": FEE, "sigThr": SIG_THR},
        "model": {"trainedAt": M.get("trainedAt"), "dataTo": M.get("dataTo"), "rows": M.get("rows")},
        "count": len(ranked), "items": items, "all": allrows, "young": young_list, "regime": regime, "wNet": W_NET,
        "market": {k: rnd(mk.get(k), 4) for k in ("mkt_pump3", "breadth", "mkt_ret1", "mkt_ret3", "btc_ret1", "btc_ret7", "mkt_atr")},
        "summary": {"verdict": (stats or {}).get("verdict"), "lines": ((stats or {}).get("lines") or [])[:2],
                    "base": (stats or {}).get("base"), "top": ((stats or {}).get("bucketsCand") or [None])[0],
                    "topPump": ((stats or {}).get("buckets") or [None])[0],
                    "orders": ((stats or {}).get("orders") or [None])[0]},
        "net": {"req": NET["n"], "fail": NET["fail"], "r429": NET["429"], "ai": calls},
        "secs": round(time.time() - t0, 1)}
    write_json(F_OUT, out)
    write_json(F_LOG, lg)
    write_json(F_STATE, state)
    write_json(F_BARS, store)
    best = min(items, key=lambda z: z["rankNet"]) if items else None
    log(f"점수 {len(ranked)}개 · 후보 1위 {best['name'] if best else '-'} {best['cand'] if best else ''} · 기준 {kst_label(A)} · "
        f"신호 {sum(1 for x in lg['items'] if x['t'] == A)}개 · AI {calls}건 · {time.time() - t0:.0f}초 · "
        f"pump.json {F_OUT.stat().st_size / 1024:.0f}KB")
    return 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--train", action="store_true", help="워크포워드 검증 + 최종 학습 (numpy·lightgbm)")
    ap.add_argument("--if-stale", type=float, default=0, help="--train: 이 시간 안에 학습했으면 건너뜀")
    ap.add_argument("--boot", action="store_true", help="--train: collector/pump/ 의 처음용 모델·검증도 갱신")
    ap.add_argument("--hist", default="", help="--train: 일봉 이력 폴더 (기본 collector/.history/upbit)")
    ap.add_argument("--save-oos", default="", help="--train: 표본 밖 예측을 이 파일(pickle)로 (연구용)")
    ap.add_argument("--offline", action="store_true", help="받지 않고 저장된 봉으로만")
    ap.add_argument("--no-ai", action="store_true", help="AI 문장 없이 규칙 문장만")
    ap.add_argument("--minutes", type=float, default=4.0, help="받기 마감(분)")
    ap.add_argument("--max-req", type=int, default=0, help=f"한 실행 요청 상한 (기본 {MAX_REQ})")
    args = ap.parse_args()
    if args.train:
        return train(args)
    try:
        return run(args)
    except Exception as e:
        import traceback
        traceback.print_exc()
        print(f"::warning title=펌핑 후보::{e}", flush=True)
        return 1


if __name__ == "__main__":
    sys.exit(main())
