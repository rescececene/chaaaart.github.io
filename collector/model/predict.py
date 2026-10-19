"""시장별: 패널 → 특징 → 워크포워드 검증 → 최종 학습 → 오늘 예측 → JSON 출력

출력 계약: web/public/data/predict/summary.json, sym/<market>/<safe code>.json
모든 수치는 유한한 숫자 또는 null, 쓰기는 임시 파일 → 교체(원자적, fsync).
"""
import json
import math
import os
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

import analogs
import engine
import explain
import features
import history
import outlook
import recrule
import sources

N_PICKS, N_AVOID, SPARK = 20, 10, 60
MIN_UNIVERSE = 12   # 이보다 작으면 순위·검증이 의미 없다 (하루 횡단면 통계에 10종목 이상 필요)
LAG_MAX = 0.10      # 오늘 유니버스 중 마지막 날 일봉이 빠진 종목이 이 비율을 넘으면 그 시장은 실패로 (직전 결과 유지)
# sources.STABLE 에 없는 스테이블코인(법정화폐 연동). collect.py 동작은 그대로 두고 모형 쪽에서만 뺀다.
PEGGED = sources.STABLE | {"USDT", "U", "EURC", "USDG", "JPYC", "GUSD", "FRAX", "USDD", "LUSD", "AUSD",
                           "USD0", "USDQ", "EURQ", "USDF", "KRWQ"}
safe_code = history.safe_code  # 결과 파일 이름 = 프런트엔드 safeCode 규칙


class StaleData(RuntimeError):
    """오늘 일봉이 빠진 종목이 너무 많다 — 이 시장은 직전 결과를 유지하고 다음 실행에서 다시 받는다"""


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def clean(x, sig=6):
    """NaN/inf → None, 실수는 유효숫자 sig 자리 (파일 크기 절약)"""
    if isinstance(x, dict):
        return {k: clean(v, sig) for k, v in x.items()}
    if isinstance(x, (list, tuple)):
        return [clean(v, sig) for v in x]
    if isinstance(x, (bool, np.bool_)):
        return bool(x)
    if isinstance(x, (int, np.integer)):
        return int(x)
    if isinstance(x, (float, np.floating)):
        x = float(x)
        if not math.isfinite(x):
            return None
        return float(f"{x:.{sig}g}")
    return x


