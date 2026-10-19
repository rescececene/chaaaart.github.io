// 내 평단 진단 — 일봉 기술적 분석에 내 평단가를 겹쳐 손절 고려선 · 1차 목표 · 판단 · 시나리오를 만든다 (순수 함수)
// 손절 고려선 = 구조(현재가 아래 가장 가까운 지지 − 0.5×ATR)와 변동성(평단 − 2×ATR, 수익 중이면 추적: 고점 − 2×ATR) 중 높은 쪽.
// 문장은 단정하지 않는다 ('고려', '~할 수 있어요'). 숫자 뒤에는 받침에 따라 바뀌는 조사(이/가, 으로/로)를 붙이지 않는다.
import type { Analysis } from './indicators';
import type { Candle } from './market/types';

/** 이 기기에 저장하는 내 평단 — at: 저장한 시각(ms) */
export interface Position { avg: number; qty?: number; at: number }

// ── 입력 ──
export interface Parsed { value: number | null; error: string | null }
const UNIT_RE = /원|₩|\$|usdt|개|주/gi;
/** '98,000,000' · ' 1.5 ' · '$180.5' · '０.１' → 숫자. 빈칸은 value·error 모두 null */
export function parseAmount(raw: string): Parsed {
  const s = raw.normalize('NFKC').replace(/[\s,]/g, '').replace(UNIT_RE, '');
  if (!s) return { value: null, error: raw.trim() ? '숫자만 입력해 주세요' : null };
  if (s.startsWith('-')) return { value: null, error: '0보다 큰 값을 입력해 주세요' };
  if (!/^(\d+\.?\d*|\.\d+)$/.test(s)) return { value: null, error: '숫자만 입력해 주세요' };
  const v = Number(s);
  if (!Number.isFinite(v)) return { value: null, error: '숫자만 입력해 주세요' };
  if (v <= 0) return { value: null, error: '0보다 큰 값을 입력해 주세요' };
  return { value: v, error: null };
}
/** 평단이 현재가와 5배 넘게 차이 나면 통화를 잘못 넣었을 가능성 (원 ↔ USDT ↔ $) */
export const farFromPrice = (avg: number, price: number | null | undefined) => !!price && (avg / price > 5 || price / avg > 5);
/** 저장된 값이 쓸 만한가 (예전 형식·깨진 값 거르기) */
export function isPosition(p: unknown): p is Position {
  if (!p || typeof p !== 'object') return false;
  const { avg, qty } = p as Position;
  return typeof avg === 'number' && Number.isFinite(avg) && avg > 0 && (qty == null || (typeof qty === 'number' && Number.isFinite(qty) && qty > 0));
}

// ── 지지·저항 ──
export interface Pivots { highs: number[]; lows: number[] }
/** 앞뒤 k 봉보다 높은(낮은) 봉 = 고점(저점). indicators.analyze() 의 지지·저항과 같은 규칙 (최근 look 봉) —
 *  미리 한 번 구해 두고, 실시간 가격이 바뀔 때는 nearestBelow·nearestAbove 로 가볍게 고른다 */
export function pivots(candles: Candle[], look = 120, k = 3): Pivots {
  const N = candles.length, highs: number[] = [], lows: number[] = [];
  for (let i = Math.max(k, N - look); i < N - k; i++) {
    const { h, l } = candles[i];
    let top = true, bottom = true;
    for (let j = i - k; j <= i + k; j++) {
      if (j === i) continue;
      if (candles[j].h > h) top = false;
      if (candles[j].l < l) bottom = false;
    }
    if (top) highs.push(h);
    if (bottom) lows.push(l);
  }
  return { highs, lows };
}
export function nearestBelow(xs: number[], p: number): number | null {
  let r: number | null = null;
  for (const x of xs) if (x < p && (r == null || x > r)) r = x;
  return r;
}
export function nearestAbove(xs: number[], p: number): number | null {
  let r: number | null = null;
  for (const x of xs) if (x > p && (r == null || x < r)) r = x;
  return r;
}
/** 추적 손절의 기준 고점 — 끝에서부터 저가가 평단보다 높았던 봉들(평단 위에서 움직인 최근 구간, 최대 max 봉)의 최고가와 지금 가격 중 큰 값.
 *  막 산 종목(오늘 저가가 평단 아래)은 지금 가격이 기준이라, 사기 전의 고점으로 손절선이 올라가지 않는다 */
