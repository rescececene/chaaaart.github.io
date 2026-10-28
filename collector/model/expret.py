"""'H 뒤 예상 %' — 종목마다 다른 절대 수익 예상(가운데 값) + '10번 중 8번' 범위 + 그 방법의 워크포워드 검증

생각의 틀: H 뒤 수익 y = 그날 시장 가운데 수익(med) + 그 종목의 초과수익(ex = y − med)
  예상 % = '시장 몫'(LEVELS) + '종목 몫'(EDGES). 시장 몫은 모든 종목에 같고, 종목 몫이 종목마다 다르다.
  - 시장 몫: zero 0% · long 그때까지 쌓인 '날짜별 시장 가운데 H 수익'의 평균 · half 그 절반
    (연구: 시장 국면 특징으로 시장 몫을 맞히는 방법은 표본 밖에서 0%·장기 평균보다 못했다)
  - 종목 몫(그날 점수 백분위 p·변동성 s·종목 단기 특징만, 날짜 공통 특징은 쓰지 않는다):
    bin   점수 10구간 평균 초과수익 (같은 구간이면 같은 값 — 비교용)
    cell  s × (점수 5구간 × 변동성 3구간) 칸 평균 '초과수익/s'
    ridge 릿지 회귀(초과수익 ~ 특징)
    zridge s × 릿지 회귀(초과수익/s ~ 특징)
    zmed  s × 선형 분위 회귀(중앙값, 초과수익/s ~ 특징)
  - 섞기(BLENDS, 종목 몫끼리): avg 평균 · stack 쌓기(절편 + 음수 아닌 가중치) · recent 최근 90일 성적 가중 ·
    regime 국면(시장 20일 추세 ±, 시장 변동성 높음/낮음)마다 과거 그 국면에서 가장 잘 맞힌 방법
    가중치는 늘 '그 날짜 − H − 5일 전에 결과가 확정된' 표본 밖 예측으로만 정한다.
  방법 이름 = '<시장 몫>+<종목 몫 또는 섞기>' (예: long+cell). 새 방법은 함수 두 개(학습·예측)를 EDGES 에 더하면 된다.
p 는 엔진 워크포워드의 '표본 밖' 점수에서만 쓴다(학습 구간 점수는 모형이 이미 본 값이라 누수). 오늘 행은 오늘 점수.
범위 — 예상 % 둘레 표준화 잔차((y − 예상)/s)의 (점수 5구간 × 변동성 3구간) 칸별 10·90% 분위.
검증 — 블록마다 다시 학습하는 워크포워드(학습 라벨 ≤ 블록 시작 − H − 5일). 예상 구간별 실제 평균·중앙값, 기울기,
  평균 차이, 범위 적중(목표 80%), 방향 적중, 순위 IC, '상위 10% 안에서 예상 높은 5개'의 실제 평균 vs 시장 평균,
  최근 30회(겹치지 않게 H 간격) 목록. 평가 구간 뒤 30%는 따로 적는다.
시장별 방법(CHOICE)은 연구(사전 등록: devB 성적으로 고르고 뒤 30% 는 마지막에 한 번)로 정한 값 — 보고서 참고.
"""
import math

import numpy as np

E = 5                # 엠바고(일) — 학습 라벨 구간 끝과 평가 시작 사이
REL_TAU = 0.005      # recent: 최근 손실이 최솟값보다 0.5% 클 때마다 가중치 e 배씩 줄인다
RECENT_DAYS = 90
MIN_TRAIN_ROWS = 3000
COST = {"upbit": 0.001, "binance": 0.002, "krx": 0.0025, "us": 0.0005}  # 왕복 비용(수수료·세금 어림) — recrule 과 같음
CLIP_Q = (0.005, 0.995)
BLEND_EDGES = ("cell", "ridge", "zridge", "zmed")

