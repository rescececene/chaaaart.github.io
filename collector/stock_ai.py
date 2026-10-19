"""종목 AI 해설 — 시장별 주요 종목의 기술적 분석 근거를 AI 가 쉬운 말로 3문장 안팎 정리 (하루 2번 정도)

무료 사용량은 뉴스 판단과 함께 쓴다 (cf_ai.Budget, 하루 8,000 뉴런에서 멈춤).
뉴스가 먼저라서 오늘 사용량이 START_BELOW 를 넘었으면 해설은 건너뛴다.
비밀값(CF_ACCOUNT_ID / CF_AI_TOKEN)이 없으면 아무것도 하지 않는다.

입력(brief): collect.py 가 일봉 지표를 계산하면서 모은 종목별 요약
    {"sym", "name", "market", "price", "chg", "op", "buy", "sell", "neutral", "pos": [...], "neg": [...], "obj": [...]}
결과: data/stock_ai.json
    {"updatedAt", "model", "usage": {...}, "items": {"<sym>": {"x": 해설, "s": -2~2, "at": 판단 시각}}}
"""
import json
import time
from datetime import datetime, timezone
from pathlib import Path

import cf_ai

TOP_N = {"upbit": 30, "binance": 20, "krx": 30, "us": 30}  # 시장별 해설할 종목 수 (거래대금·시가총액 순)
STALE_HOURS = 11  # 마지막 해설이 이보다 오래됐을 때만 다시 (10분마다 도는 수집기 안에서 하루 2번 정도)
START_BELOW = 4500  # 오늘 AI 사용량이 이보다 많으면 해설은 건너뛴다 (뉴스 판단 몫을 남긴다)
BATCH = 5
TIME_BUDGET = 150
MARKET_NAME = {"upbit": "업비트 코인(원화)", "binance": "바이낸스 코인(USDT)", "krx": "국내주식", "us": "미국주식"}

SYSTEM = """너는 한국 개인 투자자를 위한 차트 분석 해설가다. 종목마다 주어진 기술적 지표 근거만 보고 쉬운 말로 해설한다.
규칙:
- x: 해요체 2~3문장, 140자 안팎. 첫 문장은 지금 흐름 한 줄 요약, 다음은 가장 중요한 긍정·부정 근거, 마지막은 지켜볼 점.
- 근거에 없는 사실(뉴스, 실적, 목표가)을 지어내지 않는다. 숫자는 입력에 있는 것만 쓴다.
- 확신하거나 권유하지 않는다 ('사세요', '오를 거예요' 금지). '~로 보여요', '~할 수 있어요' 처럼 쓴다.
- s: 종합 방향 -2(매우 약함) -1(약함) 0(중립·엇갈림) 1(강함) 2(매우 강함).
- 입력 순서대로 모두 답하고 JSON 배열만 출력한다.
출력 예: [{"i":0,"s":1,"x":"20일 평균 위에서 오름세가 이어지고 있어요. 거래량이 평소의 2배로 늘었지만 RSI가 71로 단기 과열 구간이에요. 숨 고르기가 나오는지 지켜볼 만해요."}]"""


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def load(path):
    try:
        d = json.loads(Path(path).read_text(encoding="utf-8"))
        if isinstance(d.get("items"), dict):
            return d
    except Exception:
        pass
    return {"items": {}}


