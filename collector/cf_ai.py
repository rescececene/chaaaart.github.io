"""Cloudflare Workers AI(Gemma) 공용 호출기 — 무료. 하루 무료 사용량을 여러 모듈이 함께 나눠 쓴다

AI 구조
    뉴스 호재·악재 판단(news_ai.py) · 종목 해설(stock_ai.py)  → Gemma (여기, 무료)
    예측 문장(ai.py 의 ai.write — 비트코인 결론 btc · 펌핑 설명 pump · 순위 이유 rank)
        → 클로드 하이쿠 우선(claude_ai.py · 사용자 Anthropic Console 크레딧 · 이 사이트 몫 누적 150달러까지)
        → 키 없음·한도 도달·오류면 Gemma(여기) → 그것도 안 되면 None (부르는 쪽이 규칙 문장으로 대신)
    Console 조직은 야구 게임과 같이 쓴다(조직 크레딧 200달러, 야구는 자체 장부로 180달러).
    claude_usage.json 은 마켓 사이트 사용분만 세므로 Console 의 사용액과 다르다.

무료 플랜은 하루 10,000 뉴런(UTC 0시 초기화). 넘어도 요금 없이 그날 호출만 실패하지만, 여기서는 어림값 8,000 에서 먼저 멈춘다.
나눠 쓰는 순서 (오늘 전체 사용량 기준): 종목 해설은 6,000 까지 → 예측 문장(클로드 대신)은 7,000 까지 → 뉴스 판단은 8,000 까지.
중계 Worker 를 거치지 않고 REST 로 직접 부르므로 중계 요청 수와 상관없다.

비밀값 (GitHub Actions Secret — 사이트에는 판단 결과만 올라간다):
    CF_ACCOUNT_ID   Cloudflare 계정 ID
    CF_AI_TOKEN     Workers AI 토큰 (대시보드 Workers AI → REST API 사용 → Workers AI API 토큰 만들기)
사용량 장부: data/ai_usage.json  {"day": UTC 날짜, "neurons": 어림값, "by": {"news": .., "stock": .., "btc": ..}}
    부를 때마다 파일을 다시 읽어 더하고 바로 쓴다 (여러 모듈·단계가 같은 장부를 쓴다)
"""
import json
import os
import re
import threading
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

MODEL = os.environ.get("CF_AI_MODEL") or "@cf/google/gemma-4-26b-a4b-it"  # 다국어, 싼 편 (결제 수단 없이 무료 플랜에서 쓸 수 있는 모델)
API = os.environ.get("CF_API_BASE") or "https://api.cloudflare.com/client/v4"
DAILY_NEURONS = 8000  # 무료 한도(10,000) 전에 멈춘다
N_IN, N_OUT = 9091, 27273  # Gemma 4 26B 단가 — 토큰 100만 개당 뉴런 (입력, 출력)
_LOCK = threading.Lock()


def scrub(text):
    """사이트(공개 파일)·공개 로그에 남는 오류 글에서 계정 ID·토큰처럼 보이는 긴 문자열을 가린다"""
    return re.sub(r"[A-Za-z0-9_\-]{32,}", "…", re.sub(r"[0-9a-fA-F]{20,}", "…", str(text)))


class Stop(Exception):
    """이번 실행에서는 AI 를 더 부르지 않는다 (인증·한도·연결 문제)"""


def creds():
    return os.environ.get("CF_ACCOUNT_ID", "").strip(), os.environ.get("CF_AI_TOKEN", "").strip()


def enabled():
    a, t = creds()
    return bool(a and t)


def utc_day():
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


