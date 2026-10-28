"""예측 근거 → 한국어 문장. 문장 속 숫자는 그날 실제 특징 값·시장 내 백분위 그대로 쓴다."""
import math

from features import EXTRA, EXTRA_REGIME, FEATURES, MOM_WIN, REGIME, W52

LABELS = {k: v[0] for d in (FEATURES, REGIME, EXTRA, EXTRA_REGIME) for k, v in d.items()}
COIN = ("upbit", "binance")


def _x(v):
    """배율 → '4.1배' · 1배 아래는 '30% 수준' ('0.0배'처럼 보이지 않게)"""
    if v >= 0.95:
        return f"{v:.1f}배"
    return f"{max(1, round(v * 100))}% 수준" if v >= 0.005 else "1%도 안 되는 수준"


def _unit(market):
    return "일" if market in COIN else "거래일"


def label(key, market):
    """기여도 목록·notes 용 이름 — 실제 계산 창과 맞춘다"""
    if key == "mom_12_1":
        skip, year = MOM_WIN[market]
        return f"12-1 모멘텀({year}~{skip}{_unit(market)} 전 수익률)"
    return LABELS.get(key, key)


def _p(x, digits=1):
    """분수 → 부호 있는 퍼센트 문자열"""
    return f"{x * 100:+.{digits}f}%"


def _u(x, digits=1):
    return f"{x * 100:.{digits}f}%"


def _pos(pct):
    """시장 안 백분위(0~1) → '시장 상위 5%' / '시장 하위 12%'"""
    if pct is None or not math.isfinite(pct):
        return ""
    if pct >= 0.5:
        return f"시장 상위 {max(1, round((1 - pct) * 100))}%"
    return f"시장 하위 {max(1, round(pct * 100))}%"


def _with_pos(text, pct):
    p = _pos(pct)
    return f"{text} ({p})" if p else text


def _with_loss_pos(text, pct, noun):
    """손실형 지표(값이 클수록 손실이 작다): '상위'가 반대로 읽히지 않게 '…이 작은 쪽 x%' 로 쓴다"""
    if pct is None or not math.isfinite(pct):
        return text
    if pct >= 0.5:
        return f"{text} ({noun} 작은 쪽 {max(1, round((1 - pct) * 100))}%)"
    return f"{text} ({noun} 큰 쪽 {max(1, round(pct * 100))}%)"


def _won(x, market):
    """거래대금 → 읽기 쉬운 금액"""
    if market in ("krx", "upbit"):
        return f"{x / 1e8:,.0f}억 원" if x >= 1e8 else f"{x / 1e4:,.0f}만 원"
    return f"${x / 1e6:,.1f}M" if x >= 1e6 else f"${x / 1e3:,.0f}K"


