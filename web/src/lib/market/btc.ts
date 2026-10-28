// 비트코인 카드 데이터 — collector/btc_forecast.py 가 수집할 때마다 만드는 data/btc.json (작은 정적 파일, 중계 요청 없음)
// 변화율(med·lo·hi·actual)은 모두 분수(0.012 = +1.2%), 가격은 원.
import { staticJSON } from './staticData';

export const BTC_SYM = 'upbit:KRW-BTC';
export const UPBIT_BTC_URL = 'https://upbit.com/exchange?code=CRIX.UPBIT.KRW-BTC';

/** 방향 예측력 — 과거 검증(지난 1년) 기준: none 동전 던지기 수준 · weak 약함 · some 조금 있음 */
export type BtcEdge = 'none' | 'weak' | 'some';

export interface BtcHorizon {
  h: 24 | 1;
  /** 이 시각의 가격을 예상 (기준 시각 + h 시간) */
  target: string;
  /** 예상 변화율 (중앙값) */
  med: number;
  /** 10번 중 8번 범위 (10%·90%) */
  lo: number;
  hi: number;
  medPrice: number;
  loPrice: number;
  hiPrice: number;
  /** 오를 확률 */
  pUp: number;
  /** '거의 반반이에요' · '오를 쪽이 아주 조금 커요' … */
  lean: string;
  edge: BtcEdge;
}

export interface BtcPivotEvidence {
  /** 이 선 위에 있었을 때 / 아래였을 때 다음 24시간 오른 비율 (긴 기간) */
  above: number;
  below: number;
  /** 같은 것, 최근 2년만 */
  above2y: number | null;
  below2y: number | null;
  /** 근거 기간 시작 (YYYY-MM-DD) · 하루 1번 표본 수 */
  from: string;
  days: number;
}

export interface BtcPivot {
  price: number;
  kind: string;
  /** '30일 평균' 같은 짧은 이름 · desc 는 풀어 쓴 설명 */
  label: string;
  desc: string;
  side: 'above' | 'below';
  /** 지금 기준 가격이 갈림길보다 얼마나 위(+)/아래(−) */
  dist: number;
  /** 24시간 범위(10번 중 8번) 안에 있는지 — 밖이면 하루 안에 닿기 어렵다 */
  inRange: boolean;
  ev: BtcPivotEvidence | null;
}

export interface BtcScored {
  t: string;
  price: number;
  m: number | null;
  lo: number | null;
  hi: number | null;
  pUp: number | null;
  actual: number | null;
  actualPrice: number | null;
  /** null = 예상이 0(반반)이라 방향을 말하지 않았음 */
  dirHit: boolean | null;
  inRange: boolean | null;
}

export interface BtcLive {
  since: string | null;
  days: number;
  n: number;
  dir: [number, number];
  range: [number, number];
  h1: { n: number; dir: [number, number]; range: [number, number] };
  recent: { t: string; m: number | null; a: number | null; lo: number | null; hi: number | null }[];
}

export interface BtcBtStat {
  /** 방향 맞힘 비율 · [맞힘, 방향을 말한 횟수] */
  hit: number;
  dir: [number, number];
  /** 범위(10번 중 8번) 안에 든 비율 · [안, 전체] */
  cov: number;
  range: [number, number];
  /** 브라이어 개선 (늘 50% 라고 했을 때보다 확률이 얼마나 나았나, 분수 — 0 이하면 나을 게 없음) */
  bss: number;
  auc: number | null;
  /** 실제로 오른 비율 (기준선) */
  upRate: number;
  /** 평균 범위 폭 */
  width: number;
}

export interface BtcCalibRow { pred: number; actMed: number; actMean: number; up: number; n: number }

