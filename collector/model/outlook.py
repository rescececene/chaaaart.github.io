"""단기·중기·장기 예상 수익 — '지금과 비슷했던 과거 자리'의 실제 결과(백데이터)로만 만든 분포 + 그 방법의 워크포워드 검증

방법 (모형 점수는 쓰지 않는다 — 순위 모형은 이 기간들을 학습하지 않았다)
- 기간: 중기 1일·장기 1주 (주식 1·5거래일, 코인 1·7일). 단기 1시간은 hourly.py
- 자리 특징 10개 (그날까지의 데이터만): 5·20·60일 수익률(변동성 단위), RSI, 볼린저 %B, 52주 고점 대비, 60일 변동성(로그),
  거래량 추세(로그), 시장 전체 20일 추세·변동성
- 같은 시장 모든 종목(같은 종목 포함)의 과거 자리 중 특징 거리가 가장 가까운 K=100개. 한 날짜에서 최대 2개만
  (같은 날 시장 전체 움직임에 표본이 쏠리지 않게). 결과가 '예측 시점에 이미 확정된' 자리만 쓴다 (t + h ≤ 기준일).
- 그 자리들의 h 기간 뒤 실제 수익률 → 10·50·90% 분위, 오른 비율(win). 표본이 15개보다 적으면 내지 않는다.
- base: 같은 종목을 아무 날이나 샀을 때(그 종목의 과거 모든 h 기간 수익률)의 중앙값·오른 비율 — 비교 기준.

검증 (누수 없음): 과거 평가일 d 마다 d 이전에 결과가 확정된 자리만으로 같은 방식의 예상을 만들고, d 이후 실제 수익률과
비교한다. 평가일은 h 간격(겹치지 않게), 최근부터 최대 24회. 범위 적중률(목표 80%), 중앙값 방향 적중률, 오를 확률 보정,
같은 종목 기준값(base) 대비 브라이어 점수 개선 → 등급 good / weak / poor.
"""
import math
import time

import numpy as np

# 단기(1시간)는 hourly.py(시간봉)가 따로 만든다. 여기서는 중기 1일 · 장기 1주 (주식 1·5거래일, 코인 1·7일)
HORIZONS = {"upbit": (1, 7), "binance": (1, 7), "krx": (1, 5), "us": (1, 5)}
LABELS = ("중기", "장기")
K, K_BIG, PER_DATE = 100, 600, 2
MIN_N = 15          # 비슷한 자리가 이보다 적으면 그 기간은 내지 않는다
BASE_MIN = 30       # 같은 종목 기준값에 필요한 과거 표본 수
MAX_PERIODS = 24    # 기간별 검증 평가일 수 상한 (최근부터, h 간격)
MIN_HISTORY = 250   # 첫 평가일 전에 쌓여 있어야 하는 날짜 수
CAL_EDGES = (0.0, 0.3, 0.4, 0.5, 0.6, 0.7, 1.0001)


def _step(h):
    """후보 자리 솎기 간격 — 이웃한 날의 h 기간 결과는 거의 같으므로 (계산량 절약)"""
    return 1 if h <= 7 else 2 if h <= 30 else 3


def cube(P, F, M):
    """(날짜, 종목, 특징) 배열과 사용 가능 표시"""
    T, N = P["c"].shape
    with np.errstate(divide="ignore", invalid="ignore"):
        v60 = F["vol_60"].values
        mz = (M["mkt_ret_20"] / (M["mkt_vol_20"] * math.sqrt(20))).values
        mv = np.log(M["mkt_vol_20"].values)
        cols = [
            F["ret_5"].values / (v60 * math.sqrt(5)),
            F["ret_20"].values / (v60 * math.sqrt(20)),
            F["ret_60"].values / (v60 * math.sqrt(60)),
            F["rsi_14"].values / 100.0,
            np.clip(F["bb_pctb"].values, -0.5, 1.5),
            np.clip(F["hi_52w"].values, -1.0, 0.0),
            np.log(v60),
            np.log(np.clip(F["volu_5_20"].values, 0.05, 20.0)),
            np.broadcast_to(mz[:, None], (T, N)),
            np.broadcast_to(mv[:, None], (T, N)),
        ]
    X = np.stack(cols, axis=2).astype(np.float32)
    ok = np.isfinite(X).all(axis=2) & P["elig"].values & P["actual"].values
    return X, ok