export function profitPeak(candles: Candle[], avg: number, price: number, max = 20): number {
  let peak = price;
  for (let i = candles.length - 1, n = 0; i >= 0 && n < max; i--, n++) {
    if (candles[i].l <= avg) break;
    if (candles[i].h > peak) peak = candles[i].h;
  }
  return peak;
}

// ── 진단 ──
export type VerdictKey = 'trail_broken' | 'overheat' | 'hold' | 'protect' | 'profit_watch' | 'oversold' | 'stop' | 'near' | 'watch';
/** hold 보유 · trim 일부 익절 · watch 관망 · caution 주의 · exit 손절 */
export type VerdictTone = 'hold' | 'trim' | 'watch' | 'caution' | 'exit';
export interface Verdict { key: VerdictKey; tone: VerdictTone; badge: string; title: string; detail: string }
export type LineTone = 'up' | 'down' | 'flat';
export interface Line { tone: LineTone; text: string }
export type StopKind = 'struct' | 'vol' | 'trail';

export interface Diagnosis {
  price: number; avg: number; qty: number | null;
  pnlPct: number; pnlAmt: number | null; profit: boolean;
  atr: number; atrPct: number;
  /** 손절 고려선과 그 근거 — broken: 이미 현재가가 손절선 아래 */
  stop: number; stopKind: StopKind; stopBroken: boolean; stopBasis: string;
  structStop: number | null; volStop: number; peak: number | null;
  /** 손절선에서 정리하면 평단 대비 (%, 금액) · 현재가에서 손절선까지 (%) */
  stopFromAvgPct: number; stopAmt: number | null; stopFromPricePct: number;
  target: number | null; targetKind: 'res' | 'high' | null;
  support: number | null; resistance: number | null;
  /** 손익비 = (목표 − 현재) ÷ (현재 − 손절). 목표가 없거나 손절선을 이미 이탈했으면 null */
  rr: number | null;
  /** 수익 지키기 판단일 때 올려 둘 만한 손절선 — 고점 − 1×ATR 와 본전(평단) 중 높은 쪽, 현재가보다 0.5×ATR 아래까지. 지금 손절선보다 높을 때만 */
  raise: number | null;
  near: boolean; downtrend: boolean; overheated: boolean; oversold: boolean;
  /** 기술적 의견 방향 (1 매수 쪽 · 0 중립 · -1 매도 쪽) */
  lean: -1 | 0 | 1;
  verdict: Verdict;
  scenarios: Line[];
  reasons: { pos: string[]; neg: string[]; mine: string[] };
}
export interface DiagInput {
  candles: Candle[]; a: Analysis; piv: Pivots;
  avg: number; price: number; qty?: number | null;
  /** 가격 표시 (단위 포함 — '93,760,000원' · '$180.25') */
  f?: (x: number) => string;
}

/** 부호 % — '+6.2%' · '−3.9%' (음수 부호는 U+2212) */
const pc = (x: number, d = 1) => { const r = Number(x.toFixed(d)); return `${r > 0 ? '+' : r < 0 ? '−' : ''}${Math.abs(r).toFixed(d)}%`; };
const gap = (from: number, to: number) => (to / from - 1) * 100;
const absPct = (x: number) => Math.abs(x).toFixed(Math.abs(x) < 1 ? 2 : 1);
/** 계산으로 만든 선(손절 고려선 등)은 유효숫자 4자리로 — 112,932,307 → 112,900,000 · 180.237 → 180.2 */
export function roundSig(x: number, n = 4): number {
  if (!Number.isFinite(x) || x === 0) return x;
  const k = 10 ** (Math.floor(Math.log10(Math.abs(x))) - n + 1);
  return k >= 1 ? Math.round(x / k) * k : +(Math.round(x / k) * k).toPrecision(n);
}
const LEAN_EDGE = 0.15; // 의견 점수가 이 이상이면 매수 쪽 (indicators 의 '매수' 문턱과 같다)

