"""시장 데이터 수집 — 업비트 / 바이낸스 / 국내주식 / 미국주식 (GitHub Actions 에서 실행)

종목은 "시장:코드" 문자열 하나로 다룬다.
    upbit:KRW-BTC    binance:BTCUSDT    krx:005930    us:AAPL.O (네이버 reutersCode)

캔들은 오래된 것부터 [{"t","o","h","l","c","v"}] 이고, t 는 '현지 날짜 0시를 UTC 로 적은' 초다.
(브라우저 쪽 js/data.js 와 같은 규칙 — 차트가 UTC 로 그려도 거래일 날짜가 그대로 보인다)
"""
import json
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36"
KST = timezone(timedelta(hours=9))
MARKETS = ("upbit", "binance", "krx", "us")

# 호스트별 최소 호출 간격(초). 업비트 시세 API 는 초당 10회 제한이 있다.
MIN_GAP = {"api.upbit.com": 0.11, "api.binance.com": 0.05, "data-api.binance.vision": 0.05}
_next_slot = {}
_slot_lock = threading.Lock()


def _throttle(host):
    gap = MIN_GAP.get(host, 0.07)
    with _slot_lock:
        now = time.monotonic()
        slot = max(now, _next_slot.get(host, 0.0))
        _next_slot[host] = slot + gap
    if slot > now:
        time.sleep(slot - now)


def http_get(url, timeout=15, retries=2, accept="application/json"):
    host = urllib.parse.urlsplit(url).hostname
    for attempt in range(retries + 1):
        _throttle(host)
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": accept})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read().decode("utf-8")
        except urllib.error.HTTPError as e:
            if e.code in (429, 500, 502, 503, 504) and attempt < retries:
                time.sleep(1.5 * (attempt + 1))
                continue
            raise
        except (urllib.error.URLError, TimeoutError, ConnectionError):
            if attempt < retries:
                time.sleep(1 + attempt)
                continue
            raise


def http_json(url, **kw):
    return json.loads(http_get(url, **kw))


def _num(s):
    if s is None:
        return None
    if isinstance(s, (int, float)):
        return float(s)
    try:
        return float(str(s).replace(",", "").strip())
    except ValueError:
        return None


def _date_ts(yyyymmdd):
    return int(datetime.strptime(yyyymmdd[:8], "%Y%m%d").replace(tzinfo=timezone.utc).timestamp())


def _dedupe(candles):
    by_t = {c["t"]: c for c in candles}
    return [by_t[t] for t in sorted(by_t)]


# ── 업비트 ───────────────────────────────────────────────
def upbit_markets():
    """{KRW-BTC: {"name","en","warn"}}"""
    out = {}
    for m in http_json("https://api.upbit.com/v1/market/all?isDetails=true"):
        if m["market"].startswith("KRW-"):
            ev = m.get("market_event") or {}
            out[m["market"]] = {"name": m["korean_name"], "en": m["english_name"], "warn": bool(ev.get("warning"))}
    return out


def upbit_snapshot(markets):
    codes = list(markets)
    rows = {}
    for i in range(0, len(codes), 100):
        for t in http_json("https://api.upbit.com/v1/ticker?markets=" + ",".join(codes[i:i + 100])):
            code = t["market"]
            base = code.split("-", 1)[1]
            m = markets.get(code, {})
            rows["upbit:" + code] = {"sym": "upbit:" + code, "name": m.get("name", base), "sub": base,
                                     "price": t["trade_price"], "chg": t["signed_change_rate"] * 100,
                                     "vol": t["acc_trade_price_24h"]}
    return rows


def upbit_daily(code, n):
    raw, to = [], None
    while len(raw) < n:
        cnt = min(200, n - len(raw))  # 한 번에 최대 200개
        url = f"https://api.upbit.com/v1/candles/days?market={code}&count={cnt}"
        if to:
            url += "&to=" + urllib.parse.quote(to)
        page = http_json(url)
        raw += page
        if len(page) < cnt:
            break
        to = page[-1]["candle_date_time_utc"].replace("T", " ")
    return _dedupe([{"t": _date_ts(d["candle_date_time_kst"][:10].replace("-", "")),
                     "o": d["opening_price"], "h": d["high_price"], "l": d["low_price"],
                     "c": d["trade_price"], "v": d["candle_acc_trade_volume"]} for d in raw])


# ── 바이낸스 ─────────────────────────────────────────────
# GitHub Actions 서버(미국)에서는 api.binance.com 이 막혀 있어 시세 전용 미러로 넘어간다.
BINANCE_HOSTS = ["https://api.binance.com", "https://data-api.binance.vision"]
STABLE = {"USDC", "FDUSD", "TUSD", "BUSD", "DAI", "USDP", "USDE", "USD1", "EUR", "AEUR", "EURI",
          "XUSD", "BFUSD", "PYUSD", "RLUSD", "USDS", "UST", "USTC"}


def _binance(path):
    last = None
    for host in list(BINANCE_HOSTS):
        try:
            return http_json(host + path)
        except urllib.error.HTTPError as e:
            if e.code not in (403, 451):
                raise
            last = e
            if BINANCE_HOSTS[0] == host and len(BINANCE_HOSTS) > 1:
                BINANCE_HOSTS.remove(host)  # 다음부터는 바로 미러로
    raise last