# 시장별 방법·다시 학습 간격(일) — 연구 결과로 고정 (2026-10-29, 로컬 이력 ~10-18, 표본 밖 워크포워드)
#  고르는 법: 평가 날짜 앞 70% 중 뒤 40%(devB)의 잘린 제곱 오차. 시장 몫은 cell 로 비교해 0% 보다 0.2% 이상 나을 때만,
#  종목 몫은 단일 방법 중 최소, 섞기는 그 단일 최고보다 나을 때만. 뒤 30%(hold)는 고른 뒤 확인만 했다.
#  (처음엔 'cell 보다 0.2% 이상 나을 때만 바꾼다'는 문턱도 두었지만 ridge·cell 은 크기가 비슷한 단순 모형이라 뺐다 —
#   hold 를 본 뒤 바꾼 것이라, 업비트·미국의 hold 확인은 완전히 깨끗한 시험은 아니다. 그 문턱이면 upbit long+cell ·
#   us zero+cell 이었다. hold 에서 upbit 는 ridge 가 제곱오차·기울기·상위5 모두 나았고, us 는 제곱오차·기울기는 cell 이
#   조금 낫고(−0.08% vs −0.07%, 0.87 vs 0.71) 상위5 초과는 ridge 가 나았다(+0.31%p vs +0.24%p))
#  upbit  long+ridge  hold: 제곱오차 0% 예상보다 −0.36%, 기울기 1.16, 범위 적중 79.6%, 순위 IC 0.144,
#                     상위5 실제 +0.38%/일 vs 시장 +0.03% (이긴 날 59%, 124일)
#  us     zero+ridge  hold: −0.07%, 기울기 0.71, 범위 77.2%, IC 0.014, 상위5 +0.40% vs +0.09% (61%, 180일)
#  binance half+stack hold: −0.37%, 기울기 0.86, 범위 74.3%, IC 0.126, 상위5 +8.9% vs +4.2% (14일, 9회 — 표본 적음)
#  krx    zero+stack  hold: +0.53%(0% 예상보다 나쁨), 기울기 −2.6, 범위 75.5%, IC 0.004 — 20거래일 절대 수익은 못 맞힌다
#  (조사관 제안 시험, 같은 틀: '~k' 과신 보정은 업비트 기울기가 이미 1 근처라 그대로(k≈1), 미국은 devB 가 나빠져 안 씀,
#   바이낸스는 devB 는 나았지만 hold 제곱오차가 +6%p 나빠져 되돌림. 단순 평균(avg)은 업비트·미국 모두 devB 에서 ridge 보다 못했다)
CHOICE = {"upbit": "long+ridge", "binance": "half+stack", "krx": "zero+stack", "us": "zero+ridge"}
BLOCK = {"upbit": 28, "binance": 28, "krx": 42, "us": 42}


# ── 데이터 ─────────────────────────────────────────────────────────────
class Data:
    """행 = 엔진 데이터셋 행(날짜 × 종목, 날짜 순). 날짜 배열은 길이 T."""

    def __init__(self, **kw):
        self.__dict__.update(kw)


def _xs_med_ret(C, elig):
    """날짜별 '그날 1일 수익' 횡단면 중앙값 (그날 종가에 이미 안다)"""
    T = C.shape[0]
    out = np.full(T, np.nan)
    with np.errstate(all="ignore"):
        r = C[1:] / C[:-1] - 1
    for d in range(1, T):
        m = elig[d] & elig[d - 1] & np.isfinite(r[d - 1])
        if m.sum() >= 5:
            out[d] = np.median(r[d - 1][m])
    return out


def prepare(market, H, ti, si, y, ex, pct, C, elig, vol20, vol60, ret1, ret20, mkt20, mktvol, codes,
            first_test, last_lab, excl=None):
    """predict.run_market 이 넘겨준 배열 → Data. pct: 행별 점수 백분위(표본 밖 + 오늘), 나머지는 NaN.
    C·elig·vol20…: (T, N) 배열, mkt20·mktvol: (T,) 배열. excl: 순위 목록에서 빼는 종목 열 번호 집합(금·비트코인 묶음 등)"""
    T = C.shape[0]
    ti, si = np.asarray(ti), np.asarray(si)
    g = lambda A: np.asarray(A, dtype=np.float64)[ti, si]  # noqa: E731
    v20, v60 = g(vol20), g(vol60)
    v = np.where(np.isfinite(v60), 0.5 * (v20 + v60), v20)
    s = np.clip(v, 0.002, None) * math.sqrt(H)  # NaN 은 NaN
    y = np.asarray(y, float)
    # 날짜별 시장 가운데 H 수익(라벨 — d + H 에야 확정)
    med = np.full(T, np.nan)
    ok = np.isfinite(y)
    starts = np.searchsorted(ti, np.arange(T + 1))
    for d in range(T):
        yy = y[starts[d]:starts[d + 1]]
        yy = yy[np.isfinite(yy)]
        if len(yy) >= 5:
            med[d] = np.median(yy)
    # 국면: 시장 20일 추세 부호 × 시장 변동성(그날까지 1년 중앙값보다 높음)
    mktvol = np.asarray(mktvol, float)
    mv_hi = np.zeros(T, bool)
    for d in range(T):
        hist = mktvol[max(0, d - 364):d + 1]
        hist = hist[np.isfinite(hist)]
        mv_hi[d] = bool(len(hist) >= 30 and np.isfinite(mktvol[d]) and mktvol[d] > np.median(hist))
    regime = (np.nan_to_num(np.asarray(mkt20, float)) >= 0).astype(int) * 2 + mv_hi.astype(int)
    # 시장 전체 단기 흔들림 배율: 최근 5일 / 60일 '시장 가운데 1일 수익' 실현 변동성 (그날 종가까지)
    d1 = _xs_med_ret(np.asarray(C, float), np.asarray(elig, bool))
    sq = np.where(np.isfinite(d1), d1 * d1, np.nan)
    mvf = np.ones(T)
    for d in range(T):
        a5, a60 = sq[max(0, d - 4):d + 1], sq[max(0, d - 59):d + 1]
        a5, a60 = a5[np.isfinite(a5)], a60[np.isfinite(a60)]
        if len(a5) >= 3 and len(a60) >= 30 and a60.mean() > 0:
            mvf[d] = float(np.clip(math.sqrt(a5.mean() / a60.mean()), 0.5, 3.0))
    excl_row = np.isin(si, sorted(excl)) if excl else np.zeros(len(ti), bool)
    D = Data(market=market, H=H, T=T, ti=ti, si=si, y=y, ex=np.asarray(ex, float), pct=np.asarray(pct, float), s=s,
             med=med, regime=regime, starts=starts, ret1z=g(ret1) / np.maximum(v20, 1e-4), ret20=g(ret20),
             volratio=v20 / np.maximum(v60, 1e-4), first_test=int(first_test), last_lab=int(last_lab), excl_row=excl_row,
             mvf=mvf)
    D.pred_ok = np.isfinite(D.pct) & np.isfinite(D.s)
    D.train_ok = D.pred_ok & np.isfinite(D.y) & np.isfinite(D.ex) & (D.ti >= D.first_test) & (D.ti <= D.last_lab)
    D.clip = tuple(np.quantile(D.y[D.train_ok], CLIP_Q)) if D.train_ok.any() else (-1.0, 1.0)
    D.exclip = tuple(np.quantile(D.ex[D.train_ok], CLIP_Q)) if D.train_ok.any() else (-1.0, 1.0)
    return D


