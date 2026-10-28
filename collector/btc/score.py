"""예측 기록·채점 — data/btc_log.json (표준 라이브러리)

한 줄 = 한 번의 예측 (기준 시각마다 하나, 최근 LOG_DAYS 일만):
  [t, 가격, m24, lo24, hi24, u24, m1, lo1, hi1, u1, 갈림길, 실제24, 실제1]
  t: 기준 시각(UTC 초, 봉이 끝난 정각) · m/lo/hi: 예상 중앙·10%·90% 변화율(단순 수익률) · u: 오를 확률
  실제24·실제1: 기간이 지나면 업비트 종가로 채운 실제 변화율 (아직이면 null)
화면용 성적: '어제 이 시각 예측 → 실제', '최근 30일(매일 오전 9시에 가까운 예측 1개씩) 방향 x/n · 범위 안 y/n'.
"""
import math
from datetime import datetime

from . import core

LOG_DAYS = 60
COLS = ("t", "p", "m24", "lo24", "hi24", "u24", "m1", "lo1", "hi1", "u1", "pv", "a24", "a1")
I = {k: i for i, k in enumerate(COLS)}


def load(path):
    d = core.read_json(path, {}) or {}
    rows = [r for r in d.get("rows", []) if isinstance(r, list) and len(r) == len(COLS)]
    return {"version": 1, "cols": list(COLS), "rows": rows}


def _r(x, d=5):
    return None if x is None or x != x else round(float(x), d)


def add(log, t, price, f24, f1, pivot):
    """새 예측 한 줄 (같은 기준 시각이 있으면 바꾼다 — 같은 봉으로 다시 돌린 경우)"""
    row = [int(t), round(price), _r(f24["m"]), _r(f24["lo"]), _r(f24["hi"]), _r(f24["u"], 4),
           _r(f1["m"]), _r(f1["lo"]), _r(f1["hi"]), _r(f1["u"], 4), round(pivot) if pivot else None, None, None]
    rows = [r for r in log["rows"] if r[0] != int(t)]
    rows.append(row)
    rows.sort(key=lambda r: r[0])
    cut = int(t) - LOG_DAYS * 86400
    log["rows"] = [r for r in rows if r[0] >= cut]
    return row


def grade(log, bars):
    """기간이 지난 예측을 실제 종가로 채점. 바뀐 줄 수"""
    k = 0
    for r in log["rows"]:
        for hor, col in ((24, "a24"), (1, "a1")):
            if r[I[col]] is not None:
                continue
            # 기준 시각 t 의 hor 시간 뒤 종가 = 시작이 t + hor·3600 − 3600 인 봉의 종가
            i = bars.index(r[0] + (hor - 1) * core.HOUR)  # 끝난 봉만 들어 있다 (거래 없던 칸은 직전 체결가 = 그 시각 가격)
            if i is None:
                continue
            r[I[col]] = round(bars.c[i] / r[I["p"]] - 1, 5)
            k += 1
    return k


def dir_hit(m, a):
    """예상 변화율 부호가 실제와 같으면 True, 예상이 0(반반)이면 None"""
    if m is None or a is None or m == 0:
        return None
    if a == 0:
        return False
    return (m > 0) == (a > 0)


def in_range(lo, hi, a):
    if lo is None or hi is None or a is None:
        return None
    return lo <= a <= hi


def item(r, hor):
    s = "24" if hor == 24 else "1"
    m, lo, hi, u, a = r[I["m" + s]], r[I["lo" + s]], r[I["hi" + s]], r[I["u" + s]], r[I["a" + s]]
    return {"t": core.iso(r[0]), "price": r[I["p"]], "m": m, "lo": lo, "hi": hi, "pUp": u,
            "actual": a, "actualPrice": round(r[I["p"]] * (1 + a)) if a is not None else None,
            "dirHit": dir_hit(m, a), "inRange": in_range(lo, hi, a)}


def yesterday(log, t_now, tol_h=2):
    """기준 시각 24시간 전에 가장 가까운(±2시간) 예측 — 채점이 끝난 것"""
    best = None
    for r in log["rows"]:
        if r[I["a24"]] is None:
            continue
        d = abs(r[0] - (t_now - 86400))
        if d <= tol_h * core.HOUR and (best is None or d < best[0]):
            best = (d, r)
    return item(best[1], 24) if best else None


def daily_rows(log, days=30, hour_kst=9, tol_h=4):
    """KST 날짜마다 오전 9시에 가장 가까운(±4시간) 채점된 24시간 예측 하나"""
    by_day = {}
    for r in log["rows"]:
        if r[I["a24"]] is None:
            continue
        d = datetime.fromtimestamp(r[0], core.KST)
        anchor = d.replace(hour=hour_kst, minute=0, second=0, microsecond=0)
        dist = abs((d - anchor).total_seconds())
        if dist > tol_h * 3600:
            continue
        key = anchor.date().isoformat()
        if key not in by_day or dist < by_day[key][0]:
            by_day[key] = (dist, r)
    keys = sorted(by_day)[-days:]
    return [by_day[k][1] for k in keys]


def live_summary(log, days=30):
    rows = daily_rows(log, days)
    dh = [dir_hit(r[I["m24"]], r[I["a24"]]) for r in rows]
    ir = [in_range(r[I["lo24"]], r[I["hi24"]], r[I["a24"]]) for r in rows]
    # 1시간: 최근 days 일의 모든 채점된 1시간 예측
    if log["rows"]:
        cut = log["rows"][-1][0] - days * 86400
    else:
        cut = 0
    one = [r for r in log["rows"] if r[0] >= cut and r[I["a1"]] is not None]
    dh1 = [dir_hit(r[I["m1"]], r[I["a1"]]) for r in one]
    ir1 = [in_range(r[I["lo1"]], r[I["hi1"]], r[I["a1"]]) for r in one]
    first = log["rows"][0][0] if log["rows"] else None
    span_days = (log["rows"][-1][0] - first) / 86400 if first else 0
    return {
        "since": core.iso(first) if first else None,
        "days": int(math.floor(span_days)) + (1 if first else 0),
        "n": len(rows),
        "dir": [sum(1 for x in dh if x), sum(1 for x in dh if x is not None)],
        "range": [sum(1 for x in ir if x), sum(1 for x in ir if x is not None)],
        "h1": {"n": len(one), "dir": [sum(1 for x in dh1 if x), sum(1 for x in dh1 if x is not None)],
               "range": [sum(1 for x in ir1 if x), sum(1 for x in ir1 if x is not None)]},
        "recent": [{"t": core.iso(r[0]), "m": r[I["m24"]], "a": r[I["a24"]], "lo": r[I["lo24"]], "hi": r[I["hi24"]]} for r in rows[-7:]],
    }
