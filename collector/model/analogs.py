"""유사 패턴 — 최근 60일 정규화 가격 경로와 가장 비슷한 과거 구간(같은 종목 자기 이력)

- 유사도: 로그 종가를 창마다 평균 0·표준편차 1 로 정규화한 뒤의 피어슨 상관
- 후보 창은 최근 60일 창과 겹치지 않는 것만 (끝 위치 e ≤ 기준 끝 - 60). 그 뒤 H 일 결과가 이미 확정된 구간이다.
- 비슷한 창이 하루씩 밀린 복제본으로 10개를 다 채우지 않도록, 고른 창끼리 끝 날짜를 30일 이상 띄운다.
- 끝나는 날이 실제 거래일이고(거래정지로 앞 값을 채운 날이 아니고) 그 뒤 H 일 경로가 모두 있는 창만 쓴다
  → path 에 null 이 섞이거나 정지 중 가격이 기준가가 되는 일이 없다.
- 검증: 과거 평가일마다 그날까지의 이력만으로 같은 방식의 '유사 패턴 평균 수익'을 만들고
  실제 초과수익과의 순위 IC 를 잰다 (유사 패턴이 실제로 맞는지 정직하게 보여 주려고).
"""
import math

import numpy as np
from numpy.lib.stride_tricks import sliding_window_view

W = 60
TOPK = 10
MIN_SEP = 30
MIN_STATS = 3  # 유사 구간이 이보다 적으면 통계는 null


def znorm(c):
    """c: 종가(NaN 가능) → (len-W+1, W) 정규화 창. NaN 이 낀 창은 NaN"""
    with np.errstate(divide="ignore", invalid="ignore"):
        lc = np.log(c)
        win = sliding_window_view(lc, W)
        mu = win.mean(axis=1, keepdims=True)
        sd = win.std(axis=1, keepdims=True)
        return (win - mu) / np.where(sd > 1e-12, sd, np.nan)


def find(z, c, end, H, topk=TOPK, actual=None):
    """end: 기준 창의 끝 위치, actual: 실제 일봉이 있는 날(bool 배열, 없으면 유한한 종가로 판단).
    반환 [(e, corr)] 유사도 높은 순"""
    if end - W < W - 1:
        return []
    q = z[end - W + 1]
    if not np.all(np.isfinite(q)):
        return []
    last_row = end - W - (W - 1)  # 후보 창 끝 e ≤ end - W → 행 번호 e - W + 1
    if last_row < 0:
        return []
    corr = z[:last_row + 1] @ q / W
    corr = np.where(np.isfinite(corr), corr, -2.0)
    order = np.argsort(-corr, kind="stable")
    picked = []
    for i in order:
        r = corr[i]
        if r <= 0:
            break
        e = int(i) + W - 1
        if e + H > end or not np.all(np.isfinite(c[e:e + H + 1])):
            continue
        if actual is not None and not actual[e]:
            continue
        if all(abs(e - p) >= MIN_SEP for p, _ in picked):
            picked.append((e, float(r)))
            if len(picked) >= topk:
                break
    return picked


def describe(c, dates, picks, H):
    out = []
    for e, r in picks:
        base = c[e]
        path = [float(c[e + k] / base) for k in range(1, H + 1)]
        out.append({"start": str(dates[e - W + 1].date()), "end": str(dates[e].date()), "corr": r,
                    "fwdRet": path[-1] - 1.0, "path": path})
    return out


def stats(items):
    if len(items) < MIN_STATS:
        return None
    f = np.array([x["fwdRet"] for x in items])
    if not np.all(np.isfinite(f)):
        f = f[np.isfinite(f)]
        if len(f) < MIN_STATS:
            return None
    return {"n": int(len(f)), "winRate": float((f > 0).mean()), "avg": float(f.mean()), "median": float(np.median(f))}


def backtest_ic(C, ds, eval_days, H, actual=None):
    """평가일마다 그날까지의 이력만 쓴 '유사 패턴 평균 수익' vs 실제 초과수익의 순위 IC 평균"""
    from engine import _spearman
    st, si, ex = ds["starts"], ds["si"], ds["excess"]
    vals = C.values
    act = actual.values if actual is not None else None
    T, N = vals.shape
    Z = [None] * N
    fc = {}
    for d in eval_days:
        sl = slice(st[d], st[d + 1])
        for j in si[sl]:
            if Z[j] is None:
                Z[j] = znorm(vals[:, j])
            picks = find(Z[j], vals[:, j], d, H, actual=None if act is None else act[:, j])
            if len(picks) >= MIN_STATS:
                e = np.array([p[0] for p in picks])
                fc[(d, j)] = float(np.mean(vals[e + H, j] / vals[e, j] - 1))
    ics = []
    for d in eval_days:
        sl = slice(st[d], st[d + 1])
        js, ys = si[sl], ex[sl]
        a = np.array([fc.get((d, j), np.nan) for j in js])
        ok = np.isfinite(a) & np.isfinite(ys)
        if ok.sum() >= 10:
            ics.append(_spearman(a[ok], ys[ok]))
    if len(ics) < 3:
        return None
    ics = np.array(ics)
    return {"ic": float(ics.mean()), "n": int(len(ics)),
            "t": float(ics.mean() / ics.std(ddof=1) * math.sqrt(len(ics))) if ics.std(ddof=1) > 0 else None}
