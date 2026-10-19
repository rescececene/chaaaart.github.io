"""추천 모음 — web/public/data/recommend.json (collect.py 안에서 10분마다, 표준 라이브러리만, 1초 안팎)

    python collector/recommend.py            # 지금 파일들로 다시 계산
    python collector/recommend.py --print    # 결과를 화면에도

무거운 학습은 하지 않는다. 하루 1번 도는 예측 엔진(collector/model) 결과 + 10분마다 갱신되는 스크리너(최신 가격·전략 판정)
+ 뉴스 상태를 합쳐, 같은 규칙으로 다시 거르고 순서를 정한다.

규칙 (collector/model/recrule.py 가 과거 각 날짜에 똑같이 적용해 검증한다)
  1. 검증 등급이 strong/weak 인 시장만. none 이면 그 묶음은 비우고 이유를 notes 에.
  2. 그 시장 오늘 점수 상위 10% 안(엔진 picks 의 pctRank ≥ 90)에서
  3. 뺀다: 과열 주의·하락 경고(최신 스크리너 판정), 거래대금 하위 30%, 상장 30일 미만(업비트 일봉 수·신규 상장 소식),
     업비트 투자유의, 상폐·해킹 소식, 스테이블코인, 바이낸스 주식·ETF 토큰,
     엔진 기준 종가보다 지금 가격이 ATR 2배 넘게 움직인 종목(이미 급등/급락 — 예측 당시와 자리가 달라짐)
  4. 국면 필터(엔진 백테스트가 고른 경우만): 시장 20일 수익률 < 0 이면 60일 변동성 하위 절반만
  5. '시장 이길 확률' 순 최대 5개. 모자라면 억지로 채우지 않는다. 코인은 업비트·바이낸스를 합치고 같은 코인은 하나만.
"""
import json
import math
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "web" / "public" / "data"
N_PICK = 5
TOP_PCT_RANK = 90.0   # pctRank(0~100) — 점수 상위 10%
LIQ_MIN_PCT = 0.3
MIN_AGE = 30
MOVE_ATR = 2.0
STALE_DAYS = {"upbit": 3, "binance": 3, "krx": 5, "us": 5}
GROUPS = (("coin", "코인", ("upbit", "binance")), ("krx", "국내주식", ("krx",)), ("us", "미국주식", ("us",)))
MKT_KO = {"upbit": "업비트", "binance": "바이낸스", "krx": "국내", "us": "미국"}
GRADE_KO = {"strong": "검증 강함", "weak": "검증 약함", "none": "판단 보류"}
STABLE = {"USDT", "USDC", "FDUSD", "TUSD", "BUSD", "DAI", "USDP", "USDE", "USD1", "EUR", "AEUR", "EURI", "XUSD",
          "BFUSD", "PYUSD", "RLUSD", "USDS", "UST", "USTC", "U", "EURC", "USDG", "JPYC", "GUSD", "FRAX", "USDD",
          "LUSD", "AUSD", "USD0", "USDQ", "EURQ", "USDF", "KRWQ"}
# 바이낸스 주식·ETF 토큰 (예: NVDAB, TSLAB, QQQB)
ETF_BASE = {"SOXL", "SOXS", "TQQQ", "SQQQ", "QQQ", "SPY", "EWY", "KORU", "DRAM", "SNXX", "IWM", "GLD", "SLV", "TLT"}
NOT_TOKEN = {"BNB", "ARB", "SHIB", "BOB", "FLOKI", "BB", "SAB", "ORB", "KUB", "DRB", "TRB", "JUB", "RUB", "LAB", "PUB"}


def is_stock_token(market, code, name, us_bases=None):
    if market != "binance" or not code.endswith("USDT"):
        return False
    base = code[:-4].split("#")[0]
    if base in NOT_TOKEN or not base.endswith("B") or len(base) < 3:
        return False
    core = base[:-1]
    if core in ETF_BASE or (us_bases and core in us_bases):
        return True
    return bool(name) and name == base and len(base) >= 4


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _read(path):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def _num(x):
    return x if isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x) else None


