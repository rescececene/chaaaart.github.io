"""모형: 순위 점수(LightGBM + 릿지 앙상블) + 분위 회귀(10/50/90%, LightGBM) + 워크포워드 검증

누설 방지
- 워크포워드: 날짜 순으로만 학습 → 그 뒤 구간 예측. 검증 구간이 b 일에 시작하면
  학습 행은 날짜 ≤ b - H - E 만 쓴다(퍼지 H + 엠바고 E). 학습 라벨 구간 (t, t+H] 이 검증 시작보다
  E 일 이상 앞에서 끝나므로 '미래 가격이 들어간 라벨'이 검증 구간과 겹치지 않는다.
- 학습 데이터셋(LightGBM 구간 나누기 포함)은 접힘마다 그 접힘의 학습 행만으로 새로 만든다
  (전체 데이터로 bin 경계를 정하면 미래 특징 분포가 새어 들어간다).
- 성과 지표는 겹치지 않는 평가일(H 간격)만 쓴다. 시작 위치(오프셋) H 가지를 모두 평균해 잡음을 줄인다.
- 확률 보정·수익 환산·분위 보정은 전부 '검증 구간 예측(학습에 안 쓴 날짜)'으로만 맞춘다.
"""
import math
import time

import lightgbm as lgb
import numpy as np
from sklearn.linear_model import LogisticRegression

# block: 재학습 주기(검증 구간 길이), min_train: 첫 학습에 필요한 날짜 수, step: 학습 날짜 솎기(라벨이 H 일씩
# 겹쳐 하루 건너 써도 정보 손실이 작다), embargo: 퍼지 H 에 더하는 여유
CFG = {
    "upbit": dict(block=56, min_train=300, step=1, qstep=2, embargo=5),
    "binance": dict(block=56, min_train=300, step=1, qstep=2, embargo=5),
    "krx": dict(block=84, min_train=375, step=2, qstep=3, embargo=5),
    "us": dict(block=84, min_train=375, step=2, qstep=3, embargo=5),
}
TOP_FRAC = 0.10
N_TREES = 500
Q_TREES = 200
QUANTS = (0.1, 0.5, 0.9)
# 순위 점수 = ① LightGBM(순위→정규점수 회귀, 얕은 나무·큰 잎·특징 30% 표본) ② 릿지(시장 내 백분위 특징의 선형 결합)
# 두 점수의 같은 날 백분위 평균. 설계 비교(검증 앞쪽 절반 기준)에서 단일 GBDT·랭커(xendcg)·앙상블보다 나았고
# 비교에 안 쓴 뒤쪽 절반에서도 가장 좋았다 — 잡음이 큰 금융 데이터에서 선형 모형이 과적합을 눌러 준다.
KINDS = ("gbm", "ridge")
KIND_NAME = "lightgbm+ridge-rank-ensemble"
RIDGE_LAMBDA = 10.0


