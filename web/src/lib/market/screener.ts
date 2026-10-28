// 스크리너·수집 상태·예측 결과 (GitHub Actions 산출물)
import { split } from './core';
import { safeCode } from './candles';
import { staticJSON } from './staticData';
import type { Market, ScreenerData, StockAi, Sym } from './types';

export const screener = (market: Market) => staticJSON<ScreenerData>(`screener/${market}.json`, 3 * 60e3);
export const collectMeta = () => staticJSON<{ updatedAt: string; secs: number; errors: Record<string, string> }>('meta.json', 3 * 60e3);

// ── 예측 (collector/model/run.py 가 하루 한 번 만드는 predict/*.json) ──
export interface PredictReason { text: string; tone: 'up' | 'down' | 'flat' }
/** 검증 등급 — 과거 데이터로 되돌려 확인한 결과 (poor = 참고 낮음) */
export type OutlookGrade = 'good' | 'weak' | 'poor';
/** 모델 검증 등급 — strong = 전체·뒤쪽 절반 모두 뚜렷 · weak = 약함 · none = 근거 없음 */
export type ModelGrade = 'strong' | 'weak' | 'none';
/** 시장 대비 초과수익 분포 (과거 같은 점수 구간 종목들이 실제로 낸 값, 분수) */
export interface ExpEx { q10: number; q50: number; q90: number; n: number; h?: number; unit?: string }
/** 이 자리에서 사면 — 1시간(unit 'h', src 'hourly') · 1일 · 1주. 지금과 비슷했던 과거 자리 실제 결과의 분포 */
export interface OutlookItem {
  h: number; unit?: 'h' | 'd'; label: '단기' | '중기' | '장기'; n: number;
  q10: number | null; q50: number | null; q90: number | null; win: number | null;
  base: { q50: number; win: number } | null; grade: OutlookGrade; reason?: string; asOf?: string; src?: string;
}
export interface OutlookCheck {
  h: number; unit?: 'h' | 'd'; periods: number; n: number; coverage: number; dirHit: number; baseDirHit: number;
  calib: { p: number; actual: number; n: number }[]; calibErr: number; calibSlope: number; brierSkill: number; grade: OutlookGrade;
}
/** 'H 뒤 예상 %' 검증 등급 — good: 0% 예상보다 잘 맞고 보정·범위·순위가 괜찮음 · weak: 0% 보다 조금 나음 · poor: 0% 라고 하는 것보다 못함 */
export type FcGrade = 'good' | 'weak' | 'poor';
/** 'H 뒤 예상 %'(절대 수익, 분수) — mid 예상 · lo~hi 10번 중 8번 · mkt 그 시장 전체(가운데 종목) 예상 · edge = mid − mkt (다른 종목보다 나을 몫) */
export interface ExpRet {
  h: number; unit?: string; label?: string; mid: number; lo: number; hi: number; mkt?: number | null; edge?: number | null;
  grade?: FcGrade | null; how?: string | null;
}
/** 빼지 않고 붙이는 '주의' — k: heat 과열 · down 하락 경고 · jump/drop 기준가 뒤 급변동 · thin 거래가 적어요 · listing 막 상장 · badnews · hacknews */
export interface Caution { k: string; t: string }
/** 예상 % 의 표본 밖 성적 (collector/model/expret.py evaluate) — 값은 분수 */
export interface ExpEval {
  n: number; days: number; mse: number; mseZero: number; mae: number; bias: number; biasMed: number; slope: number; slopeClip: number;
  dirHit: number | null; upShare: number | null; ic: number | null; icT: number | null; binErr: number;
  bins: { pred: number; mean: number; median: number; n: number }[];
  coverage?: number; coverageByVol?: number[]; pinLo?: number; pinHi?: number;
  top5?: { n: number; pred: number; act: number; mkt: number; ex: number; exMed?: number; exAfterCost?: number; beat: number; mae: number; bias: number;
    inRange: number | null; dirHit: number | null; growth?: number; uniGrowth?: number; mdd?: number; uniMdd?: number };
}
export interface ExpCheck {
  method: string; block: number; h: number; from: string; to: string; holdFrom: string; all: ExpEval | null; hold: ExpEval | null;
  recent: { d: string; end: string; pred: number; act: number; mkt: number; mktMed: number; inRange: number | null }[];
  grade?: FcGrade; level?: number | null; mktMid?: number | null; range?: Record<string, number>;
}
/** 점수 = '시장 이길 확률×100' (null 이면 hold — 판단 보류). pctRank = 시장 안 백분위(100 = 1등) */
export interface PredictScoreFields {
  score: number | null; probBeat?: number | null; pctRank?: number | null; grade?: ModelGrade; hold?: boolean; expEx?: ExpEx | null;
}
export interface PredictPick extends PredictScoreFields {
  sym: Sym; name: string; sub: string; rank: number; probUp: number | null;
  q10: number | null; q50: number | null; q90: number | null;
  reasons: PredictReason[]; spark: number[]; analog: { n: number; winRate: number; avg: number } | null;
  outlook?: { h: number; unit?: 'h' | 'd'; label: string; q50: number | null; win: number | null; grade: OutlookGrade }[];
  /** 'H 뒤 예상 %' · 쉬운 말 이유 1~2줄 · 금·비트코인 등에 묶인 토큰이면 그 이름 */
  expRet?: ExpRet | null; why?: PredictReason[]; peg?: string;
  rec?: { close: number; atr: number | null; lo20: number | null; dvPct: number | null; volPct: number | null; obs: number; heat: boolean; down: boolean };
}
export interface PredictBacktest {
  from: string; to: string; periods: number; rankIC: number | null; icIR: number | null; icPositiveRate: number | null;
  topExcess: number | null; topHitRate: number | null; equity: { t: string; top: number; all: number; topMin?: number; topMax?: number }[];
  /** strong = 전체·뒤쪽 절반 모두 통계적으로 뚜렷 · weak = 약함 · none = 효과 없음 */
  verdict?: ModelGrade; tStat?: number | null; topExcessLog?: number | null; bottomExcess?: number | null;
  heldOut?: Record<string, unknown>; dev?: Record<string, unknown>; regime?: Record<string, unknown>; grids?: unknown; randomTop?: Record<string, unknown>; basis?: string;
}
/** 추천 규칙(상위 최대 5개)을 과거에 그대로 적용한 성적 — 값은 분수 (ex 0.0034 = 회당 +0.34%p) */
export interface RecStats {
  ex: number; exMed?: number; exAfterCost?: number; win: number; mdd: number; uniMdd: number; growth: number; uniGrowth: number;
  periods: number; avgPicks?: number; empty?: number; downEx?: number; upEx?: number; t?: number;
}
export interface RecBacktest { h: number; from: string; to: string; holdFrom: string; rule?: string; desc?: string; all: RecStats; hold: RecStats | null }
export interface PredictMarket {
  asOf: string; horizon: number; universe: number;
  model: { kind: string; trainedAt: string; trainRows: number; features: number };
  backtest: PredictBacktest; notes: string[]; picks: PredictPick[]; avoid: PredictPick[];
  grade?: ModelGrade; recBacktest?: RecBacktest | null;
  /** mkt20 = 시장 전체 20일 수익률 · breadth = 20일 이동평균 위 종목 비율 */
  regime?: { mkt20: number | null; breadth: number | null } | null;
  /** 'H 뒤 예상 %' 의 워크포워드 검증 · 날짜별 시장 전체 H 수익(채점용) · 순위 목록에서 뺀 묶인 토큰 */
  expCheck?: ExpCheck | null; mktRet?: { d: string; end: string; mean: number; med: number; n: number }[];
  pegged?: { sym: Sym; name: string; peg: string; pctRank: number }[];
}
export interface PredictSummary {
  version: number; updatedAt: string; markets: Partial<Record<Market, PredictMarket>>;
  outlookBacktest?: Partial<Record<Market, Partial<Record<'단기' | '중기' | '장기', OutlookCheck | null>>>>;
}
export interface PredictSymbol extends PredictScoreFields {
  sym: Sym; name: string; sub: string; asOf: string; horizon: number;
  rank: number; of: number; probUp: number | null; q10: number | null; q50: number | null; q90: number | null;
  cone: { d: number; q10: number; q50: number; q90: number }[];
  reasons: PredictReason[];
  contrib: { key: string; label: string; value: number; impact: number }[];
  analogs: { start: string; end: string; corr: number; fwdRet: number; path: number[] }[];
  analogStats: { n: number; winRate: number; avg: number; median: number } | null;
  outlook?: OutlookItem[];
}
/** 1시간 예측 — 매시간 새로 (predict/hourly/<시장>.json). items 의 키는 sym 의 코드 부분 (KRW-XRP · 005930 · NVDA.O · BTCUSDT) */
export interface PredictHourly {
  version: number; market: Market; updatedAt: string; asOf: string; nextBarAt: string; h: number; unit: 'h';
  grade: OutlookGrade; backtest: OutlookCheck | null; note?: string; reason: string | null;
  items: Record<string, { n: number; q10: number | null; q50: number | null; q90: number | null; win: number | null }>;
}
export const predictHourly = (market: Market) => staticJSON<PredictHourly>(`predict/hourly/${market}.json`, 5 * 60e3);

