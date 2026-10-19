"""뉴스 호재·악재 AI 판단 — 코인니스 코인·주식 속보를 Cloudflare Workers AI 로 (cf_ai.py 참고)

중계 Worker 를 거치지 않으므로 중계 요청 수(계정 전체 하루 10만 건)와 상관없고,
AI 무료 사용량을 다 써도 AI 판단만 그날 멈춘다 (무료 플랜이면 요금도 없다). 해외 속보는 판단하지 않는다.
CF_ACCOUNT_ID / CF_AI_TOKEN 이 없으면 아무것도 하지 않는다 → 사이트는 투표·키워드로 판단한다.

결과: data/news_ai.json
    {"updatedAt", "model", "usage": {"day": UTC 날짜, "neurons": 오늘 AI 전체 어림값},
     "tags": {"<피드>:<기사 id>": {"s": -2~2, "r": 이유, "t": [관련 티커·이름], "at": 판단 시각} | null}}
한 번 판단한 기사는 다시 묻지 않는다 (null = 판단 실패, 다시 묻지 않음). GitHub Actions 캐시로 다음 실행에 이어진다.

    python collector/news_ai.py      # data/news.json 의 속보로 한 번 돌려 본다 (CF_ACCOUNT_ID, CF_AI_TOKEN 필요)
"""
import json
import re
import time
from datetime import datetime, timezone
from pathlib import Path

import cf_ai

BATCH = 10  # 한 번에 묻는 기사 수
TIME_BUDGET = 120  # 한 번 실행에 AI 로 쓰는 최대 초 (수집 전체가 늦어지지 않게)
KEEP = 1500  # 기억해 둘 판단 수
# 판단할 뉴스 주제 (적힌 순서대로) → (프롬프트에 쓰는 이름, 한 번에 볼 최신 기사 수)
# 코인니스 속보만 (하루 170~190건씩 → 약 1,300 뉴런). 해외 속보는 AI 로 판단하지 않는다.
FEEDS = {"coinflash": ("코인", 30), "stockflash": ("주식", 30),
         "notice": ("거래소 공지", 20),  # coin_social.py — 규칙 1차 판단(rule)이 붙어 있어 AI 는 확인만 (하루 20건 안팎)
         "social": ("코인 SNS", 20)}  # coin_social.py — 코인 공식 텔레그램 채널 글 (하루 수십 건)

SYSTEM = """너는 한국 개인 투자자를 위한 금융 속보 분석가다. 기사마다 관련 자산 가격에 줄 단기 영향을 판단한다.
s (영향 점수):
 2  미친 호재 — 가격이 크게 뛸 만한 드문 대형 호재 (현물 ETF 승인, 대형 거래소 상장, 대규모 인수·투자 유치, 깜짝 실적과 전망 대폭 상향 등)
 1  호재 — 가격에 긍정적인 소식
 0  중립 — 일정 안내, 단순 시세 보도, 엇갈리거나 영향이 불분명한 전망·의견
-1  악재 — 가격에 부정적인 소식
-2  미친 악재 — 큰 폭락을 부를 만한 소식 (해킹, 파산, 상장폐지, 사기·기소, 강한 규제, 실적 쇼크 등)
규칙:
- 2와 -2는 정말 큰 소식에만 쓴다. 대부분은 -1, 0, 1 이다.
- 이미 일어난 가격 움직임만 전하는 기사는 신고가·급등락처럼 두드러질 때만 ±1, 아니면 0.
- r: 판단 이유를 한국어로 짧게 (20자 안팎).
- t: 직접 영향을 받는 코인 티커(BTC, ETH 등)나 종목(미국은 티커, 한국은 회사 이름) 최대 3개. 없으면 빈 배열.
- '거래소 공지'는 거래소가 직접 올린 공지다. [규칙 판단]이 붙어 있으면 그 점수를 그대로 쓰고, 본문이 분명히 다를 때만 바꾼다.
  과거 데이터상 신규 상장은 직후 오른 뒤 7일 안에 내린 경우가 많아 0, 거래지원 종료·유의 종목 지정은 -1 이다 (±2 로 올리지 않는다).
  입출금 중단은 사유가 해킹·체인 정지면 -1(대형 해킹이면 -2), 정기 업그레이드·점검이면 0.
- '코인 SNS'는 코인 프로젝트 공식 텔레그램 채널 글이다(영어가 많다). 홍보·이벤트·AMA·단순 안내는 0.
  메인넷 출시·대형 제휴·바이백·소각·거래소 상장·해킹 같은 실질 소식만 ±1, 아주 큰 것만 ±2. r 은 한국어로.
- 입력 기사 순서대로 모두 답한다. JSON 배열만 출력한다.
출력 예: [{"i":0,"s":1,"r":"현물 ETF 자금 유입","t":["BTC"]},{"i":1,"s":0,"r":"일정 안내","t":[]}]"""

