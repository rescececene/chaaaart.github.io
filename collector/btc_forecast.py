"""비트코인 카드 — 업비트 원화 비트코인의 24시간·1시간 뒤 예상(중앙값 %·10번 중 8번 범위·오를 확률)·갈림길·채점

    python collector/btc_forecast.py                          # 매 실행: 새 시간봉 → 예측 → data/btc.json, 기록 채점 (표준 라이브러리, 몇 초)
    python collector/btc_forecast.py --check-train --if-stale 20   # 학습할 차례면 train=1 (GitHub Actions 출력용, 표준 라이브러리)
    python collector/btc_forecast.py --train --if-stale 20 --deadline 8   # 하루 1번: 긴 이력 → 검증·학습 → data/btc_model.json (numpy·lightgbm)

파일 (모두 web/public/data — 데이터 캐시로 매 실행 이어진다)
  btc.json        화면용 (수 KB)
  btc_log.json    예측 기록·채점 (최근 60일)
  btc_model.json  학습 결과: 모델 계수·보정·검증 성적·갈림길 근거 (사이트는 읽지 않음)
  btc_bars.json   최근 시간봉 1000개 (다음 실행 때 새 봉만 받으려고, 사이트는 읽지 않음)
긴 이력: collector/.history/btc/KRW-BTC_1h.npz (학습할 때만)
"""
import argparse
import json
import math
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from btc import core, score, text  # noqa: E402

OUT_FILE = core.OUT / "btc.json"
LOG_FILE = core.OUT / "btc_log.json"
MODEL_FILE = core.OUT / "btc_model.json"
BARS_FILE = core.OUT / "btc_bars.json"
KEEP_BARS = 1000
SPARK_H = 48


def log(msg):
    print(f"[btc] {msg}", flush=True)


# ── 시간봉 ─────────────────────────────────────────
def refresh_bars(now):
    d = core.read_json(BARS_FILE)
    b = None
    if d:
        try:
            b = core.Bars.from_json(d)
        except (KeyError, TypeError, ValueError):
            b = None
    n_req = 0
    if b is None or len(b) < core.NEED_BARS or now - (b.t_last + core.HOUR) > 180 * core.HOUR:
        rows = core.fetch_hourly(KEEP_BARS, now=now)  # 처음·오래 끊겼을 때: 5번
        n_req = math.ceil(KEEP_BARS / 200)
        b = core.Bars.from_rows(rows)
    else:
        rows = core.fetch_hourly(200, now=now)  # 보통: 1번
        n_req = 1
        b.merge(rows)
    b = b.tail(KEEP_BARS)
    return b, n_req


# ── 갈림길 고르기 ────────────────────────────────────
def choose_pivot(b, i, price, lo_p, hi_p, ev, prev_kind):
    """24시간 범위 안의 후보 중 과거 근거(t)가 가장 뚜렷한 것. 직전 것이 아직 범위 근처면 그대로(자주 안 바뀌게).
    범위 안에 없으면 가장 가까운 후보."""
    levels = {k: v for k, v in core.pivot_levels(b, i).items() if v == v and v > 0}
    if not levels:
        return None
    span = hi_p - lo_p
    strength = {k: (ev.get(k) or {}).get("t", 0.0) for k in levels}
    inside = [k for k, v in levels.items() if lo_p <= v <= hi_p]
    if prev_kind in levels and lo_p - 0.1 * span <= levels[prev_kind] <= hi_p + 0.1 * span:
        kind = prev_kind
    elif inside:
        kind = max(inside, key=lambda k: strength[k])
    else:
        kind = min(levels, key=lambda k: abs(levels[k] - price))
    lv = levels[kind]
    e = ev.get(kind)
    name, desc = core.PIVOTS[kind]
    return {"price": round(lv), "kind": kind, "label": name, "desc": desc,
            "side": "above" if price >= lv else "below", "dist": round(price / lv - 1, 5),
            "inRange": bool(lo_p <= lv <= hi_p),
            "ev": {"above": e["above"], "below": e["below"], "above2y": e.get("above2y"), "below2y": e.get("below2y"),
                   "from": e["from"], "days": e["days"]} if e else None}


def edge_of(long_, y1):
    """방향 예측력 — 긴 기간(2021~) 되짚어 본 성적이 기준, 최근 1년이 0 이하로 떨어졌으면 없음으로
    none: 맞힘 52% 미만이거나 브라이어 개선 0.1% 미만 · weak: 52~55% · some: 55% 이상"""
    if not long_:
        return "none"
    hit, bss = long_.get("hit"), long_.get("bss")
    if hit is None or bss is None or hit < 0.52 or bss < 0.001:
        return "none"
    if y1 and (y1.get("bss") or 0) <= 0:
        return "none"
    return "weak" if hit < 0.55 else "some"


