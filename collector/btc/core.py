"""비트코인 카드 공통 — 표준 라이브러리만 (매 실행 몇 초 안에 끝나야 한다)

시간 규칙
  봉 t = 업비트 60분봉의 시작 시각(UTC 초). 판단 시각 = 봉이 끝나는 t + 3600 (예측의 '기준 시각').
  목표 = 판단 시각 종가 → hor 시간 뒤 봉의 종가, 로그 수익률. 빈 시간(거래 없음)은 직전 종가로 채운다.
특징·모델은 학습(train.py, numpy)과 매 실행이 이 파일의 같은 함수로 계산한다 — 둘이 어긋나지 않게.
"""
import json
import math
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import deque
from datetime import datetime, timedelta, timezone
from pathlib import Path

HOUR = 3600
KST = timezone(timedelta(hours=9))
MARKET = "KRW-BTC"
SYM = "upbit:KRW-BTC"
ROOT = Path(__file__).resolve().parent.parent.parent
OUT = ROOT / "web" / "public" / "data"
HIST = ROOT / "collector" / ".history" / "btc"
# 브라우저 흉내 X — 누가 부르는지 밝힌다
UA = "chaaaart-btc-forecast/1.0 (+https://github.com/rescececene/chaaaart.github.io)"
NAN = float("nan")

# ── HTTP (업비트 초당 4회 이하 — 다른 수집도 같은 IP 를 쓰므로 0.3초 간격, 429 면 쉬었다 다시) ──
MIN_GAP = {"api.upbit.com": 0.3}
_last_call = {}


def get_json(url, timeout=10, tries=4):
    host = urllib.parse.urlsplit(url).hostname
    for a in range(tries):
        gap = MIN_GAP.get(host, 0.2)
        wait = _last_call.get(host, 0.0) + gap - time.monotonic()
        if wait > 0:
            time.sleep(wait)
        _last_call[host] = time.monotonic()
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                body = json.loads(r.read().decode("utf-8"))
                rem = r.headers.get("Remaining-Req") or ""
            # 'group=candles; min=600; sec=9' — 이번 초에 남은 횟수가 적으면 조금 더 쉰다
            for part in rem.split(";"):
                part = part.strip()
                if part.startswith("sec=") and part[4:].isdigit() and int(part[4:]) <= 2:
                    _last_call[host] = time.monotonic() + 0.7
            return body
        except urllib.error.HTTPError as e:
            if e.code == 429 or e.code >= 500:
                time.sleep(1.5 * (a + 1))
                continue
            raise
        except (urllib.error.URLError, TimeoutError, ConnectionError, OSError):
            if a + 1 < tries:
                time.sleep(1.0 + a)
                continue
            raise
    raise RuntimeError(f"요청 실패: {url}")


def _ts(s):
    return int(datetime.fromisoformat(s).replace(tzinfo=timezone.utc).timestamp())


