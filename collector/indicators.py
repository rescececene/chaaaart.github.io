"""기술적 지표와 신호 — web/src/lib/indicators.ts 와 같은 계산 (값이 같아야 스크리너와 차트가 일치한다)

모든 시계열 함수는 입력과 길이가 같은 리스트를 돌려주고, 아직 계산되지 않는 앞부분은 None 이다.
JS 와 끝자리까지 같아야 하므로 더하는 순서와 식의 모양을 TS 쪽과 똑같이 둔다 (내장 sum() 대신 _sum).
고친 뒤에는 py -3 tools/make_fixture.py --reuse 로 기준값을 다시 만들고 web 에서 npx vitest run 으로 확인한다.
"""
import math

MA_PERIODS = (5, 20, 60, 120)
SURGE = 5.0  # 급등/급락 기준 등락률(%)
VOL_SPIKE = 3.0  # 거래량 급증 기준 (20봉 평균 대비 배수)
CROSS_LOOKBACK = 3  # 최근 몇 봉 안의 크로스를 신호로 볼지
ICHI_SHIFT = 26  # 일목균형표 구름(선행스팬)은 계산한 봉보다 26봉 앞에 그린다
MA_VOTE = (5, 10, 20, 60, 120)  # 의견 표를 던지는 이동평균

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


def highest(xs, n):
    """최근 n 봉(자기 봉 포함) 중 가장 큰 값"""
    out = [None] * len(xs)
    for i in range(n - 1, len(xs)):
        out[i] = max(xs[i - n + 1:i + 1])
    return out


def lowest(xs, n):
    """최근 n 봉(자기 봉 포함) 중 가장 작은 값"""
    out = [None] * len(xs)
    for i in range(n - 1, len(xs)):
        out[i] = min(xs[i - n + 1:i + 1])
    return out


def roll_mean(xs, n):
    """최근 n 개 값의 단순 평균 — 창 안에 None 이 있으면 None. 앞에서부터 차례로 더한다"""
    out = [None] * len(xs)
    for i in range(n - 1, len(xs)):
        s, ok = 0.0, True
        for x in xs[i - n + 1:i + 1]:
            if x is None:
                ok = False
                break
            s += x
        if ok:
            out[i] = s / n
    return out


def stochastic(h, l, c, n=14, kn=3, dn=3):
    """느린 스토캐스틱 (14, 3, 3) — (%K, %D)"""
    hh, ll = highest(h, n), lowest(l, n)
    fast = [None] * len(c)
    for i, x in enumerate(c):
        hi, lo = hh[i], ll[i]
        if hi is None or lo is None:
            continue
        fast[i] = (x - lo) / (hi - lo) * 100 if hi > lo else 50.0
    k = roll_mean(fast, kn)
    return k, roll_mean(k, dn)


def williams_r(h, l, c, n=14):
    """윌리엄스 %R (14) — 0 꼭대기 · -100 바닥"""
    hh, ll = highest(h, n), lowest(l, n)
    out = [None] * len(c)
    for i, x in enumerate(c):
        hi, lo = hh[i], ll[i]
        if hi is None or lo is None:
            continue
        out[i] = (x - hi) / (hi - lo) * 100 if hi > lo else -50.0
    return out


def cci(h, l, c, n=20):
    """CCI (20) — 대표 가격((고+저+종)/3)이 20봉 평균에서 얼마나 벗어났는지"""
    tp = [(h[i] + l[i] + c[i]) / 3 for i in range(len(c))]
    out = [None] * len(c)
    for i in range(n - 1, len(c)):
        w = tp[i - n + 1:i + 1]
        m = _sum(w) / n
        md = _sum(abs(x - m) for x in w) / n
        # 값이 전혀 안 변하면 평균을 낼 때 생기는 아주 작은 오차만 남는다 — 0 으로 본다
        out[i] = (tp[i] - m) / (0.015 * md) if md > abs(m) * 1e-12 else 0.0
    return out


