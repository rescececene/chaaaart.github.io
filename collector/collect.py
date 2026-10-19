"""GitHub Actions 에서 10분마다 실행 — 스크리너·뉴스·시세 목록을 site/data/*.json 으로 저장

    python collector/collect.py                       # 전체
    python collector/collect.py --only upbit,krx      # 일부 시장만
    python collector/collect.py --limit 20            # 시장별 종목 수 제한 (빠른 테스트)

실시간 시세는 브라우저가 직접(코인) 또는 Cloudflare Worker 를 거쳐(주식) 받는다.
여기서 만드는 건 '전 종목 일봉 지표'처럼 브라우저가 매번 계산하기엔 무거운 것들이다.
"""
import argparse
import json
import math
import re
import threading
import time
import traceback
import urllib.parse
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path

import indicators
import sources

OUT = Path(__file__).resolve().parent.parent / "site" / "data"
SCAN_N = {"upbit": 200, "binance": 260, "krx": 260, "us": 260}  # 종목당 일봉 개수
BINANCE_TOP = 120  # 바이낸스는 거래대금 상위만
NEWS_TOPICS = [  # (키, 표시 이름, 구글 뉴스 검색어)
    ("us", "미국 증시", "뉴욕증시 OR 나스닥 OR 미국 증시"),
    ("krx", "국내 증시", "코스피 OR 코스닥"),
    ("coin", "코인", "비트코인 OR 가상자산 OR 이더리움"),
    ("macro", "환율·금리", "환율 OR 금리 OR 연준"),
]


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def rnd(x, sig=7):
    """JSON 크기를 줄이려고 유효숫자 7자리로. NaN/inf 는 null"""
    if x is None:
        return None
    if not math.isfinite(x):
        return None
    return float(f"{x:.{sig}g}")


def write(name, obj):
    path = OUT / name
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(obj, ensure_ascii=False, separators=(",", ":"), allow_nan=False), encoding="utf-8")
    tmp.replace(path)


def candle_path(sym):
    """site/js/data.js 의 staticCandles() 와 같은 규칙"""
    market, _, code = sym.partition(":")
    return f"candles/{market}/{re.sub(r'[^A-Za-z0-9._-]', '_', code)}.json"


def write_candles(sym, cs):
    """일봉을 파일로 남겨 둔다 — 업비트가 브라우저 요청을 막거나 중계(Worker)가 없을 때 차트용"""
    write(candle_path(sym), {"c": [[c["t"], rnd(c["o"], 10), rnd(c["h"], 10), rnd(c["l"], 10), rnd(c["c"], 10), rnd(c["v"], 6)] for c in cs]})


def scan(market, snap, limit):
    rows = sorted(snap.values(), key=lambda q: -((q.get("cap") or q.get("vol")) or 0))
    if market == "binance":
        rows = rows[:BINANCE_TOP]
    if market == "upbit":  # 원화로 사는 달러 코인은 지표가 의미 없다
        rows = [q for q in rows if q["sub"] not in sources.STABLE | {"USDT"}]
    if limit:
        rows = rows[:limit]
    out, fails, t0 = [], 0, time.time()
    for q in rows:
        try:
            cs = sources.daily(q["sym"], SCAN_N[market])
            a = indicators.analyze(cs)
            if market != "binance":  # 바이낸스는 브라우저가 직접 받을 수 있다
                write_candles(q["sym"], cs)
        except Exception as e:
            fails += 1
            if fails <= 3:
                print(f"  [{market}] {q['sym']} 실패: {e}")
            continue
        if not a:
            continue
        # 급등/급락은 일봉 종가 대신 목록 시세의 등락률 기준 (업비트는 09시, 바이낸스는 24시간 기준)
        sig = [s for s in a["signals"] if s not in ("surge", "plunge")]
        chg = q["chg"] if q.get("chg") is not None else a["chg"]
        if chg >= indicators.SURGE:
            sig.insert(0, "surge")
        elif chg <= -indicators.SURGE:
            sig.insert(0, "plunge")
        out.append({"sym": q["sym"], "name": q["name"], "sub": q["sub"], "ex": q.get("ex"),
                    "price": rnd(q["price"]), "chg": rnd(chg, 4), "vol": rnd(q.get("vol"), 4), "cap": rnd(q.get("cap"), 4),
                    "rsi": rnd(a["rsi"], 4), "volRatio": rnd(a["volRatio"], 3), "sig": sig,
                    "op": a["opinion"]["label"], "score": a["opinion"]["score"]})
    print(f"[{market}] {len(out)}종목 계산 / 실패 {fails} / {time.time() - t0:.0f}초")
    return {"market": market, "updatedAt": now_iso(), "count": len(out), "fails": fails, "rows": out}


