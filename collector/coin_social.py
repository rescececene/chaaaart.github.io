"""코인 거래소 공지 · 프로젝트 공식 텔레그램 공지 채널 → news.json 의 두 주제

    import coin_social
    topics += coin_social.topics(OUT)      # [{"key": "notice", ...}, {"key": "social", ...}]

    python collector/coin_social.py                 # 한 번 돌려 두 주제를 요약 출력 (상태는 web/public/data/coin_social.json)
    python collector/coin_social.py --warm          # 코인게코·텔레그램 목록을 넉넉한 시간으로 한 번에 채운다 (로컬용)

X(트위터)는 무료로 읽을 방법이 없어 뺐다 (유료 API · 긁기 금지). 대신 무료로 되는 두 가지:
 1) 거래소 공지 — 업비트·빗썸·바이낸스가 공개로 내놓는 공지 목록. 제목에서 티커를 뽑고 규칙으로 1차 판단(rule, -1..1)을 붙인다
    (나중에 news_ai 가 확인·덮어씀). 백데이터상 상장은 호재가 아니었다 → 상장·상폐·유의 지정에는 점수 대신 주의 꼬리표
    caution('listing'·'delist'·'warning')를 단다 (아래 '공지 규칙 판단' 참고). 새 글은 본문 앞부분을 한 번만 받아 요약·판단 근거로 쓴다.
    바이낸스 공지 API 가 막히면(미국 서버 등) 바이낸스 공식 공지 텔레그램(@binance_announcements)으로 대신 받는다.
 2) 코인 SNS — 시가총액 상위·업비트 원화 거래대금 상위 코인의 공식 텔레그램 '공지 채널'(코인게코가 알려 준 것만)의
    공개 웹 미리보기(t.me/s/채널). 그룹 대화방·비공개·없는 채널은 미리보기가 없어(302) 자동으로 빠진다.
    사람 손을 거치지 않은 글이라 출처(채널 이름·@아이디)를 꼭 남기고, 홍보성 글은 간단한 규칙으로 거른다.

상태(코인게코 채널 목록·채널별 최근 글·공지 본문)는 web/public/data/coin_social.json 에 두어 Actions 캐시로 다음 실행에 이어진다.
 - 코인게코(키 없는 무료 API)는 대상 목록을 하루 1번, 코인별 채널 아이디는 7일에 1번만 묻는다 (실행마다 몇 개씩, 느리게).
   429 를 받으면 15분 쉰다. (선택) 무료 Demo 키를 COINGECKO_DEMO_KEY 환경 변수로 주면 그 키로 묻는다.
 - 텔레그램은 실행마다 오래된 채널부터 TG_PER_RUN 개만 (채널당 요청 1번, 간격 1초 이상) 돌아가며 받는다.
 - 세 갈래(공지·코인게코·텔레그램)는 서로 다른 서버라 동시에 돌리고, 전체를 budget 초(기본 30초) 안에 끝낸다.
표준 라이브러리만 쓴다.
"""
import argparse
import html
import json
import os
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36"
KST = timezone(timedelta(hours=9))
DATA = Path(__file__).resolve().parent.parent / "web" / "public" / "data"
STATE_NAME = "coin_social.json"

BUDGET = 30  # 한 번 실행의 목표 시간(초)
MAX_ITEMS = 40  # 주제마다 최대 항목 수
NOTICE_MAX_AGE = 30 * 86400  # 이보다 오래된 공지는 뺀다 (바이낸스 목록에는 몇 달 전 글도 섞여 온다)
DETAIL_PER_RUN = 8  # 한 번에 본문을 받는 새 공지 수 (거래소 합계)

TG_PER_RUN = 12  # 한 번 실행에 받는 텔레그램 채널 수 (최대 30)
TG_GAP = 1.2  # 텔레그램 요청 간격(초)
TG_RECHECK = 7 * 86400  # 대화방·없는 채널 판정을 다시 확인하는 주기
TG_POSTS_KEEP = 5  # 채널마다 기억해 둘 최근 글 수
POST_MAX_AGE = 7 * 86400  # 이보다 오래된 SNS 글은 뺀다
PER_CHANNEL = 4  # 코인 SNS 주제에 한 채널이 차지할 수 있는 최대 글 수

CG_API = "https://api.coingecko.com/api/v3"
CG_GAP = 6.0  # 코인게코 무료(키 없음)는 분당 몇 번만 된다(3초 간격 8번에 429) — 느리게
CG_PER_RUN = 3  # 한 번 실행에 묻는 코인 상세 수 (60여 개를 처음 채우는 데 몇 시간, 그 뒤로는 7일에 한 번씩)
CG_DIR_TTL = 86400  # 대상 코인 목록(시총·거래대금 순위)을 다시 만드는 주기
CG_COIN_TTL = 7 * 86400  # 코인별 텔레그램 채널 아이디를 다시 묻는 주기
CG_BACKOFF = 15 * 60  # 429(호출 제한)를 받으면 쉬는 시간
TOP_CAP = 40  # 시가총액 상위 몇 개
TOP_UPBIT = 40  # 업비트 원화 거래대금 상위 몇 개
WARM = False  # --warm: 로컬에서 한 번에 채울 때 (429 를 받으면 쉬었다 이어 간다)

STABLE = {"USDT", "USDC", "DAI", "USDE", "USDS", "FDUSD", "TUSD", "PYUSD", "USD1", "RLUSD", "USDP", "JPYC", "USDD", "GUSD",
          "BUSD", "USDB", "USDG", "USD0", "EURC", "KRW1", "USDF", "SUSDE", "USDTB", "BFUSD", "USYC", "BUIDL", "USX", "FRAX"}
NOT_TICKER = {"KRW", "USD", "UTC", "KST", "NFT", "API", "ETF", "VIP", "APR", "APY", "FAQ", "AMA", "DEX", "CEX", "IEO", "IDO",
              "TGE", "P2P", "OTC", "SNS", "KYC", "ID", "AI", "OS", "PC", "APP", "TV", "CEO", "Q1", "Q2", "Q3", "Q4", "UAH",
              "EUR", "JPY", "BRL", "TRY", "USDⓈ", "VS", "OR", "AND", "ON", "BEP20", "BEP2", "ERC20", "TRC20", "SPL"}