def _fwd(C, h):
    out = np.full(C.shape, np.nan)
    with np.errstate(divide="ignore", invalid="ignore"):
        out[:-h] = C[h:] / C[:-h] - 1.0
    return out


class Pool:
    """시간 순으로 정렬한 후보 자리 (t, 종목, 특징, h 뒤 수익). cutoff 이하의 앞부분만 꺼내 쓴다."""

    def __init__(self, X, ok, y, h):
        s = _step(h)
        T = X.shape[0]
        m = ok & np.isfinite(y) & (np.arange(T)[:, None] % s == 0)
        t, j = np.nonzero(m)  # 행 우선 → t 오름차순
        self.t, self.j = t, j
        self.X = X[t, j]
        self.y = y[t, j]

    def upto(self, cutoff):
        return int(np.searchsorted(self.t, cutoff, side="right"))


def _knn(pool, n, Xq):
    """앞 n 개 후보에서 질의마다 K 개 이웃(날짜당 최대 PER_DATE) → (Q×K 수익, NaN 채움)"""
    Xp = pool.X[:n]
    med = np.median(Xp, axis=0)
    q1, q3 = np.quantile(Xp, [0.25, 0.75], axis=0)
    sc = np.where(q3 - q1 > 1e-9, (q3 - q1) / 1.349, 1.0).astype(np.float32)
    Zp = (Xp - med) / sc
    Zq = (Xq - med) / sc
    pn = (Zp * Zp).sum(axis=1)
    kb = min(K_BIG, n)
    out = np.full((len(Zq), K), np.nan)
    for a in range(0, len(Zq), 128):
        q = Zq[a:a + 128]
        d2 = (q * q).sum(axis=1)[:, None] + pn[None, :] - 2.0 * (q @ Zp.T)
        idx = np.argpartition(d2, kb - 1, axis=1)[:, :kb] if kb < n else np.tile(np.arange(n), (len(q), 1))
        dd = np.take_along_axis(d2, idx, axis=1)
        idx = np.take_along_axis(idx, np.argsort(dd, axis=1, kind="stable"), axis=1)
        dt = pool.t[idx]
        # 같은 날짜가 몇 번째로 나왔는지 (가까운 순서대로) → PER_DATE 개까지만
        o = np.argsort(dt, axis=1, kind="stable")
        sd = np.take_along_axis(dt, o, axis=1)
        new = np.ones_like(sd, dtype=bool)
        new[:, 1:] = sd[:, 1:] != sd[:, :-1]
        pos = np.arange(sd.shape[1])[None, :].repeat(len(sd), axis=0)
        start = np.maximum.accumulate(np.where(new, pos, 0), axis=1)
        occ_sorted = pos - start
        occ = np.empty_like(occ_sorted)
        np.put_along_axis(occ, o, occ_sorted, axis=1)
        keep = occ < PER_DATE
        keep &= np.cumsum(keep, axis=1) <= K
        yy = np.where(keep, pool.y[idx], np.nan)
        # 앞쪽으로 모아 K 칸에 담는다
        order = np.argsort(~keep, axis=1, kind="stable")[:, :K]
        out[a:a + len(q), :order.shape[1]] = np.take_along_axis(yy, order, axis=1)
    return out


def _dist(Y):
    n = np.isfinite(Y).sum(axis=1)
    with np.errstate(all="ignore"):
        q = np.nanquantile(Y, [0.1, 0.5, 0.9], axis=1) if Y.size else np.full((3, 0), np.nan)
        win = np.nanmean(np.where(np.isfinite(Y), Y > 0, np.nan), axis=1)
    return n, q[0], q[1], q[2], win


