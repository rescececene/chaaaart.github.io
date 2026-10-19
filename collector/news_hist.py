"""코인별 뉴스 이력 누적 + 사이트용 '최근 뉴스 상태' — 표준 라이브러리만 (collect.py 가 부른다)

collect.py 가 10분마다 받은 속보(news.json 의 topics)로:
  (a) data/news_hist.json 에 누적 — Actions 캐시(web/public/data)로 다음 실행에 이어진다
      · art  : 코인 속보 기사별 기록 (최근 ART_DAYS 일, 제목·본문은 저장하지 않음)
               투표 수는 '게시 뒤 VOTE_WINDOW_H 시간 안'에 본 마지막 값만 남긴다. 코인니스 표는 하루 동안 계속 쌓여서
               (게시 5시간 뒤 ≈ 최종 표의 40~50%), 나중 표에는 가격이 움직인 걸 보고 누른 표가 섞일 수 있다 → 앞으로 미래 정보 누수 없이 다시 검증할 수 있게.
               AI 판단(news_ai.json)이 있으면 그 점수도 남긴다 (AI 판단이 맞는지 나중에 검증할 재료)
      · days : 코인·날(UTC — 업비트 원화 일봉과 같은 경계, 한국 9시)별 집계 (최근 KEEP_DAYS 일)
      · us   : 네이버 해외 속보의 관련 미국 종목·날별 기사 수 (관심도만. 과거를 받을 수 없어 앞으로 쌓는다)
  (b) data/news_state.json — 코인별 최근 1일·3일 뉴스 상태 + 과거 사건 연구(백테스트) 결과(STUDY). 사이트가 읽는다.

사건 연구 결론 (자세한 표는 STUDY, 방법은 STUDY["method"]):
  · '호재' 투표·호재 단어가 나온 뒤의 수익률은 보통 뉴스가 나온 날과 거의 같다 (7일 차이 +0.4%p 안팎, 수익률 퍼짐의 몇십 분의 1)
    → 호재·악재는 참고로만 보여 주고 기대 수익률에 섞지 않는다.
  · 예외 하나: 업비트 신규 상장 소식 뒤에는 뚜렷하게 약했다 (7일 중앙값 −11%, 오른 비율 24%, 표본 153 · 기간 반으로 나눠도 같음)
    → '호재처럼 보이지만 과거엔 대체로 내렸다'는 주의 표시로 쓴다.

    python collector/news_hist.py              # data/news.json 으로 한 번 갱신 (news_hist.json · news_state.json 쓰기)
    python collector/news_hist.py --dry        # 파일을 쓰지 않고 요약만
    python collector/news_hist.py --recheck    # 쌓인 이력 + data/candles/upbit 로 사건 연구를 다시 (누수 없는 투표로)
"""
import json
import math
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "web" / "public" / "data"
HIST_FILE, STATE_FILE = "news_hist.json", "news_state.json"
VERSION = 1
ART_DAYS = 4            # 기사별 기록 보관 일수 (최근 3일 상태 + 날 경계 여유)
KEEP_DAYS = 400         # 코인·날별 집계 보관 일수
EVENT_DAYS = 7          # 상장·상폐·해킹 같은 사건 표시를 유지하는 일수
VOTE_WINDOW_H = 6       # 게시 뒤 이 시간까지만 투표 수를 갱신한다 (최신 40건 창에 머무는 시간 ≈ 5시간)
MAX_BYTES = 700_000     # news_hist.json 이 이보다 크면 오래된 날부터 덜어 낸다
MIN_VOTES = 20          # 투표 판단에 필요한 최소 표 수 (web/src/lib/newsTag.ts 와 같다)
MIN_REF = 60            # 상대 기준(분위)을 직접 계산하는 데 필요한 기사 수 — 모자라면 FALLBACK
Q_GOOD, Q_BAD = 0.80, 0.10   # 투표 호재 = 같은 시기 코인 기사 중 호재 표 비율 상위 20%, 투표 악재 = 하위 10% (사건 연구와 같은 정의)
FALLBACK = {"base": 0.84, "good": 0.05, "bad": -0.18}  # 최근 6개월(2026-04~10) 코인 기사 최종 표 기준: 중앙값과 상위 20%·하위 10% 경계(중앙값과의 차이)
NEW_LISTING_DAYS = 10   # 업비트 원화 일봉이 이 수 이하인 코인의 상장 소식 → '업비트 신규 상장' 통계를 쓴다

