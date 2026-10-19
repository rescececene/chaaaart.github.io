"""장기 일봉 이력 저장소 — collector/.history/<시장>/<파일>.npz (git 제외, Actions 에서는 캐시로 이어 쓴다)

- 첫 실행: 종목당 전량 (주식 ~5년 1260거래일, 업비트 1000일=200개×5페이지, 바이낸스 1000일)
- 이후: 마지막 저장일 이후 며칠 + 겹침 5일만 받아 이어 붙인다 (증분 갱신)
- 겹친 날의 종가가 저장값과 다르면(액면분할 등으로 네이버가 과거 수정주가를 다시 계산) 그 종목만 전량 다시 받는다
- 진행 중인 오늘 봉은 저장하지 않는다 → 다음 날 값이 바뀌어 학습·예측이 어긋나는 일을 막는다
- 지금 유니버스에서 빠진 종목도 1년 동안은 계속 갱신·학습에 쓴다 (빠진 뒤의 성과를 남겨 생존 편향을 조금이라도 줄이려고)
- 운영 안전장치: 마감 시각(deadline)이 지나면 남은 종목은 건너뛴다 / 같은 시장에서 네트워크 오류가 연달아 나면
  (서버가 응답 없이 매달림) 그 시장 수집을 멈춘다 / 깨진 파일은 .bad 로 치우고 다음 수집에서 전량 다시 받는다

호출 간격은 sources.http_get 의 _throttle(호스트별 최소 간격)을 그대로 따른다.
"""
import io
import json
import os
import re
import threading
import time
import urllib.error
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

import sources
from runplan import CLOSE_AFTER  # 진행 중인 봉 판정 — 실행 일정 판단과 같은 기준

DEFAULT_DIR = Path(__file__).resolve().parent.parent / ".history"
FULL_N = {"upbit": 1000, "binance": 1000, "krx": 1260, "us": 1260}  # 종목당 최대 보관 봉 수
# 동시 요청 수. 실제 호출 속도는 sources._throttle(호스트별 최소 간격)이 정하므로 늘려도 한도를 넘지 않는다.
# 미국 서버(Actions)→한국 API 는 요청 하나가 0.5초 안팎이라, 업비트(0.11초 간격)를 채우려면 6개쯤 필요하다.
WORKERS = {"upbit": 6, "binance": 4, "krx": 4, "us": 4}
OVERLAP = 5            # 증분 갱신 때 다시 받는 겹침 일수 (수정주가 변경 감지용)
REFETCH_GAP = 150      # 마지막 저장일이 이보다 오래됐으면 전량 다시
KEEP_EXITED_DAYS = 365  # 유니버스에서 빠진 종목을 계속 갱신·학습하는 기간
DROP_AFTER_DAYS = KEEP_EXITED_DAYS + 30  # 이보다 오래 빠져 있던 종목은 인덱스·파일을 지운다
MAX_FAIL = 3           # 연속 실패가 이만큼이면(상장폐지 등) 빠진 종목은 매일 시도하지 않는다
RETRY_FAILED_DAYS = 7  # … 대신 이 간격으로 한 번씩 다시 시도한다
ADJ_TOL = 0.005        # 겹친 날 종가가 0.5% 넘게 다르면 과거가 다시 계산된 것으로 본다
NET_BREAK = 8          # 같은 시장에서 네트워크 오류가 이만큼 연달아 나면 그 시장 수집을 멈춘다
REQ_TIMEOUT, REQ_RETRIES = 8, 1  # 대량 일봉 요청 하나의 제한 시간·재시도 (기본 15초·2회보다 짧게)
FIELDS = ("o", "h", "l", "c", "v")
_OK_NAME = re.compile(r"[A-Za-z0-9._-]+")
NET_ERRORS = (urllib.error.URLError, TimeoutError, ConnectionError)  # 응답 없음·연결 실패 (HTTP 오류 응답은 따로 본다)


def safe_code(code):
    """결과 파일 이름 규칙 (프런트엔드 safeCode·collect.py candle_path 와 같음) — 서로 다른 코드가 같아질 수 있다"""
    return re.sub(r"[^A-Za-z0-9._-]", "_", code)


def hist_name(code):
    """이력 파일 이름 — 겹치지 않는 인코딩. 허용 문자만이면 그대로, 아니면 '~' + UTF-8 16진수
    ('~' 는 허용 문자 밖이라 평범한 코드와 겹치지 않는다. 예: 牛来USDT → ~e7899be69da555534454)"""
    return code if _OK_NAME.fullmatch(code) else "~" + code.encode("utf-8").hex()