class Base:
    """같은 종목을 아무 날이나 샀을 때 — 종목별 (t, h 뒤 수익) 누적"""

    def __init__(self, ok, y):
        self.by = {}
        for j in range(y.shape[1]):
            t = np.nonzero(ok[:, j] & np.isfinite(y[:, j]))[0]
            self.by[j] = (t, y[t, j])

    def at(self, j, cutoff):
        t, v = self.by.get(j, (np.array([], int), np.array([])))
        v = v[:np.searchsorted(t, cutoff, side="right")]
        if len(v) < BASE_MIN:
            return None
        return float(np.median(v)), float((v > 0).mean())


def _grade(cov, cal_err, bss, slope):
    """good: 범위 적중 80±7%p, 확률 보정 오차 ≤5%p, 같은 종목 기준값보다 브라이어 점수 2% 이상 개선, 확률이 높을수록 실제로 더 오름
    weak: 범위 80±10%p, 보정 오차 ≤10%p, 기준값보다 크게 나쁘지 않음(−2% 이내), 확률 방향은 맞음 / poor: 그 밖"""
    if cov is None or bss is None or slope is None:
        return "poor"
    if abs(cov - 0.8) <= 0.07 and cal_err <= 0.05 and bss > 0.02 and slope > 0:
        return "good"
    if abs(cov - 0.8) <= 0.10 and cal_err <= 0.10 and bss > -0.02 and slope > 0:
        return "weak"
    return "poor"


def backtest_h(X, ok, y, pool, base, h, last, first_ok):
    """평가일 d: d 이전에 결과가 확정된 자리(t ≤ d − h)만으로 예상 → d 이후 실제 h 수익과 비교"""
    d_min = first_ok + MIN_HISTORY + h
    days = []
    d = last - h
    cap = 60 if h <= 1 else MAX_PERIODS  # 1일 기간은 평가일이 촘촘해도 겹치지 않으므로 더 많이
    while d >= d_min and len(days) < cap:
        days.append(d)
        d -= h
    rec = {k: [] for k in ("y", "q10", "q50", "q90", "win", "bwin", "bq50")}
    used = 0
    for d in sorted(days):
        n_pool = pool.upto(d - h)
        if n_pool < 20 * K:
            continue
        js = np.nonzero(ok[d] & np.isfinite(y[d]))[0]
        if len(js) < 5:
            continue
        Y = _knn(pool, n_pool, X[d, js])
        n, q10, q50, q90, win = _dist(Y)
        good = n >= MIN_N
        if not good.any():
            continue
        used += 1
        for i in np.nonzero(good)[0]:
            j = js[i]
            b = base.at(j, d - h)
            rec["y"].append(y[d, j])
            rec["q10"].append(q10[i])
            rec["q50"].append(q50[i])
            rec["q90"].append(q90[i])
            rec["win"].append(win[i])
            rec["bwin"].append(b[1] if b else np.nan)
            rec["bq50"].append(b[0] if b else np.nan)
    if used < 3:
        return None
    r = {k: np.array(v, dtype=float) for k, v in rec.items()}
    yv = r["y"]
    up = yv > 0
    nz = yv != 0
    cov = float(((yv >= r["q10"]) & (yv <= r["q90"])).mean())
    dir_hit = float(((r["q50"] > 0) == up)[nz].mean())
    hb = np.isfinite(r["bq50"])
    base_dir = float(((r["bq50"][hb] > 0) == up[hb])[nz[hb]].mean()) if hb.sum() >= 50 else None
    calib, err_w, err_n = [], 0.0, 0
    for lo, hi in zip(CAL_EDGES[:-1], CAL_EDGES[1:]):
        sel = (r["win"] >= lo) & (r["win"] < hi)
        if sel.sum() >= 20:
            p, a = float(r["win"][sel].mean()), float(up[sel].mean())
            calib.append({"p": p, "actual": a, "n": int(sel.sum())})
            err_w += abs(p - a) * sel.sum()
            err_n += sel.sum()
    cal_err = err_w / err_n if err_n else 1.0
    w = r["win"]
    slope = float(np.polyfit(w, up.astype(float), 1)[0]) if np.ptp(w) > 0 else None  # 확률 1 단위당 실제 오른 비율 변화
    bss = None
    if hb.sum() >= 50:
        br = np.mean((r["win"][hb] - up[hb]) ** 2)
        bb = np.mean((r["bwin"][hb] - up[hb]) ** 2)
        bss = float(1.0 - br / bb) if bb > 0 else None
    return {"h": h, "periods": used, "n": int(len(yv)), "coverage": cov, "dirHit": dir_hit, "baseDirHit": base_dir,
            "calib": calib, "calibErr": float(cal_err), "calibSlope": slope, "brierSkill": bss,
            "grade": _grade(cov, cal_err, bss, slope)}


