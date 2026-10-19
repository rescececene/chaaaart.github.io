"""예측력 개선 연구 — 누수 없는 워크포워드로 아이디어를 하나씩 시험하고, 사전 등록한 규칙으로만 채택한다.

    python collector/model/research.py --market upbit --out RESULT.json [--threads 3]

━━ 사전 등록 (결과를 보기 전에 고정, 2026-10-20) ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
검증 틀: engine.walk_forward 그대로(날짜 순, 학습 끝과 검증 시작 사이 H+5일 퍼지·엠바고, 접힘마다 새로 학습).
  검증 구간(OOS) 날짜를 앞 70% = 개발(dev), 뒤 30% = 보류(holdout)로 나눈다. 개발 끝은 보류 시작보다 H 일 앞에서 자른다
  (개발 라벨이 보류 구간 가격을 보지 않게). 아이디어 고르기는 개발 구간만 보고, 보류 구간은 마지막에 한 번만 본다.
지표: 같은 날 유니버스 중앙값 대비 H 초과수익과 점수의 순위 IC, 상위 10% 로그 초과수익(유니버스 평균 대비).
  겹치지 않는 평가일(H 간격) 격자 H 개의 평균, t 는 격자 하나 기준(정직한 표본 수).
① 목표 기간: 코인 1·7·14·30일, 주식 1·5·20·60거래일. 개발 구간 '연율 IC IR' = IC 평균/표준편차 × √(연간 기간 수)
  가 가장 큰 기간을 고르되, 상위 10% 초과수익(기간당) − 왕복 비용(업비트 0.1%, 바이낸스 0.2%, 국내 0.25%, 미국 0.05%)
  > 0 인 기간만 후보. 지금 기간보다 IR 이 1.2배 이상일 때만 바꾼다.
② 특징 묶음(vam·rev·liq·hi·btc·kp·frgn)과 모형 변형(회귀 목표 reg, 앙상블 ens3, 단조 제약 mono)은 ①에서 고른 기간에서
  기준 모형과 짝 비교: 개발 ΔIC ≥ +0.005, 짝 t(ΔIC) ≥ 2.0, 개발 Δ상위10%(로그) ≥ −0.1%p 이면 채택 후보.
③ 다중 검정: 시장당 시험 수 K 로 본페로니 보정 p 를 함께 적는다. 최종 판정은 보류 구간 한 번:
  채택 후보를 모두 합친 모형이 기준 모형보다 보류 ΔIC > 0 이고 Δ상위10%(로그) ≥ −0.1%p 여야 최종 채택, 아니면 기준 유지.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
"""
import argparse
import json
import math
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))

import lightgbm as lgb  # noqa: E402
import numpy as np  # noqa: E402

import engine  # noqa: E402
import features  # noqa: E402
import history  # noqa: E402
import predict  # noqa: E402

HIST = HERE.parent / ".history"
HORIZONS = {"upbit": (1, 7, 14, 30), "binance": (1, 7, 14, 30), "krx": (1, 5, 20, 60), "us": (1, 5, 20, 60)}
YEAR = {"upbit": 365, "binance": 365, "krx": 250, "us": 250}
COST = {"upbit": 0.001, "binance": 0.002, "krx": 0.0025, "us": 0.0005}
DEV_FRAC = 0.7
MIN_DIC, MIN_T, MIN_DTOP = 0.005, 2.0, -0.001


def load(market, hist=HIST):
    idx = history.load_index(hist / market)
    arrs = history.load_market(market, hist)
    pegged = {c for c, a in arrs.items() if predict.is_pegged(market, c, a)}
    arrs = {c: a for c, a in arrs.items() if c not in pegged}
    P = features.build_panel(arrs, idx.get("listed"), None, market=market)
    return P, idx


def aux_for(market, P, hist=HIST):
    return predict.aux_for(market, P, hist, all_groups=True)


# ── 모형 변형 ─────────────────────────────────────────────
_orig_fit = engine.fit_rank


def make_fit(variant):
    def fit(kind, X, ds, rows, threads):
        if variant == "reg" and kind in ("gbm", "ridge"):
            y0 = ds["ygauss"]
            ds["ygauss"] = ds["yreg"]
            try:
                return _orig_fit(kind, X, ds, rows, threads)
            finally:
                ds["ygauss"] = y0
        if kind == "gbm2":
            p = engine._params(len(rows), threads, seed=23)
            p.update(num_leaves=7, feature_fraction=0.5, learning_rate=0.03)
            d = lgb.Dataset(X[rows], label=ds["ygauss"][rows])
            return engine.GBM(lgb.train(p, d, num_boost_round=400))
        if kind == "gbm" and variant == "mono":
            # 단조 제약: 이 접힘 학습 구간의 릿지 부호가 큰 순위 특징 10개만 그 방향으로 묶는다 (학습 구간만 사용 → 누수 없음)
            rid = _orig_fit("ridge", X, ds, rows, threads)
            cols = rid.cols
            b = rid.beta[:-1]
            top = np.argsort(-np.abs(b))[:10]
            cons = [0] * X.shape[1]
            for i in top:
                cons[int(cols[i])] = int(np.sign(b[i]))
            p = engine._params(len(rows), threads)
            p.update(monotone_constraints=cons, monotone_constraints_method="advanced")
            d = lgb.Dataset(X[rows], label=ds["ygauss"][rows])
            return engine.GBM(lgb.train(p, d, num_boost_round=engine.N_TREES))
        return _orig_fit(kind, X, ds, rows, threads)
    return fit