def fetch_hourly(count=200, to=None, now=None):
    """업비트 60분봉 (끝난 봉만) → [(t, o, h, l, c, v원)] 오래된 것부터"""
    now = time.time() if now is None else now
    out = {}
    left = count
    while left > 0:
        url = f"https://api.upbit.com/v1/candles/minutes/60?market={MARKET}&count={min(200, left)}"
        if to:
            url += "&to=" + to
        page = get_json(url)
        if not page:
            break
        for k in page:
            t = _ts(k["candle_date_time_utc"])
            if t + HOUR <= now - 60:  # 아직 안 끝난 봉은 뺀다
                out[t] = (t, float(k["opening_price"]), float(k["high_price"]), float(k["low_price"]),
                          float(k["trade_price"]), float(k["candle_acc_trade_price"]))
        left -= len(page)
        if len(page) < 200:
            break
        oldest = min(_ts(k["candle_date_time_utc"]) for k in page)
        to = datetime.fromtimestamp(oldest, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    return [out[t] for t in sorted(out)]


# ── 연속 시간봉 ─────────────────────────────────────────
class Bars:
    """빈 시간 없이 1시간마다 한 칸. a=1 은 실제 봉, 0 은 거래가 없어 직전 종가로 채운 칸"""

    def __init__(self, t0=0, o=None, h=None, l=None, c=None, v=None, a=None):
        self.t0 = int(t0)
        self.o, self.h, self.l, self.c = o or [], h or [], l or [], c or []
        self.v, self.a = v or [], a or []

    def __len__(self):
        return len(self.c)

    @property
    def t_last(self):
        return self.t0 + (len(self.c) - 1) * HOUR if self.c else None

    def t(self, i):
        return self.t0 + i * HOUR

    def index(self, t):
        i = (int(t) - self.t0) // HOUR
        return i if 0 <= i < len(self.c) and self.t0 + i * HOUR == int(t) else None

    @classmethod
    def from_rows(cls, rows):
        b = cls()
        b.merge(rows)
        return b

    def merge(self, rows):
        """새 봉 [(t,o,h,l,c,v)] 을 합친다 (같은 시각은 새 값으로). 빈 시간은 직전 종가로 채운다.
        새 봉이 지금 첫 칸보다 앞이면 실제 봉끼리 모아 처음부터 다시 만든다."""
        if not rows:
            return 0
        rows = sorted(rows)
        if self.c and rows[0][0] < self.t0:
            keep = {self.t(i): (self.t(i), self.o[i], self.h[i], self.l[i], self.c[i], self.v[i]) for i in range(len(self.c)) if self.a[i]}
            keep.update({r[0]: r for r in rows})
            rows = [keep[t] for t in sorted(keep)]
            self.c = []
        if not self.c:
            self.t0, self.o, self.h, self.l, self.c, self.v, self.a = rows[0][0], [], [], [], [], [], []
        added = 0
        for (t, o, h, l, c, v) in rows:
            i = (t - self.t0) // HOUR
            while len(self.c) < i:  # 빈 시간 채우기
                pc = self.c[-1]
                self.o.append(pc), self.h.append(pc), self.l.append(pc), self.c.append(pc), self.v.append(0.0), self.a.append(0)
            if i < len(self.c):
                self.o[i], self.h[i], self.l[i], self.c[i], self.v[i], self.a[i] = o, h, l, c, v, 1
            else:
                self.o.append(o), self.h.append(h), self.l.append(l), self.c.append(c), self.v.append(v), self.a.append(1)
                added += 1
        return added

    def tail(self, n):
        k = max(0, len(self.c) - n)
        return Bars(self.t0 + k * HOUR, self.o[k:], self.h[k:], self.l[k:], self.c[k:], self.v[k:], self.a[k:])

    def to_json(self):
        return {"t0": self.t0, "o": [round(x) for x in self.o], "h": [round(x) for x in self.h], "l": [round(x) for x in self.l],
                "c": [round(x) for x in self.c], "v": [round(x) for x in self.v], "a": self.a}

    @classmethod
    def from_json(cls, d):
        return cls(d["t0"], [float(x) for x in d["o"]], [float(x) for x in d["h"]], [float(x) for x in d["l"]],
                   [float(x) for x in d["c"]], [float(x) for x in d["v"]], [int(x) for x in d["a"]])


# ── 이동 창 계산 (pandas rolling 과 같은 뜻: NaN 은 건너뛰고, 개수가 minp 미만이면 NaN) ──
def _isnan(x):
    return x != x


def roll_sum(x, w, minp=None, mean=False):
    minp = w if minp is None else minp
    out = [NAN] * len(x)
    s = 0.0
    k = 0
    for i, xi in enumerate(x):
        if not _isnan(xi):
            s += xi
            k += 1
        if i >= w:
            xo = x[i - w]
            if not _isnan(xo):
                s -= xo
                k -= 1
        if k >= minp and k > 0:
            out[i] = s / k if mean else s
    return out


def roll_std(x, w, minp):
    out = [NAN] * len(x)
    s = s2 = 0.0
    k = 0
    for i, xi in enumerate(x):
        if not _isnan(xi):
            s += xi
            s2 += xi * xi
            k += 1
        if i >= w:
            xo = x[i - w]
            if not _isnan(xo):
                s -= xo
                s2 -= xo * xo
                k -= 1
        if k >= minp and k > 1:
            var = (s2 - s * s / k) / (k - 1)
            out[i] = math.sqrt(var) if var > 0 else 0.0
    return out


def roll_ext(x, w, minp, mx=True):
    out = [NAN] * len(x)
    dq = deque()
    k = 0
    for i, xi in enumerate(x):
        if i >= w and not _isnan(x[i - w]):
            k -= 1
        while dq and dq[0] <= i - w:
            dq.popleft()
        if not _isnan(xi):
            k += 1
            while dq and ((x[dq[-1]] <= xi) if mx else (x[dq[-1]] >= xi)):
                dq.pop()
            dq.append(i)
        if k >= minp and dq:
            out[i] = x[dq[0]]
    return out


def _log(x):
    return math.log(x) if x > 0 else NAN


def kst_hour(close_t):
    return ((int(close_t) // HOUR) + 9) % 24


def kst_dow(close_t):
    return ((int(close_t) + 9 * HOUR) // 86400 + 3) % 7  # 0=월


# 쓸 수 있는 특징 (rlib 연구와 같은 정의 · 바이낸스 없이 업비트 시간봉만)
FEATURES = ("lv24", "lv168", "lv720", "vr_24_168", "vr_168_720", "lpk24",
            "r1", "r3", "r6", "r12", "r24", "r72", "r168", "r336", "r720",
            "ma24", "ma168", "ma720", "pos24", "pos168", "pos720", "dd720",
            "vol24_168", "vol168_720", "vol1_24", "uph24", "uph168", "rsi14",
            "hour_sin", "hour_cos", "wkend")
NEED_BARS = 760  # 특징에 필요한 최소 봉 수 (가장 긴 창 720 + 여유)
# 브라우저가 업비트 시간봉 200개(한 번 요청)로 계산할 수 있는 특징 — 창이 168시간 이하 (1시간 예측용, web/src/components/btc/h1.ts 와 같은 정의)
FEATURES_SHORT = ("lv24", "lv168", "vr_24_168", "lpk24", "r1", "r3", "r6", "r12", "r24", "r72", "r168",
                  "ma24", "ma168", "pos24", "pos168", "vol24_168", "vol1_24", "uph24", "uph168", "rsi14",
                  "hour_sin", "hour_cos", "wkend")


def features(b):
    """{특징: [값…]} — 칸마다 그 시각까지의 봉만 쓴다 (앞쪽은 창이 덜 차 NaN). _s24·_s168·_s720 은 변동성용"""
    c, h, l, v = b.c, b.h, b.l, b.v
    n = len(c)
    lc = [_log(x) for x in c]
    r = [NAN] + [lc[i] - lc[i - 1] for i in range(1, n)]
    s24, s168, s720 = roll_std(r, 24, 20), roll_std(r, 168, 150), roll_std(r, 720, 600)
    F = {}
    F["lv24"] = [_log(x) if not _isnan(x) else NAN for x in s24]
    F["lv168"] = [_log(x) if not _isnan(x) else NAN for x in s168]
    F["lv720"] = [_log(x) if not _isnan(x) else NAN for x in s720]
    F["vr_24_168"] = [a - b_ for a, b_ in zip(F["lv24"], F["lv168"])]
    F["vr_168_720"] = [a - b_ for a, b_ in zip(F["lv168"], F["lv720"])]
    hl2 = [(_log(h[i] / l[i]) ** 2) if l[i] > 0 and h[i] > 0 else NAN for i in range(n)]
    pk = roll_sum(hl2, 24, 20, mean=True)
    F["lpk24"] = [0.5 * _log(x / (4 * math.log(2))) if not _isnan(x) and x > 0 else NAN for x in pk]
    base = s168
    for k in (1, 3, 6, 12, 24, 72, 168, 336, 720):
        col = [NAN] * n
        sq = math.sqrt(k)
        for i in range(k, n):
            bs = base[i]
            if not _isnan(bs) and bs > 0:
                col[i] = (lc[i] - lc[i - k]) / (bs * sq)
        F[f"r{k}"] = col
    for k in (24, 168, 720):
        sma = roll_sum(c, k, int(k * 0.9), mean=True)
        sq = math.sqrt(k / 2)
        F[f"ma{k}"] = [(lc[i] - _log(sma[i])) / (base[i] * sq) if not _isnan(sma[i]) and not _isnan(base[i]) and base[i] > 0 else NAN
                       for i in range(n)]
    for k in (24, 168, 720):
        hi = roll_ext(h, k, int(k * 0.9), True)
        lo = roll_ext(l, k, int(k * 0.9), False)
        F[f"pos{k}"] = [(c[i] - lo[i]) / (hi[i] - lo[i]) if not _isnan(hi[i]) and hi[i] > lo[i] else NAN for i in range(n)]
    hi720 = roll_ext(h, 720, 600, True)
    F["dd720"] = [lc[i] - _log(hi720[i]) if not _isnan(hi720[i]) else NAN for i in range(n)]
    vv = [max(0.0, x) for x in v]
    v24, v168, v720 = roll_sum(vv, 24), roll_sum(vv, 168), roll_sum(vv, 720)
    F["vol24_168"] = [math.log((a + 1) / (b_ / 7 + 1)) if not (_isnan(a) or _isnan(b_)) else NAN for a, b_ in zip(v24, v168)]
    F["vol168_720"] = [math.log((a + 1) / (b_ / 720 * 168 + 1)) if not (_isnan(a) or _isnan(b_)) else NAN for a, b_ in zip(v168, v720)]
    vm24 = roll_sum(vv, 24, mean=True)
    F["vol1_24"] = [math.log((vv[i] + 1) / (vm24[i] + 1)) if not _isnan(vm24[i]) else NAN for i in range(n)]
    upi = [1.0 if (not _isnan(x) and x > 0) else 0.0 for x in r]
    F["uph24"] = roll_sum(upi, 24, mean=True)
    F["uph168"] = roll_sum(upi, 168, mean=True)
    up = [max(0.0, x) if not _isnan(x) else NAN for x in r]
    dn = [max(0.0, -x) if not _isnan(x) else NAN for x in r]
    au, ad = roll_sum(up, 14, mean=True), roll_sum(dn, 14, mean=True)
    F["rsi14"] = [a / (a + d) if not (_isnan(a) or _isnan(d)) and (a + d) > 0 else NAN for a, d in zip(au, ad)]
    hs, hc, wk = [], [], []
    for i in range(n):
        ct = b.t(i) + HOUR
        hk = kst_hour(ct)
        hs.append(math.sin(2 * math.pi * hk / 24))
        hc.append(math.cos(2 * math.pi * hk / 24))
        wk.append(1.0 if kst_dow(ct) >= 5 else 0.0)
    F["hour_sin"], F["hour_cos"], F["wkend"] = hs, hc, wk
    F["_s24"], F["_s168"], F["_s720"] = s24, s168, s720
    return F


def sigma_hourly(F, i, w=(0.3, 0.4, 0.3)):
    """시간당 변동성 — 24·168·720시간 실현 변동성의 기하 가중 (기본 · 'mix')"""
    a, b_, c = F["_s24"][i], F["_s168"][i], F["_s720"][i]
    if any(_isnan(x) or x <= 0 for x in (a, b_, c)):
        return NAN
    return math.exp(w[0] * math.log(a) + w[1] * math.log(b_) + w[2] * math.log(c))


# ── 변동성(σ) 방법 — btc_model.json 의 기간별 'vol' (train.py 가 같은 정의로 학습) ──
HAR_EPS = 1e-10


def _rets(b, lo, hi):
    """봉 lo..hi 의 시간 로그수익 (첫 칸·0 이하 가격은 0)"""
    out = []
    for j in range(lo, hi + 1):
        out.append(math.log(b.c[j] / b.c[j - 1]) if j > 0 and b.c[j] > 0 and b.c[j - 1] > 0 else 0.0)
    return out


def utc_weekend(t):
    """봉 시작 시각 t(UTC 초)가 토·일(UTC)인가"""
    return ((int(t) // 86400 + 3) % 7) >= 5


def har_row(b, i, hh=24):
    """HAR + 하락 반분산 + 주말 비율 설명 변수 (판단 시각 = 봉 i 끝) — Corsi 2009 · Patton & Sheppard 2015
    [1, log RV24, log RV168/7, log RV720/30, log RS−24, 다음 hh 봉 중 토·일(UTC) 비율]"""
    if i < 720:
        return None
    r = _rets(b, i - 719, i)
    r2 = [x * x for x in r]
    rv24, rv168, rv720 = sum(r2[-24:]), sum(r2[-168:]), sum(r2)
    rs24 = sum(x * x for x in r[-24:] if x < 0)
    wk = sum(1 for k in range(1, hh + 1) if utc_weekend(b.t(i) + k * HOUR)) / hh
    return [1.0, math.log(rv24 + HAR_EPS), math.log(rv168 / 7 + HAR_EPS), math.log(rv720 / 30 + HAR_EPS), math.log(rs24 + HAR_EPS), wk]


def garch_next(b, i, par, seas_bar):
    """GJR-GARCH(1,1)-t 다음 봉 표준편차 — 시간대 배율로 나눈 수익(%)에 재귀, 다음 봉 시간대 배율을 다시 곱한다.
    par = [ω, α, γ, β, ν], seas_bar[k] = 봉 시작 한국 시각 k 의 배율"""
    om, al, ga, be = par[:4]
    den = 1.0 - al - ga / 2 - be
    v = om / den if den > 1e-6 else om * 100
    lo = max(1, i - 999)
    e_prev = None
    for j in range(lo, i + 1):
        if e_prev is not None:
            v = om + (al + (ga if e_prev < 0 else 0.0)) * e_prev * e_prev + be * v
        f = seas_bar[(kst_hour(b.t(j)))] or 1.0
        e_prev = (math.log(b.c[j] / b.c[j - 1]) if b.c[j] > 0 and b.c[j - 1] > 0 else 0.0) / f * 100
    v = om + (al + (ga if e_prev < 0 else 0.0)) * e_prev * e_prev + be * v
    return math.sqrt(max(v, 1e-12)) / 100 * (seas_bar[kst_hour(b.t(i) + HOUR)] or 1.0)


def sigma_for(hspec, b, F, i):
    """기간 h 의 수익률 표준편차 예측 (로그) — 방법은 hspec['vol']['type']"""
    h = hspec["h"]
    vs = hspec.get("vol") or {"type": "mix"}
    hk = kst_hour(b.t(i) + HOUR)
    if vs["type"] == "har":
        x = har_row(b, i, vs.get("hh", 24))
        if x is None:
            return NAN
        lv = sum(w * xi for w, xi in zip(vs["beta"], x))
        s = math.sqrt(math.exp(lv) * h / vs.get("hh", 24))
        seas = vs.get("seas")
        return s * (seas[hk] if seas else 1.0)
    if vs["type"] == "garch":
        return garch_next(b, i, vs["p"], vs["seasBar"])
    seas = hspec.get("seas")
    return sigma_hourly(F, i) * math.sqrt(h) * (seas[hk] if seas else 1.0)


# ── 저장된 모델 적용 (train.py 가 JSON 으로 내보낸 것) ─────────────────
def _stdz(x, mu, sd):
    if _isnan(x):
        return 0.0
    z = (x - mu) / sd if sd > 0 else 0.0
    return max(-5.0, min(5.0, z))


def _tree(tr, x):
    f = tr["f"]
    if not f:
        return tr["v"][0]
    node = 0
    while node >= 0:
        val = x[f[node]]
        mt = tr["m"][node]
        if _isnan(val) and mt != 2:
            val = 0.0
        if (mt == 1 and -1e-35 <= val <= 1e-35) or (mt == 2 and _isnan(val)):
            left = tr["d"][node] == 1
        else:
            left = val <= tr["t"][node]
        node = tr["l"][node] if left else tr["r"][node]
    return tr["v"][~node]


def score(spec, row):
    """모델 하나의 원점수 — ridge: z 위치, logit/lgbm_c: 로그 오즈, lgbm_q: 분위별 z"""
    typ = spec["type"]
    x = [row.get(k, NAN) for k in spec["cols"]]
    if typ in ("ridge", "logit"):
        s = spec.get("b", 0.0)
        for xi, mu, sd, w in zip(x, spec["mu"], spec["sd"], spec["w"]):
            s += w * _stdz(xi, mu, sd)
        return s
    if typ in ("lgbm_c", "lgbm_r"):
        return spec.get("init", 0.0) + sum(_tree(tr, x) for tr in spec["trees"])
    if typ == "zero":
        return 0.0
    raise ValueError(f"모르는 모델 종류: {typ}")


def interp(xs, ys, x):
    """정렬된 xs 에서 x 의 ys 선형 보간 (끝은 고정)"""
    if x <= xs[0]:
        return ys[0]
    if x >= xs[-1]:
        return ys[-1]
    lo, hi = 0, len(xs) - 1
    while hi - lo > 1:
        mid = (lo + hi) // 2
        if xs[mid] <= x:
            lo = mid
        else:
            hi = mid
    t = (x - xs[lo]) / (xs[hi] - xs[lo]) if xs[hi] > xs[lo] else 0.0
    return ys[lo] + t * (ys[hi] - ys[lo])


def predict_h(hspec, row, sig):
    """한 기간(24·1시간)의 예측 분포 — {med, q10, q90, pUp, z} (수익률은 로그, z 는 변동성 단위)
    hspec: {"h", "vol": σ 방법, "models": {이름: spec}, "combine": κ|Platt, "dist": {"eq": 잔차 분위, "ep": 확률 눈금, "q10", "q90"},
            "range": 분위 모델 폭(선택)} · sig = sigma_for(hspec, …)
    """
    comb = hspec["combine"]
    raw = {name: score(spec, row) for name, spec in hspec["models"].items()}
    # 위치(z) = 모델 원점수를 섞고 축소 (κ). 'p' 로 보정하는 종류는 로그오즈 → 확률 → 잔차 분포로 위치 환산
    eq, ep = hspec["dist"]["eq"], hspec["dist"]["ep"]
    if comb["type"] == "kappa":
        z = sum(comb["w"][k] * raw[k] for k in comb["w"]) * comb["k"]
        p_up = 1.0 - interp(eq, ep, -z)
    elif comb["type"] == "platt":
        lo = comb["a"] + sum(comb["w"][k] * raw[k] for k in comb["w"])
        p_up = 1.0 / (1.0 + math.exp(-max(-30.0, min(30.0, lo))))
        z = -interp(ep, eq, 1.0 - p_up)
    else:
        raise ValueError(comb["type"])
    dist = hspec["dist"]
    lo, hi = dist["lo"], dist["hi"]  # 지난 1년 잔차 분위(FHS, z 단위)
    rng = hspec.get("range")
    if rng:  # 분위 모델 폭(변동성 국면·시간대에 따라 그때그때)과 섞기 — mix 1 이면 분위 모델만
        g10, g50, g90 = (score(rng[k], row) for k in ("q10", "q50", "q90"))
        wm = rng.get("mix", 1.0)
        lo = (1 - wm) * lo + wm * (min(g10, g50 - 1e-3) - g50)
        hi = (1 - wm) * hi + wm * (max(g90, g50 + 1e-3) - g50)
    s = dist.get("scale", 1.0)  # ACI 적응 배율 (하루 1번 학습 때 정함)
    q10, q90 = z + s * lo, z + s * hi
    return {"z": z, "sig": sig, "med": z * sig, "q10": q10 * sig, "q90": q90 * sig, "pUp": max(0.0, min(1.0, p_up)), "raw": raw}


# ── 갈림길 후보 (마지막 칸 기준) ─────────────────────────
PIVOTS = {  # 키: (이름, 설명)
    "sma168": ("7일 평균", "최근 7일 평균 가격"),
    "sma336": ("14일 평균", "최근 14일 평균 가격"),
    "sma720": ("30일 평균", "최근 30일 평균 가격"),
    "poc720": ("30일 매물대", "최근 30일 동안 가장 많이 거래된 가격대의 가운데"),
}


def poc(b, i, w=720, width=0.005):
    """매물대 중심: 최근 w시간 거래대금을 0.5% 간격 가격대에 나눠(대표가 (고+저+종)/3) 가장 많이 거래된 칸, 이웃 칸 절반 가중"""
    lo = max(0, i - w + 1)
    acc = {}
    for j in range(lo, i + 1):
        tp = (b.h[j] + b.l[j] + b.c[j]) / 3
        if tp <= 0:
            continue
        k = math.floor(math.log(tp) / width)
        acc[k] = acc.get(k, 0.0) + max(0.0, b.v[j])
    if not acc:
        return NAN
    best, bk = None, None
    for k, s in acc.items():
        s2 = s + 0.5 * acc.get(k - 1, 0.0) + 0.5 * acc.get(k + 1, 0.0)
        if best is None or s2 > best:
            best, bk = s2, k
    return math.exp((bk + 0.5) * width)


def pivot_levels(b, i):
    out = {}
    for key, w in (("sma168", 168), ("sma336", 336), ("sma720", 720)):
        if i + 1 >= w:
            out[key] = sum(b.c[i - w + 1:i + 1]) / w
    if i + 1 >= 720:
        out["poc720"] = poc(b, i)
    return out


# ── 숫자 표기 ─────────────────────────────────────────
def krw(x):
    """108,347,000 → '1억 835만 원' (만 원 단위 반올림)"""
    if x is None or _isnan(x):
        return "–"
    man = int(math.floor(x / 1e4 + 0.5))  # 0.5 는 올림 (화면 Math.round 와 같게)
    eok, rest = divmod(man, 10000)
    if eok and rest:
        return f"{eok}억 {rest:,}만 원"
    if eok:
        return f"{eok}억 원"
    return f"{rest:,}만 원"


def pct(x, d=1, sign=True):
    """분수 0.0123 → '+1.2%' (음수는 U+2212)"""
    if x is None or _isnan(x):
        return "–"
    v = round(x * 100, d)
    if v == 0:
        v = 0.0
    s = f"{abs(v):.{d}f}%"
    if not sign:
        return s
    return ("+" if v > 0 else "−" if v < 0 else "") + s


def iso(t):
    return datetime.fromtimestamp(int(t), timezone.utc).isoformat(timespec="seconds")


def kst_label(t):
    """'오후 10시' 같은 기준 시각 글 (정각)"""
    d = datetime.fromtimestamp(int(t), KST)
    h = d.hour
    return f"{'오전' if h < 12 else '오후'} {h % 12 or 12}시" + (f" {d.minute}분" if d.minute else "")


def read_json(path, default=None):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default


def write_json(path, obj):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(obj, ensure_ascii=False, separators=(",", ":"), allow_nan=False), encoding="utf-8")
    tmp.replace(path)