export function leanOf(score: number): -1 | 0 | 1 {
  return score >= LEAN_EDGE ? 1 : score <= -LEAN_EDGE ? -1 : 0;
}

export function diagnose({ candles, a, piv, avg, price, qty, f = (x) => String(Math.round(x * 100) / 100) }: DiagInput): Diagnosis {
  const atr = a.atr != null && a.atr > 0 ? a.atr : price * 0.01; // 값이 전혀 안 움직인 종목도 손절선은 그린다
  const atrPct = (atr / price) * 100;
  const atrTxt = `${atrPct.toFixed(atrPct < 1 ? 2 : 1)}%`;
  const profit = price > avg;
  const pnlPct = gap(avg, price);
  const q = qty && qty > 0 ? qty : null;

  const support = nearestBelow(piv.lows, price);
  const resistance = nearestAbove(piv.highs, price);
  const structStop = support != null ? support - 0.5 * atr : null;
  const peak = profit ? profitPeak(candles, avg, price) : null;
  const volStop = peak != null ? peak - 2 * atr : avg - 2 * atr;
  const useStruct = structStop != null && structStop > volStop;
  const stop = roundSig(Math.max(0, useStruct ? (structStop as number) : volStop));
  const stopKind: StopKind = useStruct ? 'struct' : peak != null ? 'trail' : 'vol';
  const stopBroken = stop >= price;
  const stopBasis = stopKind === 'struct' ? `최근 지지 ${f(support as number)} 아래 · 하루 평균 움직임 0.5배 여유`
    : stopKind === 'trail' ? `최근 고점 ${f(peak as number)} 아래 · 하루 평균 움직임 2배 (따라 올라가는 손절선)`
      : '평단 아래 · 하루 평균 움직임 2배';

  // 1차 목표 — 하루 평균 움직임의 1/4 도 안 되는 바로 위 고점은 목표로 보지 않는다 (손익비가 0에 가깝게 나오지 않게)
  const res1 = nearestAbove(piv.highs, price + 0.25 * atr);
  const hi1 = a.high > price + 0.25 * atr ? a.high : null;
  const targetKind: Diagnosis['targetKind'] = res1 != null ? 'res' : hi1 != null ? 'high' : null;
  const target = res1 ?? hi1;
  const rr = target != null && !stopBroken && price > stop ? (target - price) / (price - stop) : null;

  const lean = leanOf(a.opinion.score);
  const rsi = a.rsi;
  const overheated = (rsi != null && rsi >= 70) || (a.bb.up != null && price > a.bb.up);
  const oversold = rsi != null && rsi <= 30;
  const downtrend = a.signals.includes('align_down') || lean < 0;
  const room = price - stop; // 현재가 → 손절선 거리
  const near = !stopBroken && room <= atr;
  const roomPct = absPct(gap(price, stop));
  const opLabel = a.opinion.label;
  const sl = stopKind === 'trail' ? '추적 손절선' : '손절선';
  const rsiTxt = rsi != null ? rsi.toFixed(0) : '';
  // 반등하면 줄여 볼 자리 — 현재가 위 가장 가까운 5·20일 평균 또는 저항
  const near0 = [a.ma[5], a.ma[20], resistance].filter((x): x is number => x != null && x > price).sort((x, y) => x - y)[0];
  const bounce = near0 != null ? roundSig(near0) : null;

  // 수익 지키기 — 손절선을 고점 − 1×ATR 또는 본전까지 당겨 본다 (현재가에 너무 붙지 않게 0.5×ATR 아래까지)
  const tRaw = profit ? Math.min(Math.max((peak as number) - atr, avg), price - 0.5 * atr) : null;
  const tight = tRaw == null ? null : tRaw === avg ? avg : roundSig(tRaw); // 본전은 반올림하지 않는다
  const raise = tight != null && tight > stop && !stopBroken && lean < 0 && !overheated ? tight : null;

  let verdict: Verdict;
  if (profit) {
    if (stopBroken) {
      verdict = { key: 'trail_broken', tone: 'caution', badge: '수익 지키기', title: '추적 손절선 아래 · 수익 일부 지키기 고려',
        detail: `최근 고점 ${f(peak as number)}에서 하루 평균 움직임의 2배 넘게 내려왔어요. 아직 평단보다 ${pc(pnlPct)} 위예요.` };
    } else if (overheated) {
      verdict = { key: 'overheat', tone: 'trim', badge: '일부 익절', title: '단기 과열 · 일부 익절 고려',
        detail: rsi != null && rsi >= 70 ? `RSI ${rsiTxt} — 짧은 기간에 많이 올라 쉬어 갈 수 있어요.` : '볼린저밴드 상단 위 — 20일 보통 범위보다 많이 올라 숨 고르기가 나올 수 있어요.' };
    } else if (lean > 0) {
      verdict = { key: 'hold', tone: 'hold', badge: '보유 유지', title: `보유 유지 · ${sl} 아래로 내려오면 정리`,
        detail: `기술적 의견이 '${opLabel}' 쪽이에요. 손절 고려선까지 ${roomPct}% 여유가 있어요.` };
    } else if (lean < 0) {
      verdict = { key: 'protect', tone: 'caution', badge: '수익 지키기', title: '수익 지키기 · 손절선을 올려 두세요',
        detail: `기술적 의견이 '${opLabel}' 쪽으로 기울었어요. ${raise != null
          ? `수익이 줄기 전에 손절선을 ${f(raise)}${raise === avg ? '(본전)' : ''}까지 올려 둘 수 있어요.`
          : `손절 고려선(${f(stop)}) 아래로 내려오면 정리를 고려해 보세요.`}` };
    } else {
      verdict = { key: 'profit_watch', tone: 'watch', badge: '보유 관망', title: `보유하며 관망 · ${sl} 아래로 내려오면 정리 고려`,
        detail: `기술적 의견은 중립이에요. 손절 고려선까지 ${roomPct}% 여유가 있어요.` };
    }
  } else if (stopBroken && oversold) {
    verdict = { key: 'oversold', tone: 'caution', badge: '반등 때 줄이기', title: '손절선 아래지만 많이 빠짐 · 급매도보다 반등 때 비중 줄이기 고려',
      detail: `RSI ${rsiTxt} — 짧은 기간에 너무 많이 떨어져 되돌림이 나올 수 있어요.${bounce != null ? ` 반등하면 ${f(bounce)} 근처에서 줄여 볼 수 있어요.` : ''}` };
  } else if (stopBroken) {
    verdict = { key: 'stop', tone: 'exit', badge: '손절 고려', title: '손절선 이탈 · 손절 고려',
      detail: `손절 고려선 ${f(stop)} 아래로 내려왔어요 (평단 대비 ${pc(gap(avg, stop))}).` };
  } else if (near) {
    verdict = { key: 'near', tone: 'caution', badge: '손절선 가까움', title: '손절선 가까움 · 이탈하면 손절 고려',
      detail: `손절 고려선까지 ${roomPct}% — 하루 평균 움직임(${atrTxt}) 안이에요.${downtrend ? ' 하락 추세라 이탈할 수 있어요.' : ''}` };
  } else {
    verdict = { key: 'watch', tone: 'watch', badge: '관망', title: '손절선 지키며 관망',
      detail: `손절 고려선 ${f(stop)}까지 ${roomPct}% 여유가 있어요.${downtrend ? ' 다만 하락 추세라 손절선을 꼭 지켜보는 게 좋아요.' : ''}` };
  }

  // ── 이렇게 보면 돼요 (실제 숫자) ──
  const sc: Line[] = [];
  if (profit && stopBroken) {
    sc.push({ tone: 'down', text: support != null ? `${f(support)} 아래로 마감하면 남은 물량도 정리 고려` : '받쳐 줄 최근 저점이 없어요 — 더 내려가면 남은 물량도 정리 고려' });
    if (target != null) sc.push({ tone: 'flat', text: `${f(target)}까지 반등하면 일부 익절 고려` });
    sc.push({ tone: 'up', text: `${f(stop)} 위로 다시 올라서 마감하면 계속 보유해 볼 수 있어요` });
  } else if (profit) {
    sc.push({ tone: 'down', text: raise != null ? `${f(raise)} 아래로 마감하면 정리 고려 (올려 둔 손절선)` : `${f(stop)} 아래로 마감하면 정리 고려` });
    if (target != null) {
      sc.push({ tone: 'up', text: `${f(target)}${targetKind === 'high' ? '(최근 고점)' : ''}에 닿으면 일부 익절 고려` });
      const next = roundSig(target - 2 * atr);
      if (next > stop) sc.push({ tone: 'flat', text: `${f(target)} 위로 마감하면 손절선을 ${f(next)}까지 올려 볼 수 있어요` });
    } else {
      sc.push({ tone: 'up', text: '위쪽에 막힐 최근 고점이 없어요 — 손절선을 따라 올리며 보유 고려' });
    }
  } else if (stopBroken) {
    sc.push({ tone: 'down', text: support != null ? `${f(support)} 아래로 마감하면 추가 하락 가능 — 남은 물량 정리 고려` : '아래쪽에 받쳐 줄 최근 저점이 없어요 — 더 내려갈 수 있어요' });
    if (oversold && bounce != null) sc.push({ tone: 'flat', text: `${f(bounce)}까지 반등하면 비중 줄이기 고려` });
    sc.push({ tone: 'up', text: `${f(stop)} 위로 다시 올라서 마감하면 손절을 미루고 지켜볼 수 있어요` });
  } else {
    sc.push({ tone: 'down', text: `${f(stop)} 아래로 마감하면 손절 고려 (평단 대비 ${pc(gap(avg, stop))})` });
    if (target != null && target < avg) {
      sc.push({ tone: 'up', text: `${f(target)} 돌파하면 평단 ${f(avg)} 회복을 노려볼 수 있어요` });
      sc.push({ tone: 'flat', text: `${f(target)} 근처에서 막히면 비중 줄이기 고려` });
    } else if (target != null) {
      sc.push({ tone: 'up', text: `평단 ${f(avg)} 위로 올라서면 본전 — ${f(target)} 근처에선 일부 정리 고려` });
    } else {
      sc.push({ tone: 'flat', text: `평단 ${f(avg)}까지 ${pc(gap(price, avg))} 남았어요` });
    }
  }

  // ── 근거 — 지표의 긍정·부정 이유 상위 3개씩 + 내 평단 기준 ──
  const mine: string[] = [];
  const ma20 = a.ma[20];
  if (ma20 != null) {
    const d = gap(ma20, avg);
    mine.push(d >= 0 ? `평단이 20일 평균(${f(roundSig(ma20))})보다 ${absPct(d)}% 위 — 최근 평균 가격보다 비싸게 산 편이에요`
      : `평단이 20일 평균(${f(roundSig(ma20))})보다 ${absPct(d)}% 아래 — 최근 평균 가격보다 싸게 산 편이에요`);
  }
  if (profit) {
    const under = piv.lows.filter((x) => x < price && x > avg).length;
    mine.push(under ? `평단 위 지지 ${under}곳 — 가장 가까운 지지 ${f(support as number)}, 수익 구간을 받쳐 줄 수 있어요`
      : '평단 위 지지 없음 — 평단과 현재가 사이에 받쳐 줄 최근 저점이 없어 되돌림이 크면 평단까지 내려올 수 있어요');
  } else if (avg > price) {
    const over = piv.highs.filter((x) => x > price && x < avg).length;
    mine.push(over ? `평단 아래 저항 ${over}곳 — 평단까지 오르는 길에 가장 가까운 ${f(resistance as number)}에서 막힐 수 있어요`
      : '평단 아래 저항 없음 — 현재가와 평단 사이에 막힐 최근 고점이 없어요');
  }
  const dist = Math.abs(price - avg) / atr;
  mine.push(`평단 거리 — 현재가와 평단 차이는 하루 평균 움직임(${atrTxt})의 ${dist.toFixed(1)}배예요`);

  return {
    price, avg, qty: q, pnlPct, pnlAmt: q != null ? (price - avg) * q : null, profit,
    atr, atrPct, stop, stopKind, stopBroken, stopBasis, structStop, volStop, peak,
    stopFromAvgPct: gap(avg, stop), stopAmt: q != null ? (stop - avg) * q : null, stopFromPricePct: gap(price, stop),
    target, targetKind, support, resistance, rr, raise,
    near, downtrend, overheated, oversold, lean, verdict,
    scenarios: sc.slice(0, 3),
    reasons: { pos: a.reasons.pos.slice(0, 3), neg: a.reasons.neg.slice(0, 3), mine },
  };
}