def _X(D, rows):
    """종목 몫 특징 — 같은 날 종목끼리 다른 값만 (날짜 공통 특징 없음)"""
    p = D.pct[rows] - 0.5
    ls = np.log(D.s[rows])
    cols = [p, p * p, p * p * p, ls, p * ls, D.ret1z[rows], D.ret20[rows], D.volratio[rows]]
    return np.nan_to_num(np.column_stack(cols).astype(np.float64), nan=0.0, posinf=0.0, neginf=0.0)


def _ridge(X, y, lam=1e-3):
    Xc = np.column_stack([X, np.ones(len(X))])
    return np.linalg.solve(Xc.T @ Xc + lam * len(X) * np.eye(Xc.shape[1]), Xc.T @ y)


def _rp(beta, X):
    return np.column_stack([X, np.ones(len(X))]) @ beta


def _qreg(X, y, q=0.5, iters=80, eps=1e-4, lam=1e-4):
    """선형 분위 회귀 — 반복 가중 최소제곱(IRLS). sklearn QuantileRegressor(highs)는 3만 행에 80초라 못 쓴다"""
    Xc = np.column_stack([X, np.ones(len(X))])
    I = np.eye(Xc.shape[1])
    beta = np.linalg.solve(Xc.T @ Xc + lam * len(X) * I, Xc.T @ y)
    for _ in range(iters):
        r = y - Xc @ beta
        w = np.where(r >= 0, q, 1 - q) / np.maximum(np.abs(r), eps)
        Xw = Xc * w[:, None]
        new = np.linalg.solve(Xc.T @ Xw + lam * len(X) * float(w.mean()) * I, Xw.T @ y)
        done = np.max(np.abs(new - beta)) < 1e-6
        beta = new
        if done:
            break
    return beta


def _exw(D, tr):
    """학습 초과수익 — 학습 구간 초과수익 0.5·99.5% 분위로 잘라 펌핑 한두 건에 휘둘리지 않게"""
    lo, hi = np.quantile(D.ex[tr], CLIP_Q)
    return np.clip(D.ex[tr], lo, hi)


def _cells(D, rows, edges):
    b5 = np.clip((D.pct[rows] * 5).astype(int), 0, 4)
    return b5 * 3 + np.digitize(D.s[rows], edges)


# ── 시장 몫 ─────────────────────────────────────────────────────────────
def level_zero(D, cut):
    return 0.0


def level_long(D, cut):
    m = D.med[:max(0, cut) + 1]
    m = m[np.isfinite(m)]
    return float(m.mean()) if len(m) >= 60 else 0.0


def level_half(D, cut):
    return 0.5 * level_long(D, cut)


LEVELS = {"zero": level_zero, "long": level_long, "half": level_half}


# ── 종목 몫 ─────────────────────────────────────────────────────────────
def fit_bin(D, tr):
    e = _exw(D, tr)
    b = np.clip((D.pct[tr] * 10).astype(int), 0, 9)
    return np.array([e[b == i].mean() if (b == i).sum() >= 30 else 0.0 for i in range(10)])