def _r(x, nd=4):
    return None if _num(x) is None else round(float(x), nd)


def base_of(market, sub, code):
    if market == "upbit":
        return code.split("-", 1)[-1]
    if market == "binance":
        return (sub or code).split("/")[0] if sub else code[:-4]
    return code


def _pct(x, d=1):
    return f"{x * 100:+.{d}f}%"


def _upbit_bars(code):
    """업비트 일봉 파일(최근 200봉)의 봉 수 — 30 미만이면 신규 상장"""
    d = _read(OUT / "candles" / "upbit" / (re.sub(r"[^A-Za-z0-9._-]", "_", code) + ".json"))
    return len((d or {}).get("c") or []) if d else None


def _bt_brief(bt):
    if not bt or not bt.get("all"):
        return None
    keep = ("ex", "exMed", "exAfterCost", "win", "mdd", "uniMdd", "growth", "uniGrowth", "periods", "avgPicks", "empty",
            "downEx", "upEx", "t")
    return {"h": bt.get("h"), "from": bt.get("from"), "to": bt.get("to"), "holdFrom": bt.get("holdFrom"),
            "rule": bt.get("rule"), "desc": bt.get("desc"),
            "all": {k: _r(bt["all"].get(k), 5) for k in keep},
            "hold": {k: _r((bt.get("hold") or {}).get(k), 5) for k in keep} if bt.get("hold") else None}


def _bt_note(market, h, bt):
    a, ho = bt.get("all") or {}, bt.get("hold") or {}
    if a.get("ex") is None:
        return None
    u = "일" if market in ("upbit", "binance") else "거래일"
    s = (f"{MKT_KO[market]} 추천 규칙 검증({bt['from']}~{bt['to']}, 학습에 안 쓴 날짜에 같은 규칙으로 날마다 5개를 골라 "
         f"{h}{u} 보유, {a['periods']}회): 시장 평균보다 회당 {a['ex'] * 100:+.2f}%p"
         f"(왕복 비용을 빼면 {a['exAfterCost'] * 100:+.2f}%p), 시장을 이긴 회차 {a['win'] * 100:.0f}%")
    if ho.get("ex") is not None:
        s += f", 뒤쪽 30%(보류 구간 {bt.get('holdFrom')}~)만 보면 {ho['ex'] * 100:+.2f}%p·{ho['win'] * 100:.0f}%"
    s += (f". 고른 종목 묶음의 누적 최대 낙폭 {a['mdd'] * 100:.0f}%(시장 전체 {a['uniMdd'] * 100:.0f}%), "
          f"누적 {a['growth']:.2f}배(시장 {a['uniGrowth']:.2f}배).")
    if a["growth"] < 1:
        s += " 시장보다는 나았어도 돈은 잃은 기간이었어요 — '시장을 이긴다'와 '오른다'는 달라요."
    if (a.get("exAfterCost") or 0) <= 0:
        s += " 비용을 빼면 남는 게 없어요."
    return s