# ── 제목 판단 (web/src/lib/newsTag.ts keywordHits 와 같은 규칙) ──
POS = [
    (re.compile(r"폭등|급등|불기둥|사상\s?최고|역대\s?최[대고]|신고가|최고치\s?경신"), 2),
    (re.compile(r"(?:ETF|상장)\s?승인|승인\s?(?:받|획득)|현물\s?ETF"), 2),
    (re.compile(r"상향|호실적|어닝\s?서프라이즈|흑자\s?전환|수주|대규모\s?(?:투자|계약)|파트너십|인수|합병|자사주\s?(?:매입|소각)|추가\s?매수|매집"), 1),
    (re.compile(r"상승|반등|강세|돌파|순매수|순유입|유입|기대감|수혜|호재|증가|확대|상장(?!\s?(?:폐지|사|기업|된|한))|채택|협력|출시|승인|획득"), 1),
]
NEG = [
    (re.compile(r"폭락|급락|붕괴|해킹|파산|상장\s?폐지|사기|뱅크런|디폴트|청산\s?폭탄|러그\s?풀"), 2),
    (re.compile(r"소송|기소|제재|조사\s?착수|압수수색|규제\s?강화|금지"), 2),
    (re.compile(r"하향|어닝\s?쇼크|적자|손실|감원|리콜|중단|연기|부진|경고|우려|악재|최저|급감|하회|전량\s?매도"), 1),
    (re.compile(r"하락|약세|순매도|순유출|유출|매도\s?(?:압력|세)|감소|축소|둔화|불안"), 1),
]
CONTRAST = re.compile(r"지만|에도\s|는데\s|불구하고")
MACRO = re.compile(r"금리|국채|채권|환율|원[/·]달러|달러\s?(?:인덱스|지수|가치)|물가|인플레(?:이션)?|CPI|PPI|PCE|실업률|국제\s?유가|(?<![가-힣])유가(?!증권)|WTI|브렌트유|VIX|변동성\s?지수|공포\s?지수")
MOVE_WORDS = re.compile(r"폭등|급등|폭락|급락|불기둥|사상\s?최[고저]|역대\s?최[대고저]|신고가|신저가|최고치(?:\s?경신)?|최저치?|상승|하락|반등|강세|약세|돌파|상회|하회|급감|증가|감소|확대|축소|둔화")
# 가격 움직임 자체를 전하는 기사(사후 보도) — 'SOL, 지난 5분간 3.6% 상승', 'BTC $75,000 하회' 등. 호재·악재 집계에서 뺀다
PRICE_MOVE = re.compile(r"\d[\d,.]*\s?%|[$＄]\s?\d|\d\s?(?:달러|원|불)\s?(?:돌파|상회|하회|회복|붕괴)|급등|급락|폭등|폭락|신고가|신저가|상승세|하락세|"
                        r"반등|돌파|하회|상회|일시\s?(?:상승|하락)|(?:상승|하락)폭|(?:상승|하락)(?:\s|$|…|,)|강세|약세|불기둥|최고치|최저치")
# 사건 종류 (사건 연구에서 따로 본 것)
KR_LIST = re.compile(r"(?:업비트|빗썸|코인원|코빗|고팍스).{0,40}(?:상장|마켓\s?추가|원화\s?마켓)")
GL_LIST = re.compile(r"(?:바이낸스|코인베이스|OKX|바이비트|로빈후드|크라켄|비트겟|게이트|쿠코인|HTX).{0,40}(?:상장|마켓\s?추가|거래\s?지원|페어\s?추가)")
NOT_LIST = re.compile(r"상폐|상장\s?폐지|폐지|중단|종료|선물|무기한|마진|철회|상장사|상장\s?기업|ETF|상장\s?추진|IPO|나스닥|NYSE|주식")
DELIST = re.compile(r"상폐|상장\s?폐지|유의\s?종목|거래\s?지원\s?종료|투자\s?유의|경고\s?지정")
HACK = re.compile(r"해킹|탈취|도난|익스플로잇|exploit|러그\s?풀", re.I)


def keyword_level(text):
    """제목 좋은 말·나쁜 말 점수 → -2~2 (newsTag.ts 와 같은 기준: ±2 이상 1, ±4 이상 2)"""
    cut, ln = -1, 0
    for m in CONTRAST.finditer(text):
        cut, ln = m.start(), len(m.group(0))
    segs = [(text, 1.0)] if cut < 0 else [(text[:cut], 0.5), (text[cut + ln:], 1.5)]
    if MACRO.search(text):
        segs = [(MOVE_WORDS.sub(" ", t), k) for t, k in segs]
    s = 0.0
    for part, k in segs:
        s += sum(w * k for rx, w in POS if rx.search(part))
        s -= sum(w * k for rx, w in NEG if rx.search(part))
    return 2 if s >= 4 else 1 if s >= 2 else -2 if s <= -4 else -1 if s <= -2 else 0


def event_tags(title):
    """upbitList 업비트 상장 · krList 국내 다른 거래소 상장 · glList 해외 거래소 상장 · delist 상폐·유의 · hack 해킹·도난"""
    tags = []
    listing = not NOT_LIST.search(title)
    if listing and KR_LIST.search(title):
        tags.append("upbitList" if "업비트" in title else "krList")
    elif listing and GL_LIST.search(title):
        tags.append("glList")
    if DELIST.search(title):
        tags.append("delist")
    if HACK.search(title):
        tags.append("hack")
    return tags


def _day(ts):
    return datetime.fromtimestamp(ts, timezone.utc).strftime("%Y-%m-%d")


def _quantile(xs, q):
    xs = sorted(xs)
    if not xs:
        return None
    k = (len(xs) - 1) * q
    lo, hi = math.floor(k), math.ceil(k)
    return xs[lo] + (xs[hi] - xs[lo]) * (k - lo)


def load(path):
    try:
        d = json.loads(Path(path).read_text(encoding="utf-8"))
        if isinstance(d, dict) and d.get("v") == VERSION:
            for k in ("art", "days", "usSeen", "us"):
                if not isinstance(d.get(k), dict):
                    d[k] = {}
            return d
    except Exception:
        pass
    return {"v": VERSION, "art": {}, "days": {}, "usSeen": {}, "us": {}}


