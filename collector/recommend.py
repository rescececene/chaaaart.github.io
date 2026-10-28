"""순위 · 추천 모음 · 추천 기록 — 매 실행(collect.py 안 + 예측 엔진 뒤) 다시 계산. 표준 라이브러리만(+ AI 문장은 collector/ai.py)

    python collector/recommend.py            # 지금 파일들로 다시 계산
    python collector/recommend.py --print    # 결과를 화면에도
    python collector/recommend.py --no-ai    # AI 문장 없이 (시험용 — 돈이 들지 않는다)

무거운 학습은 하지 않는다. 하루 1번 도는 예측 엔진(collector/model) 결과 + 매 실행 스크리너(최신 가격·전략 판정) + 뉴스 상태를 합친다.

1) 순위 — data/rank.json(전체 순위 화면, 4개 시장) · data/rank_top.json(첫 화면 '오늘 강할 코인' 5개만, 작게)
   대상: 그 시장 엔진 점수 상위 10%(pctRank ≥ 90, 판단 보류 제외). 순서: 'H 뒤 예상 %'(엔진 expRet.mid) 높은 순.
   빼는 것(하드 제외)만 뺀다: 업비트 투자유의 · 상폐/유의/해킹 소식 · 스테이블코인 · 금·비트코인 등에 묶인 토큰(엔진 peg) · 바이낸스 주식 토큰.
   빼지 않고 '주의'만 붙이는 것: 과열 주의 · 하락 경고 · 기준가 뒤 급변동(ATR 2배) · 거래가 적어요(그 시장 20일 평균 거래대금 하위 30% 또는
     코인 24시간 1억 원 미만) · 막 상장 소식 · 악재 쪽 뉴스 반응. 그래도 최대 5개(화면 첫 목록)이고 점수 상위 10% 밖으로 채우지 않는다.
   코인 순위의 기준 시장은 업비트 원화(사용자 거래소), 바이낸스는 보조 탭.
   이유: 엔진 근거를 쉬운 말로(why, 엔진이 씀) + 업비트 상위 5개만 하루 1번(기준일마다) AI 한 문장(ai.write who="rank").
2) 추천 기록 — data/picks_log.json (collector/picks_log.py): 시장마다 기준일별 첫 5개를 남기고 H 뒤 실제 수익 vs 시장 평균으로 채점.
   화면: '어제 고른 5개 예상 x% → 실제 y% (시장 z%)'와 최근 30회 성적. 실제 기록이 쌓이기 전엔 엔진 워크포워드의
   '과거 되짚어 본 성적'(summary expCheck.recent, 학습에 안 쓴 날짜)을 따로 보여 준다.
3) 추천 모음 — data/recommend.json (추천 화면 호환). 코인 = 업비트 순위 5개(없으면 바이낸스), 주식 = 예전 규칙 그대로.
   모든 항목에 새 필드 expRet{h, unit, label, mid, lo, hi, mkt, edge, grade} · cautions[{k, t}] (기존 필드는 그대로).
"""
import json
import math
import re
import sys
import time
from collections import Counter
from datetime import datetime, timedelta, timezone
from pathlib import Path

import picks_log

OUT = Path(__file__).resolve().parent.parent / "web" / "public" / "data"
N_PICK = 5
N_LIST = 30           # 전체 순위 화면에 싣는 시장별 최대 종목 수 (점수 상위 10% 안)
TOP_PCT_RANK = 90.0   # pctRank(0~100) — 점수 상위 10%
LIQ_MIN_PCT = 0.3
# 2026-10-29: 크기(거래대금·시총)로는 빼지 않는다. '거래가 적어요' 표시는 그 시장 20일 평균 거래대금 하위 30% 이거나
# 코인 24시간 거래대금 1억 원 미만일 때만 (예전 빼기 기준 100억 원은 업비트 원화 코인 280개 중 260개가 걸려 표시가 뜻이 없다)
THIN_KRW = 1e8
MAJORS = {"BTC", "ETH", "USDT", "USDC", "SOL", "XRP", "BNB", "TRX", "DOGE", "ADA"}  # 해킹 기사 제목에 자주 함께 나오는 큰 코인
FX = {"usd": 1350.0}  # 바이낸스 USDT 거래대금 → 원 (overview.json 의 USD/KRW 로 덮어씀)
MIN_AGE = 30
MOVE_ATR = 2.0
STALE_DAYS = {"upbit": 3, "binance": 3, "krx": 5, "us": 5}
GROUPS = (("coin", "코인", ("upbit", "binance")), ("krx", "국내주식", ("krx",)), ("us", "미국주식", ("us",)))
MKT_KO = {"upbit": "업비트", "binance": "바이낸스", "krx": "국내", "us": "미국"}
GRADE_KO = {"strong": "검증 강함", "weak": "검증 약함", "none": "판단 보류"}
COIN = ("upbit", "binance")
STABLE = {"USDT", "USDC", "FDUSD", "TUSD", "BUSD", "DAI", "USDP", "USDE", "USD1", "EUR", "AEUR", "EURI", "XUSD",
          "BFUSD", "PYUSD", "RLUSD", "USDS", "UST", "USTC", "U", "EURC", "USDG", "JPYC", "GUSD", "FRAX", "USDD",
          "LUSD", "AUSD", "USD0", "USDQ", "EURQ", "USDF", "KRWQ"}
# 바이낸스 주식·ETF 토큰 (예: NVDAB, TSLAB, QQQB)
ETF_BASE = {"SOXL", "SOXS", "TQQQ", "SQQQ", "QQQ", "SPY", "EWY", "KORU", "DRAM", "SNXX", "IWM", "GLD", "SLV", "TLT"}
NOT_TOKEN = {"BNB", "ARB", "SHIB", "BOB", "FLOKI", "BB", "SAB", "ORB", "KUB", "DRB", "TRB", "JUB", "RUB", "LAB", "PUB"}
# 금·비트코인 등에 값이 묶인 토큰 (엔진이 peg 를 붙이지만, 엔진이 아직 새 형식으로 돌기 전 결과에도 빼려고 이름으로도 본다)
PEGGED_NAMES = {"PAXG": "금", "XAUT": "금", "KAU": "금", "XAUM": "금", "WBTC": "비트코인", "CBBTC": "비트코인", "BTCB": "비트코인",
                "TBTC": "비트코인", "FBTC": "비트코인", "LBTC": "비트코인", "WETH": "이더리움", "STETH": "이더리움", "WSTETH": "이더리움",
                "BETH": "이더리움", "WBETH": "이더리움", "CBETH": "이더리움", "RETH": "이더리움", "WEETH": "이더리움",
                "BNSOL": "솔라나", "JITOSOL": "솔라나", "MSOL": "솔라나", "WBNB": "BNB"}