def pred_bin(st, D, rows):
    return st[np.clip((D.pct[rows] * 10).astype(int), 0, 9)]


def fit_cell(D, tr):
    z = _exw(D, tr) / D.s[tr]
    edges = np.quantile(D.s[tr], [1 / 3, 2 / 3])
    k = _cells(D, tr, edges)
    return edges, np.array([z[k == i].mean() if (k == i).sum() >= 30 else 0.0 for i in range(15)])


def pred_cell(st, D, rows):
    edges, tab = st
    return D.s[rows] * tab[_cells(D, rows, edges)]


def fit_ridge(D, tr):
    return _ridge(_X(D, tr), _exw(D, tr))


def pred_ridge(st, D, rows):
    return _rp(st, _X(D, rows))


def fit_zridge(D, tr):
    return _ridge(_X(D, tr), _exw(D, tr) / D.s[tr])


def pred_zridge(st, D, rows):
    return D.s[rows] * _rp(st, _X(D, rows))


def fit_zmed(D, tr):
    rng = np.random.default_rng(0)
    sub = tr if len(tr) <= 60000 else np.sort(rng.choice(tr, 60000, replace=False))
    return _qreg(_X(D, sub), _exw(D, sub) / D.s[sub])


def pred_zmed(st, D, rows):
    return D.s[rows] * _rp(st, _X(D, rows))


EDGES = {"bin": (fit_bin, pred_bin), "cell": (fit_cell, pred_cell), "ridge": (fit_ridge, pred_ridge),
         "zridge": (fit_zridge, pred_zridge), "zmed": (fit_zmed, pred_zmed)}
BLENDS = ("avg", "stack", "recent", "regime")


def split_method(method):
    lv, _, ed = method.partition("+")
    return (lv, ed) if ed else ("zero", lv)


def needs(edge):
    return BLEND_EDGES if edge in BLENDS else (edge,)


# ── 워크포워드 ───────────────────────────────────────────────────────────
def schedule(D, block):
    """다시 학습하는 날짜들 — 첫 학습에 표본 밖 점수 90일 이상. 마지막 블록은 오늘(T-1)부터 (가장 새 학습으로 오늘 예측)"""
    start = D.first_test + D.H + E + 90
    days = list(range(start, D.T - 1, block)) + [D.T - 1]
    return [d for d in days if d >= start]


def _blocks(D, block):
    sch = schedule(D, block)
    for i, b in enumerate(sch):
        yield b, (sch[i + 1] if i + 1 < len(sch) else D.T)


def walk_levels(D, block):
    """{시장 몫 이름: 행별 값} — 블록 시작 − H − E 까지 확정된 값만"""
    N = len(D.ti)
    out = {k: np.full(N, np.nan) for k in LEVELS}
    for b, e in _blocks(D, block):
        te = np.nonzero(D.pred_ok & (D.ti >= b) & (D.ti < e))[0]
        for k, fn in LEVELS.items():
            out[k][te] = fn(D, b - D.H - E)
    return out


def walk_edges(D, names, block, log=None):
    """종목 몫 후보들의 표본 밖 예측 {이름: 행별 배열(NaN = 없음)}"""
    N = len(D.ti)
    out = {n: np.full(N, np.nan) for n in names}
    for b, e in _blocks(D, block):
        tr = np.nonzero(D.train_ok & (D.ti <= b - D.H - E))[0]
        te = np.nonzero(D.pred_ok & (D.ti >= b) & (D.ti < e))[0]
        if len(tr) < MIN_TRAIN_ROWS or not len(te):
            continue
        for n in names:
            fit, pred = EDGES[n]
            try:
                out[n][te] = pred(fit(D, tr), D, te)
            except Exception as ex:  # 후보 하나가 실패해도 나머지는 계속
                if log:
                    log(f"  · 예상 % 종목 몫 {n} 실패: {ex}")
    return out


