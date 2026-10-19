"""기술적 지표와 신호 — site/js/indicators.js 와 같은 계산 (값이 같아야 스크리너와 차트가 일치한다)

모든 시계열 함수는 입력과 길이가 같은 리스트를 돌려주고, 아직 계산되지 않는 앞부분은 None 이다.
"""
import math

MA_PERIODS = (5, 20, 60, 120)
SURGE = 5.0  # 급등/급락 기준 등락률(%)
VOL_SPIKE = 3.0  # 거래량 급증 기준 (20봉 평균 대비 배수)
CROSS_LOOKBACK = 3  # 최근 몇 봉 안의 크로스를 신호로 볼지

SIGNALS = {
    "surge": "급등", "plunge": "급락", "vol_spike": "거래량 급증",
    "rsi_os": "RSI 과매도", "rsi_ob": "RSI 과매수",
    "golden": "골든크로스", "dead": "데드크로스",
    "align_up": "정배열", "align_down": "역배열",
    "bb_up": "볼린저 상단 돌파", "bb_down": "볼린저 하단 이탈",
    "macd_up": "MACD 상향 돌파", "macd_down": "MACD 하향 돌파",
    "new_high": "신고가", "new_low": "신저가",
}


def _sum(xs):
    """앞에서부터 차례로 더하기. 내장 sum() 은 3.12부터 보정 합산을 해서 JS 결과와 미세하게 달라진다."""
    s = 0.0
    for x in xs:
        s += x
    return s


def sma(xs, n):
    out = [None] * len(xs)
    s = 0.0
    for i, x in enumerate(xs):
        s += x
        if i >= n:
            s -= xs[i - n]
        if i >= n - 1:
            out[i] = s / n
    return out


def ema(xs, n):
    """앞쪽 None 은 건너뛰고, 처음 n 개 평균으로 시작"""
    out = [None] * len(xs)
    k = 2 / (n + 1)
    prev, seed = None, []
    for i, x in enumerate(xs):
        if x is None:
            continue
        if prev is None:
            seed.append(x)
            if len(seed) == n:
                prev = _sum(seed) / n
                out[i] = prev
            continue
        prev = x * k + prev * (1 - k)
        out[i] = prev
    return out


def rsi(closes, n=14):
    """Wilder 방식"""
    out = [None] * len(closes)
    if len(closes) <= n:
        return out
    gain = loss = 0.0
    for i in range(1, n + 1):
        d = closes[i] - closes[i - 1]
        gain += max(d, 0)
        loss += max(-d, 0)
    ag, al = gain / n, loss / n

    def val():
        if al == 0:
            return 50.0 if ag == 0 else 100.0
        return 100 - 100 / (1 + ag / al)
    out[n] = val()
    for i in range(n + 1, len(closes)):
        d = closes[i] - closes[i - 1]
        ag = (ag * (n - 1) + max(d, 0)) / n
        al = (al * (n - 1) + max(-d, 0)) / n
        out[i] = val()
    return out


def macd(closes, fast=12, slow=26, sig=9):
    ef, es = ema(closes, fast), ema(closes, slow)
    line = [a - b if a is not None and b is not None else None for a, b in zip(ef, es)]
    signal = ema(line, sig)
    hist = [a - b if a is not None and b is not None else None for a, b in zip(line, signal)]
    return line, signal, hist


def bollinger(closes, n=20, k=2.0):
    mid, up, lo = [None] * len(closes), [None] * len(closes), [None] * len(closes)
    for i in range(n - 1, len(closes)):
        w = closes[i - n + 1:i + 1]
        m = _sum(w) / n
        sd = math.sqrt(_sum((x - m) * (x - m) for x in w) / n)
        mid[i], up[i], lo[i] = m, m + k * sd, m - k * sd
    return mid, up, lo


def series(candles):
    c = [x["c"] for x in candles]
    out = {f"ma{n}": sma(c, n) for n in MA_PERIODS}
    out["bbMid"], out["bbUp"], out["bbLo"] = bollinger(c)
    out["rsi"] = rsi(c)
    out["macd"], out["macdSignal"], out["macdHist"] = macd(c)
    return out


