"""클로드(Anthropic API · claude-haiku-5-5) 호출기 + 돈 장부 — ai.py 가 부른다 (직접 쓰지 말고 ai.write 를 쓸 것)

쓰는 곳: 새 예측 문장(비트코인 결론 btc · 펌핑 설명 pump · 순위 이유 rank). 뉴스 판단·종목 해설은 Gemma(cf_ai.py, 무료) 그대로.
사용자 결정(2026-10-28): 이 사이트는 클로드를 '누적 총 150달러'까지 쓰고, 닿으면 Gemma 로 자동으로 돌아간다.

키     환경변수 ANTHROPIC_API_KEY (GitHub Secret). 없거나 SDK 를 못 불러오면 꺼짐 → Gemma (돈 0원).
       키는 로그·파일에 남기지 않는다 (오류 글은 scrub 으로 가린다).
SDK    공식 anthropic 파이썬 SDK — collector/requirements-ai.txt 에 1.14.0 으로 고정 (원시 HTTP 로 부르지 않는다).
       1.14.0(2026-10-14)을 고른 이유: 문서(1.x 기준)와 같은 줄이고, 2.x(10-21~)처럼 갓 나온 버전은 피했다.
       이 버전에서 thinking={"type": "disabled"} · output_config.format(json_schema) 이 되는 것을 확인했다.
모델   claude-haiku-5-5 하나. 생각(thinking)은 끈다. temperature·top_p·top_k·assistant prefill·budget_tokens 는
       보내지 않는다 (Haiku 5.5 는 400 오류). effort 도 보내지 않는다 (기본 medium — thinking 끄기는 high 이하에서 허용).
       schema 가 있으면 구조화 출력(output_config.format)으로 JSON 형식을 보장한다 (SDK transform_schema 로 지원 안 되는 제약은 설명으로).
       stop_reason 이 end_turn 이 아니면(refusal · max_tokens …) 그 호출은 실패. 답은 type == "text" 블록만 쓴다.
단가   100만 토큰당 입력 0.10 / 출력 0.50 달러 (프롬프트 10만 토큰 이하 — 넘으면 0.50 / 2.50).
       캐시 쓰기·읽기 토큰은 보수적으로 입력 단가 × 1.25. 새 토크나이저는 같은 글을 예전보다 약 30% 더 많이 센다.
한도   누적 150달러(LIMIT_USD) · 하루 3달러(DAILY_USD, 한국 날짜 — 버그로 한꺼번에 쓰는 것 방지).
       환경변수 CLAUDE_LIMIT_USD · CLAUDE_DAILY_USD 로는 낮추기만 된다.
       부르기 전에 '지금까지 + 이번 호출의 최대 금액(입력 넉넉한 어림 + max_tokens 전부 출력)'이 한도를 넘으면 부르지 않는다.
       타임아웃·연결 오류는 서버가 처리했을 수도 있어 최대 금액 × 시도 횟수로 센다.
       인증·권한·모델 없음·크레딧 부족, 또는 연결 오류가 3번 이어지면 이번 실행(같은 Actions 실행의 다음 단계 포함) 동안 클로드를 끈다.
장부   web/public/data/claude_usage.json — Actions 캐시로 다음 실행에 이어지고, 사이트에도 올라가 설정 화면에 보인다.
       로컬 파일이 없거나 깨졌으면 공개 사이트의 것을 받아 이어 쓰고, 둘 다 있으면 totalUsd 가 큰 쪽을 쓴다.
       둘 다 못 읽으면 이번 실행은 클로드를 쓰지 않는다(fail closed). 공개 사이트가 404 를 분명히 돌려주는
       (사이트의 meta.json 은 보이는) 첫 실행만 0 에서 시작한다. 못 읽은 채로 키가 있으면 '모름' 표시 파일을 남겨,
       다음 배포가 장부 없는 사이트를 만들어 0 부터 다시 세는 일을 막는다 (그 뒤로는 계속 쉰다 — 복구는 아래).
       복구: 환경변수 CLAUDE_SPENT_FLOOR_USD 에 '이 사이트가 적어도 이만큼 썼다'를 넣으면 그 값부터 센다 (올리기만 된다).
주의   같은 Console 조직을 야구 게임도 쓴다 (조직 크레딧 200달러 · 야구는 자체 장부로 180달러 제한).
       이 장부는 마켓 사이트 사용분만 세므로 Console 화면의 사용액과 다르다.

    python collector/claude_ai.py      # 지금 상태만 본다 (클로드를 부르지 않는다)
"""
import json
import math
import os
import re
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

