"""추천 기록·채점 — web/public/data/picks_log.json (recommend.py 가 매 실행 부른다, 표준 라이브러리만)

    python collector/picks_log.py            # 지금 기록 요약만 화면에 (파일은 바꾸지 않는다)

기록: 시장마다 엔진 기준일(asOf)이 새로 나오면 그날 '순위 상위 5개'를 처음 본 그대로 남긴다(나중에 목록이 바뀌어도 고치지 않는다).
  항목 = 종목 · 기준가(엔진 기준일 종가 — 코인은 그날 09:00 KST 가격) · 예상 %(mid) · 10번 중 8번 범위(lo~hi) · 점수 백분위 · 주의 표시
채점: H 뒤(코인 업비트 1일=24시간, 바이낸스 14일, 국내 20거래일, 미국 1거래일) 실제 종가가 나오면
  실제 수익 = 그 날 종가 / 기준가 − 1 (종가는 엔진이 쓰는 것과 같은 일봉: predict/sym/<시장>/<코드>.json 의 hist),
  시장 = 같은 기준일·같은 기간의 그 시장 점수 대상 전체 평균(그리고 중앙값) — summary.json 의 mktRet (엔진이 날마다 계산).
  이김 = 5개 평균 > 시장 평균. 범위 안 = 실제가 lo~hi 안. 방향 맞힘 = 예상과 실제의 부호가 같음(0 은 뺌).
요약(stats): 최근 30회 — 이긴 비율, 평균 예상 vs 평균 실제 vs 시장 평균, 평균 오차(|실제 − 예상|), 범위 안 비율, 방향 맞힘.
"""
import json
import math
import re
from datetime import datetime, timezone
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "web" / "public" / "data"
KEEP = 150      # 시장마다 남기는 기준일 수
N_STATS = 30
EXPIRE_DAYS = 70  # 이만큼 지나도 채점 자료가 없으면 '채점 못 함'으로 닫는다


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _read(path):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def _num(x):
    return x if isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x) else None


def _r(x, nd=6):
    return None if _num(x) is None else round(float(x), nd)


def safe_code(code):
    """predict.py 결과 파일 이름 규칙 (history.safe_code 와 같음)"""
    return re.sub(r"[^A-Za-z0-9._-]", "_", code)


def load(out_dir=OUT):
    d = _read(Path(out_dir) / "picks_log.json")
    return d if isinstance(d, dict) and d.get("version") == 1 else {"version": 1, "markets": {}}


def save(log, out_dir=OUT):
    log["updatedAt"] = now_iso()
    path = Path(out_dir) / "picks_log.json"
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(log, ensure_ascii=False, separators=(",", ":"), allow_nan=False), encoding="utf-8")
    tmp.replace(path)


def record(log, market, asof, h, items, mkt_mid=None, fc_grade=None):
    """기준일 asof 의 상위 5개를 처음 한 번만 남긴다 → 새로 남겼으면 True"""
    L = log.setdefault("markets", {}).setdefault(market, {"days": []})
    L["h"] = h
    if not asof or not items or any(e.get("d") == asof for e in L["days"]):
        return False
    L["days"].append({"d": asof, "h": h, "at": now_iso(), "mkt": _r(mkt_mid), "fc": fc_grade,
                      "items": [{"sym": x["sym"], "name": x.get("name"), "base": _r(x.get("base"), 10),
                                 "mid": _r(x.get("mid")), "lo": _r(x.get("lo")), "hi": _r(x.get("hi")),
                                 "pct": _r(x.get("pct"), 1), "cau": [c["k"] for c in x.get("cau") or []]}
                                for x in items[:5]]})
    L["days"].sort(key=lambda e: e["d"])
    L["days"] = L["days"][-KEEP:]
    return True


def _sym_hist(out_dir, market, sym, cache):
    if sym in cache:
        return cache[sym]
    code = sym.split(":", 1)[1]
    d = _read(Path(out_dir) / "predict" / "sym" / market / f"{safe_code(code)}.json") or {}
    h = d.get("hist") or {}
    cache[sym] = dict(zip(h.get("d") or [], h.get("c") or []))
    return cache[sym]


