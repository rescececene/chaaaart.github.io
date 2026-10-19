"""예측 근거 → 한국어 문장. 문장 속 숫자는 그날 실제 특징 값·시장 내 백분위 그대로 쓴다."""
import math

from features import EXTRA, EXTRA_REGIME, FEATURES, MOM_WIN, REGIME, W52

LABELS = {k: v[0] for d in (FEATURES, REGIME, EXTRA, EXTRA_REGIME) for k, v in d.items()}
COIN = ("upbit", "binance")


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
        return f"최근 20일 변동성이 60일의 {v:.1f}배"
    if key == "volu_1_20":
        return _with_pos(f"마지막 날 거래량이 20일 평균의 {v:.1f}배", pct)
    if key == "volu_5_20":
        return _with_pos(f"최근 5일 거래량이 20일 평균의 {v:.1f}배", pct)
    if key == "volu_20_60":
        return _with_pos(f"20일 거래량이 60일 평균의 {v:.1f}배", pct)
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
        return _with_pos(f"최근 5일 거래대금이 60일 평균의 {v:.1f}배", pct)
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
        reasons.append({"text": s, "tone": tone(z, top_abs)})
        if len(reasons) >= n_reasons:
            break
    return reasons, contrib
