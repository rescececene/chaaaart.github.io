"""전략 탭(매매 자리) — 일봉으로 '분출 임박·돌파·눌림목…' 같은 자리를 찾고, 과거 일봉으로 효과를 검증한다

1) 판정 — 표준 라이브러리만 (collect.py 가 10분마다 종목마다 부른다)
       setups.detect(cs, market) → [{"k": 키, "s": 점수 0~100, "r": [근거 …]}]   켜진 것만, 점수 높은 순
   cs 는 sources.daily() 일봉 (마지막 봉은 진행 중일 수 있다 — 스크리너의 다른 신호와 같은 기준).
   모든 판정은 i 번째 봉 종가까지의 값만 본다 (지표는 indicators.py 의 함수를 그대로 쓴다).

2) 백데이터 검증 — numpy·pandas 필요 (예측 엔진과 같은 환경, 하루 1번이면 충분)
       python collector/setups.py --stats                     # collector/.history → web/public/data/setups_stats.json
       python collector/setups.py --stats --if-stale 20       # 결과가 20시간 안쪽이면 건너뜀 (10분 주기 Actions 용)
       python collector/setups.py --stats --markets krx --out FILE --limit 50 --boot 2000
   - 과거 각 날짜 d 에 그날 종가까지로 판정 → d 다음 봉 시가에 사서 d+H 봉 종가까지의 수익 (H = 5·20봉)
   - 같은 날 같은 시장 전 종목(그날 판정 가능했던 종목)의 같은 수익 평균을 빼서 '초과 수익'으로 본다
   - 같은 종목에서 H 봉 안에 다시 켜진 날은 겹치는 표본이라 뺀다 (첫 신호만)
   - 평균·신뢰구간은 극단값을 시장 전체 초과 수익의 1%·99% 지점에서 잘라 계산 (중앙값·오른 비율은 원래 값)
   - 신뢰구간: 날짜를 H 봉 길이 묶음으로 나눠 묶음째 다시 뽑는 부트스트랩 (같은 시기에 몰린 신호끼리의 상관 반영)
   - 이력에는 지금 목록 + 최근 1년 안에 빠진 종목만 있다 → 그 전에 상장폐지된 종목은 빠져 있다(생존 편향)
"""
import argparse
import json
import math
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import indicators as ind

HERE = Path(__file__).resolve().parent
OUT_FILE = HERE.parent / "web" / "public" / "data" / "setups_stats.json"
HIST_DIR = HERE / ".history"
HORIZONS = (5, 20)
HIGH_LOOK = 250  # 신고가·고점 대비 낙폭을 보는 최대 봉 수 (indicators.analyze 의 lookback 과 같은 규칙)
SQUEEZE_WIN = 120  # 밴드 폭·변동폭이 '낮은 편'인지 비교하는 기간
COINS = ("upbit", "binance")

# (키, 이모지, 이름, 한 줄 설명, 기대 방향: +1 오를 자리 · -1 조심할 자리) — 탭 순서
DEFS = (
    ("squeeze_breakout", "🚀", "분출 임박", "변동폭이 줄어든 채 고점 바로 아래에서 거래량이 붙기 시작했어요", 1),
    ("breakout", "⚡", "돌파", "20일 고점을 거래량 2배 이상과 함께 넘었어요", 1),
    ("new_high", "🆕", "신고가", "최근 1년(코인은 200~250일) 중 가장 높은 값을 종가로 넘었어요", 1),
    ("volume_surge", "🔥", "거래량 폭발", "거래량이 20일 평균의 3배를 넘었어요", 1),
    ("uptrend", "📈", "상승 추세", "이동평균 정배열에 추세 강도(ADX)도 강해요", 1),
    ("pullback", "🎯", "눌림목", "상승 추세 속에 20일선 근처까지 쉬어 왔어요", 1),
    ("golden_cross", "✨", "골든크로스 직후", "20일선이 60일선을 막 뚫고 올라섰어요", 1),
    ("bottoming", "🧱", "바닥 다지기", "크게 빠진 뒤 저점을 더 깨지 않고 20일선을 되찾았어요", 1),
    ("oversold_bounce", "💧", "낙폭 과대 반등", "과하게 빠진 뒤 반등이 시작됐어요", 1),
    ("overheat", "🌡️", "과열 주의", "단기간에 너무 올라 RSI·이격도가 과열 구간이에요", -1),
    ("downtrend_warn", "⚠️", "하락 경고", "역배열·지지선 이탈 등 하락 추세가 뚜렷해요", -1),
)
KEYS = tuple(d[0] for d in DEFS)
DIRECTION = {d[0]: d[4] for d in DEFS}

# 시장 성격별 문턱값 (코인은 하루 변동이 주식의 2배쯤이라 넓게)
PARAMS = {
    "stock": {"near": 0.05, "band": 0.02, "drop": (0.03, 0.15), "disp": 90.0, "dd": 0.30, "base": 0.20, "heat": 0.12},
    "coin": {"near": 0.08, "band": 0.03, "drop": (0.05, 0.25), "disp": 85.0, "dd": 0.45, "base": 0.35, "heat": 0.20},
}