def blend(D, base, name, block):
    """종목 몫 섞기 — 날짜 d 의 가중치는 d − H − E 까지 확정된 결과(초과수익)로만"""
    N = len(D.ti)
    out = np.full(N, np.nan)
    names = [n for n in BLEND_EDGES if n in base]
    if not names:
        return out
    P = np.column_stack([base[n] for n in names])
    have = np.all(np.isfinite(P), axis=1) & D.pred_ok
    lab = have & D.train_ok
    if name == "avg":
        out[have] = P[have].mean(axis=1)
        return out
    if name == "stack":
        for b, e in _blocks(D, block):
            tr = np.nonzero(lab & (D.ti <= b - D.H - E))[0]
            te = np.nonzero(have & (D.ti >= b) & (D.ti < e))[0]
            if len(np.unique(D.ti[tr])) < 60 or not len(te):
                continue
            w, icpt = _nnls_icpt(P[tr], _exw(D, tr))
            out[te] = P[te] @ w + icpt
        return out
    # recent · regime: 날짜별 (초과수익 제곱 오차 합, 행 수)
    T = D.T
    K = len(names)
    se = np.zeros((T, K))
    cnt = np.zeros(T)
    r = np.nonzero(lab)[0]
    exw = np.clip(D.ex[r], D.exclip[0], D.exclip[1])
    for k in range(K):
        np.add.at(se[:, k], D.ti[r], (exw - P[r, k]) ** 2)
    np.add.at(cnt, D.ti[r], 1)
    for d in np.unique(D.ti[have]):
        cut = d - D.H - E
        if cut < 0:
            continue
        if name == "recent":
            lo_d = max(0, cut - RECENT_DAYS + 1)
            n_ = cnt[lo_d:cut + 1].sum()
            if n_ < 1000:
                continue
            L = se[lo_d:cut + 1].sum(axis=0) / n_
            w = np.exp(-(L - L.min()) / (REL_TAU * L.min()))
            w /= w.sum()
        else:
            past = np.arange(0, cut + 1)
            same = past[D.regime[past] == D.regime[d]]
            use = same if cnt[same].sum() >= 3000 and len(same) >= 30 else past
            if cnt[use].sum() < 1000:
                continue
            L = se[use].sum(axis=0) / cnt[use].sum()
            w = np.zeros(K)
            w[int(np.argmin(L))] = 1.0
        sel = have & (D.ti == d)
        out[sel] = P[sel] @ w
    return out


def _nnls_icpt(P, y):
    """y ≈ 절편 + P·w (w ≥ 0) — 평균을 뺀 뒤 NNLS"""
    from scipy.optimize import nnls
    pm, ym = P.mean(axis=0), y.mean()
    w, _ = nnls(P - pm, y - ym)
    return w, float(ym - pm @ w)


def shrink(D, level, edge, block):
    """종목 몫 보정 — 블록마다 지난 표본 밖 결과로 '실제(시장 몫을 뺀 수익) ~ 종목 몫' 기울기 k 를 구해(0~1로 자름)
    종목 몫에 곱한다. 과신(기울기 < 1)이면 줄이고, 근거가 없으면(k≈0) 시장 몫만 남는다."""
    out = np.full(len(edge), np.nan)
    ok = np.isfinite(edge) & np.isfinite(level) & D.pred_ok
    lab = ok & D.train_ok
    for b, e in _blocks(D, block):
        tr = np.nonzero(lab & (D.ti <= b - D.H - E))[0]
        te = np.nonzero(ok & (D.ti >= b) & (D.ti < e))[0]
        if len(np.unique(D.ti[tr])) < 60 or not len(te):
            continue
        x = edge[tr] - edge[tr].mean()
        yy = np.clip(D.y[tr], *D.clip) - level[tr]
        yy = yy - yy.mean()
        den = float(x @ x)
        k = min(1.0, max(0.0, float(x @ yy) / den)) if den > 0 else 0.0
        out[te] = k * edge[te]
    return out


def centers_for(D, method, block, log=None):
    """방법 이름('<시장 몫>+<종목 몫>[~k]') → (행별 예상 %, 행별 시장 몫, 행별 종목 몫) — 모두 표본 밖.
    '~k' 를 붙이면 종목 몫을 지난 결과의 기울기로 줄인다(shrink)"""
    calib = method.endswith("~k")
    lv, ed = split_method(method[:-2] if calib else method)
    level = walk_levels(D, block)[lv]
    base = walk_edges(D, [n for n in needs(ed) if n in EDGES], block, log)
    edge = base[ed] if ed in EDGES else blend(D, base, ed, block)
    if calib:
        edge = shrink(D, level, edge, block)
    return level + edge, level, edge


# ── 범위 ────────────────────────────────────────────────────────────────
# 시장별 범위 설정 — 연구(2026-10-29, devB 윙클러 점수가 1% 이상 낫고 월별 적중 흔들림이 커지지 않을 때만 채택,
# hold 에서 기본보다 1% 넘게 나빠지면 되돌림):
#  upbit  시장 흔들림 ^0.5 — 월별 적중 표준편차 devB 0.073→0.039, hold 0.035→0.028 (적중 0.786→0.795)
#  binance ACI γ0.03       — hold 적중 0.722→0.767, 윙클러 −9.5%
#  krx    기본 (ACI 는 devB 에선 나았지만 hold 윙클러 +13.8% 라 되돌림) · us 기본 (나아진 게 없음)
RANGE = {"upbit": {"mvk": 0.5}, "binance": {"aci": 0.03}, "krx": {}, "us": {}}


