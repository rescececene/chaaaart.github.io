"""AI 문장 공용 입구 — 클로드 하이쿠 우선 → 못 쓰면 Gemma(무료) → 둘 다 안 되면 None

    import ai
    text = ai.write(who="btc", system="…", user="…", max_tokens=400)                       # → str | None
    obj  = ai.write(who="pump", system="…", user="…", max_tokens=800, schema={JSON Schema})  # → dict | None

- 쓰는 곳: 새 예측 문장 (비트코인 결론 btc · 펌핑 설명 pump · 순위 이유 rank). who 는 장부에 모듈별로 쌓인다.
  뉴스 판단·종목 해설(news_ai.py · stock_ai.py)은 이걸 쓰지 않고 Gemma(cf_ai.py)를 직접 쓴다 (무료).
- 예외를 밖으로 던지지 않는다. 실패하면 None — 부르는 쪽은 규칙으로 만든 문장을 대신 쓰면 된다.
- 클로드(claude_ai.py): ANTHROPIC_API_KEY 가 있고, 이 사이트 몫 누적 150달러·하루 3달러 한도 안일 때.
  키가 없거나 한도에 닿았거나 오류면 Gemma 로 → 돈 0원.
- Gemma(cf_ai.py): CF_ACCOUNT_ID · CF_AI_TOKEN 이 있을 때. 무료 사용량은 뉴스 판단이 먼저라
  오늘 전체 7,000 뉴런(GEMMA_STOP)·모듈 하나 1,500 뉴런(GEMMA_WHO_DAILY)이 넘으면 Gemma 로도 쓰지 않는다.
- schema: 최상위가 object 인 JSON Schema. 클로드는 구조화 출력으로 형식을 보장하고,
  Gemma 는 프롬프트로 JSON 을 요청해 파싱한다 (필수 키가 빠지거나 형식이 틀리면 None).
- 누가 썼는지: ai.last("btc") → {"provider": "claude"|"gemma", "model", "usd" 또는 "neurons"} (화면에 'AI 판단' 출처를 적을 때)
- 지금 상태: ai.info() → {"provider", "model", "usd": {"total", "today", "limit", "dailyLimit"}, "reason"}

    python collector/ai.py      # 지금 상태만 본다 (AI 를 부르지 않는다)
"""
import json
import re
import threading
from pathlib import Path

import cf_ai
import claude_ai

DATA = Path(__file__).resolve().parent.parent / "web" / "public" / "data"
GEMMA_STOP = 7000  # 오늘 Gemma 전체 사용량이 이만큼이면 예측 문장은 Gemma 로도 쓰지 않는다 (뉴스 판단 몫을 남긴다)
GEMMA_WHO_DAILY = 1500  # 모듈(who) 하나가 하루(UTC)에 Gemma 로 쓸 수 있는 뉴런 어림
MAX_TOKENS = 4000  # 한 번에 받을 최대 출력 토큰 (큰 값을 넣어도 이만큼만)
JSON_RULE = ("출력 형식: 아래 JSON Schema 에 맞는 JSON 객체 하나만 출력한다. 앞뒤 설명이나 ``` 없이 { 로 시작해 } 로 끝낸다. "
             "필수(required) 키는 모두 넣는다.\nJSON Schema: ")

_LOCK = threading.Lock()
_last = {}
_said = set()
_gemma_off = []


def _who(who):
    w = re.sub(r"[^a-z0-9_\-]", "", str(who or "").lower())[:24]
    return w or "etc"


def _say(key, text):
    """같은 알림은 실행마다 한 번만 찍는다"""
    with _LOCK:
        if key in _said:
            return
        _said.add(key)
    print(text)


def write(who, system, user, max_tokens=400, schema=None):
    """AI 로 글을 쓴다 — 클로드 하이쿠 → (못 쓰면) Gemma → (그것도 안 되면) None. 예외를 던지지 않는다.
    schema(최상위 object 인 JSON Schema)를 주면 dict 를 돌려준다"""
    try:
        return _write(_who(who), system, user, max_tokens, schema)
    except Exception as e:  # 어떤 경우에도 수집을 멈추지 않는다
        print(f"[AI] {who}: 예기치 못한 오류 — {claude_ai.scrub(e)[:200]}")
        return None