def sentence(key, v, pct, market, hist=None, mkt=None):
    """key 특징의 값 v, 시장 내 백분위 pct → 문장. 값이 없으면 None.
    hist: 최근 52주 창 안에 실제로 있는 봉 수 (짧으면 '52주' 대신 '상장(재개) 후 n일')"""
    if v is None or not math.isfinite(v):
        return None
    short = hist is not None and hist < W52[market] - 5
    span = f"상장(재개) 후 {hist}{_unit(market)}" if short else "52주"
    if key.startswith("ret_"):
        n = key[4:]
        med = (mkt or {}).get(key)
        if med is not None and math.isfinite(med) and n != "1":
            d = v - med
            word = "강함" if d > 0 else "약함"
            return _with_pos(f"최근 {n}{_unit(market)} {_p(v)} — 시장(중앙값 {_p(med)})보다 {d * 100:+.1f}%p {word}", pct)
        return _with_pos(f"{'어제 하루' if n == '1' else f'최근 {n}{_unit(market)}'} 수익률 {_p(v)}", pct)
    if key == "mom_12_1":
        skip, year = MOM_WIN[market]
        if market in COIN:
            return _with_pos(f"1년 전~{skip}일 전 수익률(최근 한 달 제외) {_p(v)}", pct)
        return _with_pos(f"{year}~{skip}거래일 전 수익률(최근 한 달 제외) {_p(v)}", pct)
    if key.startswith("gap_ma"):
        n = key[6:]
        return _with_pos(f"{n}일 이동평균보다 {_u(abs(v))} {'위' if v >= 0 else '아래'}", pct)
    if key == "slope_ma20":
        return f"20일 이동평균이 5일 동안 {_p(v, 2)} ({'오름세' if v > 0 else '내림세'})"
    if key == "slope_ma60":
        return f"60일 이동평균이 20일 동안 {_p(v)} ({'오름세' if v > 0 else '내림세'})"
    if key == "ma_align":
        if v >= 3:
            return "이동평균 정배열 (5>20>60>120일)"
        if v <= -3:
            return "이동평균 역배열 (5<20<60<120일)"
        return f"이동평균 혼조 (배열 점수 {v:+.0f})"
    if key == "rsi_14":
        tag = " — 과매수권" if v >= 70 else " — 과매도권" if v <= 30 else ""
        return f"RSI(14) {v:.0f}{tag}"
    if key == "stoch_14":
        tag = " — 최근 고점권" if v >= 80 else " — 최근 저점권" if v <= 20 else ""
        return f"스토캐스틱 %K {v:.0f}{tag}"
    if key == "macd":
        return f"MACD {'양(+)' if v >= 0 else '음(-)'} — 가격의 {_p(v, 2)}"
    if key == "macd_hist":
        return f"MACD 히스토그램 {'양(+)' if v >= 0 else '음(-)'} ({_p(v, 2)}) — 단기 추세 {'강화' if v >= 0 else '약화'}"
    if key == "bb_pctb":
        if v > 1:
            return "볼린저 밴드 상단 위에서 마감"
        if v < 0:
            return "볼린저 밴드 하단 아래에서 마감"
        return f"볼린저 밴드 안 {v * 100:.0f}% 위치"
    if key == "bb_width":
        return _with_pos(f"볼린저 밴드폭 {_u(v)}", pct)
    if key == "atr_14":
        return _with_pos(f"하루 평균 변동폭(ATR) {_u(v)}", pct)
    if key in ("vol_20", "vol_60"):
        return _with_pos(f"{key[4:]}일 변동성 하루 {_u(v, 2)}", pct)
    if key == "vol_ratio":
        return f"최근 20일 변동성이 60일의 {_x(v)}"
    if key == "volu_1_20":
        return _with_pos(f"마지막 날 거래량이 20일 평균의 {_x(v)}", pct)
    if key == "volu_5_20":
        return _with_pos(f"최근 5일 거래량이 20일 평균의 {_x(v)}", pct)
    if key == "volu_20_60":
        return _with_pos(f"20일 거래량이 60일 평균의 {_x(v)}", pct)
    if key == "hi_52w":
        return _with_pos(f"{span} 고점 대비 {_p(v)}" if v < -0.0005 else f"{span} 고점 부근", pct)
    if key == "lo_52w":
        return _with_pos(f"{span} 저점 대비 {_p(v)}", pct)
    if key == "mdd_60":
        return _with_loss_pos(f"최근 60일 최대 낙폭 {_p(v)}", pct, "낙폭이")
    if key in ("up_20", "up_60"):
        return f"최근 {key[3:]}일 중 상승한 날 {v * 100:.0f}%"
    if key == "max_ret_20":
        return _with_pos(f"최근 20일 하루 최대 상승 {_p(v)}", pct)
    if key == "min_ret_20":
        return _with_loss_pos(f"최근 20일 하루 최대 하락 {_p(v)}", pct, "하락폭이")
    if key == "skew_60":
        return f"60일 수익률 분포 {'급등 쪽' if v > 0 else '급락 쪽'}으로 치우침 (왜도 {v:+.1f})"
    if key == "clv_5":
        tag = "고가권" if v >= 0.65 else "저가권" if v <= 0.35 else "중간"
        return f"최근 5일 종가가 하루 고저 범위의 {v * 100:.0f}% 지점 ({tag} 마감)"
    if key == "gap_20":
        return f"20일 누적 시초가 갭 {_p(v)}"
    if key == "intra_20":
        return f"20일 누적 장중(시가→종가) 수익 {_p(v)}"
    if key == "ram_60":
        return _with_pos(f"변동성 대비 60일 수익 {v:+.2f}", pct)
    if key == "beta_60":
        return _with_pos(f"시장 민감도(베타) {v:.2f}", pct)
    if key == "ivol_60":
        return _with_pos(f"종목 고유 변동성 하루 {_u(v, 2)}", pct)
    if key.startswith("rs_"):
        return f"{key[3:]}일 상대강도: 시장 중앙값보다 {v * 100:+.1f}%p"
    if key == "age":
        return f"상장 {v:.0f}일째 (신규 상장)" if v < 365 else "상장 1년 이상"
    if key == "kp_rel":
        return _with_pos(f"김치 프리미엄이 다른 코인 평균보다 {v * 100:+.1f}%p {'높음' if v > 0 else '낮음'}", pct)
    if key == "kp_chg5":
        return _with_pos(f"김치 프리미엄이 5일 새 {v * 100:+.1f}%p {'커짐' if v > 0 else '줄어듦'}", pct)
    if key == "dv_20":
        return _with_pos(f"20일 평균 거래대금 {_won(math.exp(v), market)}", pct)
    if key == "dv_trend":
        return _with_pos(f"최근 5일 거래대금이 60일 평균의 {_x(v)}", pct)
    if key == "amihud_20":
        return _with_pos("적은 거래에도 가격이 크게 움직이는 편(비유동성)" if (pct or 0) >= 0.5
                         else "거래가 많아 가격 충격이 작은 편(유동성 좋음)", pct)
    if key == "btc_ret_20":
        return f"비트코인 20일 수익률 {_p(v)}"
    if key == "mkt_ret_20":
        return f"시장 전체 20일 수익률 {_p(v)} (중앙값)"
    if key == "mkt_ret_60":
        return f"시장 전체 60일 수익률 {_p(v)} (중앙값)"
    if key == "mkt_vol_20":
        return f"시장 전체 변동성 하루 {_u(v, 2)} (중앙값)"
    if key == "mkt_breadth":
        return f"60일선 위 종목 비율 {v * 100:.0f}%"
    if key == "mkt_disp_20":
        return f"종목 간 20일 수익률 격차(사분위 범위) {_u(v)}"
    return f"{LABELS.get(key, key)} {v:.3g}"


