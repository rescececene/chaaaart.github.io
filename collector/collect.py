"""GitHub Actions 에서 10분마다 실행 — 스크리너·뉴스·시세 목록을 web/public/data/*.json 으로 저장

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
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path

import coin_social
import indicators
import news_ai
import news_hist
import setups
import sources
import stock_ai

OUT = Path(__file__).resolve().parent.parent / "web" / "public" / "data"  # React 사이트(web/)가 그대로 서빙·빌드
KST = timezone(timedelta(hours=9))
SCAN_N = {"upbit": 200, "binance": 260, "krx": 260, "us": 260}  # 종목당 일봉 개수
BINANCE_TOP = 120  # 바이낸스는 거래대금 상위만
BRIEFS = []  # 종목 AI 해설용 요약 (시장마다 거래대금·시가총액 순으로 쌓인다)
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
    """web/src/lib/market/candles.ts 의 정적 일봉 경로와 같은 규칙"""
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
        try:  # 전략 탭(분출 임박·돌파·눌림목…) 판정 — 실패해도 종목은 그대로 싣는다
            st = setups.detect(cs, market)
        except Exception as e:
            st = []
            print(f"  [{market}] {q['sym']} 전략 탭 실패: {e}")
        if len(out) < stock_ai.TOP_N.get(market, 0):
            try:
                BRIEFS.append(stock_ai.brief(q["sym"], q["name"], market, q.get("price"), q.get("chg") if q.get("chg") is not None else a["chg"], a))
            except Exception as e:
                print(f"  [{market}] {q['sym']} 해설 요약 실패: {e}")
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
                    "op": a["opinion"]["label"], "score": a["opinion"]["score"], "setups": st})
    print(f"[{market}] {len(out)}종목 계산 / 실패 {fails} / {time.time() - t0:.0f}초")
    return {"market": market, "updatedAt": now_iso(), "count": len(out), "fails": fails, "rows": out}


WORLD_NEWS_URL = "https://api.stock.naver.com/news/worldNews?pageSize=50&page=1"


def world_news():
    """해외 증시 속보 — 네이버 증권이 제공하는 로이터 등 번역 기사. 제목·짧은 요약·원문(네이버) 링크만 담는다."""
    items = []
    for x in json.loads(sources.http_get(WORLD_NEWS_URL)):
        title = (x.get("tit") or "").strip()
        if not title:
            continue
        try:
            ts = int(datetime.strptime(x["dt"][:14], "%Y%m%d%H%M%S").replace(tzinfo=KST).timestamp())
        except Exception:
            ts = None
        summary = re.sub(r"\s+", " ", x.get("subcontent") or "").strip()
        # 네이버가 붙여 주는 관련 종목 (지수 '.SOX' 같은 것은 뺀다)
        rel = [{"sym": "us:" + r["reutersCode"], "name": r.get("itemName") or r["reutersCode"]}
               for r in (x.get("relatedItems") or []) if r.get("reutersCode") and not r["reutersCode"].startswith(".")]
        items.append({"id": f"{x.get('oid', '')}-{x.get('aid', '')}", "title": title, "src": (x.get("ohnm") or "").strip(), "ts": ts,
                      "summary": summary[:160], "rel": rel[:4],
                      "url": "https://m.stock.naver.com/news/read?" + urllib.parse.urlencode({"oid": x.get("oid", ""), "aid": x.get("aid", "")})})
    return items


COINNESS = {  # (키, 표시 이름, API 경로, 글 주소)
    "coinflash": ("코인 속보", "/feed/v3/breaking-news", "https://coinness.com/news/{id}"),
    "stockflash": ("주식 속보", "/feed/v1/stock-breaking-news", "https://coinness.com/stock-news/{id}"),
}


def coinness_news(path, link):
    """코인니스 속보 — 제목·짧은 미리보기·원문 링크와 호재/악재 투표 수만 담는다 (본문 전체를 다시 싣지 않는다)"""
    items = []
    for x in json.loads(sources.http_get("https://api.coinness.com" + path + "?languageCode=ko&limit=40")):
        title = (x.get("title") or "").strip()
        if not title:
            continue
        try:
            ts = int(datetime.fromisoformat(x["publishAt"].replace("Z", "+00:00")).timestamp())
        except Exception:
            ts = None
        body = re.sub(r"\s+", " ", x.get("content") or "").strip()
        items.append({"id": str(x.get("id")), "title": title, "src": "코인니스", "ts": ts, "summary": body[:110] + ("…" if len(body) > 110 else ""),
                      "url": link.format(id=x.get("id")), "bull": x.get("bullCount"), "bear": x.get("bearCount"),
                      "important": bool(x.get("isImportant")), "codes": [c for c in (x.get("originCodes") or []) if c][:4]})
    return items


def news():
    topics = []
    try:
        topics.append({"key": "world", "label": "해외 속보", "items": world_news()})
    except Exception as e:
        print(f"[뉴스] 해외 속보 실패: {e}")
    for key, (label, path, link) in COINNESS.items():
        try:
            topics.append({"key": key, "label": label, "items": coinness_news(path, link)})
        except Exception as e:
            print(f"[뉴스] {label} 실패: {e}")
    try:  # 거래소 공지(업비트·빗썸·바이낸스) · 코인 공식 텔레그램 — coin_social.py (30초 안팎, 상태는 data/coin_social.json)
        topics += coin_social.topics(OUT)
    except Exception as e:
        print(f"[뉴스] 거래소 공지·코인 SNS 실패: {e}")
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
            link = (it.findtext("link") or "").strip()
            if not link.startswith(("https://", "http://")):  # 링크는 http(s) 만 (사이트에서 누를 수 있으므로)
                continue
            items.append({"title": title, "src": src, "url": link, "ts": ts})
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
        topics = news()
        write("news.json", {"updatedAt": now_iso(), "topics": topics})
        try:  # 속보 호재·악재 AI 판단 (Cloudflare Workers AI · 비밀값이 없으면 건너뜀)
            news_ai.run(topics, OUT / "news_ai.json")
        except Exception:
            traceback.print_exc()
    for t in threads:
        t.join()
    if not args.no_news:
        try:  # 코인별 뉴스 이력 누적 + 사이트용 최근 뉴스 상태 (news_hist.json · news_state.json) — 일봉 파일을 다 쓴 뒤라야 신규 상장 판단이 된다
            news_hist.run(topics, OUT)
        except Exception:
            traceback.print_exc()
    try:  # 시장별 주요 종목 AI 해설 (하루 2번 정도 · 비밀값이 없으면 건너뜀)
        stock_ai.run(BRIEFS, OUT / "stock_ai.json")
    except Exception:
        traceback.print_exc()

    try:  # 추천 모음 — 예측 엔진 결과 + 방금 만든 스크리너·뉴스 상태로 다시 거르기 (1초 미만, 표준 라이브러리)
        import recommend
        recommend.run(OUT)
    except Exception:
        traceback.print_exc()
    write("meta.json", {"updatedAt": now_iso(), "secs": round(time.time() - t0), "errors": errors})
    print(f"완료 {time.time() - t0:.0f}초" + (f" / 오류: {errors}" if errors else ""))


if __name__ == "__main__":
    main()
