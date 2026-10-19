"""TS 지표(web/src/lib/indicators.ts)가 Python(collector/indicators.py)과 같은 값을 내는지 확인할 기준 데이터 생성

    py -3 tools/make_fixture.py           →  실제 일봉을 새로 받아 tools/fixture.json 생성
    py -3 tools/make_fixture.py --reuse   →  fixture.json 의 실제 캔들은 그대로 두고 기대값만 다시 계산 (인터넷 불필요)
    그다음: cd web; npx vitest run src/lib/indicators.test.ts

실제 종목 외에 경계 상황용 가짜 캔들(synthetic:*)도 함께 넣는다 — 값이 전혀 안 변하는 종목, 데이터가 짧은 종목,
거래량 0 인 봉, 고가=저가인 봉, 정수 가격(국내 주식처럼) 등.
"""
import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "collector"))
import indicators  # noqa: E402

FIXTURE = ROOT / "tools" / "fixture.json"
SYMS = ["upbit:KRW-BTC", "upbit:KRW-XRP", "upbit:KRW-DOGE", "binance:ETHUSDT", "binance:SOLUSDT",
        "krx:005930", "krx:000660", "krx:035720", "us:NVDA.O", "us:AAPL.O", "us:TSLA.O"]
N = {"upbit": 200, "binance": 260, "krx": 260, "us": 260}
# analyze() 가 돌려주는 새 지표 값 — vitest 가 하나씩 비교한다
EXTRA = ("stochK", "stochD", "willr", "cci", "adx", "pdi", "mdi", "atr", "atrPct", "obv", "obvMa", "mfi", "roc",
         "ichiConv", "ichiBase", "ichiA", "ichiB", "sar", "sarDir", "disparity")


def lcg(seed):
    """언제나 같은 수열을 내는 간단한 난수 (0 이상 1 미만)"""
    x = seed
    while True:
        x = (1103515245 * x + 12345) % 2 ** 31
        yield x / 2 ** 31


def walk(name, n, start, drift, vol, seed, digits=2, zero_vol_every=0, flat_bar_every=0):
    rnd = lcg(seed)
    t0 = 1_700_000_000 - 1_700_000_000 % 86400
    cs, p = [], start
    for i in range(n):
        o = p
        c = max(0.01, o * (1 + drift + vol * (next(rnd) - 0.5)))
        hi = max(o, c) * (1 + vol * 0.5 * next(rnd))
        lo = min(o, c) * (1 - vol * 0.5 * next(rnd))
        vv = 1000 * (0.3 + next(rnd))
        if zero_vol_every and i % zero_vol_every == 0:
            vv = 0
        if flat_bar_every and i % flat_bar_every == 0:
            hi = lo = o = c
        r = (lambda x: int(round(x))) if digits == 0 else (lambda x: round(x, digits))
        cs.append({"t": t0 + i * 86400, "o": r(o), "h": r(hi), "l": r(lo), "c": r(c), "v": round(vv, 4)})
        p = c
    return {"sym": f"synthetic:{name}", "candles": cs}


def synthetic():
    t0 = 1_700_000_000 - 1_700_000_000 % 86400
    flat = [{"t": t0 + i * 86400, "o": 100.0, "h": 100.0, "l": 100.0, "c": 100.0, "v": 500.0} for i in range(80)]
    tiny = [{"t": t0 + i * 86400, "o": 0.1, "h": 0.1, "l": 0.1, "c": 0.1, "v": 0.0} for i in range(60)]
    return [
        {"sym": "synthetic:flat", "candles": flat},
        {"sym": "synthetic:flat-frac-novol", "candles": tiny},
        walk("short", 35, 50.0, 0.0, 0.04, 7),
        walk("uptrend", 220, 1000.0, 0.004, 0.02, 11),
        walk("downtrend-zero-vol", 220, 5000.0, -0.004, 0.03, 23, zero_vol_every=7),
        walk("choppy-int-flatbars", 150, 70000.0, 0.0, 0.05, 42, digits=0, flat_bar_every=11),
    ]


def expect(cs):
    a = indicators.analyze(cs)
    ind = indicators.series(cs)
    e = {"signals": a["signals"], "opinion": a["opinion"], "votes": a["votes"], "rsi": a["rsi"], "macd": a["macd"],
         "volRatio": a["volRatio"], "ma": a["ma"], "series": {k: v[-60:] for k, v in ind.items()}}
    e.update({k: a[k] for k in EXTRA})
    return e


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--reuse", action="store_true", help="fixture.json 의 실제 캔들을 그대로 쓰고 기대값만 다시 계산")
    args = ap.parse_args()
    if args.reuse:
        real = [{"sym": x["sym"], "candles": x["candles"]} for x in json.loads(FIXTURE.read_text(encoding="utf-8"))
                if not x["sym"].startswith("synthetic:")]
    else:
        import sources  # 인터넷이 필요할 때만
        real = [{"sym": sym, "candles": sources.daily(sym, N[sym.split(":")[0]])} for sym in SYMS]
    cases = []
    for x in real + synthetic():
        x["expect"] = expect(x["candles"])
        cases.append(x)
        op = x["expect"]["opinion"]
        print(f'{x["sym"]:<34} {len(x["candles"]):>4}봉  {op["label"]:<5} {op["score"]:+.3f}  '
              f'매수 {op["buy"]} · 중립 {op["neutral"]} · 매도 {op["sell"]}  {x["expect"]["signals"]}')
    # NaN·Infinity 가 끼면 JSON.parse 가 실패하므로 여기서 바로 잡는다
    FIXTURE.write_text(json.dumps(cases, allow_nan=False), encoding="utf-8")


if __name__ == "__main__":
    main()
