"""종목 AI 해설 — 기술적 분석 근거를 AI(Gemma, 무료)가 쉬운 말로 3문장 안팎 정리. 돌려 가며 조금씩

클로드는 쓰지 않는다 — 종목 해설은 Gemma 그대로 (사용자 결정 2026-10-28. 클로드는 새 예측 문장만, ai.py).
비밀값(CF_ACCOUNT_ID / CF_AI_TOKEN)이 없으면 아무것도 하지 않는다 (이전 해설 파일은 그대로).

대상 (2026-10-29 '시총과 상관없이 분석해서 알려줘'):
    업비트 원화 전 종목 + 바이낸스 상위 20 · 국내 상위 30 · 미국 상위 30 (거래대금·시가총액 순, ROTATE_N)
    + 우선 종목: 추천(recommend.json) · 예측 상위(predict/summary.json 시장별 5) · 펌핑 상위(pump.json 10 — 없거나 모양이 달라도 건너뜀)
순서: 우선 종목 중 3시간(PRIORITY_HOURS) 지난 것 → 나머지 중 오래된 것(해설이 아직 없는 것)부터.
      어떤 종목도 3시간(STALE_HOURS) 안에는 다시 하지 않는다.
양:   무료 사용량은 뉴스 판단·예측 문장과 함께 쓴다 (cf_ai.Budget, 하루 8,000 뉴런 어림 — 뉴스 판단이 먼저).
      종목 해설은 하루 4,500 뉴런(DAILY) · 오늘 AI 전체 6,000(TOTAL_STOP)까지만. 남은 몫을 그날(UTC) 남은 시간에 고르게 나눠
      한 실행에 쓸 몫을 정하고(실행은 실제로 40~70분마다), 한 실행 150초(TIME_BUDGET)를 넘기지 않는다.
      해설 하나 ≈ 5.4 뉴런 (2026-10-28 실측: 약 120개에 643 뉴런) → 하루 800개 안팎.

입력(brief): collect.py 가 일봉 지표를 계산하면서 모은 종목별 요약 — 시장마다 거래대금·시가총액 순으로 TOP_N 개
    (요약은 계산이 거의 들지 않아 전 종목을 모아 두고, 해설할 종목은 여기서 고른다. 요약이 없는 우선 종목은 건너뛴다)
    {"sym", "name", "market", "price", "chg", "op", "buy", "sell", "neutral", "pos": [...], "neg": [...], "obj": [...]}
결과: data/stock_ai.json
    {"updatedAt", "model", "usage": {...}, "items": {"<sym>": {"x": 해설, "s": -2~2, "at": 판단 시각}}, "queue": 차례를 기다리는 수}
    해설은 48시간(KEEP_HOURS) 동안 남는다 — 이번에 못 한 종목은 이전 해설을 보인다.
"""
import json
import re
import time
from datetime import datetime, timezone
from pathlib import Path

import cf_ai

TOP_N = {"upbit": 10_000, "binance": 10_000, "krx": 10_000, "us": 10_000}  # collect.py 가 모을 해설용 요약 수 (사실상 전 종목)
ROTATE_N = {"upbit": 10_000, "binance": 20, "krx": 30, "us": 30}  # 돌려 가며 해설할 기본 대상 (업비트 원화는 전 종목)
PRED_TOP, PUMP_TOP = 5, 10  # 우선 종목: 예측 상위(시장별) · 펌핑 상위
PRIORITY_HOURS = 3  # 우선 종목은 이보다 오래되면 다시
STALE_HOURS = 3  # 어떤 종목도 이 시간 안에는 다시 하지 않는다
KEEP_HOURS = 48  # 이보다 오래된 해설은 버린다
DAILY = 4500  # 종목 해설이 하루(UTC)에 쓰는 뉴런 상한
TOTAL_STOP = 6000  # 오늘 AI 전체 사용량이 이만큼이면 해설은 멈춘다 (뉴스 판단·예측 문장 몫을 남긴다)
PER_ITEM = 5.5  # 해설 하나에 드는 뉴런 어림 (이번 실행에서 실제로 잰 값이 생기면 그것)
BATCH = 5
TIME_BUDGET = 150
SYM_RE = re.compile(r"^(upbit|binance|krx|us):[A-Za-z0-9._-]{1,24}$")
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