def _side(pct):
    """시장 안 백분위 → ('lo'|'hi', '전체 하위 12%') — 가운데 40% 는 (None, '')"""
    if pct is None or not math.isfinite(pct):
        return None, ""
    if pct >= 0.7:
        return "hi", f"전체 상위 {max(1, round((1 - pct) * 100))}%"
    if pct <= 0.3:
        return "lo", f"전체 하위 {max(1, round(pct * 100))}%"
    return None, ""


def easy_one(key, v, pct, market):
    """특징 하나 → 짧고 쉬운 한 줄. '무엇보다 어떻다'를 숫자로 (전문 용어는 괄호로만). 없으면 None"""
    if v is None or not math.isfinite(v):
        return None
    coin = market in COIN
    u = _unit(market)
    who = "코인" if coin else "종목"
    side, pos = _side(pct)
    if key == "kp_rel":
        if abs(v) < 0.0005:
            return None
        return f"해외 거래소 값보다 붙는 웃돈(김프)이 다른 코인보다 {abs(v) * 100:.1f}%p {'낮아요' if v < 0 else '높아요'}"
    if key == "kp_chg5":
        if abs(v) < 0.0005:
            return None
        return f"해외 값보다 붙는 웃돈(김프)이 최근 5{u} 새 {abs(v) * 100:.1f}%p {'줄었어요' if v < 0 else '커졌어요'}"
    if key in ("atr_14", "vol_20", "vol_60", "ivol_60"):
        if not side:
            return None
        what = {"atr_14": "하루 평균 출렁임", "vol_20": "최근 20일 하루 흔들림", "vol_60": "최근 60일 하루 흔들림",
                "ivol_60": "시장과 따로 노는 하루 흔들림"}[key]
        return f"{what}이 {v * 100:.1f}%로 다른 {who}보다 {'커요' if side == 'hi' else '작아요'} ({pos})"
    if key in ("volu_1_20", "volu_5_20", "volu_20_60"):
        if 0.8 <= v <= 1.25:
            return None
        span = {"volu_1_20": "어제" if coin else "전 거래일", "volu_5_20": f"최근 5{u}", "volu_20_60": f"최근 20{u}"}[key]
        ref = f"60{u} 평균" if key == "volu_20_60" else f"20{u} 평균"
        return f"{span} 거래량이 {ref}의 {_x(v)}{'로' if v >= 0.95 else '으로'} {'늘었어요' if v > 1 else '줄었어요'}"
    if key.startswith("gap_ma"):
        n = key[6:]
        if abs(v) < 0.005:
            return None
        return f"가격이 {n}{u} 평균보다 {abs(v) * 100:.1f}% {'높아요' if v > 0 else '낮아요'}" + (" (짧게 눌림)" if v < 0 and n == "5" else "")
    if key == "ret_1":
        return f"{'어제' if coin else '전 거래일'} {abs(v) * 100:.1f}% {'올랐어요' if v > 0 else '내렸어요'}" if abs(v) >= 0.001 else None
    if key == "ret_5":
        return f"최근 5{u} {v * 100:+.1f}% {'오른' if v > 0 else '빠진'} 뒤예요" if abs(v) >= 0.01 else None
    if key in ("ret_20", "ret_60", "ret_120", "ret_250"):
        return f"최근 {key[4:]}{u} {v * 100:+.1f}% {'올랐어요' if v > 0 else '내렸어요'}" if abs(v) >= 0.01 else None
    if key == "mom_12_1":
        return f"1년 흐름(최근 한 달 빼고) {v * 100:+.0f}%"
    if key == "rsi_14":
        return (f"최근 많이 올라 과열 쪽이에요 (RSI {v:.0f})" if v >= 70 else
                f"많이 내려 바닥 쪽이에요 (RSI {v:.0f})" if v <= 30 else None)
    if key == "beta_60":
        if not side:
            return None
        return f"시장이 1% 움직일 때 평균 {v:.1f}% 따라 움직였어요 ({pos})"
    if key == "mdd_60":
        if not side:
            return None
        return f"최근 60{u} 고점에서 가장 크게 빠진 폭이 {abs(v) * 100:.0f}%로 다른 {who}보다 {'작아요' if side == 'hi' else '커요'}"
    if key == "min_ret_20":
        if not side:
            return None
        return f"최근 20{u} 하루 최대 하락이 {abs(v) * 100:.1f}%로 다른 {who}보다 {'작아요' if side == 'hi' else '커요'}"
    if key == "max_ret_20":
        return f"최근 20{u} 하루에 가장 크게 오른 날이 {v * 100:+.1f}%예요"
    if key == "hi_52w":
        return f"1년 고점보다 {abs(v) * 100:.0f}% 낮아요" if v < -0.01 else "1년 고점 근처예요"
    if key == "lo_52w":
        return f"1년 저점보다 {v * 100:.0f}% 높아요"
    if key == "macd_hist":
        return f"단기 흐름(MACD)이 {'힘을 얻는' if v > 0 else '약해지는'} 중이에요"
    if key == "slope_ma20":
        return f"20{u} 평균 가격이 최근 5{u} 새 {v * 100:+.1f}% 움직였어요" if abs(v) >= 0.005 else None
    if key == "slope_ma60":
        return f"60{u} 평균 가격이 최근 20{u} 새 {v * 100:+.1f}% 움직였어요" if abs(v) >= 0.005 else None
    if key == "stoch_14":
        return ("가격이 최근 2주 범위의 위쪽 끝에 있어요" if v >= 80 else "가격이 최근 2주 범위의 아래쪽 끝에 있어요" if v <= 20 else None)
    if key == "clv_5":
        return ("최근 5일 대부분 하루 범위의 위쪽에서 마감했어요" if v >= 0.65 else
                "최근 5일 대부분 하루 범위의 아래쪽에서 마감했어요" if v <= 0.35 else None)
    if key in ("up_20", "up_60"):
        return f"최근 {key[3:]}{u} 중 {v * 100:.0f}%가 오른 날이에요"
    if key == "intra_20":
        return f"최근 20{u} 장 중(시작가→마감가)에는 {v * 100:+.1f}% 움직였어요"
    if key == "gap_20":
        return f"최근 20{u} 장 시작 때(밤사이) {v * 100:+.1f}% 움직였어요" if not coin else None
    if key == "ram_60":
        return f"흔들림에 비해 최근 60{u} 수익이 {'좋은' if v > 0 else '나쁜'} 편이에요" if side else None
    if key == "amihud_20":
        return (f"적은 거래에도 가격이 크게 움직이는 편이에요 ({pos})" if side == "hi" else
                f"거래가 많아 가격이 덜 흔들리는 편이에요 ({pos})" if side == "lo" else None)
    if key == "ma_align":
        return ("이동평균이 오름 차례로 늘어서 있어요 (정배열)" if v >= 3 else
                "이동평균이 내림 차례로 늘어서 있어요 (역배열)" if v <= -3 else None)
    if key == "bb_pctb":
        return ("가격이 볼린저 밴드 아래쪽 끝에 있어요" if v < 0.1 else "가격이 볼린저 밴드 위쪽 끝에 있어요" if v > 0.9 else None)
    if key == "dv_20":
        return f"하루 거래대금이 {_won(math.exp(v), market)}으로 다른 {who}보다 {'많아요' if side == 'hi' else '적어요'} ({pos})" if side else None
    if key == "dv_trend":
        return f"최근 5{u} 거래대금이 60{u} 평균의 {_x(v)}{'예요' if v >= 0.95 else '이에요'}" if not 0.8 <= v <= 1.25 else None
    if key in ("frgn_d5", "frgn_d20"):
        return f"외국인 보유율이 {key[6:]}거래일 새 {v:+.1f}%p 바뀌었어요" if abs(v) >= 0.05 else None
    if key == "skew_60":
        return ("최근 60일 가끔 크게 튀어 오르는 편이었어요" if v > 0.3 else
                "최근 60일 가끔 크게 빠지는 편이었어요" if v < -0.3 else None)
    if key.startswith("mkt_") or key in ("btc_ret_20", "age", "bb_width", "vol_ratio"):
        return None
    return sentence(key, v, pct, market)