def params(market, hi=HIGH_LOOK):
    p = dict(PARAMS["coin" if market in COINS else "stock"])
    p["hi"] = hi  # 신고가 비교 봉 수 상한 (검증 때는 실시간 창 길이에 맞춘다)
    p["coin"] = market in COINS
    return p


# ── 계산 도우미 ─────────────────────────────────────────
def _cl(x):
    return 0.0 if x < 0 else 1.0 if x > 1 else x


def _mean(xs):
    s = 0.0
    for x in xs:
        s += x
    return s / len(xs) if xs else 0.0


def _rank(xs, j, n=SQUEEZE_WIN):
    """xs[j] 가 최근 n 개(자기 포함) 중 아래에서 몇 % 자리인지 (0 = 가장 낮음). 계산 못 하면 None"""
    x = xs[j] if 0 <= j < len(xs) else None
    if x is None or j - n + 1 < 0:
        return None
    lo = cnt = 0
    for y in xs[j - n + 1:j + 1]:
        if y is None:
            continue
        cnt += 1
        if y < x:
            lo += 1
    return lo / cnt if cnt >= n // 2 else None


def _pct(x, d=1):
    """0.0213 → '+2.1%'"""
    return f"{x * 100:+.{d}f}%"


def _bottom_label(r):
    return "최저" if r < 0.005 else f"하위 {max(1, round(r * 100))}%"


def _span(L, P):
    """신고가·고점 비교 기간 이름 — 이력이 창보다 짧으면(새로 상장) '상장 후'"""
    if L < min(P["hi"], 199):
        return "상장 후"
    if not P["coin"] and L >= 245:
        return "52주"
    return f"{round((L + 1) / 10) * 10}일"


class Series:
    """한 종목 일봉에서 미리 계산한 지표 묶음 (모든 값은 그 봉 종가까지의 정보로만 계산)"""
    __slots__ = ("o", "h", "l", "c", "v", "ma5", "ma20", "ma60", "ma120", "bbw", "atrp", "rsi", "k", "d",
                 "pdi", "mdi", "adx", "vma", "hh20", "hh60", "ll20", "disp")

    def __init__(self, o, h, l, c, v):
        self.o, self.h, self.l, self.c, self.v = o, h, l, c, v
        self.ma5, self.ma20, self.ma60, self.ma120 = (ind.sma(c, n) for n in (5, 20, 60, 120))
        mid, up, lo = ind.bollinger(c)
        self.bbw = [(u - b) / m if m else None for m, u, b in zip(mid, up, lo)]
        self.rsi = ind.rsi(c)
        self.k, self.d = ind.stochastic(h, l, c)
        atr, self.pdi, self.mdi, self.adx = ind.dmi(h, l, c)
        self.atrp = [a / x if a is not None and x else None for a, x in zip(atr, c)]
        self.vma = ind.sma(v, 20)          # vma[i-1] = i 직전 20봉 평균 거래량
        self.hh20 = ind.highest(h, 20)     # hh20[i-1] = i 직전 20봉 최고가
        self.hh60 = ind.highest(h, 60)
        self.ll20 = ind.lowest(l, 20)
        self.disp = ind.disparity(c, self.ma20)


def prepare(cs):
    """sources.daily() 캔들 → Series (indicators.series 처럼 float 로 맞춘다)"""
    return Series(*([float(x[k] or 0.0) for x in cs] for k in ("o", "h", "l", "c", "v")))


def _vr(S, i):
    """i 봉 거래량 ÷ 직전 20봉 평균"""
    b = S.vma[i - 1] if i >= 1 else None
    return S.v[i] / b if b else None


# ── 판정 — 각 함수는 (S, i, P, why) → None 또는 (점수 0~100, [근거]) ────────────
def squeeze_breakout(S, i, P, why):
    """밴드·변동폭 수축 + 60일 고점 바로 아래 + 최근 3봉 거래량 증가 + 20일선 위·상승"""
    if i < SQUEEZE_WIN + 25:
        return None
    c, m20, m20p = S.c[i], S.ma20[i], S.ma20[i - 5]
    if not (c > m20 > m20p):
        return None
    R = S.hh60[i - 1]
    dist = c / R - 1
    if dist > 0 or dist < -P["near"]:
        return None
    base = _mean(S.v[i - 22:i - 2])
    if base <= 0:
        return None
    vr3 = (S.v[i] + S.v[i - 1] + S.v[i - 2]) / 3 / base
    if vr3 < 1.2:
        return None
    rbs = [r for r in (_rank(S.bbw, j) for j in range(i - 4, i + 1)) if r is not None]
    rb = min(rbs) if rbs else 1.0
    ra = _rank(S.atrp, i)
    ra = 1.0 if ra is None else ra
    sq = min(rb, ra)
    if sq > 0.2:
        return None
    s = 0.35 * (1 - sq / 0.2) + 0.3 * (1 + dist / P["near"]) + 0.25 * _cl((vr3 - 1.2) / 1.3) \
        + 0.1 * _cl((m20 / m20p - 1) / 0.03)
    if not why:
        return 30 + 70 * s
    sqtxt = (f"밴드 수축(120일 중 {_bottom_label(rb)})" if rb <= ra else f"변동폭 축소(120일 중 {_bottom_label(ra)})")
    return 30 + 70 * s, [sqtxt, f"60일 고점까지 {_pct(dist)}", f"최근 거래량 {vr3:.1f}배", "20일선 위·상승 중"]


