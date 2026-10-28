"""결론 한두 문장 — 클로드(collector/ai.py 의 ai.write)가 숫자를 보고 쓰고, 못 쓰면 규칙 문장.

돈이 드니 숫자가 크게 바뀔 때만 다시 부른다: 24시간 오를 확률 5%p 이상 · 예상 변화율 0.3%p 이상 ·
범위 폭 30% 이상 · 갈림길 종류나 위/아래가 바뀜(마지막 글에서 2시간 지난 뒤) · 마지막 글이 6시간 넘음 → 하루 최대 약 12번.
클로드 글은 검사한다: 해요체, 길이, 투자 권유·단정 표현 금지, 입력에 없는 숫자 금지 — 하나라도 어기면 규칙 문장.
"""
import re
import time

from . import core

REFRESH_H = 6
MIN_GAP_H = 2
BANNED = ("사세요", "파세요", "매수", "매도", "추천", "기회", "확실", "반드시", "보장", "틀림없", "오를 거", "내릴 거",
          "떨어질 거", "오를것", "내릴것", "수익을", "벌 수", "진입", "손절", "익절", "물타", "풀매", "몰빵", "!", "ㅋ", "\"", "“", "”")

SYSTEM = (
    "너는 '마켓' 사이트 첫 화면의 비트코인 예측 카드에 들어갈 24시간 결론을 쓴다. "
    "규칙: 한국어 해요체로 1~2문장, 합쳐서 110자 이내. 입력에 있는 숫자와 표현만 쓰고 새 숫자를 만들거나 계산하지 않는다. "
    "가격은 입력에 적힌 그대로(예: '1억 835만 원') 쓰거나 쓰지 않는다. "
    "투자 권유를 하지 않는다(사라·팔라·매수·매도·추천·기회 같은 말 금지). '오를 거예요'처럼 단정하지 않고 '오를 쪽이 조금 커요', '거의 반반이에요'처럼 쓴다. "
    "입력에 방향 예측력이 약하다고 적혀 있으면 그 점을 먼저 짧게 밝힌다. "
    "이모지·따옴표·제목·머리말 없이 문장만 쓴다."
)


def lean_h(h, m, u):
    """결론 한 마디 — 예상 변화율이 0 근처면서 확률도 50% 근처거나, 둘의 방향이 엇갈리면 '거의 반반'"""
    near = 0.0015 if h == 24 else 0.0003
    if (abs(m) < near and abs(u - 0.5) < (0.03 if h == 24 else 0.02)) or m == 0 or (m > 0) != (u > 0.5):
        return "거의 반반이에요"
    big = abs(u - 0.5) >= (0.06 if h == 24 else 0.04)
    return ("오를 쪽이 " if m > 0 else "내릴 쪽이 ") + ("조금 더 커요" if big else "아주 조금 커요")


def lean(f24):
    return lean_h(24, f24["m"], f24["u"])


EDGE_WORDS = {"none": "거의 없음(동전 던지기 수준)", "weak": "약함", "some": "조금 있음"}


def facts(state):
    """AI 에 줄 입력 (화면에 보이는 숫자와 같은 표기)"""
    f24, pv, bt = state["f24"], state.get("pivot"), state.get("bt") or {}
    p = state["price"]
    lines = [
        f"시각: {state['asOfLabel']}, 업비트 비트코인 {core.krw(p)}",
        f"24시간 뒤 예상: {core.pct(f24['m'])} (약 {core.krw(p * (1 + f24['m']))}), 오를 확률 {round(f24['u'] * 100)}%",
        f"10번 중 8번 범위(24시간): {core.pct(f24['lo'])} ~ {core.pct(f24['hi'])} ({core.krw(p * (1 + f24['lo']))} ~ {core.krw(p * (1 + f24['hi']))})",
    ]  # 1시간 숫자는 화면이 정시마다 브라우저에서 새로 계산하므로 결론에 넣지 않는다 (글과 숫자가 엇갈리지 않게)
    if pv:
        side = "위(강세 쪽)" if pv["side"] == "above" else "아래(약세 쪽)"
        lines.append(f"갈림길: {core.krw(pv['price'])} ({pv['label']}) — 지금은 이 선 {side}, {core.pct(abs(pv['dist']), 1, sign=False)} 차이")
    b24 = bt.get("h24")
    if b24:
        lines.append(f"지난 1년 되짚어 본 성적(매일 1번): 24시간 방향 맞힘 {round(b24['hit'] * 100)}%, 범위 안 {round(b24['cov'] * 100)}%")
    lines.append(f"24시간 방향 예측력: {EDGE_WORDS.get(state.get('edge24'), '아직 검증 전')}")
    lines.append(f"규칙으로 정한 결론: {lean(f24)}")
    return "\n".join(lines)