def build(now=None):
    t0 = time.time()
    now = now or time.time()
    summ = _read(OUT / "predict" / "summary.json") or {}
    markets = summ.get("markets") or {}
    coins = _read(OUT / "coins.json") or {}
    warn = {c for c, v in (coins.get("upbit") or {}).items() if isinstance(v, list) and len(v) > 2 and v[2]}
    news = (_read(OUT / "news_state.json") or {}).get("coins") or {}
    us_bases = {p["sym"].split(":", 1)[1].split(".")[0] for p in ((markets.get("us") or {}).get("picks") or [])}
    groups, notes, backtest = {}, [], {}
    all_cands = {}
    for gkey, glabel, mks in GROUPS:
        cands = []
        for m in mks:
            r = markets.get(m)
            if not r:
                notes.append(f"{MKT_KO[m]}: 예측 엔진 결과가 아직 없어요.")
                continue
            grade = r.get("grade") or (r.get("backtest") or {}).get("verdict") or "none"
            bt = r.get("recBacktest")
            if bt:
                backtest[m] = _bt_brief(bt)
            if grade not in ("strong", "weak"):
                notes.append(f"{MKT_KO[m]}: 예측 모델 검증 등급이 '근거 없음'이라 추천하지 않아요 "
                             f"(검증 순위 IC {(r.get('backtest') or {}).get('rankIC') or 0:+.3f}). 억지로 채우지 않았어요.")
                continue
            try:
                age_d = (datetime.fromtimestamp(now, timezone.utc).date() - datetime.fromisoformat(r["asOf"]).date()).days
            except (KeyError, ValueError, TypeError):
                age_d = 99
            if age_d > STALE_DAYS[m]:
                notes.append(f"{MKT_KO[m]}: 예측 기준일 {r.get('asOf')} 이 오래돼 추천에서 뺐어요.")
                continue
            if bt and bt.get("all"):
                n = _bt_note(m, r.get("horizon"), bt)
                if n:
                    notes.append(n)
            # 안전장치(검증 결과를 본 뒤 더한 보수적 조건 — 추천을 줄이기만 한다): 이 규칙 자체가 과거에 비용 후에도
            # 시장을 이기지 못했거나 보류 구간(최근 30%)에서 졌으면, 모델 등급이 있어도 그 시장은 추천하지 않는다
            ba, bh = (bt or {}).get("all") or {}, (bt or {}).get("hold") or {}
            if not bt or (_num(ba.get("exAfterCost")) or -1) <= 0 or (_num(bh.get("ex")) or -1) <= 0:
                notes.append(f"{MKT_KO[m]}: 모델 순위 자체는 검증 등급 '{GRADE_KO.get(grade, grade)}'이지만, 이 추천 규칙(상위 5개)을 "
                             "과거에 그대로 적용했을 때 비용 후 또는 최근 보류 구간에서 시장을 이기지 못해 추천하지 않아요.")
                continue
            scr = {x["sym"]: x for x in ((_read(OUT / "screener" / f"{m}.json") or {}).get("rows") or [])}
            reg = r.get("regime") or {}
            down_regime = _num(reg.get("mkt20")) is not None and reg["mkt20"] < 0
            use_b = (bt or {}).get("rule") == "B"
            H = r.get("horizon")
            for p in r.get("picks") or []:
                why = cand(m, p, r, scr.get(p["sym"]), warn, news, us_bases, down_regime and use_b)
                if why is None:
                    continue
                if isinstance(why, str):
                    all_cands.setdefault(m, []).append((p["sym"], why))
                    continue
                why.update(H=H, grade=grade, regime=reg, down=down_regime, asOf=r.get("asOf"))
                cands.append(why)
        cands.sort(key=lambda c: (-(c["probBeat"] or 0), -((c["expEx"] or {}).get("q50") or 0),
                                  -(_num(c["p"].get("pctRank")) or 0)))
        seen, items = set(), []
        for c in cands:
            if c["base"] in seen:
                continue
            seen.add(c["base"])
            items.append(item(c))
            if len(items) >= N_PICK:
                break
        groups[gkey] = {"label": glabel, "items": items}
        if not items and any(markets.get(m) for m in mks):
            ex = sum(len(all_cands.get(m, [])) for m in mks)
            if ex:
                notes.append(f"{glabel}: 상위 후보 {ex}개가 과열·하락 경고·유동성·급변동 등으로 모두 빠져 지금은 추천이 없어요.")
    excluded = {m: [{"sym": s, "why": w} for s, w in v[:12]] for m, v in all_cands.items()}
    notes.append("점수는 '시장 이길 확률'이에요: 과거 검증 구간에서 같은 점수 구간 종목들이 실제로 같은 시장 중앙값을 이긴 비율을, "
                 "그 시장 모델의 검증 등급만큼 50% 쪽으로 줄인 값이에요(약함 = 절반만 반영). 가격이 오를 확률이 아니고, 투자 권유가 아니에요.")
    notes.append("목록은 10분마다 최신 가격·전략 판정·뉴스로 다시 걸러요. 모델 자체는 하루 1번 학습해요. 수수료·세금·슬리피지는 빼지 않았어요(검증 문장의 '비용 후'만 왕복 비용 차감).")
    return {"version": 1, "updatedAt": now_iso(), "groups": groups, "notes": notes, "backtest": backtest,
            "excluded": excluded, "secs": round(time.time() - t0, 3)}