# ── HTTP ─────────────────────────────────────────────────
_next_slot, _slot_lock = {}, threading.Lock()


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """텔레그램은 미리보기가 없으면(대화방·없는 채널) 302 로 돌려보낸다 — 따라가지 않고 그 자체를 판정에 쓴다"""

    def redirect_request(self, *a, **k):
        return None


_no_redirect = urllib.request.build_opener(_NoRedirect)


def _wait(host, gap):
    with _slot_lock:
        now = time.monotonic()
        slot = max(now, _next_slot.get(host, 0.0))
        _next_slot[host] = slot + gap
    if slot > now:
        time.sleep(slot - now)


def http_get(url, gap=0.3, timeout=10, follow=True, accept="application/json, text/html;q=0.9, */*;q=0.5", headers=None):
    """호스트별 최소 간격을 지키는 GET (다시 시도하지 않는다 — 다음 실행이 이어 받는다)"""
    _wait(urllib.parse.urlsplit(url).hostname, gap)
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": accept, "Accept-Language": "ko,en;q=0.8", **(headers or {})})
    with (urllib.request.urlopen if follow else _no_redirect.open)(req, timeout=timeout) as r:
        return r.read().decode("utf-8", "replace")


def cg_get(path):
    """코인게코 — 키 없이 느리게. (선택) 무료 Demo 키를 COINGECKO_DEMO_KEY 로 주면 그 키로 조금 덜 느리게"""
    key = os.environ.get("COINGECKO_DEMO_KEY", "").strip()
    return json.loads(http_get(CG_API + path, gap=2.5 if key else CG_GAP, timeout=15, headers={"x-cg-demo-api-key": key} if key else None))


# ── 글 다듬기 ──────────────────────────────────────────────
def text_of(s):
    """HTML 조각 → 한 줄 글 (줄바꿈 태그는 줄바꿈으로 남긴다)"""
    s = re.sub(r"<br\s*/?>|</p>|</div>|</li>|</h\d>", "\n", s or "", flags=re.I)
    s = html.unescape(re.sub(r"<[^>]+>", " ", s))
    lines = [re.sub(r"\s+", " ", x.replace(chr(0x200B), "")).strip() for x in s.split("\n")]  # 줄 안의 공백·nbsp 정리, 폭 없는 공백 제거
    return "\n".join(x for x in lines if x)


def one_line(s):
    return re.sub(r"\s+", " ", s or "").strip()


def clip(s, n):
    s = one_line(s)
    return s if len(s) <= n else s[: n - 1].rstrip() + "…"


GREETING = re.compile(r"^\s*안녕하세요[.!,]?\s*[^.]{0,60}?입니다[.!]?\s*")


def body_summary(text):
    """공지 본문 앞부분 — 인사말·마크다운 기호·법령 근거 괄호를 빼고 160자"""
    t = GREETING.sub("", one_line(text))
    t = re.sub(r"\((?:[^()]*시행령[^()]*)\)|#{1,6}\s*|\*{1,3}(?=\S)|(?<=\S)\*{1,3}", "", t)
    return clip(re.sub(r"\.\s*\.", ".", t), 160)


def ts_iso(s, tz=None):
    try:
        d = datetime.fromisoformat(s.replace("Z", "+00:00"))
        return int((d if d.tzinfo else d.replace(tzinfo=tz or KST)).timestamp())
    except Exception:
        return None


# ── 티커 뽑기 ─────────────────────────────────────────────
def _ok_ticker(t):
    return bool(re.fullmatch(r"[A-Z0-9]{2,12}", t)) and re.search(r"[A-Z]", t) and t not in NOT_TICKER


def _add(out, *ts):
    for t in ts:
        t = t.strip()
        if _ok_ticker(t) and t not in out:
            out.append(t)


def tickers_kr(title):
    """'콘크리트(CT) 신규 거래지원', '아이오에스티(IOST), 테조스(XTZ)', '담보자산 추가 (SOL, XRP)' → 티커들 (최대 4)"""
    out = []
    for inner in re.findall(r"\(([A-Z0-9][A-Z0-9 ,]*)\)", title):
        parts = [p.strip() for p in inner.split(",") if p.strip()]
        if all(re.fullmatch(r"[A-Z0-9]{2,12}", p) for p in parts):
            _add(out, *parts)
    return out[:4]


def tickers_en(title, body=""):
    """'Binance Will List Hyperliquid (HYPE)', 'Will Delist EPIC, QUICK on ..', '.. CTUSDT Perpetual' → 티커들 (최대 4)"""
    out = []
    m = re.search(r"\bWill (?:Delist|List|Remove|Extend the Monitoring Tag to Include)\s+(.+?)(?:\s+on\s+\d|\s+with\s|\s*\(|\s*-\s*\d|$)", title)
    if m:  # 'Will Delist A, B & C on ..' 목록을 먼저 (괄호는 이름 구분용일 때가 있다: 'SLX (SLIMEX)')
        _add(out, *re.split(r"\s*(?:,|&|\band\b)\s*", m.group(1)))
    for inner in re.findall(r"\(([A-Z0-9]{2,12})\)", title):
        _add(out, inner)
    for t in re.findall(r"\b([A-Z0-9]{2,12})USDT\b", title):
        _add(out, t)
    if not out and body:  # 제목에 없으면 요약문에서 괄호 티커만
        for inner in re.findall(r"\(([A-Z0-9]{2,12})\)", body):
            _add(out, inner)
    return out[:4]


# ── 공지 규칙 판단 ─────────────────────────────────────────
# 결과: (점수, 이유) · (점수, 이유, 주의 꼬리표) · (None, 거른 이유)
# 백데이터 검증(코인니스 2024~2026 · 업비트 일봉) 결과를 따른다:
#  - 업비트 신규 상장 소식 153건 뒤 7일 수익률 중앙값 -11.4%, 오른 비율 24% (보통 뉴스보다 -6.65%p), 30일 중앙값 -23.5%
#    → 상장은 호재(2)로 보지 않는다. 0 + 주의 꼬리표 caution='listing'. 해외 거래소 상장도 7일 -1.16%p 로 약했다 → 0.
#  - 상폐·유의 지정도 공지 뒤 7일 추가 하락이 뚜렷하지 않았다 → -2 대신 -1 + caution='delist' / 'warning'.
# 그래서 규칙 점수는 -1..1 만 쓴다 (±2 는 AI 가 본문을 보고 정말 큰 사건일 때만).
LISTING_NOTE = "과거엔 상장 직후 오른 뒤 7일 안에 내린 경우가 많아요"
ABROAD_NOTE = "해외 거래소 상장은 과거 영향이 약했어요"
AFTER_NOTE = "과거엔 공지 뒤 7일 추가 하락은 뚜렷하지 않았어요"
PROBLEM_KR = re.compile(r"해킹|보안\s*(?:사고|이슈|문제|위협|사항)|탈취|공격|익스플로잇|exploit|취약점|이상\s*(?:거래|징후|출금|입금)|"
                        r"블록\s*생성\s*(?:중단|지연|오류)|네트워크\s*(?:장애|불안정|오류|이슈|중단|문제)|체인\s*(?:중단|정지|오류)|노드\s*(?:장애|이슈|문제)")