def _ai_tags(out_dir):
    try:
        return json.loads((Path(out_dir) / "news_ai.json").read_text(encoding="utf-8")).get("tags") or {}
    except Exception:
        return {}


def update(hist, topics, now=None, ai=None):
    """이번 실행에 받은 속보를 이력에 더한다"""
    now = int(now or time.time())
    ai = ai or {}
    by_key = {t.get("key"): t.get("items") or [] for t in topics}
    art = hist["art"]
    for it in by_key.get("coinflash", []):
        i, ts = str(it.get("id") or ""), it.get("ts")
        if not i or not ts:
            continue
        rec = art.get(i)
        if rec is None:
            title = it.get("title") or ""
            rec = art[i] = {"t": int(ts), "f": now, "c": [str(c).upper() for c in (it.get("codes") or []) if c],
                            "i": int(bool(it.get("important"))), "m": int(bool(PRICE_MOVE.search(title))),
                            "k": keyword_level(title), "g": event_tags(title)}
        if now - rec["t"] <= VOTE_WINDOW_H * 3600:  # 게시 뒤 몇 시간 안의 표만
            if it.get("bull") is not None and it.get("bear") is not None:
                rec["b"], rec["r"], rec["s"] = int(it["bull"]), int(it["bear"]), now - rec["t"]  # s = 게시 뒤 몇 초에 본 표인지
            rec["i"] = max(rec["i"], int(bool(it.get("important"))))
        a = ai.get(f"coinflash:{i}")
        if isinstance(a, dict) and a.get("s") in (-2, -1, 0, 1, 2):
            rec["a"] = a["s"]
    # 해외 속보 — 네이버가 붙인 관련 미국 종목별 기사 수 (같은 기사는 한 번만)
    seen = hist["usSeen"]
    for it in by_key.get("world", []):
        i, ts = str(it.get("id") or ""), it.get("ts")
        if not i or not ts or i in seen:
            continue
        seen[i] = int(ts)
        for s in {r["sym"] for r in (it.get("rel") or []) if isinstance(r, dict) and r.get("sym")}:
            day = hist["us"].setdefault(_day(ts), {})
            day[s] = day.get(s, 0) + 1
    hist["art"] = {k: v for k, v in art.items() if v["t"] >= now - ART_DAYS * 86400}
    hist["usSeen"] = {k: v for k, v in seen.items() if v >= now - 3 * 86400}
    _rebuild_days(hist, now)
    keep = _day(now - KEEP_DAYS * 86400)
    hist["days"] = {d: v for d, v in hist["days"].items() if d >= keep}
    hist["us"] = {d: v for d, v in hist["us"].items() if d >= keep}
    hist["updatedAt"] = datetime.fromtimestamp(now, timezone.utc).isoformat(timespec="seconds")
    return hist


def vote_ref(hist):
    """같은 시기 '코인이 붙은' 기사들의 호재 표 비율 기준 — 중앙값(base)과 상위 20%·하위 10% 경계(중앙값과의 차이).
    코인니스 코인 속보는 보통 기사도 호재 표가 84~92% 라서(시기마다 다름) 절대 기준 대신 상대 순위를 쓴다."""
    ps = [r["b"] / (r["b"] + r["r"]) for r in hist["art"].values() if r["c"] and r.get("b") is not None and r["b"] + r["r"] >= MIN_VOTES]
    if len(ps) < MIN_REF:
        return dict(FALLBACK, n=len(ps), fallback=True)
    base = _quantile(ps, 0.5)
    return {"base": round(base, 4), "good": round(_quantile(ps, Q_GOOD) - base, 4), "bad": round(_quantile(ps, Q_BAD) - base, 4), "n": len(ps), "fallback": False}


def vote_tone(rec, ref):
    """1 = 투표 호재(상대 상위 20%), -1 = 투표 악재(하위 10%), 0 = 보통, None = 표 부족"""
    b, r = rec.get("b"), rec.get("r")
    if b is None or b + r < MIN_VOTES:
        return None
    rel = b / (b + r) - ref["base"]
    return 1 if rel >= ref["good"] else -1 if rel <= ref["bad"] else 0


# 코인·날 집계 열 — n 기사 수 · vg/vb 투표 호재/악재 · kg/kb 제목 좋은 말/나쁜 말 · imp 중요 표시 · mv 가격 보도
#                  ul 업비트 상장 · kl 국내 다른 거래소 상장 · gl 해외 거래소 상장 · dl 상폐·유의 · hk 해킹 · ag/ab AI 호재/악재
DAY_COLS = ("n", "vg", "vb", "kg", "kb", "imp", "mv", "ul", "kl", "gl", "dl", "hk", "ag", "ab")
_TAG_COL = {"upbitList": "ul", "krList": "kl", "glList": "gl", "delist": "dl", "hack": "hk"}


def _row(rec, ref):
    tone = None if rec["m"] else vote_tone(rec, ref)
    kw = 0 if rec["m"] else rec["k"]
    a = rec.get("a")
    v = {"n": 1, "vg": int(tone == 1), "vb": int(tone == -1), "kg": int(kw >= 1), "kb": int(kw <= -1), "imp": rec["i"], "mv": rec["m"],
         "ag": int(a is not None and a >= 1), "ab": int(a is not None and a <= -1)}
    for g in rec["g"]:
        v[_TAG_COL[g]] = 1
    return [v.get(c, 0) for c in DAY_COLS]