def _atomic_bytes(path, write_fn):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f"{path.name}.{os.getpid()}.{threading.get_ident()}.tmp")
    with open(tmp, "wb") as f:
        write_fn(f)
        f.flush()
        os.fsync(f.fileno())  # 전원이 나가도 0바이트·잘린 파일로 바뀌지 않게
    os.replace(tmp, path)


def save_npz(path, arr):
    _atomic_bytes(path, lambda f: np.savez(f, **arr))  # 압축 안 함 — 읽기 속도 우선


def load_npz(path, quarantine=True):
    """읽지 못하면 None. 파일이 깨졌으면(빈 파일·잘린 zip 등) .bad 로 치워 다음 수집이 전량 다시 받게 한다."""
    path = Path(path)
    try:
        # 바이트를 먼저 읽어 파일을 닫는다 — np.load 가 실패하면 예외가 파일 핸들을 붙잡아 Windows 에서 이름을 못 바꾼다
        with open(path, "rb") as f:
            raw = f.read()
        with np.load(io.BytesIO(raw)) as z:
            out = {k: z[k] for k in ("t",) + FIELDS}
        n = len(out["t"])
        if any(len(out[k]) != n for k in FIELDS):
            raise ValueError("길이 불일치")
        return out
    except FileNotFoundError:
        return None
    except Exception as e:  # EOFError·BadZipFile·ValueError·KeyError … 무엇이든
        if quarantine and path.exists():
            try:
                os.replace(path, path.with_name(path.name + ".bad"))
                print(f"  깨진 이력 파일을 치움: {path.name} ({type(e).__name__}: {e})", flush=True)
            except OSError:
                pass
        return None


def to_arrays(candles, market, now_ts):
    """캔들 리스트 → 배열. 진행 중인 봉·비정상 값은 버린다."""
    cut = now_ts - CLOSE_AFTER[market]
    rows = []
    for c in candles:
        try:
            t = int(c["t"])
            vals = [float(c[k] or 0.0) for k in FIELDS]
        except (TypeError, ValueError, KeyError):
            continue
        if t > cut:  # 아직 끝나지 않은 봉
            continue
        o, h, l, cl, v = vals
        if not (np.isfinite(cl) and cl > 0):
            continue
        o = o if o > 0 else cl
        h = max(h, o, cl) if h > 0 else max(o, cl)
        l = min(l, o, cl) if l > 0 else min(o, cl)
        rows.append((t, o, h, l, cl, v if np.isfinite(v) and v >= 0 else 0.0))
    rows.sort()
    out = {"t": np.array([r[0] for r in rows], dtype=np.int64)}
    for i, k in enumerate(FIELDS):
        out[k] = np.array([r[i + 1] for r in rows], dtype=np.float64)
    if len(out["t"]):  # 같은 날짜 중복 제거 (뒤의 값 우선)
        keep = np.r_[out["t"][1:] != out["t"][:-1], True]
        out = {k: v[keep] for k, v in out.items()}
    return out


def merge(old, new, cap):
    """같은 날짜는 새 값 우선. 최근 cap 개만 보관."""
    t = np.concatenate([old["t"], new["t"]])
    order = np.argsort(t, kind="stable")
    t = t[order]
    keep = np.r_[t[1:] != t[:-1], True]  # 정렬 뒤 같은 t 중 마지막(=new) 을 남긴다
    out = {"t": t[keep]}
    for k in FIELDS:
        out[k] = np.concatenate([old[k], new[k]])[order][keep]
    if len(out["t"]) > cap:
        out = {k: v[-cap:] for k, v in out.items()}
    return out


def overlap_ok(old, new):
    common, io, inew = np.intersect1d(old["t"], new["t"], return_indices=True)
    if len(common) == 0:
        return False  # 겹치는 날이 없으면 확인할 수 없으니 전량 다시
    rel = np.abs(new["c"][inew] / old["c"][io] - 1.0)
    return bool(np.all(rel <= ADJ_TOL))


def load_index(mdir):
    try:
        idx = json.loads((Path(mdir) / "_index.json").read_text(encoding="utf-8"))
        if not isinstance(idx, dict):
            idx = {}
    except (OSError, ValueError):
        idx = {}
    for k in ("names", "seen", "fail", "failAt", "listed"):
        if not isinstance(idx.get(k), dict):
            idx[k] = {}
    if not isinstance(idx.get("universe"), list):
        idx["universe"] = []
    return idx