def dmi(h, l, c, n=14):
    """Wilder 방식 (ATR, +DI, −DI, ADX). TR 은 둘째 봉부터, ADX 는 DX n 개 평균으로 시작"""
    N = len(c)
    atr, pdi, mdi, adx = [None] * N, [None] * N, [None] * N, [None] * N
    if N <= n:
        return atr, pdi, mdi, adx
    tr = pdm = mdm = dx_sum = ax = 0.0
    for i in range(1, N):
        t = max(h[i] - l[i], abs(h[i] - c[i - 1]), abs(l[i] - c[i - 1]))
        up, dn = h[i] - h[i - 1], l[i - 1] - l[i]
        p = up if up > dn and up > 0 else 0.0
        m = dn if dn > up and dn > 0 else 0.0
        if i <= n:
            tr += t
            pdm += p
            mdm += m
            if i < n:
                continue
            tr /= n
            pdm /= n
            mdm /= n
        else:
            tr = (tr * (n - 1) + t) / n
            pdm = (pdm * (n - 1) + p) / n
            mdm = (mdm * (n - 1) + m) / n
        P = pdm / tr * 100 if tr > 0 else 0.0
        M = mdm / tr * 100 if tr > 0 else 0.0
        atr[i], pdi[i], mdi[i] = tr, P, M
        dx = abs(P - M) / (P + M) * 100 if P + M > 0 else 0.0
        if i < 2 * n - 1:
            dx_sum += dx
            continue
        ax = (dx_sum + dx) / n if i == 2 * n - 1 else (ax * (n - 1) + dx) / n
        adx[i] = ax
    return atr, pdi, mdi, adx


def obv(c, v):
    """OBV — 오른 봉의 거래량은 더하고 내린 봉은 뺀 누적값 (처음 봉은 0)"""
    out, s = [None] * len(c), 0.0
    for i in range(len(c)):
        if i > 0:
            if c[i] > c[i - 1]:
                s += v[i]
            elif c[i] < c[i - 1]:
                s -= v[i]
        out[i] = s
    return out


def mfi(h, l, c, v, n=14):
    """MFI (14) — 대표 가격이 오른 봉의 거래대금 ÷ 내린 봉의 거래대금으로 만든 RSI"""
    N = len(c)
    out = [None] * N
    tp = [(h[i] + l[i] + c[i]) / 3 for i in range(N)]
    pos, neg = [0.0] * N, [0.0] * N
    for i in range(1, N):
        if tp[i] > tp[i - 1]:
            pos[i] = tp[i] * v[i]
        elif tp[i] < tp[i - 1]:
            neg[i] = tp[i] * v[i]
    for i in range(n, N):
        p = m = 0.0
        for j in range(i - n + 1, i + 1):
            p += pos[j]
            m += neg[j]
        out[i] = 100 - 100 / (1 + p / m) if m > 0 else (100.0 if p > 0 else 50.0)
    return out


def roc(c, n=12):
    """ROC (12) — n 봉 전 대비 등락률(%)"""
    return [(c[i] - c[i - n]) / c[i - n] * 100 if i >= n and c[i - n] else None for i in range(len(c))]


def _mid(h, l, n):
    hh, ll = highest(h, n), lowest(l, n)
    return [None if a is None or b is None else (a + b) / 2 for a, b in zip(hh, ll)]


def ichimoku(h, l, a=9, b=26, s=52):
    """일목균형표 — (전환선, 기준선, 선행스팬1, 선행스팬2). 선행스팬은 계산한 봉 자리 값 (지금 봉의 구름은 ICHI_SHIFT 봉 전 값)"""
    conv, base = _mid(h, l, a), _mid(h, l, b)
    span_a = [None if x is None or y is None else (x + y) / 2 for x, y in zip(conv, base)]
    return conv, base, span_a, _mid(h, l, s)