ROUTINE_KR = re.compile(r"업그레이드|하드포크|하드\s*포크|점검|전환|마이그레이션|스왑|교체|실사|리브랜딩")


def rule_kr(title, cat, body, codes):
    """업비트·빗썸 공지 1차 판단"""
    t = title
    stable_only = bool(codes) and all(c in STABLE for c in codes)
    if cat == "NFT" or re.search(r"\bNFT\b|드롭스", t):
        return None, "NFT 공지"
    if "이벤트" in cat or re.search(r"이벤트|챌린지|경품", t):
        return (0, "이벤트 안내") if codes else (None, "이벤트·홍보 공지")
    if re.search(r"신규\s*거래\s*지원|마켓\s*(?:디지털\s*자산\s*)?추가|원화\s*마켓\s*추가|상장\s*안내", t) and "종료" not in t:
        if stable_only:
            return 0, "스테이블코인 상장"
        if re.search(r"KRW|원화", t):
            return 0, f"원화 마켓 신규 상장 — {LISTING_NOTE}", "listing"
        return 0, f"BTC·USDT 마켓 상장 — {LISTING_NOTE}", "listing"
    if re.search(r"거래\s*지원\s*종료|상장\s*폐지|거래지원종료", t):
        if re.search(r"(?:BTC|USDT)\s*마켓\s*(?:\S+\s*)?거래\s*지원\s*종료", t) and not re.search(r"KRW|원화", t):
            return -1, "일부 마켓 거래지원 종료", "delist"
        return (0, "스테이블코인 거래지원 종료") if stable_only else (-1, f"거래지원 종료(상장폐지) — {AFTER_NOTE}", "delist")
    if re.search(r"유의\s*종목|투자\s*유의|유의\s*지정|거래\s*유의", t) or cat == "투자유의":
        if "해제" in t:
            return 1, "유의 종목 지정 해제"
        if "연장" in t:
            return -1, "유의 종목 지정 기간 연장", "warning"
        return -1, f"투자 유의 종목 지정 — {AFTER_NOTE}", "warning"
    if re.search(r"(?:투자|거래)\s*(?:주의|경고)\s*종목|주의\s*종목\s*지정", t):
        return (1, "주의 종목 해제") if "해제" in t else (-1, "투자 주의·경고 지정", "warning")
    if re.search(r"(?:입출금|입금|출금)[^()]{0,12}(?:중단|중지)", t):
        if re.search(r"완료|재개|취소", t):
            return 0, "입출금 재개·점검 완료"
        if PROBLEM_KR.search(t + " " + (body or "")):
            return -1, "네트워크·보안 문제로 입출금 중단"
        if ROUTINE_KR.search(t + " " + (body or "")):
            return 0, "업그레이드·점검으로 입출금 일시 중단"
        return 0, "입출금 일시 중단(사유는 원문 확인)"
    if re.search(r"재개", t):
        return 0, "입출금 재개"
    if re.search(r"에어드랍|에어드롭", t):
        return 0, "에어드랍 지급 안내"
    if re.search(r"리브랜딩|명칭\s*변경|유통량|토큰\s*(?:스왑|교체)|네트워크\s*(?:추가|전환)", t):
        return 0, "토큰 정보 변경"
    return 0, "일반 공지"


STOCKY = re.compile(r"bStocks|Tokeni[sz]ed Securit|Stock Trading|Stocks? on Binance|TradFi|Pre-IPO|Cash Dividend|Quanto|"
                    r"\bUSDBRL|\bFiat\b|\bUAH\b|\bADR\b", re.I)
PROBLEM_EN = re.compile(r"\bhack|exploit|security (?:incident|issue|breach)|compromis|attack|vulnerab|halt(?:ed)? .*network|network (?:issue|outage)", re.I)


def rule_binance(title, catalog, body, codes):
    """바이낸스 공지 1차 판단 (catalog: 48 상장, 161 상장폐지, 157 점검, 49 소식, 128 에어드랍, 93 이벤트, 51 API)"""
    t = title
    stable_only = bool(codes) and all(c in STABLE for c in codes)
    if catalog in (93, 51):
        return None, "이벤트·API 공지"
    if STOCKY.search(t):
        return None, "주식·전통자산 상품 공지"
    if re.search(r"\bWill Delist\b", t) and not re.search(r"Futures|Margin|Loan|Trading Pair", t):
        return (0, "스테이블코인 상장폐지") if stable_only else (-1, f"바이낸스 현물 상장폐지 — {AFTER_NOTE}", "delist")
    if re.search(r"Monitoring Tag|Vote to Delist", t):
        return -1, "모니터링 태그(상폐 후보) 지정", "warning"
    if re.search(r"Futures Will Delist|Margin.*Delist|Loans? .*Delist|Alpha Will Remove|Delist .*Perpetual", t):
        return -1, "선물·마진·알파 제외", "delist"
    if re.search(r"Removal of .*Trading Pairs", t):
        return 0, "일부 거래쌍 제거"
    if re.search(r"HODLer Airdrops", t) and not re.search(r"Continues|Completed|Completes", t):
        return 0, f"바이낸스 상장(홀더 에어드랍) — {ABROAD_NOTE}", "listing"
    if re.search(r"Launchpool|Launchpad|Megadrop", t):
        return 0, f"바이낸스 런치풀·런치패드 — {ABROAD_NOTE}", "listing"
    if re.search(r"\bWill List\b", t):
        return (0, "스테이블코인 상장") if stable_only else (0, f"바이낸스 현물 신규 상장 — {ABROAD_NOTE}", "listing")
    if re.search(r"Futures Will Launch.*Perpetual|Futures Will List.*Perpetual", t):
        return 0, f"바이낸스 선물 상장 — {ABROAD_NOTE}", "listing"
    if re.search(r"Will Add .* on (?:Earn|Buy Crypto|Convert|VIP Loan|Margin)", t):
        return 0, "바이낸스 부가 서비스 추가"
    if re.search(r"Binance Alpha", t) and re.search(r"List|Feature|Add", t):
        return 0, f"바이낸스 알파 추가 — {ABROAD_NOTE}", "listing"
    if PROBLEM_EN.search(t + " " + (body or "")) and re.search(r"Suspend|Halt|Pause|Deposit|Withdraw", t, re.I):
        return -1, "보안·네트워크 문제로 입출금 중단"
    if re.search(r"Upgrade|Hard Fork|Maintenance|Migration|Token Merge|Contract Swap|Token Swap|Rebrand|Redenominat", t, re.I):
        return 0, "네트워크 업그레이드·토큰 교체"
    if re.search(r"Airdrop|Distribution", t, re.I):
        return 0, "에어드랍·분배 지원"
    if re.search(r"Trading Pairs|Margin Will Add|Quarterly|Delivery", t):
        return 0, "거래쌍·상품 추가"
    if re.search(r"Competition|Tournament|Carnival|Word of the Day|Campaign|Promotion|Share .*(?:Rewards|USDC|USDT|Vouchers)|"
                 r"Earn Up to|Up for Grabs|APR\b|Cashback|Giveaway", t, re.I):
        return None, "이벤트·프로모션 공지"  # 텔레그램으로 받을 때는 분류가 없어 제목으로 거른다
    return 0, "일반 공지"