// ── 추천 묶음 (collector 가 10분마다 다시 고르는 recommend.json) ──
export type RecGroupKey = 'coin' | 'krx' | 'us';
export interface RecItem {
  sym: Sym; name: string; sub: string; market: Market; score: number; probBeat: number; pctRank: number;
  expEx: ExpEx & { h: number; unit: string }; grade: ModelGrade; gradeLabel: string;
  reasons: PredictReason[]; risks: string[]; price: number | null; stop: number | null; stopPct: number | null; asOf: string; spark: number[];
  /** 새 필드 — 'H 뒤 예상 %'(label 예: '24시간'·'20거래일'), 주의 표시, (코인 상위 5개) AI 한 문장 */
  expRet?: (ExpRet & { label: string; unit: string }) | null; cautions?: Caution[]; ai?: string;
}
export interface Recommend {
  version: number; updatedAt: string;
  groups: Partial<Record<RecGroupKey, { label: string; items: RecItem[] }>>;
  notes: string[];
  backtest: Partial<Record<Market, RecBacktest>>;
  excluded?: Partial<Record<Market, { sym: Sym; why: string }[]>>;
}
export const recommend = () => staticJSON<Recommend>('recommend.json', 4 * 60e3);

// ── 순위 (collector/recommend.py 가 매 실행 만드는 rank.json · rank_top.json, 채점은 picks_log.json) ──
/** 순위 한 줄 — pct 점수 백분위(100 = 1등) · mid/lo/hi 'H 뒤 예상'·10번 중 8번 · base 기준가(엔진 기준일 종가) · price 수집 때 가격 · pb 시장 이길 확률 */
export interface RankItem {
  sym: Sym; name: string; sub: string; rank: number; pct: number | null; mid: number | null; lo: number | null; hi: number | null;
  edge: number | null; base: number | null; price: number | null; move: number | null; pb?: number | null; score?: number | null;
  why: string[]; ai?: string; cau: Caution[]; spark?: number[];
}
/** 채점 — real 실제 기록 최근 30회 · last 가장 최근 채점된 하루 · past 엔진 워크포워드로 되짚어 본 최근 30회(실제 기록 아님) */
export interface PickStats { n: number; from: string; to: string; win: number; avg: number | null; pred: number | null; mkt: number | null; mktMed?: number | null; mae: number | null; inRange: number | null; dirHit: number | null }
export interface PickLast {
  d: string; end: string; pred: number | null; avg: number; mkt: number | null; mktMed?: number | null; win: boolean; inRange: number | null;
  items?: { sym: Sym; name: string; mid: number | null; ret: number | null }[];
}
export interface PastStats { n: number; from: string; to: string; pred: number; act: number; mkt: number; beat: number; mae: number; inRange: number | null; list?: { d: string; pred: number; act: number; mkt: number }[] }
export interface ExpBrief {
  n: number; coverage: number | null; slope: number | null; bias: number | null; dirHit: number | null; upShare: number | null; ic: number | null;
  mseVsZero: number | null; top5: Record<string, number | null> | null; bins: { pred: number; mean: number; median: number }[];
}
export interface RankScore {
  real: PickStats | null; last: PickLast | null; past: PastStats | null; pending?: { n: number; d: string } | null;
  check: { method: string; grade?: FcGrade; from: string; to: string; holdFrom: string; all: ExpBrief | null; hold: ExpBrief | null } | null;
}
export interface RankMarket {
  asOf: string; h: number; hLabel: string; baseAt: string | null; grade: ModelGrade; fcGrade?: FcGrade | null; universe: number; stale: boolean;
  mkt: { mid: number | null }; items: RankItem[]; excluded: { sym: Sym; name: string; why: string }[]; notes: string[]; score?: RankScore; aiBy?: string | null;
  /** 위쪽 종목 대부분에 공통인 근거 — 목록 위에 한 번만 ('오늘 위쪽 코인들은 대부분 …') */
  common?: string | null;
}
export interface RankData { version: number; updatedAt: string; markets: Partial<Record<Market, RankMarket>> }
export type RankTopItem = Pick<RankItem, 'sym' | 'name' | 'sub' | 'rank'> & Partial<Omit<RankItem, 'why'>> & { why?: string | null };
export interface RankTop {
  version: number; updatedAt: string; market: Market | null; asOf?: string; h?: number; hLabel?: string; baseAt?: string | null;
  grade?: ModelGrade; fcGrade?: FcGrade | null; stale?: boolean; mkt?: { mid: number | null }; items: RankTopItem[]; notes?: string[]; aiBy?: string | null;
  common?: string | null;
  score?: { last: PickLast | null; real: PickStats | null; past: Omit<PastStats, 'list'> | null; pending?: { n: number; d: string } | null;
    /** mdd·uniMdd = 되짚어 본 기간 고른 5개·시장 전체의 누적 최대 낙폭(분수, 음수) */
    check: { grade?: FcGrade; coverage: number | null; slope: number | null; from: string; to: string; mdd?: number | null; uniMdd?: number | null } | null };
}
export const rankData = () => staticJSON<RankData>('rank.json', 4 * 60e3);
export const rankTop = () => staticJSON<RankTop>('rank_top.json', 4 * 60e3);
export const predictSummary = () => staticJSON<PredictSummary>('predict/summary.json', 10 * 60e3);
export function predictSymbol(sym: Sym) {
  const [market, code] = split(sym);
  return staticJSON<PredictSymbol>(`predict/sym/${market}/${safeCode(code)}.json`, 10 * 60e3);
}

// ── 종목 AI 해설 (collector/stock_ai.py — 시장별 주요 종목만, 하루 2번 정도) ──
export const stockAi = () => staticJSON<StockAi>('stock_ai.json', 10 * 60e3);

// ── 전략 탭 과거 검증 (collector/setups.py --stats, 하루 1번) ──
export interface SetupHorizon { n: number; avgEx: number; medEx: number; win: number; up: number; mktUp: number; pop: number; popMkt: number; ci: [number, number] }
export interface SetupStat { nRaw: number; h5?: SetupHorizon; h20?: SetupHorizon; grade: 'good' | 'weak' | 'none'; opp?: boolean }
export interface SetupsStats {
  updatedAt: string; method?: string;
  /** dir: +1 = 오를 쪽 신호, -1 = 경고(내릴 쪽) */
  defs: Record<string, { emoji: string; name: string; desc: string; dir: 1 | -1 }>;
  markets: Partial<Record<Market, Record<string, SetupStat>>>;
}
export const setupsStats = () => staticJSON<SetupsStats>('setups_stats.json', 30 * 60e3);