def psar(h, l, step=0.02, max_af=0.2):
    """파라볼릭 SAR (0.02 · 최대 0.2) — (SAR, 방향 1 상승 · -1 하락). 둘째 봉부터"""
    N = len(h)
    sar, d = [None] * N, [None] * N
    if N < 3:
        return sar, d
    up = h[1] - h[0] >= l[0] - l[1]
    ep = max(h[0], h[1]) if up else min(l[0], l[1])
    s = min(l[0], l[1]) if up else max(h[0], h[1])
    af = step
    sar[1], d[1] = s, (1 if up else -1)
    for i in range(2, N):
        nxt = s + af * (ep - s)
        if up:
            nxt = min(nxt, l[i - 1], l[i - 2])
            if l[i] < nxt:
                up, nxt, ep, af = False, max(ep, h[i]), l[i], step
            elif h[i] > ep:
                ep, af = h[i], min(af + step, max_af)
        else:
            nxt = max(nxt, h[i - 1], h[i - 2])
            if h[i] > nxt:
                up, nxt, ep, af = True, min(ep, l[i]), h[i], step
            elif l[i] < ep:
                ep, af = l[i], min(af + step, max_af)
        s = nxt
        sar[i], d[i] = s, (1 if up else -1)
    return sar, d


def disparity(c, ma):
    """이격도 — 종가 ÷ 이동평균 × 100"""
    return [x / m * 100 if m else None for x, m in zip(c, ma)]


def series(candles):
    c = [x["c"] for x in candles]
    out = {f"ma{n}": sma(c, n) for n in MA_PERIODS}
    out["bbMid"], out["bbUp"], out["bbLo"] = bollinger(c)
    out["rsi"] = rsi(c)
    out["macd"], out["macdSignal"], out["macdHist"] = macd(c)
    # 새 지표 — JS 와 같은 실수 계산이 되도록 float 로 맞춘다 (정수 곱셈이 JS 보다 정확해지는 일이 없게)
    h, l, cf, v = ([float(x[k]) for x in candles] for k in ("h", "l", "c", "v"))
    out["stochK"], out["stochD"] = stochastic(h, l, cf)
    out["willr"] = williams_r(h, l, cf)
    out["cci"] = cci(h, l, cf)
    out["atr"], out["pdi"], out["mdi"], out["adx"] = dmi(h, l, cf)
    out["obv"] = obv(cf, v)
    out["obvMa"] = roll_mean(out["obv"], 20)
    out["mfi"] = mfi(h, l, cf, v)
    out["roc"] = roc(cf)
    out["ichiConv"], out["ichiBase"], out["ichiSpanA"], out["ichiSpanB"] = ichimoku(h, l)
    out["sar"], out["sarDir"] = psar(h, l)
    out["disparity"] = disparity(cf, out["ma20"])
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


def _base_votes(c, rsi_v, macd_v, sig_v, bb_up, bb_lo):
    """기본 8표 — 이동평균 5개 + RSI(30·70) + MACD + 볼린저. [(키, 1 매수 · 0 중립 · -1 매도)]"""
    last = c[-1]
    out = []
    for n in MA_VOTE:
        if len(c) >= n:
            out.append((f"ma{n}", 1 if last > _sum(c[-n:]) / n else -1))
    if rsi_v is not None:
        out.append(("rsi", 1 if rsi_v < 30 else -1 if rsi_v > 70 else 0))
    if macd_v is not None and sig_v is not None:
        out.append(("macd", 1 if macd_v > sig_v else -1))
    if bb_up is not None and bb_lo is not None:
        out.append(("bb", 1 if last < bb_lo else -1 if last > bb_up else 0))
    return out