def run(P, F, M, market, js_today, log=print):
    """반환 (outlook {j: [기간 3개]}, 검증 {라벨: {...}})"""
    t0 = time.time()
    X, ok = cube(P, F, M)
    C = P["c"].values
    T = C.shape[0]
    last = T - 1
    cnt = ok.sum(axis=1)
    first_ok = int(np.argmax(cnt >= max(5, int(cnt.max() * 0.2))))
    out = {j: [] for j in js_today}
    bt = {}
    for h, label in zip(HORIZONS[market], LABELS):
        y = _fwd(C, h)
        pool = Pool(X, ok, y, h)
        base = Base(ok, y)
        b = backtest_h(X, ok, y, pool, base, h, last, first_ok)
        bt[label] = b
        grade = b["grade"] if b else None
        n_pool = pool.upto(last - h)
        qj = [j for j in js_today if ok[last, j]]
        res = {}
        if qj and n_pool >= 20 * K:
            n, q10, q50, q90, win = _dist(_knn(pool, n_pool, X[last, qj]))
            res = {j: (int(n[i]), q10[i], q50[i], q90[i], win[i]) for i, j in enumerate(qj)}
        for j in js_today:
            bj = base.at(j, last - h)
            item = {"h": h, "unit": "d", "label": label, "n": 0, "q10": None, "q50": None, "q90": None, "win": None,
                    "base": {"q50": bj[0], "win": bj[1]} if bj else None, "grade": grade}
            if j not in res:
                item["reason"] = ("이력이 짧아 지금 자리의 특징을 계산할 수 없어요." if not ok[last, j]
                                  else "비교할 과거 자리가 부족해요.")
            else:
                n, a10, a50, a90, w = res[j]
                item["n"] = n
                if n < MIN_N:
                    item["reason"] = f"비슷한 과거 자리가 {n}개뿐이라(최소 {MIN_N}개) 내지 않아요."
                else:
                    item.update(q10=float(a10), q50=float(a50), q90=float(a90), win=float(w))
            out[j].append(item)
        if b:
            log(f"  · 전망 {label}({h}{'일' if market in ('upbit', 'binance') else '거래일'}): 검증 {b['periods']}회 "
                f"{b['n']:,}건, 범위 적중 {b['coverage']:.3f}, 방향 {b['dirHit']:.3f}(기준 "
                f"{'n/a' if b['baseDirHit'] is None else round(b['baseDirHit'], 3)}), 보정 오차 {b['calibErr']:.3f} "
                f"기울기 {'n/a' if b['calibSlope'] is None else round(b['calibSlope'], 2)}, "
                f"브라이어 개선 {'n/a' if b['brierSkill'] is None else round(b['brierSkill'], 3)} → {b['grade']}")
        else:
            log(f"  · 전망 {label}({h}): 검증할 기간이 부족")
    log(f"  전망(비슷한 과거 자리) {time.time() - t0:.0f}초")
    return out, bt