MODEL = "claude-haiku-5-5"
LIMIT_USD = 150.0  # 누적 총 한도 (사용자 결정)
DAILY_USD = 3.0  # 하루 안전장치 (한국 날짜)
PRICE = (0.10, 0.50)  # 달러 / 100만 토큰 (입력, 출력) — 프롬프트(입력+캐시) 10만 토큰 이하
PRICE_LONG = (0.50, 2.50)  # 프롬프트가 10만 토큰을 넘을 때
LONG_PROMPT = 100_000
CACHE_RATE = 1.25  # 캐시 토큰은 보수적으로 입력 단가 × 1.25 (실제 읽기는 0.1배, 5분 쓰기는 1.25배)
TIMEOUT = 60.0  # 초 (시도 한 번)
MAX_RETRIES = 2  # SDK 기본 — 연결 오류·408·409·429·5xx 를 지수 백오프로 다시
FAILS_TO_STOP = 3  # 오류가 연달아 이만큼이면 이번 실행은 클로드를 끈다
KEEP_DAYS = 120  # 장부에 남길 날짜별 기록
KST = timezone(timedelta(hours=9))
LEDGER_PATH = Path(__file__).resolve().parent.parent / "web" / "public" / "data" / "claude_usage.json"
SITE_DATA = "https://rescececene.github.io/chaaaart.github.io/data"  # 공개 사이트 — 장부 유실 대비
REMOTE_TRIES, REMOTE_WAIT = 3, 2.0
STICKY = {"auth", "perm", "model", "credit", "error"}  # 같은 Actions 실행의 다음 단계도 클로드를 건너뛴다
NOTE = "마켓 사이트 사용분만 센다 — 같은 Console 조직의 야구 게임 사용분은 들어 있지 않다"

_LOCK = threading.RLock()
_S = {}


class Unavailable(Exception):
    """지금은 클로드를 쓸 수 없다 (키 없음·SDK 없음·한도·장부 문제·이번 실행에서 꺼짐) → Gemma 로"""


class Failed(Exception):
    """이번 호출만 실패했다 (거절·max_tokens·형식·일시 오류) → 이 호출은 Gemma 로"""


def reset():
    """이 프로세스의 상태를 처음으로 (시험용 · 오래 도는 프로세스가 장부를 다시 읽을 때)"""
    with _LOCK:
        _S.clear()
        _S.update(ledger=None, load=None, client=None, sdk=None, off=None, fails=0, pending=0.0, last=None, error=None)


reset()


# ── 작은 도구 ────────────────────────────────────────────────

def api_key():
    return os.environ.get("ANTHROPIC_API_KEY", "").strip()


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def kst_day():
    return datetime.now(KST).strftime("%Y-%m-%d")


def _num(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) and v >= 0


def _env_usd(name):
    try:
        v = float(os.environ.get(name, "").strip())
    except ValueError:
        return None
    return v if _num(v) else None


def limits():
    """(누적 한도, 하루 한도) — 환경변수로는 낮추기만 된다"""
    lim, day = LIMIT_USD, DAILY_USD
    v = _env_usd("CLAUDE_LIMIT_USD")
    if v is not None:
        lim = min(lim, v)
    v = _env_usd("CLAUDE_DAILY_USD")
    if v is not None:
        day = min(day, v)
    return lim, day


def cost(inp, out, cache_w=0, cache_r=0):
    """토큰 → 달러 (캐시 토큰은 보수적으로 입력 단가 × 1.25)"""
    pin, pout = PRICE_LONG if inp + cache_w + cache_r > LONG_PROMPT else PRICE
    return (inp * pin + (cache_w + cache_r) * pin * CACHE_RATE + out * pout) / 1e6


