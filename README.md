# 마켓렌즈

코인(업비트·바이낸스)과 주식(국내·미국)의 실시간 시세, 차트 기술적 분석, 스크리너, 포트폴리오, 가격 알림을 한 화면에서 보는 웹사이트. PC와 휴대폰 모두 지원.

## 구조

| 부분 | 하는 일 | 위치 |
|---|---|---|
| 사이트 | 화면 전체. 서버 없이 브라우저에서 동작 | `site/` → GitHub Pages |
| 수집기 | 10분마다 전 종목 일봉 지표를 계산해 스크리너·뉴스 데이터 생성 | `collector/` → GitHub Actions |
| 중계 Worker | 브라우저에서 직접 못 부르는 네이버 증권 등을 대신 호출 | `worker/worker.js` → Cloudflare |

- **코인 시세**: 업비트·바이낸스 WebSocket에서 직접 실시간
- **주식 시세**: Worker를 거쳐 네이버 증권 실시간 시세를 5초마다 (Worker가 없으면 10~20분 지연 데이터)
- **관심종목·보유자산·알림**: 각 기기의 브라우저에 저장. 설정 → 백업 코드로 다른 기기에 옮김
- **알림**: 사이트가 열려 있는 동안 10초마다 검사

## 설정 (완료됨)

1. **GitHub Pages** — 저장소 Settings → Pages → Source: **GitHub Actions**
2. **Worker** — `https://market-relay.get943.workers.dev` 에 `worker/worker.js` 를 배포. 사이트(`site/js/data.js` 의 `DEFAULT_RELAY`)가 이 주소를 기본으로 쓴다.
   - Worker는 `https://rescececene.github.io` 에서 온 요청(Origin 헤더)만 받으므로 사이트에는 비밀값이 없다. 다른 웹사이트는 브라우저가 Origin을 바꿀 수 없어 이 Worker를 못 쓴다.
   - Cloudflare의 Secret `ACCESS_KEY` 는 로컬 개발·다른 도구용 예비 수단 (`?k=키`).
   - `worker/worker.js` 를 고치면 Cloudflare 편집기에 다시 붙여넣고 Deploy 해야 반영된다 (GitHub Actions는 Worker를 배포하지 않음).
3. 관심종목·보유자산·알림은 기기마다 브라우저에 저장 — 설정 → 백업 코드로 옮긴다.

## 로컬에서 실행

```
py collector/collect.py --limit 20     # site/data 생성 (시장별 20종목만, 빠른 확인)
py tools/dev_relay.py                  # http://localhost:8787 — 사이트 + Worker 와 같은 중계
```

브라우저에서 `http://localhost:8787/?relay=http://localhost:8787` 로 열면 로컬 중계가 자동 연결된다.

지표 계산(Python ↔ JS) 일치 검사: `py tools/make_fixture.py` 후 `py -m http.server 8790` 을 켜고 `http://localhost:8790/tools/test_indicators.html`

## 데이터 출처

업비트 · 바이낸스 공개 API, 네이버 증권, 야후 파이낸스(미국 주식 분봉), Google 뉴스 RSS. 기술적 신호는 참고용이며 투자 권유가 아니다.