def _read(path):
    try:
        d = json.loads(Path(path).read_text(encoding="utf-8"))
        return d if isinstance(d, (dict, list)) else {}
    except Exception:
        return {}


def _syms_in(x, depth=0):
    """JSON 안의 'sym' 값을 나온 순서대로 (펌핑 파일처럼 모양을 아직 모르는 파일용 · 제외 목록은 건너뜀)"""
    if depth > 4:
        return []
    if isinstance(x, list):
        return [s for v in x for s in _syms_in(v, depth + 1)]
    if not isinstance(x, dict):
        return []
    out = [x["sym"]] if isinstance(x.get("sym"), str) else []
    for k, v in x.items():
        if k not in ("excluded", "exclude", "skipped", "avoid", "history", "past", "backtest", "notes", "all", "universe", "summary", "log"):
            out += _syms_in(v, depth + 1)
    return out


def priority(data_dir):
    """우선 종목 → [sym …] (추천 → 예측 상위 → 펌핑 상위 순). 파일이 없거나 모양이 달라도 조용히 건너뛴다"""
    out = []

    def add(s):
        if isinstance(s, str) and SYM_RE.match(s) and s not in out:
            out.append(s)

    data_dir = Path(data_dir)
    groups = _read(data_dir / "recommend.json")
    groups = groups.get("groups") if isinstance(groups, dict) else None
    for g in (groups.values() if isinstance(groups, dict) else []):
        for it in (g.get("items") if isinstance(g, dict) and isinstance(g.get("items"), list) else []):
            add(it.get("sym") if isinstance(it, dict) else None)
    markets = _read(data_dir / "predict" / "summary.json")
    markets = markets.get("markets") if isinstance(markets, dict) else None
    for m in (markets.values() if isinstance(markets, dict) else []):
        picks = [p for p in (m.get("picks") if isinstance(m, dict) and isinstance(m.get("picks"), list) else []) if isinstance(p, dict)]
        picks.sort(key=lambda p: p["rank"] if isinstance(p.get("rank"), (int, float)) else 1e9)
        for p in picks[:PRED_TOP]:
            add(p.get("sym"))
    pump = _read(data_dir / "pump.json")
    if isinstance(pump, dict):  # 상위 목록(top·items …)이 보이면 그것만, 아니면 파일 안의 sym 을 나온 순서대로 (전 종목 요약은 건너뜀)
        lst = next((pump[k] for k in ("top", "items", "picks", "rows", "list") if isinstance(pump.get(k), list)), None)
        pump = lst if lst is not None else pump
    n0 = len(out)
    for s in _syms_in(pump):
        if len(out) - n0 >= PUMP_TOP:
            break
        add(s)
    return out


def plan(briefs, items, prio, now=None):
    """이번에 해설할 차례 → ([brief …], 요약이 없어 건너뛴 우선 종목). 우선 종목 먼저, 다음은 오래된 것(없는 것)부터"""
    now = time.time() if now is None else now
    by_sym, seen, pool = {}, {}, []
    for b in briefs:
        sym, m = b.get("sym"), b.get("market")
        if not sym or sym in by_sym:
            continue
        by_sym[sym] = b
        seen[m] = seen.get(m, 0) + 1
        if seen[m] <= ROTATE_N.get(m, 0):
            pool.append(sym)

    def age(s):
        v = items.get(s)
        at = v.get("at") if isinstance(v, dict) else 0
        return now - (at if isinstance(at, (int, float)) else 0)

    first = [s for s in prio if s in by_sym and age(s) >= PRIORITY_HOURS * 3600]
    taken = set(first)
    rest = sorted((s for s in pool if s not in taken and age(s) >= STALE_HOURS * 3600), key=lambda s: -age(s))  # 안정 정렬 — 같으면 상위 종목 먼저
    return [by_sym[s] for s in first + rest], [s for s in prio if s not in by_sym]