export interface BtcBacktest {
  trainedAt: string;
  from: string;
  to: string;
  /** 24시간: 지난 1년, 매일 오전 9시(한국) 기준 예측 1개씩 */
  h24: BtcBtStat;
  /** 1시간: 지난 1년 매시간 */
  h1: BtcBtStat;
  /** 되짚어 본 최근 30일 (24시간, 매일 1번) */
  d30: { dir: [number, number]; range: [number, number] };
  /** 예상 % 구간별 실제 (지난 1년 24시간) — 보정 확인 */
  calib24: BtcCalibRow[];
  slope24: number | null;
  calib1: BtcCalibRow[];
  slope1: number | null;
  /** 2021년부터 긴 기간 */
  long: { from: string; h24: BtcBtStat; h1: BtcBtStat } | null;
  model24: string;
  model1: string;
}

export interface BtcData {
  version: 1;
  updatedAt: string;
  /** 기준 시각 (끝난 시간봉의 끝, 정각) */
  asOf: string;
  price: number;
  /** 최근 48시간 종가 (1시간마다) */
  spark: number[];
  h24: BtcHorizon;
  h1: BtcHorizon;
  pivot: BtcPivot | null;
  /** 결론 — by: ai(provider: 클로드·Gemma) | rule(숫자로 정한 규칙 문장) · at: 쓴 시각 */
  summary: { text: string; by: 'ai' | 'rule'; provider?: 'claude' | 'gemma' | 'ai'; at: string };
  yesterday: BtcScored | null;
  live: BtcLive;
  backtest: BtcBacktest | null;
  note?: string | null;
}

export const btcForecast = () => staticJSON<BtcData>('btc.json', 2 * 60e3);

// ── 1시간 뒤 예상: 브라우저 계산용 (components/btc/h1.ts) ─────────────────
/** LightGBM 나무 하나 — f 나눌 특징 번호, t 기준값, d 빈 값이면 왼쪽(1), m 빈 값 종류(0 없음·1 0·2 NaN), l·r 자식(음수 = ~잎), v 잎 값 */
export interface BtcTree { f: number[]; t: number[]; d: number[]; m: number[]; l: number[]; r: number[]; v: number[] }
/** data/btc_h1.json — 하루 1번 학습한 1시간 계수 (약 40KB) */
export interface BtcH1Model {
  version: 1;
  trainedAt: string;
  cols: string[];
  trees: BtcTree[];
  platt: { a: number; b: number };
  /** 잔차(변동성 단위) 분위표: ep 확률 눈금 → eq 값 (가운데 0) */
  ep: number[];
  eq: number[];
  /** 10%·90% 잔차 분위와 적응(ACI) 배율 */
  lo: number;
  hi: number;
  scale: number;
  /** GJR-GARCH(1,1)-t [ω, α, γ, β, ν] (시간대 배율로 나눈 % 수익) · 봉 시작 한국 시각별 배율 24개 */
  garch: { p: number[]; seasBar: number[] };
  backtest?: { hit: number; bss: number; cov: number; auc: number | null; longHit?: number; longBss?: number; from?: string; to?: string } | null;
}
export const btcH1Model = () => staticJSON<BtcH1Model>('btc_h1.json', 30 * 60e3);

/** 업비트 60분봉 응답 한 줄 */
export interface UpbitHourRaw { candle_date_time_utc: string; opening_price: number; high_price: number; low_price: number; trade_price: number; candle_acc_trade_price: number }
/** 업비트 원화 비트코인 60분봉 200개 — 브라우저에서 직접 (중계 안 거침). 업비트 브라우저 요청 한도(분당 6회)에 걸리면
 *  CORS 헤더 없는 429 라 TypeError 로 보이므로 15초 쉬고 두 번까지 다시 */
export async function upbitHours200(): Promise<UpbitHourRaw[]> {
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await fetch('https://api.upbit.com/v1/candles/minutes/60?market=KRW-BTC&count=200', { cache: 'no-store' });
      if (!r.ok) throw Object.assign(new Error(`업비트 ${r.status}`), { status: r.status });
      return (await r.json()) as UpbitHourRaw[];
    } catch (e) {
      const st = (e as { status?: number }).status;
      if (attempt >= 2 || (st && st !== 429 && st < 500)) throw e;
      await new Promise((res) => setTimeout(res, 15_000));
    }
  }
}