def save_index(mdir, idx):
    data = json.dumps(idx, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    _atomic_bytes(Path(mdir) / "_index.json", lambda f: f.write(data))


def _days_since(ymd, now_ts):
    try:
        d = datetime.strptime(ymd, "%Y-%m-%d").replace(tzinfo=timezone.utc).timestamp()
    except (TypeError, ValueError):
        return 10 ** 6
    return (now_ts - d) / 86400


def cleanup(mdir, idx, now_ts, keep_codes=()):
    """오래 빠져 있던 종목(인덱스·파일), 어느 코드에도 대응하지 않는 파일, 깨진 파일·임시 파일 정리"""
    removed = 0
    for code in [c for c, s in idx["seen"].items() if _days_since(s, now_ts) > DROP_AFTER_DAYS
                 and c not in idx["universe"] and c not in keep_codes]:
        for k in ("seen", "fail", "failAt", "listed", "names"):
            idx[k].pop(code, None)
        try:
            (mdir / f"{hist_name(code)}.npz").unlink()
        except OSError:
            pass
        removed += 1
    known = {hist_name(c) for c in set(idx["seen"]) | set(idx["universe"]) | set(keep_codes)}
    for p in mdir.iterdir():
        try:
            if p.suffix == ".npz" and p.stem not in known:
                p.unlink()  # 예: 예전 이름 규칙(겹칠 수 있던 safe_code)으로 저장된 파일
                removed += 1
            elif p.name.endswith(".bad") or (p.name.endswith(".tmp") and now_ts - p.stat().st_mtime > 3600):
                p.unlink()
        except OSError:
            pass
    return removed


def update_market(market, universe, names, hist_dir=DEFAULT_DIR, now_ts=None, log=print, max_n=None,
                  extra=True, fetch=True, persist_universe=True, only=None, deadline=None):
    """universe: 오늘 유니버스 코드 목록(순서 유지), names: {code: [name, sub, ex]}.
    persist_universe=False(--limit 시험 실행)면 인덱스의 유니버스·seen 을 바꾸지 않는다.
    only: 이 코드들만 다시 받는다(최신 일봉이 빠진 종목 재시도용). deadline: 이 시각(time.time) 뒤엔 새 종목을 시작하지 않는다.
    반환: {"index", "fetched", "full", "failed", "skipped", "aborted", "secs"}"""
    now_ts = now_ts or time.time()
    mdir = Path(hist_dir) / market
    mdir.mkdir(parents=True, exist_ok=True)
    idx = load_index(mdir)
    today = datetime.fromtimestamp(now_ts, timezone.utc).strftime("%Y-%m-%d")
    if universe and persist_universe and only is None:
        idx["universe"] = list(universe)
        idx["universeAt"] = today
        for code in universe:
            idx["seen"][code] = today
    idx["names"].update(names or {})
    stats = {"index": idx, "fetched": 0, "full": 0, "failed": 0, "skipped": 0, "aborted": False, "secs": 0.0}
    if not fetch:
        return stats
    cap = FULL_N[market]  # 보관 한도 (max_n 이 작아도 이미 받은 긴 이력은 자르지 않는다)
    fetch_n = cap if not max_n else max(60, min(cap, int(max_n)))  # 전량 받을 때의 개수
    if only is not None:
        targets = list(only)
    else:
        targets = list(universe) if not persist_universe else list(idx["universe"])
        uset = set(targets)
        if extra:  # 최근 1년 안에 유니버스에 있었던 종목도 계속 갱신 (생존 편향 완화)
            for c, s in idx["seen"].items():
                if c in uset or _days_since(s, now_ts) > KEEP_EXITED_DAYS:
                    continue
                if idx["fail"].get(c, 0) >= MAX_FAIL and _days_since(idx["failAt"].get(c), now_ts) < RETRY_FAILED_DAYS:
                    continue  # 상장폐지 등으로 계속 실패하는 종목은 일주일에 한 번만
                targets.append(c)
    t0 = time.time()
    lock = threading.Lock()
    errors, failed_codes = [], []
    state = {"net_streak": 0}

    def job(code):
        if stats["aborted"] or (deadline and time.time() > deadline):
            with lock:
                stats["skipped"] += 1
            return
        sym = f"{market}:{code}"
        path = mdir / f"{hist_name(code)}.npz"
        try:
            old = load_npz(path)
            need, incremental = fetch_n, False
            if old is not None and len(old["t"]):
                # 저장된 이력이 요청 길이를 다 채웠거나(또는 상장일부터 다 있으면) 최근 며칠만 받는다
                complete = len(old["t"]) >= fetch_n * 0.98 or code in idx["listed"]
                gap = int((now_ts - int(old["t"][-1])) // 86400)
                if complete and gap <= REFETCH_GAP:
                    need, incremental = gap + OVERLAP, True
            new = to_arrays(sources.daily_quick(sym, need, REQ_TIMEOUT, REQ_RETRIES), market, now_ts)
            full = not incremental
            if incremental:
                if len(new["t"]) and not overlap_ok(old, new):
                    # 겹친 날 값이 달라졌다 = 과거 수정주가 재계산(분할·증자 등) → 전량 다시
                    new = to_arrays(sources.daily_quick(sym, fetch_n, REQ_TIMEOUT, REQ_RETRIES), market, now_ts)
                    full = True
                else:
                    merged = merge(old, new, cap) if len(new["t"]) else old
            if full:
                merged = new
                if len(merged["t"]) == 0:
                    raise ValueError("일봉 없음")
            save_npz(path, merged)
            with lock:
                state["net_streak"] = 0
                stats["fetched"] += 1
                stats["full"] += int(full)
                idx["fail"].pop(code, None)
                idx["failAt"].pop(code, None)
                if full:
                    # 요청보다 적게 왔으면 첫 봉 = 상장일(또는 데이터 시작일)로 본다 → '상장 후 일수' 특징에 쓴다
                    if len(merged["t"]) < fetch_n * 0.98:
                        idx["listed"][code] = int(merged["t"][0])
                    else:
                        idx["listed"].pop(code, None)
        except Exception as e:  # 한 종목 실패가 전체를 멈추지 않게
            net = isinstance(e, NET_ERRORS) and not isinstance(e, urllib.error.HTTPError)
            with lock:
                stats["failed"] += 1
                failed_codes.append(code)
                if net:
                    state["net_streak"] += 1
                    if state["net_streak"] >= NET_BREAK and not stats["aborted"]:
                        stats["aborted"] = True  # 서버가 응답하지 않는다 — 남은 종목은 건너뛰고 다음 실행에 맡긴다
                        errors.append(f"네트워크 오류 {NET_BREAK}회 연속 → 이 시장 수집 중단")
                else:
                    state["net_streak"] = 0
                if len(errors) < 3:
                    errors.append(f"{sym}: {type(e).__name__}: {e}")

    with ThreadPoolExecutor(max_workers=WORKERS[market]) as ex:
        list(ex.map(job, targets))
    # 시장 전체 장애(성공 0)나 수집 중단이면 종목 탓이 아니므로 실패 횟수를 올리지 않는다
    if stats["fetched"] > 0 and not stats["aborted"]:
        for code in failed_codes:
            idx["fail"][code] = idx["fail"].get(code, 0) + 1
            idx["failAt"][code] = today
    if only is None and persist_universe:
        n_rm = cleanup(mdir, idx, now_ts, keep_codes=universe or ())
        if n_rm:
            log(f"  [{market}] 이력 정리 {n_rm}건")
    save_index(mdir, idx)
    stats["secs"] = time.time() - t0
    for e in errors:
        log(f"  [{market}] 실패 {e}")
    log(f"[{market}] 이력 갱신 {stats['fetched']}/{len(targets)}종목 (전량 {stats['full']}, 실패 {stats['failed']}"
        + (f", 시간·중단으로 건너뜀 {stats['skipped']}" if stats["skipped"] else "") + f") {stats['secs']:.0f}초")
    return stats


def last_bar(market, hist_dir, codes):
    """{code: 마지막 저장 봉 t} — 파일이 없는 종목은 빠진다"""
    mdir = Path(hist_dir) / market
    out = {}
    for c in codes:
        a = load_npz(mdir / f"{hist_name(c)}.npz")
        if a is not None and len(a["t"]):
            out[c] = int(a["t"][-1])
    return out


def load_market(market, hist_dir=DEFAULT_DIR, codes=None, now_ts=None):
    """{code: arrays} — codes 가 없으면 지금 유니버스 + 최근 1년 안에 빠진 종목"""
    mdir = Path(hist_dir) / market
    out = {}
    if codes is None:
        now_ts = now_ts or time.time()
        idx = load_index(mdir)
        codes = list(dict.fromkeys(list(idx["universe"]) + [
            c for c, s in idx["seen"].items() if _days_since(s, now_ts) <= KEEP_EXITED_DAYS]))
    for code in codes:
        a = load_npz(mdir / f"{hist_name(code)}.npz")
        if a is not None and len(a["t"]):
            out[code] = a
    return out