def news():
    topics = []
    for key, label, q in NEWS_TOPICS:
        url = "https://news.google.com/rss/search?" + urllib.parse.urlencode(
            {"q": q + " when:1d", "hl": "ko", "gl": "KR", "ceid": "KR:ko"})
        try:
            root = ET.fromstring(sources.http_get(url, accept="application/rss+xml,*/*"))
        except Exception as e:
            print(f"[뉴스] {label} 실패: {e}")
            continue
        items, seen = [], set()
        for it in root.iter("item"):
            title = (it.findtext("title") or "").strip()
            src = (it.findtext("source") or "").strip()
            if src and title.endswith(" - " + src):
                title = title[: -len(src) - 3]
            if not title or title in seen:
                continue
            seen.add(title)
            try:
                ts = int(parsedate_to_datetime(it.findtext("pubDate")).timestamp())
            except Exception:
                ts = None
            items.append({"title": title, "src": src, "url": it.findtext("link"), "ts": ts})
        items.sort(key=lambda x: -(x["ts"] or 0))
        topics.append({"key": key, "label": label, "items": items[:40]})
    return topics


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", default=",".join(sources.MARKETS))
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--no-news", action="store_true")
    args = ap.parse_args()
    only = [m for m in args.only.split(",") if m in sources.MARKETS]
    t0 = time.time()
    errors = {}

    # 1) 종목 목록·현재 시세
    markets = sources.upbit_markets()
    names = {code[4:]: m["name"] for code, m in markets.items()}
    loaders = {"upbit": lambda: sources.upbit_snapshot(markets), "binance": lambda: sources.binance_snapshot(names),
               "krx": sources.krx_snapshot, "us": sources.us_snapshot}
    snaps = {}
    for m in only:
        try:
            snaps[m] = loaders[m]()
        except Exception as e:
            errors[m] = f"목록 실패: {e}"
            print(f"[{m}] 목록 실패: {e}")
    # 코인 이름표 + 바이낸스 거래대금 상위 목록 (브라우저가 이 목록만 실시간 구독한다)
    coins = {"updatedAt": now_iso(), "upbit": {c: [m["name"], m["en"], int(m["warn"])] for c, m in markets.items()}}
    if "binance" in snaps:
        top = sorted(snaps["binance"].values(), key=lambda q: -q["vol"])[:150]
        coins["binance"] = [q["sym"].split(":")[1] for q in top]
    elif (OUT / "coins.json").exists():  # 바이낸스가 막혔으면 이전 목록 유지
        coins["binance"] = json.loads((OUT / "coins.json").read_text(encoding="utf-8")).get("binance", [])
    write("coins.json", coins)
    for m in ("krx", "us"):  # 주식 목록은 Worker 없이 열었을 때의 대체 시세·검색용
        if m in snaps:
            write(f"{m}.json", {"updatedAt": now_iso(), "rows": [
                {k: (rnd(v) if isinstance(v, float) else v) for k, v in r.items()} for r in snaps[m].values()]})
    write("overview.json", {"updatedAt": now_iso(), "items": sources.overview()})

    # 2) 스크리너 — 시장마다 서버가 달라 병렬로 돌려도 각자 호출 간격을 지킨다
    def run(m):
        try:
            write(f"screener/{m}.json", scan(m, snaps[m], args.limit))
        except Exception as e:
            errors[m] = f"스크리너 실패: {e}"
            traceback.print_exc()
    threads = [threading.Thread(target=run, args=(m,)) for m in snaps]
    for t in threads:
        t.start()
    if not args.no_news:
        write("news.json", {"updatedAt": now_iso(), "topics": news()})
    for t in threads:
        t.join()

    write("meta.json", {"updatedAt": now_iso(), "secs": round(time.time() - t0), "errors": errors})
    print(f"완료 {time.time() - t0:.0f}초" + (f" / 오류: {errors}" if errors else ""))


if __name__ == "__main__":
    main()