def crossed(a, b, lookback=CROSS_LOOKBACK):
    """최근 lookback 봉 안에 a 가 b 를 위로(+1)/아래로(-1) 뚫었으면 (방향, 몇 봉 전). 없으면 (0, None)"""
    n = len(a)
    for back in range(lookback):
        i = n - 1 - back
        if i < 1 or None in (a[i], b[i], a[i - 1], b[i - 1]):
            break
        if a[i - 1] <= b[i - 1] and a[i] > b[i]:
            return 1, back
        if a[i - 1] >= b[i - 1] and a[i] < b[i]:
            return -1, back
    return 0, None


def opinion(c, rsi_v, macd_v, sig_v, bb_up, bb_lo):
    """이동평균 5개 + RSI + MACD + 볼린저로 매수/매도 표를 세는 요약 의견"""
    last = c[-1]
    votes = []
    for n in (5, 10, 20, 60, 120):
        if len(c) >= n:
            votes.append(1 if last > _sum(c[-n:]) / n else -1)
    if rsi_v is not None:
        votes.append(1 if rsi_v < 30 else -1 if rsi_v > 70 else 0)
    if macd_v is not None and sig_v is not None:
        votes.append(1 if macd_v > sig_v else -1)
    if bb_up is not None:
        votes.append(1 if last < bb_lo else -1 if last > bb_up else 0)
    buy, sell = votes.count(1), votes.count(-1)
    score = (buy - sell) / len(votes) if votes else 0.0
    label = ("적극 매수" if score >= 0.5 else "매수" if score >= 0.15 else
             "적극 매도" if score <= -0.5 else "매도" if score <= -0.15 else "중립")
    return {"score": round(score, 3), "label": label, "buy": buy, "sell": sell, "neutral": votes.count(0)}


def analyze(candles):
    if len(candles) < 30:
        return None
    ind = series(candles)
    c = [x["c"] for x in candles]
    v = [x["v"] for x in candles]
    last, prev = c[-1], c[-2]
    chg = (last / prev - 1) * 100 if prev else 0.0
    ma = {n: ind[f"ma{n}"][-1] for n in MA_PERIODS}
    r, m, s = ind["rsi"][-1], ind["macd"][-1], ind["macdSignal"][-1]
    up, lo = ind["bbUp"][-1], ind["bbLo"][-1]
    base = v[-21:-1]
    avg_v = _sum(base) / len(base) if base else 0
    vol_ratio = v[-1] / avg_v if avg_v else None
    look = min(len(candles) - 1, 250)
    prior = candles[-look - 1:-1]
    prior_high, prior_low = max(x["h"] for x in prior), min(x["l"] for x in prior)

    sig = []
    if chg >= SURGE:
        sig.append("surge")
    if chg <= -SURGE:
        sig.append("plunge")
    if vol_ratio is not None and vol_ratio >= VOL_SPIKE:
        sig.append("vol_spike")
    if r is not None and r <= 30:
        sig.append("rsi_os")
    if r is not None and r >= 70:
        sig.append("rsi_ob")
    gx, _ = crossed(ind["ma5"], ind["ma20"])
    if gx:
        sig.append("golden" if gx > 0 else "dead")
    if all(ma[n] is not None for n in MA_PERIODS):
        if ma[5] > ma[20] > ma[60] > ma[120]:
            sig.append("align_up")
        elif ma[5] < ma[20] < ma[60] < ma[120]:
            sig.append("align_down")
    if up is not None and last > up:
        sig.append("bb_up")
    if lo is not None and last < lo:
        sig.append("bb_down")
    mx, _ = crossed(ind["macd"], ind["macdSignal"])
    if mx:
        sig.append("macd_up" if mx > 0 else "macd_down")
    if candles[-1]["h"] > prior_high:
        sig.append("new_high")
    if candles[-1]["l"] < prior_low:
        sig.append("new_low")

    return {"price": last, "chg": chg, "rsi": r, "macd": m, "macdSignal": s, "volRatio": vol_ratio,
            "ma": {str(n): ma[n] for n in MA_PERIODS}, "lookback": look,
            "signals": sig, "opinion": opinion(c, r, m, s, up, lo)}