# ── 거래소 공지 받기 ───────────────────────────────────────
UPBIT_LIST = "https://api-manager.upbit.com/api/v1/announcements?os=web&page=1&per_page=20&category=all"
BITHUMB_LIST = "https://api.bithumb.com/v1/notices?count=20"
BINANCE_LIST = "https://www.binance.com/bapi/composite/v1/public/cms/article/list/query?type=1&pageNo=1&pageSize=20"
BINANCE_CATALOGS = {48, 161, 157, 49, 128}  # 이벤트(93)·API(51)는 받지 않는다


def fetch_upbit():
    rows = []
    for n in json.loads(http_get(UPBIT_LIST))["data"]["notices"]:
        title = one_line(n.get("title"))
        if title and n.get("id"):
            rows.append({"id": f"upbit-{n['id']}", "title": title, "src": "업비트", "cat": n.get("category") or "",
                         "ts": ts_iso(n.get("first_listed_at") or n.get("listed_at") or ""),
                         "url": f"https://upbit.com/service_center/notice?id={n['id']}",
                         "_detail": f"https://api-manager.upbit.com/api/v1/announcements/{n['id']}"})
    return rows


def fetch_bithumb():
    rows = []
    for n in json.loads(http_get(BITHUMB_LIST)):
        title, url = one_line(n.get("title")), n.get("pc_url") or ""
        m = re.search(r"/notice/(\d+)", url)
        if title and m:
            rows.append({"id": f"bithumb-{m.group(1)}", "title": title, "src": "빗썸", "cat": "·".join(n.get("categories") or []),
                         "ts": ts_iso((n.get("published_at") or "").replace(" ", "T")),
                         "url": f"https://feed.bithumb.com/notice/{m.group(1)}", "_detail": f"https://feed.bithumb.com/notice/{m.group(1)}"})
    return rows


def fetch_binance():
    rows = []
    for c in json.loads(http_get(BINANCE_LIST))["data"]["catalogs"]:
        if c.get("catalogId") not in BINANCE_CATALOGS:
            continue
        for a in c.get("articles") or []:
            title, code = one_line(a.get("title")), a.get("code")
            if title and code:
                rows.append({"id": f"binance-{code}", "title": title, "src": "바이낸스", "cat": c.get("catalogName") or "",
                             "_catalog": c.get("catalogId"), "ts": int(a["releaseDate"] / 1000) if a.get("releaseDate") else None,
                             "url": f"https://www.binance.com/en/support/announcement/detail/{code}",
                             "_detail": f"https://www.binance.com/bapi/composite/v1/public/cms/article/detail/query?articleCode={code}"})
    return rows


def fetch_binance_tg(bodies):
    """바이낸스 공지 API 가 막혔을 때(예: 미국 서버) — 바이낸스 공식 공지 텔레그램 채널(@binance_announcements) 미리보기로 대신.
    분류(catalog)는 없고 제목으로만 판단한다. 글 본문 앞부분을 bodies 에 바로 넣는다 (본문을 따로 받지 않는다)."""
    page = http_get("https://t.me/s/binance_announcements", gap=TG_GAP, follow=False, accept="text/html")
    rows = []
    for block in page.split('<div class="tgme_widget_message_wrap')[1:]:
        code = re.search(r"binance\.com/[a-zA-Z-]+/support/announcement/(?:detail/)?([0-9a-f]{32})", block)
        mx = re.search(r'<div class="tgme_widget_message_text js-message_text"[^>]*>(.*?)</div>', block, re.S)
        mt = re.search(r'<time datetime="([^"]+)"', block)
        if not (code and mx):
            continue
        text = text_of(mx.group(1))
        lines = text.split("\n")
        title = one_line(lines[0])
        if not title:
            continue
        rid = f"binance-{code.group(1)}"
        bodies.setdefault(rid, one_line(" ".join(lines[1:]))[:600])
        rows.append({"id": rid, "title": title, "src": "바이낸스", "cat": "", "_catalog": None,
                     "ts": ts_iso(mt.group(1), timezone.utc) if mt else None,
                     "url": f"https://www.binance.com/en/support/announcement/detail/{code.group(1)}"})
    return rows


def fetch_detail(row):
    """공지 본문 앞부분 (규칙 판단 근거·요약)"""
    raw = http_get(row["_detail"], accept="text/html" if row["src"] == "빗썸" else "application/json")
    if row["src"] == "업비트":
        return text_of(json.loads(raw)["data"].get("body") or "")[:600]
    if row["src"] == "바이낸스":
        d = json.loads(raw)["data"]
        return one_line(d.get("seoDesc") or "")[:600]
    m = re.search(r'<script id="__NEXT_DATA__"[^>]*>(.*?)</script>', raw, re.S)  # 빗썸: 글 페이지에 실린 데이터
    d = json.loads(m.group(1))["props"]["pageProps"]["data"] if m else {}
    return text_of(html.unescape(d.get("content") or ""))[:600]


