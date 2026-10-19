"""추천 규칙 백테스트 — 라이브 추천(collector/recommend.py)과 같은 규칙을 과거 각 날짜에 그대로 적용해 본다.

사전 등록 (결과를 보기 전에 고정, 2026-10-20):
  규칙 A: 그날 모형 점수 상위 10% 안에서, 과열 주의·하락 경고 판정이 켜진 종목, 거래대금(20일 평균) 하위 30%,
          상장 30일 미만(엔진은 40일 미만을 이미 뺀다)을 빼고 점수 순 최대 5개를 동일 비중으로 산다. H 기간 보유.
  규칙 B(국면 필터): A 와 같되 시장 20일 수익률(중앙값)이 0 아래인 날에는 60일 변동성이 그날 유니버스 중앙값 이하인
          종목만 ('덜 떨어질 종목'으로 목적 전환).
  채택: 하락 국면 기간의 평균 초과수익이 B > A 이고, 전체 평균 초과수익이 B ≥ A − 0.1%p 이면 B, 아니면 A.
  성적: 검증(워크포워드, 학습에 안 쓴 날짜) 구간에서 겹치지 않게 H 간격으로 리밸런싱, 시작일을 바꾼 H 가지 격자 평균.
        초과수익 = 고른 종목 평균 수익 − 같은 날 유니버스 평균 수익. 승률 = 기간 초과수익 > 0 인 비율.
        최대 낙폭 = 고른 종목 포트폴리오(절대 수익) 누적 곡선의 최대 낙폭. 비용 후 = 기간마다 왕복 비용 전액 차감(보수적).
        뒤쪽 30%(보류 구간)는 따로 보고한다.
"""
import math

import numpy as np

import features

N_PICK = 5
TOP_PCT = 0.9
LIQ_MIN_PCT = 0.3
MIN_AGE = 30
COST = {"upbit": 0.001, "binance": 0.002, "krx": 0.0025, "us": 0.0005}


def flags(P, market, d_from):
    """(T, N) bool: 과열 주의 / 하락 경고 (collector/setups.py 판정 그대로, 그날 종가까지)"""
    import setups
    C = P["c"].values
    T, N = C.shape
    O, Hh, L, V = (P[k].values for k in ("o", "h", "l", "v"))
    heat = np.zeros((T, N), bool)
    down = np.zeros((T, N), bool)
    prm = setups.params(market)
    for j in range(N):
        ok = np.isfinite(C[:, j])
        if ok.sum() < 130:
            continue
        b = T - int(np.argmax(ok[::-1]))          # 마지막 값 다음
        gaps = np.nonzero(~ok[:b])[0]
        a = int(gaps[-1]) + 1 if len(gaps) else 0  # 마지막 공백 뒤 연속 구간
        if b - a < 130:
            continue
        o, h, l, c, v = (np.nan_to_num(x[a:b, j]).tolist() for x in (O, Hh, L, C, V))
        S = setups.Series(o, h, l, c, v)
        for i in range(max(0, d_from - a), b - a):
            try:
                heat[a + i, j] = setups.overheat(S, i, prm, False) is not None
            except (TypeError, ZeroDivisionError, ValueError, IndexError):
                pass
            try:
                down[a + i, j] = setups.downtrend_warn(S, i, prm, False) is not None
            except (TypeError, ZeroDivisionError, ValueError, IndexError):
                pass
    return heat, down


def panels(P, F, M):
    C, V, elig = P["c"], P["v"], P["elig"]
    dv = (C * V).rolling(20, min_periods=10).mean()
    return {"dv_pct": features.xs_rank(dv, elig).values, "vol_pct": features.xs_rank(F["vol_60"], elig).values,
            "atr": F["atr_14"].values, "mkt20": M["mkt_ret_20"].values, "age": P["age"].values,
            "obs": P["obs"].values, "lo20": P["l"].rolling(20, min_periods=10).min().values}


def eligible(pct, j, d, X, heat, down, regime_filter):
    if not np.isfinite(pct) or pct < TOP_PCT:
        return False
    if heat[d, j] or down[d, j]:
        return False
    dvp = X["dv_pct"][d, j]
    if not np.isfinite(dvp) or dvp < LIQ_MIN_PCT:
        return False
    if X["obs"][d, j] < MIN_AGE:
        return False
    if regime_filter and np.isfinite(X["mkt20"][d]) and X["mkt20"][d] < 0:
        vp = X["vol_pct"][d, j]
        if not np.isfinite(vp) or vp > 0.5:
            return False
    return True


def pick_day(ds, score, d, X, heat, down, regime_filter, exclude=()):
    st = ds["starts"]
    sl = slice(st[d], st[d + 1])
    s = score[sl]
    js = ds["si"][sl]
    okm = np.isfinite(s)
    if okm.sum() < 10:
        return None, None
    pct = np.full(len(s), np.nan)
    r = np.empty(okm.sum())
    r[np.argsort(s[okm], kind="stable")] = np.arange(okm.sum())
    pct[okm] = (r + 0.5) / okm.sum()
    order = np.argsort(-np.where(okm, s, -np.inf), kind="stable")
    picks = []
    for i in order:
        if len(picks) >= N_PICK:
            break
        j = int(js[i])
        if j in exclude:
            continue
        if eligible(pct[i], j, d, X, heat, down, regime_filter):
            picks.append(i)
    return sl, picks


