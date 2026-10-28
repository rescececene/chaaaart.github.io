"""하루 1번 — 긴 시간봉 이력 갱신 → 채택 방법 워크포워드 검증(엠바고) → 최종 학습 → web/public/data/btc_model.json · btc_h1.json

  python collector/btc_forecast.py --train [--if-stale 20] [--deadline 6]

이력: collector/.history/btc/KRW-BTC_1h.npz (업비트 원화 비트코인 60분봉 2018-01~, 처음엔 약 390번 요청 · 이후 하루 1~2번)
     collector/.history/btc/wf_cache.npz (달마다 표본 밖 예측 — 지난 달은 다시 계산하지 않아 매일 학습은 수십 초)
검증: 2019-07 부터 매달 다시 학습 — 그 달 시작 전에 결과가 확정됐고, 거기서 목표 기간만큼 더 떨어진 표본만(엠바고) →
  표본 밖 예측. 하이퍼파라미터·조합은 연구(검증 구간 2019-07~2020-12, 시험 2021-01~)로 정해 아래 RECIPES 에 고정.
변동성 σ: 24시간 HAR + 하락 반분산 + 주말 비율 (매달 최소제곱), 1시간 GJR-GARCH(1,1)-t 시간대 보정 (매달 최대우도)
보정(매달, 그 전에 확정된 표본 밖 예측만):
  확률·위치  리지 → κ 축소(지난 2년 브라이어 최소) / LightGBM 분류 → Platt(지난 2년)
  범위       지난 1년 잔차 분위(FHS) [+ LightGBM 분위 폭과 평균] × ACI 배율(1시간만 — 결과가 확정될 때마다
             배율 ← 배율·exp(0.02·(빗나감 − 0.2)), 적응 conformal · Gibbs & Candès 2021)
안전장치: 채택 방법이 시험 구간(2021~)에서 '방향 신호 없음(0%)' 기준선보다 브라이어가 0.1%p 넘게 나쁘면 기준선을 쓴다.
새 방법 끼워 넣기: models.fit 에 종류 추가 → RECIPES 의 loc/width/vol 을 바꾸면 검증·보정·내보내기는 그대로 돈다.
"""
import math
import time
from datetime import datetime, timezone

import numpy as np

from . import core, models

H = core.HOUR
START = "2018-01-01T00:00:00"
VAL0, TEST0 = "2019-07-01", "2021-01-01"
TRAIN_YEARS = 4
HIST_FILE = core.HIST / "KRW-BTC_1h.npz"
MODEL_FILE = core.OUT / "btc_model.json"
KAP = (0.0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.8, 1.0)
EP = [round(0.005 + 0.01 * i, 3) for i in range(100)]  # 잔차 분위 눈금 0.005 … 0.995
ACI_GAMMA = 0.02
ACI_ALPHA = 0.2

# 채택 방법 — 연구(2019-07~2020-12 검증으로 하이퍼파라미터, 2021~ 시험 구간 비교)로 고정
FEATS_1H = list(core.FEATURES_SHORT)  # 브라우저가 업비트 시간봉 200개로 같은 계산을 한다 (창 168시간 이하)
RECIPES = {
    # 24시간: 방향은 어떤 모델도 기준선(0%)보다 뚜렷이 낫지 않아 가장 단순한 추세 하나(30일 평균 거리)를 κ 로 축소해서만.
    #   σ = HAR + 하락 반분산 + 주말 비율, 범위 = FHS 잔차 분위와 LightGBM 분위 폭의 평균 (지금 방식보다 분위 손실 −1.1~−1.7%).
    #   ACI 는 24시간(겹치는 결과)에선 손실을 키워 끔
    24: {"name": "30일 평균 거리(추세) 리지", "vol": "har", "aci": None,
         "loc": ("ridge", ["ma720"], {"alpha": 30000.0}),
         "width": (list(core.FEATURES), {"n": 150, "leaves": 7, "mcs": 2000}), "width_mix": 0.5},
    # 1시간: LightGBM 분류(짧은 창 특징 23개)가 방향·위치 → Platt, σ = GJR-GARCH-t(시간대 보정), 범위 = FHS × ACI.
    #   이 계수는 btc_h1.json 으로도 내보내 브라우저가 정시마다 바로 계산한다
    1: {"name": "LightGBM 분류(방향·위치) + GJR-GARCH 범위", "vol": "garch", "aci": ACI_GAMMA,
        "loc": ("lgbm_c", FEATS_1H, {"n": 150, "leaves": 7, "mcs": 300}), "width": None},
}
BASELINE = {"name": "방향 신호 없음(0%)", "loc": ("zero", [], {}), "width": None}


def log(msg):
    print(f"{datetime.now().strftime('%H:%M:%S')} [btc 학습] {msg}", flush=True)


def _ts(s):
    return int(datetime.fromisoformat(s).replace(tzinfo=timezone.utc).timestamp())


# ── 긴 이력 ─────────────────────────────────────────
def load_history():
    try:
        with np.load(HIST_FILE) as z:
            rows = list(zip(z["t"].tolist(), z["o"].tolist(), z["h"].tolist(), z["l"].tolist(), z["c"].tolist(), z["v"].tolist()))
            complete = bool(z["complete"][0]) if "complete" in z.files else False
        return rows, complete
    except (OSError, ValueError, KeyError):
        return [], False


def save_history(rows, complete):
    HIST_FILE.parent.mkdir(parents=True, exist_ok=True)
    a = np.array(sorted({r[0]: r for r in rows}.values()), dtype=np.float64)
    tmp = HIST_FILE.with_name(HIST_FILE.stem + ".tmp.npz")
    np.savez_compressed(tmp, t=a[:, 0].astype(np.int64), o=a[:, 1], h=a[:, 2], l=a[:, 3], c=a[:, 4], v=a[:, 5],
                        complete=np.array([complete]))
    tmp.replace(HIST_FILE)