def judge_notice(row, body):
    """→ (항목, None) 또는 (None, 거른 이유)"""
    if row["src"] == "바이낸스":
        codes = tickers_en(row["title"], body)
        res = rule_binance(row["title"], row.get("_catalog"), body, codes)
    else:
        codes = tickers_kr(row["title"])
        res = rule_kr(row["title"], row.get("cat") or "", body, codes)
    s, r, caution = res[0], res[1], (res[2] if len(res) > 2 else None)
    if s is None:
        return None, r
    if s == 0 and (not codes or (all(c in STABLE for c in codes) and not r.startswith("스테이블"))):
        return None, "관련 코인 없는 일반 공지"
    if row.get("ts") and row["ts"] < time.time() - NOTICE_MAX_AGE:
        return None, "30일 지난 공지"
    summary = body_summary(body) if body else ""  # 본문은 다음 실행들에서 조금씩 채워진다
    it = {"id": row["id"], "title": row["title"], "src": row["src"], "ts": row.get("ts"), "summary": summary,
          "url": row["url"], "codes": codes, "cat": row.get("cat") or "", "rule": {"s": s, "r": r}}
    if caution:  # 'listing' 상장(상장 직후 7일 하락이 잦았다) · 'delist' 거래지원 종료 · 'warning' 유의·모니터링 지정
        it["caution"] = caution
    return it, None


def run_notices(state, deadline, log):
    """세 거래소 목록을 받고 새 글 본문을 조금씩 받는다 → state['notice'][거래소] = 목록 행"""
    store, bodies = state.setdefault("notice", {}), state.setdefault("bodies", {})
    for name, fn in (("upbit", fetch_upbit), ("bithumb", fetch_bithumb), ("binance", fetch_binance)):
        if time.time() > deadline:
            break
        try:
            store[name] = fn()
        except Exception as e:  # 막히면 직전 목록을 그대로 쓴다
            log(f"[공지] {name} 목록 실패: {e}")
            if name == "binance":
                try:
                    store[name] = fetch_binance_tg(bodies)
                    log(f"[공지] 바이낸스는 공식 공지 텔레그램으로 대신 받음 ({len(store[name])}건)")
                except Exception as e2:
                    log(f"[공지] 바이낸스 텔레그램도 실패: {e2}")
    rows = [r for v in store.values() for r in v]
    todo = []
    for r in rows:
        if r["id"] in bodies or not r.get("_detail") or (r.get("ts") or 0) < time.time() - NOTICE_MAX_AGE:
            continue
        it, _ = judge_notice(r, "")
        if not it or it["rule"]["r"] == "이벤트 안내":
            continue  # 어차피 거르거나 판단에 본문이 필요 없는 글은 받지 않는다
        todo.append((0 if "원문 확인" in it["rule"]["r"] else 1, -(r.get("ts") or 0), r))  # 사유가 본문에만 있는 입출금 중단을 먼저
    got = 0
    for _, _, r in sorted(todo, key=lambda x: x[:2]):
        if got >= DETAIL_PER_RUN or time.time() > deadline - 2:
            break
        try:
            bodies[r["id"]] = fetch_detail(r)
            got += 1
        except Exception as e:
            bodies[r["id"]] = ""  # 다시 받지 않는다 (요약만 비고 판단은 제목으로)
            log(f"[공지] {r['id']} 본문 실패: {e}")
    live = {r["id"] for r in rows}
    for k in [k for k in bodies if k not in live]:
        del bodies[k]


def notice_topic(state, dropped=None):
    items = []
    for r in sorted((r for v in state.get("notice", {}).values() for r in v), key=lambda r: -(r.get("ts") or 0)):
        it, why = judge_notice(r, state.get("bodies", {}).get(r["id"], ""))
        if it:
            items.append(it)
        elif dropped is not None:
            dropped.append((why, r["src"], r["title"]))
    return {"key": "notice", "label": "거래소 공지", "items": items[:MAX_ITEMS]}


# ── 코인게코: 코인 ↔ 공식 텔레그램 채널 ─────────────────────
def norm_name(s):
    s = re.sub(r"[^a-z0-9]", "", (s or "").lower())
    return re.sub(r"^the", "", s)


def _read_json(path, default):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except Exception:
        return default


def upbit_volume_order(data_dir):
    """업비트 원화 거래대금 순 티커 — 직전 수집 결과(screener/upbit.json)에서. 없으면 빈 목록(코인게코 순서를 쓴다)"""
    rows = _read_json(Path(data_dir) / "screener" / "upbit.json", {}).get("rows") or []
    return [r["sub"] for r in sorted((r for r in rows if r.get("sub")), key=lambda r: -(r.get("vol") or 0))]


def is_stable_or_wrapped(m):
    name, sym = (m.get("name") or "").lower(), (m.get("symbol") or "").upper()
    if sym in STABLE or re.search(r"wrapped|staked|bridged|liquid staking|restaked|\bw?steth\b|tokenized|heloc|treasury", name):
        return True
    p = m.get("current_price")
    return "usd" in sym.lower() and p is not None and 0.97 <= p <= 1.03