def _extra_votes(ind, last):
    """나머지 11표 — [(키, 1 · 0 · -1 · None 계산 못 함)] (TS extraVotes 와 같은 규칙·순서)"""
    N = len(ind["rsi"])

    def at(k, i=None):
        i = N - 1 if i is None else i
        return ind[k][i] if 0 <= i < N else None
    K, D, W, C, Cp = at("stochK"), at("stochD"), at("willr"), at("cci"), at("cci", N - 2)
    A, P, M = at("adx"), at("pdi"), at("mdi")
    O, Om, F, R = at("obv"), at("obvMa"), at("mfi"), at("roc")
    cA, cB = at("ichiSpanA", N - 1 - ICHI_SHIFT), at("ichiSpanB", N - 1 - ICHI_SHIFT)
    T, B, Sd, Dp = at("ichiConv"), at("ichiBase"), at("sarDir"), at("disparity")
    return [
        # 스토캐스틱: 과매도(%D 20 아래)에서 %K 가 %D 위로 → 매수, 과매수(80 위)에서 아래로 → 매도
        ("stoch", None if K is None or D is None else 1 if K > D and D < 20 else -1 if K < D and D > 80 else 0),
        ("willr", None if W is None else 1 if W < -80 else -1 if W > -20 else 0),
        # CCI: -100 아래에서 다시 오르면 매수, +100 위에서 꺾이면 매도
        ("cci", None if C is None or Cp is None else 1 if C < -100 and C > Cp else -1 if C > 100 and C < Cp else 0),
        # ADX 20 이상(추세 있음)일 때만 +DI·−DI 방향으로
        ("adx", None if A is None or P is None or M is None else 0 if A < 20 else 1 if P > M else -1 if P < M else 0),
        ("obv", None if O is None or Om is None else 1 if O > Om else -1 if O < Om else 0),
        ("mfi", None if F is None else 1 if F < 20 else -1 if F > 80 else 0),
        ("roc", None if R is None else 1 if R > 0 else -1 if R < 0 else 0),
        ("cloud", None if cA is None or cB is None else 1 if last > max(cA, cB) else -1 if last < min(cA, cB) else 0),
        ("tk", None if T is None or B is None else 1 if T > B else -1 if T < B else 0),
        ("sar", None if Sd is None else 1 if Sd > 0 else -1),
        ("disparity", None if Dp is None else 1 if Dp < 95 else -1 if Dp > 105 else 0),
    ]


def _tally(votes):
    buy, sell = votes.count(1), votes.count(-1)
    score = (buy - sell) / len(votes) if votes else 0.0
    label = ("적극 매수" if score >= 0.5 else "매수" if score >= 0.15 else
             "적극 매도" if score <= -0.5 else "매도" if score <= -0.15 else "중립")
    # JS Math.round 와 같은 반올림 (round() 는 0.0625 같은 딱 중간값을 짝수 쪽으로 보낸다)
    return {"score": math.floor(score * 1000 + 0.5) / 1000, "label": label, "buy": buy, "sell": sell,
            "neutral": len(votes) - buy - sell}


def opinion(c, rsi_v, macd_v, sig_v, bb_up, bb_lo, extra=()):
    """지표 표를 세는 요약 의견 — 기본 8표 + extra(새 지표 표, None 은 건너뜀)"""
    votes = [v for _, v in _base_votes(c, rsi_v, macd_v, sig_v, bb_up, bb_lo)]
    votes += [v for v in extra if v is not None]
    return _tally(votes)


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

    extra = _extra_votes(ind, last)
    votes = _base_votes(c, r, m, s, up, lo) + [(k, x) for k, x in extra if x is not None]
    L = {k: ind[k][-1] for k in ("stochK", "stochD", "willr", "cci", "adx", "pdi", "mdi", "atr", "obv", "obvMa",
                                 "mfi", "roc", "ichiConv", "ichiBase", "sar", "sarDir", "disparity")}
    ci = len(c) - 1 - ICHI_SHIFT
    atr = L["atr"]
    return {"price": last, "chg": chg, "rsi": r, "macd": m, "macdSignal": s, "volRatio": vol_ratio,
            "ma": {str(n): ma[n] for n in MA_PERIODS}, "lookback": look,
            "signals": sig, "opinion": opinion(c, r, m, s, up, lo, [x for _, x in extra]),
            "votes": [[k, x] for k, x in votes],
            **L, "atrPct": atr / last * 100 if atr is not None and last else None,
            "ichiA": ind["ichiSpanA"][ci] if ci >= 0 else None, "ichiB": ind["ichiSpanB"][ci] if ci >= 0 else None}