def binance_snapshot(names):
    now_ms = time.time() * 1000
    rows = {}
    for t in _binance("/api/v3/ticker/24hr"):
        s = t["symbol"]
        if not s.endswith("USDT"):
            continue
        base = s[:-4]
        qv = float(t["quoteVolume"])
        if base in STABLE or qv <= 0 or now_ms - t["closeTime"] > 86_400_000:
            continue
        rows["binance:" + s] = {"sym": "binance:" + s, "name": names.get(base) or base, "sub": base + "/USDT",
                                "price": float(t["lastPrice"]), "chg": float(t["priceChangePercent"]), "vol": qv}
    return rows


def binance_daily(code, n):
    data = _binance(f"/api/v3/klines?symbol={urllib.parse.quote(code)}&interval=1d&limit={min(n, 1000)}")
    return [{"t": k[0] // 1000, "o": float(k[1]), "h": float(k[2]), "l": float(k[3]),
             "c": float(k[4]), "v": float(k[5])} for k in data]


# ── 국내·미국 주식 (네이버 증권) ─────────────────────────
def _naver_chg(d):
    raw = d.get("fluctuationsRatioRaw")
    v = _num(raw if raw is not None else d.get("fluctuationsRatio")) or 0.0
    code = (d.get("compareToPreviousPrice") or {}).get("code")
    if code in ("4", "5") and v > 0:  # 하한가·하락인데 부호가 빠진 경우
        v = -v
    return v


KRX_LISTS = (("KOSPI", 2), ("KOSDAQ", 2))  # (시장, 100종목 페이지 수) — 시총 상위
US_LISTS = (("NASDAQ", 2), ("NYSE", 1))


def krx_snapshot():
    rows = {}
    for cat, pages in KRX_LISTS:
        for p in range(1, pages + 1):
            d = http_json(f"https://m.stock.naver.com/api/stocks/marketValue/{cat}?page={p}&pageSize=100")
            for s in d.get("stocks", []):
                if s.get("stockEndType") not in (None, "stock"):
                    continue
                sym = "krx:" + s["itemCode"]
                rows[sym] = {"sym": sym, "name": s["stockName"], "sub": s["itemCode"], "ex": cat,
                             "price": _num(s.get("closePriceRaw") or s.get("closePrice")), "chg": _naver_chg(s),
                             "vol": _num(s.get("accumulatedTradingValueRaw")), "cap": _num(s.get("marketValueRaw"))}
    return rows


def us_snapshot():
    rows = {}
    for ex, pages in US_LISTS:
        for p in range(1, pages + 1):
            d = http_json(f"https://api.stock.naver.com/stock/exchange/{ex}/marketValue?page={p}&pageSize=100")
            for s in d.get("stocks", []):
                sym = "us:" + s["reutersCode"]
                rows[sym] = {"sym": sym, "name": s["stockName"], "sub": s["symbolCode"], "ex": ex,
                             "price": _num(s.get("closePriceRaw")), "chg": _naver_chg(s),
                             "vol": _num(s.get("accumulatedTradingValueRaw")), "cap": _num(s.get("marketValueRaw"))}
    return rows


def naver_daily(market, code, n):
    kind = "domestic" if market == "krx" else "foreign"
    now = datetime.now(KST)
    start = (now - timedelta(days=int(n * 1.5) + 10)).strftime("%Y%m%d") + "0000"
    end = (now + timedelta(days=1)).strftime("%Y%m%d") + "0000"
    d = http_json(f"https://api.stock.naver.com/chart/{kind}/item/{code}/day?startDateTime={start}&endDateTime={end}")
    out = []
    for x in d:
        c = x["closePrice"]
        out.append({"t": _date_ts(x["localDate"]), "o": x["openPrice"] or c, "h": x["highPrice"] or c,
                    "l": x["lowPrice"] or c, "c": c, "v": x.get("accumulatedTradingVolume") or 0})
    return _dedupe(out)[-n:]


def daily(sym, n):
    market, _, code = sym.partition(":")
    if market == "upbit":
        return upbit_daily(code, n)
    if market == "binance":
        return binance_daily(code, n)
    return naver_daily(market, code, n)


# ── 지수·환율 (네이버) ───────────────────────────────────
def overview():
    out = []
    try:
        d = http_json("https://api.stock.naver.com/marketindex/exchange/FX_USDKRW")["exchangeInfo"]
        chg = _num(d.get("fluctuationsRatio")) or 0.0
        if (d.get("fluctuationsType") or {}).get("code") in ("4", "5") and chg > 0:
            chg = -chg
        out.append({"id": "USDKRW", "label": "USD/KRW", "price": _num(d.get("calcPrice") or d.get("closePrice")), "chg": chg})
    except Exception as e:
        print(f"[환율] 실패: {e}")
    for kind, codes in (("domestic", "KOSPI,KOSDAQ"), ("worldstock", ".IXIC,.INX,.DJI")):
        try:
            for s in http_json(f"https://polling.finance.naver.com/api/realtime/{kind}/index/{codes}")["datas"]:
                out.append({"id": s.get("itemCode") or s.get("reutersCode"), "label": s.get("stockName") or s.get("indexName"),
                            "price": _num(s.get("closePriceRaw")), "chg": _naver_chg(s), "status": s.get("marketStatus")})
        except Exception as e:
            print(f"[지수] {kind} 실패: {e}")
    return out
