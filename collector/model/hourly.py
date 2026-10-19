"""단기(1시간) 예상 — 시간봉 이력 저장 + '지금과 비슷했던 과거 시간'의 다음 1시간 실제 결과 분포 + 누수 없는 검증

    python collector/model/hourly.py                    # 새 시간봉이 나온 시장만: 이력 갱신 → 예상 → JSON
    python collector/model/hourly.py --force --markets upbit,binance
    python collector/model/hourly.py --check            # 돌릴 시장만 markets=… 로 출력 (표준 라이브러리 수준, numpy 없이)

이력: collector/.history/<시장>_1h/<파일>.npz (t: 봉 시작 UTC 초, o h l c v) — 끝난 봉만 저장
  코인: 바이낸스 /api/v3/klines 1h (첫 수집 2년), 업비트 /v1/candles/minutes/60 (첫 수집 120일, 이후 계속 쌓임)
  주식: 야후 차트 API 60m (무료, 약 2년). 국내는 코드.KS/.KQ, 미국은 네이버 코드에서 거래소 꼬리를 뗀 티커.
  주식의 '다음 1시간'은 장 시간 기준 다음 봉이다 (장 마지막 봉 뒤에는 다음 날 첫 봉 — 밤사이 갭 포함).
방법: outlook.py 와 같은 근접 이웃(같은 시장 과거 시간 자리 중 특징이 가장 가까운 100개, 한 시각에 최대 2개,
  결과가 확정된 자리만) → 다음 1봉 수익률의 10·50·90% 분위와 오른 비율.
검증: 최근 평가 시각(코인 24시간 간격, 주식 하루 1번) 최대 60회마다 그 시각 이전에 확정된 자리만으로 예상 → 실제와 비교.
  범위 적중(목표 80%), 방향 적중(같은 종목 아무 시간 기준과 비교), 오를 확률 보정 → outlook._grade 와 같은 등급.
  검증은 하루 1번만 다시 하고(무겁다) 그사이에는 저장된 결과를 쓴다.
결과: web/public/data/predict/hourly/<시장>.json
"""
import argparse
import io
import json
import math
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))

import sources  # noqa: E402

MARKETS = ("upbit", "binance", "krx", "us")
HIST = HERE.parent / ".history"
OUT = HERE.parent.parent / "web" / "public" / "data" / "predict" / "hourly"
FIRST_DAYS = {"upbit": 120, "binance": 730}
KEEP = 24 * 800          # 시간봉 보관 상한
POOL_CAP = 400_000       # 근접 이웃 후보 상한 (가장 최근 것부터)
BT_PERIODS = 60
BT_EVERY_H = 20          # 검증은 이 시간마다 한 번만 다시
MIN_BARS = 72            # 특징 계산에 필요한 최소 시간봉 수
UNIVERSE_N = {"upbit": 150, "binance": 120, "krx": 200, "us": 200}  # 시간봉을 받을 종목 수 (시총·거래대금 순)
WORKERS = {"upbit": 6, "binance": 4, "krx": 4, "us": 4}


def log(msg):
    print(f"{datetime.now().strftime('%H:%M:%S')} {msg}", flush=True)


def hist_name(code):
    import re
    return code if re.fullmatch(r"[A-Za-z0-9._-]+", code) else "~" + code.encode("utf-8").hex()


def yahoo_symbol(market, code, ex):
    if market == "krx":
        return f"{code}.{'KQ' if ex == 'KOSDAQ' else 'KS'}"
    base = code.split(".")[0]
    if base and base[-1].islower():  # BRKb → BRK-B
        base = base[:-1] + "-" + base[-1].upper()
    return base


