"""비트코인 카드 (collector/btc_forecast.py) 부품

core.py   표준 라이브러리만 — 시간봉 받기 · 특징 · 저장된 모델 적용 · 갈림길 · 숫자 표기 (매 실행)
models.py numpy·lightgbm — 모델 후보(기준선·리지·로지스틱·LightGBM·섞기) 학습과 JSON 내보내기 (하루 1번)
train.py  긴 이력 갱신 → 워크포워드 검증(엠바고) → 채택 모델 학습 → data/btc_model.json
score.py  예측 기록(data/btc_log.json) 쌓기 · 채점 · 화면용 성적 요약
text.py   결론 문장 (클로드 ai.write → 실패하면 규칙 문장) · 금지어·숫자 검사
"""