def build_dir(state, data_dir, log):
    """하루 1번: 대상 코인 목록(시총 상위 + 업비트 원화 거래대금 상위)과 코인게코 id

    업비트 티커 ↔ 코인게코 id 는 코인게코가 업비트 마켓마다 적어 둔 coin_id(/exchanges/upbit/tickers)를 그대로 쓴다
    — 같은 티커 다른 코인을 이름으로 짐작하지 않는다. 시총 상위 코인은 업비트의 같은 티커가 다른 코인이면 티커를 붙이지 않는다.
    """
    d = state.setdefault("dir", {"at": 0, "coins": {}})
    if time.time() - d.get("at", 0) < CG_DIR_TTL:
        return
    markets = cg_get("/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=1")
    up_t = cg_get("/exchanges/upbit/tickers?page=1&order=volume_desc").get("tickers") or []
    up_id = {}  # 업비트 원화 티커 → 코인게코 id (거래량 순)
    for t in up_t:
        if t.get("target") == "KRW" and t.get("base") and t.get("coin_id"):
            up_id.setdefault(t["base"].upper(), t["coin_id"])
    by_id = {m["id"]: m for m in markets}
    want = {}
    for m in markets:
        if sum(v["why"] == "cap" for v in want.values()) >= TOP_CAP:
            break
        if is_stable_or_wrapped(m):
            continue
        sym = m["symbol"].upper()
        codes = [sym] if up_id.get(sym, m["id"]) == m["id"] else []  # 업비트의 같은 티커가 다른 코인이면 티커를 붙이지 않는다
        want[m["id"]] = {"s": sym, "n": m["name"], "r": m.get("market_cap_rank"), "codes": codes, "why": "cap"}
    order = [s for s in upbit_volume_order(data_dir) if s in up_id] or list(up_id)
    up_en = {k[4:]: v[1] for k, v in (_read_json(Path(data_dir) / "coins.json", {}).get("upbit") or {}).items()
             if k.startswith("KRW-") and isinstance(v, list) and len(v) > 1}  # 업비트 영문 이름 (시총 250위 밖 코인용)
    n_up = 0
    for sym in order:
        if n_up >= TOP_UPBIT:
            break
        if sym in STABLE:
            continue
        cid = up_id[sym]
        n_up += 1
        if cid not in want:
            m = by_id.get(cid) or {}
            want[cid] = {"s": sym, "n": m.get("name") or up_en.get(sym) or sym, "r": m.get("market_cap_rank"), "codes": [sym], "why": "upbit"}
    old = d.get("coins", {})
    for cid, v in want.items():  # 이미 받은 채널 정보는 이어 쓴다
        if cid in old:
            v.update({k: old[cid][k] for k in ("tg", "at") if k in old[cid]})
    d["coins"], d["at"] = want, int(time.time())
    log(f"[코인 SNS] 대상 코인 {len(want)}개 (시총 상위 {sum(v['why'] == 'cap' for v in want.values())} · 업비트 거래대금 상위로 더한 것 "
        f"{sum(v['why'] == 'upbit' for v in want.values())})")


TG_LINK = re.compile(r"(?:https?://)?(?:t\.me|telegram\.me)/(?:s/)?([A-Za-z][A-Za-z0-9_]{3,31})/?$")


def tg_names(links):
    """코인게코 links → 공지 채널 후보 (공지 주소에 있는 t.me 를 먼저, 그다음 telegram_channel_identifier)"""
    out = []
    for u in links.get("announcement_url") or []:
        m = TG_LINK.match((u or "").strip())
        if m:
            out.append(m.group(1))
    ident = (links.get("telegram_channel_identifier") or "").strip().lstrip("@")
    if re.fullmatch(r"[A-Za-z][A-Za-z0-9_]{3,31}", ident):
        out.append(ident)
    seen, res = set(), []
    for n in out:
        if n.lower() not in seen and n.lower() not in ("joinchat", "share", "addstickers", "proxy", "s"):
            seen.add(n.lower())
            res.append(n)
    return res[:2]


def run_coingecko(state, data_dir, deadline, log):
    """대상 목록(하루 1번) + 오래된 코인 몇 개씩 상세(텔레그램 채널 아이디) 받기"""
    if time.time() < state.get("cgWait", 0):
        return
    try:
        build_dir(state, data_dir, log)
        coins = state.get("dir", {}).get("coins", {})
        todo = sorted((cid for cid, v in coins.items() if time.time() - v.get("at", 0) > CG_COIN_TTL),
                      key=lambda cid: (coins[cid].get("at", 0), coins[cid].get("r") or 9999))
        n = 0
        for cid in todo:
            if n >= CG_PER_RUN or time.time() > deadline - CG_GAP - 3:
                break
            path = (f"/coins/{urllib.parse.quote(cid)}?localization=false&tickers=false&market_data=false"
                    "&community_data=false&developer_data=false&sparkline=false")
            try:
                d = cg_get(path)
            except urllib.error.HTTPError as e:
                if not (WARM and e.code == 429):
                    raise
                log("[코인 SNS] 코인게코 429 — 70초 쉬고 이어서 (--warm)")
                time.sleep(70)
                d = cg_get(path)
            coins[cid]["tg"], coins[cid]["at"] = tg_names(d.get("links") or {}), int(time.time())
            coins[cid]["n"] = d.get("name") or coins[cid].get("n")  # 채널 이름 확인용 (시총 250위 밖 코인은 목록에 이름이 없다)
            n += 1
    except urllib.error.HTTPError as e:
        if e.code == 429:
            state["cgWait"] = int(time.time() + CG_BACKOFF)
        log(f"[코인 SNS] 코인게코 실패: {e}")
    except Exception as e:
        log(f"[코인 SNS] 코인게코 실패: {e}")


# ── 텔레그램 공개 채널 미리보기 ────────────────────────────
PROMO = re.compile(
    r"give\s?away|airdrop\s+(?:campaign|event|is live|now live|quest|task)|claim (?:your|now|free)|free (?:tokens?|nfts?|mint)|"
    r"whitelist|pre-?sale|referral|invite (?:your )?friends|retweet|\blike\s*(?:&|and)\s*(?:rt|retweet|share)|\bquests?\b|"
    r"galxe|zealy|taskon|layer3|\bcontests?\b|competition|\bprizes?\b|reward pool|prize pool|\bwin (?:up to )?\$|"
    r"\$\s?\d[\d,.]*\s?k? (?:in|worth of) (?:rewards|prizes|tokens)|lucky draw|에어드랍 이벤트|이벤트 참여|경품|추첨", re.I)
EVENT = re.compile(r"\bAMA\b|\bx spaces?\b|twitter spaces?|live ?stream|tune in|join us (?:live|on|at|for|tomorrow|today)|"
                   r"watch (?:live|now)|\bmeetup\b|webinar|happening now|going live|라이브 방송", re.I)


def post_filter(text, forwarded):
    """광고·홍보성이면 거른 이유, 아니면 None"""
    if forwarded:
        return "다른 채널 글 전달"
    if not text:
        return "본문 없음(사진·영상만)"
    bare = re.sub(r"https?://\S+|t\.me/\S+|@\w+|#\w+", " ", text)
    bare = re.sub(r"[^\w가-힣]+", " ", bare).strip()
    if len(bare) < 25:
        return "링크·짧은 글"
    if PROMO.search(text):
        return "에어드랍·경품 홍보"
    if EVENT.search(text):
        return "AMA·방송 안내"
    return None


