"""JS 지표(site/js/indicators.js)가 Python(collector/indicators.py)과 같은 값을 내는지 확인할 기준 데이터 생성

    py tools/make_fixture.py  →  tools/fixture.json   (그다음 tools/test_indicators.html 을 브라우저로 열기)
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "collector"))
import indicators  # noqa: E402
import sources  # noqa: E402

SYMS = ["upbit:KRW-BTC", "upbit:KRW-XRP", "upbit:KRW-DOGE", "binance:ETHUSDT", "binance:SOLUSDT",
        "krx:005930", "krx:000660", "krx:035720", "us:NVDA.O", "us:AAPL.O", "us:TSLA.O"]
N = {"upbit": 200, "binance": 260, "krx": 260, "us": 260}

cases = []
for sym in SYMS:
    cs = sources.daily(sym, N[sym.split(":")[0]])
    a = indicators.analyze(cs)
    ind = indicators.series(cs)
    cases.append({"sym": sym, "candles": cs, "expect": {
        "signals": a["signals"], "opinion": a["opinion"], "rsi": a["rsi"], "macd": a["macd"],
        "volRatio": a["volRatio"], "ma": a["ma"],
        "series": {k: v[-60:] for k, v in ind.items()}}})
    print(sym, len(cs), a["signals"], a["opinion"]["label"])
(ROOT / "tools" / "fixture.json").write_text(json.dumps(cases), encoding="utf-8")