def candidates(items, market, n=6):
    """모형이 이 종목 점수를 올린 근거(기여 z > 0) 중 쉬운 말이 있는 것 n 개 → [{k, t, p, z}] (기여 큰 순)
    k 특징 키 · t 쉬운 문장(숫자 포함) · p 그날 시장 안 백분위(0~1, 없으면 None) · z 모형 점수 기여(표준화)
    — 추천 모음(recommend.py)이 화면 목록 안에서 '다른 종목과 다른 근거'를 고를 때 쓴다"""
    items = [x for x in items if x[1] is not None and math.isfinite(x[1]) and math.isfinite(x[4]) and x[4] > 0]
    items.sort(key=lambda x: -x[4])
    out, seen = [], set()
    for k, v, pct, _, z in items:
        t = easy_one(k, v, pct, market)
        if not t or t in seen:
            continue
        seen.add(t)
        p = round(float(pct), 3) if pct is not None and math.isfinite(pct) else None
        out.append({"k": k, "t": t, "p": p, "z": round(float(z), 3)})
        if len(out) >= n:
            break
    return out


def easy(items, market, n=2, side=None):
    """모형이 이 종목 점수를 올린(side='up', 기본) 이유 n 줄 — 쉬운 말. items = [(key, value, pct, impact, z)]"""
    items = [x for x in items if x[1] is not None and math.isfinite(x[1]) and math.isfinite(x[4])]
    tot = sum(x[4] for x in items)
    side = side or ("up" if tot >= 0 else "down")
    pool = sorted(items, key=lambda x: -x[4] if side == "up" else x[4])
    out, seen = [], set()
    for k, v, pct, _, z in pool:
        if (z <= 0 if side == "up" else z >= 0):
            break
        t = easy_one(k, v, pct, market)
        if not t or t in seen:
            continue
        seen.add(t)
        out.append({"text": t, "tone": side, "key": k})
        if len(out) >= n:
            break
    return out