def _vcell_day(D, rows):
    """그날 횡단면 안 변동성 3구간 (0 낮음 · 1 중간 · 2 높음)"""
    out = np.zeros(len(rows), int)
    t = D.ti[rows]
    for d in np.unique(t):
        m = t == d
        sv = D.s[rows][m]
        r = np.empty(m.sum())
        r[np.argsort(sv, kind="stable")] = np.arange(m.sum())
        out[m] = np.minimum(2, (3 * (r + 0.5) / m.sum()).astype(int))
    return out


def walk_ranges(D, c, block, window=None, aci=None, mvk=0.0):
    """예상 c 둘레 표준화 잔차((y − c)/s')의 칸별 10·90% 분위 → (lo, hi) 행별 배열. 학습은 그 블록 시작 − H − E 이전만.
    s' = s × (시장 단기 흔들림 배율)^mvk · window: 최근 며칠 잔차만(None = 쌓인 전부) ·
    aci: 적응형 컨포멀 갱신 폭 γ — 변동성 3구간마다 아래·위 이탈률이 10% 가 되게 날마다 배율 조정(결과가 확정된 날만)"""
    N = len(D.ti)
    lo, hi = np.full(N, np.nan), np.full(N, np.nan)
    ok_c = np.isfinite(c) & D.pred_ok
    lab = ok_c & D.train_ok
    se = D.s * (D.mvf[D.ti] ** mvk if mvk else 1.0)
    for b, e in _blocks(D, block):
        m = lab & (D.ti <= b - D.H - E)
        if window:
            m &= D.ti > b - D.H - E - window
        tr = np.nonzero(m)[0]
        te = np.nonzero(ok_c & (D.ti >= b) & (D.ti < e))[0]
        if len(tr) < 1000 or not len(te):
            continue
        r = (D.y[tr] - c[tr]) / se[tr]
        edges = np.quantile(D.s[tr], [1 / 3, 2 / 3])
        k = _cells(D, tr, edges)
        g = np.quantile(r, [0.1, 0.9])
        tab = np.array([np.quantile(r[k == j], [0.1, 0.9]) if (k == j).sum() >= 30 else g for j in range(15)])
        kt = _cells(D, te, edges)
        lo[te] = c[te] + se[te] * tab[kt, 0]
        hi[te] = c[te] + se[te] * tab[kt, 1]
    if aci:
        lo, hi = _aci(D, c, lo, hi, aci)
    return lo, hi


def _aci(D, c, lo, hi, gamma):
    """적응형 컨포멀(Gibbs & Candès 2021) — 변동성 3구간마다 아래·위 배율 a 를 날마다 a += γ(이탈률 − 10%)로.
    d 날 예측은 d − H 날 예측의 결과(그날 확정)까지만 반영한다."""
    rows = np.nonzero(np.isfinite(lo))[0]
    if not len(rows):
        return lo, hi
    vc = np.zeros(len(D.ti), int)
    vc[rows] = _vcell_day(D, rows)
    a_lo, a_hi = np.zeros(3), np.zeros(3)
    lo2, hi2 = lo.copy(), hi.copy()
    by_day = {}
    for i in rows:
        by_day.setdefault(int(D.ti[i]), []).append(i)
    for d in sorted(by_day):
        p = by_day.get(d - D.H)
        if p:
            p = np.array(p)
            p = p[np.isfinite(D.y[p]) & (D.ti[p] <= D.last_lab)]
            for k in range(3):
                q = p[vc[p] == k]
                if len(q):
                    a_lo[k] += gamma * (float(np.mean(D.y[q] < lo2[q])) - 0.1)
                    a_hi[k] += gamma * (float(np.mean(D.y[q] > hi2[q])) - 0.1)
        r = np.array(by_day[d])
        k = vc[r]
        lo2[r] = c[r] + (lo[r] - c[r]) * np.exp(a_lo[k])
        hi2[r] = c[r] + (hi[r] - c[r]) * np.exp(a_hi[k])
    return lo2, hi2


# ── 검증 ────────────────────────────────────────────────────────────────
def _spear(a, b):
    ra = np.argsort(np.argsort(a, kind="stable"), kind="stable").astype(float)
    rb = np.argsort(np.argsort(b, kind="stable"), kind="stable").astype(float)
    ra -= ra.mean()
    rb -= rb.mean()
    den = math.sqrt((ra * ra).sum() * (rb * rb).sum())
    return float((ra * rb).sum() / den) if den > 0 else float("nan")


def _eval_days(D, ok):
    days = np.unique(D.ti[ok])
    if D.H > 1 and len(days):  # 겹치지 않게: 마지막 날에서 H 간격으로 거슬러
        days = days[(days[-1] - days) % D.H == 0]
    return days