def _rebuild_days(hist, now):
    """기사 기록이 온전히 남아 있는 날(오늘 포함 ART_DAYS-1 일)만 다시 집계한다. 그보다 오래된 날은 굳힌다."""
    ref = vote_ref(hist)
    first = _day(now - (ART_DAYS - 1) * 86400)
    fresh = {}
    for rec in hist["art"].values():
        d = _day(rec["t"])
        if d < first:
            continue
        row = _row(rec, ref)
        for c in rec["c"]:
            cur = fresh.setdefault(d, {}).setdefault(c, [0] * len(DAY_COLS))
            for j, v in enumerate(row):
                cur[j] += v
    for d in [d for d in hist["days"] if d >= first]:
        del hist["days"][d]
    hist["days"].update(fresh)
    hist["dayCols"] = list(DAY_COLS)


def trim(hist):
    """파일 크기 제한 — 오래된 날부터 덜어 낸다"""
    while len(json.dumps(hist, separators=(",", ":"))) > MAX_BYTES and (hist["days"] or hist["us"]):
        oldest = min(list(hist["days"]) + list(hist["us"]))
        hist["days"].pop(oldest, None)
        hist["us"].pop(oldest, None)
    return hist


def _upbit_days(out_dir, code):
    """업비트 원화 일봉 수 (collect.py 가 쓰는 candles/upbit 파일 · 최대 200) — 없으면 None"""
    try:
        return len(json.loads((Path(out_dir) / "candles" / "upbit" / f"KRW-{code}.json").read_text(encoding="utf-8"))["c"])
    except Exception:
        return None


STATE_COLS = ("n", "voteGood", "voteBad", "kwGood", "kwBad", "important")


def coin_state(hist, now=None, out_dir=OUT):
    """코인별 최근 뉴스 상태
    d1·d3: 최근 24시간·72시간 [기사 수, 투표 호재, 투표 악재, 제목 좋은 말, 제목 나쁜 말, 중요 표시] (가격 보도 기사는 호재·악재에서 뺌)
    tags : 최근 EVENT_DAYS 일 사건 (upbitList krList glList delist hack) · last: 마지막 기사 시각
    tone : 최근 3일 호재·악재 우세 (1/0/-1 — 참고용, 수익률 예측력은 검증되지 않음)
    study: 이 코인에 맞는 STUDY 묶음 키 (사이트가 과거 통계 카드를 고를 때)"""
    now = int(now or time.time())
    ref = vote_ref(hist)
    out = {}

    def slot(c):
        return out.setdefault(c, {"d1": [0] * 6, "d3": [0] * 6, "last": 0, "tags": []})
    for rec in hist["art"].values():
        age = now - rec["t"]
        if age < 0 or age > 3 * 86400:
            continue
        row = dict(zip(DAY_COLS, _row(rec, ref)))
        vals = [row["n"], row["vg"], row["vb"], row["kg"], row["kb"], row["imp"]]
        for c in rec["c"]:
            s = slot(c)
            for j, v in enumerate(vals):
                s["d3"][j] += v
                if age <= 86400:
                    s["d1"][j] += v
            s["last"] = max(s["last"], rec["t"])
    since = _day(now - EVENT_DAYS * 86400)  # 사건 표시는 날 집계에서 (기사 기록은 ART_DAYS 일만 있다)
    for d, coins in hist["days"].items():
        if d < since:
            continue
        for c, row in coins.items():
            for tag, col in _TAG_COL.items():
                if row[DAY_COLS.index(col)] and tag not in slot(c)["tags"]:
                    slot(c)["tags"].append(tag)
    for c, s in out.items():
        g, b = s["d3"][1] + s["d3"][3], s["d3"][2] + s["d3"][4]
        s["tone"] = 1 if g > b else -1 if b > g else 0
        if "upbitList" in s["tags"] or "krList" in s["tags"]:
            n = _upbit_days(out_dir, c)
            s["upbitDays"] = n
            s["study"] = "krListNew" if n is not None and n <= NEW_LISTING_DAYS else "krListOther"
        elif "glList" in s["tags"]:
            s["study"] = "glList"
        elif s["d3"][1] and not s["d3"][2]:
            s["study"] = "voteGood"
        elif s["d3"][2] and not s["d3"][1]:
            s["study"] = "voteBad"
        elif s["d3"][0]:
            s["study"] = "news"
    return out, ref


