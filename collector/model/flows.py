"""국내 주식 외국인 보유율 이력 (네이버 일봉 차트 API 의 foreignRetentionRate — 무료, 종목당 요청 1번에 5년치)

    python collector/model/flows.py            # 이력 인덱스의 국내 유니버스 + 최근 빠진 종목 전부 갱신

저장: collector/.history/krx_flow/<코드>.npz  {t: 날짜(UTC 0시 초), f: 외국인 보유율(%)}
기관 순매수는 네이버가 하루 10줄씩만 주는 화면이라(5년치 = 종목당 120번 요청) 받지 않는다.
"""
import io
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
import sources  # noqa: E402

DIR = HERE.parent / ".history" / "krx_flow"


def fetch(code, years=5.2):
    end = datetime.now(timezone(timedelta(hours=9)))
    start = end - timedelta(days=int(365 * years))
    d = sources.http_json(f"https://api.stock.naver.com/chart/domestic/item/{code}/day?"
                          f"startDateTime={start:%Y%m%d}0000&endDateTime={end:%Y%m%d}2359", timeout=10, retries=1)
    t, f = [], []
    for x in d:
        v = x.get("foreignRetentionRate")
        if v is None:
            continue
        dt = datetime.strptime(x["localDate"], "%Y%m%d").replace(tzinfo=timezone.utc)
        t.append(int(dt.timestamp()))
        f.append(float(v))
    return np.array(t, dtype=np.int64), np.array(f, dtype=np.float64)


def save(code, t, f):
    DIR.mkdir(parents=True, exist_ok=True)
    buf = io.BytesIO()
    np.savez_compressed(buf, t=t, f=f)
    tmp = DIR / f"{code}.npz.tmp"
    tmp.write_bytes(buf.getvalue())
    tmp.replace(DIR / f"{code}.npz")


def load(code):
    try:
        with np.load(DIR / f"{code}.npz") as z:
            return {"t": z["t"], "f": z["f"]}
    except (OSError, ValueError, KeyError):
        return None


def update(codes, log=print, deadline=None, max_age_h=20):
    """각 종목을 통째로 다시 받는다 (요청 1번이 5년치라 증분보다 단순). max_age_h 안에 받은 파일은 건너뛴다."""
    now = time.time()
    todo = [c for c in codes if not (DIR / f"{c}.npz").exists()
            or now - (DIR / f"{c}.npz").stat().st_mtime > max_age_h * 3600]
    ok = fail = 0

    def job(c):
        nonlocal ok, fail
        if deadline and time.time() > deadline:
            return
        try:
            t, f = fetch(c)
            if len(t):
                save(c, t, f)
                ok += 1
        except Exception:
            fail += 1

    with ThreadPoolExecutor(4) as ex:
        list(ex.map(job, todo))
    log(f"[krx] 외국인 보유율 {ok}종목 갱신 / 실패 {fail} / 건너뜀 {len(codes) - len(todo)}")
    return ok, fail


if __name__ == "__main__":
    import history
    idx = history.load_index(HERE.parent / ".history" / "krx")
    codes = list(dict.fromkeys(list(idx["universe"]) + list(idx["seen"])))
    t0 = time.time()
    update(codes)
    print(f"{time.time() - t0:.0f}초")