def horizon(h, f, price, t_close, bt):
    """로그 수익률 → 단순 변화율·가격"""
    med, lo, hi = math.expm1(f["med"]), math.expm1(f["q10"]), math.expm1(f["q90"])
    key = f"h{h}"
    return {"h": h, "target": core.iso(t_close + h * core.HOUR), "med": round(med, 5), "lo": round(lo, 5), "hi": round(hi, 5),
            "medPrice": round(price * (1 + med)), "loPrice": round(price * (1 + lo)), "hiPrice": round(price * (1 + hi)),
            "pUp": round(f["pUp"], 4), "lean": text.lean_h(h, med, f["pUp"]),
            "edge": edge_of((bt.get("long") or {}).get(key), bt.get(key))}


def run(use_ai=True):
    t0 = time.time()
    now = time.time()
    model = core.read_json(MODEL_FILE)
    if not model or "h24" not in model or "h1" not in model:
        log("학습된 모델(btc_model.json)이 없어요 — --train 을 먼저 돌려야 해요")
        return 1
    try:
        b, n_req = refresh_bars(now)
    except Exception as e:  # 업비트가 잠깐 안 될 때: 저장된 봉으로 (기준 시각이 오래되면 화면이 '오래된 예측'으로 알린다)
        log(f"시간봉 받기 실패 — 저장된 봉으로 계산: {e}")
        d = core.read_json(BARS_FILE)
        if not d:
            return 1
        b, n_req = core.Bars.from_json(d), 0
    if len(b) < core.NEED_BARS:
        log(f"시간봉이 모자라요 ({len(b)}개)")
        return 1
    core.write_json(BARS_FILE, b.to_json())
    i = len(b) - 1
    t_close = b.t(i) + core.HOUR
    price = b.c[i]
    F = core.features(b)
    row = {k: F[k][i] for k in core.FEATURES}
    sig24, sig1 = core.sigma_for(model["h24"], b, F, i), core.sigma_for(model["h1"], b, F, i)
    if not all(s == s and s > 0 for s in (sig24, sig1)):
        log("변동성을 계산하지 못했어요")
        return 1
    f24 = core.predict_h(model["h24"], row, sig24)
    f1 = core.predict_h(model["h1"], row, sig1)
    bt = model.get("backtest") or {}
    h24 = horizon(24, f24, price, t_close, bt)
    h1 = horizon(1, f1, price, t_close, bt)
    prev = core.read_json(OUT_FILE, {}) or {}
    pv = choose_pivot(b, i, price, h24["loPrice"], h24["hiPrice"], model.get("pivot") or {}, (prev.get("pivot") or {}).get("kind"))

    lg = score.load(LOG_FILE)
    score.add(lg, t_close, price, {"m": h24["med"], "lo": h24["lo"], "hi": h24["hi"], "u": h24["pUp"]},
              {"m": h1["med"], "lo": h1["lo"], "hi": h1["hi"], "u": h1["pUp"]}, pv["price"] if pv else None)
    graded = score.grade(lg, b)
    core.write_json(LOG_FILE, lg)

    state = {"price": price, "asOfLabel": f"{core.kst_label(t_close)} 기준",
             "f24": {"m": h24["med"], "lo": h24["lo"], "hi": h24["hi"], "u": h24["pUp"]},
             "f1": {"m": h1["med"], "lo": h1["lo"], "hi": h1["hi"], "u": h1["pUp"]},
             "pivot": pv, "bt": bt, "edge24": h24["edge"], "edge1": h1["edge"]}
    summary = text.conclusion(state, prev.get("summary"), use_ai=use_ai, log=log)
    out = {
        "version": 1, "updatedAt": core.iso(now), "asOf": core.iso(t_close), "price": round(price),
        "spark": [round(x) for x in b.c[-SPARK_H:]],
        "h24": h24, "h1": h1, "pivot": pv,
        "summary": summary,
        "yesterday": score.yesterday(lg, t_close),
        "live": score.live_summary(lg),
        "backtest": {k: bt.get(k) for k in ("trainedAt", "from", "to", "h24", "h1", "d30", "calib24", "slope24", "calib1", "slope1",
                                            "long", "model24", "model1")} if bt else None,
    }
    core.write_json(OUT_FILE, out)
    log(f"{core.kst_label(t_close)} 기준 {core.krw(price)} → 24시간 {core.pct(h24['med'])} "
        f"[{core.pct(h24['lo'])} ~ {core.pct(h24['hi'])}] 오를 확률 {h24['pUp']:.0%} · 1시간 {core.pct(h1['med'], 2)} "
        f"({h1['pUp']:.0%}) · 갈림길 {core.krw(pv['price']) if pv else '-'} · 결론 {summary['by']} · 채점 {graded}건 · "
        f"요청 {n_req}번 · {time.time() - t0:.1f}초")
    return 0