class Budget:
    """하루 사용량 장부 — 날짜가 바뀌면 0 부터. 여러 모듈·단계가 같은 파일을 쓰므로
    더할 때마다 파일을 다시 읽어 더하고 바로 저장한다 (먼저 읽어 둔 값으로 남의 몫을 덮어쓰지 않게)"""

    def __init__(self, path):
        self.path = Path(path)
        self.d = self._read()

    def _read(self):
        d = {}
        try:
            d = json.loads(self.path.read_text(encoding="utf-8"))
        except Exception:
            pass
        if not isinstance(d, dict) or d.get("day") != utc_day() or not isinstance(d.get("neurons"), (int, float)):
            d = {"day": utc_day(), "neurons": 0, "by": {}}
        if not isinstance(d.get("by"), dict):
            d["by"] = {}
        return d

    def _write(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(self.d, ensure_ascii=False), encoding="utf-8")
        tmp.replace(self.path)

    @property
    def used(self):
        return self.d["neurons"]

    def used_by(self, who):
        v = self.d["by"].get(who, 0)
        return v if isinstance(v, (int, float)) else 0

    def left(self, cap=DAILY_NEURONS):
        return cap - self.d["neurons"]

    def refresh(self):
        """다른 모듈이 그 사이에 쓴 몫까지 다시 읽는다"""
        with _LOCK:
            self.d = self._read()
        return self

    def add(self, who, neurons):
        with _LOCK:
            self.d = self._read()
            self.d["neurons"] = round(self.d["neurons"] + neurons, 1)
            self.d["by"][who] = round(self.used_by(who) + neurons, 1)
            self._write()

    def save(self):
        """add() 가 이미 저장한다 — 날짜가 바뀐 장부를 0 으로 새로 쓰는 일만 한다 (예전 호출 호환)"""
        with _LOCK:
            self.d = self._read()
            self._write()

    def snapshot(self):
        return {"day": self.d["day"], "neurons": self.d["neurons"]}


def chat(system, user, max_tokens, temperature=0.1, timeout=60):
    """모델에 한 번 묻는다 → (답 글, 쓴 뉴런 어림값). 인증·한도·연결 문제는 Stop"""
    account, token = creds()
    if not account or not token:
        raise Stop("CF_ACCOUNT_ID / CF_AI_TOKEN 없음")
    body = json.dumps({"messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
                       "max_tokens": max_tokens, "temperature": temperature,
                       # Gemma 4 는 기본으로 긴 '생각'을 해서 사용량이 4배쯤 늘어난다 — 끈다 (실측 7.9 → 1.9 뉴런)
                       "chat_template_kwargs": {"enable_thinking": False}}).encode("utf-8")
    req = urllib.request.Request(f"{API}/accounts/{account}/ai/run/{MODEL}", data=body, method="POST", headers={
        "Authorization": f"Bearer {token}", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            d = json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        raise Stop(scrub(f"HTTP {e.code} {e.read().decode('utf-8', 'replace')[:300]}")) from None
    except (urllib.error.URLError, TimeoutError) as e:
        raise Stop(scrub(f"연결 실패 {e}")) from None
    if not d.get("success", True):
        raise Stop(scrub(f"실패 {json.dumps(d.get('errors'), ensure_ascii=False)[:300]}"))
    res = d.get("result") or {}
    u = res.get("usage") or {}
    tin = u.get("prompt_tokens") or (len(system) + len(user)) / 1.5
    tout = u.get("completion_tokens") or max_tokens / 2
    neurons = u.get("neurons") or (tin * N_IN + tout * N_OUT) / 1e6  # Cloudflare 가 알려 주는 실제 뉴런이 있으면 그것
    if isinstance(res.get("response"), str):
        text = res["response"]
    elif res.get("response") is not None:
        text = json.dumps(res["response"], ensure_ascii=False)
    else:
        text = ((res.get("choices") or [{}])[0].get("message") or {}).get("content") or ""
    return text, neurons


def json_array(text):
    """답에서 JSON 배열을 꺼낸다 (앞뒤 설명·```json 울타리 무시). 형식이 아니면 ValueError"""
    a, b = text.find("["), text.rfind("]")
    if a < 0 or b <= a:
        raise ValueError("AI 답 형식 오류")
    arr = json.loads(text[a:b + 1])
    if not isinstance(arr, list):
        raise ValueError("AI 답 형식 오류")
    return arr


def json_object(text):
    """답에서 JSON 객체 하나를 꺼낸다 (앞뒤 설명·```json 울타리 무시). 객체가 아니면(배열 등) ValueError"""
    text, dec = str(text or ""), json.JSONDecoder()
    a, s = text.find("{"), text.find("[")
    if s >= 0 and (a < 0 or s < a):  # 객체보다 배열이 먼저 나오면 배열 답인지 본다
        try:
            v, _ = dec.raw_decode(text, s)
        except ValueError:
            v = None
        if isinstance(v, list):
            raise ValueError("AI 답이 객체가 아니라 배열")
    if a < 0:
        raise ValueError("AI 답 형식 오류")
    try:
        obj, _ = dec.raw_decode(text, a)
    except ValueError:
        raise ValueError("AI 답 형식 오류") from None
    if not isinstance(obj, dict):
        raise ValueError("AI 답 형식 오류")
    return obj