def picks_by_day(D, c, lo, hi, rows_mask, n_pick=5, top=0.9):
    """평가일마다 '점수 상위 10% 안(묶인 토큰 제외)에서 예상 높은 5개'
    → [(d, 예상 평균, 실제 평균, 시장 평균, 시장 중앙값, 범위 안 비율, 방향 맞힘 비율)]"""
    out = []
    ok = rows_mask & np.isfinite(c) & np.isfinite(D.y)
    for d in _eval_days(D, ok):
        sel = np.nonzero(ok & (D.ti == d))[0]
        if len(sel) < 10:
            continue
        cand = sel[(D.pct[sel] >= top) & ~D.excl_row[sel]]
        if not len(cand):
            continue
        pk = cand[np.argsort(-c[cand], kind="stable")][:n_pick]
        yy = D.y[pk]
        inr = float(np.mean((yy >= lo[pk]) & (yy <= hi[pk]))) if np.all(np.isfinite(lo[pk])) else None
        nz = (c[pk] != 0) & (yy != 0)
        dh = float(np.mean((c[pk][nz] > 0) == (yy[nz] > 0))) if nz.any() else None
        out.append((int(d), float(c[pk].mean()), float(yy.mean()), float(D.y[sel].mean()), float(np.median(D.y[sel])), inr, dh))
    return out


def evaluate(D, c, lo, hi, rows_mask):
    """예상 c(·범위 lo~hi)의 표본 밖 성적 — rows_mask 안에서"""
    ok = rows_mask & np.isfinite(c) & np.isfinite(D.y)
    if ok.sum() < 200:
        return None
    y, cc = D.y[ok], c[ok]
    yc = np.clip(y, *D.clip)
    X = np.column_stack([cc, np.ones(len(cc))])
    res = {"n": int(ok.sum()), "days": int(len(np.unique(D.ti[ok]))),
           "mse": float(np.mean((yc - cc) ** 2)), "mseZero": float(np.mean(yc ** 2)), "mae": float(np.mean(np.abs(y - cc))),
           "bias": float(np.mean(y - cc)), "biasMed": float(np.median(y - cc)),
           "slope": float(np.linalg.lstsq(X, y, rcond=None)[0][0]), "slopeClip": float(np.linalg.lstsq(X, yc, rcond=None)[0][0])}
    nz = (cc != 0) & (y != 0)
    res["dirHit"] = float(np.mean((cc[nz] > 0) == (y[nz] > 0))) if nz.any() else None
    res["upShare"] = float(np.mean(y[y != 0] > 0)) if (y != 0).any() else None  # 기준: 실제로 오른 비율
    o = np.argsort(cc, kind="stable")
    res["bins"] = [{"pred": float(cc[p].mean()), "mean": float(y[p].mean()), "median": float(np.median(y[p])), "n": int(len(p))}
                   for p in np.array_split(o, 10)]
    res["binErr"] = float(np.mean([abs(b["mean"] - b["pred"]) for b in res["bins"]]))
    if lo is not None:
        okr = ok & np.isfinite(lo) & np.isfinite(hi)
        if okr.any():
            yr = D.y[okr]
            inr = (yr >= lo[okr]) & (yr <= hi[okr])
            res["coverage"] = float(inr.mean())
            s = D.s[okr]
            if okr.sum() >= 300:
                e1, e2 = np.quantile(s, [1 / 3, 2 / 3])
                vb = np.digitize(s, [e1, e2])
                res["coverageByVol"] = [float(inr[vb == i].mean()) for i in range(3)]
            res["pinLo"] = float(np.mean(np.maximum(0.1 * (yr - lo[okr]), -0.9 * (yr - lo[okr]))))
            res["pinHi"] = float(np.mean(np.maximum(0.9 * (yr - hi[okr]), -0.1 * (yr - hi[okr]))))
    ics = []
    for d in _eval_days(D, ok):
        sel = ok & (D.ti == d)
        if sel.sum() >= 10 and np.ptp(c[sel]) > 0:
            ics.append(_spear(c[sel], D.y[sel]))
    ics = np.array([x for x in ics if np.isfinite(x)])
    res["ic"] = float(ics.mean()) if len(ics) else None
    res["icT"] = float(ics.mean() / ics.std(ddof=1) * math.sqrt(len(ics))) if len(ics) > 2 and ics.std() > 0 else None
    nan = np.full(len(c), np.nan)
    pk = picks_by_day(D, c, lo if lo is not None else nan, hi if hi is not None else nan, rows_mask)
    if pk:
        a = np.array([[p[1], p[2], p[3]] for p in pk])
        cost = COST.get(D.market, 0.0)
        g5, gm = np.cumprod(1 + a[:, 1]), np.cumprod(1 + a[:, 2])
        dd = lambda g: float((g / np.maximum.accumulate(np.concatenate([[1.0], g]))[1:] - 1).min())  # noqa: E731
        res["top5"] = {"n": len(pk), "pred": float(a[:, 0].mean()), "act": float(a[:, 1].mean()), "mkt": float(a[:, 2].mean()),
                       "ex": float((a[:, 1] - a[:, 2]).mean()), "exMed": float(np.median(a[:, 1] - a[:, 2])),
                       "exAfterCost": float((a[:, 1] - a[:, 2] - cost).mean()), "beat": float(np.mean(a[:, 1] > a[:, 2])),
                       "mae": float(np.mean(np.abs(a[:, 1] - a[:, 0]))), "bias": float(np.mean(a[:, 1] - a[:, 0])),
                       "inRange": _mean([p[5] for p in pk]), "dirHit": _mean([p[6] for p in pk]),
                       "growth": float(g5[-1]), "uniGrowth": float(gm[-1]), "mdd": dd(g5), "uniMdd": dd(gm)}
    return res