def dataset(P, F, M, market, H):
    ds = features.build_dataset(P, F, M, market, H=H)
    ds["starts"] = engine.date_starts(ds["ti"], len(P["dates"]))
    # 회귀 목표: 같은 날 초과수익을 그날 사분위 폭으로 나누고 ±3 으로 자른다
    ex = ds["excess"].copy()
    st = ds["starts"]
    y = np.full(len(ex), np.nan)
    for d in range(len(st) - 1):
        e = ex[st[d]:st[d + 1]]
        ok = np.isfinite(e)
        if ok.sum() >= 10:
            q1, q3 = np.quantile(e[ok], [0.25, 0.75])
            s = (q3 - q1) / 1.349 or 1.0
            y[st[d]:st[d + 1]] = np.clip(e / s, -3, 3)
    ds["yreg"] = y
    return ds


def run_variant(ds, market, kinds, variant, threads):
    engine.fit_rank = make_fit(variant)
    try:
        oos, pl, folds = engine.walk_forward(ds, engine.CFG[market], kinds, threads, lambda *_: None)
    finally:
        engine.fit_rank = _orig_fit
    return engine.combine(ds, [oos[k] for k in kinds]), pl


def split(pl, H):
    a, b = pl["first_test"], pl["last_lab"]
    h0 = a + int((b - a) * DEV_FRAC)
    return (a, h0 - H), (h0, b)


def metrics(S, H, year):
    """격자(H 간격) 평균 지표 + 연율 IR"""
    n = len(S["ic"])
    gm = []
    for o in range(H):
        idx = np.arange(o, n, H)
        idx = idx[np.isfinite(S["ic"][idx])]
        if len(idx) >= 4:
            gm.append(engine._grid_metrics(S, idx))
    if not gm:
        return None
    A = engine._avg(gm)
    sd = A["ic"] / A["ir"] if A["ir"] else float("nan")
    A["irAnn"] = A["ir"] * math.sqrt(year / H)
    A["sd"] = sd
    return A


def paired(Sa, Sb, H):
    """일별 ΔIC (a − b) 의 격자 평균 t"""
    d = Sa["ic"] - Sb["ic"]
    dt = Sa["top_log"] - Sb["top_log"]
    ts, ms, mt = [], [], []
    for o in range(H):
        idx = np.arange(o, len(d), H)
        idx = idx[np.isfinite(d[idx])]
        if len(idx) >= 4:
            x = d[idx]
            sd = x.std(ddof=1)
            ts.append(x.mean() / sd * math.sqrt(len(x)) if sd > 0 else 0.0)
            ms.append(x.mean())
            mt.append(np.nanmean(dt[idx]))
    if not ts:
        return None
    t = float(np.mean(ts))
    from math import erf
    p = 0.5 * (1 - erf(t / math.sqrt(2)))  # 한쪽 검정 근사
    return {"dIC": float(np.mean(ms)), "t": t, "p": p, "dTopLog": float(np.mean(mt))}


def evaluate(ds, score, pl, H, year):
    (d0, d1), (h0, h1) = split(pl, H)
    Sd = engine.daily_stats(ds, score, d0, d1)
    Sh = engine.daily_stats(ds, score, h0, h1)
    return Sd, Sh, metrics(Sd, H, year), metrics(Sh, H, year), [str(ds["dates"][x].date()) for x in (d0, d1, h0, h1)]


