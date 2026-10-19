"""Cloudflare Workers AI 공용 호출기 — 뉴스 판단·종목 해설이 하루 무료 사용량을 함께 나눠 쓴다

무료 플랜은 하루 10,000 뉴런(UTC 0시 초기화). 넘어도 요금 없이 그날 호출만 실패하지만,
여기서는 어림값 8,000 에서 먼저 멈춘다. 중계 Worker 를 거치지 않고 REST 로 직접 부르므로 중계 요청 수와 상관없다.

비밀값 (GitHub Actions Secret — 사이트에는 판단 결과만 올라간다):
    CF_ACCOUNT_ID   Cloudflare 계정 ID
    CF_AI_TOKEN     Workers AI 토큰 (대시보드 Workers AI → REST API 사용 → Workers AI API 토큰 만들기)
사용량 장부: data/ai_usage.json  {"day": UTC 날짜, "neurons": 어림값, "by": {"news": .., "stock": ..}}
"""
import json
import os
import re
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

MODEL = os.environ.get("CF_AI_MODEL") or "@cf/google/gemma-4-26b-a4b-it"  # 다국어, 싼 편 (결제 수단 없이 무료 플랜에서 쓸 수 있는 모델)
API = os.environ.get("CF_API_BASE") or "https://api.cloudflare.com/client/v4"
DAILY_NEURONS = 8000  # 무료 한도(10,000) 전에 멈춘다
N_IN, N_OUT = 9091, 27273  # Gemma 4 26B 단가 — 토큰 100만 개당 뉴런 (입력, 출력)


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
    """하루 사용량 장부 — 날짜가 바뀌면 0 부터. 여러 모듈이 같은 파일을 쓴다"""

    def __init__(self, path):
        self.path = Path(path)
        d = {}
        try:
            d = json.loads(self.path.read_text(encoding="utf-8"))
        except Exception:
            pass
        if d.get("day") != utc_day():
            d = {"day": utc_day(), "neurons": 0, "by": {}}
        d.setdefault("by", {})
        self.d = d

    @property
    def used(self):
        return self.d["neurons"]

    def left(self, cap=DAILY_NEURONS):
        return cap - self.d["neurons"]

    def add(self, who, neurons):
        self.d["neurons"] = round(self.d["neurons"] + neurons, 1)
        self.d["by"][who] = round(self.d["by"].get(who, 0) + neurons, 1)

    def save(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(self.d, ensure_ascii=False), encoding="utf-8")
        tmp.replace(self.path)

    def snapshot(self):
        return {"day": self.d["day"], "neurons": self.d["neurons"]}


def chat(system, user, max_tokens, temperature=0.1, timeout=60):
    """모델에 한 번 묻는다 → (답 글, 쓴 뉴런 어림값). 인증·한도·연결 문제는 Stop"""
    account, token = creds()
    if not account or not token:
        raise Stop("CF_ACCOUNT_ID / CF_AI_TOKEN 없음")
    body = json.dumps({"messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
                       "max_tokens": max_tokens, "temperature": temperature}).encode("utf-8")
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
    neurons = (tin * N_IN + tout * N_OUT) / 1e6
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
