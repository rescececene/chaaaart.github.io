"""패널(날짜×종목) 만들기, 특징 50개, 목표값

누설 방지 원칙
- 특징은 rolling / ewm / shift(k>=0) 만 쓴다 → t 행에는 t 종가까지의 정보만 들어간다.
- 시장 상대값(중앙값·순위)은 같은 날짜 t 의 횡단면에서만 계산한다 (미래 날짜를 섞지 않는다).
- 목표값만 shift(-H) 로 미래를 본다. 학습/검증 분리는 engine.py 에서 날짜 기준 퍼지로 처리.
- 날짜 정리(데이터가 거의 없는 이상한 날 제거)도 '그날까지'의 종목 수만 보고 판단한다.
"""
import math

import numpy as np
import pandas as pd
from numpy.lib.stride_tricks import sliding_window_view
from scipy.special import ndtri

# 코인: 달력일(7일 무휴), 주식: 거래일. research.py 사전 등록 규칙(개발 구간 연율 IC IR 최대 + 비용 후 상위 10% > 0,
# 지금보다 1.2배 이상일 때만 교체, 보류 구간 IC > 0)으로 고른 값 — 2026-10-20: 업비트·미국 1, 바이낸스 14, 국내 20 유지
HORIZON = {"upbit": 1, "binance": 14, "krx": 20, "us": 1}
W52 = {"upbit": 365, "binance": 365, "krx": 250, "us": 250}   # 52주 고점/저점 창 (코인은 있는 만큼)
# 12-1 모멘텀 (최근 1개월을 뺀 1년 수익률): (건너뛰는 최근 봉 수, 1년 봉 수) — 코인은 달력일, 주식은 거래일
MOM_WIN = {"upbit": (30, 365), "binance": (30, 365), "krx": (20, 250), "us": (20, 250)}
MIN_OBS = 40       # 실제 일봉이 이만큼 쌓여야 점수 대상 (신규 상장은 그 전까지 제외)
FFILL_LIMIT = 5    # 거래정지·체결 없는 날은 최대 5일까지 직전 종가로 메운다
AGE_CAP = 365      # '상장 후 일수' 특징 상한