def grade(log, summary, out_dir=OUT, now=None):
    """결과가 나온 기록을 채점 → 새로 채점한 기준일 수"""
    now = now or datetime.now(timezone.utc)
    n_new = 0
    for m, L in (log.get("markets") or {}).items():
        mr = ((summary or {}).get("markets") or {}).get(m) or {}
        mret = {x["d"]: x for x in mr.get("mktRet") or [] if isinstance(x, dict) and x.get("d")}
        cache = {}
        for e in L.get("days") or []:
            if e.get("res"):
                continue
            x = mret.get(e["d"])
            if not x:
                try:
                    age = (now.date() - datetime.fromisoformat(e["d"]).date()).days
                except (ValueError, KeyError):
                    age = 999
                if age > EXPIRE_DAYS:
                    e["res"] = {"none": "채점 자료가 없어요(기준일이 너무 오래됐어요)", "at": now_iso()}
                continue
            end = x.get("end")
            rets, inr, dh, pred = [], [], [], []
            for it in e.get("items") or []:
                h = _sym_hist(out_dir, m, it["sym"], cache)
                c0, c1 = _num(h.get(e["d"])) or _num(it.get("base")), _num(h.get(end))
                if not c0 or c1 is None:
                    rets.append(None)
                    continue
                ret = c1 / c0 - 1
                rets.append(ret)
                if _num(it.get("lo")) is not None and _num(it.get("hi")) is not None:
                    inr.append(it["lo"] <= ret <= it["hi"])
                if _num(it.get("mid")) is not None:
                    pred.append(it["mid"])
                    if it["mid"] != 0 and ret != 0:
                        dh.append((it["mid"] > 0) == (ret > 0))
            ok = [r for r in rets if r is not None]
            if not ok:
                continue  # 종목 파일이 아직 없거나 날짜가 안 맞으면 다음 실행에서 다시
            avg = sum(ok) / len(ok)
            e["res"] = {"end": end, "ret": [_r(r) for r in rets], "avg": _r(avg), "pred": _r(sum(pred) / len(pred)) if pred else None,
                        "mkt": _r(x.get("mean")), "mktMed": _r(x.get("med")), "n": x.get("n"),
                        "win": bool(_num(x.get("mean")) is not None and avg > x["mean"]),
                        "inRange": _r(sum(inr) / len(inr), 4) if inr else None,
                        "dirHit": _r(sum(dh) / len(dh), 4) if dh else None, "at": now_iso()}
            n_new += 1
        L["stats"] = stats(L.get("days") or [])
    return n_new


def stats(days, n=N_STATS):
    """최근 n 회(채점된 것) 요약 — 없으면 None"""
    done = [e for e in days if isinstance(e.get("res"), dict) and _num(e["res"].get("avg")) is not None]
    done = done[-n:]
    if not done:
        return None
    R = [e["res"] for e in done]

    def mean(k):
        v = [_num(r.get(k)) for r in R]
        v = [x for x in v if x is not None]
        return _r(sum(v) / len(v)) if v else None

    err = [abs(r["avg"] - r["pred"]) for r in R if _num(r.get("pred")) is not None]
    return {"n": len(R), "from": done[0]["d"], "to": done[-1]["d"], "win": _r(sum(1 for r in R if r.get("win")) / len(R), 4),
            "avg": mean("avg"), "pred": mean("pred"), "mkt": mean("mkt"), "mktMed": mean("mktMed"),
            "mae": _r(sum(err) / len(err)) if err else None, "inRange": mean("inRange"), "dirHit": mean("dirHit")}


def last_graded(L):
    """가장 최근에 채점된 기준일 하나 (화면의 '어제 고른 5개')"""
    for e in reversed(L.get("days") or []):
        if isinstance(e.get("res"), dict) and _num(e["res"].get("avg")) is not None:
            return e
    return None


if __name__ == "__main__":
    lg = load()
    for m, L in (lg.get("markets") or {}).items():
        print(m, "기록", len(L.get("days") or []), "요약", json.dumps(L.get("stats"), ensure_ascii=False))