def _mean(xs):
    xs = [x for x in xs if x is not None]
    return float(np.mean(xs)) if xs else None


# ── 시장 하나 전체 ───────────────────────────────────────────────────────
def run(D, dates, today_rows, method=None, block=None, log=print, hold_frac=0.3):
    """반환 (오늘 행별 예상 %, 10%, 90%, 시장 몫, 검증 dict). method 기본 = CHOICE[시장]"""
    method = method or CHOICE.get(D.market, "long+cell")
    block = block or BLOCK.get(D.market, 28)
    c, level, edge = centers_for(D, method, block, log)
    if np.isfinite(c[today_rows]).mean() < 0.5 and method != "long+cell":  # 섞기가 준비 안 됐으면(이력 부족) 단순 표로
        if log:
            log(f"  · 예상 %: {method} 를 오늘 쓸 수 없어 long+cell 로")
        method = "long+cell"
        c, level, edge = centers_for(D, method, block, log)
    lo, hi = walk_ranges(D, c, block, **RANGE.get(D.market, {}))
    ev = D.train_ok & np.isfinite(c) & np.isfinite(lo)
    chk = None
    if ev.sum() >= 200:
        dd = np.unique(D.ti[ev])
        h0 = int(dd[int(len(dd) * (1 - hold_frac))])
        allr = evaluate(D, c, lo, hi, ev)
        hold = evaluate(D, c, lo, hi, ev & (D.ti >= h0))
        pk = picks_by_day(D, c, lo, hi, ev)
        recent = [{"d": str(dates[d].date()), "end": str(dates[min(d + D.H, len(dates) - 1)].date()), "pred": p, "act": a,
                   "mkt": m, "mktMed": mm, "inRange": inr} for d, p, a, m, mm, inr, _ in pk[-30:]]
        chk = {"method": method, "block": block, "h": D.H, "from": str(dates[int(dd[0])].date()),
               "to": str(dates[int(dd[-1])].date()), "holdFrom": str(dates[h0].date()), "all": allr, "hold": hold,
               "recent": recent, "range": RANGE.get(D.market, {}), "grade": grade_of(allr, hold)}
        if log and allr:
            t5 = allr.get("top5") or {}
            log(f"  · 예상 % ({method}): 검증 {chk['from']}~{chk['to']} 범위 적중 {_f(allr.get('coverage'))} "
                f"기울기 {allr['slope']:+.2f} 평균 차이 {allr['bias'] * 100:+.2f}%p 순위 IC {_f(allr.get('ic'), '+.3f')} "
                f"상위5 예상 {_f(t5.get('pred'), '+.4f')} → 실제 {_f(t5.get('act'), '+.4f')} (시장 {_f(t5.get('mkt'), '+.4f')}, "
                f"이긴 비율 {_f(t5.get('beat'))}) 제곱오차 {allr['mse'] / allr['mseZero'] - 1:+.2%} (0% 예상 대비)")
    return c[today_rows], lo[today_rows], hi[today_rows], level[today_rows], chk


def grade_of(allr, hold):
    """예상 % 의 검증 등급 — good: 전체·뒤 30% 모두 0% 예상보다 제곱오차가 작고, 기울기 0.5~1.5, 범위 적중 80±5%p,
    순위 IC ≥ 0.03 / weak: 둘 다 0% 예상보다 낫고 기울기 > 0 / poor: 그 밖 (0% 라고 하는 것보다 못했다)"""
    parts = [r for r in (allr, hold) if r]
    if len(parts) < 2:
        return "poor"
    beat = all(r["mse"] < r["mseZero"] for r in parts)
    if beat and all(0.5 <= r["slope"] <= 1.5 and abs((r.get("coverage") or 0) - 0.8) <= 0.05 and (r.get("ic") or 0) >= 0.03
                    for r in parts):
        return "good"
    if beat and all(r["slope"] > 0 for r in parts):
        return "weak"
    return "poor"


def _f(x, fmt=".3f"):
    return "n/a" if x is None or not np.isfinite(x) else format(float(x), fmt)