# 키 → (한국어 이름, 종류)  종류: pct=수익률·비율(분수), num=수치, x=배수, days=일수
FEATURES = {
    "ret_1": ("1일 수익률", "pct"), "ret_5": ("5일 수익률", "pct"), "ret_20": ("20일 수익률", "pct"),
    "ret_60": ("60일 수익률", "pct"), "ret_120": ("120일 수익률", "pct"), "ret_250": ("250일 수익률", "pct"),
    "mom_12_1": ("12-1 모멘텀(1년 전~1개월 전 수익률)", "pct"),
    "gap_ma5": ("5일 이동평균 이격도", "pct"), "gap_ma20": ("20일 이동평균 이격도", "pct"),
    "gap_ma60": ("60일 이동평균 이격도", "pct"), "gap_ma120": ("120일 이동평균 이격도", "pct"),
    "slope_ma20": ("20일 이동평균 기울기", "pct"), "slope_ma60": ("60일 이동평균 기울기", "pct"),
    "ma_align": ("이동평균 배열", "num"),
    "rsi_14": ("RSI(14)", "num"), "stoch_14": ("스토캐스틱 %K", "num"),
    "macd": ("MACD(가격 대비)", "pct"), "macd_hist": ("MACD 히스토그램(가격 대비)", "pct"),
    "bb_pctb": ("볼린저 %B", "num"), "bb_width": ("볼린저 밴드폭", "pct"),
    "atr_14": ("ATR(14)/가격", "pct"),
    "vol_20": ("20일 변동성(일)", "pct"), "vol_60": ("60일 변동성(일)", "pct"), "vol_ratio": ("변동성 확대(20/60일)", "x"),
    "volu_1_20": ("마지막 날 거래량/20일 평균", "x"), "volu_5_20": ("5일/20일 거래량", "x"), "volu_20_60": ("20일/60일 거래량", "x"),
    "hi_52w": ("52주 고점 대비", "pct"), "lo_52w": ("52주 저점 대비", "pct"),
    "mdd_60": ("60일 최대 낙폭", "pct"),
    "up_20": ("20일 상승일 비율", "pct"), "up_60": ("60일 상승일 비율", "pct"),
    "max_ret_20": ("20일 최대 일간 상승", "pct"), "min_ret_20": ("20일 최대 일간 하락", "pct"),
    "skew_60": ("60일 수익률 왜도", "num"), "clv_5": ("5일 종가 위치(고저 범위 내)", "num"),
    "gap_20": ("20일 누적 시초 갭", "pct"), "intra_20": ("20일 누적 장중 수익", "pct"),
    "ram_60": ("변동성 대비 60일 수익", "num"),
    "beta_60": ("시장 베타(60일)", "num"), "ivol_60": ("고유 변동성(60일)", "pct"),
    "rs_20": ("20일 상대강도(시장 중앙값 대비)", "pct"), "rs_60": ("60일 상대강도(시장 중앙값 대비)", "pct"),
    "rs_120": ("120일 상대강도(시장 중앙값 대비)", "pct"),
    "age": ("상장 후 일수", "days"),
}
REGIME = {
    "mkt_ret_20": ("시장 전체 20일 수익률(중앙값)", "pct"), "mkt_ret_60": ("시장 전체 60일 수익률(중앙값)", "pct"),
    "mkt_vol_20": ("시장 전체 변동성(중앙값)", "pct"), "mkt_breadth": ("60일선 위 종목 비율", "pct"),
    "mkt_disp_20": ("20일 수익률 종목 간 격차", "pct"),
}
# 순위 모형: 같은 날 시장 안 백분위로 바꾼 특징 (상대강도는 수익률 순위와 같아서 뺀다)
RANK_SKIP = {"rs_20", "rs_60", "rs_120", "age"}
# 백분위만으로는 '얼마나' 크게 움직였는지 사라지므로 몇 개는 원래 값도 같이 준다
RAW_FOR_RANKER = ["ret_1", "ret_5", "ret_20", "vol_20", "atr_14", "age"]


SPLIT_K = (2, 3, 4, 5, 6, 8, 10, 15, 20, 25, 30, 40, 50, 100)
GAP_BREAK = {"upbit": 10, "binance": 10, "krx": 30, "us": 30}  # 이보다 긴 공백 = 다른 시계열로 본다(달력일)
JUMP_BREAK = math.log(8)  # 하루 8배 넘는 변화는 데이터 이음새(티커 재사용 등)로 본다