def breakout(S, i, P, why):
    """종가가 직전 20봉 고점 위 + 거래량 20봉 평균의 2배 이상"""
    if i < 21:
        return None
    c, R = S.c[i], S.hh20[i - 1]
    if c <= R:
        return None
    vr = _vr(S, i)
    if vr is None or vr < 2:
        return None
    R60 = S.hh60[i - 1] if i >= 61 else None
    big = R60 is not None and c > R60
    m = c / R - 1
    s = 0.45 * _cl((vr - 2) / 3) + 0.25 * _cl(m / 0.05) + 0.3 * big
    if not why:
        return 30 + 70 * s
    r = [f"20일 고점 돌파({_pct(m)})", f"거래량 {vr:.1f}배"]
    if big:
        r.insert(1, "60일 고점도 넘음")
    return 30 + 70 * s, r


def new_high(S, i, P, why):
    """종가가 최근 1년(최대 P['hi'] 봉) 최고가 위 — 상장 120봉 미만은 제외"""
    if i < 120:
        return None
    c = S.c[i]
    if c <= S.hh60[i - 1]:  # 싼 조건 먼저
        return None
    L = min(P["hi"], i)
    prior = max(S.h[i - L:i])
    if c <= prior:
        return None
    m = c / prior - 1
    vr = _vr(S, i) or 1.0
    s = 0.5 * _cl(m / 0.05) + 0.5 * _cl((vr - 1) / 2)
    if not why:
        return 40 + 60 * s
    sp = _span(L, P)
    return 40 + 60 * s, ["상장 후 최고가" if sp == "상장 후" else f"{sp} 신고가", f"직전 고점보다 {_pct(m)}", f"거래량 {vr:.1f}배"]


def volume_surge(S, i, P, why):
    """거래량이 직전 20봉 평균의 3배 이상"""
    if i < 21:
        return None
    vr = _vr(S, i)
    if vr is None or vr < 3:
        return None
    s = _cl(math.log(vr / 3) / math.log(10 / 3))
    if not why:
        return 30 + 70 * s
    chg = S.c[i] / S.c[i - 1] - 1
    return 30 + 70 * s, [f"거래량 {vr:.1f}배", f"가격 {_pct(chg)}" + (" (내리며 터짐)" if chg < 0 else "")]


def uptrend(S, i, P, why):
    """5>20>60>120일선 정배열 + ADX 25 이상 + +DI 우세"""
    if i < 120:
        return None
    a5, a20, a60, a120 = S.ma5[i], S.ma20[i], S.ma60[i], S.ma120[i]
    if not (a5 > a20 > a60 > a120):
        return None
    A, Pd, Md = S.adx[i], S.pdi[i], S.mdi[i]
    if A is None or A < 25 or Pd <= Md:
        return None
    s = 0.5 * _cl((A - 25) / 20) + 0.3 * _cl((a20 / a120 - 1) / 0.25) + 0.2 * _cl((Pd - Md) / 20)
    if not why:
        return 30 + 70 * s
    return 30 + 70 * s, ["정배열(5>20>60>120일선)", f"추세 강도 ADX {A:.0f}", f"상승 힘 우세(+DI {Pd:.0f}, −DI {Md:.0f})"]


def pullback(S, i, P, why):
    """20일선 > 60일선, 60일선 상승 중인데 최근 10봉 종가 고점에서 3~15%(코인 5~25%) 내려와 20일선 ±2%(코인 3%) + RSI 40~55
    (고점 대비 너무 많이 빠진 건 급등 뒤 급락이라 눌림목으로 보지 않는다)"""
    if i < 66:
        return None
    a20, a60, a60p = S.ma20[i], S.ma60[i], S.ma60[i - 5]
    if not (a20 > a60 > a60p):
        return None
    c = S.c[i]
    g = c / a20 - 1
    if abs(g) > P["band"]:
        return None
    r = S.rsi[i]
    if r is None or not 40 <= r <= 55:
        return None
    drop = c / max(S.c[i - 10:i]) - 1
    if not -P["drop"][1] <= drop <= -P["drop"][0]:
        return None
    s = 0.4 * (1 - abs(g) / P["band"]) + 0.25 * (1 - abs(r - 47.5) / 7.5) + 0.35 * _cl((a20 / a60 - 1) / 0.08)
    if not why:
        return 30 + 70 * s
    return 30 + 70 * s, [f"20일선 근처({_pct(g)})", f"최근 고점 대비 {_pct(drop)}", f"RSI {r:.0f}", "20일선>60일선 상승 추세"]