def tone(z, top_abs):
    """모형 점수를 올린 쪽(up)/내린 쪽(down). 가장 큰 기여의 15% 도 안 되면 flat"""
    if not math.isfinite(z) or abs(z) < max(0.02, 0.15 * top_abs):
        return "flat"
    return "up" if z > 0 else "down"


def build(items, market, n_reasons=4, n_contrib=8, hist=None, mkt=None):
    """items: [(key, value, pct, impact, z)] — impact: 초과수익 단위 기여, z: 모형 점수(표준화) 기여
    기여 순서·방향은 z 로 정한다(검증 IC 가 0 이하라 impact 가 0 이어도 모형이 왜 그 순위를 줬는지는 보이게)."""
    items = [x for x in items if x[1] is not None and math.isfinite(x[1]) and math.isfinite(x[4])]
    items.sort(key=lambda x: -abs(x[4]))
    contrib = [{"key": k, "label": label(k, market), "value": v, "impact": imp}
               for k, v, _, imp, _ in items[:n_contrib]]
    top_abs = abs(items[0][4]) if items else 0.0
    reasons = []
    for k, v, pct, _, z in items:
        s = sentence(k, v, pct, market, hist, mkt)
        if not s:
            continue
        reasons.append({"text": s, "tone": tone(z, top_abs), "key": k})
        if len(reasons) >= n_reasons:
            break
    return reasons, contrib