def write_json(path, obj):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    data = json.dumps(clean(obj), ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")
    tmp = path.with_name(f"{path.name}.{os.getpid()}.{threading.get_ident()}.tmp")
    with open(tmp, "wb") as f:
        f.write(data)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def _fin(x):
    return x is not None and isinstance(x, (int, float, np.floating)) and math.isfinite(float(x))


def _f(x, fmt, na="n/a"):
    """None·NaN 이어도 로그 문자열이 깨지지 않게"""
    return format(float(x), fmt) if _fin(x) else na


def is_pegged(market, code, a):
    """스테이블코인: 이름 목록 또는 최근 60일 가격이 중앙값 ±2% 안에서 하루 변동 0.3% 미만"""
    if market not in ("upbit", "binance"):
        return False
    base = code.split("-", 1)[1] if market == "upbit" else (code[:-4] if code.endswith("USDT") else code)
    if base.upper() in PEGGED:
        return True
    c = a["c"][-60:]
    if len(c) < 20:
        return False
    med = float(np.median(c))
    r = np.diff(np.log(c))
    return bool(np.all(np.abs(c / med - 1) < 0.02) and np.std(r) < 0.003)


def aux_for(market, P, hist_dir, all_groups=False):
    """추가 특징에 필요한 바깥 데이터: 코인 = 다른 거래소 같은 코인 종가(김치 프리미엄), 국내 = 외국인 보유율"""
    import pandas as pd
    aux = {}
    groups = list(features.GROUPS) if all_groups else (features.EXTRA_GROUPS.get(market) or [])
    if market in ("upbit", "binance") and "kp" in groups:
        other = "binance" if market == "upbit" else "upbit"
        cols = {}
        for code, a in history.load_market(other, Path(hist_dir)).items():
            if other == "binance" and code.endswith("USDT"):
                mine = "KRW-" + code[:-4]
            elif other == "upbit" and code.startswith("KRW-"):
                mine = code[4:] + "USDT"
            else:
                continue
            if mine in P["c"].columns and len(a["t"]):
                cols[mine] = pd.Series(a["c"], index=pd.to_datetime(a["t"], unit="s"))
        if cols:
            aux["other_c"] = pd.DataFrame(cols).sort_index()
    if market == "krx" and "frgn" in groups:
        import flows
        fr = {c.split("#")[0]: flows.load(c.split("#")[0]) for c in P["c"].columns}
        aux["frgn"] = {k: v for k, v in fr.items() if v}
    return aux


VERDICT_TEXT = {
    "strong": "판정: 검증 기간에는 통계적으로 뚜렷한 순위 예측력이 있었어요. 다만 미래에도 유지된다는 보장은 없어요.",
    "weak": "판정: 약한 편이에요(통계적으로 뚜렷하지 않거나, 기간·시장 국면에 따라 흔들렸어요). 순위는 참고 정도로만 보세요.",
    "none": "판정: 점수 상위 종목이 평균보다 낫다는 근거가 거의 없어요. 이 시장의 순위·추천은 믿기 어려워요.",
}


GRADE_KO = {"good": "양호", "weak": "약함", "poor": "참고 낮음"}


def outlook_note(market, olbt):
    unit0 = "일" if market in ("upbit", "binance") else "거래일"
    parts, poor = [], []
    for label, b in (olbt or {}).items():
        if not b:
            parts.append(f"{label} 검증 기간 부족")
            continue
        unit = "시간" if b.get("unit") == "h" else unit0
        base = f"(같은 종목 아무 날 기준 {b['baseDirHit'] * 100:.0f}%)" if _fin(b.get("baseDirHit")) else ""
        parts.append(f"{label}({b['h']}{unit}) 범위 적중 {b['coverage'] * 100:.0f}%·방향 적중 {b['dirHit'] * 100:.0f}%{base}·"
                     f"확률 보정 오차 {b['calibErr'] * 100:.0f}%p → {GRADE_KO[b['grade']]}")
        if b["grade"] == "poor":
            poor.append(label)
    if not parts:
        return None
    s = ("단기(1시간)·중기(1일)·장기(1주) 예상은 지금과 비슷했던 과거 자리 최대 100개(같은 시장, 시각당 2개까지, 결과가 이미 확정된 자리만)의 "
         "실제 결과로 만든 분포예요(모형 점수와 별개). 과거로 되돌려 같은 방식으로 검증한 결과: " + "; ".join(parts) + ".")
    if poor:
        s += (f" {'·'.join(poor)} 예상은 '오를 확률'·방향이 '같은 종목을 아무 날이나 샀을 때'보다 낫다는 근거가 없거나 오히려 "
              "어긋났어요. 범위는 흔들림의 크기 정도로만, 확률은 참고 정도로만 보세요.")
    return s


def make_notes(market, bt, cal, qcal, an, ctx):
    """한계·주의 (해요체) — 숫자는 이번 검증 결과 그대로. 화면에 앞의 3개만 보이는 곳이 있어서
    ① 판정+핵심 수치 ② 시장 국면별 성과 ③ 생존 편향 순서로 둔다."""
    H = features.HORIZON[market]
    coin = market in ("upbit", "binance")
    unit = "일" if coin else "거래일"
    notes = []
    if bt:
        ho = bt.get("heldOut") or {}
        head = (f"{VERDICT_TEXT[bt['verdict']]} 검증 {bt['from']}~{bt['to']}({H}{unit}씩 겹치지 않게 {bt['periods']}회): "
                f"순위 IC {bt['rankIC']:+.3f}(t≈{bt['tStat']:.1f}), 상위 10% − 유니버스 평균 "
                f"{bt['topExcess'] * 100:+.2f}%p(로그수익 기준 {bt['topExcessLog'] * 100:+.2f}%p), "
                f"상위 10% 중 중앙값을 이긴 비율 {bt['topHitRate'] * 100:.0f}%(무작위 50%).")
        if ho:
            head += (f" 모형을 고를 때 쓰지 않은 뒤쪽 절반({ho['from']}~)만 보면 IC {ho['rankIC']:+.3f}(t≈{ho['tStat']:.1f}), "
                     f"상위−평균 {ho['topExcessLog'] * 100:+.2f}%p(로그)예요.")
        notes.append(head)
        rg = bt.get("regime") or {}
        if _fin(rg.get("icUp")) and _fin(rg.get("icDown")):
            s = (f"시장 국면별: 검증일 가운데 시장이 내린 구간이 {(1 - rg['upShare']) * 100:.0f}%였어요. 시장이 오른 구간에서는 "
                 f"순위 IC {rg['icUp']:+.3f}, 상위 10% − 평균 {rg['topUp'] * 100:+.2f}%p"
                 f"(오른 날의 {rg['upDaysTopBehind'] * 100:.0f}%에서 상위가 뒤처짐), 내린 구간에서는 IC {rg['icDown']:+.3f}, "
                 f"상위 10% − 평균 {rg['topDown'] * 100:+.2f}%p.")
            if coin and (rg["icUp"] <= 0 or rg["topUp"] < 0):
                s += " 이 점수는 '오를 코인'보다 '덜 떨어질 코인'에 가까워요. 시장이 오를 때는 오히려 뒤처지기 쉬워요."
            elif rg["icUp"] <= 0:
                s += " 시장이 오르는 구간에서는 순위가 맞지 않았어요."
            notes.append(s)
    yrs = ctx.get("hist_years") or 0
    span = (f"학습·검증했어요(이력 약 {yrs:.1f}년, 검증 구간 {bt['from']}~{bt['to']})" if bt
            else f"학습했어요(이력 약 {yrs:.1f}년)")
    if market in ("krx", "us"):
        s = (f"생존 편향: 오늘 시가총액 상위 종목으로 {span}. 그사이 상장폐지되거나 순위 밖으로 밀린 종목이 빠져 있어"
             "(오늘 큰 종목 = 과거의 승자) 검증 성과가 실제보다 좋게 나왔을 수 있어요.")
    elif market == "upbit":
        s = (f"생존 편향: 지금 업비트 원화 시장에 남아 있는 코인으로 {span}. 상장폐지된 코인(대개 큰 손실)은 데이터가 없어 "
             "빠져 있으므로 실제 성과는 이 수치보다 낮을 수 있어요.")
    else:
        s = (f"생존 편향: 오늘 거래대금 상위 코인으로 {span}. 최근 거래가 몰린(대개 많이 오른) 코인이 많이 들어가고 "
             "상장폐지·인기 하락 코인이 빠져 있어 실제 성과는 이 수치보다 낮을 수 있어요.")
    dev, ho = (bt or {}).get("dev") or {}, (bt or {}).get("heldOut") or {}
    if _fin(dev.get("rankIC")) and _fin(ho.get("rankIC")) and dev["rankIC"] > ho["rankIC"]:
        s += (f" 검증 앞쪽 절반 IC({dev['rankIC']:+.3f})가 뒤쪽({ho['rankIC']:+.3f})보다 높은데, 오래된 구간일수록 "
              "생존 편향이 커서 앞쪽이 부풀려졌을 수 있어요.")
    if ctx.get("n_extra"):
        s += f" 완화책으로 최근 1년 안에 유니버스에서 빠진 {ctx['n_extra']}종목의 이력도 학습·검증에 넣었어요."
    notes.append(s)
    if bt:
        eq = bt["equity"][-1] if bt.get("equity") else None
        rt, gr = bt.get("randomTop") or {}, bt.get("grids") or {}
        if eq:
            s = (f"누적 곡선(리밸런싱 시작일을 바꾼 {gr.get('n', 1)}가지 경우의 평균, 수수료 전): 상위 10% {eq['top']:.2f}배, "
                 f"유니버스 평균 {eq['all']:.2f}배")
            if _fin(rt.get("p05")):
                s += f", 무작위로 10%를 골랐다면 {rt['p05']:.2f}~{rt['p95']:.2f}배(90% 범위)"
            s += "."
            if gr.get("n", 0) > 1:
                s += f" 시작일에 따라 상위/평균 비율이 {gr['ratioMin']:.2f}~{gr['ratioMax']:.2f}배로 달랐고, "
                s += ("모든 경우에 상위 10%가 평균보다 높았어요." if gr["topBehind"] == 0 else
                      f"{gr['n']}가지 중 {gr['topBehind']}가지에서 상위 10%가 평균보다 낮았어요.")
            if bt["topExcessLog"] <= 0:
                s += " 점수만 보고 샀다면 평균적으로 시장 평균보다 못했을 거예요."
            notes.append(s)
    else:
        notes.append("이력이 짧아 워크포워드 검증을 하지 못했어요. 점수는 참고용이에요.")
    notes.append(f"검증 방식: 날짜 순 워크포워드(학습 끝과 검증 시작 사이 {H}+5{unit} 비움). 목표는 같은 날 같은 시장 유니버스 "
                 f"중앙값 대비 {H}{unit} 초과수익이에요. '평균 초과수익'은 상위 10% 평균 − 유니버스 평균이라 무작위로 고르면 0 이에요. "
                 "수수료·세금·슬리피지는 빼지 않았어요.")
    sb = ctx.get("bins")
    if bt and bt["verdict"] == "none":
        notes.append("점수: 이 시장은 검증에서 근거가 없어 점수·'시장 이길 확률' 대신 '판단 보류'로 둬요. 순서는 참고용이에요.")
    elif sb:
        w = engine.GRADE_W.get(bt["verdict"] if bt else "none", 0)
        top = sb["bins"][-1]
        s = (f"점수 = '시장 이길 확률' × 100 이에요. 과거 검증 구간({sb['from']}~{sb['to']}, {sb['n']:,}건)에서 오늘과 같은 점수 "
             f"구간(10등분)에 있던 종목들이 실제로 {H}{unit} 뒤 같은 시장 중앙값을 이긴 비율이고, 예상 초과수익도 그 구간 "
             f"종목들의 실제 결과(10·50·90%)예요. 최상위 구간은 실제로 {top['hit'] * 100:.0f}%가 이겼고 초과수익 중앙값 "
             f"{top['q50'] * 100:+.2f}%p였어요.")
        if w < 1:
            s += f" 검증 등급이 '약함'이라 확률·초과수익을 기준(50%·0)쪽으로 절반만 반영했어요."
        rel = sb.get("reliability") or {}
        if rel.get("topHit") is not None:
            s += (f" 표를 앞 70%로 만들고 뒤 30%({rel['from']}~)에서 확인하니 최상위 구간 예상 {rel['topPredHit'] * 100:.0f}% → "
                  f"실제 {rel['topHit'] * 100:.0f}%, 구간 평균 오차 {rel['calibErr'] * 100:.1f}%p였어요.")
        notes.append(s + " 가격이 오를 확률이 아니라 '시장보다 나을' 확률이에요.")
    if qcal and _fin(qcal.get("coverage")):
        s = ("예상 범위(10~90%)·중앙값: 이 모형은 시장 전체가 오를지 내릴지는 맞히지 못해서, 중앙값은 '시장 보합(0%)'을 "
             "기준으로 종목의 상대적인 기울기만 얹었어요(분위 회귀 + 최근 구간 보정). 보정에 안 쓴 최근 구간에서 실제 수익이 "
             f"범위 안에 든 비율 {qcal['coverage'] * 100:.0f}%(목표 80%)")
        if _fin(qcal.get("q50Below")):
            s += (f", 실제 수익이 중앙값보다 낮았던 비율 {qcal['q50Below'] * 100:.0f}%(이상값 50%, 보정 전 "
                  f"{qcal['q50BelowRaw'] * 100:.0f}%), 중앙값의 오름·내림 방향 적중 {qcal['q50SignHit'] * 100:.0f}%"
                  "(동전 던지기 수준)")
        s += ("예요. 시장 전체가 크게 움직이면 범위를 벗어나요. 예측 경로 콘의 중간 날짜는 √시간 비례로 보간한 값이에요.")
        notes.append(s)
    ol_note = outlook_note(market, ctx.get("olbt"))
    if ol_note:
        notes.append(ol_note)
    if an:
        weak_an = an["ic"] < 0.02 or (an.get("t") or 0) < 2
        notes.append(f"유사 패턴(과거 비슷한 차트 10개의 평균 결과)의 검증 순위 IC {an['ic']:+.3f}({an['n']}회): "
                     + ("예측력이 거의 없어 참고용으로만 보세요." if weak_an else "약하게나마 맞는 편이었어요(모형 점수와 별개)."))
    top_feats = ctx.get("top_feats") or []
    if top_feats:
        lowvol = coin and any("변동" in f or "ATR" in f for f in top_feats[:2])
        assets = "금 연동 토큰(XAUT 등)" if market == "upbit" else "금(PAXG·XAUT)·주식 연동 토큰"
        notes.append(f"오늘 점수에 영향이 가장 큰 특징: {', '.join(top_feats)}."
                     + (f" 변동성이 낮은 대형 코인·{assets}이 상위에 오르기 쉬운 이유예요." if lowvol else ""))
    if ctx.get("n_short"):
        notes.append(f"상장(또는 거래 재개) 후 {features.MIN_OBS}{unit}이 안 된 {ctx['n_short']}종목은 이력이 짧아 점수를 매기지 않았어요.")
    if ctx.get("n_lag"):
        notes.append(f"마지막 날({ctx['as_of']}) 일봉이 없는 {ctx['n_lag']}종목(거래정지·수집 실패)은 오늘 점수에서 뺐어요.")
    if ctx.get("n_adj"):
        notes.append(f"데이터 정리: 수정주가가 빠진 액면분할 보정, 긴 거래정지·이음새에서 시계열 나누기 등 {ctx['n_adj']}건.")
    if ctx.get("pegged_n"):
        notes.append(f"스테이블코인(법정화폐 연동) {ctx['pegged_n']}개는 순위에서 뺐어요.")
    if ctx.get("warn_n"):
        notes.append(f"업비트 투자유의 지정 코인 {ctx['warn_n']}개는 추천(상위) 목록에서 뺐어요.")
    s = "모형 구성(LightGBM+릿지 앙상블)은 여러 후보 중 검증 기간 앞쪽 절반 성과로 골랐어요"
    if _fin(dev.get("rankIC")):
        s += f"(앞쪽 IC {dev['rankIC']:+.3f})"
    s += ". 그래서 앞쪽 수치는 낙관적일 수 있어 판정은 뒤쪽 절반도 함께 봐요. 투자 권유가 아니며 결과는 참고용이에요."
    notes.append(s)
    return notes


def run_market(market, uni, hist_dir, out_dir, limit=0, max_days=None, threads=4, log=print):
    t0 = time.time()
    H = features.HORIZON[market]
    mdir = Path(hist_dir) / market
    idx = history.load_index(mdir)
    arrs = history.load_market(market, hist_dir, codes=list(uni["codes"]) if limit else None)
    for c in uni["codes"]:  # 유니버스 종목은 반드시 포함
        if c not in arrs:
            a = history.load_npz(mdir / f"{history.hist_name(c)}.npz")
            if a is not None and len(a["t"]):
                arrs[c] = a
    pegged = {c for c, a in arrs.items() if is_pegged(market, c, a)}
    arrs = {c: a for c, a in arrs.items() if c not in pegged}
    # 결과 파일 이름이 겹치는 코드(예: 한자 이름 토큰 두 개가 둘 다 '__USDT')는 유니버스 순서상 앞의 것만 남긴다
    used, collide = {}, set()
    for c in uni["codes"]:
        sc = safe_code(c)
        if sc in used:
            collide.add(c)
            log(f"  [{market}] 결과 파일 이름 충돌: {c} 와 {used[sc]} → {c} 는 오늘 점수에서 뺌")
        else:
            used[sc] = c
    ucodes = [c for c in uni["codes"] if c not in pegged and c not in collide]
    uset = set(ucodes)
    n_have = len([c for c in ucodes if c in arrs])
    if n_have < MIN_UNIVERSE:
        raise ValueError(f"유니버스가 너무 작다 (이력 있는 종목 {n_have}개 < {MIN_UNIVERSE})")
    n_extra = len([c for c in arrs if c not in uset and c not in collide])
    P = features.build_panel(arrs, idx.get("listed"), max_days, market=market)
    F, M = features.compute_features(P, market)
    groups = features.EXTRA_GROUPS.get(market) or []
    if groups:
        added, addm = features.extra_features(P, F, M, market, groups, aux_for(market, P, hist_dir))
        log(f"  [{market}] 추가 특징 {groups}: {added + addm}")
    ds = features.build_dataset(P, F, M, market)
    T = len(P["dates"])
    ds["starts"] = engine.date_starts(ds["ti"], T)
    log(f"[{market}] 패널 {T}일 × {len(P['codes'])}종목, 라벨 행 {int(ds['has_label'].sum()):,}, "
        f"특징 {ds['Xr'].shape[1]}(순위)/{ds['Xq'].shape[1]}(분위), 스테이블 제외 {len(pegged & set(uni['codes']))}, "
        f"정리 {P['adjusted']}건 — {time.time() - t0:.0f}초")

    # 마지막 날 실제 일봉이 없는 유니버스 종목(수집 실패·거래정지) — 어제 값을 복사한 채 '오늘'처럼 점수 매기지 않는다
    last = T - 1
    as_of = str(P["dates"][last].date())
    act_last = P["actual"].iloc[last]
    in_panel = [c for c in ucodes if c in act_last.index]
    lag = [c for c in in_panel if not bool(act_last[c])]
    if in_panel and len(lag) > LAG_MAX * len(in_panel):
        raise StaleData(f"{as_of} 일봉이 없는 종목 {len(lag)}/{len(in_panel)} — 직전 결과 유지")
    if lag:
        log(f"  [{market}] {as_of} 일봉 없음 {len(lag)}종목 → 오늘 점수에서 뺌 (예: {', '.join(lag[:5])})")

    cfg = engine.CFG[market]
    kinds = list(engine.KINDS)
    oos, pl, folds = engine.walk_forward(ds, cfg, kinds, threads, log)
    score_oos = engine.combine(ds, [oos[k] for k in kinds])
    bt = engine.evaluate(ds, score_oos, pl)
    if len(kinds) > 1:  # 구성 모형별 성과도 로그로 (설계 비교용)
        for k in kinds:
            b = engine.evaluate(ds, oos[k], pl, band=False)
            if b:
                log(f"  · {k}: IC {b['rankIC']:+.4f} IR {b['icIR']:+.3f} 적중 {b['topHitRate']:.3f} "
                    f"상위-평균 {b['topExcess'] * 100:+.2f}%p(로그 {b['topExcessLog'] * 100:+.2f}%p) "
                    f"하위-평균 {b['bottomExcess'] * 100:+.2f}%p")
    if bt:
        ho, rg, rt = bt.get("heldOut") or {}, bt["regime"], bt.get("randomTop") or {}
        log(f"  · 최종(앙상블): IC {bt['rankIC']:+.4f} t {bt['tStat']:.2f} IR {bt['icIR']:+.3f} +비율 {bt['icPositiveRate']:.2f} "
            f"적중 {bt['topHitRate']:.3f} 상위-평균 {bt['topExcess'] * 100:+.2f}%p(로그 {bt['topExcessLog'] * 100:+.2f}%p) "
            f"하위-평균 {bt['bottomExcess'] * 100:+.2f}%p ({bt['periods']}회 × 격자 {bt['grids']['n']})")
        log(f"  · 홀드아웃(뒤쪽 절반 {ho.get('from')}~): IC {_f(ho.get('rankIC'), '+.4f')} t {_f(ho.get('tStat'), '.2f')} "
            f"상위-평균(로그) {_f((ho.get('topExcessLog') or 0) * 100, '+.2f')}%p / 국면: 상승 {_f(rg.get('upShare'), '.2f')} "
            f"IC 상승 {_f(rg.get('icUp'), '+.3f')} 하락 {_f(rg.get('icDown'), '+.3f')} → 판정 {bt['verdict']}")
        eq = bt["equity"][-1]
        log(f"  · 누적(격자 평균) 상위 {eq['top']:.3f} 평균 {eq['all']:.3f}, 격자별 상위/평균 {bt['grids']['ratioMin']:.3f}"
            f"~{bt['grids']['ratioMax']:.3f}, 무작위 10% {_f(rt.get('p05'), '.3f')}~{_f(rt.get('p95'), '.3f')}")
    cal = engine.calibrate(ds, score_oos, pl)
    if cal:
        log(f"  · 확률 보정 a {cal['a']:+.3f} b {cal['b']:+.3f}, σ {_f(cal.get('sigma'), '.4f')}, 10분위 적중 "
            f"{[round(x['hit'], 3) if x else None for x in cal['byDecile']]}")
    bins = engine.score_bins(ds, score_oos, pl)
    if bins:
        rel = bins.get("reliability") or {}
        log(f"  · 점수 구간표: 10구간 이긴 비율 {[round(b['hit'], 3) for b in bins['bins']]} / 보류 신뢰도 오차 "
            f"{_f(rel.get('calibErr'), '.3f')}, 최상위 구간 예상 {_f(rel.get('topPredHit'), '.3f')} → 실제 {_f(rel.get('topHit'), '.3f')}")
    recbt = None
    if bt:
        try:
            tr0 = time.time()
            us_bases = set()
            if market == "binance":
                us_bases = {c.split(".")[0] for c in history.load_index(Path(hist_dir) / "us")["universe"]}
            tok = [c for c in P["codes"] if recrule.is_stock_token(market, str(c).split("#")[0],
                                                                    (uni["names"].get(c) or [None])[0], us_bases)]
            recbt = recrule.backtest(ds, score_oos, pl, P, F, M, market, log=log, excl_codes=tok)
            log(f"  · 추천 규칙 백테스트 {time.time() - tr0:.0f}초")
        except Exception as e:  # 백테스트 실패가 예측을 막지 않게
            log(f"  · 추천 규칙 백테스트 실패: {e}")
    an = None
    if bt:
        ta = time.time()
        an = analogs.backtest_ic(P["c"], ds, bt["_grid"], H, actual=P["actual"])
        if an:
            log(f"  · 유사 패턴 검증 IC {an['ic']:+.4f} (n {an['n']}, t {_f(an.get('t'), '.2f')}) {time.time() - ta:.0f}초")
    verdict = bt["verdict"] if bt else "none"

    tf = time.time()
    models, n_train = engine.fit_final(ds, cfg, kinds, pl, threads)
    qmodels, qcal = engine.fit_quantiles(ds, cfg, pl, threads, log)
    log(f"  최종 학습 {time.time() - tf:.0f}초 (학습 행 {n_train:,})")

    # ── 오늘 예측 ─────────────────────────────────────
    rows = np.arange(ds["starts"][last], ds["starts"][last + 1])
    if len(rows) == 0:
        raise RuntimeError("마지막 날짜에 점수 대상 종목이 없다")
    codes_today = [P["codes"][j] for j in ds["si"][rows]]
    Xt = ds["Xr"][rows]
    raw = {k: models[k].predict(Xt, threads) for k in kinds}
    # 오늘 횡단면(유니버스 + 최근 빠진 종목) 안 백분위 평균 — 검증 때와 같은 방식
    pct_all = np.mean([_pct(raw[k]) for k in kinds], axis=0)
    qlog = engine.predict_quantiles(qmodels, qcal, ds["Xq"][rows])
    # 검증에서 근거가 없으면(판정 none) 기여도를 수익률 단위로 바꾸지 않는다 (근거 없는 숫자를 만들지 않게)
    impact, zc = engine.contributions(models, Xt, bt["rankIC"] if bt and verdict != "none" else 0.0,
                                      (cal or {}).get("sigma"))
    base_keys = [n.split(":", 1)[1] for n in ds["Xr_names"]]  # r:ret_20 과 v:ret_20 은 같은 특징으로 합친다
    ukeys = list(dict.fromkeys(base_keys))
    merge_m = np.zeros((len(base_keys), len(ukeys)))
    for i, k in enumerate(base_keys):
        merge_m[i, ukeys.index(k)] = 1.0
    impact_b, z_b = impact @ merge_m, zc @ merge_m
    # 근거 문장용: 원래 값과 '오늘 유니버스' 안 백분위 (문장의 '시장 상위 x%' 가 화면의 종목 목록 기준이 되게)
    lag_set = set(lag)
    score_set = uset - lag_set
    el_last = P["elig"].iloc[[last]].copy()
    el_last.iloc[0, ~P["elig"].columns.isin(list(score_set))] = False
    raw_vals = {k: F[k].iloc[last].values for k in F}
    pct_vals = {k: features.xs_rank(F[k].iloc[[last]], el_last).iloc[0].values for k in F}
    reg_vals = {k: float(M[k].iloc[last]) for k in M}
    sel_u = el_last.iloc[0].values
    mkt_med = {k: float(np.nanmedian(np.where(sel_u, raw_vals[k], np.nan))) if sel_u.any() else None
               for k in raw_vals if k.startswith("ret_")}

    in_u = [i for i, c in enumerate(codes_today) if c in score_set]
    if not in_u:
        raise RuntimeError("오늘 점수를 매길 종목이 없다")
    order = sorted(in_u, key=lambda i: -pct_all[i])
    n_u = len(order)
    C = P["c"].values
    A = P["actual"].values
    dates = P["dates"]
    w52 = features.W52[market]
    names = uni["names"]
    warn = set(uni.get("warn") or ())
    # 단기·중기·장기 예상 — 비슷한 과거 자리(백데이터)의 실제 결과 + 워크포워드 검증 (모형 점수와 별개)
    ol, olbt = outlook.run(P, F, M, market, [int(ds["si"][rows[i]]) for i in order], log=log)
    _hr = _hourly(market)
    olbt = {"단기": (_hr or {}).get("backtest"), **olbt}
    with np.errstate(all="ignore"):
        dv_last = (P["c"] * P["v"]).iloc[-20:].mean().values
    dv_s = np.where(el_last.iloc[0].values & np.isfinite(dv_last), dv_last, np.nan)
    okd = np.isfinite(dv_s)
    rec_dv_pct = np.full(len(dv_s), np.nan)
    if okd.any():
        rr = np.empty(okd.sum())
        rr[np.argsort(dv_s[okd], kind="stable")] = np.arange(okd.sum())
        rec_dv_pct[okd] = (rr + 0.5) / okd.sum()
    flag_heat, flag_down = _flags_last(P, market)
    hourly = _hourly(market)
    out_sym = Path(out_dir) / "sym" / market
    written = set()
    items = []
    ta = time.time()
    for rank, i in enumerate(order, start=1):
        code = codes_today[i]
        j = int(ds["si"][rows[i]])
        pct_rank = 100.0 * (n_u - rank) / (n_u - 1) if n_u > 1 else 50.0
        # 근거 있는 점수: 오늘 백분위가 속한 구간의 과거(검증 구간) 실제 결과 × 검증 등급 (none 이면 판단 보류)
        g = engine.grounded(bins, float(pct_all[i]), verdict)
        score = g["score"] if g else None
        pu = g["probBeat"] if g else None
        q = [math.expm1(float(v)) for v in qlog[i]]
        its = []
        for col, k in enumerate(ukeys):
            if k in M:
                its.append((k, reg_vals[k], None, float(impact_b[i, col]), float(z_b[i, col])))
            else:
                p = float(pct_vals[k][j])
                its.append((k, float(raw_vals[k][j]), p if math.isfinite(p) else None,
                            float(impact_b[i, col]), float(z_b[i, col])))
        col_c = C[:, j]
        hist_n = int(np.isfinite(col_c[-w52:]).sum())
        reasons, contribs = explain.build(its, market, hist=hist_n, mkt=mkt_med)
        z = analogs.znorm(col_c)
        an_items = analogs.describe(col_c, dates, analogs.find(z, col_c, last, H, actual=A[:, j]), H)
        an_stats = analogs.stats(an_items)
        spark = [float(x) for x in col_c[-SPARK:] if math.isfinite(x)]
        nm = names.get(code) or [code, code, None]
        rv = {k: (float(raw_vals[k][j]) if k in raw_vals and math.isfinite(float(raw_vals[k][j])) else None)
              for k in ("atr_14", "vol_60", "ret_20")}
        lo20 = P["l"].iloc[-20:, j].min()
        recx = {"close": float(col_c[last]), "atr": rv["atr_14"], "lo20": float(lo20) if math.isfinite(lo20) else None,
                "dvPct": _nz(rec_dv_pct[j]), "volPct": _nz(pct_vals["vol_60"][j]), "obs": int(P["obs"].iloc[last, j]),
                "heat": bool(flag_heat[j]), "down": bool(flag_down[j])}
        rec = {"sym": f"{market}:{code}", "name": nm[0], "sub": nm[1], "asOf": as_of, "horizon": H,
               "score": score, "pctRank": round(pct_rank, 1), "grade": verdict, "hold": g is None,
               "probBeat": pu, "expEx": g["expEx"] if g else None,
               "rank": rank, "of": n_u, "probUp": pu,
               "q10": q[0], "q50": q[1], "q90": q[2],
               "cone": engine.cone([float(v) for v in qlog[i]], H),
               "reasons": reasons, "contrib": contribs, "analogs": an_items, "analogStats": an_stats,
               "outlook": [_hourly_item(hourly, code)] + ol[j]}
        write_json(out_sym / f"{safe_code(code)}.json", rec)
        written.add(f"{safe_code(code)}.json")
        items.append({"sym": rec["sym"], "name": rec["name"], "sub": rec["sub"], "score": rec["score"], "rank": rank,
                      "pctRank": rec["pctRank"], "grade": verdict, "hold": g is None, "probBeat": pu,
                      "expEx": rec["expEx"], "rec": recx,
                      "probUp": pu, "q10": q[0], "q50": q[1], "q90": q[2], "reasons": reasons, "spark": spark,
                      "analog": ({"n": an_stats["n"], "winRate": an_stats["winRate"], "avg": an_stats["avg"]}
                                 if an_stats else None),
                      "outlook": [{"h": o["h"], "unit": o.get("unit", "d"), "label": o["label"], "q50": o["q50"],
                                   "win": o["win"], "grade": o["grade"]} for o in rec["outlook"]],
                      "_warn": code in warn})
    # 유니버스에서 빠진(또는 오늘 점수에서 뺀) 종목의 지난 결과 파일은 지운다 (오래된 예측이 남아 보이지 않게)
    for p in out_sym.glob("*.json"):
        if p.name not in written:
            try:
                p.unlink()
            except OSError:
                pass
    # 추천 모음(recommend.py)이 상위 10% 전체에서 고를 수 있게 picks 는 최소 상위 10% 까지
    picks = [x for x in items if not x["_warn"]][:max(N_PICKS, math.ceil(0.1 * n_u))]
    avoid = sorted(items, key=lambda x: x["rank"], reverse=True)[:N_AVOID]
    for x in items:
        x.pop("_warn", None)
    # 오늘 유니버스 전체에서 평균 |기여(z)| 가 큰 특징 — 모형이 지금 무엇을 보고 줄을 세우는지
    imp = np.abs(z_b[in_u]).mean(axis=0)
    top_feats = [explain.label(ukeys[c], market) for c in np.argsort(-imp)[:4]]
    obs_last = P["obs"].iloc[-1]
    n_short = len([c for c in ucodes if c in obs_last.index and obs_last[c] < features.MIN_OBS and c not in lag_set])
    if bt:
        backtest = {k: v for k, v in bt.items() if not k.startswith("_")}
    else:
        backtest = {"from": None, "to": None, "periods": 0, "rankIC": None, "icIR": None, "icPositiveRate": None,
                    "topExcess": None, "topHitRate": None, "equity": [], "verdict": "none"}
    ctx = {"n_extra": n_extra, "warn_n": len([c for c in warn if c in uset]),
           "pegged_n": len(pegged & set(uni["codes"])), "n_adj": P["adjusted"], "top_feats": top_feats,
           "n_short": n_short, "n_lag": len(lag), "as_of": as_of,
           "hist_years": (dates[-1] - dates[0]).days / 365.25, "olbt": olbt, "bins": bins}
    res = {
        "asOf": as_of, "horizon": H, "universe": n_u,
        "model": {"kind": engine.KIND_NAME, "trainedAt": now_iso(), "trainRows": int(n_train), "features": int(ds["Xr"].shape[1])},
        "backtest": backtest,
        "notes": make_notes(market, bt, cal, qcal, an, ctx),
        "picks": picks, "avoid": avoid,
        "grade": verdict,
        "scoreBins": ({"bins": bins["bins"], "reliability": bins["reliability"], "n": bins["n"], "from": bins["from"],
                       "to": bins["to"], "gradeWeight": engine.GRADE_W.get(verdict)} if bins else None),
        "recBacktest": recbt,
        "regime": {"mkt20": reg_vals.get("mkt_ret_20"), "breadth": reg_vals.get("mkt_breadth")},
        "outlookBacktest": olbt,  # write_summary 가 summary 최상위 outlookBacktest[market] 으로 옮긴다
    }
    log(f"[{market}] 예측 {n_u}종목 기준일 {as_of} 판정 {verdict} — 파일 {time.time() - ta:.0f}초, 시장 전체 {time.time() - t0:.0f}초")
    return res


def _nz(x):
    try:
        x = float(x)
    except (TypeError, ValueError):
        return None
    return x if math.isfinite(x) else None


def _flags_last(P, market):
    """마지막 날 과열 주의·하락 경고 (setups.py 판정)"""
    import setups
    N = len(P["codes"])
    heat, down = np.zeros(N, bool), np.zeros(N, bool)
    prm = setups.params(market)
    cols = {k: P[k].iloc[-260:].values for k in ("o", "h", "l", "c", "v")}
    for j in range(N):
        c = cols["c"][:, j]
        ok = np.isfinite(c)
        if ok.sum() < 30 or not ok[-1]:
            continue
        gaps = np.nonzero(~ok)[0]
        a = int(gaps[-1]) + 1 if len(gaps) else 0
        S = setups.Series(*(np.nan_to_num(cols[k][a:, j]).tolist() for k in ("o", "h", "l", "c", "v")))
        i = len(c) - a - 1
        for arr, fn in ((heat, setups.overheat), (down, setups.downtrend_warn)):
            try:
                arr[j] = fn(S, i, prm, False) is not None
            except (TypeError, ZeroDivisionError, ValueError, IndexError):
                pass
    return heat, down


HOURLY_DIR = Path(__file__).resolve().parent.parent.parent / "web" / "public" / "data" / "predict" / "hourly"


def _hourly(market):
    try:
        return json.loads((HOURLY_DIR / f"{market}.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def _hourly_item(hr, code):
    """단기(1시간) 항목 — hourly.py 결과(따로 매시간 갱신)를 학습 시점 값으로 넣어 둔다. 최신 값은 predict/hourly/<시장>.json"""
    item = {"h": 1, "unit": "h", "label": "단기", "n": 0, "q10": None, "q50": None, "q90": None, "win": None,
            "base": None, "grade": (hr or {}).get("grade"), "asOf": (hr or {}).get("asOf"), "src": "hourly"}
    it = ((hr or {}).get("items") or {}).get(code)
    if it:
        item.update(n=it["n"], q10=it["q10"], q50=it["q50"], q90=it["q90"], win=it["win"])
    else:
        item["reason"] = (hr or {}).get("reason") or "1시간 예상이 아직 없어요(시간봉 이력이 짧거나 이 종목은 시간봉을 받지 않아요)."
    return item


def _pct(x):
    """한 날짜 점수 → 백분위(0~1, 가운데 정렬)"""
    x = np.asarray(x, dtype=float)
    r = np.empty(len(x))
    r[np.argsort(x, kind="stable")] = np.arange(len(x))
    return (r + 0.5) / max(1, len(x))


def write_summary(out_dir, results, log=print):
    path = Path(out_dir) / "summary.json"
    try:
        old = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        old = {}
    ok_old = isinstance(old, dict) and old.get("version") == 1
    markets = dict(old.get("markets") or {}) if ok_old else {}
    obt = dict(old.get("outlookBacktest") or {}) if ok_old else {}
    for m, r in results.items():  # 이번에 실패한 시장은 직전 결과를 그대로 둔다
        r = dict(r)
        ob = r.pop("outlookBacktest", None)
        if ob is not None:
            obt[m] = ob
        markets[m] = r
    order = [m for m in ("upbit", "binance", "krx", "us") if m in markets]
    write_json(path, {"version": 1, "updatedAt": now_iso(), "markets": {m: markets[m] for m in order},
                      # 단기·중기·장기 예상의 워크포워드 검증 {시장: {단기|중기|장기: {coverage, dirHit, calib, periods, grade, …}}}
                      "outlookBacktest": {m: obt[m] for m in order if m in obt}})
    log(f"summary.json 저장 ({', '.join(order)})")