# ── 받기 ──────────────────────────────────────────────
def fetch_binance(code, since_ms, now):
    out = []
    start = since_ms
    for _ in range(40):
        d = sources.http_json(f"https://api.binance.com/api/v3/klines?symbol={code}&interval=1h&limit=1000&startTime={start}",
                              timeout=10, retries=1)
        if not d:
            break
        out += [(int(k[0]) // 1000, float(k[1]), float(k[2]), float(k[3]), float(k[4]), float(k[7])) for k in d]
        start = int(d[-1][0]) + 3600_000
        if len(d) < 1000 or start / 1000 > now:
            break
    return out


def fetch_upbit(code, since, now):
    out = []
    to = None
    for _ in range(60):
        url = f"https://api.upbit.com/v1/candles/minutes/60?market={code}&count=200"
        if to:
            url += "&to=" + to
        d = sources.http_json(url, timeout=10, retries=1)
        if not d:
            break
        for k in d:
            t = int(datetime.fromisoformat(k["candle_date_time_utc"]).replace(tzinfo=timezone.utc).timestamp())
            out.append((t, float(k["opening_price"]), float(k["high_price"]), float(k["low_price"]),
                        float(k["trade_price"]), float(k["candle_acc_trade_price"])))
        oldest = min(int(datetime.fromisoformat(k["candle_date_time_utc"]).replace(tzinfo=timezone.utc).timestamp()) for k in d)
        if oldest <= since or len(d) < 200:
            break
        to = datetime.fromtimestamp(oldest, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    return out


def fetch_yahoo(sym, first):
    rng = "730d" if first else "5d"
    d = sources.http_json(f"https://query1.finance.yahoo.com/v8/finance/chart/{sym}?interval=60m&range={rng}",
                          timeout=12, retries=1)["chart"]["result"][0]
    ts = d.get("timestamp") or []
    q = d["indicators"]["quote"][0]
    out = []
    for i, t in enumerate(ts):
        o, h, l, c, v = (q[k][i] for k in ("open", "high", "low", "close", "volume"))
        if None in (o, h, l, c) or not c:
            continue
        out.append((int(t), float(o), float(h), float(l), float(c), float(v or 0) * float(c)))
    return out


def update(market, codes, names, log=log, deadline=None):
    import numpy as np
    mdir = HIST / f"{market}_1h"
    mdir.mkdir(parents=True, exist_ok=True)
    now = time.time()
    ok = fail = 0

    def job(code):
        nonlocal ok, fail
        if deadline and time.time() > deadline:
            return
        path = mdir / f"{hist_name(code)}.npz"
        old = None
        if path.exists():
            try:
                with np.load(path) as z:
                    old = {k: z[k] for k in ("t", "o", "h", "l", "c", "v")}
            except Exception:
                old = None
        last = int(old["t"][-1]) if old is not None and len(old["t"]) else None
        try:
            if market == "binance":
                since = (last - 6 * 3600) if last else int(now - FIRST_DAYS[market] * 86400)
                rows = fetch_binance(code, since * 1000, now)
            elif market == "upbit":
                since = (last - 6 * 3600) if last else int(now - FIRST_DAYS[market] * 86400)
                rows = fetch_upbit(code, since, now)
            else:
                rows = fetch_yahoo(yahoo_symbol(market, code, (names.get(code) or [None, None, None])[2]), last is None)
        except Exception:
            fail += 1
            return
        # 끝난 봉만 (주식 마지막 봉은 30분짜리라 시작 + 1시간이 지나야 확정으로 본다)
        rows = [r for r in rows if r[0] + 3600 <= now - 60]
        if not rows:
            return
        new = {k: np.array([r[i] for r in rows], dtype=np.int64 if k == "t" else np.float64)
               for i, k in enumerate(("t", "o", "h", "l", "c", "v"))}
        if old is not None:
            keep = old["t"] < new["t"].min()
            merged = {k: np.concatenate([old[k][keep], new[k]]) for k in new}
        else:
            merged = new
        o = np.argsort(merged["t"], kind="stable")
        merged = {k: v[o] for k, v in merged.items()}
        u = np.concatenate([merged["t"][1:] != merged["t"][:-1], [True]])  # 같은 시각은 마지막 값
        merged = {k: v[u][-KEEP:] for k, v in merged.items()}
        buf = io.BytesIO()
        np.savez_compressed(buf, **merged)
        tmp = path.with_suffix(".tmp")
        tmp.write_bytes(buf.getvalue())
        tmp.replace(path)
        ok += 1

    with ThreadPoolExecutor(WORKERS[market]) as ex:
        list(ex.map(job, codes))
    log(f"[{market}] 시간봉 {ok}종목 갱신 / 실패 {fail}")
    return ok, fail


# ── 패널·특징 ─────────────────────────────────────────
def panel(market, codes):
    import numpy as np
    mdir = HIST / f"{market}_1h"
    arrs = {}
    for c in codes:
        try:
            with np.load(mdir / f"{hist_name(c)}.npz") as z:
                if len(z["t"]) >= MIN_BARS:
                    arrs[c] = {k: z[k] for k in ("t", "o", "h", "l", "c", "v")}
        except Exception:
            pass
    if not arrs:
        return None
    ts = np.unique(np.concatenate([a["t"] for a in arrs.values()]))
    if market in ("upbit", "binance"):  # 코인: 빈 시간도 채운 연속 시간축
        ts = np.arange(ts.min(), ts.max() + 1, 3600, dtype=np.int64)
    else:  # 주식: 종목 절반 이상이 봉을 가진 시각만 (장 시간)
        cnt = np.zeros(len(ts))
        for a in arrs.values():
            cnt[np.searchsorted(ts, a["t"])] += 1
        ts = ts[cnt >= 0.3 * len(arrs)]
    T, N = len(ts), len(arrs)
    codes = list(arrs)
    P = {k: np.full((T, N), np.nan) for k in ("o", "h", "l", "c", "v")}
    for j, c in enumerate(codes):
        a = arrs[c]
        i = np.searchsorted(ts, a["t"])
        m = (i < T) & (ts[np.minimum(i, T - 1)] == a["t"])
        for k in P:
            P[k][i[m], j] = a[k][m]
    actual = np.isfinite(P["c"])
    # 짧은 공백(최대 3봉)은 직전 종가로 (거래가 없던 시간)
    c = P["c"].copy()
    for _ in range(3):
        prev = np.vstack([np.full((1, N), np.nan), c[:-1]])
        c = np.where(np.isfinite(c), c, prev)
    P["c"] = c
    P["actual"] = actual
    P["t"] = ts
    P["codes"] = codes
    return P


def _roll(x, w, fn):
    import numpy as np
    from numpy.lib.stride_tricks import sliding_window_view
    out = np.full(x.shape, np.nan)
    if len(x) >= w:
        with np.errstate(all="ignore"):
            out[w - 1:] = fn(sliding_window_view(x, w, axis=0), axis=-1)
    return out


def cube(P):
    """(시각, 종목, 특징 10개) — 그 시각까지의 봉만 쓴다"""
    import numpy as np
    C, Hh, L, V = P["c"], P["h"], P["l"], P["v"]
    T, N = C.shape
    with np.errstate(all="ignore"):
        lc = np.log(C)
        r = np.vstack([np.full((1, N), np.nan), np.diff(lc, axis=0)])
        vol = _roll(r, 24, np.nanstd)
        vol = np.where(vol > 1e-5, vol, np.nan)

        def ret(k):
            out = np.full((T, N), np.nan)
            out[k:] = lc[k:] - lc[:-k]
            return out
        r1, r4, r24 = ret(1), ret(4), ret(24)
        up = np.clip(r, 0, None)
        dn = np.clip(-r, 0, None)
        au, ad = _roll(up, 14, np.nanmean), _roll(dn, 14, np.nanmean)
        rsi = au / (au + ad)
        ma = _roll(C, 20, np.nanmean)
        sd = _roll(C, 20, np.nanstd)
        pctb = np.clip((C - (ma - 2 * sd)) / (4 * sd), -0.5, 1.5)
        hi = _roll(np.where(np.isfinite(Hh), Hh, C), 24, np.nanmax)
        lo = _roll(np.where(np.isfinite(L), L, C), 24, np.nanmin)
        pos = (C - lo) / (hi - lo)
        vv = np.where(np.isfinite(V), V, 0.0)
        vr = np.log(np.clip(vv / _roll(vv, 24, np.mean), 0.05, 20))
        mk1 = np.nanmedian(r1 / vol, axis=1)
        mk4 = np.nanmedian(r4 / (vol * 2), axis=1)
        cols = [r1 / vol, r4 / (vol * 2), r24 / (vol * math.sqrt(24)), rsi, pctb, pos, np.log(vol), vr,
                np.broadcast_to(mk1[:, None], (T, N)), np.broadcast_to(mk4[:, None], (T, N))]
    X = np.stack(cols, axis=2).astype(np.float32)
    ok = np.isfinite(X).all(axis=2) & P["actual"]
    y = np.full((T, N), np.nan)
    with np.errstate(all="ignore"):
        y[:-1] = C[1:] / C[:-1] - 1.0
    y[:-1][~P["actual"][1:]] = np.nan  # 다음 봉이 실제로 있어야 결과로 쓴다
    return X, ok, y


class _Slice:
    def __init__(self, pool, a, b):
        self.X, self.t, self.y = pool.X[a:b], pool.t[a:b], pool.y[a:b]


def _knn_recent(pool, n, Xq):
    import outlook
    a = max(0, n - POOL_CAP)
    return outlook._knn(_Slice(pool, a, n), n - a, Xq)


def backtest(X, ok, y, market):
    import numpy as np
    import outlook
    T = X.shape[0]
    pool = outlook.Pool(X, ok, y, 1)
    base = outlook.Base(ok, y)
    every = 24 if market in ("upbit", "binance") else 7
    days = list(range(T - 2, max(MIN_BARS * 3, T - 2 - every * BT_PERIODS), -every))
    rec = {k: [] for k in ("y", "q10", "q50", "q90", "win", "bwin", "bq50")}
    used = 0
    tt = []
    for d in sorted(days):
        n_pool = pool.upto(d - 1)
        if n_pool < 20 * outlook.K:
            continue
        js = np.nonzero(ok[d] & np.isfinite(y[d]))[0]
        if len(js) < 5:
            continue
        n, q10, q50, q90, win = outlook._dist(_knn_recent(pool, n_pool, X[d, js]))
        good = n >= outlook.MIN_N
        if not good.any():
            continue
        used += 1
        tt.append(d)
        for i in np.nonzero(good)[0]:
            j = js[i]
            b = base.at(j, d - 1)
            rec["y"].append(y[d, j])
            for k, v in (("q10", q10), ("q50", q50), ("q90", q90), ("win", win)):
                rec[k].append(v[i])
            rec["bwin"].append(b[1] if b else np.nan)
            rec["bq50"].append(b[0] if b else np.nan)
    if used < 10:
        return None, None
    r = {k: np.array(v, dtype=float) for k, v in rec.items()}
    yv = r["y"]
    up = yv > 0
    nz = yv != 0
    cov = float(((yv >= r["q10"]) & (yv <= r["q90"])).mean())
    dir_hit = float(((r["q50"] > 0) == up)[nz].mean())
    hb = np.isfinite(r["bq50"])
    base_dir = float(((r["bq50"][hb] > 0) == up[hb])[nz[hb]].mean()) if hb.sum() >= 50 else None
    calib, err_w, err_n = [], 0.0, 0
    for lo, hi in zip(outlook.CAL_EDGES[:-1], outlook.CAL_EDGES[1:]):
        sel = (r["win"] >= lo) & (r["win"] < hi)
        if sel.sum() >= 20:
            p, a = float(r["win"][sel].mean()), float(up[sel].mean())
            calib.append({"p": p, "actual": a, "n": int(sel.sum())})
            err_w += abs(p - a) * sel.sum()
            err_n += sel.sum()
    cal_err = err_w / err_n if err_n else 1.0
    slope = float(np.polyfit(r["win"], up.astype(float), 1)[0]) if np.ptp(r["win"]) > 0 else None
    bss = None
    if hb.sum() >= 50:
        br = np.mean((r["win"][hb] - up[hb]) ** 2)
        bb = np.mean((r["bwin"][hb] - up[hb]) ** 2)
        bss = float(1.0 - br / bb) if bb > 0 else None
    # 수수료 감안: 오를 확률 상위 10% 자리의 다음 1시간 평균 수익 − 전체 평균
    k = max(1, int(len(yv) * 0.1))
    top = float(np.mean(yv[np.argsort(-r["win"])[:k]]) - np.mean(yv))
    return {"h": 1, "unit": "h", "periods": used, "n": int(len(yv)), "coverage": cov, "dirHit": dir_hit,
            "baseDirHit": base_dir, "calib": calib, "calibErr": float(cal_err), "calibSlope": slope,
            "brierSkill": bss, "topMinusAll": top, "grade": outlook._grade(cov, cal_err, bss, slope)}, tt


def _f3(x):
    return "n/a" if x is None else f"{x:.3f}"


def iso(t):
    return datetime.fromtimestamp(int(t), timezone.utc).isoformat(timespec="seconds")


def run_market(market, codes, names, fetch=True, deadline=None):
    import numpy as np
    import outlook
    from predict import write_json
    t0 = time.time()
    if fetch:
        update(market, codes, names, deadline=deadline)
    P = panel(market, codes)
    out_path = OUT / f"{market}.json"
    try:
        old = json.loads(out_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        old = {}
    if P is None or len(P["t"]) < MIN_BARS * 3:
        write_json(out_path, {"version": 1, "market": market, "updatedAt": iso(time.time()), "asOf": None, "h": 1,
                              "unit": "h", "grade": None, "backtest": None, "items": {},
                              "reason": "시간봉 이력이 아직 짧아 1시간 예상을 낼 수 없어요."})
        return
    X, ok, y = cube(P)
    T = X.shape[0]
    bt = old.get("backtest")
    age_h = (time.time() - datetime.fromisoformat(old["btAt"]).timestamp()) / 3600 if old.get("btAt") else 1e9
    bt_at = old.get("btAt")
    if not bt or age_h >= BT_EVERY_H:
        tb = time.time()
        bt, tt = backtest(X, ok, y, market)
        bt_at = iso(time.time())
        if bt:
            bt["from"], bt["to"] = iso(P["t"][tt[0]])[:10], iso(P["t"][tt[-1]])[:10]
            log(f"[{market}] 1시간 검증 {bt['periods']}회 {bt['n']:,}건: 범위 {bt['coverage']:.3f} 방향 {bt['dirHit']:.3f}"
                f"(기준 {_f3(bt['baseDirHit'])}) 보정오차 {bt['calibErr']:.3f} 브라이어개선 {_f3(bt['brierSkill'])} "
                f"상위10%−평균 {bt['topMinusAll'] * 100:+.3f}% → {bt['grade']} ({time.time() - tb:.0f}초)")
        else:
            log(f"[{market}] 1시간 검증 표본 부족")
    last = T - 1
    # 마지막 시각: 종목 대부분이 실제 봉을 가진 가장 최근 시각
    while last > 0 and P["actual"][last].sum() < 0.5 * P["actual"][max(0, last - 24):last].sum(axis=1).max():
        last -= 1
    pool = outlook.Pool(X, ok, y, 1)
    n_pool = pool.upto(last - 1)
    items = {}
    qj = [j for j in range(X.shape[1]) if ok[last, j]]
    if qj and n_pool >= 20 * outlook.K:
        n, q10, q50, q90, win = outlook._dist(_knn_recent(pool, n_pool, X[last, qj]))
        for i, j in enumerate(qj):
            if n[i] >= outlook.MIN_N:
                items[P["codes"][j]] = {"n": int(n[i]), "q10": float(q10[i]), "q50": float(q50[i]),
                                        "q90": float(q90[i]), "win": float(win[i])}
    grade = bt["grade"] if bt else None
    res = {"version": 1, "market": market, "updatedAt": iso(time.time()), "asOf": iso(P["t"][last]),
           "nextBarAt": iso(P["t"][last] + 3600), "h": 1, "unit": "h", "grade": grade, "backtest": bt, "btAt": bt_at,
           "items": items,
           "reason": None if bt else "검증 표본이 모자라 1시간 예상의 신뢰도를 매길 수 없어요."}
    if market in ("krx", "us"):
        res["note"] = "주식의 '다음 1시간'은 장 시간 기준 다음 봉이에요. 장 마지막 봉 뒤에는 다음 날 첫 봉(밤사이 갭 포함)이에요."
    write_json(out_path, res)
    log(f"[{market}] 1시간 예상 {len(items)}종목 기준 {res['asOf']} 등급 {grade} — {time.time() - t0:.0f}초")


def universe(market):
    idx_path = HIST / market / "_index.json"
    try:
        idx = json.loads(idx_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return [], {}
    return idx["universe"][:UNIVERSE_N[market]], idx.get("names") or {}


def due(market, now):
    """새 시간봉이 끝났는데 결과가 그보다 오래됐으면. 주식은 장 시간 무렵에만(+장 끝난 뒤 1번)."""
    try:
        r = json.loads((OUT / f"{market}.json").read_text(encoding="utf-8"))
        asof = datetime.fromisoformat(r["asOf"]).timestamp() if r.get("asOf") else 0
        upd = datetime.fromisoformat(r["updatedAt"]).timestamp()
    except (OSError, ValueError, KeyError, TypeError):
        return True
    if market in ("upbit", "binance"):
        return now - asof >= 2 * 3600 + 120 and now - upd >= 50 * 60
    h = datetime.fromtimestamp(now, timezone.utc)
    if h.weekday() >= 5:
        return now - upd >= 24 * 3600
    hour = h.hour + h.minute / 60
    sess = (0.0 <= hour <= 7.5) if market == "krx" else (13.5 <= hour <= 21.5)
    return now - upd >= (55 * 60 if sess else 6 * 3600)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--markets", default=",".join(MARKETS))
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--skip-fetch", action="store_true")
    ap.add_argument("--deadline", type=float, default=0, help="분")
    args = ap.parse_args()
    now = time.time()
    ms = [m for m in args.markets.split(",") if m in MARKETS]
    if not args.force:
        ms = [m for m in ms if due(m, now)]
    if args.check:
        print(f"markets={','.join(ms)}")
        return 0
    dl = now + args.deadline * 60 if args.deadline else None
    code = 0
    for m in ms:
        codes, names = universe(m)
        try:
            run_market(m, codes, names, fetch=not args.skip_fetch, deadline=dl)
        except Exception as e:
            import traceback
            traceback.print_exc()
            print(f"::warning title=1시간 예상 {m}::{e}", flush=True)
            code = 1
    return code


if __name__ == "__main__":
    sys.exit(main())