def allowance(budget, now=None):
    """이번 실행에 종목 해설로 쓸 뉴런 — 오늘 남은 몫을 그날(UTC) 남은 시간에 고르게 (실행은 대략 1시간에 한 번)"""
    left = min(DAILY - budget.used_by("stock"), TOTAL_STOP - budget.used, budget.left())
    if left <= 0:
        return 0.0
    d = datetime.fromtimestamp(time.time() if now is None else now, timezone.utc)
    hours_left = 24 - d.hour - d.minute / 60
    return left / max(1.0, hours_left)


def run(briefs, path, usage_path=None, force=False):
    """해설할 차례인 종목을 이번 실행 몫만큼 해설해 path 에 저장한다 (force: 몫·시간 간격 무시 — 손으로 돌려 볼 때)"""
    if not cf_ai.enabled():
        print("[종목 AI] CF_ACCOUNT_ID / CF_AI_TOKEN 이 없어 건너뜀")
        return
    db = load(path)
    old = db.get("items") or {}
    todo, missing = plan(briefs, {} if force else old, priority(Path(path).parent))
    if missing:
        print(f"[종목 AI] 요약이 없어 건너뛴 우선 종목 {len(missing)}개: {', '.join(missing[:6])}")
    if not todo:
        return  # 모두 3시간 안에 해설함 — 조용히 건너뛴다
    budget = cf_ai.Budget(usage_path or Path(path).with_name("ai_usage.json"))
    allow = float("inf") if force else allowance(budget)
    items, t0, done, spent, asked, err = {}, time.time(), 0, 0.0, 0, ""
    try:
        for i in range(0, len(todo), BATCH):
            batch = todo[i:i + BATCH]
            per = spent / asked if asked else PER_ITEM
            if spent + per * len(batch) > allow:
                if not force and budget.used_by("stock") >= DAILY:
                    err = f"오늘 해설 몫 {DAILY:,} 뉴런을 다 씀 — 내일(UTC) 다시"
                elif not force and budget.used >= TOTAL_STOP:
                    err = f"오늘 AI 전체 {budget.used:,.0f} 뉴런 — 뉴스 판단 몫을 남기려고 멈춤"
                break  # 이번 실행 몫을 다 씀 — 다음 실행에 이어서
            if budget.left() <= 0:
                raise cf_ai.Stop(f"오늘 무료 사용량 어림 {budget.used:.0f} 뉴런 — 내일(UTC) 다시")
            if time.time() - t0 > TIME_BUDGET:
                raise cf_ai.Stop("이번 실행 시간 초과 — 다음 실행에 이어서")
            user = f"종목 {len(batch)}개\n\n" + "\n\n".join(f"[{j}]\n{describe(b)}" for j, b in enumerate(batch))
            text, neurons = cf_ai.chat(SYSTEM, user, max_tokens=170 * len(batch) + 100, temperature=0.2)
            budget.add("stock", neurons)
            spent, asked = spent + neurons, asked + len(batch)
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
    if not items:  # 한 개도 못 했으면 이전 해설 파일을 그대로 둔다 (다음 실행에 다시)
        if err:
            print(f"[종목 AI] 이번엔 해설 못 함 — {err}")
        return
    # 이번에 못 한 종목은 이전 해설을 남긴다 (48시간 넘은 것은 버린다)
    keep_after = time.time() - KEEP_HOURS * 3600
    for sym, v in old.items():
        if sym not in items and isinstance(v, dict) and v.get("at", 0) > keep_after:
            items[sym] = v
    out = {"updatedAt": now_iso(), "model": cf_ai.MODEL, "usage": budget.snapshot(), "items": items, "queue": len(todo) - done}
    if err:
        out["error"] = cf_ai.scrub(err)[:300]
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    tmp.replace(p)
    print(f"[종목 AI] 차례 {len(todo)}종목 중 {done}개 해설 · 이번 {spent:.0f} 뉴런(몫 {allow:.0f}) / "
          f"해설 오늘 {budget.used_by('stock'):.0f} · AI 전체 {budget.used:.0f} 뉴런 / {time.time() - t0:.0f}초")
