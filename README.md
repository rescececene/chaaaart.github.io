# 마켓렌즈

코인(업비트·바이낸스)과 주식(국내·미국)의 실시간 시세·호가와, 업비트 옆에 두고 보는 예측(첫 화면 '추천' — 비트코인 다음 24시간·1시간 · 펌핑 후보 · 오늘 강할 코인 · 주식), 전체 순위, 차트 기술적 분석, 종목 골라보기, 호재·악재가 표시되는 속보를 보는 웹사이트. PC·휴대폰 모두 지원. 주문 기능은 없다(보기 전용).

예측 숫자 원칙: '시장 이길 확률' 대신 **'H 뒤 예상 +X% · 10번 중 8번은 A ~ B'**. 모든 예상은 학습에 쓰지 않은 과거(워크포워드)로 검증하고, 배포 뒤에는 실제 결과로 채점해 '되짚어 본 성적'과 '실제 기록'을 나눠 보여 준다. 검증이 약하면 숨기지 않고 먼저 알린다.

공개 주소: https://rescececene.github.io/chaaaart.github.io/

## 구조

| 부분 | 하는 일 | 위치 |
|---|---|---|
| 사이트 | React 19 + TypeScript + Vite + Tailwind + shadcn/ui. 서버 없이 브라우저에서 동작 | `web/` → GitHub Pages |
| 수집기 | 전 종목 일봉 지표(종목 골라보기)·뉴스·지연 시세·종목별 일봉 파일 생성. 일정은 10분마다지만 GitHub 사정으로 실제로는 보통 40~70분 간격 | `collector/collect.py` → GitHub Actions |
| 뉴스·종목 해설 AI | 코인·주식 속보의 호재·악재 판단 · 종목 기술적 해설 (Cloudflare Workers AI · Gemma 4, 무료 사용량 안에서) | `collector/news_ai.py` · `stock_ai.py` → GitHub Actions |
| 예측 문장 AI | 비트코인 결론 · 펌핑 설명 · 순위 이유 문장 (클로드 하이쿠 우선 → 누적 150달러 한도 · 키 없음 · 오류면 Gemma) | `collector/ai.py` · `claude_ai.py` → GitHub Actions |
| 예측 엔진 | 하루 한 번 장기 일봉으로 순위 모델 학습 + 워크포워드 백테스트 + 유사 패턴 + 종목별 'H 뒤 예상 %'·범위(`model/expret.py`) → `predict/*.json` | `collector/model/` → GitHub Actions |
| 순위·추천 | 오늘 강할 코인(업비트 점수 상위 10% 안에서 24시간 뒤 예상이 높은 5개)·전체 순위·주식 추천, 매일 고른 5개를 실제 결과로 채점 → `rank.json`·`rank_top.json`·`recommend.json`·`picks_log.json` | `collector/recommend.py` · `picks_log.py` → GitHub Actions |
| 비트코인 예측 | 업비트 KRW-BTC 다음 24시간(수집기)·1시간(브라우저에서 바로 계산) 예상 %·80% 범위·오를 확률·갈림길 가격, 여러 변동성 모델 평균, 실행마다 채점 → `btc.json`·`btc_log.json` | `collector/btc_forecast.py` · `collector/btc/` → GitHub Actions |
| 펌핑 후보 | 업비트 원화 전 종목(시총·거래량 상관없이)의 72시간 안 +15% 가능성 — 후보 점수(0~100, 펌핑 확률 − 2×급락 확률의 과거 백분위 · 정렬 기준과 같음)·'3일 안 최고 +X%'·근거·위험, '이럴 땐 조심' 국면 경고, 과거 검증, 실제 신호 기록 → `pump.json`·`pump_stats.json`·`pump_log.json` | `collector/pump.py` (+ 처음용 모델 `collector/pump/`) → GitHub Actions |
| 중계 Worker | 브라우저에서 직접 못 부르는 네이버 증권·업비트 REST·야후·코인니스를 대신 호출 | `worker/worker.js` → Cloudflare |