Stop = cf_ai.Stop  # 예전 이름 호환


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def load(path):
    try:
        d = json.loads(Path(path).read_text(encoding="utf-8"))
        if isinstance(d.get("tags"), dict):
            return d
    except Exception:
        pass
    return {"tags": {}}


def clip(s, n):
    t = re.sub(r"\s+", " ", re.sub(r"<[^>]*>", " ", s or "")).strip()
    return t[:n] + "…" if len(t) > n else t


def parse(text, n):
    """모델 답에서 JSON 배열을 꺼내 형식을 검사한다 → {i: {s, r, t}}"""
    out = {}
    for x in cf_ai.json_array(text):
        if not isinstance(x, dict):
            continue
        try:
            i, s = int(x.get("i")), round(float(x.get("s")))
        except (TypeError, ValueError):
            continue
        if not 0 <= i < n or i in out or not -2 <= s <= 2:
            continue
        t = [str(v).strip() for v in (x.get("t") if isinstance(x.get("t"), list) else [])]
        out[i] = {"s": s, "r": str(x.get("r") or "").strip()[:40], "t": [v for v in t if v and len(v) <= 24][:3]}
    return out


def ask(kind, items):
    """기사 묶음 하나를 묻는다 → ({i: 판단}, 쓴 뉴런 어림값)"""
    user = f"{kind} 속보 {len(items)}건\n\n" + "\n\n".join(
        f"[{i}] " + (f"({x['src']}) " if x.get("src") else "") + x["title"] + (f"\n{x['body']}" if x["body"] else "")
        + (f"\n[규칙 판단] {x['rule']['s']:+d} {x['rule']['r']}" if x.get("rule") else "") for i, x in enumerate(items))
    text, neurons = cf_ai.chat(SYSTEM, user, max_tokens=80 * len(items) + 120)
    try:
        return parse(text, len(items)), neurons
    except ValueError:  # 답이 엉망이면 그 기사들은 판단 실패로 남긴다 (같은 글로 다시 묻지 않는다)
        return {}, neurons


def run(topics, path, usage_path=None):
    """news.json 의 주제 목록에서 아직 판단하지 않은 속보를 판단해 path 에 저장한다"""
    if not cf_ai.enabled():
        print("[뉴스 AI] CF_ACCOUNT_ID / CF_AI_TOKEN 이 없어 건너뜀 (투표·키워드 판단만)")
        return
    budget = cf_ai.Budget(usage_path or Path(path).with_name("ai_usage.json"))
    db = load(path)
    tags = db["tags"]
    t0, asked, done, err = time.time(), 0, 0, ""
    by_key = {t.get("key"): t for t in topics}
    try:
        for key, (kind, newest) in FEEDS.items():
            todo = [x for x in (by_key.get(key) or {}).get("items", [])[:newest] if x.get("id") and f"{key}:{x['id']}" not in tags]
            for i in range(0, len(todo), BATCH):
                if budget.left() <= 0:
                    raise cf_ai.Stop(f"오늘 무료 사용량 어림 {budget.used:.0f} 뉴런 — 내일(UTC) 다시")
                if time.time() - t0 > TIME_BUDGET:
                    raise cf_ai.Stop("이번 실행 시간 초과 — 다음 실행에 이어서")
                batch = todo[i:i + BATCH]
                got, neurons = ask(kind, [{"title": clip(x.get("title"), 120), "body": clip(x.get("summary"), 300),
                                           "src": x.get("src") if key == "social" else "",  # 어느 코인 채널 글인지
                                           "rule": x.get("rule") if isinstance(x.get("rule"), dict) else None} for x in batch])
                budget.add("news", neurons)
                asked += len(batch)
                for j, x in enumerate(batch):
                    tag = got.get(j)
                    if tag:
                        tag["at"] = int(time.time())
                        done += 1
                    tags[f"{key}:{x['id']}"] = tag
    except cf_ai.Stop as e:
        err = str(e)
        print(f"[뉴스 AI] 멈춤: {err}")
    budget.save()
    # 오래된 판단부터 지운다 (dict 는 넣은 순서를 지킨다)
    for k in list(tags)[:max(0, len(tags) - KEEP)]:
        del tags[k]
    out = {"updatedAt": now_iso(), "model": cf_ai.MODEL, "usage": budget.snapshot(), "tags": tags}
    if err:
        out["error"] = cf_ai.scrub(err)[:300]
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    tmp.replace(p)
    print(f"[뉴스 AI] {asked}건 물어 {done}건 판단 / 오늘 AI 전체 어림 {budget.used:.0f} 뉴런 / {time.time() - t0:.0f}초")


if __name__ == "__main__":
    data = Path(__file__).resolve().parent.parent / "web" / "public" / "data"
    news = json.loads((data / "news.json").read_text(encoding="utf-8"))
    run(news.get("topics", []), data / "news_ai.json")
