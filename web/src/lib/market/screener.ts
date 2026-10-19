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
/** 이 자리에서 사면 — 단기·중기·장기 (주식 5·20·60 거래일, 코인 7·30·90일). 지금과 비슷했던 과거 자리 실제 결과의 분포 */
export interface OutlookItem {
  h: number; label: '단기' | '중기' | '장기'; n: number;
  q10: number | null; q50: number | null; q90: number | null; win: number | null;
  base: { q50: number; win: number } | null; grade: OutlookGrade; reason?: string;
}
export interface OutlookCheck {
  h: number; periods: number; n: number; coverage: number; dirHit: number; baseDirHit: number;
  calib: { p: number; actual: number; n: number }[]; calibErr: number; calibSlope: number; brierSkill: number; grade: OutlookGrade;
}
export interface PredictPick {
  sym: Sym; name: string; sub: string; score: number; rank: number; probUp: number | null;
  q10: number | null; q50: number | null; q90: number | null;
  reasons: PredictReason[]; spark: number[]; analog: { n: number; winRate: number; avg: number } | null;
  outlook?: { h: number; label: string; q50: number | null; win: number | null; grade: OutlookGrade }[];
}
export interface PredictBacktest {
  from: string; to: string; periods: number; rankIC: number | null; icIR: number | null; icPositiveRate: number | null;
  topExcess: number | null; topHitRate: number | null; equity: { t: string; top: number; all: number; topMin?: number; topMax?: number }[];
  /** strong = 전체·뒤쪽 절반 모두 통계적으로 뚜렷 · weak = 약함 · none = 효과 없음 */
  verdict?: 'strong' | 'weak' | 'none'; tStat?: number | null; topExcessLog?: number | null; bottomExcess?: number | null;
  heldOut?: Record<string, unknown>; dev?: Record<string, unknown>; regime?: Record<string, unknown>; grids?: number; randomTop?: Record<string, unknown>; basis?: string;
}
export interface PredictMarket {
  asOf: string; horizon: number; universe: number;
  model: { kind: string; trainedAt: string; trainRows: number; features: number };
  backtest: PredictBacktest; notes: string[]; picks: PredictPick[]; avoid: PredictPick[];
}
export interface PredictSummary {
  version: number; updatedAt: string; markets: Partial<Record<Market, PredictMarket>>;
  outlookBacktest?: Partial<Record<Market, Partial<Record<'단기' | '중기' | '장기', OutlookCheck | null>>>>;
}
export interface PredictSymbol {
  sym: Sym; name: string; sub: string; asOf: string; horizon: number;
  score: number; rank: number; of: number; probUp: number | null; q10: number | null; q50: number | null; q90: number | null;
  cone: { d: number; q10: number; q50: number; q90: number }[];
  reasons: PredictReason[];
  contrib: { key: string; label: string; value: number; impact: number }[];
  analogs: { start: string; end: string; corr: number; fwdRet: number; path: number[] }[];
  analogStats: { n: number; winRate: number; avg: number; median: number } | null;
  outlook?: OutlookItem[];
}
export const predictSummary = () => staticJSON<PredictSummary>('predict/summary.json', 10 * 60e3);
export function predictSymbol(sym: Sym) {
  const [market, code] = split(sym);
  return staticJSON<PredictSymbol>(`predict/sym/${market}/${safeCode(code)}.json`, 10 * 60e3);
}

// ── 종목 AI 해설 (collector/stock_ai.py — 시장별 주요 종목만, 하루 2번 정도) ──
export const stockAi = () => staticJSON<StockAi>('stock_ai.json', 10 * 60e3);