def est_tokens(*parts):
    """입력 토큰 넉넉한 어림 — UTF-8 바이트 ÷ 2 (한글 1자 ≈ 1.5토큰, 영문 1자 ≈ 0.5토큰. 실제보다 크게 잡는다) + 요청 틀 몫"""
    n = 0
    for p in parts:
        if p is None:
            continue
        n += len((p if isinstance(p, str) else json.dumps(p, ensure_ascii=False)).encode("utf-8"))
    return n // 2 + 50


def _up(x):
    """달러를 100만분의 1 단위로 올림 (장부는 늘 실제보다 같거나 많게)"""
    return math.ceil(round(x * 1e6, 6)) / 1e6


def scrub(text):
    """오류 글에서 키·토큰처럼 보이는 것을 가린다"""
    t = str(text)
    k = api_key()
    if k:
        t = t.replace(k, "…")
    t = re.sub(r"sk-ant-[A-Za-z0-9_\-]*", "sk-ant-…", t)
    return re.sub(r"[A-Za-z0-9_\-]{32,}", "…", t)


def _who(who):
    w = re.sub(r"[^a-z0-9_\-]", "", str(who or "").lower())[:24]
    return w or "etc"


def _msg(code):
    lim, day = limits()
    return {
        "ok": "클로드 하이쿠로 쓰는 중",
        "nokey": "클로드 키(ANTHROPIC_API_KEY)가 아직 없어요",
        "nosdk": "클로드 SDK(anthropic)를 설치하지 못했어요",
        "limit": f"누적 한도({lim:g}달러)에 닿았어요",
        "daily": f"오늘 한도({day:g}달러)에 닿았어요 — 내일(한국 시간) 다시 써요",
        "auth": "클로드 키가 맞지 않아요 (인증 오류)",
        "perm": "클로드 키에 권한이 없어요",
        "model": "클로드 하이쿠 모델을 쓸 수 없어요",
        "credit": "Console 크레딧이 부족해요",
        "error": "클로드 연결 오류가 이어졌어요",
        "ledger": "사용 장부를 확인하지 못해 클로드를 쉬어요",
    }.get(code, code)


# ── 장부 ────────────────────────────────────────────────────

def _valid(d):
    return isinstance(d, dict) and not d.get("unknown") and _num(d.get("totalUsd"))


def _classify(d):
    if _valid(d):
        return "ok"
    if isinstance(d, dict) and d.get("unknown"):
        return "placeholder"
    return "bad"


def _read_local():
    """→ (ok | placeholder | bad | absent, 장부)"""
    try:
        raw = LEDGER_PATH.read_text(encoding="utf-8")
    except FileNotFoundError:
        return "absent", None
    except OSError:
        return "bad", None
    try:
        d = json.loads(raw)
    except ValueError:
        return "bad", None
    st = _classify(d)
    return st, (d if st != "bad" else None)