CAUTION_KO = {"heat": "과열 주의", "down": "하락 경고", "jump": "기준가 뒤 급등", "drop": "기준가 뒤 급락", "thin": "거래가 적어요",
              "listing": "막 상장", "badnews": "악재 뉴스", "hacknews": "해킹 관련 기사"}
AI_RETRY_H = 2.0      # AI 문장이 실패·일부만 남으면 이 시간 뒤 다시
AI_MAX_TRIES = 4      # 기준일마다 AI 를 부르는 최대 횟수 (엔진이 다시 돌아 다섯이 바뀌면 바로 다시 — 예: 결과 형식 바뀜)


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


def _write(path, obj):
    path = Path(path)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(obj, ensure_ascii=False, separators=(",", ":"), allow_nan=False), encoding="utf-8")
    tmp.replace(path)


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


def h_label(market, h):
    """보유 기간 이름 — 코인 1일 = '24시간'"""
    if market in COIN:
        return "24시간" if h == 1 else f"{h}일"
    return "다음 거래일" if h == 1 else f"{h}거래일"


def base_at(market, asof):
    """기준가가 정해진 때(UTC ISO) — 코인 일봉 끝(다음 날 00:00 UTC = 09:00 KST), 국내 15:30 KST, 미국 16:00 ET(어림 20:30 UTC)"""
    try:
        d = datetime.fromisoformat(asof).replace(tzinfo=timezone.utc)
    except (TypeError, ValueError):
        return None
    t = {"upbit": d + timedelta(days=1), "binance": d + timedelta(days=1),
         "krx": d + timedelta(hours=6, minutes=30), "us": d + timedelta(hours=20, minutes=30)}[market]
    return t.isoformat(timespec="seconds")


def _upbit_bars(code, out_dir=OUT):
    """업비트 일봉 파일(최근 200봉)의 봉 수 — 30 미만이면 신규 상장"""
    d = _read(Path(out_dir) / "candles" / "upbit" / (re.sub(r"[^A-Za-z0-9._-]", "_", code) + ".json"))
    return len((d or {}).get("c") or []) if d else None


# ── 순위 ─────────────────────────────────────────────────────────────────
def hard_exclusion(m, p, warn, news, us_bases):
    """빼야 하는 이유(str) 또는 None — 크기(거래대금)·과열·급변동으로는 빼지 않는다"""
    code = p["sym"].split(":", 1)[1]
    base = base_of(m, p.get("sub"), code).upper()
    if p.get("peg") or (m in COIN and base in PEGGED_NAMES):
        return f"{p.get('peg') or PEGGED_NAMES[base]}에 값이 묶인 토큰"
    if m in COIN and base in STABLE:
        return "스테이블코인"
    if is_stock_token(m, code, p.get("name"), us_bases):
        return "바이낸스 주식 토큰"
    if m == "upbit" and code in warn:
        return "업비트 투자유의"
    tags = set(((news.get(base) if m in COIN else None) or {}).get("tags") or [])
    if "delist" in tags:
        return "상폐·유의 소식"
    if "hack" in tags and base not in MAJORS:
        return "해킹·도난 소식"
    return None


# ── 이유 다양화 ─────────────────────────────────────────────────────────────
# 같은 묶음(가족)의 근거는 하나로 본다 — 예: 하루 출렁임·20일 흔들림·60일 흔들림 = 'vol'
FAMILY = {"atr_14": "vol", "vol_20": "vol", "vol_60": "vol", "ivol_60": "vol", "volu_1_20": "volu", "volu_5_20": "volu",
          "volu_20_60": "volu", "dv_trend": "volu", "kp_rel": "kp", "kp_chg5": "kp", "gap_ma5": "dip", "gap_ma20": "dipL",
          "gap_ma60": "dipL", "gap_ma120": "dipL", "ret_1": "r1", "ret_5": "r5", "ret_20": "r20", "mdd_60": "dd",
          "min_ret_20": "dd", "beta_60": "beta", "hi_52w": "hi52", "lo_52w": "lo52", "mom_12_1": "mom", "amihud_20": "liq",
          "dv_20": "liq", "slope_ma20": "trend", "slope_ma60": "trend", "ma_align": "trend"}
# (가족, 쪽) → (이어 쓰는 말, 끝맺는 말) — 목록 위 공통 한 줄 '오늘 위쪽 코인들은 대부분 …' 에 쓴다
PHRASE = {("vol", "lo"): ("하루 출렁임이 작고", "하루 출렁임이 작은"), ("vol", "hi"): ("하루 출렁임이 크고", "하루 출렁임이 큰"),
          ("volu", "lo"): ("거래가 줄었고", "거래가 줄어든"), ("volu", "hi"): ("거래가 늘었고", "거래가 늘어난"),
          ("kp", "lo"): ("해외 값보다 붙는 웃돈(김프)이 낮고", "해외 값보다 붙는 웃돈(김프)이 낮은"),
          ("kp", "hi"): ("김프가 높고", "김프가 높은"), ("dipL", "lo"): ("긴 평균 가격보다 낮고", "긴 평균 가격보다 낮은"),
          ("dip", "lo"): ("최근 며칠 눌렸고", "최근 며칠 눌린"), ("r1", "lo"): ("전날 내렸고", "전날 내린"),
          ("r1", "hi"): ("전날 올랐고", "전날 오른"), ("r5", "lo"): ("최근 며칠 빠졌고", "최근 며칠 빠진"),
          ("r5", "hi"): ("최근 며칠 올랐고", "최근 며칠 오른"), ("dd", "hi"): ("최근 크게 빠지지 않았고", "최근 크게 빠지지 않은"),
          ("beta", "hi"): ("시장을 크게 따라 움직이고", "시장을 크게 따라 움직이는"),
          ("beta", "lo"): ("시장을 덜 따라 움직이고", "시장을 덜 따라 움직이는"),
          ("liq", "lo"): ("거래대금이 적고", "거래대금이 적은")}


def _fam_side(c):
    pv = c.get("p")
    side = "lo" if pv is not None and pv < 0.5 else "hi" if pv is not None else "-"
    return FAMILY.get(c["k"], c["k"]), side