VOTE_TEXT = {  # 지표 표 → (매수 쪽 문장, 매도 쪽 문장) — 값은 brief() 가 채운다
    "rsi": ("RSI {rsi:.0f} — 많이 떨어져 반등 여지", "RSI {rsi:.0f} — 단기 과열"),
    "macd": ("MACD가 시그널선 위 — 오르는 힘 우세", "MACD가 시그널선 아래 — 내리는 힘 우세"),
    "bb": ("볼린저밴드 하단 아래 — 평소보다 많이 빠짐", "볼린저밴드 상단 위 — 평소보다 많이 오름"),
    "stoch": ("스토캐스틱 침체권에서 상승 전환", "스토캐스틱 과열권에서 하락 전환"),
    "willr": ("윌리엄스%R {willr:.0f} — 침체권", "윌리엄스%R {willr:.0f} — 과열권"),
    "cci": ("CCI -100 아래에서 반등", "CCI +100 위에서 꺾임"),
    "adx": ("ADX {adx:.0f}·+DI 우세 — 오르는 쪽 추세", "ADX {adx:.0f}·−DI 우세 — 내리는 쪽 추세"),
    "obv": ("거래량 흐름(OBV)이 평균 위 — 매수세 유입", "거래량 흐름(OBV)이 평균 아래 — 매도세 우세"),
    "mfi": ("MFI {mfi:.0f} — 자금 유출이 지나침", "MFI {mfi:.0f} — 자금 유입이 지나침"),
    "roc": ("12일 변화율 {roc:+.1f}%", "12일 변화율 {roc:+.1f}%"),
    "cloud": ("가격이 일목 구름 위", "가격이 일목 구름 아래"),
    "tk": ("일목 전환선이 기준선 위", "일목 전환선이 기준선 아래"),
    "sar": ("파라볼릭 SAR 상승 방향", "파라볼릭 SAR 하락 방향"),
    "disparity": ("20일 이격도 {disparity:.0f} — 평균보다 많이 낮음", "20일 이격도 {disparity:.0f} — 평균보다 많이 높음"),
}
SIGNAL_TEXT = {"surge": "급등", "plunge": "급락", "vol_spike": "거래량 급증", "rsi_os": "낙폭 과대", "rsi_ob": "단기 과열",
               "golden": "상승 전환(골든크로스)", "dead": "하락 전환(데드크로스)", "align_up": "상승 추세(정배열)",
               "align_down": "하락 추세(역배열)", "bb_up": "볼린저 상단 돌파", "bb_down": "볼린저 하단 이탈",
               "macd_up": "MACD 상향 돌파", "macd_down": "MACD 하향 돌파", "new_high": "최근 1년 최고가 돌파", "new_low": "최근 1년 최저가 이탈"}


def brief(sym, name, market, price, chg, a):
    """collector/indicators.analyze() 결과 → 해설용 요약 (지표 표를 쉬운 문장으로)"""
    vals = {k: a.get(k) for k in ("rsi", "willr", "adx", "mfi", "roc", "disparity")}
    pos, neg, ma_up, ma_dn = [], [], [], []
    for k, v in a.get("votes") or []:
        if k.startswith("ma") and k[2:].isdigit():
            (ma_up if v > 0 else ma_dn).append(k[2:])
            continue
        if k not in VOTE_TEXT or not v:
            continue
        try:
            text = VOTE_TEXT[k][0 if v > 0 else 1].format(**{x: (y if y is not None else 0) for x, y in vals.items()})
        except (ValueError, KeyError):
            continue
        (pos if v > 0 else neg).append(text)
    if ma_up:
        pos.insert(0, f"가격이 {'·'.join(ma_up)}일 평균 위")
    if ma_dn:
        neg.insert(0, f"가격이 {'·'.join(ma_dn)}일 평균 아래")
    obj = []
    adx = a.get("adx")
    if adx is not None:
        obj.append(f"ADX {adx:.0f} — 추세가 {'뚜렷함' if adx >= 25 else '약함' if adx < 20 else '보통'}")
    if a.get("atrPct") is not None:
        obj.append(f"하루 평균 움직임(ATR) {a['atrPct']:.1f}%")
    if a.get("volRatio") is not None:
        obj.append(f"오늘 거래량은 20일 평균의 {a['volRatio']:.1f}배")
    sig = [SIGNAL_TEXT[s] for s in a.get("signals") or [] if s in SIGNAL_TEXT]
    if sig:
        obj.append("신호: " + ", ".join(sig[:4]))
    op = a.get("opinion") or {}
    return {"sym": sym, "name": name, "market": market, "price": price, "chg": chg, "op": op.get("label"),
            "buy": op.get("buy", 0), "sell": op.get("sell", 0), "neutral": op.get("neutral", 0), "pos": pos, "neg": neg, "obj": obj}