def update_history(deadline=None):
    """새 봉을 이어 받고, 처음이면 2018-01 까지 거슬러 받는다 (마감 시간을 넘기면 다음에 이어서)"""
    rows, complete = load_history()
    have = {r[0] for r in rows}
    now = time.time()
    start_t = _ts(START)
    n_req = 0
    last = max(have) if have else None
    to = None
    fresh = {}
    while not (deadline and time.time() > deadline):  # 1) 최신 → 이미 있는 마지막 봉까지 (겹치는 봉은 새 값으로)
        page = core.fetch_hourly(200, to=to, now=now)
        n_req += 1
        if not page:
            break
        fresh.update({r[0]: r for r in page})
        have |= {r[0] for r in page}
        oldest = page[0][0]
        if (last is not None and oldest <= last) or oldest <= start_t or len(page) < 150:
            break
        to = datetime.fromtimestamp(oldest, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    if fresh:
        rows = [r for r in rows if r[0] not in fresh] + list(fresh.values())
    while not complete and rows and not (deadline and time.time() > deadline):  # 2) 2018-01 까지 거꾸로
        first = min(have)
        if first <= start_t:
            complete = True
            break
        page = core.fetch_hourly(200, to=datetime.fromtimestamp(first, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), now=now)
        n_req += 1
        if not page:
            complete = True
            break
        rows += [r for r in page if r[0] not in have]
        have |= {r[0] for r in page}
        if n_req % 50 == 0:
            log(f"이력 거슬러 받는 중 {n_req}회 · {datetime.fromtimestamp(first, timezone.utc):%Y-%m-%d}")
    rows = sorted(r for r in rows if r[0] >= start_t)
    if rows:
        save_history(rows, complete)
    log(f"이력 {len(rows):,}봉 ({'완료' if complete else '이어 받는 중'}) · 요청 {n_req}회")
    return rows, complete


# ── 데이터 ──────────────────────────────────────────
class Data:
    def __init__(self, rows):
        self.bars = core.Bars.from_rows(rows)
        b = self.bars
        self.n = len(b)
        self.T = np.array([b.t(i) + H for i in range(self.n)], dtype=np.int64)  # 판단 시각(봉 끝)
        self.F = {k: np.array(v, dtype=np.float64) for k, v in core.features(b).items()}
        self.c = np.array(b.c)
        self.act = np.array(b.a, dtype=bool)
        lc = np.log(self.c)
        with np.errstate(all="ignore"):
            self.sig_h = np.exp(0.3 * np.log(self.F["_s24"]) + 0.4 * np.log(self.F["_s168"]) + 0.3 * np.log(self.F["_s720"]))
        self.hk = ((self.T // H) + 9) % 24
        self.Y = {}
        for h in (1, 24):
            y = np.full(self.n, np.nan)
            y[:-h] = lc[h:] - lc[:-h]
            ok = np.zeros(self.n, bool)
            ok[:-h] = self.act[h:]
            y[~ok] = np.nan
            self.Y[h] = y

    def X(self, cols):
        return np.column_stack([self.F[c] for c in cols]) if cols else np.zeros((self.n, 0))


def month_bounds(T, start):
    a = datetime.fromisoformat(start).replace(tzinfo=timezone.utc)
    end = int(T[-1]) + 1
    out = []
    while int(a.timestamp()) < end:
        b = datetime(a.year + (a.month == 12), a.month % 12 + 1, 1, tzinfo=timezone.utc)
        out.append((int(a.timestamp()), min(int(b.timestamp()), end)))
        a = b
    return out


class Horizon:
    """한 기간(24·1시간)의 표본: z = 수익률/변동성 σ(방법: mix·har·garch, 매달 다시 맞춤), 학습 표본 고르기(엠바고)"""

    def __init__(self, D, h, vol="mix"):
        self.D, self.h = D, h
        self.months = month_bounds(D.T, VAL0)
        self.emb = h * H
        self.vol_type = vol
        self.seas = np.ones(D.n)
        self.seas_last = None
        if h == 1:
            for a, b in self.months:
                te = (D.T >= a) & (D.T < b)
                self.seas[te] = self._seas_at(a)[D.hk[te]]
            self.seas_last = self._seas_at(int(D.T[-1]) + H)
        if vol == "har":
            self.sig, self.vol_spec = har_sigma(self)
        elif vol == "garch":
            self.sig, self.vol_spec = garch_sigma(self)
        else:
            self.sig = D.sig_h * math.sqrt(h) * self.seas
            self.vol_spec = {"type": "mix"}
        with np.errstate(all="ignore"):
            self.Z = np.clip(D.Y[h] / self.sig, -5, 5)
        self.UP = (D.Y[h] > 0).astype(float)

    def _seas_at(self, a):
        D = self.D
        tr = (D.T + 2 * H <= a) & (D.T >= a - 365 * 86400) & np.isfinite(D.Y[1]) & np.isfinite(D.sig_h)
        if tr.sum() < 1000:
            return np.ones(24)
        z2 = (D.Y[1][tr] / D.sig_h[tr]) ** 2
        tot = np.mean(z2)
        return np.array([math.sqrt(np.mean(z2[D.hk[tr] == k]) / tot) if (D.hk[tr] == k).sum() > 50 else 1.0 for k in range(24)])

    def train_idx(self, a, Xm):
        D = self.D
        m = (D.T + self.h * H + self.emb <= a) & np.isfinite(self.Z) & (D.T >= a - TRAIN_YEARS * 365 * 86400)
        if Xm.shape[1]:
            m &= np.isfinite(Xm).sum(1) >= int(math.ceil(Xm.shape[1] * 0.8))
        idx = np.nonzero(m)[0]
        return idx[::3] if self.h == 24 else idx  # 24시간 목표는 겹치는 표본이라 3시간마다

    def known(self, a, days):
        D = self.D
        return (D.T + self.h * H <= a) & (D.T >= a - days * 86400) & np.isfinite(self.Z)


# ── 변동성 σ 방법 (core.sigma_for 와 같은 정의) ───────────
def _rets(D):
    lc = np.log(D.c)
    r = np.r_[0.0, np.diff(lc)]
    return np.where(np.isfinite(r), r, 0.0)


def har_design(D, hh=24):
    """core.har_row 와 같은 설명 변수 (i ≥ 720 만), 목표 log(다음 hh 봉 실현분산)"""
    r = _rets(D)
    r2 = r * r
    neg2 = np.where(r < 0, r2, 0.0)
    c2 = np.r_[0.0, np.cumsum(r2)]
    cn = np.r_[0.0, np.cumsum(neg2)]
    n = D.n
    idx = np.arange(n)

    def wsum(cs, w):
        out = np.full(n, np.nan)
        ok = idx >= 719  # core.har_row 는 i-719..i 로 계산 (i ≥ 720 에서만 쓰지만 같은 창)
        out[ok] = cs[idx[ok] + 1] - cs[idx[ok] + 1 - w]
        return out

    rv24, rv168, rv720, rs24 = wsum(c2, 24), wsum(c2, 168), wsum(c2, 720), wsum(cn, 24)
    wk = np.full(n, np.nan)
    # 다음 hh 봉(i+1 … i+hh)의 시작 시각 = 판단 시각 + (k-1)시간 — 데이터 끝 너머도 달력으로 계산
    for k in range(1, hh + 1):
        ts = D.T + (k - 1) * H
        add = ((((ts // 86400) + 3) % 7) >= 5).astype(float)
        wk = add if k == 1 else wk + add
    wk = wk / hh
    X = np.column_stack([np.ones(n), np.log(rv24 + core.HAR_EPS), np.log(rv168 / 7 + core.HAR_EPS), np.log(rv720 / 30 + core.HAR_EPS),
                         np.log(rs24 + core.HAR_EPS), wk])
    X[idx < 720] = np.nan
    fut = np.full(n, np.nan)
    fut[:n - hh] = c2[1 + hh:n + 1] - c2[1:n + 1 - hh]
    return X, np.log(fut + core.HAR_EPS), fut


def har_sigma(hz, hh=24):
    D = hz.D
    X, yh, fut = har_design(D, hh)
    sig = np.full(D.n, np.nan)

    def fit(a):
        tr = (D.T + hh * H + hz.h * H <= a) & (D.T >= a - 3 * 365 * 86400) & np.isfinite(X).all(1) & np.isfinite(yh) & (fut > 0)
        beta, *_ = np.linalg.lstsq(X[tr], yh[tr], rcond=None)
        return beta

    a0 = hz.months[0][0]
    pre = D.T < a0  # 검증 시작 전 칸(첫 몇 달 보정에 쓰는 잔차용) — 첫 달 계수로 (시험 구간에는 영향 없음)
    sig[pre] = np.sqrt(np.exp(X[pre] @ fit(a0)) * hz.h / hh) * hz.seas[pre]
    for a, b in hz.months:
        te = (D.T >= a) & (D.T < b)
        if te.any():
            sig[te] = np.sqrt(np.exp(X[te] @ fit(a)) * hz.h / hh) * hz.seas[te]
    beta = fit(int(D.T[-1]) + H)
    spec = {"type": "har", "hh": hh, "beta": [round(float(x), 6) for x in beta],
            "seas": [round(float(x), 4) for x in hz.seas_last] if hz.seas_last is not None else None}
    return sig, spec


def _seas_bar(D, a, years=2):
    """봉 시작 한국 시각별 변동성 배율 — 지난 2년 시간 수익 제곱 평균 / 전체"""
    r = _rets(D)
    tr = (D.T + H <= a) & (D.T >= a - years * 365 * 86400)
    sh = (D.hk - 1) % 24  # 봉 시작 시각
    r2 = r[tr] ** 2
    tot = r2.mean()
    return np.array([math.sqrt(r2[sh[tr] == k].mean() / tot) if (sh[tr] == k).sum() > 50 else 1.0 for k in range(24)])


def _garch_var(e, p, s0):
    from scipy.signal import lfilter
    om, al, ga, be = p[:4]
    u = np.r_[om, om + (al + ga * (e[:-1] < 0)) * e[:-1] ** 2]
    return lfilter([1.0], [1.0, -be], u, zi=[be * s0])[0]


def _garch_nll(th, e, s0):
    from scipy.special import gammaln
    om, al, ga, be, nu = th
    if om <= 0 or al < 0 or ga < 0 or be < 0 or al + ga / 2 + be >= 0.999 or nu <= 2.05:
        return 1e10
    v = _garch_var(e, th, s0)
    if not np.all(v > 0):
        return 1e10
    ll = gammaln((nu + 1) / 2) - gammaln(nu / 2) - 0.5 * np.log(np.pi * (nu - 2) * v) - (nu + 1) / 2 * np.log1p(e * e / ((nu - 2) * v))
    return -float(np.sum(ll))


def fit_garch(e, x0=None):
    """최대우도 — 시작점 몇 개에서 Nelder-Mead 후 가장 좋은 것 (가능도가 평평해 한 시작점은 지역 최적에 빠지기 쉽다)"""
    from scipy.optimize import minimize
    s0 = float(np.var(e))
    starts = [[s0 * 0.05, 0.05, 0.05, 0.88, 5.0], [s0 * 0.02, 0.10, 0.02, 0.86, 4.0], [s0 * 0.10, 0.15, 0.05, 0.75, 6.0]]
    if x0 is not None:
        starts.insert(0, list(x0))
    best = None
    for st in starts:
        res = minimize(_garch_nll, np.array(st), args=(e, s0), method="Nelder-Mead",
                       options={"maxiter": 6000, "xatol": 1e-8, "fatol": 1e-5})
        if best is None or res.fun < best.fun - 1e-6:
            best = res
    return best.x


def garch_sigma(hz):
    """1시간: GJR-GARCH(1,1)-t — 시간대 배율로 나눈 수익(%)을 지난 2년으로 매달 최대우도, 같은 모수로 재귀"""
    D = hz.D
    r = _rets(D)
    sh = (D.hk - 1) % 24
    sig = np.full(D.n, np.nan)
    x0 = None

    def prep(a):
        f = _seas_bar(D, a)
        e = r / f[sh] * 100
        lo = int(np.searchsorted(D.T, a - 2 * 365 * 86400))
        end = int(np.searchsorted(D.T, a - 2 * H))
        return f, e, lo, end

    first = True
    nm = WFCache.name("garch", 1)
    for a, b in hz.months:
        te_idx = np.nonzero((D.T >= a) & (D.T < b))[0]
        if not len(te_idx):
            continue
        hit = None if first else cache().get(nm, a, D.T[te_idx])
        if hit is not None:
            sig[te_idx] = hit
            continue
        f, e, lo, end = prep(a)
        th = fit_garch(e[lo + 1:end], x0)
        x0 = th
        if first:  # 검증 시작 전 칸(첫 몇 달 보정용 잔차) — 첫 달 모수로 (시험 구간에는 영향 없음)
            first = False
            v0 = _garch_var(e[1:te_idx[0] + 1], th, float(np.var(e[lo + 1:end])))
            sig[0:te_idx[0]] = np.sqrt(v0) / 100 * f[D.hk[0:te_idx[0]]]  # v0[k] = 판단 칸 k 의 다음 봉 분산
        seg = e[lo + 1:min(D.n, te_idx[-1] + 2)]
        v = _garch_var(seg, th, float(np.var(e[lo + 1:end])))
        k = te_idx - lo
        ok = k < len(v)
        nxt = np.full(len(te_idx), np.nan)
        nxt[ok] = np.sqrt(v[k[ok]]) / 100
        # 마지막 칸(다음 봉이 아직 없음)은 재귀 한 걸음 더
        if not ok[-1]:
            i = te_idx[-1]
            vi = v[-1] if len(v) else float(np.var(e[lo + 1:end]))
            ei = e[i]
            nxt[-1] = math.sqrt(th[0] + (th[1] + (th[2] if ei < 0 else 0.0)) * ei * ei + th[3] * vi) / 100
        sig[te_idx] = nxt * f[D.hk[te_idx]]
        cache().put(nm, a, D.T[te_idx], sig[te_idx])
    f, e, lo, end = prep(int(D.T[-1]) + H)
    th = fit_garch(e[lo + 1:end], x0)
    spec = {"type": "garch", "p": [float(x) for x in th], "seasBar": [round(float(x), 5) for x in f]}
    log(f"GJR-GARCH-t 모수 ω={th[0]:.4f} α={th[1]:.3f} γ={th[2]:.3f} β={th[3]:.3f} ν={th[4]:.2f}")
    return sig, spec


# ── 워크포워드 결과 저장 (지난 달은 학습 표본·모델이 그대로라 결과도 같다 → 매일 이번 달만 다시) ──
CACHE_FILE = core.HIST / "wf_cache.npz"
CACHE_VER = "1"


class WFCache:
    def __init__(self):
        self.data, self.dirty = {}, False
        try:
            with np.load(CACHE_FILE, allow_pickle=False) as z:
                if str(z["_ver"]) == CACHE_VER:
                    self.data = {k: z[k] for k in z.files if k != "_ver"}
        except (OSError, ValueError, KeyError):
            pass

    @staticmethod
    def name(*parts):
        import hashlib
        return hashlib.sha1(json_dumps(parts).encode()).hexdigest()[:16]

    def get(self, name, a, t_te):
        t = self.data.get(f"{name}|{a}|T")
        return self.data.get(f"{name}|{a}|V") if t is not None and np.array_equal(t, t_te) else None

    def put(self, name, a, t_te, v):
        self.data[f"{name}|{a}|T"] = np.asarray(t_te)
        self.data[f"{name}|{a}|V"] = np.asarray(v)
        self.dirty = True

    def save(self):
        if not self.dirty:
            return
        CACHE_FILE.parent.mkdir(parents=True, exist_ok=True)
        tmp = CACHE_FILE.with_name(CACHE_FILE.stem + ".tmp.npz")
        np.savez_compressed(tmp, _ver=np.array(CACHE_VER), **self.data)
        tmp.replace(CACHE_FILE)
        self.dirty = False


def json_dumps(x):
    import json
    return json.dumps(x, sort_keys=True, ensure_ascii=False, default=str)


CACHE = None


def cache():
    global CACHE
    if CACHE is None:
        CACHE = WFCache()
    return CACHE


# ── 워크포워드 ───────────────────────────────────────
def wf_raw(hz, kind, cols, cfg):
    X = hz.D.X(cols)
    raw = np.full(hz.D.n, np.nan)
    nm = WFCache.name("raw", hz.h, kind, list(cols), cfg, hz.vol_type, TRAIN_YEARS)  # σ 방법이 바뀌면 학습 표본·목표도 바뀐다
    for a, b in hz.months:
        te = (hz.D.T >= a) & (hz.D.T < b)
        if not te.any():
            continue
        hit = cache().get(nm, a, hz.D.T[te])
        if hit is not None:
            raw[te] = hit
            continue
        idx = hz.train_idx(a, X)
        if len(idx) < 2000:
            continue
        pred, _ = models.fit(kind, X[idx], hz.Z[idx], hz.UP[idx], cfg, cols, export=False)
        raw[te] = pred(X[te])
        cache().put(nm, a, hz.D.T[te], raw[te])
    return raw


def wf_width(hz, cols, cfg):
    """LightGBM 분위(10·50·90%) — 범위 폭과 기울기만 쓴다 (가운데는 위치 모델)"""
    import lightgbm as lgb
    X = hz.D.X(cols)
    out = {q: np.full(hz.D.n, np.nan) for q in (0.1, 0.5, 0.9)}
    nm = WFCache.name("width", hz.h, list(cols), cfg, hz.vol_type, TRAIN_YEARS)
    for a, b in hz.months:
        te = (hz.D.T >= a) & (hz.D.T < b)
        if not te.any():
            continue
        hit = cache().get(nm, a, hz.D.T[te])
        if hit is not None:
            for j, q in enumerate(out):
                out[q][te] = hit[:, j]
            continue
        idx = hz.train_idx(a, X)
        if len(idx) < 2000:
            continue
        for q in out:
            m = lgb.LGBMRegressor(objective="quantile", alpha=q, **models._lgb_params(cfg)).fit(X[idx], hz.Z[idx])
            out[q][te] = m.predict(X[te])
        cache().put(nm, a, hz.D.T[te], np.column_stack([out[q][te] for q in out]))
    return out


# ── 보정 ────────────────────────────────────────────
def _centered(e):
    e = e[np.isfinite(e)]
    return np.sort(e - np.median(e))


def _p_from(es, loc):
    return 1.0 - np.searchsorted(es, -loc, side="right") / len(es)


def calib_params(hz, raw, unit, a):
    """시각 a 직전까지 확정된(지난 2년) 표본 밖 원점수로 보정값 — 최종 모델에도 같은 함수"""
    hist = hz.known(a, 730) & np.isfinite(raw)
    if hist.sum() < 150 * 24:
        return {"type": "kappa", "k": 0.0}
    if unit == "z":
        best, bk = None, 0.0
        for k in KAP:
            es = _centered(hz.Z[hist] - k * raw[hist])
            p = _p_from(es, k * raw[hist])
            bs = float(np.mean((p - hz.UP[hist]) ** 2))
            if best is None or bs < best - 1e-7:
                best, bk = bs, k
        return {"type": "kappa", "k": bk}
    from sklearn.linear_model import LogisticRegression
    cl = LogisticRegression(C=1.0).fit(raw[hist].reshape(-1, 1), hz.UP[hist].astype(int))
    return {"type": "platt", "a": float(cl.intercept_[0]), "b": float(cl.coef_[0, 0])}


def apply_calib(hz, raw, cp, a, sel):
    """sel 칸들의 (오를 확률, 위치 z, 잔차 분포) — 잔차는 지난 1년 확정 표본 밖"""
    if cp["type"] == "kappa" and cp["k"] > 0:
        h1 = hz.known(a, 365) & np.isfinite(raw)
        es = _centered(hz.Z[h1] - cp["k"] * raw[h1])
        loc = cp["k"] * np.nan_to_num(raw[sel])
        return _p_from(es, loc), loc, es
    es = _centered(hz.Z[hz.known(a, 365)])
    if cp["type"] == "kappa":  # 신호 없음: 위치 0
        loc = np.zeros(int(sel.sum()))
        return _p_from(es, loc), loc, es
    lo = cp["a"] + cp["b"] * np.nan_to_num(raw[sel])
    p = 1.0 / (1.0 + np.exp(-np.clip(lo, -30, 30)))
    return p, -np.quantile(es, np.clip(1 - p, 0.001, 0.999)), es


def run_recipe(hz, rc):
    """→ o: p, loc, q10, q90 (z 단위, ACI 배율 적용), s_now(마지막 배율), raw, width"""
    D = hz.D
    kind, cols, cfg = rc["loc"]
    unit = models.UNIT[kind]
    raw = wf_raw(hz, kind, cols, cfg) if kind != "zero" else np.zeros(D.n)
    width = wf_width(hz, rc["width"][0], rc["width"][1]) if rc.get("width") else None
    o = {k: np.full(D.n, np.nan) for k in ("p", "loc", "lo", "hi", "k")}
    for a, b in hz.months:
        te = (D.T >= a) & (D.T < b) & np.isfinite(raw)
        if not te.any():
            continue
        cp = calib_params(hz, raw, unit, a)
        p, loc, es = apply_calib(hz, raw, cp, a, te)
        o["p"][te], o["loc"][te] = p, loc
        q = np.quantile(es, [0.1, 0.9])  # 잔차 분위(FHS)
        o["lo"][te], o["hi"][te] = q[0], q[1]
        if width is not None and np.isfinite(width[0.5][te]).all():
            # 분위 모델 폭 — width_mix 만큼 섞는다 (1 = 분위 모델만, 0.5 = FHS 와 반반 평균 · 분위 평균)
            wm = rc.get("width_mix", 1.0)
            g10, g50, g90 = width[0.1][te], width[0.5][te], width[0.9][te]
            o["lo"][te] = (1 - wm) * q[0] + wm * (np.minimum(g10, g50 - 1e-3) - g50)
            o["hi"][te] = (1 - wm) * q[1] + wm * (np.maximum(g90, g50 + 1e-3) - g50)
        o["k"][te] = cp.get("k", cp.get("b", 0.0))
    o["q10"], o["q90"], s_now = aci(hz, o, rc.get("aci", ACI_GAMMA))
    o["raw"], o["width"], o["unit"], o["s_now"] = raw, width, unit, s_now
    return o


def aci(hz, o, gamma=ACI_GAMMA, alpha=ACI_ALPHA):
    """적응 conformal: 낸 범위의 결과가 확정될 때마다 배율 조정 (목표 빗나감 20%). gamma 0/None 이면 배율 1 고정"""
    D = hz.D
    if not gamma:
        return o["loc"] + o["lo"], o["loc"] + o["hi"], 1.0
    q10 = np.full(D.n, np.nan)
    q90 = np.full(D.n, np.nan)
    s = 1.0
    pend = []
    head = 0
    lag = hz.h * H
    for i in range(D.n):
        while head < len(pend) and D.T[pend[head]] + lag <= D.T[i]:
            j = pend[head]
            head += 1
            if np.isfinite(hz.Z[j]):
                miss = 0.0 if q10[j] <= hz.Z[j] <= q90[j] else 1.0
                s = min(2.5, max(0.4, s * math.exp(gamma * (miss - alpha))))
        if np.isfinite(o["loc"][i]) and np.isfinite(o["lo"][i]):
            q10[i] = o["loc"][i] + s * o["lo"][i]
            q90[i] = o["loc"][i] + s * o["hi"][i]
            pend.append(i)
    # 마지막 칸 이후에 확정된 것까지 (지금 기준 배율)
    now = int(D.T[-1]) + H
    while head < len(pend) and D.T[pend[head]] + lag <= now:
        j = pend[head]
        head += 1
        if np.isfinite(hz.Z[j]):
            miss = 0.0 if q10[j] <= hz.Z[j] <= q90[j] else 1.0
            s = min(2.5, max(0.4, s * math.exp(gamma * (miss - alpha))))
    return q10, q90, s


# ── 평가 ────────────────────────────────────────────
def stats(hz, o, mask):
    from sklearn.metrics import roc_auc_score
    D = hz.D
    m = mask & np.isfinite(o["p"]) & np.isfinite(D.Y[hz.h]) & np.isfinite(o["q10"])
    if m.sum() < 10:
        return None
    up = hz.UP[m]
    p = o["p"][m]
    s = hz.sig[m]
    med = np.expm1(o["loc"][m] * s)
    act = np.expm1(D.Y[hz.h][m])
    lo, hi = np.expm1(o["q10"][m] * s), np.expm1(o["q90"][m] * s)
    said = med != 0
    hits = int(np.sum((med[said] > 0) == (act[said] > 0)))
    inr = int(np.sum((act >= lo) & (act <= hi)))
    b, b0 = float(np.mean((p - up) ** 2)), float(np.mean((0.5 - up) ** 2))
    try:
        auc = float(roc_auc_score(up, p)) if np.ptp(p) > 0 else 0.5
    except ValueError:
        auc = None
    y = D.Y[hz.h][m]
    pin = 0.0
    for q, f in ((0.1, o["q10"][m] * s), (0.5, o["loc"][m] * s), (0.9, o["q90"][m] * s)):
        d = y - f
        pin += float(np.mean(np.maximum(q * d, (q - 1) * d)))
    return {"hit": hits / max(1, int(said.sum())), "dir": [hits, int(said.sum())], "cov": inr / len(act), "range": [inr, int(len(act))],
            "bss": 1 - b / b0, "auc": auc, "upRate": float(up.mean()), "width": float(np.mean(hi - lo)), "n": int(len(act)),
            "pinball": pin / 3 * 100}


def calib_table(hz, o, mask, bins=5):
    """예상 %(중앙값) 구간별 실제 중앙·평균·오른 비율 + 구간 중앙값끼리 기울기(1 이면 잘 맞음)"""
    D = hz.D
    m = mask & np.isfinite(o["loc"]) & np.isfinite(D.Y[hz.h])
    pred = np.expm1(o["loc"][m] * hz.sig[m])
    act = np.expm1(D.Y[hz.h][m])
    if len(pred) < bins * 30 or np.ptp(pred) == 0:
        return [], None
    qs = np.quantile(pred, np.linspace(0, 1, bins + 1))
    rows = []
    for i in range(bins):
        s = (pred >= qs[i]) & ((pred < qs[i + 1]) if i < bins - 1 else (pred <= qs[i + 1]))
        if s.sum() < 10:
            continue
        rows.append({"pred": float(np.median(pred[s])), "actMed": float(np.median(act[s])), "actMean": float(np.mean(act[s])),
                     "up": float(np.mean(act[s] > 0)), "n": int(s.sum())})
    xs, ys = [r["pred"] for r in rows], [r["actMed"] for r in rows]
    slope = float(np.polyfit(xs, ys, 1)[0]) if len(rows) >= 3 and np.ptp(xs) > 0 else None
    return rows, slope


def periods(hz):
    D = hz.D
    t_end = int(D.T[-1])
    test = (D.T >= _ts(TEST0 + "T00:00:00")) & np.isfinite(D.Y[hz.h])
    return {"val": (D.T >= _ts(VAL0 + "T00:00:00")) & (D.T < _ts(TEST0 + "T00:00:00")) & np.isfinite(D.Y[hz.h]),
            "test": test, "y1": test & (D.T >= t_end - 365 * 86400), "d30": test & (D.T >= t_end - 30 * 86400),
            "daily": (D.hk == 9) if hz.h == 24 else np.ones(D.n, bool)}


# ── 최종 학습 · 내보내기 ─────────────────────────────
def final_spec(hz, rc, o):
    D = hz.D
    now_a = int(D.T[-1]) + H
    kind, cols, cfg = rc["loc"]
    X = D.X(cols)
    idx = hz.train_idx(now_a, X)
    _, spec = models.fit(kind, X[idx], hz.Z[idx], hz.UP[idx], cfg, cols, export=True)
    cp = calib_params(hz, o["raw"], o["unit"], now_a)
    _, _, es = apply_calib(hz, o["raw"], cp, now_a, np.zeros(D.n, bool))
    s = o["s_now"]
    q = np.quantile(es, [0.1, 0.9])
    comb = {"type": "kappa", "k": cp["k"], "w": {"m": 1.0}} if cp["type"] == "kappa" else {"type": "platt", "a": cp["a"], "w": {"m": cp["b"]}}
    hspec = {"h": hz.h, "vol": hz.vol_spec, "models": {"m": spec}, "combine": comb,
             "dist": {"ep": EP, "eq": [round(float(x), 5) for x in np.quantile(es, EP)], "lo": round(float(q[0]), 5),
                      "hi": round(float(q[1]), 5), "scale": round(s, 4)},
             "seas": [round(float(x), 4) for x in hz.seas_last] if hz.seas_last is not None else None,
             "range": None, "name": rc["name"], "kind": kind}
    if rc.get("width"):
        import lightgbm as lgb
        wcols, wcfg = rc["width"]
        Xw = D.X(wcols)
        widx = hz.train_idx(now_a, Xw)
        rng = {"mix": rc.get("width_mix", 1.0)}
        chk = Xw[widx][np.linspace(0, len(widx) - 1, min(300, len(widx))).astype(int)]
        for q, key in ((0.1, "q10"), (0.5, "q50"), (0.9, "q90")):
            m = lgb.LGBMRegressor(objective="quantile", alpha=q, **models._lgb_params(wcfg)).fit(Xw[widx], hz.Z[widx])
            rng[key] = models._export_lgbm(m, wcols, "lgbm_r", chk)
        hspec["range"] = rng
    # 매 실행(표준 라이브러리)이 같은 계수로 같은 σ 를 내는지 마지막 칸으로 확인
    i = D.n - 1
    s_std = core.sigma_for(hspec, D.bars, D.F, i)
    vs = hspec["vol"]
    if vs["type"] == "har":
        X, _, _ = har_design(D, vs.get("hh", 24))
        s_np = math.sqrt(math.exp(float(X[i] @ np.array(vs["beta"]))) * hz.h / vs.get("hh", 24)) * (vs["seas"][D.hk[i]] if vs.get("seas") else 1.0)
    elif vs["type"] == "garch":
        f = np.array(vs["seasBar"])
        e = _rets(D) / f[(D.hk - 1) % 24] * 100
        th = vs["p"]
        v = _garch_var(e[max(1, i - 3000):i + 1], th, float(np.var(e[max(1, i - 3000):i + 1])))
        ei = e[i]
        s_np = math.sqrt(th[0] + (th[1] + (th[2] if ei < 0 else 0.0)) * ei * ei + th[3] * v[-1]) / 100 * f[D.hk[i]]
    else:
        s_np = float(hz.sig[i])
    if not (abs(s_std / s_np - 1) < 0.005):
        log(f"주의: {hz.h}시간 σ 가 학습 계산({s_np:.6f})과 매 실행 계산({s_std:.6f})에서 달라요")
    return hspec


def pivot_evidence(D):
    """매일 오전 9시(한국) 판단 시각마다: 후보 선 위/아래 → 다음 24시간 오른 비율 (2019-01~, 최근 2년)"""
    b = D.bars
    y = D.Y[24]
    t_end = int(D.T[-1])
    idx = [i for i in range(D.n) if D.hk[i] == 9 and D.T[i] >= _ts("2019-01-01T00:00:00") and np.isfinite(y[i])]
    lv = {k: [] for k in core.PIVOTS}
    for i in idx:
        L = core.pivot_levels(b, i)
        for k in core.PIVOTS:
            lv[k].append(L.get(k, math.nan))
    up = y[idx] > 0
    recent = D.T[idx] >= t_end - 730 * 86400
    c = D.c[idx]
    out = {}
    for k in core.PIVOTS:
        L = np.array(lv[k])
        ok = np.isfinite(L)
        a, bl = ok & (c > L), ok & ~(c > L)
        pa, pb = float(up[a].mean()), float(up[bl].mean())
        se = math.sqrt(pa * (1 - pa) / max(1, a.sum()) + pb * (1 - pb) / max(1, bl.sum()))
        out[k] = {"above": round(pa, 4), "below": round(pb, 4),
                  "above2y": round(float(up[a & recent].mean()), 4) if (a & recent).sum() >= 30 else None,
                  "below2y": round(float(up[bl & recent].mean()), 4) if (bl & recent).sum() >= 30 else None,
                  "from": "2019-01-01", "days": int(ok.sum()), "t": round((pa - pb) / se, 2) if se > 0 else 0.0}
    return out


def _r(x, d=4):
    return None if x is None or (isinstance(x, float) and not math.isfinite(x)) else round(float(x), d)


def _clean(st):
    return {k: (_r(v, 5) if isinstance(v, float) else v) for k, v in st.items()} if st else None


def train(deadline=None):
    t0 = time.time()
    rows, complete = update_history(deadline)
    if len(rows) < 24 * 365 * 3:
        log(f"이력이 아직 짧아요 ({len(rows)}봉) — 다음에 이어 받고 학습")
        return False
    D = Data(rows)
    log(f"특징 계산 {D.n:,}칸 ({time.time() - t0:.0f}초)")
    out = {"version": 1, "trainedAt": core.iso(time.time()), "dataFrom": core.iso(D.bars.t0), "dataTo": core.iso(int(D.T[-1])),
           "bars": D.n, "complete": complete}
    bt = {"trainedAt": out["trainedAt"], "long": {"from": TEST0}}
    compare = {}
    for h in (24, 1):
        th = time.time()
        hz = Horizon(D, h, RECIPES[h].get("vol", "mix"))
        P = periods(hz)
        dmask = P["daily"]
        rc = RECIPES[h]
        base = run_recipe(hz, {**BASELINE, "aci": rc.get("aci", ACI_GAMMA)})  # 범위 보정 방식은 같게 — 위치·폭 모델만 비교
        o = run_recipe(hz, rc)
        sb, so = stats(hz, base, P["test"] & dmask), stats(hz, o, P["test"] & dmask)
        if so is None or (sb is not None and so["bss"] < sb["bss"] - 0.001):  # 0.1%p 넘게 나쁠 때만 (날마다 오락가락 않게)
            log(f"{h}시간: '{rc['name']}' 이 시험 구간에서 기준선보다 나빠 기준선을 써요")
            rc, o = BASELINE, base
        key = f"h{h}"
        out[key] = final_spec(hz, rc, o)
        bt[key] = _clean(stats(hz, o, P["y1"] & dmask))
        bt["long"][key] = _clean(stats(hz, o, P["test"] & dmask))
        cal, slope = calib_table(hz, o, P["y1"])
        bt[f"calib{h}"] = [{k: (_r(v, 5) if isinstance(v, float) else v) for k, v in r.items()} for r in cal]
        bt[f"slope{h}"] = _r(slope, 3)
        if h == 24:
            d30 = stats(hz, o, P["d30"] & dmask)
            bt["d30"] = {"dir": d30["dir"], "range": d30["range"]} if d30 else {"dir": [0, 0], "range": [0, 0]}
        bt[f"model{h}"] = model_name(out[key])
        compare[key] = [{"name": r_["name"], "val": _clean(stats(hz, oo, P["val"] & dmask)), "test": _clean(stats(hz, oo, P["test"] & dmask)),
                         "y1": _clean(stats(hz, oo, P["y1"] & dmask)), "chosen": r_ is rc} for r_, oo in ((BASELINE, base), (RECIPES[h], o))]
        st = bt["long"][key]
        log(f"{h}시간 · {rc['name']}: 2021~ 방향 {st['hit']:.3f} 브라이어개선 {st['bss'] * 100:+.2f}% 범위 {st['cov']:.3f} "
            f"분위손실 {st['pinball']:.4f} (기준선 {sb['pinball']:.4f}) · 지난 1년 방향 {bt[key]['hit']:.3f} 범위 {bt[key]['cov']:.3f} "
            f"· ACI 배율 {o['s_now']:.3f} · {time.time() - th:.0f}초")
    t_end = int(D.T[-1])
    bt["from"] = datetime.fromtimestamp(t_end - 365 * 86400, core.KST).date().isoformat()
    bt["to"] = datetime.fromtimestamp(t_end, core.KST).date().isoformat()
    out["backtest"] = bt
    out["compare"] = compare
    out["pivot"] = pivot_evidence(D)
    core.write_json(MODEL_FILE, out)
    hb = browser_h1(out["h1"], bt.get("h1") or {}, bt["long"].get("h1"))
    if hb:
        hb["backtest"] = {**(hb["backtest"] or {}), "from": bt["from"], "to": bt["to"]}
        core.write_json(core.OUT / "btc_h1.json", hb)
        log(f"브라우저용 1시간 계수 btc_h1.json ({(core.OUT / 'btc_h1.json').stat().st_size // 1024} KB)")
    cache().save()
    log(f"저장 {MODEL_FILE.name} ({MODEL_FILE.stat().st_size // 1024} KB) — {time.time() - t0:.0f}초")
    return True


def _sig(x, d=7):
    return float(f"{x:.{d}g}")


def browser_h1(spec, bt1, long1):
    """브라우저용 1시간 계수 (web/src/components/btc/h1.ts) — 나무는 유효숫자를 줄여 작게"""
    m = spec["models"]["m"]
    if m["type"] != "lgbm_c" or spec["combine"]["type"] != "platt" or (spec.get("vol") or {}).get("type") != "garch":
        return None
    trees = [{"f": t["f"], "t": [_sig(x, 9) for x in t["t"]], "d": t["d"], "m": t["m"], "l": t["l"], "r": t["r"],
              "v": [_sig(x, 6) for x in t["v"]]} for t in m["trees"]]
    d = spec["dist"]
    return {"version": 1, "trainedAt": core.iso(time.time()), "cols": m["cols"], "trees": trees,
            "platt": {"a": round(spec["combine"]["a"], 6), "b": round(spec["combine"]["w"]["m"], 6)},
            "ep": d["ep"], "eq": d["eq"], "lo": d["lo"], "hi": d["hi"], "scale": d["scale"],
            "garch": {"p": [_sig(x, 8) for x in spec["vol"]["p"]], "seasBar": spec["vol"]["seasBar"]},
            "backtest": {"hit": bt1.get("hit"), "bss": bt1.get("bss"), "cov": bt1.get("cov"), "auc": bt1.get("auc"),
                         "longHit": (long1 or {}).get("hit"), "longBss": (long1 or {}).get("bss")} if bt1 else None}


def model_name(spec):
    c = spec["combine"]
    if spec["kind"] == "zero" or (c["type"] == "kappa" and c["k"] == 0):
        base = "방향 신호 없음(0%)"
    elif c["type"] == "kappa":
        base = f"{spec['name']} · 축소 {c['k']:.1f}배"
    else:
        base = f"{spec['name']} · Platt 보정"
    vol = {"har": "HAR(하락 반분산·주말)", "garch": "GJR-GARCH-t(시간대 보정)"}.get((spec.get("vol") or {}).get("type"), "실현 변동성 가중")
    rng = spec.get("range")
    width = ("잔차 분위와 LightGBM 분위 폭 평균" if rng.get("mix", 1.0) < 1 else "LightGBM 분위 폭") if rng else "지난 1년 잔차 분위"
    sc = spec["dist"].get("scale", 1.0)
    return f"{base} · 변동성 {vol} · 범위 {width}" + (f" × 적응 배율 {sc:.2f}" if abs(sc - 1) > 1e-9 else "")