def diversify(items, picks_by_sym, top_n=N_PICK, who="코인"):
    """화면 목록 안에서 같은 이유가 되풀이되지 않게 — 위쪽 top_n 개 중 과반이 같은 근거면 목록 위 공통 한 줄로 빼고,
    종목마다는 '다른 종목과 가장 다른 근거' 1~2개(숫자 포함)를 고른다. items 의 why 를 바꾸고 공통 한 줄(str|None)을 돌려준다.
    다름 = 그 근거의 시장 안 극단도(|백분위 − 0.5|) × (목록 안에서 드문 정도) × 모형 기여 순서, 위 종목이 쓴 묶음은 뒤로"""
    cand = {it["sym"]: [c for c in (picks_by_sym.get(it["sym"]) or {}).get("whyAll") or [] if c.get("t")] for it in items}
    if not any(cand.values()):
        return None
    top = items[:top_n]
    from collections import Counter
    cnt = Counter()
    for it in top:
        cnt.update({_fam_side(c) for c in cand[it["sym"]][:3]})
    need = max(2, len(top) // 2 + 1)  # 과반 — 5개면 3개 이상
    common = [fs for fs, n in cnt.most_common() if n >= need and fs in PHRASE][:2]
    line = None
    if common:
        ph = [PHRASE[fs] for fs in common]
        body = " ".join([x[0] for x in ph[:-1]] + [ph[-1][1]])
        line = f"오늘 위쪽 {who}들은 대부분 {body} {who}이에요."
    common_set = set(common)
    freq = Counter()
    for it in items:
        freq.update({_fam_side(c) for c in cand[it["sym"]]})
    n_all = max(1, len(items))
    used = Counter()
    for it in items:
        cs = cand[it["sym"]]
        if not cs:
            continue
        scored = []
        for i, c in enumerate(cs):
            fs = _fam_side(c)
            if fs in common_set:
                continue
            pv = c.get("p")
            ext = abs(pv - 0.5) * 2 if pv is not None else 0.5
            score = (0.2 + ext) * (1 - 0.6 * freq[fs] / n_all) / (1 + 0.15 * i) / (1 + used[fs[0]])
            scored.append((score, c))
        scored.sort(key=lambda x: -x[0])
        pick, fams = [], set()
        for _, c in scored:
            f = _fam_side(c)[0]
            if f in fams:
                continue
            pick.append(c)
            fams.add(f)
            if len(pick) >= 2:
                break
        if not pick:  # 공통 근거뿐이면 그 종목 숫자로 한 줄
            pick = cs[:1]
        for c in pick:
            used[_fam_side(c)[0]] += 1
        it["why"] = [c["t"] for c in pick]
    return line


def cautions_of(m, p, row, news, price, base, atr, out_dir=OUT):
    """빼지 않고 붙이는 '주의' [{k, t}] — 매 실행 최신 스크리너·뉴스로"""
    rx = p.get("rec") or {}
    code = p["sym"].split(":", 1)[1]
    out = []
    st = {s.get("k") for s in ((row or {}).get("setups") or [])} if row else \
        {k for k, f in (("overheat", rx.get("heat")), ("downtrend_warn", rx.get("down"))) if f}
    if "overheat" in st:
        out.append(("heat", "과열 주의"))
    if "downtrend_warn" in st:
        out.append(("down", "하락 경고"))
    move = price / base - 1 if price and base else None
    if move is not None and atr and abs(move) > MOVE_ATR * atr:
        out.append(("jump", f"기준가 뒤 이미 {_pct(move)}") if move > 0 else ("drop", f"기준가 뒤 {_pct(move)}"))
    thin = _num(rx.get("dvPct")) is not None and rx["dvPct"] < LIQ_MIN_PCT
    if m in COIN:
        v = _num((row or {}).get("vol"))
        krw = None if v is None else v * (FX["usd"] if m == "binance" else 1)
        thin = thin or (krw is not None and krw < THIN_KRW)
    if thin:
        out.append(("thin", "거래가 적어요"))
    if m in COIN:
        b = base_of(m, p.get("sub"), code).upper()
        nt = news.get(b) or {}
        tags = set(nt.get("tags") or [])
        if "hack" in tags and b in MAJORS:
            out.append(("hacknews", "해킹 관련 기사"))
        if (m == "upbit" and "upbitList" in tags) or (rx.get("obs") or 999) < MIN_AGE or \
                (m == "upbit" and (_upbit_bars(code, out_dir) or 999) < MIN_AGE):
            out.append(("listing", "막 상장"))
        if (nt.get("tone") or 0) < 0:
            out.append(("badnews", "악재 뉴스 반응"))
    return [{"k": k, "t": t} for k, t in out]


def _short_spark(p, n=30):
    return [_r(x, 10) for x in (p.get("spark") or [])[-n:]]


def rank_market(m, r, scr, warn, news, us_bases, now, out_dir=OUT):
    """시장 하나의 순위 목록 (화면용)"""
    H = r.get("horizon")
    asof = r.get("asOf")
    try:
        age_d = (datetime.fromtimestamp(now, timezone.utc).date() - datetime.fromisoformat(asof).date()).days
    except (TypeError, ValueError):
        age_d = 99
    ek = r.get("expCheck") or {}
    res = {"asOf": asof, "h": H, "hLabel": h_label(m, H), "baseAt": base_at(m, asof), "grade": r.get("grade"),
           "fcGrade": ek.get("grade"), "universe": r.get("universe"), "stale": age_d > STALE_DAYS[m],
           "mkt": {"mid": _r((ek or {}).get("mktMid"), 6)}, "items": [], "excluded": [], "notes": []}
    if res["stale"]:
        res["notes"].append(f"예측 기준일 {asof} 이 오래됐어요(엔진이 며칠 돌지 못했어요). 숫자를 그대로 믿지 마세요.")
    grade = r.get("grade") or "none"
    if grade not in ("strong", "weak"):
        res["notes"].append("이 시장은 과거 검증에서 순위가 맞는다는 근거가 없어 순위를 내지 않아요(판단 보류).")
        return res
    for x in r.get("pegged") or []:
        res["excluded"].append({"sym": x["sym"], "name": x.get("name"), "why": f"{x.get('peg')}에 값이 묶인 토큰"})
    items = []
    for p in r.get("picks") or []:
        if p.get("hold") or (_num(p.get("pctRank")) or 0) < TOP_PCT_RANK:
            continue
        why_ex = hard_exclusion(m, p, warn, news, us_bases)
        if why_ex:
            if not any(e["sym"] == p["sym"] for e in res["excluded"]):
                res["excluded"].append({"sym": p["sym"], "name": p.get("name"), "why": why_ex})
            continue
        rx = p.get("rec") or {}
        row = scr.get(p["sym"])
        base = _num(rx.get("close"))
        price = _num((row or {}).get("price")) or base
        er = p.get("expRet") or {}
        it = {"sym": p["sym"], "name": p.get("name"), "sub": p.get("sub"), "pct": _r(p.get("pctRank"), 1),
              "mid": _r(er.get("mid"), 6), "lo": _r(er.get("lo"), 6), "hi": _r(er.get("hi"), 6), "edge": _r(er.get("edge"), 6),
              "base": _r(base, 10), "price": _r(price, 10), "move": _r(price / base - 1, 6) if price and base else None,
              "pb": _r(p.get("probBeat")), "score": _r(p.get("score"), 1),
              "why": [w["text"] for w in (p.get("why") or [])][:2] or [x["text"] for x in (p.get("reasons") or []) if x.get("tone") == "up"][:2],
              "cau": cautions_of(m, p, row, news, price, base, _num(rx.get("atr")), out_dir), "spark": _short_spark(p)}
        items.append(it)
    # 예상 % 높은 순 (예상이 없는 종목은 뒤로, 같으면 점수 순)
    items.sort(key=lambda x: (x["mid"] is None, -(x["mid"] or 0), -(x["pct"] or 0)))
    for i, it in enumerate(items, start=1):
        it["rank"] = i
    items = items[:N_LIST]
    res["common"] = diversify(items, {p["sym"]: p for p in r.get("picks") or []}, who="코인" if m in COIN else "종목")
    res["items"] = items
    res["excluded"] = res["excluded"][:20]
    if len(items) < N_PICK:
        res["notes"].append(f"점수 상위 10% 안에서 빼야 하는 종목(투자유의·묶인 토큰 등)을 빼니 {len(items)}개만 남았어요. 억지로 채우지 않았어요.")
    return res


def score_block(m, r, L):
    """채점 묶음: real(실제 기록 최근 30회) · last(가장 최근 채점 하루) · past(엔진 워크포워드 '과거 되짚어 본 성적') · check(예상 % 검증)"""
    ek = (r or {}).get("expCheck") or {}
    out = {"real": (L or {}).get("stats"), "last": None, "past": None, "check": None, "pending": None}
    e = picks_log.last_graded(L or {})
    if e:
        res = e["res"]
        out["last"] = {"d": e["d"], "end": res.get("end"), "pred": res.get("pred"), "avg": res.get("avg"), "mkt": res.get("mkt"),
                       "mktMed": res.get("mktMed"), "win": res.get("win"), "inRange": res.get("inRange"),
                       "items": [{"sym": it["sym"], "name": it.get("name"), "mid": it.get("mid"), "ret": ret}
                                 for it, ret in zip(e.get("items") or [], res.get("ret") or [])]}
    pend = [x for x in (L or {}).get("days") or [] if not x.get("res")]
    if pend:
        out["pending"] = {"n": len(pend), "d": pend[-1]["d"]}
    rc = ek.get("recent") or []
    if rc:
        n = len(rc)
        out["past"] = {"n": n, "from": rc[0]["d"], "to": rc[-1]["d"],
                       "pred": _r(sum(x["pred"] for x in rc) / n, 6), "act": _r(sum(x["act"] for x in rc) / n, 6),
                       "mkt": _r(sum(x["mkt"] for x in rc) / n, 6), "beat": _r(sum(1 for x in rc if x["act"] > x["mkt"]) / n),
                       "mae": _r(sum(abs(x["act"] - x["pred"]) for x in rc) / n, 6),
                       "inRange": _r(sum(x["inRange"] for x in rc if _num(x.get("inRange")) is not None) /
                                     max(1, sum(1 for x in rc if _num(x.get("inRange")) is not None))),
                       "list": [{"d": x["d"], "pred": _r(x["pred"], 6), "act": _r(x["act"], 6), "mkt": _r(x["mkt"], 6)} for x in rc]}
    a, h = ek.get("all") or {}, ek.get("hold") or {}
    if a:
        def brief(z):
            if not z:
                return None
            t5 = z.get("top5") or {}
            return {"n": z.get("n"), "coverage": _r(z.get("coverage")), "slope": _r(z.get("slope"), 3), "bias": _r(z.get("bias"), 6),
                    "dirHit": _r(z.get("dirHit")), "upShare": _r(z.get("upShare")), "ic": _r(z.get("ic")),
                    "mseVsZero": _r(z["mse"] / z["mseZero"] - 1, 5) if _num(z.get("mseZero")) else None,
                    "top5": {k: _r(t5.get(k), 6) for k in ("n", "pred", "act", "mkt", "ex", "beat", "mae", "inRange", "mdd", "uniMdd",
                                                          "growth", "uniGrowth")} if t5 else None,
                    "bins": [{k: _r(b[k], 6) for k in ("pred", "mean", "median")} for b in z.get("bins") or []]}
        out["check"] = {"method": ek.get("method"), "grade": ek.get("grade"), "from": ek.get("from"), "to": ek.get("to"),
                        "holdFrom": ek.get("holdFrom"), "all": brief(a), "hold": brief(h)}
    return out


# ── AI 한 문장 (업비트 상위 5개, 기준일마다 1번) ──────────────────────────────
AI_SYSTEM = (
    "너는 코인 순위표 옆에 붙는 짧은 설명을 쓴다. 주어진 숫자만 근거로, 이 코인이 오늘 다른 코인보다 순위가 높게 나온 까닭을 "
    "쉬운 한국어 해요체 한 문장(30~48자)으로 쓴다.\n"
    "규칙: 사세요·추천·오를 거예요·확실·기회 같은 말 금지(가격이 오른다고 말하지 말 것). 주어진 숫자에 없는 사실(뉴스·호재·프로젝트 이야기)을 지어내지 않는다. "
    "전문 용어는 풀어 쓴다(예: ATR → 하루 출렁임, 김치 프리미엄 → 해외보다 비싸게/싸게 거래). 이모지·따옴표·숫자 나열 금지. "
    "'주의' 항목이 있으면 문장 끝에 짧게 덧붙인다(예: ', 다만 거래가 적어요'). "
    "'위쪽 코인 공통점'은 목록 위에 따로 적으니 되풀이하지 말고, 코인마다 '이 코인만의 근거'를 숫자와 함께 쓴다. "
    "다섯 문장이 같은 말로 시작하지 않게 한다(코인 이름으로 시작하지 말 것).")
AI_SCHEMA = {"type": "object", "properties": {"items": {"type": "array", "items": {
    "type": "object", "properties": {"sym": {"type": "string"}, "why": {"type": "string"}}, "required": ["sym", "why"],
    "additionalProperties": False}}}, "required": ["items"], "additionalProperties": False}
BANNED = re.compile(r"사세요|매수|추천|오를\s*거|오를\s*것|확실|대박|기회예요|급등할")


def _ai_user(m, rk, picks_by_sym):
    lines = [f"시장: {MKT_KO[m]} 원화 코인. 기간: 앞으로 {rk['hLabel']}. 시장 전체(가운데 코인) 예상 {_pct(rk['mkt']['mid'] or 0, 2)}.",
             f"위쪽 코인 공통점(목록 위에 따로 적음 — 되풀이 금지): {rk.get('common') or '없음'}"]
    for it in rk["items"][:N_PICK]:
        p = picks_by_sym.get(it["sym"]) or {}
        other = [c["t"] for c in (p.get("whyAll") or []) if c.get("t") not in it["why"]][:3]
        lines.append(json.dumps({
            "sym": it["sym"], "이름": it["name"], "순위": it["rank"], "점수 백분위": f"상위 {max(1, round(100 - (it['pct'] or 0)))}%",
            "예상": _pct(it["mid"] or 0, 2), "10번 중 8번 범위": f"{_pct(it['lo'] or 0)} ~ {_pct(it['hi'] or 0)}",
            "다른 코인보다 나을 몫": f"{(it['edge'] or 0) * 100:+.2f}%p", "이 코인만의 근거": it["why"], "그 밖 근거": other,
            "주의": [c["t"] for c in it["cau"]]}, ensure_ascii=False))
    lines.append("위 코인마다 sym 과 why(한 문장)를 돌려줘.")
    return "\n".join(lines)


def ai_reasons(m, rk, picks_by_sym, prev, no_ai=False, log=print):
    """{sym: 문장} + 상태 — 같은 기준일·같은 다섯이면 지난번 것을 그대로 (보통 하루 1번 상위 5개만).
    다섯이 바뀌면(엔진 재실행 등) 바로, 일부가 걸러졌으면 AI_RETRY_H 뒤 다섯을 한 번에 다시 쓴다 — 기준일마다 최대 AI_MAX_TRIES 번"""
    asof = rk.get("asOf")
    st = dict(prev or {}) if (prev or {}).get("asOf") == asof else {"asOf": asof, "texts": {}, "tries": 0}
    cur = [it["sym"] for it in rk["items"][:N_PICK]]
    need = [x for x in cur if x not in st.get("texts", {})]
    try:
        last_try = datetime.fromisoformat(st["at"]).timestamp() if st.get("at") else 0
    except ValueError:
        last_try = 0
    tries = st.get("tries", 0)
    changed = set(cur) != set(st.get("for") or [])  # 지난번에 문장을 쓴 다섯과 다르다
    can = tries < AI_MAX_TRIES and (tries == 0 or changed or time.time() - last_try > AI_RETRY_H * 3600)
    if no_ai or not need or not can or not rk["items"]:
        return st
    try:
        import ai  # collector/ai.py (클로드 연결 담당)
    except ImportError:
        return st
    st["tries"] = tries + 1
    st["at"] = now_iso()
    st["for"] = cur
    out = ai.write(who="rank", system=AI_SYSTEM, user=_ai_user(m, rk, picks_by_sym), max_tokens=700, schema=AI_SCHEMA)
    texts, drop = {}, Counter()
    for x in (out or {}).get("items") or []:
        s = re.sub(r"\s+", " ", str(x.get("why") or "")).strip().strip('"').strip()
        sym = str(x.get("sym"))
        if sym not in cur:
            drop["sym"] += 1
        elif not 8 <= len(s) <= 90:
            drop["len"] += 1
        elif BANNED.search(s):
            drop["ban"] += 1
        else:
            texts[sym] = s
    old = st.get("texts") or {}
    seen_head = set()
    keep = {}
    for sym in cur:  # 새 문장 우선, 이번에 걸러진 코인은 지난 문장(같은 기준일)이 있으면 그대로
        t = texts.get(sym) or old.get(sym)
        if not t:
            continue
        head = re.sub(r"\s+", "", t)[:6]
        if head in seen_head:
            drop["head"] += 1
            continue
        seen_head.add(head)
        keep[sym] = t
    st["texts"] = keep
    if texts:
        meta = getattr(ai, "last", lambda w: None)("rank") or {}
        st["by"] = meta.get("provider")
        st["model"] = meta.get("model")
    log(f"[순위] AI 문장 {len(keep)}/{len(cur)}개 ({st.get('by') or '없음'})" + (f" · 거름 {dict(drop)}" if drop else ""))
    return st


# ── 추천 모음 (추천 화면 호환) ─────────────────────────────────────────────
def _bt_brief(bt):
    if not bt or not bt.get("all"):
        return None
    keep = ("ex", "exMed", "exAfterCost", "win", "mdd", "uniMdd", "growth", "uniGrowth", "periods", "avgPicks", "empty",
            "downEx", "upEx", "t")
    return {"h": bt.get("h"), "from": bt.get("from"), "to": bt.get("to"), "holdFrom": bt.get("holdFrom"),
            "rule": bt.get("rule"), "desc": bt.get("desc"),
            "all": {k: _r(bt["all"].get(k), 5) for k in keep},
            "hold": {k: _r((bt.get("hold") or {}).get(k), 5) for k in keep} if bt.get("hold") else None}


def _bt_from_check(m, r):
    """새 코인 규칙('상위 10% 안 예상 높은 5개')의 워크포워드 성적 → 추천 화면의 규칙 성적 표 모양"""
    ek = (r or {}).get("expCheck") or {}

    def one(z):
        t = (z or {}).get("top5")
        if not t:
            return None
        return {"ex": _r(t.get("ex"), 5), "exMed": _r(t.get("exMed"), 5), "exAfterCost": _r(t.get("exAfterCost"), 5),
                "win": _r(t.get("beat"), 5), "mdd": _r(t.get("mdd"), 5), "uniMdd": _r(t.get("uniMdd"), 5),
                "growth": _r(t.get("growth"), 5), "uniGrowth": _r(t.get("uniGrowth"), 5), "periods": t.get("n"),
                "avgPicks": 5, "empty": 0}
    a = one(ek.get("all"))
    if not a:
        return None
    return {"h": ek.get("h"), "from": ek.get("from"), "to": ek.get("to"), "holdFrom": ek.get("holdFrom"), "rule": "E",
            "desc": f"점수 상위 10% 안에서 '{h_label(m, ek.get('h') or 1)} 뒤 예상'이 높은 5개(투자유의·묶인 토큰만 빼고, 과열·급변동·거래 적음은 빼지 않음)",
            "all": a, "hold": one(ek.get("hold"))}


def _bt_note(market, h, bt):
    a, ho = bt.get("all") or {}, bt.get("hold") or {}
    if a.get("ex") is None:
        return None
    u = "일" if market in COIN else "거래일"
    s = (f"{MKT_KO[market]} 추천 규칙 검증({bt['from']}~{bt['to']}, 학습에 안 쓴 날짜에 같은 규칙으로 날마다 5개를 골라 "
         f"{h}{u} 보유, {a['periods']}회): 시장 평균보다 회당 {a['ex'] * 100:+.2f}%p"
         f"(왕복 비용을 빼면 {a['exAfterCost'] * 100:+.2f}%p), 시장을 이긴 회차 {a['win'] * 100:.0f}%")
    if ho.get("ex") is not None:
        s += f", 뒤쪽 30%(보류 구간 {bt.get('holdFrom')}~)만 보면 {ho['ex'] * 100:+.2f}%p·{ho['win'] * 100:.0f}%"
    if a.get("mdd") is not None and a.get("growth") is not None:
        s += (f". 고른 종목 묶음의 누적 최대 낙폭 {a['mdd'] * 100:.0f}%(시장 전체 {a['uniMdd'] * 100:.0f}%), "
              f"누적 {a['growth']:.2f}배(시장 {a['uniGrowth']:.2f}배).")
        if a["growth"] < 1:
            s += " 시장보다는 나았어도 돈은 잃은 기간이었어요 — '시장을 이긴다'와 '오른다'는 달라요."
    if (a.get("exAfterCost") or 0) <= 0:
        s += " 비용을 빼면 남는 게 없어요."
    return s


def stop_of(price, atr, lo20):
    """손절 참고가: 20일 저점(지지) 1% 아래를 1.5~3 ATR 사이로 자른 값. 지지가 지금가 위면(이미 깨짐) 2 ATR"""
    if not price or not atr:
        return None, None
    s = price * (1 - 2 * atr)
    if lo20 and lo20 < price:
        s = min(max(lo20 * 0.99, price * (1 - 3 * atr)), price * (1 - 1.5 * atr))
    return s, s / price - 1


def _exp_field(m, p, fc_grade):
    er = p.get("expRet") or {}
    if _num(er.get("mid")) is None:
        return None
    return {"h": er.get("h"), "unit": "일" if m in COIN else "거래일", "label": h_label(m, er.get("h") or 1),
            "mid": _r(er["mid"], 6), "lo": _r(er.get("lo"), 6), "hi": _r(er.get("hi"), 6), "mkt": _r(er.get("mkt"), 6),
            "edge": _r(er.get("edge"), 6), "grade": fc_grade}


def _sig(t):
    """같은 숫자를 되풀이하는 근거 거르기용 — '최근 5거래일 -5.3%'처럼 첫 % 숫자까지 (띄어쓰기·부호 모양 무시)"""
    t = re.sub(r"\s+", "", str(t)).replace("−", "-")
    m_ = re.search(r"[+-]?\d+(?:\.\d+)?%", t)
    return t[:m_.end()] if m_ else t


def rec_item(m, p, r, row, extra=None):
    """추천 화면 카드 하나 (예전 모양 + expRet·cautions)"""
    H = r.get("horizon")
    u = "일" if m in COIN else "거래일"
    rx = p.get("rec") or {}
    e = p.get("expEx") or {}
    price = _num((row or {}).get("price")) or _num(rx.get("close"))
    atr = _num(rx.get("atr"))
    stop, stop_pct = stop_of(price, atr, _num(rx.get("lo20")))
    reasons = []
    pr = p.get("probBeat")
    lo, hi = e.get("q10"), e.get("q90")
    rng = f", 80% 범위 {lo * 100:+.1f}~{hi * 100:+.1f}%p" if lo is not None and hi is not None else ""
    if pr is not None:
        reasons.append({"text": f"과거 같은 점수 구간 종목의 {pr * 100:.0f}%가 {H}{u} 동안 시장 중앙값을 이겼어요 "
                                f"(검증 등급 반영, 초과수익 중앙값 {e.get('q50', 0) * 100:+.2f}%p{rng})", "tone": "up"})
    seen = set()

    def add(text, tone):  # 같은 숫자를 다른 말로 되풀이하는 근거는 하나만 ('최근 5거래일 -5.3% 빠진 뒤예요' · '최근 5거래일 -5.3% — 시장보다…')
        k = _sig(text)
        if k in seen:
            return False
        seen.add(k)
        reasons.append({"text": text, "tone": tone})
        return True

    for x in p.get("why") or []:
        if len(reasons) < 3:
            add(x["text"], "up")
    for x in p.get("reasons") or []:
        if x.get("tone") == "up" and len(reasons) < 4:
            add(x["text"], "up")
    for x in p.get("reasons") or []:
        if x.get("tone") == "down" and len(reasons) < 5 and add(x["text"], "down"):
            break
    risks = []
    if atr and stop_pct is not None:
        risks.append(f"하루 평균 변동폭(ATR) {atr * 100:.1f}% — 손절 참고가까지 {stop_pct * 100:.1f}%")
    if r.get("grade") == "weak":
        risks.append("이 시장 모델은 검증 등급이 '약함'이라 확률·초과수익을 절반만 반영했어요")
    reg = r.get("regime") or {}
    if _num(reg.get("mkt20")) is not None and reg["mkt20"] < 0:
        risks.append(f"시장 전체 20일 수익률 {_pct(reg['mkt20'])} — 하락 국면이라 시장을 이겨도 손실일 수 있어요")
    move = price / rx["close"] - 1 if price and _num(rx.get("close")) else 0.0
    if move and abs(move) > 0.005:
        risks.append(f"예측 기준 종가 뒤 지금까지 {_pct(move)} 움직였어요")
    if e.get("q10") is not None and e["q10"] < -0.05:
        risks.append(f"같은 점수 구간 종목의 하위 10%는 시장보다 {e['q10'] * 100:.1f}%p 이상 뒤처졌어요")
    fc_grade = ((r.get("expCheck") or {}).get("grade"))
    out = {"sym": p["sym"], "name": p.get("name"), "sub": p.get("sub"), "market": m,
           "score": _r(p.get("score"), 1), "probBeat": _r(pr), "pctRank": _r(p.get("pctRank"), 1),
           "expEx": {"h": H, "unit": u, "q10": _r(e.get("q10")), "q50": _r(e.get("q50")), "q90": _r(e.get("q90")), "n": e.get("n")},
           "grade": r.get("grade"), "gradeLabel": GRADE_KO.get(r.get("grade")), "reasons": reasons, "risks": risks,
           "price": _r(price, 8), "stop": _r(stop, 8), "stopPct": _r(stop_pct), "asOf": r.get("asOf"),
           "spark": (p.get("spark") or [])[-30:], "expRet": _exp_field(m, p, fc_grade)}
    if extra:
        out.update(extra)
    return out


def stock_cand(m, p, row, regime_filter):
    """주식 추천(예전 규칙 그대로) — 후보면 None, 빼면 이유(str)"""
    rx = p.get("rec") or {}
    if (_num(rx.get("dvPct")) is not None and rx["dvPct"] < LIQ_MIN_PCT):
        return "거래대금 하위 30%"
    if (rx.get("obs") or 999) < MIN_AGE:
        return "상장 30일 미만"
    st = {s.get("k") for s in ((row or {}).get("setups") or [])} if row else \
        {k for k, f in (("overheat", rx.get("heat")), ("downtrend_warn", rx.get("down"))) if f}
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
    return None


def build(now=None, no_ai=False, out_dir=OUT, log=print):
    t0 = time.time()
    now = now or time.time()
    summ = _read(out_dir / "predict" / "summary.json") or {}
    markets = summ.get("markets") or {}
    coins = _read(out_dir / "coins.json") or {}
    warn = {c for c, v in (coins.get("upbit") or {}).items() if isinstance(v, list) and len(v) > 2 and v[2]}
    news = (_read(out_dir / "news_state.json") or {}).get("coins") or {}
    for it in (_read(out_dir / "overview.json") or {}).get("items") or []:
        if it.get("id") == "USDKRW" and _num(it.get("price")):
            FX["usd"] = float(it["price"])
    us_bases = {p["sym"].split(":", 1)[1].split(".")[0] for p in ((markets.get("us") or {}).get("picks") or [])}
    scr = {m: {x["sym"]: x for x in ((_read(out_dir / "screener" / f"{m}.json") or {}).get("rows") or [])} for m in markets}
    prev_rank = _read(out_dir / "rank.json") or {}

    # 1) 순위 (4개 시장)
    rank = {}
    for m in ("upbit", "binance", "krx", "us"):
        r = markets.get(m)
        if not r:
            continue
        rank[m] = rank_market(m, r, scr.get(m) or {}, warn, news, us_bases, now, out_dir)
    # 2) 추천 기록 + 채점 (기준일별 첫 5개, 낡은 결과는 기록하지 않는다)
    log_ = picks_log.load(out_dir)
    for m, rk in rank.items():  # 예상 % 가 있는 결과만 (엔진이 새 형식으로 돌기 전 결과는 '예상 vs 실제'를 채점할 수 없다)
        if not rk["stale"] and rk["items"] and any(x["mid"] is not None for x in rk["items"][:N_PICK]):
            picks_log.record(log_, m, rk["asOf"], rk["h"], rk["items"][:N_PICK], (rk.get("mkt") or {}).get("mid"), rk.get("fcGrade"))
    n_graded = picks_log.grade(log_, summ, out_dir)
    picks_log.save(log_, out_dir)
    for m, rk in rank.items():
        rk["score"] = score_block(m, markets.get(m), (log_.get("markets") or {}).get(m))
    # 3) AI 한 문장 (업비트 상위 5개, 기준일마다 1번)
    ai_state = dict((prev_rank.get("ai") or {}))
    if "upbit" in rank and rank["upbit"]["items"] and not rank["upbit"]["stale"]:
        pbs = {p["sym"]: p for p in (markets["upbit"].get("picks") or [])}
        ai_state["upbit"] = ai_reasons("upbit", rank["upbit"], pbs, ai_state.get("upbit"), no_ai=no_ai, log=log)
    for m, rk in rank.items():
        texts = ((ai_state.get(m) or {}).get("asOf") == rk["asOf"]) and (ai_state.get(m) or {}).get("texts") or {}
        for it in rk["items"]:
            if it["sym"] in texts:
                it["ai"] = texts[it["sym"]]
        rk["aiBy"] = (ai_state.get(m) or {}).get("by") if texts else None

    # 4) 추천 모음 (추천 화면 호환)
    groups, notes, backtest, excluded = {}, [], {}, {}
    coin_m = next((m for m in COIN if m in rank and rank[m]["items"] and not rank[m]["stale"]), None)
    coin_items = []
    if coin_m:
        r = markets[coin_m]
        pbs = {p["sym"]: p for p in r.get("picks") or []}
        for it in rank[coin_m]["items"][:N_PICK]:
            extra = {"cautions": it["cau"], **({"ai": it["ai"]} if it.get("ai") else {})}
            coin_items.append(rec_item(coin_m, pbs[it["sym"]], r, scr.get(coin_m, {}).get(it["sym"]), extra))
        bt = _bt_from_check(coin_m, r)
        if bt:
            backtest[coin_m] = bt
            n = _bt_note(coin_m, r.get("horizon"), bt)
            if n:
                notes.append(n)
        if rank[coin_m]["excluded"]:
            excluded[coin_m] = [{"sym": e["sym"], "why": e["why"]} for e in rank[coin_m]["excluded"][:12]]
        if coin_m != "upbit":
            notes.append("업비트: 예측 결과가 없거나 오래돼 이번엔 바이낸스 순위로 보여 줘요.")
    if coin_m == "upbit" and "binance" in rank:
        notes.append("바이낸스: 코인 추천은 사용자 거래소인 업비트 원화 순위로만 골라 바이낸스 종목은 따로 추천하지 않아요"
                     "(바이낸스 순위는 전체 순위 화면의 보조 탭에서 볼 수 있어요).")
    groups["coin"] = {"label": "코인", "items": coin_items}
    for gkey, glabel, mks in GROUPS[1:]:
        cands, ex_list = [], []
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
            if rank.get(m, {}).get("stale"):
                notes.append(f"{MKT_KO[m]}: 예측 기준일 {r.get('asOf')} 이 오래돼 추천에서 뺐어요.")
                continue
            if bt and bt.get("all"):
                n = _bt_note(m, r.get("horizon"), bt)
                if n:
                    notes.append(n)
            ba, bh = (bt or {}).get("all") or {}, (bt or {}).get("hold") or {}
            if not bt or (_num(ba.get("exAfterCost")) or -1) <= 0 or (_num(bh.get("ex")) or -1) <= 0:
                notes.append(f"{MKT_KO[m]}: 모델 순위 자체는 검증 등급 '{GRADE_KO.get(grade, grade)}'이지만, 이 추천 규칙(상위 5개)을 "
                             "과거에 그대로 적용했을 때 비용 후 또는 최근 보류 구간에서 시장을 이기지 못해 추천하지 않아요.")
                continue
            reg = r.get("regime") or {}
            down_regime = _num(reg.get("mkt20")) is not None and reg["mkt20"] < 0
            use_b = (bt or {}).get("rule") == "B"
            for p in r.get("picks") or []:
                if p.get("hold") or _num(p.get("probBeat")) is None or (_num(p.get("pctRank")) or 0) < TOP_PCT_RANK:
                    continue
                why = stock_cand(m, p, scr.get(m, {}).get(p["sym"]), down_regime and use_b)
                if why:
                    ex_list.append((m, p["sym"], why))
                    continue
                cands.append((m, p, r))
        cands.sort(key=lambda c: (-(c[1].get("probBeat") or 0), -((c[1].get("expEx") or {}).get("q50") or 0),
                                  -(_num(c[1].get("pctRank")) or 0)))
        items = [rec_item(m, p, r, scr.get(m, {}).get(p["sym"])) for m, p, r in cands[:N_PICK]]
        groups[gkey] = {"label": glabel, "items": items}
        for m, s, w in ex_list:
            excluded.setdefault(m, []).append({"sym": s, "why": w})
        if not items and ex_list:
            notes.append(f"{glabel}: 상위 후보 {len(ex_list)}개가 과열·하락 경고·유동성·급변동 등으로 모두 빠져 지금은 추천이 없어요.")
    notes = [n for n in notes if n]
    notes.append("코인 목록은 점수 상위 10% 안에서 '24시간 뒤 예상'이 높은 순이에요. 투자유의·상폐·해킹 소식·스테이블·금/비트코인에 묶인 "
                 "토큰만 빼고, 과열·급변동·거래가 적은 코인은 빼지 않고 '주의'로 표시해요.")
    notes.append("'예상 %'는 학습에 안 쓴 과거 날짜로 되돌려 맞혀 본 방법으로 만든 값이고, 시장 전체 방향은 거의 못 맞혀 0% 근처에 모여요. "
                 "'시장 이길 확률'은 같은 시장 중앙값보다 더 오를 확률이에요 — 가격이 오를 확률이 아니고, 투자 권유가 아니에요.")
    notes.append("목록은 매 실행(보통 40~70분마다) 최신 가격·전략 판정·뉴스로 다시 걸러요. 모델 자체는 하루 1번 학습해요.")
    rec = {"version": 1, "updatedAt": now_iso(), "groups": groups, "notes": notes, "backtest": backtest,
           "excluded": {m: v[:12] for m, v in excluded.items()}, "secs": round(time.time() - t0, 3)}
    rank_out = {"version": 1, "updatedAt": now_iso(), "markets": rank, "ai": ai_state, "graded": n_graded}
    return rec, rank_out, top_of(rank, ai_state)


def top_of(rank, ai_state):
    """첫 화면용 작은 파일 — 업비트(없으면 바이낸스) 상위 5개 + 채점 요약만"""
    m = next((x for x in COIN if x in rank and rank[x]["items"] and not rank[x]["stale"]), None)
    if not m:
        m = next((x for x in COIN if x in rank), None)
    if not m:
        return {"version": 1, "updatedAt": now_iso(), "market": None, "items": []}
    rk = rank[m]
    keep = ("sym", "name", "sub", "rank", "pct", "mid", "lo", "hi", "edge", "base", "price", "move", "cau", "ai")
    items = []
    for it in rk["items"][:N_PICK]:
        x = {k: it.get(k) for k in keep if it.get(k) is not None}
        x["why"] = (it.get("why") or [None])[0]
        items.append(x)
    sc = rk.get("score") or {}
    past = dict(sc.get("past") or {})
    past.pop("list", None)
    chk = sc.get("check") or {}
    t5 = ((chk.get("all") or {}).get("top5") or {}) if chk else {}
    return {"version": 1, "updatedAt": now_iso(), "market": m, "asOf": rk["asOf"], "h": rk["h"], "hLabel": rk["hLabel"],
            "baseAt": rk["baseAt"], "grade": rk["grade"], "fcGrade": rk.get("fcGrade"), "stale": rk["stale"], "mkt": rk["mkt"],
            "common": rk.get("common"), "items": items, "notes": rk["notes"][:2], "aiBy": rk.get("aiBy"),
            "score": {"last": sc.get("last"), "real": sc.get("real"), "past": past or None, "pending": sc.get("pending"),
                      "check": {"grade": chk.get("grade"), "coverage": ((chk.get("all") or {}).get("coverage")),
                                "slope": ((chk.get("all") or {}).get("slope")), "from": chk.get("from"), "to": chk.get("to"),
                                "mdd": t5.get("mdd"), "uniMdd": t5.get("uniMdd")} if chk else None}}


def run(out_dir=OUT, log=print, no_ai=False):
    out_dir = Path(out_dir)
    rec, rank_out, top = build(no_ai=no_ai, out_dir=out_dir, log=log)
    _write(out_dir / "recommend.json", rec)
    _write(out_dir / "rank.json", rank_out)
    _write(out_dir / "rank_top.json", top)
    n = {k: len(g["items"]) for k, g in rec["groups"].items()}
    nr = {m: len(r["items"]) for m, r in rank_out["markets"].items()}
    log(f"[추천] {n} · 순위 {nr} · 새로 채점 {rank_out['graded']} ({rec['secs']}초)")
    return rec


if __name__ == "__main__":
    r = run(no_ai="--no-ai" in sys.argv)
    if "--print" in sys.argv:
        print(json.dumps(r, ensure_ascii=False, indent=1))