def describe(b):
    """브리프 하나 → 프롬프트 글 (짧게)"""
    p = b.get("price")
    price = "-" if p is None else f"{p:,.0f}" if p >= 100 else f"{p:,.4g}"
    lines = [f"{b['name']} ({MARKET_NAME.get(b['market'], b['market'])}) 현재가 {price} ({(b.get('chg') or 0):+.2f}%)"]
    if b.get("op"):
        lines.append(f"종합 의견: {b['op']} (매수 {b.get('buy', 0)} · 중립 {b.get('neutral', 0)} · 매도 {b.get('sell', 0)})")
    for key, label in (("pos", "긍정"), ("neg", "부정"), ("obj", "객관")):
        xs = [str(x) for x in (b.get(key) or [])][:4]
        if xs:
            lines.append(f"{label}: " + " / ".join(xs))
    return "\n".join(lines)


def parse(text, n):
    out = {}
    for x in cf_ai.json_array(text):
        if not isinstance(x, dict):
            continue
        try:
            i, s = int(x.get("i")), round(float(x.get("s")))
        except (TypeError, ValueError):
            continue
        body = " ".join(str(x.get("x") or "").split())
        if not 0 <= i < n or i in out or not -2 <= s <= 2 or len(body) < 10:
            continue
        out[i] = {"x": body[:260], "s": s}
    return out


def pick(briefs):
    """시장별 상위 종목만 (briefs 는 시장마다 거래대금·시가총액 순으로 들어온다)"""
    seen, out = {}, []
    for b in briefs:
        m = b.get("market")
        if seen.get(m, 0) < TOP_N.get(m, 0):
            seen[m] = seen.get(m, 0) + 1
            out.append(b)
    return out


def run(briefs, path, usage_path=None, force=False):
    if not cf_ai.enabled():
        print("[종목 AI] CF_ACCOUNT_ID / CF_AI_TOKEN 이 없어 건너뜀")
        return
    db = load(path)
    last = db.get("updatedAt")
    if not force and last:
        try:
            age = (datetime.now(timezone.utc) - datetime.fromisoformat(last)).total_seconds() / 3600
            if age < STALE_HOURS:
                return  # 아직 새것 — 조용히 건너뛴다
        except ValueError:
            pass
    budget = cf_ai.Budget(usage_path or Path(path).with_name("ai_usage.json"))
    if not force and budget.used >= START_BELOW:
        print(f"[종목 AI] 오늘 AI 사용량 어림 {budget.used:.0f} 뉴런 — 뉴스 몫을 남기려고 건너뜀")
        return
    todo = pick(briefs)
    items, t0, done, err = {}, time.time(), 0, ""
    try:
        for i in range(0, len(todo), BATCH):
            if budget.left() <= 0:
                raise cf_ai.Stop(f"오늘 무료 사용량 어림 {budget.used:.0f} 뉴런 — 내일(UTC) 다시")
            if time.time() - t0 > TIME_BUDGET:
                raise cf_ai.Stop("이번 실행 시간 초과")
            batch = todo[i:i + BATCH]
            user = f"종목 {len(batch)}개\n\n" + "\n\n".join(f"[{j}]\n{describe(b)}" for j, b in enumerate(batch))
            text, neurons = cf_ai.chat(SYSTEM, user, max_tokens=170 * len(batch) + 100, temperature=0.2)
            budget.add("stock", neurons)
            try:
                got = parse(text, len(batch))
            except ValueError:
                got = {}
            for j, b in enumerate(batch):
                if j in got:
                    items[b["sym"]] = {**got[j], "at": int(time.time())}
                    done += 1
    except cf_ai.Stop as e:
        err = str(e)
        print(f"[종목 AI] 멈춤: {err}")
    budget.save()
    if not items and err:  # 한 개도 못 했으면 이전 해설을 그대로 둔다 (다음 실행에 다시)
        return
    # 이번에 못 한 종목은 이전 해설을 남긴다 (36시간 넘은 것은 버린다)
    keep_after = time.time() - 36 * 3600
    for sym, v in (db.get("items") or {}).items():
        if sym not in items and isinstance(v, dict) and v.get("at", 0) > keep_after:
            items[sym] = v
    out = {"updatedAt": now_iso(), "model": cf_ai.MODEL, "usage": budget.snapshot(), "items": items}
    if err:
        out["error"] = err[:300]
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    tmp.replace(p)
    print(f"[종목 AI] {len(todo)}종목 중 {done}개 해설 / 오늘 AI 전체 어림 {budget.used:.0f} 뉴런 / {time.time() - t0:.0f}초")