def golden_cross(S, i, P, why):
    """최근 5봉 안에 20일선이 60일선을 위로 + 종가가 20일선 위"""
    if i < 66:
        return None
    c, a20 = S.c[i], S.ma20[i]
    if c <= a20:
        return None
    back = None
    for b in range(5):
        j = i - b
        if S.ma20[j - 1] <= S.ma60[j - 1] and S.ma20[j] > S.ma60[j]:
            back = b
            break
    if back is None:
        return None
    base = _mean(S.v[i - 24:i - 4])
    vr5 = _mean(S.v[i - 4:i + 1]) / base if base > 0 else 1.0
    slope60 = S.ma60[i] / S.ma60[i - 5] - 1
    s = 0.45 * (1 - back / 5) + 0.3 * _cl(vr5 - 1) + 0.25 * _cl(0.5 + slope60 / 0.02)
    if not why:
        return 30 + 70 * s
    when = "오늘" if back == 0 else f"{back}봉 전"
    return 30 + 70 * s, [f"20일선이 60일선 돌파({when})", f"최근 5봉 거래량 {vr5:.1f}배", "가격 20일선 위"]


def bottoming(S, i, P, why):
    """고점 대비 크게 빠진 뒤 60봉 최저점이 15봉 넘게 깨지지 않음 + 20일선 회복(평평·상승) + RSI 45~65 + 바닥에서 아직 멀지 않음"""
    if i < 120:
        return None
    c, a20 = S.c[i], S.ma20[i]
    if not (c > a20 >= S.ma20[i - 5]):
        return None
    r = S.rsi[i]
    if r is None or not 45 <= r <= 65:
        return None
    w = S.l[i - 59:i + 1]
    lo = min(w)
    held = 59 - w.index(lo)
    if held < 15:
        return None
    above = c / lo - 1
    if above > P["base"]:
        return None
    L = min(P["hi"], i)
    dd = c / max(S.h[i - L:i + 1]) - 1
    if dd > -P["dd"]:
        return None
    s = 0.4 * _cl((held - 15) / 30) + 0.3 * _cl((-dd - P["dd"]) / 0.3) + 0.3 * (1 - above / P["base"])
    if not why:
        return 30 + 70 * s
    return 30 + 70 * s, [f"{_span(L, P)} 고점 대비 {_pct(dd, 0)}", f"{held}일째 저점 유지", "20일선 회복"]


def oversold_bounce(S, i, P, why):
    """최근 4봉 안에 RSI 30 이하 또는 20일 이격도 90(코인 85) 이하 → 오늘 오르며 양봉 또는 스토캐스틱 상향"""
    if i < 25:
        return None
    c, cp = S.c[i], S.c[i - 1]
    if c <= cp:
        return None
    rs = [x for x in S.rsi[i - 3:i + 1] if x is not None]
    ds = [x for x in S.disp[i - 3:i + 1] if x is not None]
    rmin = min(rs) if rs else 100.0
    dmin = min(ds) if ds else 100.0
    if rmin > 30 and dmin > P["disp"]:
        return None
    K, D, Kp, Dp = S.k[i], S.d[i], S.k[i - 1], S.d[i - 1]
    cross = None not in (K, D, Kp, Dp) and Kp <= Dp and K > D and D < 30
    if not (c > S.o[i] or cross):
        return None
    sev = max(_cl((35 - rmin) / 15), _cl((P["disp"] + 5 - dmin) / 15))
    chg = c / cp - 1
    s = 0.45 * sev + 0.35 * _cl(chg / 0.05) + 0.2 * cross
    if not why:
        return 30 + 70 * s
    r = [f"RSI {rmin:.0f}까지 하락" if rmin <= 30 else f"20일선보다 {_pct(dmin / 100 - 1, 0)}",
         f"{_pct(chg)} 반등" + (" 양봉" if c > S.o[i] else "")]
    if cross:
        r.append("스토캐스틱 상향")
    return 30 + 70 * s, r


def overheat(S, i, P, why):
    """RSI 75 이상 + 20일선보다 12%(코인 20%) 넘게 위"""
    if i < 25:
        return None
    r, a20 = S.rsi[i], S.ma20[i]
    if r is None or r < 75:
        return None
    g = S.c[i] / a20 - 1
    if g < P["heat"]:
        return None
    s = 0.5 * _cl((r - 75) / 15) + 0.5 * _cl((g - P["heat"]) / P["heat"])
    if not why:
        return 30 + 70 * s
    return 30 + 70 * s, [f"RSI {r:.0f}", f"20일선보다 {_pct(g, 0)}"]