- **코인 시세·호가**: 업비트·바이낸스 웹소켓에서 직접 실시간. 두 거래소에 모두 있는 코인은 하나로 보이고 거래소는 탭으로 고른다.
- **주식 시세**: Worker 를 거쳐 네이버 실시간 시세를 2.5초마다(시장 전체 목록은 5초), 국내 호가 5단계 1.5초마다. Worker 가 없으면 자동 수집 때(보통 1시간 안쪽)의 지연 데이터.
- **중계 아끼기**: Cloudflare 무료 플랜은 계정 전체 하루 10만 건(넘으면 오전 9시까지 멈춤). 그래서 화면이 숨겨지면 멈추고, 장이 닫혔거나 15분 넘게 조작이 없으면 30초마다 받는다(화면을 움직이면 바로 실시간). 기기마다 하루 4만 건을 넘기면 같은 절약 모드로 바뀐다.
- **Worker 접근**: `https://rescececene.github.io` 에서 온 요청(Origin)만 허용 — 사이트에 비밀값이 없다. Secret `ACCESS_KEY`(`?k=`)는 개발·다른 도구용 예비 수단.
  `worker/worker.js` 를 고치면 Cloudflare 편집기에 다시 붙여넣고 Deploy 해야 한다 (Actions 는 Worker 를 배포하지 않음).
- **뉴스·종목 해설 AI (Gemma, 무료)**: GitHub Actions 가 Cloudflare Workers AI REST 를 직접 부른다(중계 Worker 와 무관). 저장소 Secret `CF_ACCOUNT_ID`, `CF_AI_TOKEN`(대시보드 Workers AI → REST API 사용 → Workers AI API 토큰 만들기)이 있어야 켜지고, 없으면 투표·키워드 판단만 한다.
  하루 8,000 뉴런 어림에서 스스로 멈춘다(무료 1만, 넘어도 무료 플랜은 요금 없이 그날만 실패). 나눠 쓰는 순서: 종목 해설은 오늘 전체 6,000 까지(해설 몫 하루 4,500) → 예측 문장(클로드 대신 쓸 때)은 7,000 까지 → 뉴스 판단은 8,000 까지. 해외 속보는 판단하지 않는다.
  종목 해설은 업비트 원화 전 종목 + 바이낸스·국내·미국 상위(20·30·30) + 추천·예측 상위·펌핑 상위 종목을 돌려 가며(우선 종목은 3시간마다, 나머지는 오래된 것부터) 만든다. 결과는 `data/news_ai.json` · `data/stock_ai.json`, 사용량은 `data/ai_usage.json`.
- **예측 문장 AI (클로드 하이쿠 → Gemma)**: 새 기능의 문장(비트코인 결론 · 펌핑 설명 · 순위 이유)은 `collector/ai.py` 의 `ai.write(...)` 하나로 쓴다. 클로드(`claude-haiku-5-5`, 생각 끔, 공식 `anthropic` SDK — `collector/requirements-ai.txt`)가 먼저이고, 키가 없거나 한도에 닿았거나 오류면 Gemma, 둘 다 안 되면 규칙 문장.
  저장소 Secret `ANTHROPIC_API_KEY`(Anthropic Console 키)가 있어야 켜진다. 사용자 결정으로 이 사이트는 클로드를 **누적 150달러**까지만 쓰고(하루 안전장치 3달러, 한국 날짜), 닿으면 자동으로 Gemma 로 돌아간다. 장부는 `data/claude_usage.json`(Actions 캐시로 이어지고 사이트에도 올라가 설정 화면에 보임 · 캐시가 사라지면 공개 사이트의 장부로 이어 씀 · 둘 다 못 읽으면 그 실행은 클로드를 쉼).
  Console 조직은 야구 게임과 같이 쓴다(조직 크레딧 200달러, 야구는 자체 장부로 180달러 제한). 이 장부는 **마켓 사이트 사용분만** 세므로 Console 의 사용액과 다르다.
- **관심종목**: 각 기기의 브라우저에 저장 (설정 → 백업 코드로 다른 기기에 옮김).

## 로컬 개발

```
cd web
npm install
npm run dev                         # http://127.0.0.1:5173
npm test                            # 지표 계산이 Python 과 같은지 (tools/fixture.json 필요: py tools/make_fixture.py)
npm run build                       # 타입검사 + 빌드 → web/dist
```

- 개발 중 주식·속보 데이터는 로컬 중계기로: `py tools/dev_relay.py` (8787) 를 켜고 `http://127.0.0.1:5173/?relay=http://127.0.0.1:8787`
- 휴대폰 폭 미리보기: `http://127.0.0.1:5173/dev/frame.html?w=390&h=844&relay=http://127.0.0.1:8787#/market`
- 데이터 만들기: `py collector/collect.py --limit 20` (→ `web/public/data`)

## 데이터 출처

업비트 · 바이낸스 공개 API, 네이버 증권, 야후 파이낸스(미국 주식 분봉), 코인니스 속보, Google 뉴스 RSS. 뉴스는 제목·짧은 요약·원문 링크만 보여 준다.
기술적 신호와 예측, AI 판단은 과거 데이터와 기사 문장에 기반한 참고 자료일 뿐 투자 권유가 아니다.