def clean_series(a, market):
    """저장된 원본 일봉을 학습용으로 정리 (원본 파일은 그대로 둔다). 반환 (구간 목록(시간 순), 조정 건수)

    - 주식: 네이버 해외 시세에 가끔 수정주가가 안 된 액면분할이 섞여 있다(CPRT 2:1, DXCM 4:1 등).
      시가 갭이 1/k(±5%), 종가가 1/k(±12%)이면 분할로 보고 그 전 가격을 1/k, 거래량을 k 배로 맞춘다.
      (실제 폭락은 시가가 정확히 1/k 근처에 서지 않는다 — 예: CRDO 2023-02-15 시가 0.55배)
    - 주식의 거래량 0 인 날 = 거래정지로 보고 버린다 (사지 못하는 날을 학습·검증에 쓰지 않게).
    - 긴 공백·하루 8배 넘는 점프(다른 종목 데이터가 이어 붙은 경우 등)에서 시계열을 끊어 구간 여러 개로 나눈다.
      마지막 구간이 그 종목이고, 앞 구간들은 별도 시계열(code#1, #2 …)로 남긴다. 예전처럼 '마지막 끊김 이전'을
      통째로 지우면 그 시점엔 알 수 없던 미래의 거래정지가 과거 유니버스를 바꾼다(시점 일관성 위반).
      끊는 위치는 각 시점에 이미 알 수 있는 정보(그날까지의 공백·점프)라서 어느 시점 d 에서 잘라 계산해도 같다."""
    a = {k: np.array(v, dtype=np.float64 if k != "t" else np.int64) for k, v in a.items()}
    n_adj = 0
    if market in ("krx", "us"):
        keep = a["v"] > 0
        if keep.sum() >= 2 and not keep.all():
            a = {k: v[keep] for k, v in a.items()}
        c, o = a["c"], a["o"]
        if len(c) >= 2:
            # 앞쪽 가격을 일정 배수로 바꿔도 그 앞의 하루 비율은 그대로라서, 원본에서 한 번에 찾고 나중에 누적 적용
            ro, rc = o[1:] / c[:-1], c[1:] / c[:-1]
            fac = np.zeros(len(rc))
            for k in SPLIT_K:
                fwd = (np.abs(ro * k - 1) < 0.05) & (np.abs(rc * k - 1) < 0.12) & (fac == 0)
                fac[fwd] = 1.0 / k
                rev = (np.abs(ro / k - 1) < 0.05) & (np.abs(rc / k - 1) < 0.12) & (fac == 0)
                fac[rev] = float(k)
            # 거래량 확인: 분할 당일 주식 수 기준 거래량은 대략 k 배(역분할은 줄어듦). 폭락일은 10~20배로 치솟는다.
            vv = a["v"]
            for i in np.nonzero(fac)[0]:
                pre = float(np.median(vv[max(0, i - 19):i + 1]))
                vr = vv[i + 1] / pre if pre > 0 else np.inf
                kk = 1.0 / fac[i] if fac[i] < 1 else fac[i]
                if (fac[i] < 1 and vr > 2.5 * kk) or (fac[i] > 1 and vr > 2.5):
                    fac[i] = 0.0
            ev = np.nonzero(fac)[0]
            if len(ev):
                mult = np.ones(len(c))
                for i in ev:  # i 번째 비율 = c[i+1]/c[i] → c[:i+1] 을 조정
                    mult[:i + 1] *= fac[i]
                for key in ("o", "h", "l", "c"):
                    a[key] = a[key] * mult
                a["v"] = a["v"] / mult
                n_adj += len(ev)
    t, c = a["t"], a["c"]
    segs = [a]
    if len(t) >= 2:
        gap = np.diff(t) / 86400.0
        jump = np.abs(np.diff(np.log(c)))
        brk = np.nonzero((gap > GAP_BREAK[market]) | (jump > JUMP_BREAK))[0]
        if len(brk):
            cuts = [0] + [int(b) + 1 for b in brk] + [len(t)]
            segs = [{k: v[s:e] for k, v in a.items()} for s, e in zip(cuts[:-1], cuts[1:])]
            n_adj += len(brk)
    return segs, n_adj