def downtrend_warn(S, i, P, why):
    """역배열 · 20일 저점 이탈 · −DI 우세(ADX 20+) · 20일선 아래·하락 중 3개 이상 (역배열이나 이탈은 꼭)"""
    if i < 120:
        return None
    a5, a20, a60, a120 = S.ma5[i], S.ma20[i], S.ma60[i], S.ma120[i]
    c = S.c[i]
    a = a5 < a20 < a60 < a120
    b = c < S.ll20[i - 1]
    if not (a or b):
        return None
    A, Pd, Md = S.adx[i], S.pdi[i], S.mdi[i]
    dmi_dn = A is not None and A >= 20 and Md > Pd
    e = c < a20 < S.ma20[i - 5]
    n = a + b + dmi_dn + e
    if n < 3:
        return None
    s = 0.2 * n + 0.2 * _cl((1 - c / a60) / 0.2)
    if not why:
        return 30 + 70 * s
    r = []
    if a:
        r.append("역배열(5<20<60<120일선)")
    if b:
        r.append(f"20일 저점 이탈({_pct(c / S.ll20[i - 1] - 1)})")
    if dmi_dn:
        r.append(f"하락 힘 우세(ADX {A:.0f})")
    if e:
        r.append("20일선 아래·하락 중")
    return 30 + 70 * s, r


CHECKS = tuple((k, globals()[k]) for k in KEYS)


def evaluate(S, i, P, why=True):
    """i 봉에서 켜진 판정 [(키, 점수, 근거)] — 계산 못 하는 값(None)이 끼면 그 판정은 건너뛴다"""
    out = []
    for key, fn in CHECKS:
        try:
            r = fn(S, i, P, why)
        except (TypeError, ZeroDivisionError, ValueError, IndexError):
            r = None
        if r is not None:
            out.append((key, r[0], r[1]) if why else (key, r, None))
    return out


def detect(cs, market=None):
    """마지막 봉 기준 판정 — 스크리너 행의 setups 필드 [{"k", "s", "r"}] (켜진 것만, 점수 높은 순)"""
    if not cs or len(cs) < 30 or not (cs[-1].get("c") or 0) > 0:
        return []
    S = prepare(cs)
    hits = evaluate(S, len(cs) - 1, params(market), True)
    hits.sort(key=lambda x: -x[1])
    return [{"k": k, "s": int(min(100, max(0, round(s)))), "r": r} for k, s, r in hits]


# ── 백데이터 검증 (numpy·pandas) ──────────────────────────
def _scan_n():
    """collect.py 의 SCAN_N (실시간 판정 창 길이) — import 하지 않고 숫자만 읽는다"""
    try:
        t = (HERE / "collect.py").read_text(encoding="utf-8")
        m = re.search(r"^SCAN_N\s*=\s*(\{[^}]*\})", t, re.M)
        return {k: int(v) for k, v in re.findall(r'"(\w+)":\s*(\d+)', m.group(1))}
    except (OSError, AttributeError, ValueError):
        return {"upbit": 200, "binance": 260, "krx": 260, "us": 260}


PEGGED = {"USDT", "USDC", "FDUSD", "TUSD", "BUSD", "DAI", "USDP", "USDE", "USD1", "EUR", "AEUR", "EURI", "XUSD",
          "BFUSD", "PYUSD", "RLUSD", "USDS", "UST", "USTC", "U", "EURC", "USDG", "JPYC", "GUSD", "FRAX", "USDD",
          "LUSD", "AUSD", "USD0", "USDQ", "EURQ", "USDF", "KRWQ"}