def _params(n_rows, threads, seed=7):
    return dict(objective="regression", learning_rate=0.02, num_leaves=15, min_data_in_leaf=max(500, n_rows // 200),
                feature_fraction=0.3, bagging_fraction=0.7, bagging_freq=1, lambda_l2=10.0, max_bin=63,
                num_threads=threads, seed=seed, deterministic=True, force_col_wise=True, verbose=-1)


class GBM:
    def __init__(self, booster):
        self.b = booster

    def predict(self, X, threads=None):
        return self.b.predict(X, num_threads=threads or 0)

    def contrib(self, X):
        """TreeSHAP (마지막 열 = 기준값은 뺀다)"""
        return self.b.predict(X, pred_contrib=True)[:, :-1]


class Ridge:
    """시장 내 백분위 특징(r:*)만 쓰는 선형 모형. 결측 = 0.5(가운데)"""

    def __init__(self, beta, cols, n_feat):
        self.beta, self.cols, self.n_feat = beta, np.asarray(cols), n_feat

    def _x(self, X):
        return np.nan_to_num(X[:, self.cols].astype(np.float64), nan=0.5)

    def predict(self, X, threads=None):
        return self._x(X) @ self.beta[:-1] + self.beta[-1]

    def contrib(self, X):
        """선형 모형의 정확한 기여: β·(x − 0.5)  (백분위 특징의 횡단면 평균이 0.5)"""
        out = np.zeros((len(X), self.n_feat))
        out[:, self.cols] = (self._x(X) - 0.5) * self.beta[:-1]
        return out


def rank_cols(ds):
    return [i for i, n in enumerate(ds["Xr_names"]) if n.startswith("r:")]


def _q_params(alpha, n_rows, threads, seed=11):
    return dict(objective="quantile", alpha=alpha, learning_rate=0.05, num_leaves=15,
                min_data_in_leaf=max(200, n_rows // 500), feature_fraction=0.8, bagging_fraction=0.7,
                bagging_freq=1, lambda_l2=10.0, max_bin=63, num_threads=threads, seed=seed,
                deterministic=True, force_col_wise=True, verbose=-1)


def fit_rank(kind, X, ds, rows, threads):
    """rows: 학습에 쓸 행 번호. 라벨 = 같은 날 수익률 순위를 정규점수로 바꾼 값(ygauss)"""
    y = ds["ygauss"][rows]
    if kind == "gbm":
        d = lgb.Dataset(X[rows], label=y, free_raw_data=True)  # 접힘마다 새로 만든다(bin 경계도 학습 구간만으로)
        return GBM(lgb.train(_params(len(rows), threads), d, num_boost_round=N_TREES))
    if kind == "ridge":
        cols = rank_cols(ds)
        Xf = np.nan_to_num(X[rows][:, cols].astype(np.float64), nan=0.5)
        Xf = np.column_stack([Xf, np.ones(len(Xf))])
        A = Xf.T @ Xf + RIDGE_LAMBDA * len(Xf) / 1000 * np.eye(Xf.shape[1])
        return Ridge(np.linalg.solve(A, Xf.T @ y), cols, X.shape[1])
    raise ValueError(kind)


def xs_pct(ds, score):
    """같은 날 안에서의 백분위(0~1). NaN 은 NaN"""
    out = np.full(len(score), np.nan)
    st = ds["starts"]
    for d in np.unique(ds["ti"][np.isfinite(score)]):
        sl = slice(st[d], st[d + 1])
        s = score[sl]
        ok = np.isfinite(s)
        if ok.sum() == 0:
            continue
        r = np.empty(ok.sum())
        r[np.argsort(s[ok], kind="stable")] = np.arange(ok.sum())
        v = np.full(len(s), np.nan)
        v[ok] = (r + 0.5) / ok.sum()
        out[sl] = v
    return out


def combine(ds, preds):
    """여러 모형 점수 → 같은 날 백분위 평균 (척도가 달라도 섞을 수 있게)"""
    if len(preds) == 1:
        return preds[0]
    with np.errstate(all="ignore"):
        stack = np.vstack([xs_pct(ds, p) for p in preds])
        n = np.isfinite(stack).sum(axis=0)
        return np.where(n > 0, np.nansum(stack, axis=0) / np.maximum(n, 1), np.nan)


def plan(ds, cfg):
    """워크포워드 일정: warm(특징이 채워지는 날), 첫 검증일, 마지막 라벨일"""
    T = len(ds["dates"])
    H = ds["H"]
    counts = np.bincount(ds["ti"], minlength=T)
    need = min(20, max(5, int(counts.max() * 0.2)))
    first_ok = int(np.argmax(counts >= need))
    warm = first_ok + 60
    last_lab = T - 1 - H
    min_train = cfg["min_train"]
    first_test = warm + min_train + H + cfg["embargo"]
    # 이력이 짧으면(--max-days 등) 첫 학습 기간을 줄이되 최소 120일, 검증은 최소 6구간 확보
    if last_lab - first_test < 6 * H:
        first_test = max(warm + 120 + H + cfg["embargo"], last_lab - 6 * H)
    return dict(T=T, warm=warm, first_test=first_test, last_lab=last_lab)


def walk_forward(ds, cfg, kinds, threads, log):
    H, E = ds["H"], cfg["embargo"]
    ti, lab = ds["ti"], ds["has_label"]
    pl = plan(ds, cfg)
    T, warm, b, last_lab = pl["T"], pl["warm"], pl["first_test"], pl["last_lab"]
    oos = {k: np.full(len(ti), np.nan) for k in kinds}
    folds = 0
    t0 = time.time()
    if b > last_lab:
        return oos, pl, folds
    while b <= last_lab:
        e = min(b + cfg["block"], last_lab + 1)
        # ← 퍼지·엠바고: 라벨 구간 (t, t+H] 가 검증 시작 b 보다 E 일 이상 앞에서 끝나는 행만 학습에 쓴다.
        #   (t ≤ b-H-E ⇒ t+H ≤ b-E) — 검증 구간의 가격이 학습 라벨에 섞이지 않는다.
        tr_max = b - H - E
        tr = np.nonzero(lab & (ti >= warm) & (ti <= tr_max) & (ti % cfg["step"] == 0))[0]
        te = np.nonzero(lab & (ti >= b) & (ti < e))[0]
        if len(tr) >= 2000 and len(te):
            for k in kinds:
                m = fit_rank(k, ds["Xr"], ds, tr, threads)
                oos[k][te] = m.predict(ds["Xr"][te], threads)
            folds += 1
        b = e
    log(f"  워크포워드 {folds}회 학습 ({'+'.join(kinds)}) {time.time() - t0:.0f}초")
    return oos, pl, folds


def _spearman(a, b):
    ra = np.argsort(np.argsort(a, kind="stable"), kind="stable").astype(float)
    rb = np.argsort(np.argsort(b, kind="stable"), kind="stable").astype(float)
    ra -= ra.mean()
    rb -= rb.mean()
    den = math.sqrt((ra * ra).sum() * (rb * rb).sum())
    return float((ra * rb).sum() / den) if den > 0 else float("nan")


def daily_stats(ds, score, d_from, d_to):
    """평가일별 IC·상위/하위 10% 성과 (모든 날짜 계산 후 격자에서 고른다)
    상위·하위 성과는 '유니버스 평균 대비'로 잰다 → 무작위로 골라도 기대값이 0 이다(중앙값 대비로 재면 수익률 분포가
    치우친 만큼 무작위도 양수가 나온다). 변동성 기울기(고변동 종목은 단순평균을 부풀린다)를 덜 타도록 로그수익 기준도 같이 낸다."""
    st = ds["starts"]
    n = d_to - d_from + 1
    cols = ("ic", "top", "bot", "top_log", "bot_log", "hit", "top_abs", "all_abs", "mkt", "n")
    out = {c: np.full(n, np.nan) for c in cols}
    for i, d in enumerate(range(d_from, d_to + 1)):
        sl = slice(st[d], st[d + 1])
        s, y, f = score[sl], ds["excess"][sl], ds["fwd"][sl]
        ok = np.isfinite(s) & np.isfinite(y) & np.isfinite(f)
        m = int(ok.sum())
        if m < 10:
            continue
        s, y, f = s[ok], y[ok], f[ok]
        lf = np.log1p(np.clip(f, -0.99, None))
        k = max(3, int(round(TOP_FRAC * m)))
        order = np.argsort(-s, kind="stable")
        top, bot = order[:k], order[-k:]
        out["ic"][i] = _spearman(s, y)
        out["top"][i] = f[top].mean() - f.mean()
        out["bot"][i] = f[bot].mean() - f.mean()
        out["top_log"][i] = lf[top].mean() - lf.mean()
        out["bot_log"][i] = lf[bot].mean() - lf.mean()
        out["hit"][i] = (y[top] > 0).mean()  # 상위 10% 중 유니버스 중앙값을 이긴 비율 (무작위 ≈ 0.5)
        out["top_abs"][i] = f[top].mean()
        out["all_abs"][i] = f.mean()
        out["mkt"][i] = np.median(f)  # 시장 방향 (그 기간 유니버스 중앙 수익)
        out["n"][i] = m
    return out


def _grid_metrics(S, idx):
    ic = S["ic"][idx]
    sd = float(ic.std(ddof=1)) if len(ic) > 1 else 0.0
    # 격자 하나는 겹치지 않는 표본이라 t 값이 정직하다 (오프셋 평균은 잡음만 줄인다)
    return dict(ic=float(ic.mean()), ir=float(ic.mean() / sd) if sd > 0 else 0.0, pos=float((ic > 0).mean()),
                top=float(np.nanmean(S["top"][idx])), bot=float(np.nanmean(S["bot"][idx])),
                top_log=float(np.nanmean(S["top_log"][idx])), hit=float(np.nanmean(S["hit"][idx])),
                t=float(ic.mean() / sd * math.sqrt(len(ic))) if sd > 0 else 0.0, n=len(idx))


def _avg(rows):
    rows = [r for r in rows if r]
    return {k: float(np.mean([r[k] for r in rows])) for k in rows[0]} if rows else None


def _random_band(ds, score, d_from, grids, n, draws=200, seed=0):
    """같은 격자에서 상위 10% 대신 무작위 10% 를 샀다면 — 누적(오프셋 평균) 최종값의 5·50·95% (운의 폭)"""
    rng = np.random.default_rng(seed)
    st = ds["starts"]
    finals = np.zeros((draws, len(grids)))
    for gi, g in enumerate(grids):
        acc = np.zeros(draws)
        for i in g[-n:]:
            d = d_from + int(i)
            sl = slice(st[d], st[d + 1])
            s, y, f = score[sl], ds["excess"][sl], ds["fwd"][sl]
            f = f[np.isfinite(s) & np.isfinite(y) & np.isfinite(f)]
            m = len(f)
            k = max(3, int(round(TOP_FRAC * m)))
            pick = np.argpartition(rng.random((draws, m)), k, axis=1)[:, :k]
            acc += np.log1p(f[pick].mean(axis=1))
        finals[:, gi] = np.exp(acc)
    fin = finals.mean(axis=1)
    return {"p05": float(np.quantile(fin, 0.05)), "p50": float(np.quantile(fin, 0.5)), "p95": float(np.quantile(fin, 0.95))}


def verdict_of(A, held, regime):
    """strong: 전체·홀드아웃(설계 선택에 안 쓴 뒤쪽 절반) 모두 t≥2, 상위가 평균보다 나음(로그 기준), 상승장에서도 IC>0
    weak: 전체 t≥1·IC>0.01·상위가 평균보다 나음(로그), 홀드아웃 IC>0 / none: 그 밖"""
    if not A:
        return "none"
    ic_up = (regime or {}).get("icUp")
    if (A["t"] >= 2 and A["ic"] > 0.01 and A["top_log"] > 0 and held and held["t"] >= 2 and held["top_log"] > 0
            and (ic_up is None or ic_up > 0)):
        return "strong"
    if A["t"] >= 1 and A["ic"] > 0.01 and A["top_log"] > 0 and (held is None or held["ic"] > 0):
        return "weak"
    return "none"


def evaluate(ds, score, pl, band=True):
    """겹치지 않는 리밸런싱(H 간격) 기준 지표. 시작 위치(오프셋) H 가지 격자를 모두 평균한다.
    누적 곡선도 격자 하나(운에 좌우된다)가 아니라 H 개 격자의 평균 + 격자별 최소·최대 띠."""
    H = ds["H"]
    d_from, d_to = pl["first_test"], pl["last_lab"]
    if d_to - d_from < 2 * H:
        return None
    S = daily_stats(ds, score, d_from, d_to)
    grids = {}
    for o in range(H):
        idx = np.arange(o, d_to - d_from + 1, H)
        idx = idx[np.isfinite(S["ic"][idx])]
        if len(idx) >= 3:
            grids[o] = idx
    if not grids:
        return None
    A = _avg([_grid_metrics(S, g) for g in grids.values()])
    dev = _avg([_grid_metrics(S, g[:len(g) // 2]) for g in grids.values() if len(g) // 2 >= 3])
    held = _avg([_grid_metrics(S, g[len(g) // 2:]) for g in grids.values() if len(g) - len(g) // 2 >= 3])
    dates = ds["dates"]
    T = len(dates)

    def day(i, plus=0):
        return str(dates[min(d_from + int(i) + plus, T - 1)].date())

    # 누적 곡선: 격자마다 최근 n 회(공통 길이)를 누적 → 회차별 평균. 날짜는 마지막 라벨일에 맞춘 격자 기준
    o_star = (d_to - d_from) % H
    g_star = grids.get(o_star, max(grids.values(), key=lambda g: g[-1]))
    n = min(len(g) for g in grids.values())
    tops = np.array([np.cumprod(1.0 + S["top_abs"][g[-n:]]) for g in grids.values()])
    alls = np.array([np.cumprod(1.0 + S["all_abs"][g[-n:]]) for g in grids.values()])
    gs = g_star[-n:]
    eq = [{"t": day(gs[0]), "top": 1.0, "all": 1.0, "topMin": 1.0, "topMax": 1.0}]
    for j in range(n):
        eq.append({"t": day(gs[j], H), "top": float(tops[:, j].mean()), "all": float(alls[:, j].mean()),
                   "topMin": float(tops[:, j].min()), "topMax": float(tops[:, j].max())})
    ratios = tops[:, -1] / alls[:, -1]
    # 시장 방향별(그 기간 유니버스 중앙 수익 > 0 = 상승) — 모든 검증일(겹침 포함)의 조건부 평균, 설명용
    ok = np.isfinite(S["ic"])
    up = S["mkt"][ok] > 0
    ic_d, top_d, tl_d = S["ic"][ok], S["top"][ok], S["top_log"][ok]
    regime = {"days": int(ok.sum()), "upShare": float(up.mean()) if ok.any() else None,
              "icUp": float(ic_d[up].mean()) if up.sum() >= 5 else None,
              "icDown": float(ic_d[~up].mean()) if (~up).sum() >= 5 else None,
              "topUp": float(top_d[up].mean()) if up.sum() >= 5 else None,
              "topDown": float(top_d[~up].mean()) if (~up).sum() >= 5 else None,
              "topLogUp": float(tl_d[up].mean()) if up.sum() >= 5 else None,
              "upDaysTopBehind": float((top_d[up] < 0).mean()) if up.sum() >= 5 else None}
    verdict = verdict_of(A, held, regime)
    half = len(gs) // 2
    out = {
        "from": day(gs[0]), "to": day(gs[-1], H), "periods": int(n),
        "rankIC": A["ic"], "icIR": A["ir"], "icPositiveRate": A["pos"],
        "topExcess": A["top"], "topHitRate": A["hit"], "equity": eq,
        # ── 계약에 더한 필드 (기존 필드는 그대로) ──
        "basis": "vsUniverseMean",  # topExcess·bottomExcess = 상위/하위 10% 평균 − 유니버스 평균 (무작위 = 0)
        "bottomExcess": A["bot"], "topExcessLog": A["top_log"], "tStat": A["t"], "verdict": verdict,
        "dev": ({"from": day(gs[0]), "to": day(gs[half - 1], H), "rankIC": dev["ic"], "tStat": dev["t"],
                 "topExcess": dev["top"], "topExcessLog": dev["top_log"]} if dev and half >= 1 else None),
        "heldOut": ({"from": day(gs[half]), "to": day(gs[-1], H), "rankIC": held["ic"], "tStat": held["t"],
                     "topExcess": held["top"], "topExcessLog": held["top_log"], "topHitRate": held["hit"]}
                    if held else None),
        "regime": regime,
        "grids": {"n": len(grids), "ratioMin": float(ratios.min()), "ratioMedian": float(np.median(ratios)),
                  "ratioMax": float(ratios.max()), "topBehind": int((ratios < 1).sum())},
        "randomTop": _random_band(ds, score, d_from, list(grids.values()), n) if band else None,
        "_grid": [int(d_from + i) for i in g_star],
    }
    return out


def calibrate(ds, score, pl):
    """검증 구간 예측만으로: ① 백분위 → '중앙값을 이길 확률' 로지스틱 보정
    ② 같은 날 초과수익의 전형적 퍼짐(σ, 사분위 범위/1.349 의 중앙값) — 기여도를 수익률 단위로 바꿀 때 쓴다"""
    ok = np.isfinite(score) & np.isfinite(ds["excess"]) & (ds["ti"] >= pl["first_test"])
    if ok.sum() < 2000:
        return None
    pct = xs_pct(ds, np.where(ok, score, np.nan))
    x = pct[ok] - 0.5
    ex = ds["excess"][ok]
    y = (ex > 0).astype(int)
    lr = LogisticRegression(C=1e4, max_iter=200).fit(x[:, None], y)
    a, b = float(lr.intercept_[0]), float(lr.coef_[0][0])
    st = ds["starts"]
    sig = []
    for d in range(pl["first_test"], pl["last_lab"] + 1):
        e = ds["excess"][st[d]:st[d + 1]]
        e = e[np.isfinite(e)]
        if len(e) >= 10:
            q1, q3 = np.quantile(e, [0.25, 0.75])
            sig.append((q3 - q1) / 1.349)
    # 점수 10분위별 실제 성과(검증) — 평균은 꼬리에 휘둘리므로 중앙값·적중률도 같이 본다
    dec = np.clip((pct[ok] * 10).astype(int), 0, 9)
    by_dec = [dict(mean=float(np.mean(ex[dec == i])), median=float(np.median(ex[dec == i])),
                   hit=float(np.mean(ex[dec == i] > 0))) if np.any(dec == i) else None for i in range(10)]
    return {"a": a, "b": b, "sigma": float(np.median(sig)) if sig else None, "byDecile": by_dec, "n": int(ok.sum())}


def prob_up(cal, pct):
    if cal is None:
        return None
    z = cal["a"] + cal["b"] * (pct - 0.5)
    return 1.0 / (1.0 + math.exp(-z))


def fit_final(ds, cfg, kinds, pl, threads):
    """오늘 예측용: 라벨이 이미 확정된 모든 날짜(≤ T-1-H)로 학습"""
    ti, lab = ds["ti"], ds["has_label"]
    tr = np.nonzero(lab & (ti >= pl["warm"]) & (ti <= pl["last_lab"]) & (ti % cfg["step"] == 0))[0]
    models = {k: fit_rank(k, ds["Xr"], ds, tr, threads) for k in kinds}
    return models, len(tr)


def _zero_drift(p, days):
    """같은 날 횡단면의 q50 중앙값을 세 분위에서 모두 뺀다 → 시장 전체 방향은 '보합(0)'으로 두고 종목의 상대 기울기만 남긴다.
    분위 회귀가 학습 기간의 국면(예: 알트코인 하락장)을 시장 드리프트로 외워 모든 종목 q50 을 한쪽으로 미는 것을 막는다.
    (검증: 보정 구간 뒤 절반에서 '실제 < q50' 비율 upbit 0.32→0.57, binance 0.39→0.49, krx 0.48→0.52, us 0.45→0.47)"""
    p = p.copy()
    for d in np.unique(days):
        sel = days == d
        p[sel] -= np.median(p[sel, 1])
    return p


def fit_quantiles(ds, cfg, pl, threads, log):
    """절대 수익률(log1p) 10/50/90% 분위 회귀 → 시장 드리프트 0 으로 중심 맞춤 → 분할 컨포멀 보정(검증 구간에서 꼬리 폭 조정)"""
    H, E = ds["H"], cfg["embargo"]
    ti, lab, X = ds["ti"], ds["has_label"], ds["Xq"]
    y_all = np.clip(np.log1p(np.clip(ds["fwd"], -0.99, None)), -4, 4)
    warm, last_lab = pl["warm"], pl["last_lab"]
    span = last_lab - warm
    t0 = time.time()

    def fit(rows):
        return [lgb.train(_q_params(a, len(rows), threads), lgb.Dataset(X[rows], label=y_all[rows]),
                          num_boost_round=Q_TREES) for a in QUANTS]

    def pred(models, rows):
        p = np.column_stack([m.predict(X[rows], num_threads=threads) for m in models])
        return np.sort(p, axis=1)  # 분위가 뒤집히지 않게

    sub = (ti % cfg["qstep"] == 0)
    cal = {"lo": 0.0, "hi": 0.0, "center": "zeroDrift", "coverage": None, "n": 0}
    if span > 300:
        cal_start = last_lab - int(span * 0.3)
        tr = np.nonzero(lab & sub & (ti >= warm) & (ti <= cal_start - H - E))[0]  # ← 보정 구간과 퍼지
        cr = np.nonzero(lab & (ti >= cal_start) & (ti <= last_lab) & (ti % 2 == 0))[0]
        if len(tr) > 2000 and len(cr) > 500:
            ms = fit(tr)
            raw = pred(ms, cr)
            p = _zero_drift(raw, ti[cr])
            y = y_all[cr]
            e_lo, e_hi = p[:, 0] - y, y - p[:, 2]
            # 보정 구간 앞 절반으로 폭을 정하고 뒤 절반에서 실제 적중률을 잰다 (정직한 범위 검증)
            half = ti[cr] < cal_start + (last_lab - cal_start) // 2
            if half.sum() > 200 and (~half).sum() > 200:
                h2 = ~half
                lo1, hi1 = np.quantile(e_lo[half], 0.9), np.quantile(e_hi[half], 0.9)
                cal["coverage"] = float(((y[h2] >= p[h2, 0] - lo1) & (y[h2] <= p[h2, 2] + hi1)).mean())
                cal["rawCoverage"] = float(((y[h2] >= raw[h2, 0]) & (y[h2] <= raw[h2, 2])).mean())
                cal["q50BelowRaw"] = float((y[h2] < raw[h2, 1]).mean())  # 이상값 0.5
                cal["q50Below"] = float((y[h2] < p[h2, 1]).mean())
                cal["q50SignHit"] = float((np.sign(y[h2]) == np.sign(p[h2, 1])).mean())
                cal["evalFrom"] = str(ds["dates"][int(ti[cr][h2].min())].date())
            cal["lo"], cal["hi"] = float(np.quantile(e_lo, 0.9)), float(np.quantile(e_hi, 0.9))
            cal["n"] = int(len(cr))
    tr = np.nonzero(lab & sub & (ti >= warm) & (ti <= last_lab))[0]
    models = fit(tr)
    log(f"  분위 회귀 {time.time() - t0:.0f}초 (보정 lo {cal['lo']:+.3f} hi {cal['hi']:+.3f}, "
        f"검증 범위 적중 {_r(cal['coverage'])}, 실제<q50 {_r(cal.get('q50BelowRaw'))}→{_r(cal.get('q50Below'))}, "
        f"q50 부호 적중 {_r(cal.get('q50SignHit'))})")
    return models, cal


def _r(x, nd=3):
    return "n/a" if x is None else round(float(x), nd)


def predict_quantiles(models, cal, X):
    """X = 오늘 횡단면 전체 → 오늘 q50 중앙값을 0 으로 맞춘 뒤 컨포멀 꼬리 보정"""
    p = np.sort(np.column_stack([m.predict(X) for m in models]), axis=1)
    p = _zero_drift(p, np.zeros(len(p)))
    p[:, 0] -= cal["lo"]
    p[:, 2] += cal["hi"]
    p = np.sort(p, axis=1)
    return p  # log1p 수익률 분위


def cone(qlog, H):
    """1~H 일 누적 수익 분위: H 일 분위를 기준으로 중앙값은 시간 비례, 폭은 √시간 비례로 보간"""
    l10, l50, l90 = qlog
    out = []
    for d in range(1, H + 1):
        f = d / H
        m = l50 * f
        out.append({"d": d, "q10": math.expm1(m - (l50 - l10) * math.sqrt(f)), "q50": math.expm1(m),
                    "q90": math.expm1(m + (l90 - l50) * math.sqrt(f))})
    return out


def contributions(models, X, ic, sigma):
    """TreeSHAP 기여도 → 초과수익 단위.
    모형마다 오늘 점수의 표준편차로 나눠 z 단위로 맞춘 뒤 평균(앙상블 점수 ≈ z 평균),
    z 1 단위의 기대 초과수익 = 검증 순위 IC × σ (정규 근사: E[y|z] = ρ·σ_y·z).
    검증 IC 가 0 이하면 기여도는 0 — 근거 없는 수익 숫자를 만들지 않는다. 순서용 z 기여도도 같이 돌려준다."""
    acc = None
    for k, m in models.items():
        c = m.contrib(X)
        sd = float(np.std(c.sum(axis=1))) or 1.0
        acc = c / sd if acc is None else acc + c / sd
    z = acc / len(models)
    scale = max(float(ic or 0.0), 0.0) * float(sigma or 0.0)
    return z * scale, z


def date_starts(ti, T):
    return np.searchsorted(ti, np.arange(T + 1))


# ── 근거 있는 점수: 점수 구간별 '실제 결과' 표 (검증 구간 예측만 사용) ───────────────────────────
N_BINS = 10
GRADE_W = {"strong": 1.0, "weak": 0.5}  # 검증 등급만큼 '시장 이길 확률'·예상 초과수익을 기준(0.5·0)쪽으로 줄인다


def _pav(y, w):
    """가중 단조 증가 회귀 (pool-adjacent-violators)"""
    blocks = [[float(v), float(x), 1] for v, x in zip(y, w)]
    i = 0
    while i < len(blocks) - 1:
        if blocks[i][0] > blocks[i + 1][0]:
            a, b = blocks[i], blocks[i + 1]
            tw = a[1] + b[1]
            blocks[i] = [(a[0] * a[1] + b[0] * b[1]) / tw if tw else 0.0, tw, a[2] + b[2]]
            del blocks[i + 1]
            i = max(0, i - 1)
        else:
            i += 1
    out = []
    for v, _, n in blocks:
        out += [v] * n
    return out


def _bin_table(pct, ex):
    b = np.clip((pct * N_BINS).astype(int), 0, N_BINS - 1)
    rows = []
    for i in range(N_BINS):
        e = ex[b == i]
        if len(e) < 30:
            rows.append(None)
            continue
        q10, q50, q90 = np.quantile(e, [0.1, 0.5, 0.9])
        rows.append({"n": int(len(e)), "hit": float((e > 0).mean()), "q10": float(q10), "q50": float(q50),
                     "q90": float(q90), "mean": float(e.mean())})
    return rows


def _smooth(rows):
    ok = [r for r in rows if r]
    if len(ok) < N_BINS:
        return rows
    for k in ("hit", "q50"):
        sm = _pav([r[k] for r in rows], [r["n"] for r in rows])
        for r, v in zip(rows, sm):
            r[k + "Raw"] = r[k]
            r[k] = v
    return rows


def score_bins(ds, score, pl, dev_frac=0.7):
    """백분위 10구간별 실제 초과수익(같은 날 유니버스 중앙값 대비) 표.
    ① 앞 70% 검증일로 표를 만들고 뒤 30%(보류)에서 신뢰도(예측 확률 vs 실제 적중)를 잰다 — 정직한 확인
    ② 공개용 표는 검증 구간 전체로 다시 만든다(단조 보정). 반환 None = 검증 표본 부족."""
    a, b = pl["first_test"], pl["last_lab"]
    ok = np.isfinite(score) & np.isfinite(ds["excess"]) & (ds["ti"] >= a) & (ds["ti"] <= b)
    if ok.sum() < 3000:
        return None
    pct = xs_pct(ds, np.where(ok, score, np.nan))
    h0 = a + int((b - a) * dev_frac)
    H = ds["H"]
    dev = ok & (ds["ti"] <= h0 - H)
    hold = ok & (ds["ti"] >= h0)
    rel = None
    if dev.sum() >= 2000 and hold.sum() >= 1000:
        tab = _smooth(_bin_table(pct[dev], ds["excess"][dev]))
        if all(tab):
            bh = np.clip((pct[hold] * N_BINS).astype(int), 0, N_BINS - 1)
            eh = ds["excess"][hold]
            rel = []
            err = 0.0
            for i in range(N_BINS):
                sel = bh == i
                act = float((eh[sel] > 0).mean()) if sel.any() else None
                rel.append({"bin": i, "pred": tab[i]["hit"], "actual": act, "n": int(sel.sum()),
                            "predQ50": tab[i]["q50"], "actualQ50": float(np.median(eh[sel])) if sel.any() else None})
                if act is not None:
                    err += abs(act - tab[i]["hit"]) * sel.sum()
            top = bh == N_BINS - 1
            rel = {"from": str(ds["dates"][h0].date()), "to": str(ds["dates"][b].date()), "bins": rel,
                   "calibErr": float(err / max(1, len(bh))),
                   "topHit": float((eh[top] > 0).mean()) if top.any() else None,
                   "topPredHit": tab[-1]["hit"]}
    full = _smooth(_bin_table(pct[ok], ds["excess"][ok]))
    if not all(full):
        return None
    return {"bins": full, "reliability": rel, "n": int(ok.sum()),
            "from": str(ds["dates"][a].date()), "to": str(ds["dates"][b].date())}


def grounded(bins, pct, verdict):
    """오늘 백분위 → {probBeat, expEx{q10,q50,q90}, score, conf}. 등급 none 이면 None (판단 보류)"""
    if not bins or verdict not in GRADE_W:
        return None
    w = GRADE_W[verdict]
    i = int(np.clip(int(pct * N_BINS), 0, N_BINS - 1))
    r = bins["bins"][i]
    p = 0.5 + (r["hit"] - 0.5) * w
    shift = r["q50"] * w - r["q50"]
    return {"probBeat": p, "probRaw": r["hit"], "bin": i, "conf": w,
            "expEx": {"q10": r["q10"] + shift, "q50": r["q50"] * w, "q90": r["q90"] + shift, "n": r["n"]},
            "score": round(100 * p, 1)}
