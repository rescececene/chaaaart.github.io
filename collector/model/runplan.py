"""언제 다시 돌릴지 — 표준 라이브러리만 쓴다 (Actions 가 numpy 를 깔기 전에 '돌릴 필요가 있나'를 먼저 본다)

시장마다 '지금쯤 받을 수 있어야 하는 마지막 완성 일봉 날짜'(기대 기준일)를 계산하고,
결과의 기준일(asOf)이 그보다 뒤처졌으면 다시 돌린다. 그래서 하루 1번, 시장별로 새 일봉이 나온 직후에 돈다.
  코인: UTC 0시(KST 09시) 직후 / 국내: 16:45 KST 무렵 / 미국: 22:15 UTC 무렵 (평일만)
공휴일에는 새 일봉이 안 나와 기준일이 그대로라서, 같은 시장을 retry 시간마다 한 번씩만 다시 확인한다.
"""
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

MARKETS = ("upbit", "binance", "krx", "us")
# 캔들 t(현지 날짜 0시를 UTC 로 적은 초) + 이 초가 지나야 '끝난 봉'으로 본다.
# 코인: 업비트(09시 KST)·바이낸스 모두 UTC 0시에 봉이 바뀐다. 국내: 15:30 KST 마감(+1시간 여유).
# 미국: 16:00 ET = 20:00/21:00 UTC 마감(서머타임 여부) + 여유.
CLOSE_AFTER = {"upbit": 86400, "binance": 86400, "krx": int(7.5 * 3600), "us": 22 * 3600}
SETTLE = 10 * 60  # 마감 뒤 데이터 제공처가 값을 확정할 여유


def expected_asof(market, now_ts):
    """지금 받을 수 있어야 하는 마지막 완성 일봉 날짜 'YYYY-MM-DD' (주식은 주말만 건너뛴다 — 공휴일은 모른다)"""
    d = datetime.fromtimestamp(now_ts, timezone.utc).date()
    for back in range(0, 10):
        day = d - timedelta(days=back)
        if market in ("krx", "us") and day.weekday() >= 5:
            continue
        t0 = datetime(day.year, day.month, day.day, tzinfo=timezone.utc).timestamp()
        if t0 + CLOSE_AFTER[market] + SETTLE <= now_ts:
            return day.isoformat()
    return None


def read_summary(out_dir):
    try:
        s = json.loads((Path(out_dir) / "summary.json").read_text(encoding="utf-8"))
        return s if isinstance(s, dict) else None
    except (OSError, ValueError):
        return None


def _age_hours(iso, now_ts):
    try:
        return (now_ts - datetime.fromisoformat(iso).timestamp()) / 3600
    except (TypeError, ValueError):
        return None


def due(markets, summary, hours, retry_hours, now_ts):
    """다시 돌릴 시장 [(market, 이유)].
    - 결과가 없다 / 학습한 지 hours 시간 이상 지났다 (안전망)
    - 기준일이 기대 기준일보다 뒤처졌고, 마지막 학습 뒤 retry_hours 시간이 지났다
      (새 일봉이 나왔을 때 하루 1번 + 일부 종목 누락·장애로 밀렸을 때 재시도 + 공휴일엔 드물게만 확인)"""
    ms = (summary or {}).get("markets") or {}
    out = []
    for m in markets:
        r = ms.get(m) or {}
        age = _age_hours((r.get("model") or {}).get("trainedAt"), now_ts)
        if age is None:
            out.append((m, "결과 없음"))
            continue
        if age >= hours:
            out.append((m, f"학습 {age:.1f}시간 전"))
            continue
        exp = expected_asof(m, now_ts)
        if exp and str(r.get("asOf") or "") < exp and age >= retry_hours:
            out.append((m, f"기준일 {r.get('asOf')} < 기대 {exp} (학습 {age:.1f}시간 전)"))
    return out


def lagging(summary, now_ts, days=2):
    """기준일이 기대 기준일보다 days 일 넘게 밀린 시장 (경보용) {market: (asOf, expected)}"""
    out = {}
    for m, r in ((summary or {}).get("markets") or {}).items():
        exp = expected_asof(m, now_ts) if m in CLOSE_AFTER else None
        try:
            gap = (datetime.fromisoformat(exp) - datetime.fromisoformat(str(r.get("asOf")))).days if exp else 0
        except ValueError:
            gap = 99
        # 주식은 주말을 끼면 달력일 차이가 커지므로 여유를 둔다
        if gap > days + (2 if m in ("krx", "us") else 0):
            out[m] = (r.get("asOf"), exp)
    return out