def _pegged(market, code, c):
    """스테이블코인 (predict.is_pegged 와 같은 규칙: 이름 또는 최근 60일 ±2% 안·하루 변동 0.3% 미만)"""
    if market not in COINS:
        return False
    base = code.split("-", 1)[-1] if market == "upbit" else (code[:-4] if code.endswith("USDT") else code)
    if base.upper() in PEGGED:
        return True
    w = sorted(c[-60:])
    if len(w) < 20:
        return False
    med = w[len(w) // 2]
    tail = c[-60:]
    rets = [math.log(b / a) for a, b in zip(tail[:-1], tail[1:]) if a > 0 and b > 0]
    mu = _mean(rets)
    sd = math.sqrt(_mean([(x - mu) ** 2 for x in rets])) if rets else 1
    return all(abs(x / med - 1) < 0.02 for x in tail) and sd < 0.003


def _segments(market, code, a, out):
    """원본 배열 → 검증용 시계열. 스테이블코인은 빼고, 수정주가 누락 보정·긴 공백/이음새 끊기는
    예측 엔진(features.clean_series)과 같게 (앞 구간은 code#1, #2 … 별도 시계열)"""
    import features
    if _pegged(market, code, a["c"].tolist()):
        return
    segs, _ = features.clean_series(a, market)
    for k, s in enumerate(segs):
        if len(s["t"]) >= 160:
            out.append((code if k == len(segs) - 1 else f"{code}#{len(segs) - 1 - k}",
                        {f: s[f].tolist() for f in ("t", "o", "h", "l", "c", "v")}))


def load_series(market, hist_dir=HIST_DIR, limit=0, log=print):
    """이력 저장소(collector/.history, 예측 엔진이 갱신) → [(코드, {t,o,h,l,c,v 리스트})]"""
    sys.path.insert(0, str(HERE / "model"))
    import history
    arrs = history.load_market(market, Path(hist_dir))
    if limit:
        arrs = dict(list(arrs.items())[:limit])
    out = []
    for code, a in arrs.items():
        _segments(market, code, a, out)
    return out


def fetch_series(market, n_syms, log=print):
    """이력 저장소가 없을 때 — 지금 스크리너 상위 종목만 sources.daily 로 길게 받아 검증 (진행 중인 봉은 버린다)"""
    sys.path.insert(0, str(HERE / "model"))
    import history
    import sources
    try:
        rows = json.loads((OUT_FILE.parent / "screener" / f"{market}.json").read_text(encoding="utf-8"))["rows"]
    except (OSError, ValueError, KeyError):
        return []
    out = []
    for r in rows[:n_syms]:
        try:
            a = history.to_arrays(sources.daily(r["sym"], history.FULL_N[market]), market, time.time())
        except Exception as e:  # 한 종목 실패는 건너뛴다
            log(f"  [{market}] {r['sym']} 받기 실패: {e}")
            continue
        if len(a["t"]) >= 160:
            _segments(market, r["sym"].split(":", 1)[1], a, out)
    return out


POP = {"coin": {5: 0.15, 20: 0.30}, "stock": {5: 0.07, 20: 0.15}}  # '분출' = 그 기간 안에 고가가 산 값보다 이만큼 넘게 오름


def scan_history(series, market, hi_cap, horizons=HORIZONS, min_obs=60):
    """각 시계열의 모든 날짜에서 판정 → (시장 전체 표 rows, 신호 events)
    rows: {h: ([t], [수익], [분출 여부])} — 그날 판정이 가능했던 모든 종목 (시장 평균용)
    events: {key: [(시계열 번호, i, t, 점수, {h: (수익, 분출 여부)})]}
    수익 = i 다음 봉 시가에 사서 i+h 봉 종가에 판 값. 분출 = i+1~i+h 봉 고가가 그 시가보다 POP 넘게 오른 적 있음"""
    P = params(market, hi_cap)
    pop = POP["coin" if market in COINS else "stock"]
    rows = {h: ([], [], []) for h in horizons}
    events = {k: [] for k in KEYS}
    H = max(horizons)
    for sid, (_, a) in enumerate(series):
        o, hi, c, v, t = a["o"], a["h"], a["c"], a["v"], a["t"]
        T = len(c)
        S = Series(o, hi, a["l"], c, v)
        for i in range(min_obs - 1, T - 1):
            if v[i] <= 0:
                continue
            e = o[i + 1]
            fwd = {h: (c[i + h] / e - 1, max(hi[i + 1:i + h + 1]) / e - 1 >= pop[h]) for h in horizons if i + h < T}
            for h, (r, p) in fwd.items():
                rows[h][0].append(t[i])
                rows[h][1].append(r)
                rows[h][2].append(p)
            for key, score, _ in evaluate(S, i, P, False):
                events[key].append((sid, i, t[i], score, fwd))
        del S
    return rows, events, H


def _boot_ci(x, blk, B, rng):
    import numpy as np
    ub, inv = np.unique(blk, return_inverse=True)
    sums = np.bincount(inv, weights=x)
    cnts = np.bincount(inv).astype(float)
    nb = len(ub)
    if nb < 3:
        return None
    idx = rng.integers(0, nb, size=(B, nb))
    m = sums[idx].sum(1) / np.maximum(cnts[idx].sum(1), 1)
    lo, hi = np.percentile(m, [2.5, 97.5])
    return float(lo), float(hi)


def _grade(st, d, min_n=30):
    """good: 어느 기간이든 신뢰구간이 기대 방향으로 0 을 벗어나고 중앙값도 같은 쪽 + 반대로 뚜렷한 기간 없음
    weak: 5·20일 평균이 모두 기대 방향 (통계적으로는 뚜렷하지 않음) / none: 그 밖 (표본 부족·효과 없음·반대)"""
    hs = [st.get(f"h{h}") for h in HORIZONS]
    if any(x is None or x["n"] < min_n or not x.get("ci") for x in hs):
        return "none", False
    sig = [x["ci"][0] > 0 if d > 0 else x["ci"][1] < 0 for x in hs]
    opp = [x["ci"][1] < 0 if d > 0 else x["ci"][0] > 0 for x in hs]
    if any(opp):
        return "none", True
    if any(s and d * x["medEx"] > 0 and d * (x["win"] - 50) > 0 for s, x in zip(sig, hs)):
        return "good", False
    if all(d * x["avgEx"] > 0 for x in hs):
        return "weak", False
    return "none", False


def stats_market(market, series, hi_cap, B=2000, seed=7, log=print):
    import numpy as np
    import pandas as pd
    t0 = time.time()
    rows, events, H = scan_history(series, market, hi_cap)
    t_scan = time.time() - t0
    coin = market in COINS
    res, meta = {}, {}
    bench = {}
    for h in HORIZONS:
        df = pd.DataFrame({"t": np.asarray(rows[h][0], dtype=np.int64), "r": np.asarray(rows[h][1]),
                           "p": np.asarray(rows[h][2], dtype=float)})
        df["u"] = (df["r"] > 0).astype(float)
        g = df.groupby("t")
        b = pd.DataFrame({"mean": g["r"].mean(), "med": g["r"].median(), "n": g.size(),
                          "upRate": g["u"].mean(), "popRate": g["p"].mean()})
        b = b[b["n"] >= 10]  # 하루 비교 대상이 10종목 미만인 날은 뺀다
        ex_all = (df["r"] - df["t"].map(b["mean"])).dropna().to_numpy()
        q = np.percentile(ex_all, [1, 99]) if len(ex_all) else (-1, 1)
        bench[h] = (b, q, float(b["mean"].mean()) if len(b) else None)
        if h == HORIZONS[-1] and len(b):
            meta = {"from": datetime.fromtimestamp(int(b.index.min()), timezone.utc).strftime("%Y-%m-%d"),
                    "to": datetime.fromtimestamp(int(b.index.max()), timezone.utc).strftime("%Y-%m-%d"),
                    "days": int(len(b)), "symbols": len({c.split("#")[0] for c, _ in series}),
                    "rows": int(len(df))}
    for key in KEYS:
        d = DIRECTION[key]
        ev = events[key]
        st = {"nRaw": len(ev)}
        for h in HORIZONS:
            b, q, _ = bench[h]
            last = {}
            ts, rs, ps = [], [], []
            for sid, i, t, _, fwd in ev:  # 같은 종목에서 h 봉 안에 다시 켜진 날은 겹치는 표본 → 첫 신호만
                if sid in last and i - last[sid] < h:
                    continue
                last[sid] = i
                if h in fwd:
                    ts.append(t)
                    rs.append(fwd[h][0])
                    ps.append(fwd[h][1])
            if not ts:
                st[f"h{h}"] = {"n": 0}
                continue
            e = pd.DataFrame({"t": np.asarray(ts, dtype=np.int64), "r": np.asarray(rs), "p": np.asarray(ps, dtype=float)})
            e = e.join(b, on="t", how="inner")
            if not len(e):
                st[f"h{h}"] = {"n": 0}
                continue
            ex = (e["r"] - e["mean"]).to_numpy()
            exw = np.clip(ex, q[0], q[1])
            # 부트스트랩 묶음: 코인은 h 달력일, 주식은 h 거래일 ≈ h×1.4 달력일
            blk = (e["t"].to_numpy() // int(86400 * h * (1.0 if coin else 1.4)))
            rng = np.random.default_rng([seed, KEYS.index(key), h])  # 탭·기간마다 고정 — 다른 탭이 바뀌어도 이 값은 그대로
            ci = _boot_ci(exw, blk, B, rng) if len(e) >= 10 else None
            tt = e["t"].to_numpy()
            mid = np.median(tt)
            halves = [float(exw[tt <= mid].mean()), float(exw[tt > mid].mean())] if (tt > mid).any() else None
            st[f"h{h}"] = {
                "n": int(len(e)),
                "avgEx": round(float(exw.mean()) * 100, 2),
                "medEx": round(float(np.median(ex)) * 100, 2),
                "win": round(float((e["r"] > e["med"]).mean()) * 100, 1),   # 같은 날 시장 중앙값보다 더 오른 비율 (기준 50%)
                "up": round(float((e["r"] > 0).mean()) * 100, 1),           # 실제로 오른 비율
                "mktUp": round(float(e["upRate"].mean()) * 100, 1),         # 같은 날들 시장 전 종목 중 오른 비율 (비교 기준)
                "pop": round(float(e["p"].mean()) * 100, 1),                # 기간 안에 고가가 POP 넘게 치솟은 비율 ('분출')
                "popMkt": round(float(e["popRate"].mean()) * 100, 1),       # 같은 날들 시장 전 종목의 그 비율 (비교 기준)
                "avgRet": round(float((exw + e["mean"].to_numpy()).mean()) * 100, 2),     # 평균 수익 (극단값 자른 초과 수익 + 그날 시장 평균)
                "mkt": round(float(e["mean"].mean()) * 100, 2),                    # 같은 날들 시장 평균 수익
                "ci": [round(ci[0] * 100, 2), round(ci[1] * 100, 2)] if ci else None,
                "halves": [round(x * 100, 2) for x in halves] if halves else None,
                "days": int(e["t"].nunique()),
            }
        st["grade"], st["opp"] = _grade(st, d)
        res[key] = st
    meta["secs"] = round(time.time() - t0, 1)
    meta["scanSecs"] = round(t_scan, 1)
    log(f"[{market}] 시계열 {len(series)}개 · 표 {meta.get('rows', 0):,}행 · 검증 {meta['secs']:.0f}초 (판정 {t_scan:.0f}초)")
    return res, meta


def _age_hours(path):
    try:
        s = json.loads(Path(path).read_text(encoding="utf-8"))
        return (time.time() - datetime.fromisoformat(s["updatedAt"]).timestamp()) / 3600, s
    except (OSError, ValueError, KeyError, TypeError):
        return None, None


METHOD = ("과거 각 날짜에 그날 종가까지의 일봉으로만 판정하고, 다음 봉 시가에 사서 5·20봉 뒤 종가까지의 수익을 "
          "같은 날 같은 시장 전 종목 평균과 비교했어요(초과 수익). 같은 종목에서 그 기간 안에 다시 켜진 날은 빼고, "
          "신뢰구간은 기간 묶음 부트스트랩(95%)이에요. 수수료·슬리피지는 빼지 않았고, 오래전에 상장폐지된 종목은 이력에 없어요.")


def run_stats(markets, out_file, hist_dir=HIST_DIR, limit=0, boot=2000, fetch_n=0, log=print):
    t0 = time.time()
    scan_n = _scan_n()
    _, prev = _age_hours(out_file)
    doc = {"updatedAt": None, "method": METHOD, "units": "avgEx·medEx·avgRet·mkt·ci·halves: %(p) / win·up·mktUp·pop·popMkt: %",
           "pop": {"coin": {f"h{h}": round(x * 100) for h, x in POP["coin"].items()},
                   "stock": {f"h{h}": round(x * 100) for h, x in POP["stock"].items()}},
           "horizons": list(HORIZONS),
           "defs": {k: {"emoji": e, "name": n, "desc": ds, "dir": d} for k, e, n, ds, d in DEFS},
           "meta": dict((prev or {}).get("meta") or {}), "markets": dict((prev or {}).get("markets") or {})}
    errors = {}
    for m in markets:
        try:
            series = load_series(m, hist_dir, limit, log)
            if len(series) < 20 and fetch_n:
                log(f"[{m}] 이력 저장소가 비어 있음 ({len(series)}개) → 상위 {fetch_n}종목만 직접 받아 검증")
                series = fetch_series(m, fetch_n, log)
            if len(series) < 20:
                raise RuntimeError(f"검증할 시계열이 모자람 ({len(series)}개)")
            hi_cap = min(HIGH_LOOK, scan_n.get(m, 260) - 1)  # 실시간 판정 창 길이와 같게
            res, meta = stats_market(m, series, hi_cap, boot, log=log)
            meta["hiLook"] = hi_cap
            doc["markets"][m] = res
            doc["meta"][m] = meta
        except Exception as e:  # 한 시장 실패는 직전 결과 유지
            errors[m] = str(e)
            log(f"[{m}] 검증 실패 — 직전 결과 유지: {e}")
    doc["updatedAt"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    if errors:
        doc["errors"] = errors
    if any(m in doc["markets"] for m in markets):
        out_file = Path(out_file)
        out_file.parent.mkdir(parents=True, exist_ok=True)
        tmp = out_file.with_suffix(".tmp")
        tmp.write_text(json.dumps(doc, ensure_ascii=False, separators=(",", ":"), allow_nan=False), encoding="utf-8")
        tmp.replace(out_file)
        log(f"저장 {out_file} ({time.time() - t0:.0f}초)")
    return doc, errors


def main():
    ap = argparse.ArgumentParser(description="전략 탭 백데이터 검증")
    ap.add_argument("--stats", action="store_true", help="검증 통계를 다시 계산")
    ap.add_argument("--markets", default="upbit,binance,krx,us")
    ap.add_argument("--out", default=str(OUT_FILE))
    ap.add_argument("--history", default=str(HIST_DIR))
    ap.add_argument("--if-stale", type=float, default=None, metavar="HOURS", help="결과가 이보다 새것이면 건너뜀")
    ap.add_argument("--limit", type=int, default=0, help="시장별 시계열 수 제한 (시험용)")
    ap.add_argument("--boot", type=int, default=2000, help="부트스트랩 반복 수")
    ap.add_argument("--fetch", type=int, default=60, help="이력이 없을 때 직접 받을 상위 종목 수 (0 = 받지 않음)")
    args = ap.parse_args()
    if not args.stats:
        ap.print_help()
        return 0
    if args.if_stale is not None:
        age, _ = _age_hours(args.out)
        if age is not None and age < args.if_stale:
            print(f"전략 탭 검증: {age:.1f}시간 전 결과 — 건너뜀", flush=True)
            return 0
    markets = [m for m in args.markets.split(",") if m]
    _, errors = run_stats(markets, args.out, args.history, args.limit, args.boot, args.fetch,
                          log=lambda s: print(s, flush=True))
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