def _get(url, timeout=10):
    """→ (HTTP 코드, 본문). 연결 실패는 (0, None)"""
    req = urllib.request.Request(url, headers={"Cache-Control": "no-cache"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, None
    except Exception:
        return 0, None


def _read_remote():
    """공개 사이트의 장부 → (ok | placeholder | absent | error, 장부).
    404 는 사이트가 살아 있을 때(meta.json 이 보일 때)만 '처음부터 없음'으로 믿는다"""
    for i in range(REMOTE_TRIES):
        bust = f"?v={int(time.time())}"  # GitHub Pages CDN 캐시(10분)를 피한다
        code, body = _get(f"{SITE_DATA}/claude_usage.json{bust}")
        if code == 200:
            try:
                d = json.loads(body.decode("utf-8"))
            except ValueError:
                d = None
            st = _classify(d)
            if st != "bad":
                return st, d
        elif code == 404 and _get(f"{SITE_DATA}/meta.json{bust}")[0] == 200:
            return "absent", None
        if i + 1 < REMOTE_TRIES:
            time.sleep(REMOTE_WAIT * (i + 1))
    return "error", None


def _cell(v):
    v = v if isinstance(v, dict) else {}
    return {"usd": float(v["usd"]) if _num(v.get("usd")) else 0.0, "calls": int(v["calls"]) if _num(v.get("calls")) else 0}


def _fix(d):
    """읽은 장부의 모양을 바로잡는다 (모르는 값은 0)"""
    tk = d.get("tokens") if isinstance(d.get("tokens"), dict) else {}
    days = d.get("days") if isinstance(d.get("days"), dict) else {}
    by = d.get("by") if isinstance(d.get("by"), dict) else {}
    return {"v": 1, "since": d.get("since") if isinstance(d.get("since"), str) else now_iso(),
            "totalUsd": float(d["totalUsd"]), "calls": int(d["calls"]) if _num(d.get("calls")) else 0,
            "tokens": {k: int(tk[k]) if _num(tk.get(k)) else 0 for k in ("in", "out", "cache")},
            "days": {k: _cell(v) for k, v in days.items() if isinstance(k, str) and re.fullmatch(r"\d{4}-\d{2}-\d{2}", k)},
            "by": {_who(k): _cell(v) for k, v in by.items()},
            "status": d.get("status") if isinstance(d.get("status"), dict) else None,
            "lastError": d.get("lastError") if isinstance(d.get("lastError"), dict) else None}


def _new(total=0.0):
    return _fix({"since": now_iso(), "totalUsd": total})


def _load():
    """장부를 읽는다 (프로세스마다 한 번) → _S["load"]: ok | first | restored | unknown"""
    if _S["load"] is not None:
        return
    lst, ld = _read_local()
    rst, rd = "skip", None
    if api_key() or lst != "ok":  # 키가 있으면 늘 공개 사이트와 맞춰 보고(큰 쪽), 없으면 로컬이 멀쩡할 땐 건너뛴다
        rst, rd = _read_remote()
    cands = [d for st, d in ((lst, ld), (rst, rd)) if st == "ok"]
    if cands:
        led, how = _fix(max(cands, key=lambda d: d["totalUsd"])), "ok"
    elif lst == "absent" and rst == "absent":
        led, how = _new(), "first"
    else:
        led, how = None, "unknown"
    floor = _env_usd("CLAUDE_SPENT_FLOOR_USD")  # 사람이 넣는 '적어도 이만큼 썼다' — 올리기만
    if floor is not None:
        if led is None:
            led, how = _new(floor), "restored"
        elif floor > led["totalUsd"]:
            led["totalUsd"] = _up(floor)
    _S["ledger"], _S["load"] = led, how
    if how == "unknown":
        print(f"[클로드] 사용 장부를 못 읽음 (로컬 {lst} · 사이트 {rst}) — 이번 실행은 클로드를 쓰지 않아요")
    elif how in ("first", "restored"):
        print(f"[클로드] 사용 장부를 새로 시작 ({how}, 누적 {led['totalUsd']:.2f}달러)")
    st = (led or {}).get("status") or {}
    run = os.environ.get("GITHUB_RUN_ID", "")
    if run and st.get("run") == run and st.get("code") in STICKY:  # 같은 실행의 앞 단계가 끈 이유는 이어 간다
        _S["off"] = st["code"]


def _code():
    """지금 상태 코드 (화면·로그용)"""
    if not api_key():
        return "nokey"
    if _S["sdk"] is False:
        return "nosdk"
    if _S["load"] == "unknown":
        return "ledger"
    return _S["off"] or _S["last"] or "ok"


def _save():
    """장부를 쓴다. 못 읽은 상태(unknown)면 키가 있을 때만 '모름' 표시 파일을 쓴다"""
    led = _S["ledger"]
    if led is None and not api_key():
        return
    lim, day = limits()
    code = _code()
    status = {"code": code, "msg": _msg(code), "at": now_iso(), "run": os.environ.get("GITHUB_RUN_ID", "")}
    if led is None:
        out = {"v": 1, "unknown": True, "totalUsd": None, "updatedAt": now_iso(), "model": MODEL,
               "limitUsd": lim, "dailyLimitUsd": day, "status": status, "note": NOTE}
    else:
        keep = sorted(led["days"])[-KEEP_DAYS:]
        led["days"] = {k: led["days"][k] for k in keep}
        led["status"] = status
        out = {"v": 1, "updatedAt": now_iso(), "model": MODEL, "limitUsd": lim, "dailyLimitUsd": day,
               **{k: v for k, v in led.items() if k != "v"}, "note": NOTE}
    LEDGER_PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp = LEDGER_PATH.with_name(LEDGER_PATH.name + ".tmp")
    tmp.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    tmp.replace(LEDGER_PATH)


def _record(who, usd, inp=0, out=0, cache=0):
    led = _S["ledger"]
    led["totalUsd"] = _up(led["totalUsd"] + usd)
    led["calls"] += 1
    for k, v in (("in", inp), ("out", out), ("cache", cache)):
        led["tokens"][k] += int(v)
    for cell in (led["days"].setdefault(kst_day(), _cell(None)), led["by"].setdefault(who, _cell(None))):
        cell["usd"] = _up(cell["usd"] + usd)
        cell["calls"] += 1


def _turn_off(code, err):
    _S["off"] = code
    _S["ledger"]["lastError"] = {"at": now_iso(), "msg": scrub(err)[:300]}
    print(f"[클로드] {_msg(code)} — 이번 실행은 Gemma 로 ({scrub(err)[:160]})")


def _block(code, detail=""):
    """이번 호출은 클로드를 못 쓴다 → Unavailable. 이유가 바뀌었을 때만 알리고 장부(설정 화면용 상태)에 남긴다"""
    if _S["last"] != code:
        _S["last"] = code
        if code in ("limit", "daily"):
            print(f"[클로드] {_msg(code)} {detail} — Gemma 로")
        _save()
    raise Unavailable(_msg(code))


def _sdk():
    """SDK 를 불러온다 — 못 불러오면 None (꺼짐)"""
    if _S["sdk"] is None:
        try:
            import anthropic
            _S["sdk"] = anthropic
        except Exception as e:
            _S["sdk"] = False
            print(f"[클로드] SDK(anthropic)를 불러오지 못함 — Gemma 로 ({scrub(e)[:120]})")
    return _S["sdk"] or None


# ── 상태 · 호출 ──────────────────────────────────────────────

def state():
    """지금 상태 (부르지 않고 보기만) → {"on", "code", "msg", "total", "today", "limit", "daily"}"""
    with _LOCK:
        if api_key():
            _sdk()
        _load()
        lim, day = limits()
        led = _S["ledger"] or {}
        total = led.get("totalUsd")
        today = (led.get("days") or {}).get(kst_day(), {}).get("usd", 0.0)
        code = _code()
        if code == "ok" and total is not None and (total >= lim or today >= day):
            code = "limit" if total >= lim else "daily"
        return {"on": code == "ok", "code": code, "msg": _msg(code), "total": total, "today": today, "limit": lim, "daily": day}


def call(who, system, user, max_tokens, schema=None):
    """클로드에 한 번 묻는다 → (str, meta) 또는 schema 가 있으면 (dict, meta).
    지금 쓸 수 없으면 Unavailable, 이번 호출만 실패면 Failed (어느 쪽이든 부르는 쪽은 Gemma 로)"""
    who = _who(who)
    with _LOCK:
        _load()
        if not api_key():
            _block("nokey")
        sdk = _sdk()
        if sdk is None:
            _block("nosdk")
        if _S["load"] == "unknown":
            _block("ledger")
        if _S["off"]:
            raise Unavailable(_msg(_S["off"]))
        fmt = None
        if schema is not None:
            try:
                fmt = {"type": "json_schema", "schema": sdk.transform_schema(schema)}
            except Exception as e:
                raise Failed(f"스키마 오류 {scrub(e)[:120]}") from None
        est = cost(est_tokens(system, user, fmt) + (300 if fmt else 0), max_tokens)
        lim, day = limits()
        led = _S["ledger"]
        today = led["days"].get(kst_day(), {}).get("usd", 0.0)
        for code, used, cap in (("limit", led["totalUsd"], lim), ("daily", today, day)):
            if used + _S["pending"] + est > cap:
                _block(code, f"(지금 {used:.4f}달러 + 이번 최대 {est:.4f}달러)")
        if _S["client"] is None:
            _S["client"] = sdk.Anthropic(api_key=api_key(), timeout=TIMEOUT, max_retries=MAX_RETRIES)
        client = _S["client"]
        _S["pending"] += est
    kw = {"model": MODEL, "max_tokens": int(max_tokens), "messages": [{"role": "user", "content": user}],
          "thinking": {"type": "disabled"}}
    if system:
        kw["system"] = system
    if fmt:
        kw["output_config"] = {"format": fmt}
    try:
        resp = client.messages.create(**kw)
    except Exception as e:
        with _LOCK:
            _S["pending"] -= est
            _on_error(sdk, who, est, e)  # 늘 예외를 던진다
    with _LOCK:
        _S["pending"] -= est
        u = getattr(resp, "usage", None)
        inp, out = int(getattr(u, "input_tokens", 0) or 0), int(getattr(u, "output_tokens", 0) or 0)
        cw, cr = int(getattr(u, "cache_creation_input_tokens", 0) or 0), int(getattr(u, "cache_read_input_tokens", 0) or 0)
        usd = cost(inp, out, cw, cr)
        _record(who, usd, inp, out, cw + cr)
        _S["fails"], _S["last"] = 0, "ok"
        _save()
    meta = {"provider": "claude", "model": getattr(resp, "model", None) or MODEL, "usd": round(usd, 6), "in": inp, "out": out}
    stop = getattr(resp, "stop_reason", None)
    if stop not in ("end_turn", "stop_sequence"):  # refusal · max_tokens · model_context_window_exceeded … → 이 호출은 실패
        raise Failed(f"클로드 답이 끝나지 않음 ({stop})")
    text = "".join(getattr(b, "text", "") or "" for b in (getattr(resp, "content", None) or []) if getattr(b, "type", "") == "text").strip()
    if not text:
        raise Failed("클로드 답이 비어 있음")
    if fmt is None:
        return text, meta
    try:
        obj = json.loads(text)
    except ValueError:
        raise Failed("클로드 답이 JSON 이 아님") from None
    if not isinstance(obj, dict):
        raise Failed("클로드 답이 JSON 객체가 아님")
    return obj, meta


def _on_error(sdk, who, est, e):
    """SDK 오류 → 장부·상태 정리 후 Unavailable(이번 실행 끔) 또는 Failed(이 호출만) 를 던진다"""
    led = _S["ledger"]
    status = getattr(e, "status_code", None)
    etype = getattr(e, "type", None)
    text = f"{type(e).__name__} {status or ''} {getattr(e, 'message', '') or e}"
    led["lastError"] = {"at": now_iso(), "msg": scrub(text)[:300]}
    rid = getattr(e, "request_id", None)
    off = None
    if isinstance(e, sdk.AuthenticationError):
        off = "auth"
    elif isinstance(e, sdk.PermissionDeniedError):
        off = "perm"
    elif isinstance(e, sdk.NotFoundError):
        off = "model"
    elif status == 402 or etype == "billing_error" or (
            isinstance(e, sdk.BadRequestError) and "credit balance" in str(getattr(e, "message", "") or e).lower()):
        off = "credit"
    else:
        if isinstance(e, sdk.APIConnectionError):  # 타임아웃·끊김 — 서버가 처리했을 수도 있어 최대 금액 × 시도 횟수로 센다
            _record(who, est * (MAX_RETRIES + 1))
        _S["fails"] += 1
        if _S["fails"] >= FAILS_TO_STOP:
            off = "error"
    if off:
        _turn_off(off, text + (f" (request-id {rid})" if rid else ""))
        _save()
        raise Unavailable(_msg(off)) from None
    _save()
    raise Failed(scrub(text)[:200] + (f" (request-id {rid})" if rid else "")) from None


if __name__ == "__main__":
    s = state()
    print(json.dumps({"model": MODEL, **s, "ledger": str(LEDGER_PATH)}, ensure_ascii=False, indent=1))
