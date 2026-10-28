// 펌핑 후보 (collector/pump.py) — pump.json(실행마다) · pump_stats.json(하루 1번 과거 검증) · pump_log.json(실제 신호 기록)
// 값은 모두 분수(0.091 = 9.1%). 점수 0~100 = 펌핑 확률이 과거 표본 밖 예측 중 몇 % 보다 높은지.
import { staticJSON } from './staticData';

export type PumpGroup = 'energy' | 'profile' | 'value' | 'volume' | 'chart' | 'vol' | 'heat' | 'own' | 'market';

/** 영역 — 앞 5개가 화면에 막대로 늘 보이고, 나머지는 펼치면 보인다 */
export const PUMP_GROUPS: { key: PumpGroup; label: string; hint: string; main: boolean }[] = [
  { key: 'energy', label: '응축된 에너지', hint: '볼린저밴드 폭·ATR 이 최근 120일 중 얼마나 좁은지, 좁은 상태가 며칠째인지', main: true },
  { key: 'profile', label: '매물대', hint: '최근 120일 가격대별 거래량 — 위쪽에 쌓인 물량, 가장 많이 거래된 가격과의 거리, 매물이 얇은 구간', main: true },
  { key: 'value', label: '거래대금 추세', hint: '5일·20일·60일 거래대금 비율, 20일 기울기, 거래대금 순위와 그 변화', main: true },
  { key: 'volume', label: '거래량 패턴', hint: '거래량 급증 뒤 가격 버팀, 오른 날·내린 날 거래대금 흐름(OBV)', main: true },
  { key: 'chart', label: '차트', hint: '고점·저점까지 거리, 이동평균 배열, 저점 높이기', main: true },
  { key: 'vol', label: '변동성', hint: '하루 평균 변동폭(ATR)·표준편차 — 클수록 위아래로 크게 움직여요', main: false },
  { key: 'heat', label: '최근 흐름', hint: 'RSI·최근 1~30일 수익·30일 고점에서 내려온 정도', main: false },
  { key: 'own', label: '이 코인 성향', hint: '이 코인이 평소 3일 안에 얼마나 크게 올랐는지, 최근 펌핑 횟수', main: false },
  { key: 'market', label: '시장 분위기', hint: '업비트 전체의 최근 펌핑 비율·거래대금·비트코인 흐름 (모든 코인에 같게 들어가요)', main: false },
];
export const PUMP_GROUP_LABEL = Object.fromEntries(PUMP_GROUPS.map((g) => [g.key, g.label])) as Record<PumpGroup, string>;