# ── 사건 연구(백테스트) 결과 — 사이트 표시용. scratchpad/newsfactor/run_study.py·make_study.py 로 계산 (2026-10-20) ──
STUDY = {
    "asOf": "2026-10-20",
    "verdict": "display_only",  # 기대 수익률에 섞지 않는다 (업비트 신규 상장만 '주의' 표시)
    "data": {"articles": 14289, "period": ["2024-01-17", "2026-10-19"], "coins": 271, "coinDays": 11690, "priceTo": "2026-10-18",
             "source": "코인니스 코인 속보(코인 코드가 붙은 기사, BTC·ETH 제외) ↔ 업비트 원화 일봉"},
    "method": ("기사가 나온 날(UTC 0시 = 한국 9시 경계) 다음 날 종가에 샀다고 보고 1·7·30·90일 뒤 종가까지의 수익률. "
               "투표는 하루 동안 계속 쌓이므로 표가 거의 다 모인 다음 날 종가부터 재서 미래 정보가 섞이지 않게 했다. "
               "같은 코인·같은 날 기사 여러 건은 한 번으로. 가격 움직임만 전하는 기사(사후 보도)는 호재·악재에서 뺐다. "
               "구간은 날짜 블록 부트스트랩 95% (같은 날·겹치는 기간 상관 반영). 90일은 독립 구간이 적어 참고만."),
    "fields": {"n": "표본 수(코인·날)", "raw": "수익률 분위 10·25·50·75·90 %", "rawWin": "오른 비율 %",
               "xMed": "같은 날 업비트 전체 코인 평균 대비 초과 수익 중앙값 %", "xdMed": "초과 수익에서 그 코인의 평소 수준을 뺀 값의 중앙값 % (lo/hi 95% 구간)",
               "vsNews": "보통 뉴스(기준)와의 xdMed 차이 %p (vsLo/vsHi 95% 구간, p 양측)"},
    "summary": [
        "호재 투표가 몰린 기사 뒤 7일 수익률은 보통 뉴스가 나온 날보다 중앙값으로 0.4%p 높았다 (95% 구간 0.1~0.8). 통계로는 겨우 보이지만, 7일 수익률 퍼짐(가운데 절반이 −8%~+4%)에 비하면 무시할 만큼 작다.",
        "악재 투표·제목 속 좋은 말·나쁜 말·해킹·상폐 소식 뒤에는 보통 뉴스와 뚜렷한 차이가 없었다 (상폐·악재 기사 당일엔 이미 평균보다 조금 내려 있었고, 좋은 말 기사는 앞선 3일에 이미 올라 있던 경우가 많았다).",
        "업비트 신규 상장 소식 뒤에는 뚜렷하게 약했다: 7일 중앙값 −11.4%, 30일 −23.5%, 7일 오른 비율 24% (표본 153, 기간을 반으로 나눠도 같은 방향).",
        "BTC·ETH 는 날마다 뉴스가 있어 투표 분위기로 날을 나눠 봤지만 1~30일 수익률 차이는 0 과 구별되지 않았다.",
        "코인니스 코인 속보는 보통 기사도 호재 표가 84~92% 라서, 절대 비율(55% 기준)로 나누면 거의 모든 기사가 '호재'가 된다.",
    ],
    "btceth": {"days": {"BTC": 311, "ETH": 238}, "period": ["2025-10-28", "2026-10-19"], "use": "none",
               "note": "날마다 투표 분위기 상위 1/3 날 vs 하위 1/3 날 — 1·7·30일 평균 수익률 차이 95% 구간이 모두 0 을 포함"},
    "groups": {
        "news": {"label": "뉴스가 나온 코인 (가격 보도 제외, 기준)", "use": "base", "h": {
            "1": {"n": 7225, "raw": [-5.35, -2.7, -0.31, 2.04, 5.15], "rawWin": 45.22, "xMed": -0.39, "xdMed": -0.17, "xdLo": -0.24, "xdHi": -0.11},
            "7": {"n": 7162, "raw": [-14.68, -8.24, -1.94, 5.0, 13.91], "rawWin": 41.29, "xMed": -0.76, "xdMed": -0.41, "xdLo": -0.66, "xdHi": -0.13},
            "30": {"n": 6955, "raw": [-31.94, -19.91, -6.3, 8.86, 30.47], "rawWin": 37.53, "xMed": -1.7, "xdMed": -1.16, "xdLo": -2.36, "xdHi": -0.07},
            "90": {"n": 6446, "raw": [-52.18, -39.45, -20.89, 6.21, 46.62], "rawWin": 29.69, "xMed": -2.19, "xdMed": -2.07, "xdLo": -4.05, "xdHi": -0.36}}},
        "voteGood": {"label": "투표 호재 — 호재 표 비율이 같은 시기 기사 상위 20%", "use": "weak", "h": {
            "1": {"n": 2017, "raw": [-4.69, -2.46, -0.4, 1.83, 4.69], "rawWin": 43.78, "xMed": -0.22, "xdMed": -0.06, "xdLo": -0.16, "xdHi": 0.05, "vsNews": 0.1, "vsLo": 0.01, "vsHi": 0.21, "p": 0.031},
            "7": {"n": 1991, "raw": [-13.74, -7.83, -2.26, 4.07, 12.5], "rawWin": 38.52, "xMed": 0.05, "xdMed": 0.0, "xdLo": -0.41, "xdHi": 0.43, "vsNews": 0.41, "vsLo": 0.1, "vsHi": 0.8, "p": 0.013},
            "30": {"n": 1893, "raw": [-29.02, -17.89, -4.35, 8.61, 26.44], "rawWin": 40.36, "xMed": 0.47, "xdMed": -0.39, "xdLo": -1.84, "xdHi": 0.8, "vsNews": 0.78, "vsLo": -0.09, "vsHi": 1.7, "p": 0.071},
            "90": {"n": 1656, "raw": [-47.32, -35.35, -18.48, 8.45, 38.66], "rawWin": 31.7, "xMed": 1.17, "xdMed": -1.68, "xdLo": -5.91, "xdHi": 2.06, "vsNews": 0.39, "vsLo": -1.99, "vsHi": 2.65, "p": 0.817}}},
        "voteBad": {"label": "투표 악재 — 호재 표 비율 하위 10%", "use": "none", "h": {
            "1": {"n": 834, "raw": [-6.24, -3.09, -0.48, 1.72, 4.75], "rawWin": 42.93, "xMed": -0.4, "xdMed": -0.21, "xdLo": -0.36, "xdHi": -0.07, "vsNews": -0.04, "vsLo": -0.18, "vsHi": 0.08, "p": 0.541},
            "7": {"n": 823, "raw": [-16.04, -9.49, -2.44, 3.27, 11.35], "rawWin": 37.67, "xMed": -1.11, "xdMed": -0.82, "xdLo": -1.4, "xdHi": -0.29, "vsNews": -0.41, "vsLo": -0.9, "vsHi": 0.02, "p": 0.066},
            "30": {"n": 799, "raw": [-32.82, -21.13, -6.71, 6.81, 23.74], "rawWin": 35.29, "xMed": -2.24, "xdMed": -1.96, "xdLo": -3.87, "xdHi": -0.37, "vsNews": -0.8, "vsLo": -1.95, "vsHi": 0.45, "p": 0.213},
            "90": {"n": 685, "raw": [-50.09, -38.08, -19.96, 3.56, 36.9], "rawWin": 29.05, "xMed": -0.18, "xdMed": -1.96, "xdLo": -5.4, "xdHi": 0.52, "vsNews": 0.11, "vsLo": -2.15, "vsHi": 1.64, "p": 0.95}}},
        "kwGood": {"label": "제목에 좋은 말 (사이트 핵심 단어 규칙)", "use": "none", "h": {
            "1": {"n": 336, "raw": [-4.15, -1.78, 0.01, 1.65, 4.19], "rawWin": 50.0, "xMed": -0.15, "xdMed": -0.06, "xdLo": -0.42, "xdHi": 0.28, "vsNews": 0.1, "vsLo": -0.22, "vsHi": 0.44, "p": 0.478},
            "7": {"n": 335, "raw": [-11.95, -5.48, -0.91, 4.93, 11.96], "rawWin": 44.18, "xMed": 0.3, "xdMed": -0.56, "xdLo": -1.27, "xdHi": 0.92, "vsNews": -0.15, "vsLo": -0.85, "vsHi": 1.28, "p": 0.94},
            "30": {"n": 326, "raw": [-24.37, -15.84, -4.82, 8.45, 25.29], "rawWin": 40.18, "xMed": 2.57, "xdMed": -0.12, "xdLo": -2.27, "xdHi": 2.56, "vsNews": 1.04, "vsLo": -0.8, "vsHi": 3.13, "p": 0.265},
            "90": {"n": 307, "raw": [-42.99, -34.53, -15.54, 18.61, 51.13], "rawWin": 36.81, "xMed": 5.11, "xdMed": -3.67, "xdLo": -7.79, "xdHi": 3.24, "vsNews": -1.6, "vsLo": -4.29, "vsHi": 3.76, "p": 0.626}}},
        "kwBad": {"label": "제목에 나쁜 말", "use": "none", "h": {
            "1": {"n": 246, "raw": [-5.07, -2.41, -0.1, 2.03, 5.12], "rawWin": 47.97, "xMed": -0.31, "xdMed": -0.2, "xdLo": -0.41, "xdHi": 0.21, "vsNews": -0.03, "vsLo": -0.25, "vsHi": 0.34, "p": 0.64},
            "7": {"n": 246, "raw": [-14.05, -7.93, -2.11, 4.13, 11.37], "rawWin": 42.28, "xMed": -0.53, "xdMed": -0.56, "xdLo": -1.15, "xdHi": 0.41, "vsNews": -0.16, "vsLo": -0.74, "vsHi": 0.78, "p": 0.66},
            "30": {"n": 240, "raw": [-28.01, -17.86, -6.32, 12.92, 30.63], "rawWin": 39.58, "xMed": -0.8, "xdMed": -0.04, "xdLo": -3.02, "xdHi": 1.87, "vsNews": 1.13, "vsLo": -1.36, "vsHi": 2.85, "p": 0.343},
            "90": {"n": 212, "raw": [-44.09, -26.88, -6.68, 18.79, 79.29], "rawWin": 41.04, "xMed": 4.81, "xdMed": 1.52, "xdLo": -2.62, "xdHi": 6.38, "vsNews": 3.59, "vsLo": -0.62, "vsHi": 8.94, "p": 0.082}}},
        "krListNew": {"label": "업비트 신규 상장 소식 (업비트 거래 3일 이내)", "use": "caution", "h": {
            "1": {"n": 156, "raw": [-12.31, -8.26, -3.74, 2.03, 7.85], "rawWin": 34.62, "xMed": -2.53, "xdMed": -1.87, "xdLo": -3.44, "xdHi": -1.04, "vsNews": -1.71, "vsLo": -3.3, "vsHi": -0.87, "p": 0.001},
            "7": {"n": 153, "raw": [-28.92, -22.97, -11.39, -0.92, 12.53], "rawWin": 24.18, "xMed": -8.83, "xdMed": -7.05, "xdLo": -9.68, "xdHi": -5.26, "vsNews": -6.65, "vsLo": -9.55, "vsHi": -4.74, "p": 0.0},
            "30": {"n": 150, "raw": [-52.27, -38.55, -23.5, -0.63, 24.7], "rawWin": 23.33, "xMed": -15.16, "xdMed": -11.77, "xdLo": -16.06, "xdHi": -5.95, "vsNews": -10.61, "vsLo": -14.52, "vsHi": -4.92, "p": 0.0},
            "90": {"n": 140, "raw": [-71.47, -59.82, -39.11, -16.75, 8.34], "rawWin": 15.0, "xMed": -18.56, "xdMed": -12.15, "xdLo": -16.8, "xdHi": -7.31, "vsNews": -10.08, "vsLo": -15.73, "vsHi": -5.45, "p": 0.0}}},
        "krListOther": {"label": "이미 업비트에 있는 코인의 국내 다른 거래소 상장", "use": "none", "h": {
            "1": {"n": 78, "raw": [-8.88, -4.03, -1.03, 0.85, 4.57], "rawWin": 32.05, "xMed": -1.34, "xdMed": -1.0, "xdLo": -1.64, "xdHi": -0.3, "vsNews": -0.83, "vsLo": -1.35, "vsHi": -0.1, "p": 0.017},
            "7": {"n": 78, "raw": [-17.46, -10.52, -4.01, 3.19, 15.37], "rawWin": 38.46, "xMed": -1.74, "xdMed": -1.22, "xdLo": -4.72, "xdHi": 1.82, "vsNews": -0.81, "vsLo": -4.02, "vsHi": 2.27, "p": 0.41},
            "30": {"n": 77, "raw": [-44.89, -28.42, -14.29, 12.89, 30.04], "rawWin": 40.26, "xMed": -4.92, "xdMed": -0.81, "xdLo": -6.84, "xdHi": 3.4, "vsNews": 0.36, "vsLo": -5.22, "vsHi": 4.64, "p": 0.878},
            "90": {"n": 73, "raw": [-63.79, -49.68, -31.88, 3.76, 34.27], "rawWin": 30.14, "xMed": -8.34, "xdMed": -2.81, "xdLo": -14.24, "xdHi": 2.82, "vsNews": -0.74, "vsLo": -10.54, "vsHi": 4.53, "p": 0.757}}},
        "glList": {"label": "해외 거래소 상장", "use": "weak", "h": {
            "1": {"n": 219, "raw": [-9.94, -4.48, -1.24, 2.59, 7.34], "rawWin": 43.38, "xMed": -0.86, "xdMed": -0.51, "xdLo": -1.22, "xdHi": 0.0, "vsNews": -0.34, "vsLo": -1.04, "vsHi": 0.2, "p": 0.261},
            "7": {"n": 219, "raw": [-24.78, -12.29, -4.76, 4.27, 16.32], "rawWin": 33.33, "xMed": -2.49, "xdMed": -1.57, "xdLo": -2.77, "xdHi": -0.42, "vsNews": -1.16, "vsLo": -2.33, "vsHi": 0.02, "p": 0.055},
            "30": {"n": 218, "raw": [-45.36, -30.9, -13.28, 6.3, 24.73], "rawWin": 31.65, "xMed": -6.35, "xdMed": -3.69, "xdLo": -6.97, "xdHi": -1.42, "vsNews": -2.53, "vsLo": -4.92, "vsHi": -0.03, "p": 0.046},
            "90": {"n": 215, "raw": [-66.56, -51.62, -31.76, -5.15, 32.64], "rawWin": 22.79, "xMed": -9.52, "xdMed": -5.87, "xdLo": -7.25, "xdHi": -1.9, "vsNews": -3.8, "vsLo": -5.5, "vsHi": 0.12, "p": 0.059}}},
        "hack": {"label": "해킹·도난", "use": "none", "h": {
            "1": {"n": 146, "raw": [-5.07, -2.66, -0.3, 1.97, 4.36], "rawWin": 45.89, "xMed": -0.33, "xdMed": -0.21, "xdLo": -0.65, "xdHi": 0.19, "vsNews": -0.04, "vsLo": -0.44, "vsHi": 0.36, "p": 0.654},
            "7": {"n": 146, "raw": [-11.8, -7.34, -1.94, 4.5, 11.8], "rawWin": 38.36, "xMed": -0.53, "xdMed": -0.45, "xdLo": -1.57, "xdHi": 1.25, "vsNews": -0.04, "vsLo": -1.06, "vsHi": 1.64, "p": 0.952},
            "30": {"n": 139, "raw": [-32.25, -21.89, -6.15, 13.68, 29.36], "rawWin": 39.57, "xMed": -1.64, "xdMed": -2.2, "xdLo": -5.75, "xdHi": 2.55, "vsNews": -1.04, "vsLo": -4.4, "vsHi": 3.65, "p": 0.649},
            "90": {"n": 122, "raw": [-47.19, -34.33, -10.27, 23.22, 83.28], "rawWin": 37.7, "xMed": 3.73, "xdMed": 1.37, "xdLo": -2.63, "xdHi": 4.7, "vsNews": 3.44, "vsLo": -0.59, "vsHi": 7.1, "p": 0.138}}},
        "delist": {"label": "상폐·유의 종목", "use": "none", "h": {
            "1": {"n": 180, "raw": [-5.34, -3.2, -0.84, 1.9, 5.12], "rawWin": 40.56, "xMed": -0.46, "xdMed": -0.15, "xdLo": -0.44, "xdHi": 0.17, "vsNews": 0.01, "vsLo": -0.29, "vsHi": 0.32, "p": 0.969},
            "7": {"n": 176, "raw": [-14.74, -9.26, -1.41, 6.98, 15.66], "rawWin": 44.32, "xMed": -0.59, "xdMed": 0.19, "xdLo": -0.45, "xdHi": 1.12, "vsNews": 0.6, "vsLo": -0.07, "vsHi": 1.59, "p": 0.069},
            "30": {"n": 171, "raw": [-33.74, -22.08, -8.44, 10.68, 25.68], "rawWin": 38.01, "xMed": -2.9, "xdMed": 0.27, "xdLo": -1.53, "xdHi": 1.91, "vsNews": 1.43, "vsLo": -0.66, "vsHi": 3.17, "p": 0.13},
            "90": {"n": 141, "raw": [-54.69, -40.86, -25.95, -4.53, 24.53], "rawWin": 21.99, "xMed": -5.04, "xdMed": 0.58, "xdLo": -1.35, "xdHi": 1.84, "vsNews": 2.65, "vsLo": 0.1, "vsHi": 5.43, "p": 0.044}}},
    },
}


