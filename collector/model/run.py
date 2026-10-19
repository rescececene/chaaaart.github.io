"""예측 엔진 실행 — 하루 1번 (GitHub Actions)

    python collector/model/run.py                         # 전 시장: 이력 갱신 → 학습·검증 → 오늘 예측
    python collector/model/run.py --markets upbit,krx     # 일부 시장만
    python collector/model/run.py --skip-fetch            # 저장된 이력만으로 (네트워크 없이)
    python collector/model/run.py --if-stale 26           # 새 일봉이 나왔는데 결과가 그보다 오래된 시장만 (아래 참고)
    python collector/model/run.py --if-stale 26 --check   # 돌릴 시장만 'markets=…' 로 출력 (numpy 없이 — 워크플로 조건용)
    python collector/model/run.py --deadline 15           # 전체 마감(분). 지나면 남은 수집은 건너뛰고 끝난 시장 결과만 저장
    python collector/model/run.py --history DIR --out DIR # 이력 저장소 / 결과 폴더 지정
    python collector/model/run.py --max-days 400          # 학습 이력 길이 제한 (시간이 모자랄 때 — 유니버스는 그대로)
    python collector/model/run.py --limit 30 --out TMP    # 시험: 시장별 종목 수 제한. --out 을 안 주면 임시 폴더에 쓰고,
                                                          # 이력 인덱스의 유니버스도 바꾸지 않는다 (운영 결과 오염 방지)

--if-stale HOURS: 시장마다 '지금쯤 받을 수 있어야 하는 마지막 완성 일봉 날짜'보다 결과 기준일(asOf)이 뒤처졌고 마지막
학습 뒤 --retry-hours(기본 4) 시간이 지났으면 돌린다. 학습한 지 HOURS 시간이 넘었으면 무조건 돌린다(안전망).
→ 10분마다 부르면 코인은 UTC 0시 직후, 국내는 16:45 KST 무렵, 미국은 22:15 UTC 무렵에 하루 1번씩 돈다.

종료 코드: 실패한 시장이 하나라도 있으면 1 (그 시장은 직전 결과 유지) — Actions 에서는 continue-on-error 로 배포는 계속.
결과: web/public/data/predict/summary.json, web/public/data/predict/sym/<시장>/<코드>.json
의존성: collector/requirements-model.txt (numpy·pandas·scipy·scikit-learn·lightgbm) — --check 는 표준 라이브러리만
"""
import argparse
import os
import queue
import re
import sys
import tempfile
import threading
import time
import traceback
from datetime import datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))  # collector/ (sources.py)
if str(HERE) not in sys.path:  # collector/model/ (스크립트로 직접 실행하지 않은 경우 대비)
    sys.path.insert(0, str(HERE))

import runplan  # noqa: E402  (표준 라이브러리만)
import sources  # noqa: E402  (표준 라이브러리만)

DEFAULT_OUT = HERE.parent.parent / "web" / "public" / "data" / "predict"
DEFAULT_HISTORY = HERE.parent / ".history"
LAG_REFETCH = 0.10   # 수집 뒤 최신 일봉이 빠진 유니버스 종목이 이 비율을 넘으면 그 종목들만 한 번 더 받는다
TRAIN_RESERVE = 300  # --deadline 중 학습·예측에 남겨 둘 초 (수집은 이만큼 먼저 끊는다)
_out = sys.stdout


def log(msg):
    print(f"{datetime.now().strftime('%H:%M:%S')} {msg}", file=_out, flush=True)


def binance_top():
    """collect.py 와 같은 바이낸스 유니버스 크기 — import 하지 않고 상수만 읽는다 (collect.py 의 다른 의존성을 끌어오지 않게)"""
    try:
        m = re.search(r"^BINANCE_TOP\s*=\s*(\d+)", (HERE.parent / "collect.py").read_text(encoding="utf-8"), re.M)
        return int(m.group(1)) if m else 120
    except OSError:
        return 120


def build_universe(markets, limit):
    """collect.py scan() 과 같은 규칙: 시총(없으면 거래대금) 순, 바이낸스 상위 120, 업비트는 스테이블 제외.
    반환 {market: {"codes": [...], "names": {code: [name, sub, ex]}, "warn": set()}}"""
    out = {}
    upm = None
    try:
        upm = sources.upbit_markets()
    except Exception as e:
        log(f"[upbit] 마켓 목록 실패: {e}")
    names = {code[4:]: m["name"] for code, m in (upm or {}).items()}
    loaders = {"upbit": (lambda: sources.upbit_snapshot(upm)) if upm else None,
               "binance": lambda: sources.binance_snapshot(names),
               "krx": sources.krx_snapshot, "us": sources.us_snapshot}
    top = binance_top()
    for m in markets:
        if loaders.get(m) is None:
            continue
        try:
            snap = loaders[m]()
        except Exception as e:
            log(f"[{m}] 목록 실패: {e}")
            continue
        rows = sorted(snap.values(), key=lambda q: -((q.get("cap") or q.get("vol")) or 0))
        if m == "binance":
            rows = rows[:top]
        if m == "upbit":  # 원화로 사는 달러 코인은 의미 없다
            rows = [q for q in rows if q["sub"] not in sources.STABLE | {"USDT"}]
        if limit:
            rows = rows[:limit]
        if not rows:
            log(f"[{m}] 목록이 비어 있음")
            continue
        codes = [q["sym"].split(":", 1)[1] for q in rows]
        out[m] = {"codes": codes,
                  "names": {q["sym"].split(":", 1)[1]: [q["name"], q["sub"], q.get("ex")] for q in rows},
                  "warn": {c for c in codes if m == "upbit" and (upm or {}).get(c, {}).get("warn")}}
    return out