def build_panel(arrs, listed=None, max_days=None, market=None):
    """arrs: {code: {"t","o","h","l","c","v"}} → 날짜×종목 패널"""
    listed = dict(listed or {})
    n_adj = 0
    if market:
        cleaned = {}
        for code, a in arrs.items():
            segs, n = clean_series(a, market)
            n_adj += n
            if len(segs) > 1:
                # 앞 구간은 별도 시계열(유니버스 밖 — 학습·횡단면 통계에만 쓰인다). 상장일 정보는 첫 구간에만 맞다.
                for k, b in enumerate(segs[:-1]):
                    pc = f"{code}#{len(segs) - 1 - k}"
                    if len(b["t"]) >= 2:
                        cleaned[pc] = b
                        if k == 0 and code in listed:
                            listed[pc] = listed[code]
                listed.pop(code, None)
            b = segs[-1]
            if len(b["t"]) >= 2:
                cleaned[code] = b
        arrs = cleaned
    codes = sorted(arrs)
    raw = {}
    for k in ("o", "h", "l", "c", "v"):
        raw[k] = pd.DataFrame({code: pd.Series(arrs[code][k], index=pd.to_datetime(arrs[code]["t"], unit="s"))
                               for code in codes}).sort_index()
    C0 = raw["c"]
    # 종목이 거의 없는 날(데이터 오류) 제거 — 직전 10일 최대 종목 수의 절반 미만이면 버린다 (과거만 본다)
    cnt = C0.notna().sum(axis=1)
    ok = cnt >= 0.5 * cnt.rolling(10, min_periods=1).max()
    for k in raw:
        raw[k] = raw[k].loc[ok]
    if max_days:
        for k in raw:
            raw[k] = raw[k].iloc[-int(max_days):]
    actual = raw["c"].notna()
    C = raw["c"].ffill(limit=FFILL_LIMIT)
    filled = C.notna() & ~actual
    O = raw["o"].where(actual, C)
    Hh = raw["h"].where(actual, C)
    L = raw["l"].where(actual, C)
    V = raw["v"].where(actual, 0.0).where(C.notna())
    obs = actual.cumsum()  # 그날까지 실제로 쌓인 일봉 수
    elig = C.notna() & (obs >= MIN_OBS)
    # 상장 후 일수: 상장일을 아는 종목(이력이 요청보다 짧게 온 종목)은 정확히, 모르는 종목은
    # '데이터 시작 후 일수'가 상한을 넘을 때부터만 값이 확정된다(그 전엔 모름 = NaN)
    first = pd.Series({c: raw["c"][c].first_valid_index() for c in codes})
    dates = C.index
    age = np.full(C.shape, np.nan)
    dnum = dates.values.astype("datetime64[D]").astype(np.int64)
    for j, code in enumerate(codes):
        if first[code] is None or pd.isna(first[code]):
            continue
        if code in listed:
            start = np.int64(int(listed[code]) // 86400)
            age[:, j] = np.clip(dnum - start, 0, AGE_CAP)
        else:
            d0 = np.datetime64(first[code], "D").astype(np.int64)
            span = dnum - d0
            age[:, j] = np.where(span >= AGE_CAP, AGE_CAP, np.nan)
    age = pd.DataFrame(age, index=dates, columns=codes).where(C.notna())
    return {"dates": dates, "codes": codes, "c": C, "o": O, "h": Hh, "l": L, "v": V,
            "actual": actual, "filled": filled, "obs": obs, "elig": elig, "age": age, "adjusted": n_adj}


def _rolling_mdd(C, w):
    """최근 w 일 안의 최대 낙폭 (경로 의존이라 창을 펼쳐 계산)"""
    a = C.values.astype(np.float64)
    T, N = a.shape
    out = np.full((T, N), np.nan)
    if T >= w:
        for j0 in range(0, N, 64):  # 메모리 절약용 열 묶음
            win = sliding_window_view(a[:, j0:j0 + 64], w, axis=0)  # (T-w+1, n, w)
            peak = np.maximum.accumulate(win, axis=2)
            out[w - 1:, j0:j0 + 64] = (win / peak - 1.0).min(axis=2)
    return pd.DataFrame(out, index=C.index, columns=C.columns)


def _xs_median(df, elig):
    return df.where(elig).median(axis=1)


def compute_features(P, market):
    C, O, Hh, L, V, elig = P["c"], P["o"], P["h"], P["l"], P["v"], P["elig"]
    with np.errstate(divide="ignore", invalid="ignore"):
        lc = np.log(C)
        r = lc.diff()
        F = {}
        for k in (1, 5, 20, 60, 120, 250):
            F[f"ret_{k}"] = C / C.shift(k) - 1
        skip, year = MOM_WIN[market]
        F["mom_12_1"] = C.shift(skip) / C.shift(year) - 1
        ma = {n: C.rolling(n, min_periods=n).mean() for n in (5, 20, 60, 120)}
        for n in (5, 20, 60, 120):
            F[f"gap_ma{n}"] = C / ma[n] - 1
        F["slope_ma20"] = ma[20] / ma[20].shift(5) - 1
        F["slope_ma60"] = ma[60] / ma[60].shift(20) - 1
        F["ma_align"] = (np.sign(ma[5] - ma[20]) + np.sign(ma[20] - ma[60]) + np.sign(ma[60] - ma[120]))
        d = C.diff()
        au = d.clip(lower=0).ewm(alpha=1 / 14, adjust=False, min_periods=14).mean()
        ad = (-d).clip(lower=0).ewm(alpha=1 / 14, adjust=False, min_periods=14).mean()
        rsi = 100 - 100 / (1 + au / ad)
        rsi = rsi.where(ad > 0, np.where(au > 0, 100.0, 50.0)).where(au.notna())
        F["rsi_14"] = rsi
        ll, hh = L.rolling(14).min(), Hh.rolling(14).max()
        F["stoch_14"] = ((C - ll) / (hh - ll)).where(hh > ll, 0.5).where(hh.notna()) * 100
        e12 = C.ewm(span=12, adjust=False, min_periods=12).mean()
        e26 = C.ewm(span=26, adjust=False, min_periods=26).mean()
        macd = e12 - e26
        sig = macd.ewm(span=9, adjust=False, min_periods=9).mean()
        F["macd"] = macd / C
        F["macd_hist"] = (macd - sig) / C
        sd20 = C.rolling(20).std(ddof=0)
        up, lo = ma[20] + 2 * sd20, ma[20] - 2 * sd20
        F["bb_pctb"] = ((C - lo) / (up - lo)).where(up > lo, 0.5).where(sd20.notna())
        F["bb_width"] = (up - lo) / ma[20]
        pc = C.shift(1)
        tr = np.maximum(np.maximum(Hh - L, (Hh - pc).abs()), (L - pc).abs())
        F["atr_14"] = tr.ewm(alpha=1 / 14, adjust=False, min_periods=14).mean() / C
        F["vol_20"] = r.rolling(20).std()
        F["vol_60"] = r.rolling(60).std()
        F["vol_ratio"] = F["vol_20"] / F["vol_60"]
        v5, v20, v60 = V.rolling(5).mean(), V.rolling(20).mean(), V.rolling(60).mean()
        F["volu_1_20"] = (V / v20).where(v20 > 0)
        F["volu_5_20"] = (v5 / v20).where(v20 > 0)
        F["volu_20_60"] = (v20 / v60).where(v60 > 0)
        w = W52[market]
        F["hi_52w"] = C / Hh.rolling(w, min_periods=60).max() - 1
        F["lo_52w"] = C / L.rolling(w, min_periods=60).min() - 1
        F["mdd_60"] = _rolling_mdd(C, 60)
        pos = (r > 0).astype(float).where(r.notna())
        F["up_20"] = pos.rolling(20).mean()
        F["up_60"] = pos.rolling(60).mean()
        F["max_ret_20"] = np.exp(r.rolling(20).max()) - 1
        F["min_ret_20"] = np.exp(r.rolling(20).min()) - 1
        F["skew_60"] = r.rolling(60).skew()
        clv = ((C - L) / (Hh - L)).where(Hh > L, 0.5)
        F["clv_5"] = clv.rolling(5).mean()
        F["gap_20"] = np.exp(np.log(O / pc).rolling(20).sum()) - 1
        F["intra_20"] = np.exp(np.log(C / O).rolling(20).sum()) - 1
        F["ram_60"] = F["ret_60"] / (F["vol_60"] * math.sqrt(60))
        # 시장 수익률 = 같은 날 '점수 대상' 종목들의 일간 수익률 중앙값 (t 시점 횡단면만 사용)
        rm = _xs_median(r, elig)
        mr, mm = r.rolling(60).mean(), rm.rolling(60).mean()
        cov = r.mul(rm, axis=0).rolling(60).mean() - mr.mul(mm, axis=0)
        varm = rm.rolling(60).var(ddof=0)
        beta = cov.div(varm.where(varm > 0), axis=0)
        F["beta_60"] = beta
        resid = r.rolling(60).var(ddof=0) - beta.pow(2).mul(varm, axis=0)
        F["ivol_60"] = np.sqrt(resid.clip(lower=0))
        for k in (20, 60, 120):
            F[f"rs_{k}"] = F[f"ret_{k}"].sub(_xs_median(F[f"ret_{k}"], elig), axis=0)
        F["age"] = P["age"]
        M = {
            "mkt_ret_20": _xs_median(F["ret_20"], elig),
            "mkt_ret_60": _xs_median(F["ret_60"], elig),
            "mkt_vol_20": _xs_median(F["vol_20"], elig),
            "mkt_breadth": (C > ma[60]).astype(float).where(ma[60].notna() & elig).mean(axis=1),
            "mkt_disp_20": F["ret_20"].where(elig).quantile(0.75, axis=1) - F["ret_20"].where(elig).quantile(0.25, axis=1),
        }
    for k in F:
        F[k] = F[k].replace([np.inf, -np.inf], np.nan).where(elig)
    for k in M:
        M[k] = M[k].replace([np.inf, -np.inf], np.nan)
    assert set(F) == set(FEATURES), set(F) ^ set(FEATURES)
    return F, M


def xs_rank(df, elig):
    """같은 날 점수 대상 종목 안에서의 백분위 (0~1, 가운데 정렬). NaN 은 NaN 유지"""
    x = df.where(elig)
    n = x.notna().sum(axis=1)
    return (x.rank(axis=1) - 0.5).div(n.where(n > 0), axis=0)


def build_dataset(P, F, M, market, H=None):
    """긴 형식(행 = 날짜×종목, 날짜 순으로 연속) 학습 데이터"""
    H = H or HORIZON[market]
    elig = P["elig"]
    C = P["c"]
    mask = elig.values
    ti, si = np.nonzero(mask)  # 행 우선 → 날짜 순으로 연속 (랭커의 그룹 조건)
    T, N = mask.shape
    fkeys = [k for k in F]  # 기본 특징 + extra_features 로 더한 특징 (넣은 순서 그대로)
    mkeys = [k for k in M]
    rank_keys = [k for k in fkeys if k not in RANK_SKIP]
    rank_cols, raw_cols = [], []
    for k in rank_keys:
        rank_cols.append(xs_rank(F[k], elig).values[mask])
    for k in fkeys:
        raw_cols.append(F[k].values[mask])
    reg_cols = [np.broadcast_to(M[k].values[:, None], (T, N))[mask] for k in mkeys]
    ranker_cols = rank_cols + [F[k].values[mask] for k in RAW_FOR_RANKER] + reg_cols
    ranker_names = [f"r:{k}" for k in rank_keys] + [f"v:{k}" for k in RAW_FOR_RANKER] + [f"m:{k}" for k in mkeys]
    q_cols = raw_cols + reg_cols
    q_names = [f"v:{k}" for k in fkeys] + [f"m:{k}" for k in mkeys]
    Xr = np.ascontiguousarray(np.column_stack(ranker_cols).astype(np.float32))
    Xq = np.ascontiguousarray(np.column_stack(q_cols).astype(np.float32))
    # 목표값: H 일(거래일) 뒤 수익률과 같은 날 시장 중앙값 대비 초과수익 — 학습 라벨에만 미래가 들어간다
    with np.errstate(divide="ignore", invalid="ignore"):
        fwd_df = (C.shift(-H) / C - 1).where(elig)
    fwd = fwd_df.values[mask]
    med = fwd_df.median(axis=1).values  # 같은 날 라벨이 있는 점수 대상 종목들의 중앙값
    excess = fwd - med[ti]
    # 순위 모형 라벨: 같은 날 수익률 순위를 정규분포 점수로 (극단값에 덜 휘둘린다)
    yrank = fwd_df.rank(axis=1)
    cnt = fwd_df.notna().sum(axis=1)
    u =((yrank - 0.5).div(cnt.where(cnt > 0), axis=0)).values[mask]
    ygauss = ndtri(np.clip(u, 1e-6, 1 - 1e-6))
    ygauss[~np.isfinite(u)] = np.nan
    return {
        "market": market, "H": H, "dates": P["dates"], "codes": P["codes"],
        "ti": ti.astype(np.int32), "si": si.astype(np.int32),
        "Xr": Xr, "Xr_names": ranker_names, "Xq": Xq, "Xq_names": q_names,
        "fwd": fwd.astype(np.float64), "excess": excess.astype(np.float64), "ygauss": ygauss.astype(np.float64),
        "has_label": np.isfinite(fwd),
    }


# ── 추가 특징 묶음 (research.py 로 검증해 시장별로 채택한 것만 EXTRA_GROUPS 에 둔다) ──────────────────
# 키 → (한국어 이름, 종류). 모두 t 시점까지의 값만 쓴다 (rolling·같은 날 횡단면).
EXTRA = {
    "ram_20": ("변동성 대비 20일 수익", "num"), "ram_120": ("변동성 대비 120일 수익", "num"),
    "mom_va": ("변동성 대비 12-1 모멘텀", "num"),
    "rev_1i": ("시장 영향을 뺀 1일 수익(단기 반전)", "pct"), "rev_5i": ("시장 영향을 뺀 5일 수익(단기 반전)", "pct"),
    "dv_20": ("20일 평균 거래대금(로그)", "num"), "dv_trend": ("거래대금 추세(5/60일)", "x"),
    "amihud_20": ("비유동성(가격 충격, 로그)", "num"),
    "hi_20": ("20일 고점 대비", "pct"), "dsh_52w": ("52주 고점 뒤 지난 기간 비율", "num"),
    "beta_btc": ("비트코인 베타(60일)", "num"), "corr_btc": ("비트코인 상관(60일)", "num"),
    "kp_rel": ("김치 프리미엄(시장 평균 대비)", "pct"), "kp_chg5": ("김치 프리미엄 5일 변화", "pct"),
    "frgn_d5": ("외국인 보유율 5일 변화", "pp"), "frgn_d20": ("외국인 보유율 20일 변화", "pp"),
    "frgn_lvl": ("외국인 보유율", "pp"),
}
EXTRA_REGIME = {"btc_ret_20": ("비트코인 20일 수익률", "pct")}
GROUPS = {
    "vam": ["ram_20", "ram_120", "mom_va"], "rev": ["rev_1i", "rev_5i"], "liq": ["dv_20", "dv_trend", "amihud_20"],
    "hi": ["hi_20", "dsh_52w"], "btc": ["beta_btc", "corr_btc", "btc_ret_20"], "kp": ["kp_rel", "kp_chg5"],
    "frgn": ["frgn_d5", "frgn_d20", "frgn_lvl"],
}
GROUP_MARKETS = {"btc": ("upbit", "binance"), "kp": ("upbit", "binance"), "frgn": ("krx",)}
# 시장별 채택 묶음 — research.py 의 사전 등록 규칙(개발 구간 ΔIC·짝 t, 보류 구간 최종 확인)을 통과한 것만
EXTRA_GROUPS = {"upbit": ["kp"], "binance": [], "krx": ["liq"], "us": []}  # 2026-10-20 연구 결과 (보류 구간 확인 통과)


def _btc_col(C, market):
    for k in ("KRW-BTC", "BTCUSDT"):
        if k in C.columns:
            return k
    return None


def extra_features(P, F, M, market, groups, aux=None):
    """F·M 에 추가 특징을 더한다 (제자리). aux: {"other_c": 다른 거래소 종가 DataFrame(김프), "frgn": {code: {t,f}}}"""
    aux = aux or {}
    C, Hh, V, elig = P["c"], P["h"], P["v"], P["elig"]
    with np.errstate(divide="ignore", invalid="ignore"):
        r = np.log(C).diff()
        new = {}
        newm = {}
        if "vam" in groups:
            skip, year = MOM_WIN[market]
            new["ram_20"] = F["ret_20"] / (F["vol_20"] * math.sqrt(20))
            new["ram_120"] = F["ret_120"] / (F["vol_60"] * math.sqrt(120))
            new["mom_va"] = F["mom_12_1"] / (F["vol_60"] * math.sqrt(year - skip))
        if "rev" in groups:
            for k, key in ((1, "rev_1i"), (5, "rev_5i")):
                mk = _xs_median(F[f"ret_{k}"], elig)
                new[key] = F[f"ret_{k}"] - F["beta_60"].fillna(1.0).mul(mk, axis=0)
        if "liq" in groups:
            dv = (C * V).where(V > 0)
            new["dv_20"] = np.log(dv.rolling(20, min_periods=10).mean())
            new["dv_trend"] = dv.rolling(5, min_periods=3).mean() / dv.rolling(60, min_periods=30).mean()
            new["amihud_20"] = np.log((r.abs() / dv).rolling(20, min_periods=10).mean() * 1e9 + 1e-12)
        if "hi" in groups:
            w = W52[market]
            new["hi_20"] = C / Hh.rolling(20).max() - 1
            arg = Hh.rolling(w, min_periods=60).apply(lambda x: len(x) - 1 - np.argmax(x), raw=True)
            new["dsh_52w"] = arg / w
        if "btc" in groups:
            b = _btc_col(C, market)
            if b is not None:
                rb = r[b]
                mr, mb = r.rolling(60).mean(), rb.rolling(60).mean()
                cov = r.mul(rb, axis=0).rolling(60).mean() - mr.mul(mb, axis=0)
                vb = rb.rolling(60).var(ddof=0)
                new["beta_btc"] = cov.div(vb.where(vb > 0), axis=0)
                new["corr_btc"] = cov / (r.rolling(60).std(ddof=0).mul(np.sqrt(vb), axis=0))
                newm["btc_ret_20"] = C[b] / C[b].shift(20) - 1
        if "kp" in groups and aux.get("other_c") is not None:
            O = aux["other_c"].reindex(C.index)  # 같은 코인(열 이름을 이쪽 코드로 맞춘) 다른 거래소 종가
            O = O.reindex(columns=C.columns)
            ratio = (C / O) if market == "upbit" else (O / C)  # 원화가/달러가
            lr = np.log(ratio)
            kp = lr.sub(lr.median(axis=1), axis=0)  # 그날 겹치는 코인들의 중앙값 = 환율 → 코인별 상대 프리미엄
            new["kp_rel"] = kp
            new["kp_chg5"] = kp - kp.shift(5)
        if "frgn" in groups and aux.get("frgn"):
            fr = {}
            for code in C.columns:
                a = aux["frgn"].get(code.split("#")[0]) if "#" not in code else None
                if a is not None and len(a["t"]):
                    fr[code] = pd.Series(a["f"], index=pd.to_datetime(a["t"], unit="s"))
            Fr = pd.DataFrame(fr).reindex(C.index).reindex(columns=C.columns)
            Fr = Fr.where(P["actual"]).ffill(limit=FFILL_LIMIT)
            new["frgn_d5"] = Fr - Fr.shift(5)
            new["frgn_d20"] = Fr - Fr.shift(20)
            new["frgn_lvl"] = Fr
    for k, v in new.items():
        F[k] = v.replace([np.inf, -np.inf], np.nan).where(elig)
    for k, v in newm.items():
        M[k] = v.replace([np.inf, -np.inf], np.nan)
    return list(new), list(newm)