def _nums(s):
    return set(re.sub(r"[,]", "", x).lstrip("0") or "0" for x in re.findall(r"\d[\d,]*(?:\.\d+)?", s))


def check(text, allowed):
    t = (text or "").strip()
    if not t or len(t) > 140 or "\n" in t.strip():
        return None
    if any(b in t for b in BANNED):
        return None
    if not t.endswith(("요.", "요", "요!", "죠.", "니다.")):
        return None
    if not _nums(t) <= _nums(allowed):
        return None
    return t


def rule_text(state):
    f24, pv = state["f24"], state.get("pivot")
    p = state["price"]
    s = f"24시간 뒤 예상은 {core.pct(f24['m'])}로 {lean(f24)}."
    s2 = f" 10번 중 8번은 {core.krw(p * (1 + f24['lo']))} ~ {core.krw(p * (1 + f24['hi']))} 안에서 끝났어요."
    if pv and abs(pv["dist"]) <= max(abs(f24["lo"]), abs(f24["hi"])):
        s2 = f" {core.krw(pv['price'])}({pv['label']}) 아래로 가면 약세 쪽, 위면 강세 쪽이에요."
    return s + s2


def need_refresh(prev, state, now):
    if not prev or prev.get("by") != "ai":
        return True
    b = prev.get("basis") or {}
    f24 = state["f24"]
    pv = state.get("pivot") or {}
    age = now - (prev.get("atTs") or 0)
    if age >= REFRESH_H * 3600 or b.get("lean") != lean(f24):  # 결론 방향이 바뀌면 바로 (옛 글과 숫자가 엇갈리지 않게)
        return True
    if age < MIN_GAP_H * 3600:  # 가격이 갈림길 근처에서 오르내려도 2시간에 한 번까지만
        return False
    if abs(f24["u"] - b.get("u24", 0.5)) >= 0.05 or abs(f24["m"] - b.get("m24", 0.0)) >= 0.003:
        return True
    w, w0 = f24["hi"] - f24["lo"], b.get("w24") or 0
    if w0 and abs(w / w0 - 1) >= 0.3:
        return True
    if pv.get("kind") != b.get("pk") or pv.get("side") != b.get("ps"):
        return True
    return False


def conclusion(state, prev, use_ai=True, log=print):
    """{text, by: ai|rule, at, atTs, basis} — prev 는 직전 btc.json 의 summary"""
    now = time.time()
    f24, pv = state["f24"], state.get("pivot") or {}
    basis = {"u24": round(f24["u"], 4), "m24": round(f24["m"], 5), "w24": round(f24["hi"] - f24["lo"], 5),
             "pk": pv.get("kind"), "ps": pv.get("side"), "lean": lean(f24)}
    if use_ai and need_refresh(prev, state, now):
        text, provider = None, None
        user = facts(state)
        try:
            import ai  # collector/ai.py (클로드 연결 담당) — 클로드 → Gemma → None
            text = ai.write(who="btc", system=SYSTEM, user=user, max_tokens=400)
            if text:
                provider = (ai.last("btc") or {}).get("provider")
        except ImportError:
            text = None
        except Exception as e:  # AI 쪽 문제로 카드가 깨지면 안 된다
            log(f"[btc] AI 결론 실패: {e}")
            text = None
        ok = check(text, user) if isinstance(text, str) else None
        if text and not ok:
            log(f"[btc] AI 결론 검사 탈락 → 규칙 문장: {text!r}")
        if ok:
            return {"text": ok, "by": "ai", "provider": provider if provider in ("claude", "gemma") else "ai",
                    "at": core.iso(now), "atTs": int(now), "basis": basis}
    elif use_ai and prev and prev.get("by") == "ai":
        return prev  # 숫자가 크게 안 바뀌었으면 직전 클로드 글 그대로 (돈 아끼기)
    return {"text": rule_text(state), "by": "rule", "at": core.iso(now), "atTs": int(now), "basis": basis}