def _write(who, system, user, max_tokens, schema):
    with _LOCK:
        _last.pop(who, None)  # 이번에 실패하면 last(who) 는 None
    system, user = str(system or ""), str(user or "")
    if not user.strip():
        return None
    if schema is not None and (not isinstance(schema, dict) or schema.get("type") != "object"):
        _say(f"schema:{who}", f"[AI] {who}: schema 는 최상위가 object 인 JSON Schema 여야 해요 — 건너뜀")
        return None
    try:
        n = max(16, min(MAX_TOKENS, int(max_tokens)))
    except (TypeError, ValueError):
        n = 400
    try:
        out, meta = claude_ai.call(who, system, user, n, schema)
        with _LOCK:
            _last[who] = _last[""] = meta
        print(f"[AI] {who}: 클로드 {meta['usd']:.4f}달러 (입력 {meta['in']} · 출력 {meta['out']} 토큰)")
        return out
    except claude_ai.Unavailable as e:
        _say(f"off:{e}", f"[AI] 클로드 못 씀 — {e} → Gemma 로")
    except claude_ai.Failed as e:
        print(f"[AI] {who}: 클로드 이번 호출 실패 — {e} → Gemma 로")
    out, meta = _gemma(who, system, user, n, schema)
    if out is not None:
        with _LOCK:
            _last[who] = _last[""] = meta
    return out


def _gemma(who, system, user, n, schema):
    """Gemma 로 한 번 → (str·dict 또는 None, meta)"""
    if not cf_ai.enabled():
        _say("gemma:nokey", "[AI] Gemma 도 꺼져 있음 (CF_ACCOUNT_ID / CF_AI_TOKEN 없음) — 이 문장은 건너뜀")
        return None, None
    if _gemma_off:
        return None, None
    budget = cf_ai.Budget(DATA / "ai_usage.json")
    if budget.used >= GEMMA_STOP or budget.used_by(who) >= GEMMA_WHO_DAILY:
        _say(f"gemma:full:{who}", f"[AI] {who}: 오늘 Gemma 몫을 다 씀 (전체 {budget.used:.0f} · {who} {budget.used_by(who):.0f} 뉴런) — 건너뜀")
        return None, None
    sys2 = system
    if schema is not None:
        sys2 = (system + "\n\n" if system else "") + JSON_RULE + json.dumps(schema, ensure_ascii=False)
    try:
        text, neurons = cf_ai.chat(sys2, user, max_tokens=n, temperature=0.2)
    except cf_ai.Stop as e:
        _gemma_off.append(str(e))
        print(f"[AI] Gemma 멈춤: {cf_ai.scrub(e)[:200]}")
        return None, None
    budget.add(who, neurons)
    meta = {"provider": "gemma", "model": cf_ai.MODEL, "neurons": round(neurons, 1)}
    if schema is None:
        t = (text or "").strip()
        return (t or None), meta
    obj = _parse_obj(text, schema)
    if obj is None:
        print(f"[AI] {who}: Gemma 답이 JSON 형식이 아님 — 건너뜀")
    return obj, meta


def _parse_obj(text, schema):
    """Gemma 답 → dict (필수 키 확인). 속성이 배열 하나뿐인 스키마에 배열만 답했으면 감싸 준다"""
    try:
        obj = cf_ai.json_object(text)
    except ValueError:
        props = schema.get("properties") if isinstance(schema.get("properties"), dict) else {}
        arr = [k for k, v in props.items() if isinstance(v, dict) and v.get("type") == "array"]
        if len(props) != 1 or len(arr) != 1:
            return None
        try:
            obj = {arr[0]: cf_ai.json_array(text)}
        except ValueError:
            return None
    req = schema.get("required") if isinstance(schema.get("required"), list) else []
    if any(k not in obj for k in req):
        return None
    return obj


def last(who=None):
    """그 모듈의 마지막 ai.write 를 쓴 AI → {"provider": "claude"|"gemma", "model", "usd"|"neurons"}
    (마지막 호출이 실패했거나 아직 없으면 None. who 를 빼면 이 프로세스에서 마지막으로 성공한 것)"""
    with _LOCK:
        m = _last.get(_who(who) if who else "")
        return dict(m) if m else None


def info():
    """지금 AI 상태 (로그·화면용, AI 를 부르지 않는다)
    → {"provider": "claude"|"gemma"|"none", "model", "usd": {"total", "today", "limit", "dailyLimit"}, "reason"}"""
    try:
        c = claude_ai.state()
    except Exception as e:
        c = {"on": False, "msg": f"상태 확인 실패 {claude_ai.scrub(e)[:80]}", "total": None, "today": 0.0, "limit": None, "daily": None}
    usd = {"total": c.get("total"), "today": c.get("today"), "limit": c.get("limit"), "dailyLimit": c.get("daily")}
    if c.get("on"):
        return {"provider": "claude", "model": claude_ai.MODEL, "usd": usd, "reason": None}
    if cf_ai.enabled() and not _gemma_off:
        return {"provider": "gemma", "model": cf_ai.MODEL, "usd": usd, "reason": c.get("msg")}
    reason = c.get("msg") or ""
    reason += " · Gemma 도 꺼짐" + (f" ({_gemma_off[0][:80]})" if _gemma_off else " (CF_ACCOUNT_ID / CF_AI_TOKEN 없음)")
    return {"provider": "none", "model": None, "usd": usd, "reason": reason}


if __name__ == "__main__":
    print(json.dumps(info(), ensure_ascii=False, indent=1))