def make_fixture(path):
    """h1.test.ts 가 브라우저 계산(h1.ts)을 파이썬(core)과 맞춰 보는 파일 — 최근 200봉 + 나무 20개로 줄인 계수 + 기대값"""
    d = core.read_json(BARS_FILE)
    hb = core.read_json(core.OUT / "btc_h1.json")
    if not d or not hb:
        log("btc_bars.json · btc_h1.json 이 먼저 있어야 해요 (--train 과 한 번 실행)")
        return 1
    b = core.Bars.from_json(d).tail(200)
    hb = dict(hb, trees=hb["trees"][:20])
    i = len(b) - 1
    F = core.features(b)
    row = {k: F[k][i] for k in core.FEATURES_SHORT}
    raw = sum(core._tree(t, [row.get(c, core.NAN) for c in hb["cols"]]) for t in hb["trees"])
    lo = max(-30.0, min(30.0, hb["platt"]["a"] + hb["platt"]["b"] * raw))
    p_up = 1 / (1 + math.exp(-lo))
    z = -core.interp(hb["ep"], hb["eq"], 1 - p_up)
    sig = core.garch_next(b, i, hb["garch"]["p"], hb["garch"]["seasBar"])
    bars = [{"t": b.t(k), "o": b.o[k], "h": b.h[k], "l": b.l[k], "c": b.c[k], "v": b.v[k]} for k in range(len(b))]
    exp = {"features": {k: (None if v != v else v) for k, v in row.items()}, "raw": raw, "pUp": p_up, "z": z, "sigma": sig,
           "med": math.expm1(z * sig), "lo": math.expm1((z + hb["scale"] * hb["lo"]) * sig), "hi": math.expm1((z + hb["scale"] * hb["hi"]) * sig)}
    Path(path).write_text(json.dumps({"model": hb, "bars": bars, "expected": exp}, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    log(f"시험 파일 {path} ({Path(path).stat().st_size // 1024} KB)")
    return 0


def model_age_h():
    m = core.read_json(MODEL_FILE)
    if not m or not m.get("trainedAt"):
        return None
    from datetime import datetime
    try:
        return (time.time() - datetime.fromisoformat(m["trainedAt"]).timestamp()) / 3600
    except ValueError:
        return None


def main():
    for st in (sys.stdout, sys.stderr):  # 콘솔 인코딩(cp949 등)에 없는 글자(−)로 멈추지 않게
        try:
            st.reconfigure(errors="replace")
        except (AttributeError, ValueError):
            pass
    ap = argparse.ArgumentParser()
    ap.add_argument("--train", action="store_true", help="긴 이력 갱신 → 검증·학습 (numpy·lightgbm 필요)")
    ap.add_argument("--check-train", action="store_true", help="학습할 차례면 train=1")
    ap.add_argument("--if-stale", type=float, default=0, help="모델이 이 시간보다 새것이면 학습 건너뜀")
    ap.add_argument("--deadline", type=float, default=0, help="이력 받기 제한(분)")
    ap.add_argument("--no-ai", action="store_true", help="결론 문장을 규칙으로만")
    ap.add_argument("--fixture", help="브라우저 1시간 계산 시험용 파일을 이 경로에 (web/src/components/btc/h1.fixture.json)")
    args = ap.parse_args()
    if args.fixture:
        return make_fixture(args.fixture)
    age = model_age_h()
    due = age is None or not args.if_stale or age >= args.if_stale
    if args.check_train:
        print(f"train={1 if due else 0}")
        return 0
    if args.train:
        if not due:
            log(f"모델이 {age:.1f}시간 전 것이라 학습 건너뜀")
            return 0
        try:
            from btc import train
        except ImportError as e:
            log(f"학습에 필요한 패키지가 없어요: {e}")
            return 1
        dl = time.time() + args.deadline * 60 if args.deadline else None
        ok = train.train(deadline=dl)
        return 0 if ok else 1
    return run(use_ai=not args.no_ai)


if __name__ == "__main__":
    sys.exit(main())