def state(hist, now=None, out_dir=OUT):
    """사이트용 — 코인별 최근 뉴스 상태 + 사건 연구 결과"""
    coins, ref = coin_state(hist, now, out_dir)
    return {"updatedAt": hist.get("updatedAt"), "cols": list(STATE_COLS), "voteRef": ref, "eventDays": EVENT_DAYS,
            "coins": coins, "study": STUDY}


def run(topics, out_dir=OUT, now=None, dry=False):
    """collect.py 에서 부른다 — 이력 갱신 후 news_hist.json · news_state.json 쓰기"""
    out_dir = Path(out_dir)
    hist = load(out_dir / HIST_FILE)
    update(hist, topics, now, _ai_tags(out_dir))
    trim(hist)
    st = state(hist, now, out_dir)
    if not dry:
        for name, obj in ((HIST_FILE, hist), (STATE_FILE, st)):
            tmp = out_dir / (name + ".tmp")
            tmp.write_text(json.dumps(obj, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
            tmp.replace(out_dir / name)
    print(f"[뉴스 이력] 기사 {len(hist['art'])}건 · 날 {len(hist['days'])}일 · 최근 3일 뉴스 코인 {len(st['coins'])}개 · 투표 기준 {st['voteRef']}")
    return hist, st


def recheck(hist, candles_dir=OUT / "candles" / "upbit", h=7, lag=1):
    """쌓인 코인·날 집계로 사건 연구를 다시 — 다음 날 종가(lag) 진입, h일 뒤, 같은 날 업비트 전체 평균 대비 초과 수익 중앙값.
    candles 파일은 최근 200일뿐이라 그 안의 사건만 본다. 표본이 수백 개 쌓이기 전에는 결론을 내지 말 것."""
    closes = {}
    for p in Path(candles_dir).glob("KRW-*.json"):
        try:
            rows = json.loads(p.read_text(encoding="utf-8"))["c"][:-1]  # 마지막(진행 중) 봉 제외
        except Exception:
            continue
        closes[p.stem[4:]] = {_day(r[0]): r[4] for r in rows if r[4]}
    days = sorted({d for m in closes.values() for d in m})
    pos = {d: i for i, d in enumerate(days)}

    def fwd(code, d):
        m, i = closes.get(code), pos.get(d)
        if m is None or i is None or i + h >= len(days):
            return None
        a, b = m.get(d), m.get(days[i + h])
        return b / a - 1 if a and b else None
    mkt = {}
    for d in days:
        rs = [r for r in (fwd(c, d) for c in closes) if r is not None]
        if rs:
            mkt[d] = sum(rs) / len(rs)
    groups = {}
    for d, coins in hist["days"].items():
        if d not in pos or pos[d] + lag >= len(days):
            continue
        e = days[pos[d] + lag]
        for c, row in coins.items():
            r = fwd(c, e)
            if r is None or e not in mkt:
                continue
            x = r - mkt[e]
            v = dict(zip(DAY_COLS, row))
            if v["n"] > v["mv"]:
                groups.setdefault("news", []).append(x)
            for col in DAY_COLS[1:]:
                if col != "mv" and v[col]:
                    groups.setdefault(col, []).append(x)
    print(f"[다시 검증] {h}일 · 다음 날 종가 진입 · 시장 대비 초과 수익 (가격 {len(closes)}코인 {days[0] if days else '-'}~{days[-1] if days else '-'})")
    for k, xs in sorted(groups.items(), key=lambda kv: -len(kv[1])):
        med = _quantile(xs, 0.5)
        print(f"  {k:5s} n={len(xs):5d}  중앙값 {med * 100:+.2f}%  이긴 비율 {sum(x > 0 for x in xs) / len(xs) * 100:.0f}%")
    return groups


if __name__ == "__main__":
    if "--recheck" in sys.argv:
        recheck(load(OUT / HIST_FILE))
    else:
        news = json.loads((OUT / "news.json").read_text(encoding="utf-8"))
        run(news.get("topics") or [], dry="--dry" in sys.argv)