def parse_channel(page, name):
    """t.me/s/<채널> HTML → (채널 정보, [글...], [(거른 이유, 글)...])"""
    info = {"title": "", "v": False, "subs": ""}
    m = re.search(r'class="tgme_channel_info_header_title"[^>]*>(.*?)</div>', page, re.S)
    if m:
        info["title"] = one_line(text_of(m.group(1)))[:60]
    lab = re.search(r'class="tgme_channel_info_header_labels"[^>]*>(.*?)</div>', page, re.S)
    info["v"] = bool(lab and "verified-icon" in lab.group(1))
    m = re.search(r'counter_value">([^<]*)</span>\s*<span class="counter_type">(subscribers|members)', page)
    if m:
        info["subs"], info["kind"] = m.group(1), m.group(2)
    posts, dropped = [], []
    for block in page.split('<div class="tgme_widget_message_wrap')[1:]:
        if "service_message" in block[:400]:
            continue
        mp = re.search(r'data-post="([^"/]+)/(\d+)"', block)
        if not mp:
            continue
        mt = re.search(r'<time datetime="([^"]+)"', block)
        ts = ts_iso(mt.group(1), timezone.utc) if mt else None
        mx = re.search(r'<div class="tgme_widget_message_text js-message_text"[^>]*>(.*?)</div>', block, re.S)
        text = text_of(mx.group(1)) if mx else ""
        fwd = "tgme_widget_message_forwarded_from" in block
        post = {"n": int(mp.group(2)), "ts": ts, "text": text[:400]}
        # 링크만 올린 글(프로젝트 X 글을 옮겨 온 것 등)은 텔레그램이 만들어 둔 링크 미리보기 글을 본문으로 쓴다 (X 를 직접 읽지 않는다)
        lp = re.search(r'class="tgme_widget_message_link_preview"(.*?)</a>', block, re.S)
        if lp and len(re.sub(r"https?://\S+|[^\w가-힣]+", "", text)) < 20:
            desc = re.search(r'link_preview_description"[^>]*>(.*?)</div>', lp.group(1), re.S)
            site = re.search(r'link_preview_site_name[^>]*>(.*?)</div>', lp.group(1), re.S)
            if desc and text_of(desc.group(1)):
                post["text"] = text_of(desc.group(1))[:400]
                post["via"] = one_line(text_of(site.group(1)))[:30] if site else ""
                text = post["text"]
        why = post_filter(text, fwd)
        if why:
            dropped.append((why, post))
        else:
            posts.append(post)
    return info, posts, dropped


def channel_trusted(info, name, coin_names):
    """코인게코가 준 채널이라도 이름이 코인과 전혀 다르면 보류 (텔레그램 인증 표시가 있으면 통과)"""
    if info.get("v"):
        return True
    hay = norm_name(info.get("title")) + " " + norm_name(name)
    keys = set()
    for n in coin_names:  # 'MiL.k Alliance' → milkalliance · milk (흔한 낱말은 빼고)
        keys.add(norm_name(n))
        keys.update(norm_name(w) for w in re.split(r"[\s\-]+", n or "") if norm_name(w) not in GENERIC_WORDS)
    return any(len(k) >= 3 and k in hay for k in keys)


GENERIC_WORDS = {"the", "network", "protocol", "finance", "token", "coin", "chain", "labs", "foundation", "official", "dao",
                 "alliance", "ecosystem", "blockchain", "community", "project", "swap", "exchange", "wallet", "app", "ai", "x"}


def channel_list(state):
    """코인게코 결과 → {채널(소문자): {"name", "codes", "coins"}}"""
    out = {}
    for cid, v in (state.get("dir", {}).get("coins") or {}).items():
        for name in v.get("tg") or []:
            c = out.setdefault(name.lower(), {"name": name, "codes": [], "coins": []})
            c["codes"] += [x for x in v.get("codes", []) if x not in c["codes"]]
            c["coins"] += [v.get("n") or "", v.get("s") or ""]
    return out


def run_telegram(state, chans, deadline, log, per_run=TG_PER_RUN, report=None):
    """오래된 채널부터 per_run 개 — 채널당 요청 1번, 간격 TG_GAP 초 이상, 302(대화방·없음)·차단은 건너뛴다"""
    tg = state.setdefault("tg", {})
    for k in [k for k in tg if k not in chans]:
        del tg[k]
    now = time.time()
    due = [k for k in chans if not (tg.get(k, {}).get("ok") is False and now - tg[k].get("at", 0) < TG_RECHECK)]
    due.sort(key=lambda k: tg.get(k, {}).get("at", 0))
    n = 0
    for k in due[:min(per_run, 30)]:
        if time.time() > deadline - TG_GAP - 3:
            break
        c, rec = chans[k], tg.setdefault(k, {})
        rec.update({"name": c["name"], "codes": c["codes"][:4], "at": int(time.time())})
        n += 1
        try:
            page = http_get(f"https://t.me/s/{c['name']}", gap=TG_GAP, follow=False, accept="text/html")
        except urllib.error.HTTPError as e:
            if e.code in (301, 302, 303, 307, 308):
                rec.update({"ok": False, "why": "미리보기 없음(대화방·비공개·없는 채널)", "posts": []})
                continue
            log(f"[코인 SNS] t.me/s/{c['name']} HTTP {e.code} — 이번 실행은 텔레그램 중단")
            rec["at"] = 0
            break
        except Exception as e:
            log(f"[코인 SNS] t.me/s/{c['name']} 실패: {e}")
            continue
        if "tgme_channel_info" not in page:
            rec.update({"ok": False, "why": "채널 미리보기 형식 아님", "posts": []})
            continue
        info, posts, dropped = parse_channel(page, c["name"])
        if info.get("kind") == "members":
            rec.update({"ok": False, "why": "대화방(그룹)", "posts": []})
            continue
        if not channel_trusted(info, c["name"], c["coins"]):
            rec.update({"ok": False, "why": f"채널 이름({info['title']})이 코인과 달라 보류", "posts": []})
            continue
        posts = [p for p in posts if (p["ts"] or 0) > time.time() - POST_MAX_AGE]
        posts.sort(key=lambda p: -(p["ts"] or 0))
        rec.update({"ok": True, "why": "", "title": info["title"] or c["name"], "v": info["v"], "subs": info.get("subs", ""),
                    "posts": posts[:TG_POSTS_KEEP]})
        if report is not None:
            report.extend((why, f"@{c['name']}", p) for why, p in dropped)
    log(f"[코인 SNS] 텔레그램 {n}개 채널 확인 (전체 {len(chans)}, 공지 채널 {sum(1 for v in tg.values() if v.get('ok'))})")