export interface PumpReason { k: string; g: PumpGroup | 'notice'; t: string; tone: 'up' | 'down' | 'flat'; w?: number }
/** lv 1 = 주의, 2 = 높음. chip === false 면 위험 칸에만 (목록 칩으로는 안 보임) */
export interface PumpRisk { k: string; lv: 1 | 2; t: string; chip?: boolean }
/** 매물대 그림 — lo~hi 를 로그 간격 b.length 칸으로 나눈 거래대금(0~100), poc = 가장 큰 칸, cur = 기준 시각 가격 */
export interface PumpVp { lo: number; hi: number; b: number[]; poc: number; cur: number }
export interface PumpItem {
  /** cand = 후보 점수(0~100, 급락 위험 반영 = '펌핑 확률 − wNet × 급락 확률'의 과거 백분위) — 화면의 큰 숫자·기본 순서(rankNet).
   *  score = 펌핑 점수(급락 위험 반영 전, 순서는 rank). d24·hist 는 후보 점수, d24p·histP 는 펌핑 점수 */
  code: string; sym: string; name: string; en?: string; rank: number; rankNet: number; net: number;
  cand: number; d24: number | null; score: number; d24p: number | null;
  /** 72시간 안 최고 상승폭 10·50·90% */
  mfe: [number, number, number];
  /** 72시간 뒤 종가 수익 10·50·90% */
  r72: [number, number, number];
  r24: number | null; pPump: number; pDump: number; own: number | null;
  price: number; val24: number | null; chg24: number | null;
  parts: Partial<Record<PumpGroup, number>>; reasons: PumpReason[]; risks: PumpRisk[]; riskLv: 0 | 1 | 2;
  /** 점수 이력 — 14일 × 1시간, 오래된 것부터 (빈 시간 null) */
  /** 점수 이력 — 14일 × 1시간, 오래된 것부터, 쉼표로 이은 글자 (빈 칸 = 값 없음). parseHist 로 푼다 */
  hist: string | (number | null)[];
  histP: string | (number | null)[];
  /** ai = 한두 문장 설명, aiBy = 'claude' · 'gemma' · 'ai'(AI 가 씀) 또는 'rule'(규칙 문장) */
  vp: PumpVp | null; stale?: boolean; anchor: number; ai?: string; aiBy?: string;
}
/** 전 종목 요약 [코드, 이름, 후보 점수, 펌핑 점수, 3일 안 최고 중앙값, 3일 뒤 중앙값, 펌핑 확률, 급락 확률, 위험 단계, 24시간 거래대금] */
export type PumpRow = [string, string, number, number, number | null, number | null, number | null, number | null, number, number | null];
export interface PumpBase { n: number; pump: number; dump: number; medMfe: number; medR24: number; medR72: number }
export interface PumpBucket {
  lo: number; hi: number; name: string; n: number; coins?: number; pump?: number; dump?: number; lift?: number; dumpLift?: number;
  medMfe?: number; predMfe?: number; medR24?: number; medR72?: number; meanR72?: number; win72?: number;
}
export interface PumpData {
  version: number; updatedAt: string; asOf: string | null; asOfKst?: string;
  def?: { h: number; pump: number; dump: number; fee: number; sigThr: number };
  model?: { trainedAt?: string; dataTo?: string; rows?: number };
  count?: number; items: PumpItem[]; all: PumpRow[];
  young: { code: string; name: string; days: number; val24: number | null }[];
  market?: Partial<Record<'mkt_pump3' | 'breadth' | 'mkt_ret1' | 'mkt_ret3' | 'btc_ret1' | 'btc_ret7' | 'mkt_atr', number | null>>;
  /** top = 후보 점수 90 이상의 과거 성적, topPump = 펌핑 점수 90 이상 */
  summary?: { verdict?: PumpVerdict; lines: string[]; base?: PumpBase | null; top?: PumpBucket | null; topPump?: PumpBucket | null; orders?: PumpOrderStat | null };
  /** '이럴 땐' 경고 — 시장에 펌핑이 잦은 때(hot) · 비트코인 7일 하락(btcDown)이면 warn. stats = 과거 같은 국면의 상위 5개 성적 */
  regime?: { hot: boolean; btcDown: boolean; warn: boolean; mktPump7: number | null; thr: number | null; btc7: number | null; stats: PumpRegimeStat[] };
  /** 급락 위험 뺀 순 = 펌핑 확률 − wNet × 급락 확률 */
  wNet?: number;
  note?: string;
}
export type PumpVerdict = 'ok' | 'weak' | 'none';
export interface PumpCompareRow {
  key: string; name: string; auc: number | null; dailyAuc: number | null; top10Pump: number | null; lift: number | null;
  top10Dump: number | null; top10R72: number | null; n: number; note?: string;
}
export interface PumpCalibRow { lo: number; hi: number; n: number; pred: number; act: number; mean?: number; pump?: number }
export interface PumpSignalRule {
  thr: number; n: number; coins: number; pump: number; dump: number; medMfe: number; predMfe: number; medR72: number; medR24: number; win72: number;
}
/** 목록 정렬 비교 — 날마다 상위 k 개를 펌핑 점수 순(score) / 급락 위험 뺀 순(net)으로 골랐다면. ex = 같은 날 전 종목 중앙값 대비 3일 수익 */
export interface PumpOrderSide { n: number; pump: number; dump: number; medMfe: number; medR72: number; ex: number }
export interface PumpOrderStat { k: number; score: PumpOrderSide; net: PumpOrderSide; exDiff?: number; exDiffCi?: [number, number] }
export interface PumpRegimeStat { key: 'hot' | 'btcdown' | 'calm'; name: string; days: number; score: PumpOrderSide & { medR72: number }; net: PumpOrderSide & { medR72: number } }
export interface PumpStats {
  version: number; updatedAt: string; from: string; to: string; holdFrom: string;
  def: { h: number; pump: number; dump: number; fee: number; sigThr: number };
  data: { coins: number; rows: number; from: string; to: string };
  /** buckets = 펌핑 점수 구간, bucketsCand = 후보 점수 구간 */
  base: PumpBase; buckets: PumpBucket[]; bucketsCand: PumpBucket[];
  recent: { from: string; base: PumpBase; buckets: PumpBucket[]; bucketsCand: PumpBucket[] } | null;
  calib: {
    mfe: PumpCalibRow[]; r72: PumpCalibRow[]; pump: PumpCalibRow[]; dump: PumpCalibRow[];
    cover80: number; coverMfe80: number; mfeIc: number; r72Ic: number; mfeSkill: number; r72Skill: number;
  };
  risk: Partial<Record<'heat' | 'thin' | 'thin10' | 'dumpHi', { name: string; n: number; pump: number; dump: number; medR72: number }>>;
  signalRule: PumpSignalRule[];
  orders?: PumpOrderStat[];
  regimes?: PumpRegimeStat[];
  compare: { all: PumpCompareRow[]; recent: PumpCompareRow[]; from: string };
  events: { suspend?: { n: number; pump: number; pred: number; dump: number; predDump: number } } | null;
  verdict: PumpVerdict; lines: string[]; method: string[]; limits: string[];
}
export interface PumpLogItem {
  /** score = 후보 점수(신호 기준), pumpScore = 그때 펌핑 점수 */
  code: string; name: string; t: number; seen: number; price: number; score: number; pumpScore?: number;
  mfe: [number, number, number]; r72: [number, number, number]; pPump: number; pDump: number;
  status: 'wait' | 'done' | 'na';
  res?: { mfe: number; mae: number; r72: number; r24: number | null; kind: 'pump' | 'dump' | 'both' | 'none' };
}
export interface PumpLog {
  version: number; updatedAt: string; thr: number; items: PumpLogItem[];
  summary: { n: number; graded: number; pump?: number; dump?: number; medR72?: number; medMfe?: number; predMfe?: number };
  backtest: PumpSignalRule | null;
}

export const pumpData = () => staticJSON<PumpData>('pump.json', 3 * 60e3);
export const pumpStats = () => staticJSON<PumpStats>('pump_stats.json', 30 * 60e3);
export const pumpLog = () => staticJSON<PumpLog>('pump_log.json', 5 * 60e3);

/** 업비트 거래 화면 (새 창) */
export const upbitUrl = (code: string) => `https://upbit.com/exchange?code=CRIX.UPBIT.${code}`;
/** 점수 이력 글자 → 배열 ('94,95,,96' → [94, 95, null, 96]) */
export function parseHist(h: string | (number | null)[] | null | undefined): (number | null)[] {
  if (!h) return [];
  if (Array.isArray(h)) return h;
  return h.split(',').map((x) => (x === '' ? null : Number(x)));
}
/** 'KRW-BTC' → 'BTC' */
export const tickerOfCode = (code: string) => code.replace(/^KRW-/, '');