def short(m):
    if not m:
        return None
    return {k: round(float(m[k]), 5) for k in ("ic", "t", "ir", "irAnn", "top", "top_log", "hit", "n")}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--market", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--threads", type=int, default=3)
    ap.add_argument("--only", default="")
    args = ap.parse_args()
    m = args.market
    year = YEAR[m]
    t0 = time.time()
    log = lambda s: print(f"[{m} {time.time() - t0:5.0f}s] {s}", flush=True)  # noqa: E731
    res = {"market": m, "prereg": __doc__.split("━━")[1] if "━━" in __doc__ else "", "horizon": {}, "ideas": {}}
    P, idx = load(m)
    F, M = features.compute_features(P, m)
    log(f"패널 {P['c'].shape}")
    kinds = list(engine.KINDS)

    # ① 목표 기간
    cur = features.HORIZON[m]
    hz = {}
    for H in HORIZONS[m]:
        ds = dataset(P, F, M, m, H)
        sc, pl = run_variant(ds, m, kinds, "base", args.threads)
        Sd, Sh, md, mh, span = evaluate(ds, sc, pl, H, year)
        hz[H] = {"dev": short(md), "hold": short(mh), "span": span,
                 "devAfterCost": (md["top"] - COST[m]) if md else None, "holdAfterCost": (mh["top"] - COST[m]) if mh else None}
        log(f"H={H}: dev IC {md['ic']:+.4f} t {md['t']:.2f} IRann {md['irAnn']:.2f} top {md['top']*100:+.2f}%p | "
            f"hold IC {mh['ic']:+.4f} t {mh['t']:.2f} top {mh['top']*100:+.2f}%p")
    ok = {H: v for H, v in hz.items() if v["dev"] and v["devAfterCost"] > 0}
    best = max(ok, key=lambda H: ok[H]["dev"]["irAnn"]) if ok else cur
    if best != cur and hz[cur]["dev"] and ok.get(best) and ok[best]["dev"]["irAnn"] < 1.2 * hz[cur]["dev"]["irAnn"]:
        best = cur
    if best != cur and not (hz[best]["hold"] and hz[best]["hold"]["ic"] > 0):
        best = cur
    res["horizon"] = {"tested": hz, "current": cur, "chosen": best}
    log(f"→ 목표 기간 {best} (지금 {cur})")
    H = best

    # ② 아이디어
    ideas = [g for g in features.GROUPS if m in features.GROUP_MARKETS.get(g, (m,))] + ["reg", "ens3", "mono"]
    if args.only:
        ideas = [i for i in ideas if i in args.only.split(",")]
    aux = aux_for(m, P)
    ds0 = dataset(P, F, M, m, H)
    sc0, pl = run_variant(ds0, m, kinds, "base", args.threads)
    Sd0, Sh0, md0, mh0, span = evaluate(ds0, sc0, pl, H, year)
    res["base"] = {"dev": short(md0), "hold": short(mh0), "span": span}
    K = len(ideas)
    adopted_g, adopted_v = [], []
    for idea in ideas:
        ti = time.time()
        if idea in features.GROUPS:
            F2, M2 = dict(F), dict(M)
            added, addm = features.extra_features(P, F2, M2, m, [idea], aux)
            if not added and not addm:
                res["ideas"][idea] = {"skip": "데이터 없음"}
                continue
            ds = dataset(P, F2, M2, m, H)
            sc, _ = run_variant(ds, m, kinds, "base", args.threads)
        else:
            kk = kinds + ["gbm2"] if idea == "ens3" else kinds
            sc, _ = run_variant(ds0, m, kk, idea, args.threads)
            ds = ds0
        Sd, Sh, md, mh, _ = evaluate(ds, sc, pl, H, year)
        pr = paired(Sd, Sd0, H)
        cand = bool(pr and pr["dIC"] >= MIN_DIC and pr["t"] >= MIN_T and pr["dTopLog"] >= MIN_DTOP)
        res["ideas"][idea] = {"dev": short(md), "paired": pr, "pBonf": min(1.0, pr["p"] * K) if pr else None,
                              "candidate": cand}
        log(f"{idea}: dev IC {md['ic']:+.4f} ΔIC {pr['dIC']:+.4f} t {pr['t']:.2f} Δtop {pr['dTopLog']*100:+.2f}%p "
            f"→ {'후보' if cand else '기각'} ({time.time() - ti:.0f}s)")
        if cand:
            (adopted_g if idea in features.GROUPS else adopted_v).append(idea)

    # ③ 보류 구간 최종 확인 (후보 전부 합친 모형 vs 기준, 한 번)
    final = {"groups": adopted_g, "variants": adopted_v, "adopted": False}
    if adopted_g or adopted_v:
        F2, M2 = dict(F), dict(M)
        if adopted_g:
            features.extra_features(P, F2, M2, m, adopted_g, aux)
        ds = dataset(P, F2, M2, m, H)
        kk = kinds + (["gbm2"] if "ens3" in adopted_v else [])
        var = "reg" if "reg" in adopted_v else "mono" if "mono" in adopted_v else "base"
        sc, _ = run_variant(ds, m, kk, var, args.threads)
        Sd, Sh, md, mh, _ = evaluate(ds, sc, pl, H, year)
        ph = paired(Sh, Sh0, H)
        final.update(dev=short(md), hold=short(mh), pairedHold=ph,
                     adopted=bool(ph and ph["dIC"] > 0 and ph["dTopLog"] >= MIN_DTOP))
        log(f"보류 최종: base IC {mh0['ic']:+.4f} → {mh['ic']:+.4f} ΔIC {ph['dIC']:+.4f} t {ph['t']:.2f} "
            f"Δtop {ph['dTopLog']*100:+.2f}%p → {'채택' if final['adopted'] else '기각(기준 유지)'}")
    res["final"] = final
    res["secs"] = round(time.time() - t0)
    Path(args.out).write_text(json.dumps(res, ensure_ascii=False, indent=1, default=float), encoding="utf-8")
    log("끝")


if __name__ == "__main__":
    main()