def cand(m, p, r, row, warn, news, us_bases, regime_filter):
    """후보 하나 → dict / 제외 사유(str) / None(상위 10% 밖)"""
    if p.get("hold") or _num(p.get("probBeat")) is None:
        return None
    if (_num(p.get("pctRank")) or 0) < TOP_PCT_RANK:
        return None
    code = p["sym"].split(":", 1)[1]
    rx = p.get("rec") or {}
    base = base_of(m, p.get("sub"), code)
    if m in ("upbit", "binance") and base.upper() in STABLE:
        return "스테이블코인"
    if is_stock_token(m, code, p.get("name"), us_bases):
        return "바이낸스 주식 토큰"
    if m == "upbit" and code in warn:
        return "업비트 투자유의"
    if (_num(rx.get("dvPct")) is not None and rx["dvPct"] < LIQ_MIN_PCT):
        return "거래대금 하위 30%"
    if (rx.get("obs") or 999) < MIN_AGE:
        return "상장 30일 미만"
    if m == "upbit":
        nb = _upbit_bars(code)
        if nb is not None and nb < MIN_AGE:
            return "업비트 신규 상장(30일 안)"
    nt = news.get(base) if m in ("upbit", "binance") else None
    tags = set((nt or {}).get("tags") or [])
    if m == "upbit" and "upbitList" in tags:
        return "업비트 신규 상장 소식(과거 7일 중앙값 −11%)"
    if tags & {"delist", "hack"}:
        return "상폐·유의·해킹 소식"
    st = {s.get("k") for s in ((row or {}).get("setups") or [])} if row else set()
    if row is None:
        st = {k for k, f in (("overheat", rx.get("heat")), ("downtrend_warn", rx.get("down"))) if f}
    if "overheat" in st:
        return "과열 주의"
    if "downtrend_warn" in st:
        return "하락 경고"
    if regime_filter and (_num(rx.get("volPct")) or 1) > 0.5:
        return "하락 국면 — 변동성 상위 절반"
    price = _num((row or {}).get("price")) or _num(rx.get("close"))
    close, atr = _num(rx.get("close")), _num(rx.get("atr"))
    move = price / close - 1 if price and close else 0.0
    if atr and abs(move) > MOVE_ATR * atr:
        return "기준 종가 뒤 이미 급등" if move > 0 else "기준 종가 뒤 급락 중"
    return {"m": m, "p": p, "row": row, "rx": rx, "base": base.upper(), "probBeat": p["probBeat"],
            "expEx": p.get("expEx") or {}, "price": price, "move": move, "atr": atr, "news": nt}


def stop_of(price, atr, lo20):
    """손절 참고가: 20일 저점(지지) 1% 아래를 1.5~3 ATR 사이로 자른 값. 지지가 지금가 위면(이미 깨짐) 2 ATR"""
    if not price or not atr:
        return None, None
    s = price * (1 - 2 * atr)
    if lo20 and lo20 < price:
        # 20일 저점(지지) 1% 아래. 단 하루 변동폭보다 가까우면(1.5 ATR 안) 잡음에 걸리므로 1.5 ATR, 3 ATR 보다 멀면 3 ATR
        s = min(max(lo20 * 0.99, price * (1 - 3 * atr)), price * (1 - 1.5 * atr))
    return s, s / price - 1


