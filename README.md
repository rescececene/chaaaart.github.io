# 마켓렌즈

코인(업비트·바이낸스)과 주식(국내·미국)의 실시간 시세·호가, 차트 기술적 분석, AI 순위 예측(유망 종목), 종목 골라보기, 호재·악재가 표시되는 속보를 한 화면에서 보는 웹사이트. PC·휴대폰 모두 지원. 주문 기능은 없다(보기 전용).

공개 주소: https://rescececene.github.io/chaaaart.github.io/

## 구조

| 부분 | 하는 일 | 위치 |
|---|---|---|
| 사이트 | React 19 + TypeScript + Vite + Tailwind + shadcn/ui. 서버 없이 브라우저에서 동작 | `web/` → GitHub Pages |
| 수집기 | 10분마다 전 종목 일봉 지표(종목 골라보기)·뉴스·지연 시세·종목별 일봉 파일 생성 | `collector/collect.py` → GitHub Actions |
| 뉴스 AI | 코인·주식 속보의 호재·악재를 판단 (Cloudflare Workers AI · Gemma 4, 무료 사용량 안에서) | `collector/news_ai.py` → GitHub Actions |
| 예측 엔진 | 하루 한 번 장기 일봉으로 순위 모델 학습 + 워크포워드 백테스트 + 유사 패턴 → `predict/*.json` | `collector/model/` → GitHub Actions |
| 중계 Worker | 브라우저에서 직접 못 부르는 네이버 증권·업비트 REST·야후·코인니스를 대신 호출 | `worker/worker.js` → Cloudflare |

- **코인 시세·호가**: 업비트·바이낸스 웹소켓에서 직접 실시간. 두 거래소에 모두 있는 코인은 하나로 보이고 거래소는 탭으로 고른다.
- **주식 시세**: Worker 를 거쳐 네이버 실시간 시세를 2.5초마다(시장 전체 목록은 5초), 국내 호가 5단계 1.5초마다. Worker 가 없으면 10~20분 지연 데이터.
- **중계 아끼기**: Cloudflare 무료 플랜은 계정 전체 하루 10만 건(넘으면 오전 9시까지 멈춤). 그래서 화면이 숨겨지면 멈추고, 장이 닫혔거나 15분 넘게 조작이 없으면 30초마다 받는다(화면을 움직이면 바로 실시간). 기기마다 하루 4만 건을 넘기면 같은 절약 모드로 바뀐다.
- **Worker 접근**: `https://rescececene.github.io` 에서 온 요청(Origin)만 허용 — 사이트에 비밀값이 없다. Secret `ACCESS_KEY`(`?k=`)는 개발·다른 도구용 예비 수단.
  `worker/worker.js` 를 고치면 Cloudflare 편집기에 다시 붙여넣고 Deploy 해야 한다 (Actions 는 Worker 를 배포하지 않음).
- **뉴스 AI**: GitHub Actions 가 Cloudflare Workers AI REST 를 직접 부른다(중계 Worker 와 무관). 저장소 Secret `CF_ACCOUNT_ID`, `CF_AI_TOKEN`(대시보드 Workers AI → REST API 사용 → Workers AI API 토큰 만들기)이 있어야 켜지고, 없으면 투표·키워드 판단만 한다.
  하루 8,000 뉴런 어림에서 스스로 멈춘다(무료 1만, 넘어도 무료 플랜은 요금 없이 그날만 실패). 해외 속보는 판단하지 않는다. 결과는 `data/news_ai.json`.
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