def backtest(ds, score, pl, P, F, M, market, log=print, dev_frac=0.7, excl_codes=()):
    H = ds["H"]
    a, b = pl["first_test"], pl["last_lab"]
    if b - a < 4 * H:
        return None
    heat, down = flags(P, market, a)
    X = panels(P, F, M)
    excl = {j for j, c in enumerate(P["codes"]) if str(c).split("#")[0] in set(excl_codes)}
    h0 = a + int((b - a) * dev_frac)
    out = {}
    for rule, rf in (("A", False), ("B", True)):
        per = []  # (d, 초과, 절대, 유니버스, 하락국면, 고른 수)
        for d in range(a, b + 1):
            sl, picks = pick_day(ds, score, d, X, heat, down, rf, excl)
            if sl is None:
                continue
            f = ds["fwd"][sl]
            okf = np.isfinite(f)
            if okf.sum() < 10:
                continue
            uni = float(np.mean(f[okf]))
            pk = [i for i in picks if np.isfinite(f[i])]
            if not pk:
                per.append((d, 0.0, 0.0, uni, X["mkt20"][d] < 0, 0))  # 고를 게 없으면 현금(0)
                continue
            ab = float(np.mean(f[pk]))
            per.append((d, ab - uni, ab, uni, bool(X["mkt20"][d] < 0), len(pk)))
        out[rule] = summarize(per, H, a, h0, b, ds["dates"], COST[market])
    A, B = out["A"], out["B"]
    use = "A"
    if A and B and B["all"]["downEx"] is not None and A["all"]["downEx"] is not None:
        if B["all"]["downEx"] > A["all"]["downEx"] and B["all"]["ex"] >= A["all"]["ex"] - 0.001:
            use = "B"
    res = dict(out[use] or {})
    res.update(rule=use, ruleAlt={"A": _brief(A), "B": _brief(B)}, h=H,
               desc=("점수 상위 10% 중 과열 주의·하락 경고·거래대금 하위 30%·상장 30일 미만을 빼고 점수 순 최대 5개"
                     + (", 시장 하락 국면엔 저변동 절반에서만" if use == "B" else "")))
    if log and A:
        log(f"  · 추천 규칙 백테스트 A: 초과 {A['all']['ex'] * 100:+.2f}%p 승률 {A['all']['win'] * 100:.0f}% "
            f"MDD {A['all']['mdd'] * 100:.1f}% (보류 {A['hold']['ex'] * 100 if A.get('hold') else float('nan'):+.2f}%p) / "
            f"B: 초과 {B['all']['ex'] * 100:+.2f}%p 하락국면 {_f(B['all']['downEx'])} vs A {_f(A['all']['downEx'])} → {use}")
    return res


def _f(x):
    return "n/a" if x is None else f"{x * 100:+.2f}%p"


def _brief(r):
    if not r:
        return None
    return {k: r["all"][k] for k in ("ex", "win", "mdd", "downEx", "periods")}


def summarize(per, H, a, h0, b, dates, cost):
    if not per:
        return None
    d = np.array([p[0] for p in per])
    ex = np.array([p[1] for p in per])
    ab = np.array([p[2] for p in per])
    un = np.array([p[3] for p in per])
    dn = np.array([p[4] for p in per])
    npk = np.array([p[5] for p in per])

    def part(sel):
        res = []
        for o in range(H):
            idx = np.nonzero(sel & ((d - a) % H == o))[0]
            if len(idx) < 3:
                continue
            eq = np.cumprod(1 + ab[idx])
            peak = np.maximum.accumulate(np.concatenate([[1.0], eq]))[1:]
            uq = np.cumprod(1 + un[idx])
            upeak = np.maximum.accumulate(np.concatenate([[1.0], uq]))[1:]
            res.append({"ex": float(ex[idx].mean()), "exMed": float(np.median(ex[idx])), "win": float((ex[idx] > 0).mean()),
                        "abs": float(ab[idx].mean()), "mdd": float((eq / peak - 1).min()), "uniMdd": float((uq / upeak - 1).min()),
                        "growth": float(eq[-1]), "uniGrowth": float(uq[-1]),
                        "exAfterCost": float((ex[idx] - cost * (npk[idx] > 0)).mean()),
                        "downEx": float(ex[idx][dn[idx]].mean()) if dn[idx].sum() >= 3 else None,
                        "upEx": float(ex[idx][~dn[idx]].mean()) if (~dn[idx]).sum() >= 3 else None,
                        "periods": int(len(idx)), "avgPicks": float(npk[idx].mean()), "empty": float((npk[idx] == 0).mean())})
        if not res:
            return None
        avg = {}
        for k in res[0]:
            vals = [r[k] for r in res if r[k] is not None]
            avg[k] = float(np.mean(vals)) if vals else None
        avg["periods"] = int(round(avg["periods"]))
        # 기간당 초과수익의 t (격자 하나 기준, 평균)
        ts = []
        for o in range(H):
            idx = np.nonzero(sel & ((d - a) % H == o))[0]
            if len(idx) >= 3 and ex[idx].std(ddof=1) > 0:
                ts.append(ex[idx].mean() / ex[idx].std(ddof=1) * math.sqrt(len(idx)))
        avg["t"] = float(np.mean(ts)) if ts else None
        return avg

    allp = part(np.ones(len(d), bool))
    hold = part(d >= h0)
    return {"from": str(dates[a].date()), "to": str(dates[min(b + H, len(dates) - 1)].date()),
            "holdFrom": str(dates[h0].date()), "all": allp, "hold": hold}


from recommend import is_stock_token  # noqa: E402,F401  (라이브 규칙과 같은 함수)