def item(c):
    m, p, rx, H = c["m"], c["p"], c["rx"], c["H"]
    u = "일" if m in ("upbit", "binance") else "거래일"
    e = c["expEx"]
    stop, stop_pct = stop_of(c["price"], c["atr"], _num(rx.get("lo20")))
    reasons = []
    pr = p.get("probBeat")
    lo, hi = e.get("q10"), e.get("q90")
    rng = f", 80% 범위 {lo * 100:+.1f}~{hi * 100:+.1f}%p" if lo is not None and hi is not None else ""
    reasons.append({"text": f"과거 같은 점수 구간 종목의 {pr * 100:.0f}%가 {H}{u} 동안 시장 중앙값을 이겼어요 "
                            f"(검증 등급 반영, 초과수익 중앙값 {e.get('q50', 0) * 100:+.2f}%p{rng})", "tone": "up"})
    for x in p.get("reasons") or []:
        if x.get("tone") == "up" and len(reasons) < 4:
            reasons.append({"text": x["text"], "tone": "up"})
    for x in p.get("reasons") or []:
        if x.get("tone") == "down" and len(reasons) < 5:
            reasons.append({"text": x["text"], "tone": "down"})
            break
    risks = []
    if c["atr"]:
        risks.append(f"하루 평균 변동폭(ATR) {c['atr'] * 100:.1f}% — 손절 참고가까지 {stop_pct * 100:.1f}%")
    if c["grade"] == "weak":
        risks.append("이 시장 모델은 검증 등급이 '약함'이라 확률·초과수익을 절반만 반영했어요")
    if c["down"]:
        risks.append(f"시장 전체 20일 수익률 {_pct(c['regime']['mkt20'])} — 하락 국면이라 시장을 이겨도 손실일 수 있어요")
    if c["move"] and abs(c["move"]) > 0.005:
        risks.append(f"예측 기준 종가 뒤 지금까지 {_pct(c['move'])} 움직였어요")
    nt = c.get("news") or {}
    if nt.get("tone", 0) < 0:
        risks.append("최근 뉴스 반응(코인니스 투표)이 악재 쪽이에요 — 과거 검증에선 수익 예측 효과가 없었어요")
    if e.get("q10") is not None and e["q10"] < -0.05:
        risks.append(f"같은 점수 구간 종목의 하위 10%는 시장보다 {e['q10'] * 100:.1f}%p 이상 뒤처졌어요")
    return {"sym": p["sym"], "name": p.get("name"), "sub": p.get("sub"), "market": m,
            "score": _r(p.get("score"), 1), "probBeat": _r(pr), "pctRank": _r(p.get("pctRank"), 1),
            "expEx": {"h": H, "unit": u, "q10": _r(e.get("q10")), "q50": _r(e.get("q50")), "q90": _r(e.get("q90")),
                      "n": e.get("n")},
            "grade": c["grade"], "gradeLabel": GRADE_KO.get(c["grade"]), "reasons": reasons, "risks": risks,
            "price": _r(c["price"], 8), "stop": _r(stop, 8), "stopPct": _r(stop_pct), "asOf": c.get("asOf"),
            "spark": (p.get("spark") or [])[-30:]}


def run(out_dir=OUT, log=print):
    res = build()
    path = Path(out_dir) / "recommend.json"
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(res, ensure_ascii=False, separators=(",", ":"), allow_nan=False), encoding="utf-8")
    tmp.replace(path)
    n = {k: len(g["items"]) for k, g in res["groups"].items()}
    log(f"[추천] {n} ({res['secs']}초)")
    return res


if __name__ == "__main__":
    r = run()
    if "--print" in sys.argv:
        print(json.dumps(r, ensure_ascii=False, indent=1))