def main():
    global _out
    ap = argparse.ArgumentParser(description="마켓렌즈 예측 엔진")
    ap.add_argument("--markets", default=",".join(sources.MARKETS))
    ap.add_argument("--limit", type=int, default=0, help="시장별 종목 수 제한 (시험용 — 인덱스·운영 결과를 건드리지 않는다)")
    ap.add_argument("--skip-fetch", action="store_true", help="이력 갱신 없이 저장된 이력만 사용")
    ap.add_argument("--history", default=str(DEFAULT_HISTORY), help="이력 저장소 폴더")
    ap.add_argument("--out", default=None, help="결과 폴더 (기본 web/public/data/predict, --limit 이면 임시 폴더)")
    ap.add_argument("--if-stale", type=float, default=None, metavar="HOURS",
                    help="새 일봉 기준으로 뒤처진 시장만 (HOURS 넘게 지난 결과는 무조건 다시)")
    ap.add_argument("--retry-hours", type=float, default=4.0, help="뒤처진 시장을 다시 시도하는 최소 간격(시간)")
    ap.add_argument("--check", action="store_true", help="돌릴 시장만 markets=… 로 출력하고 끝 (표준 라이브러리만)")
    ap.add_argument("--deadline", type=float, default=0, metavar="MIN", help="전체 마감 시간(분). 0 = 없음")
    ap.add_argument("--max-days", type=int, default=0, help="학습에 쓸 최근 일수 상한 (첫 수집 길이도 제한)")
    ap.add_argument("--threads", type=int, default=0, help="LightGBM 스레드 수 (기본: CPU 수)")
    ap.add_argument("--fetch-only", action="store_true", help="이력만 갱신하고 끝")
    args = ap.parse_args()
    if args.check:
        _out = sys.stderr  # 표준 출력은 GITHUB_OUTPUT 용 key=value 한 줄만

    out_dir = Path(args.out) if args.out else (
        Path(tempfile.gettempdir()) / "marketlens-predict-test" if args.limit else DEFAULT_OUT)
    if args.limit and not args.out:
        log(f"--limit 시험 실행 → 결과는 {out_dir} (운영 결과 폴더는 건드리지 않음)")
    markets = [m for m in args.markets.split(",") if m in sources.MARKETS]
    if args.if_stale is not None:
        summary = runplan.read_summary(out_dir)
        todo = runplan.due(markets, summary, args.if_stale, args.retry_hours, time.time())
        for m in markets:
            why = dict(todo).get(m)
            log(f"[{m}] " + (f"실행: {why}" if why else "최신 — 건너뜀"))
        markets = [m for m, _ in todo]
    if args.check:
        print(f"markets={','.join(markets)}", flush=True)
        return 0
    if not markets:
        log("모든 시장 결과가 최신 — 할 일 없음")
        return 0

    import history  # 여기서부터 numpy (무거운 의존성)

    t0 = time.time()
    t_end = t0 + args.deadline * 60 if args.deadline else None
    fetch_end = (t_end - min(TRAIN_RESERVE, args.deadline * 60 * 0.4)) if t_end else None
    hist_dir = Path(args.history)
    errors = {}

    # 1) 유니버스 (오늘 목록) — 실패하면 저장소에 남은 직전 유니버스로
    uni = {} if args.skip_fetch else build_universe(markets, args.limit)
    for m in markets:
        if m not in uni:
            idx = history.load_index(hist_dir / m)
            codes = idx["universe"][:args.limit] if args.limit else idx["universe"]
            if codes:
                uni[m] = {"codes": codes, "names": {c: idx["names"].get(c, [c, c, None]) for c in codes},
                          "warn": set(idx.get("warn", []))}
                if not args.skip_fetch:
                    log(f"[{m}] 오늘 목록을 못 받아 저장된 유니버스({len(codes)}종목) 사용")
            else:
                errors[m] = "유니버스 없음"
                log(f"[{m}] 유니버스가 없어 건너뜀")

    # 2) 이력 갱신 — 시장마다 서버가 달라 병렬 (각자 호출 간격 준수). 끝난 시장부터 바로 학습한다.
    ready = queue.Queue()

    def fetch(m):
        try:
            codes = uni[m]["codes"]
            persist = not args.limit and not args.skip_fetch  # 시험·오프라인 실행은 인덱스(유니버스·seen)를 바꾸지 않는다
            kw = dict(log=log, max_n=args.max_days or None, persist_universe=persist,
                      fetch=not args.skip_fetch, deadline=fetch_end)
            st = history.update_market(m, codes, uni[m]["names"], hist_dir, extra=not args.limit, **kw)
            if persist:
                st["index"]["warn"] = sorted(uni[m]["warn"])
                history.save_index(hist_dir / m, st["index"])
            if not args.skip_fetch:
                if st["failed"] and not st["fetched"]:
                    # 전 종목 실패(API 장애·차단) — 어제 데이터로 다시 학습해 '최신'인 척하지 않고 직전 결과를 유지,
                    # 다음 예약 실행(--if-stale)이 다시 시도하게 둔다
                    raise RuntimeError(f"이력 갱신 전부 실패 ({st['failed']}종목)")
                # 일부 종목만 최신 일봉이 빠졌으면 그 종목들만 한 번 더, 그래도 많이 빠져 있으면 이 시장은 실패
                for attempt in (1, 2):
                    lb = history.last_bar(m, hist_dir, codes)
                    if not lb:
                        raise RuntimeError("저장된 이력이 없음")
                    mx = max(lb.values())
                    lag = [c for c, t in lb.items() if t < mx]
                    if len(lag) <= LAG_REFETCH * len(lb):
                        break
                    if attempt == 2 or st["aborted"] or (fetch_end and time.time() > fetch_end):
                        raise RuntimeError(f"최신 일봉이 빠진 종목 {len(lag)}/{len(lb)} — 직전 결과 유지")
                    log(f"[{m}] 최신 일봉이 빠진 {len(lag)}/{len(lb)}종목 다시 받기")
                    st = history.update_market(m, codes, {}, hist_dir, only=lag, **kw)
        except Exception as e:
            errors[m] = f"이력 실패: {e}"
            if not isinstance(e, RuntimeError):
                traceback.print_exc()
        ready.put(m)

    todo = [m for m in markets if m in uni]
    threads = [threading.Thread(target=fetch, args=(m,), daemon=True) for m in todo]
    for t in threads:
        t.start()
    if args.fetch_only:
        for t in threads:
            t.join()
        log(f"이력 갱신 완료 {time.time() - t0:.0f}초" + (f" / 오류: {errors}" if errors else ""))
        return 1 if errors else 0

    import predict  # noqa: E402

    results = {}
    waiting = set(todo)
    while waiting:
        try:
            m = ready.get(timeout=max(1.0, t_end - time.time()) if t_end else None)
        except queue.Empty:
            for w in waiting:
                errors[w] = "마감 시간 초과 (수집이 끝나지 않음)"
            log(f"마감 {args.deadline:g}분 초과 — 끝나지 않은 시장({', '.join(sorted(waiting))})은 직전 결과 유지")
            break
        waiting.discard(m)
        if m in errors:
            log(f"[{m}] {errors[m]}")
            continue
        if t_end and t_end - time.time() < 60:
            errors[m] = "마감 시간 부족 (학습 생략)"
            log(f"[{m}] 마감까지 1분이 안 남아 학습을 생략 — 직전 결과 유지")
            continue
        try:
            results[m] = predict.run_market(m, uni[m], hist_dir, out_dir, limit=args.limit,
                                            max_days=args.max_days or None, threads=args.threads or os.cpu_count(),
                                            log=log)
            # 시장 하나 끝날 때마다 summary 갱신 — 종목 파일은 이미 바뀌었으니 요약이 뒤처지지 않게
            predict.write_summary(out_dir, {m: results[m]}, log=log)
        except Exception as e:
            errors[m] = f"예측 실패: {e}"
            log(f"[{m}] 예측 실패 — 직전 결과 유지: {e}")
            if not isinstance(e, predict.StaleData):
                traceback.print_exc()
    log(f"완료 {time.time() - t0:.0f}초" + (f" / 오류: {errors}" if errors else ""))
    # Actions 경고 (워크플로 요약에 노란 표시) — 실패한 시장, 기준일이 오래 밀린 시장
    for m, e in errors.items():
        print(f"::warning title=예측 엔진 {m}::{e}", flush=True)
    for m, (a, e) in runplan.lagging(runplan.read_summary(out_dir), time.time()).items():
        print(f"::warning title=예측 엔진 {m}::기준일 {a} 이 기대 기준일 {e} 보다 많이 밀렸습니다", flush=True)
    code = 1 if errors else 0
    if any(t.is_alive() for t in threads):
        # 응답 없는 서버에 매달린 수집 스레드를 기다리지 않는다 (결과·이력은 이미 원자적으로 저장됨)
        log("끝나지 않은 수집 스레드를 두고 종료")
        sys.stdout.flush()
        sys.stderr.flush()
        os._exit(code)
    return code


if __name__ == "__main__":
    sys.exit(main())