def split_post(text):
    """글 → (제목 ≤90자, 요약 ≤160자)"""
    lines = [one_line(x) for x in (text or "").split("\n") if x.strip()]
    if not lines:
        return "", ""
    first, i = lines[0], 1
    while i < len(lines) and len(re.findall(r"[\w가-힣]+", first)) <= 2:  # '📢 Announcement' 처럼 두 낱말 이하면 다음 줄과 합친다
        first, i = first + " " + lines[i], i + 1
    if len(first) > 90:  # 첫 줄이 길면 첫 문장에서, 문장이 길면 낱말 경계에서 자르고 나머지는 요약으로
        m = re.match(r"(.{20,88}?[.!?。])\s", first)
        cut = len(m.group(1)) if m else (first.rfind(" ", 40, 88) if first.rfind(" ", 40, 88) > 0 else 88)
        head = first[:cut] if m else first[:cut].rstrip() + "…"
        return head, clip(" ".join([("…" if not m else "") + first[cut:].strip()] + lines[i:]), 160)
    return first, clip(" ".join(lines[i:]), 160)


def social_topic(state):
    items, seen = [], set()
    for k, rec in (state.get("tg") or {}).items():
        if not rec.get("ok"):
            continue
        for p in (rec.get("posts") or [])[:PER_CHANNEL]:
            if (p.get("ts") or 0) < time.time() - POST_MAX_AGE:
                continue
            title, summary = split_post(p["text"])
            key = norm_name(title)[:60]
            if not title or key in seen:
                continue
            seen.add(key)
            it = {"id": f"{k}-{p['n']}", "title": title, "src": rec.get("title") or rec["name"], "ts": p.get("ts"),
                  "summary": summary, "url": f"https://t.me/{rec['name']}/{p['n']}", "codes": rec.get("codes", [])[:4],
                  "ch": "@" + rec["name"], "verified": bool(rec.get("v"))}
            if p.get("via"):  # 채널이 옮겨 온 링크의 미리보기 글 (예: 'X (formerly Twitter)')
                it["via"] = p["via"]
            items.append(it)
    items.sort(key=lambda x: -(x["ts"] or 0))
    return {"key": "social", "label": "코인 SNS", "items": items[:MAX_ITEMS]}


# ── 진입점 ───────────────────────────────────────────────
def load_state(path):
    d = _read_json(path, {})
    return d if isinstance(d, dict) else {}


def save_state(path, state):
    state["updatedAt"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    for _ in range(3):  # 시간 초과로 아직 도는 갈래가 상태를 바꾸는 중이면 잠깐 뒤 다시
        try:
            text = json.dumps(state, ensure_ascii=False, separators=(",", ":"))
            break
        except RuntimeError:
            time.sleep(0.3)
    else:
        return
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".tmp")
    tmp.write_text(text, encoding="utf-8")
    tmp.replace(p)


def topics(data_dir=DATA, state_path=None, budget=BUDGET, log=print, tg_per_run=TG_PER_RUN, report=None):
    """news.json 에 넣을 두 주제 [거래소 공지, 코인 SNS] — 실패한 갈래는 직전 상태로 채운다

    report 에 dict 를 주면 거른 항목을 {"notice": [(이유, 출처, 제목)], "social": [(이유, @채널, 글)]} 로 담아 준다 (확인용).
    """
    data_dir = Path(data_dir)
    state_path = Path(state_path or data_dir / STATE_NAME)
    state = load_state(state_path)
    t0 = time.time()
    deadline = t0 + budget
    rep = report if report is not None else {}

    def guard(fn, *a, **k):
        try:
            fn(*a, **k)
        except Exception as e:
            log(f"[코인 SNS·공지] {fn.__name__} 실패: {e}")

    cg = threading.Thread(target=guard, args=(run_coingecko, state, data_dir, deadline, log), daemon=True)

    def telegram():
        # 대상은 직전까지 알아낸 채널 (코인게코와 동시에 돈다). 처음이라 하나도 없으면 코인게코가 끝나길 기다린다
        if WARM or not channel_list(state):
            cg.join()
        guard(run_telegram, state, channel_list(state), deadline, log, per_run=tg_per_run, report=rep.setdefault("social", []))

    threads = [threading.Thread(target=guard, args=(run_notices, state, deadline, log), daemon=True), cg,
               threading.Thread(target=telegram, daemon=True)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(max(1.0, deadline + 15 - time.time()))  # 요청 하나가 늦어도 전체가 멈추지 않게 (남은 갈래는 버린다)
    for _ in range(3):
        try:
            out = [notice_topic(state, rep.setdefault("notice", [])), social_topic(state)]
            break
        except RuntimeError:  # 버린 갈래가 마침 상태를 바꾸는 중
            time.sleep(0.3)
    else:
        out = [{"key": "notice", "label": "거래소 공지", "items": []}, {"key": "social", "label": "코인 SNS", "items": []}]
    save_state(state_path, state)
    log(f"[코인 SNS·공지] 공지 {len(out[0]['items'])} · SNS {len(out[1]['items'])}건 / {time.time() - t0:.1f}초")
    return out


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default=str(DATA), help="coins.json · screener/upbit.json 이 있는 폴더")
    ap.add_argument("--state", default=None, help="상태 파일 (기본: <data>/coin_social.json)")
    ap.add_argument("--budget", type=float, default=BUDGET)
    ap.add_argument("--warm", action="store_true", help="코인게코 상세·텔레그램 채널을 넉넉히 (로컬에서 처음 채울 때)")
    ap.add_argument("--out", default=None, help="두 주제를 JSON 으로 저장할 경로")
    args = ap.parse_args()
    if args.warm:
        CG_PER_RUN, CG_GAP, WARM = 200, 12.0, True
    rep = {}
    res = topics(args.data, args.state, budget=max(args.budget, 1500) if args.warm else args.budget, report=rep,
                 tg_per_run=30 if args.warm else TG_PER_RUN)
    if args.out:
        Path(args.out).write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding="utf-8")
    for t in res:
        print(f"\n== {t['label']} ({len(t['items'])})")
        for x in t["items"][:12]:
            when = datetime.fromtimestamp(x["ts"] or 0, KST).strftime("%m-%d %H:%M")
            tag = f" [{x['rule']['s']:+d} {x['rule']['r']}]" if x.get("rule") else ""
            print(f"  {when} {x['src'][:16]:<16} {','.join(x['codes']) or '-':<12}{tag} {x['title'][:70]}")