// ── AI 해설과 기술적 판단 비교 ──
const AI_WORD: Record<-1 | 0 | 1, string> = { 1: '강세로', 0: '중립으로', [-1]: '약세로' };
const LEAN_WORD: Record<-1 | 0 | 1, string> = { 1: '매수 쪽', 0: '중립', [-1]: '매도 쪽' };
/** 기술적 의견 방향과 AI 종합 방향(s: -2..2)이 같은가 — 판단 제목 옆 한 줄 */
export function aiAgreement(lean: -1 | 0 | 1, s: number): { same: boolean; text: string } {
  const ai = Math.sign(s) as -1 | 0 | 1;
  if (ai === lean) return { same: true, text: ai === 0 ? 'AI도 뚜렷한 방향이 없다고 봐요' : `AI도 ${AI_WORD[ai]} 봐요` };
  return { same: false, text: `AI는 ${AI_WORD[ai]} 봐요 — 기술적 의견(${LEAN_WORD[lean]})과 달라 함께 참고하세요` };
}

// ── 가격 사다리 라벨 배치 ──
export interface LabelPos { left: number; row: 0 | 1 }
/** 점 위치(xs, px)에 너비 ws 인 라벨을 위(0)·아래(1) 두 줄에 겹치지 않게 놓는다. 점 위치는 그대로 두고 라벨만 옮긴다.
 *  위 줄을 먼저 쓰고, 겹치면 아래 줄, 둘 다 겹치면 덜 막힌 줄에서 오른쪽으로 민다. 끝에서 넘치면 왼쪽으로 되민다 */
export function placeLabels(xs: number[], ws: number[], W: number, gapPx = 6): LabelPos[] {
  const out: LabelPos[] = xs.map(() => ({ left: 0, row: 0 }));
  const order = xs.map((_, i) => i).sort((i, j) => xs[i] - xs[j]);
  const right: [number, number] = [-Infinity, -Infinity];
  const rows: [number[], number[]] = [[], []];
  for (const i of order) {
    const want = Math.min(Math.max(xs[i] - ws[i] / 2, 0), Math.max(0, W - ws[i]));
    let row: 0 | 1, left: number;
    if (want >= right[0] + gapPx) { row = 0; left = want; }
    else if (want >= right[1] + gapPx) { row = 1; left = want; }
    else { row = right[0] <= right[1] ? 0 : 1; left = right[row] + gapPx; }
    out[i] = { left, row };
    right[row] = left + ws[i];
    rows[row].push(i);
  }
  for (const r of rows) {
    let limit = W;
    for (let k = r.length - 1; k >= 0; k--) {
      const i = r[k];
      if (out[i].left + ws[i] > limit) out[i].left = Math.max(0, limit - ws[i]);
      limit = out[i].left - gapPx;
    }
  }
  return out;
}
