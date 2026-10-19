// 기술적 지표와 신호 — collector/indicators.py 와 같은 계산 (스크리너와 차트 값이 같아야 한다)
// 모든 시계열 함수는 입력과 길이가 같은 배열을 돌려주고, 아직 계산되지 않는 앞부분은 null 이다.
// 파이썬과 끝자리까지 같은 값이 나오도록 더하는 순서와 식의 모양을 맞춰 두었다. 고칠 때는 양쪽을 같이 고치고
// py -3 tools/make_fixture.py --reuse 로 기준값을 다시 만든 뒤 vitest 로 확인한다.
import type { Candle } from './market/types';

export type Series = (number | null)[];
export type Tone = 'up' | 'down' | 'flat';

export const MA_PERIODS = [5, 20, 60, 120] as const;
export const SURGE = 5; // 급등/급락 기준 등락률(%)
const VOL_SPIKE = 3; // 거래량 급증 기준 (20봉 평균 대비 배수)
const CROSS_LOOKBACK = 3; // 최근 몇 봉 안의 크로스를 신호로 볼지
export const ICHI_SHIFT = 26; // 일목균형표 구름(선행스팬)은 계산한 봉보다 26봉 앞에 그린다
const MA_VOTE = [5, 10, 20, 60, 120] as const; // 의견 표를 던지는 이동평균

/** [쉬운 이름, 성격] — up = 상승 쪽 신호, down = 하락 쪽, flat = 방향 없음 */
export const SIGNALS: Record<string, [string, Tone]> = {
  surge: ['급등', 'up'], plunge: ['급락', 'down'], vol_spike: ['거래량 급증', 'flat'],
  rsi_os: ['낙폭 과대', 'up'], rsi_ob: ['단기 과열', 'down'],
  golden: ['상승 전환', 'up'], dead: ['하락 전환', 'down'],
  align_up: ['상승 추세', 'up'], align_down: ['하락 추세', 'down'],
  bb_up: ['평소보다 높음', 'up'], bb_down: ['평소보다 낮음', 'down'],
  macd_up: ['오르는 힘 커짐', 'up'], macd_down: ['내리는 힘 커짐', 'down'],
  new_high: ['최고가 돌파', 'up'], new_low: ['최저가 이탈', 'down'],
};
/** 신호 뜻 — [쉬운 설명, 원래 용어] (일봉 기준 문장) */
export const SIGNAL_INFO: Record<string, [string, string]> = {
  surge: ['하루에 5% 넘게 올랐어요', '급등'],
  plunge: ['하루에 5% 넘게 내렸어요', '급락'],
  vol_spike: ['거래량이 평소(20일 평균)의 3배가 넘어요', '거래량 급증'],
  rsi_os: ['짧은 기간에 너무 많이 떨어져 반등할 수 있어요', 'RSI 30 이하 · 과매도'],
  rsi_ob: ['짧은 기간에 너무 많이 올라 쉬어 갈 수 있어요', 'RSI 70 이상 · 과매수'],
  golden: ['5일 평균 가격이 20일 평균을 위로 뚫었어요', '골든크로스'],
  dead: ['5일 평균 가격이 20일 평균 아래로 내려갔어요', '데드크로스'],
  align_up: ['5·20·60·120일 평균 가격이 짧은 것부터 차례로 위에 있어요', '정배열'],
  align_down: ['5·20·60·120일 평균 가격이 짧은 것부터 차례로 아래에 있어요', '역배열'],
  bb_up: ['최근 20일의 보통 움직임 범위 위로 올라섰어요', '볼린저밴드 상단 돌파'],
  bb_down: ['최근 20일의 보통 움직임 범위 아래로 내려갔어요', '볼린저밴드 하단 이탈'],
  macd_up: ['오르는 힘이 내리는 힘을 막 앞질렀어요', 'MACD 상향 돌파'],
  macd_down: ['내리는 힘이 오르는 힘을 막 앞질렀어요', 'MACD 하향 돌파'],
  new_high: ['최근 1년 중 가장 높은 가격을 넘었어요', '신고가'],
  new_low: ['최근 1년 중 가장 낮은 가격 밑으로 내려갔어요', '신저가'],
};

function sum(xs: number[]) {
  let s = 0;
  for (const x of xs) s += x;
  return s;
}

export function sma(xs: number[], n: number): Series {
  const out: Series = new Array(xs.length).fill(null);
  let s = 0;
  for (let i = 0; i < xs.length; i++) {
    s += xs[i];
    if (i >= n) s -= xs[i - n];
    if (i >= n - 1) out[i] = s / n;
  }
  return out;
}

/** 앞쪽 null 은 건너뛰고, 처음 n 개 평균으로 시작 */
export function ema(xs: Series, n: number): Series {
  const out: Series = new Array(xs.length).fill(null);
  const k = 2 / (n + 1);
  let prev: number | null = null;
  const seed: number[] = [];
  for (let i = 0; i < xs.length; i++) {
    const x = xs[i];
    if (x == null) continue;
    if (prev == null) {
      seed.push(x);
      if (seed.length === n) { prev = sum(seed) / n; out[i] = prev; }
      continue;
    }
    prev = x * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** Wilder 방식 */
export function rsi(c: number[], n = 14): Series {
  const out: Series = new Array(c.length).fill(null);
  if (c.length <= n) return out;
  let gain = 0, loss = 0;
  for (let i = 1; i <= n; i++) {
    const d = c[i] - c[i - 1];
    gain += Math.max(d, 0);
    loss += Math.max(-d, 0);
  }
  let ag = gain / n, al = loss / n;
  const val = () => (al === 0 ? (ag === 0 ? 50 : 100) : 100 - 100 / (1 + ag / al));
  out[n] = val();
  for (let i = n + 1; i < c.length; i++) {
    const d = c[i] - c[i - 1];
    ag = (ag * (n - 1) + Math.max(d, 0)) / n;
    al = (al * (n - 1) + Math.max(-d, 0)) / n;
    out[i] = val();
  }
  return out;
}

export function macd(c: number[], fast = 12, slow = 26, sig = 9): [Series, Series, Series] {
  const ef = ema(c, fast), es = ema(c, slow);
  const line = ef.map((a, i) => (a != null && es[i] != null ? a - (es[i] as number) : null));
  const signal = ema(line, sig);
  const hist = line.map((a, i) => (a != null && signal[i] != null ? a - (signal[i] as number) : null));
  return [line, signal, hist];
}

export function bollinger(c: number[], n = 20, k = 2): [Series, Series, Series] {
  const mid: Series = new Array(c.length).fill(null), up = mid.slice(), lo = mid.slice();
  for (let i = n - 1; i < c.length; i++) {
    const w = c.slice(i - n + 1, i + 1);
    const m = sum(w) / n;
    let v = 0;
    for (const x of w) v += (x - m) * (x - m);
    const sd = Math.sqrt(v / n);
    mid[i] = m; up[i] = m + k * sd; lo[i] = m - k * sd;
  }
  return [mid, up, lo];
}

/** 최근 n 봉(자기 봉 포함) 중 가장 큰 값 */
export function highest(xs: number[], n: number): Series {
  const out: Series = new Array(xs.length).fill(null);
  for (let i = n - 1; i < xs.length; i++) {
    let m = xs[i];
    for (let j = i - n + 1; j < i; j++) if (xs[j] > m) m = xs[j];
    out[i] = m;
  }
  return out;
}

/** 최근 n 봉(자기 봉 포함) 중 가장 작은 값 */
export function lowest(xs: number[], n: number): Series {
  const out: Series = new Array(xs.length).fill(null);
  for (let i = n - 1; i < xs.length; i++) {
    let m = xs[i];
    for (let j = i - n + 1; j < i; j++) if (xs[j] < m) m = xs[j];
    out[i] = m;
  }
  return out;
}

/** 최근 n 개 값의 단순 평균 — 창 안에 null 이 있으면 null. 앞에서부터 차례로 더한다 */
export function rollMean(xs: Series, n: number): Series {
  const out: Series = new Array(xs.length).fill(null);
  for (let i = n - 1; i < xs.length; i++) {
    let s = 0, ok = true;
    for (let j = i - n + 1; j <= i && ok; j++) {
      const x = xs[j];
      if (x == null) ok = false;
      else s += x;
    }
    if (ok) out[i] = s / n;
  }
  return out;
}

/** 느린 스토캐스틱 (14, 3, 3) — [%K, %D]. 최근 n 봉 가격 범위에서 종가 위치(0 바닥 · 100 꼭대기)를 3봉씩 두 번 고른다 */
export function stochastic(h: number[], l: number[], c: number[], n = 14, kn = 3, dn = 3): [Series, Series] {
  const hh = highest(h, n), ll = lowest(l, n);
  const fast: Series = c.map((x, i) => {
    const hi = hh[i], lo = ll[i];
    if (hi == null || lo == null) return null;
    return hi > lo ? ((x - lo) / (hi - lo)) * 100 : 50;
  });
  const k = rollMean(fast, kn);
  return [k, rollMean(k, dn)];
}

/** 윌리엄스 %R (14) — 0 꼭대기 · -100 바닥 */
export function williamsR(h: number[], l: number[], c: number[], n = 14): Series {
  const hh = highest(h, n), ll = lowest(l, n);
  return c.map((x, i) => {
    const hi = hh[i], lo = ll[i];
    if (hi == null || lo == null) return null;
    return hi > lo ? ((x - hi) / (hi - lo)) * 100 : -50;
  });
}

/** CCI (20) — 대표 가격((고+저+종)/3)이 20봉 평균에서 얼마나 벗어났는지 (평균 편차의 0.015배 단위) */
export function cci(h: number[], l: number[], c: number[], n = 20): Series {
  const tp = c.map((x, i) => (h[i] + l[i] + x) / 3);
  const out: Series = new Array(c.length).fill(null);
  for (let i = n - 1; i < c.length; i++) {
    let s = 0;
    for (let j = i - n + 1; j <= i; j++) s += tp[j];
    const m = s / n;
    let d = 0;
    for (let j = i - n + 1; j <= i; j++) d += Math.abs(tp[j] - m);
    const md = d / n;
    // 값이 전혀 안 변하면 평균을 낼 때 생기는 아주 작은 오차만 남는다 — 0 으로 본다
    out[i] = md > Math.abs(m) * 1e-12 ? (tp[i] - m) / (0.015 * md) : 0;
  }
  return out;
}

/** Wilder 방식 ATR · +DI · −DI · ADX (14). TR 은 둘째 봉부터, ADX 는 DX n 개 평균으로 시작 */
export function dmi(h: number[], l: number[], c: number[], n = 14): { atr: Series; pdi: Series; mdi: Series; adx: Series } {
  const N = c.length;
  const atr: Series = new Array(N).fill(null), pdi = atr.slice(), mdi = atr.slice(), adx = atr.slice();
  if (N <= n) return { atr, pdi, mdi, adx };
  let tr = 0, pdm = 0, mdm = 0, dxSum = 0, ax = 0;
  for (let i = 1; i < N; i++) {
    const t = Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1]));
    const up = h[i] - h[i - 1], dn = l[i - 1] - l[i];
    const p = up > dn && up > 0 ? up : 0, m = dn > up && dn > 0 ? dn : 0;
    if (i <= n) {
      tr += t; pdm += p; mdm += m;
      if (i < n) continue;
      tr /= n; pdm /= n; mdm /= n;
    } else {
      tr = (tr * (n - 1) + t) / n;
      pdm = (pdm * (n - 1) + p) / n;
      mdm = (mdm * (n - 1) + m) / n;
    }
    const P = tr > 0 ? (pdm / tr) * 100 : 0, M = tr > 0 ? (mdm / tr) * 100 : 0;
    atr[i] = tr; pdi[i] = P; mdi[i] = M;
    const dx = P + M > 0 ? (Math.abs(P - M) / (P + M)) * 100 : 0;
    if (i < 2 * n - 1) { dxSum += dx; continue; }
    ax = i === 2 * n - 1 ? (dxSum + dx) / n : (ax * (n - 1) + dx) / n;
    adx[i] = ax;
  }
  return { atr, pdi, mdi, adx };
}

/** OBV — 오른 봉의 거래량은 더하고 내린 봉은 뺀 누적값 (처음 봉은 0) */
export function obv(c: number[], v: number[]): Series {
  const out: Series = new Array(c.length).fill(null);
  let s = 0;
  for (let i = 0; i < c.length; i++) {
    if (i > 0) {
      if (c[i] > c[i - 1]) s += v[i];
      else if (c[i] < c[i - 1]) s -= v[i];
    }
    out[i] = s;
  }
  return out;
}

/** MFI (14) — 거래량을 곱한 RSI. 대표 가격이 오른 봉의 거래대금 ÷ 내린 봉의 거래대금 */
export function mfi(h: number[], l: number[], c: number[], v: number[], n = 14): Series {
  const N = c.length, out: Series = new Array(N).fill(null);
  const tp = c.map((x, i) => (h[i] + l[i] + x) / 3);
  const pos = new Array<number>(N).fill(0), neg = new Array<number>(N).fill(0);
  for (let i = 1; i < N; i++) {
    if (tp[i] > tp[i - 1]) pos[i] = tp[i] * v[i];
    else if (tp[i] < tp[i - 1]) neg[i] = tp[i] * v[i];
  }
  for (let i = n; i < N; i++) {
    let p = 0, m = 0;
    for (let j = i - n + 1; j <= i; j++) { p += pos[j]; m += neg[j]; }
    out[i] = m > 0 ? 100 - 100 / (1 + p / m) : p > 0 ? 100 : 50;
  }
  return out;
}

/** ROC (12) — n 봉 전 대비 등락률(%) */
export function roc(c: number[], n = 12): Series {
  return c.map((x, i) => (i >= n && c[i - n] ? ((x - c[i - n]) / c[i - n]) * 100 : null));
}

/** 일목균형표 (9·26·52) — 전환선 · 기준선 · 선행스팬1·2.
 *  선행스팬은 '그 봉에서 계산한 값'이라, 차트에선 ICHI_SHIFT 봉 앞에 그리고 지금 봉의 구름은 ICHI_SHIFT 봉 전 값이다 */
export function ichimoku(h: number[], l: number[], a = 9, b = 26, s = 52): { conv: Series; base: Series; spanA: Series; spanB: Series } {
  const mid = (n: number): Series => {
    const hh = highest(h, n), ll = lowest(l, n);
    return hh.map((x, i) => (x == null || ll[i] == null ? null : (x + (ll[i] as number)) / 2));
  };
  const conv = mid(a), base = mid(b);
  const spanA = conv.map((x, i) => (x == null || base[i] == null ? null : (x + (base[i] as number)) / 2));
  return { conv, base, spanA, spanB: mid(s) };
}

/** 파라볼릭 SAR (0.02 · 최대 0.2) — [SAR, 방향(1 상승 · -1 하락)]. 둘째 봉부터 */
export function psar(h: number[], l: number[], step = 0.02, maxAf = 0.2): [Series, Series] {
  const N = h.length, sar: Series = new Array(N).fill(null), dir: Series = sar.slice();
  if (N < 3) return [sar, dir];
  let up = h[1] - h[0] >= l[0] - l[1];
  let ep = up ? Math.max(h[0], h[1]) : Math.min(l[0], l[1]);
  let s = up ? Math.min(l[0], l[1]) : Math.max(h[0], h[1]);
  let af = step;
  sar[1] = s; dir[1] = up ? 1 : -1;
  for (let i = 2; i < N; i++) {
    let next = s + af * (ep - s);
    if (up) {
      next = Math.min(next, l[i - 1], l[i - 2]);
      if (l[i] < next) { up = false; next = Math.max(ep, h[i]); ep = l[i]; af = step; }
      else if (h[i] > ep) { ep = h[i]; af = Math.min(af + step, maxAf); }
    } else {
      next = Math.max(next, h[i - 1], h[i - 2]);
      if (h[i] > next) { up = true; next = Math.min(ep, l[i]); ep = h[i]; af = step; }
      else if (l[i] < ep) { ep = l[i]; af = Math.min(af + step, maxAf); }
    }
    s = next; sar[i] = s; dir[i] = up ? 1 : -1;
  }
  return [sar, dir];
}

/** 이격도 — 종가 ÷ 이동평균 × 100 */
export function disparity(c: number[], ma: Series): Series {
  return c.map((x, i) => { const m = ma[i]; return m ? (x / m) * 100 : null; });
}

export interface IndicatorSeries {
  ma5: Series; ma20: Series; ma60: Series; ma120: Series;
  bbMid: Series; bbUp: Series; bbLo: Series;
  rsi: Series; macd: Series; macdSignal: Series; macdHist: Series;
  stochK: Series; stochD: Series; willr: Series; cci: Series;
  adx: Series; pdi: Series; mdi: Series; atr: Series;
  obv: Series; obvMa: Series; mfi: Series; roc: Series;
  /** ichiSpanA·B 는 계산한 봉 자리 값 — 지금 봉의 구름은 ICHI_SHIFT 봉 전 값 */
  ichiConv: Series; ichiBase: Series; ichiSpanA: Series; ichiSpanB: Series;
  sar: Series; sarDir: Series; disparity: Series;
}
export function series(candles: Candle[]): IndicatorSeries {
  const c = candles.map((x) => x.c), h = candles.map((x) => x.h), l = candles.map((x) => x.l), v = candles.map((x) => x.v);
  const [bbMid, bbUp, bbLo] = bollinger(c);
  const [m, s, hist] = macd(c);
  const ma20 = sma(c, 20);
  const [stochK, stochD] = stochastic(h, l, c);
  const dm = dmi(h, l, c);
  const ob = obv(c, v);
  const ichi = ichimoku(h, l);
  const [sar, sarDir] = psar(h, l);
  return {
    ma5: sma(c, 5), ma20, ma60: sma(c, 60), ma120: sma(c, 120), bbMid, bbUp, bbLo, rsi: rsi(c), macd: m, macdSignal: s, macdHist: hist,
    stochK, stochD, willr: williamsR(h, l, c), cci: cci(h, l, c), adx: dm.adx, pdi: dm.pdi, mdi: dm.mdi, atr: dm.atr,
    obv: ob, obvMa: rollMean(ob, 20), mfi: mfi(h, l, c, v), roc: roc(c),
    ichiConv: ichi.conv, ichiBase: ichi.base, ichiSpanA: ichi.spanA, ichiSpanB: ichi.spanB, sar, sarDir, disparity: disparity(c, ma20),
  };
}

/** 최근 lookback 봉 안에 a 가 b 를 위로(+1)/아래로(-1) 뚫었으면 [방향, 몇 봉 전]. 없으면 [0, null] */
export function crossed(a: Series, b: Series, lookback = CROSS_LOOKBACK): [number, number | null] {
  const n = a.length;
  for (let back = 0; back < lookback; back++) {
    const i = n - 1 - back;
    if (i < 1 || a[i] == null || b[i] == null || a[i - 1] == null || b[i - 1] == null) break;
    if ((a[i - 1] as number) <= (b[i - 1] as number) && (a[i] as number) > (b[i] as number)) return [1, back];
    if ((a[i - 1] as number) >= (b[i - 1] as number) && (a[i] as number) < (b[i] as number)) return [-1, back];
  }
  return [0, null];
}

/** 차트 표시용: 전 구간의 크로스 지점 */
export function crossPoints(candles: Candle[], a: Series, b: Series) {
  const out: { t: number; type: 'golden' | 'dead' }[] = [];
  for (let i = 1; i < candles.length; i++) {
    if (a[i] == null || b[i] == null || a[i - 1] == null || b[i - 1] == null) continue;
    if ((a[i - 1] as number) <= (b[i - 1] as number) && (a[i] as number) > (b[i] as number)) out.push({ t: candles[i].t, type: 'golden' });
    else if ((a[i - 1] as number) >= (b[i - 1] as number) && (a[i] as number) < (b[i] as number)) out.push({ t: candles[i].t, type: 'dead' });
  }
  return out;
}

export interface Opinion { score: number; label: string; buy: number; sell: number; neutral: number }

/** 기본 8표 — 이동평균 5개(가격이 평균 위면 매수) + RSI(30·70) + MACD(시그널 위면 매수) + 볼린저(밴드 밖이면 반대 방향) */
function baseVotes(c: number[], r: number | null, m: number | null, s: number | null, bbUp: number | null, bbLo: number | null): [string, number][] {
  const last = c[c.length - 1];
  const out: [string, number][] = [];
  for (const n of MA_VOTE) {
    if (c.length >= n) out.push([`ma${n}`, last > sum(c.slice(-n)) / n ? 1 : -1]);
  }
  if (r != null) out.push(['rsi', r < 30 ? 1 : r > 70 ? -1 : 0]);
  if (m != null && s != null) out.push(['macd', m > s ? 1 : -1]);
  if (bbUp != null && bbLo != null) out.push(['bb', last < bbLo ? 1 : last > bbUp ? -1 : 0]);
  return out;
}

/** 나머지 11표 — [키, 1 매수 · 0 중립 · -1 매도 · null 계산 못 함] */
function extraVotes(I: IndicatorSeries, last: number): [string, number | null][] {
  const N = I.rsi.length;
  const at = (k: keyof IndicatorSeries, i = N - 1) => (i >= 0 && i < N ? I[k][i] ?? null : null);
  const K = at('stochK'), D = at('stochD'), W = at('willr'), C = at('cci'), Cp = at('cci', N - 2);
  const A = at('adx'), P = at('pdi'), M = at('mdi'), O = at('obv'), Om = at('obvMa'), F = at('mfi'), R = at('roc');
  const cA = at('ichiSpanA', N - 1 - ICHI_SHIFT), cB = at('ichiSpanB', N - 1 - ICHI_SHIFT);
  const T = at('ichiConv'), B = at('ichiBase'), Sd = at('sarDir'), Dp = at('disparity');
  return [
    // 스토캐스틱: 과매도(%D 20 아래)에서 %K 가 %D 위로 → 매수, 과매수(80 위)에서 아래로 → 매도
    ['stoch', K == null || D == null ? null : K > D && D < 20 ? 1 : K < D && D > 80 ? -1 : 0],
    ['willr', W == null ? null : W < -80 ? 1 : W > -20 ? -1 : 0],
    // CCI: -100 아래에서 다시 오르면 매수, +100 위에서 꺾이면 매도
    ['cci', C == null || Cp == null ? null : C < -100 && C > Cp ? 1 : C > 100 && C < Cp ? -1 : 0],
    // ADX 20 이상(추세 있음)일 때만 +DI·−DI 방향으로
    ['adx', A == null || P == null || M == null ? null : A < 20 ? 0 : P > M ? 1 : P < M ? -1 : 0],
    ['obv', O == null || Om == null ? null : O > Om ? 1 : O < Om ? -1 : 0],
    ['mfi', F == null ? null : F < 20 ? 1 : F > 80 ? -1 : 0],
    ['roc', R == null ? null : R > 0 ? 1 : R < 0 ? -1 : 0],
    ['cloud', cA == null || cB == null ? null : last > Math.max(cA, cB) ? 1 : last < Math.min(cA, cB) ? -1 : 0],
    ['tk', T == null || B == null ? null : T > B ? 1 : T < B ? -1 : 0],
    ['sar', Sd == null ? null : Sd > 0 ? 1 : -1],
    ['disparity', Dp == null ? null : Dp < 95 ? 1 : Dp > 105 ? -1 : 0],
  ];
}

function tally(votes: number[]): Opinion {
  let buy = 0, sell = 0;
  for (const v of votes) { if (v === 1) buy++; else if (v === -1) sell++; }
  const score = votes.length ? (buy - sell) / votes.length : 0;
  const label = score >= 0.5 ? '적극 매수' : score >= 0.15 ? '매수' : score <= -0.5 ? '적극 매도' : score <= -0.15 ? '매도' : '중립';
  return { score: Math.round(score * 1000) / 1000, label, buy, sell, neutral: votes.length - buy - sell };
}

/** 지표 표를 세는 요약 의견 — 기본 8표 + extra(새 지표 표, null 은 건너뜀) */
export function opinion(c: number[], r: number | null, m: number | null, s: number | null, bbUp: number | null, bbLo: number | null, extra: (number | null)[] = []): Opinion {
  const votes = baseVotes(c, r, m, s, bbUp, bbLo).map((x) => x[1]);
  for (const v of extra) if (v != null) votes.push(v);
  return tally(votes);
}

export type VoteGroup = 'trend' | 'osc';
/** 지표 하나의 표 — state 는 짧은 쉬운 말 상태 (주요 지표 칸 아래 글) */
export interface Vote { key: string; v: -1 | 0 | 1; group: VoteGroup; state: string }
export interface Tally { buy: number; sell: number; neutral: number }
/** 판단 근거 — 각 줄은 '제목 — 설명' 꼴 (설명이 없는 줄도 있다) */
export interface Reasons { pos: string[]; neg: string[]; neutral: string[] }
const TREND_KEYS = new Set(['ma5', 'ma10', 'ma20', 'ma60', 'ma120', 'macd', 'adx', 'obv', 'roc', 'cloud', 'tk', 'sar']);

export interface Analysis {
  price: number; chg: number; rsi: number | null; macd: number | null; macdSignal: number | null; macdHist: number | null; volRatio: number | null;
  ma: Record<number, number | null>; bb: { up: number | null; mid: number | null; lo: number | null };
  high: number; low: number; lookback: number; signals: string[]; opinion: Opinion; notes: [Tone, string][];
  // 새 지표의 마지막 봉 값 (ichiA·ichiB 는 지금 봉 자리의 구름 = ICHI_SHIFT 봉 전에 계산한 선행스팬)
  stochK: number | null; stochD: number | null; willr: number | null; cci: number | null;
  adx: number | null; pdi: number | null; mdi: number | null; atr: number | null; atrPct: number | null;
  obv: number | null; obvMa: number | null; mfi: number | null; roc: number | null;
  ichiConv: number | null; ichiBase: number | null; ichiA: number | null; ichiB: number | null;
  sar: number | null; sarDir: number | null; disparity: number | null;
  /** 지표별 표 (opinion 은 이 표를 센 것) · 추세 지표 / 과열·침체 지표 묶음별 표 수 */
  votes: Vote[]; groups: Record<VoteGroup, Tally>;
  reasons: Reasons;
  /** 가까운 지지·저항(최근 고점·저점), 최근 범위 안 위치(0 바닥 ~ 1 꼭대기), 볼린저 안 위치(0 하단 ~ 1 상단)·폭(%) */
  support: number | null; resistance: number | null; rangePos: number | null;
  bbPos: number | null; bbWidth: number | null; squeeze: boolean;
  /** ATR% 가 최근 120봉 중 어느 정도인지 · 파라볼릭 SAR 방향이 몇 봉째 이어지는지 */
  atrLevel: '낮은 편' | '보통' | '높은 편' | null; sarBars: number | null;
}

const ago = (k: number | null) => (k === 0 ? '이번 봉' : `${k}봉 전`);
const pct = (x: number) => `${x >= 0 ? '+' : ''}${x.toFixed(1)}%`;

/** 앞뒤 k 봉보다 높은(낮은) 봉을 고점(저점)으로 보고, 지금 가격 바로 위·아래의 것을 저항·지지로 */
function levels(candles: Candle[], last: number, look = 120, k = 3): [number | null, number | null] {
  const N = candles.length;
  let sup: number | null = null, res: number | null = null;
  for (let i = Math.max(k, N - look); i < N - k; i++) {
    const { h, l } = candles[i];
    let top = true, bottom = true;
    for (let j = i - k; j <= i + k; j++) {
      if (j === i) continue;
      if (candles[j].h > h) top = false;
      if (candles[j].l < l) bottom = false;
    }
    if (top && h > last && (res == null || h < res)) res = h;
    if (bottom && l < last && (sup == null || l > sup)) sup = l;
  }
  return [sup, res];
}

/** unit: '일' / '주' / '개월' / '봉' — 분석 문장에 쓰는 봉 단위 */
export function analyze(candles: Candle[], ind?: IndicatorSeries, unit = '봉'): Analysis | null {
  if (!candles || candles.length < 30) return null;
  const I = ind && ind.stochK ? ind : series(candles);
  const c = candles.map((x) => x.c), v = candles.map((x) => x.v);
  const N = c.length, last = c[N - 1], prev = c[N - 2];
  const L = (k: keyof IndicatorSeries) => I[k][N - 1] ?? null;
  const chg = prev ? (last / prev - 1) * 100 : 0;
  const ma: Record<number, number | null> = {};
  for (const n of MA_PERIODS) ma[n] = L(`ma${n}` as keyof IndicatorSeries);
  ma[10] = N >= 10 ? sum(c.slice(-10)) / 10 : null; // 의견 표(MA_VOTE)에만 쓰는 10봉 평균 — 화면 표시용
  const r = L('rsi'), m = L('macd'), s = L('macdSignal'), h = L('macdHist');
  const up = L('bbUp'), mid = L('bbMid'), lo = L('bbLo');
  const base = v.slice(-21, -1);
  const avgV = base.length ? sum(base) / base.length : 0;
  const volRatio = avgV ? v[N - 1] / avgV : null;
  const look = Math.min(N - 1, 250);
  const prior = candles.slice(-look - 1, -1);
  let priorHigh = -Infinity, priorLow = Infinity;
  for (const x of prior) { if (x.h > priorHigh) priorHigh = x.h; if (x.l < priorLow) priorLow = x.l; }
  const hi = Math.max(priorHigh, candles[N - 1].h), low = Math.min(priorLow, candles[N - 1].l);

  const sig: string[] = [];
  if (chg >= SURGE) sig.push('surge');
  if (chg <= -SURGE) sig.push('plunge');
  if (volRatio != null && volRatio >= VOL_SPIKE) sig.push('vol_spike');
  if (r != null && r <= 30) sig.push('rsi_os');
  if (r != null && r >= 70) sig.push('rsi_ob');
  const [gx, gxAgo] = crossed(I.ma5, I.ma20);
  if (gx) sig.push(gx > 0 ? 'golden' : 'dead');
  const allMa = MA_PERIODS.every((n) => ma[n] != null);
  const alignUp = allMa && ma[5]! > ma[20]! && ma[20]! > ma[60]! && ma[60]! > ma[120]!;
  const alignDown = allMa && ma[5]! < ma[20]! && ma[20]! < ma[60]! && ma[60]! < ma[120]!;
  if (alignUp) sig.push('align_up');
  else if (alignDown) sig.push('align_down');
  if (up != null && last > up) sig.push('bb_up');
  if (lo != null && last < lo) sig.push('bb_down');
  const [mx, mxAgo] = crossed(I.macd, I.macdSignal);
  if (mx) sig.push(mx > 0 ? 'macd_up' : 'macd_down');
  if (candles[N - 1].h > priorHigh) sig.push('new_high');
  if (candles[N - 1].l < priorLow) sig.push('new_low');

  // 볼린저 폭이 최근 120봉 중 가장 좁은 수준인지 (변동성 수축)
  const widths: number[] = [];
  for (let i = Math.max(0, N - 120); i < N; i++) {
    const bm = I.bbMid[i];
    if (bm) widths.push(((I.bbUp[i] as number) - (I.bbLo[i] as number)) / bm);
  }
  const wNow = up != null && lo != null && mid ? (up - lo) / mid : null;
  const squeeze = widths.length >= 60 && wNow != null && wNow <= Math.min(...widths) * 1.1;

  // ── 사람이 읽는 요약 (예전 형식 — 그대로 둔다) ──
  const notes: [Tone, string][] = [];
  if (alignUp) notes.push(['up', `이동평균 정배열 (5 > 20 > 60 > 120${unit}) — 상승 추세`]);
  else if (alignDown) notes.push(['down', `이동평균 역배열 (5 < 20 < 60 < 120${unit}) — 하락 추세`]);
  else if (ma[20] != null) {
    const d = (last / ma[20]! - 1) * 100;
    notes.push([d >= 0 ? 'up' : 'down', `가격이 20${unit} 이동평균보다 ${Math.abs(d).toFixed(1)}% ${d >= 0 ? '위' : '아래'}`]);
  }
  if (gx) notes.push([gx > 0 ? 'up' : 'down', `5·20${unit}선 ${gx > 0 ? '골든' : '데드'}크로스 (${ago(gxAgo)})`]);
  if (r != null) {
    const zone = r >= 70 ? '과매수 구간 — 단기 과열' : r <= 30 ? '과매도 구간 — 반등 여지' : r >= 50 ? '중립 위쪽 (매수세 우위)' : '중립 아래쪽 (매도세 우위)';
    notes.push([r >= 70 ? 'down' : r <= 30 ? 'up' : 'flat', `RSI ${r.toFixed(1)} — ${zone}`]);
  }
  if (m != null && s != null) {
    if (mx) notes.push([mx > 0 ? 'up' : 'down', `MACD가 시그널선을 ${mx > 0 ? '상향' : '하향'} 돌파 (${ago(mxAgo)})`]);
    else {
      const hp = I.macdHist[N - 2];
      const trend = hp != null && h != null ? (Math.abs(h) > Math.abs(hp) ? '강해지는 중' : '약해지는 중') : '';
      notes.push([m > s ? 'up' : 'down', `MACD ${m > s ? '>' : '<'} 시그널 — ${m > s ? '상승' : '하락'} 모멘텀 ${trend}`.trim()]);
    }
  }
  if (up != null && lo != null) {
    if (last > up) notes.push(['up', '볼린저밴드 상단 돌파 — 강한 추세 또는 과열']);
    else if (last < lo) notes.push(['down', '볼린저밴드 하단 이탈 — 급락 또는 과매도']);
    else notes.push(['flat', `볼린저밴드 안 ${Math.round(((last - lo) / (up - lo || 1)) * 100)}% 위치 (0% 하단 · 100% 상단)`]);
    if (squeeze) notes.push(['flat', `밴드폭이 최근 ${widths.length}${unit} 중 최저 수준 — 변동성 수축, 큰 움직임 전조일 수 있음`]);
  }
  if (volRatio != null) notes.push([volRatio >= 2 ? 'up' : 'flat', `거래량 20${unit} 평균 대비 ${volRatio.toFixed(1)}배${volRatio >= VOL_SPIKE ? ' — 급증' : ''}`]);
  notes.push(['flat', `${look}${unit} 최고가 대비 ${pct((last / hi - 1) * 100)} · 최저가 대비 ${pct((last / low - 1) * 100)}`]);

  // ── 새 지표 값과 표 ──
  const K = L('stochK'), D = L('stochD'), W = L('willr'), C = L('cci');
  const A = L('adx'), P = L('pdi'), M = L('mdi'), atr = L('atr');
  const atrPct = atr != null && last ? (atr / last) * 100 : null;
  const O = L('obv'), Om = L('obvMa'), F = L('mfi'), R = L('roc');
  const ci = N - 1 - ICHI_SHIFT;
  const ichiA = ci >= 0 ? I.ichiSpanA[ci] ?? null : null, ichiB = ci >= 0 ? I.ichiSpanB[ci] ?? null : null;
  const T = L('ichiConv'), B = L('ichiBase'), sar = L('sar'), sd = L('sarDir'), Dp = L('disparity');
  const extra = extraVotes(I, last);
  const op = opinion(c, r, m, s, up, lo, extra.map((x) => x[1]));
  const keyed: [string, number][] = [...baseVotes(c, r, m, s, up, lo)];
  for (const [k, x] of extra) if (x != null) keyed.push([k, x]);
  const vote: Record<string, number> = Object.fromEntries(keyed);

  let sarBars: number | null = null;
  if (sd != null) { sarBars = 0; for (let i = N - 1; i >= 0 && I.sarDir[i] === sd; i--) sarBars++; }
  const atrHist: number[] = [];
  for (let i = Math.max(0, N - 120); i < N; i++) { const a = I.atr[i]; if (a != null && c[i]) atrHist.push(a / c[i]); }
  let atrLevel: Analysis['atrLevel'] = null;
  if (atr != null && last && atrHist.length >= 30) {
    const now = atr / last;
    const rank = atrHist.filter((x) => x <= now).length / atrHist.length;
    atrLevel = rank >= 0.8 ? '높은 편' : rank <= 0.2 ? '낮은 편' : '보통';
  }
  const [support, resistance] = levels(candles, last);
  const rangePos = hi > low ? (last - low) / (hi - low) : null;
  const bbPos = up != null && lo != null && up > lo ? (last - lo) / (up - lo) : null;
  const bbWidth = wNow != null ? wNow * 100 : null;

  // ── 쉬운 말 — 값이 문턱에 걸치면 소수 한 자리까지 (예: RSI 29.6 을 30 으로 반올림해 보이지 않게) ──
  const u = unit;
  const num = (x: number, edges: number[] = []) => { const k = Math.round(x); return edges.includes(k) && k !== x ? x.toFixed(1) : String(k); };
  const sgn = (x: number) => `${x > 0 ? '+' : ''}${x.toFixed(Math.abs(x) < 0.1 ? 2 : 1)}`;
  const when = (k: number | null) => (k === 0 ? '이번 봉' : `${k}${u} 전`);
  const per = ({ 일: '하루에', 주: '한 주에', 개월: '한 달에' } as Record<string, string>)[u] ?? '한 봉에';
  const bar = ({ 일: '날', 주: '주', 개월: '달' } as Record<string, string>)[u] ?? '봉';
  const abs1 = (x: number) => Math.abs(x).toFixed(1);

  const state: Record<string, string> = {};
  for (const n of MA_VOTE) state[`ma${n}`] = vote[`ma${n}`] === 1 ? '평균 위' : '평균 아래';
  state.rsi = vote.rsi === 1 ? '많이 내려 반등 여지' : vote.rsi === -1 ? '많이 올라 과열' : r != null && r >= 50 ? '보통 (오름 쪽)' : '보통 (내림 쪽)';
  state.macd = vote.macd === 1 ? '오르는 힘 우세' : '내리는 힘 우세';
  state.bb = vote.bb === 1 ? '하단 아래 (침체)' : vote.bb === -1 ? '상단 위 (과열)' : '보통 범위 안';
  state.stoch = vote.stoch === 1 ? '바닥권에서 반등' : vote.stoch === -1 ? '꼭대기권에서 꺾임'
    : K != null && K < 20 ? '바닥권 · 아직 하락 중' : K != null && K > 80 ? '꼭대기권 · 아직 상승 중' : K != null && K >= 50 ? '범위 위쪽' : '범위 아래쪽';
  state.willr = vote.willr === 1 ? '바닥권 (과매도)' : vote.willr === -1 ? '꼭대기권 (과매수)' : '보통';
  state.cci = vote.cci === 1 ? '크게 내렸다 반등' : vote.cci === -1 ? '크게 올랐다 꺾임'
    : C != null && C > 100 ? '평균보다 크게 높음' : C != null && C < -100 ? '평균보다 크게 낮음' : '평균 근처';
  state.adx = vote.adx === 1 ? '오르는 힘이 셈' : vote.adx === -1 ? '내리는 힘이 셈' : A != null && A < 20 ? '추세 약함' : '방향 팽팽';
  state.obv = vote.obv === 1 ? '오를 때 거래 많음' : vote.obv === -1 ? '내릴 때 거래 많음' : '보통';
  state.mfi = vote.mfi === 1 ? '돈 빠짐 (과매도)' : vote.mfi === -1 ? '돈 몰림 (과매수)' : '보통';
  state.roc = vote.roc === 1 ? `12${u} 전보다 높음` : vote.roc === -1 ? `12${u} 전보다 낮음` : `12${u} 전과 같음`;
  state.cloud = vote.cloud === 1 ? '구름 위' : vote.cloud === -1 ? '구름 아래' : '구름 안';
  state.tk = vote.tk === 1 ? '전환선 > 기준선' : vote.tk === -1 ? '전환선 < 기준선' : '전환선 = 기준선';
  state.sar = `${vote.sar === 1 ? '상승' : '하락'} 흐름${sarBars ? ` ${sarBars}${u}째` : ''}`;
  state.disparity = vote.disparity === 1 ? '많이 떨어짐 (침체)' : vote.disparity === -1 ? '많이 오름 (과열)' : Dp != null ? `평균 ${sgn(Dp - 100)}%` : '';
  const votes: Vote[] = keyed.map(([key, x]) => ({ key, v: x as -1 | 0 | 1, group: TREND_KEYS.has(key) ? 'trend' : 'osc', state: state[key] ?? '' }));
  const groups: Record<VoteGroup, Tally> = { trend: { buy: 0, sell: 0, neutral: 0 }, osc: { buy: 0, sell: 0, neutral: 0 } };
  for (const x of votes) groups[x.group][x.v === 1 ? 'buy' : x.v === -1 ? 'sell' : 'neutral']++;

  // ── 긍정적 이유 · 부정적 이유 (중요한 것부터) ──
  const pos: string[] = [], neg: string[] = [];
  if (sig.includes('new_high')) pos.push(`신고가 — 최근 ${look}${u} 중 가장 높은 가격을 넘었어요`);
  if (sig.includes('new_low')) neg.push(`신저가 — 최근 ${look}${u} 중 가장 낮은 가격 밑으로 내려갔어요`);
  if (sig.includes('surge')) pos.push(`급등 — 이번 봉에 ${chg.toFixed(1)}% 올랐어요`);
  if (sig.includes('plunge')) neg.push(`급락 — 이번 봉에 ${Math.abs(chg).toFixed(1)}% 내렸어요`);
  if (alignUp) pos.push('정배열 — 짧은 평균일수록 위에 있는 상승 추세예요');
  if (alignDown) neg.push('역배열 — 짧은 평균일수록 아래에 있는 하락 추세예요');
  if (gx > 0) pos.push(`골든크로스 — 5${u} 평균이 20${u} 평균을 위로 뚫었어요 (${when(gxAgo)})`);
  if (gx < 0) neg.push(`데드크로스 — 5${u} 평균이 20${u} 평균 아래로 내려갔어요 (${when(gxAgo)})`);
  const maUp = MA_VOTE.filter((n) => vote[`ma${n}`] === 1), maDn = MA_VOTE.filter((n) => vote[`ma${n}`] === -1);
  if (maUp.length) pos.push(`${maUp.join('·')}${u} 이동평균 위 — 가격이 그동안의 평균 가격보다 높아요`);
  if (maDn.length) neg.push(`${maDn.join('·')}${u} 이동평균 아래 — 가격이 그동안의 평균 가격보다 낮아요`);
  if (m != null && s != null) {
    const hp = I.macdHist[N - 2];
    const grow = h != null && hp != null ? Math.abs(h) > Math.abs(hp) : null;
    const more = grow == null ? '커요' : grow ? '크고 점점 세지고 있어요' : '크지만 조금씩 줄고 있어요';
    if (vote.macd === 1) pos.push(mx > 0 ? `MACD 상향 돌파 — 오르는 힘이 내리는 힘을 막 앞질렀어요 (${when(mxAgo)})` : `MACD 시그널 위 — 오르는 힘이 더 ${more}`);
    else neg.push(mx < 0 ? `MACD 하향 돌파 — 내리는 힘이 오르는 힘을 막 앞질렀어요 (${when(mxAgo)})` : `MACD 시그널 아래 — 내리는 힘이 더 ${more}`);
  }
  // +DI·-DI 를 반올림해 같아 보이면 ('22 > 22') 달라질 때까지 소수 자리를 늘린다
  const pair = (x: number, y: number) => { let d = 0; while (d < 2 && x.toFixed(d) === y.toFixed(d)) d++; return [x.toFixed(d), y.toFixed(d)]; };
  if (vote.adx === 1) { const [p, q] = pair(P!, M!); pos.push(`+DI ${p} > -DI ${q} — 오르는 힘이 내리는 힘보다 센 추세예요`); }
  if (vote.adx === -1) { const [q, p] = pair(M!, P!); neg.push(`-DI ${q} > +DI ${p} — 내리는 힘이 오르는 힘보다 센 추세예요`); }
  if (vote.cloud === 1) pos.push('일목 구름대 위 — 가격이 구름 위에 있어 위쪽 흐름이 우세해요');
  if (vote.cloud === -1) neg.push('일목 구름대 아래 — 가격이 구름 아래에 있어 아래쪽 흐름이 우세해요');
  if (vote.tk === 1) pos.push(`일목 전환선 > 기준선 — 단기(9${u}) 흐름이 중기(26${u})보다 강해요`);
  if (vote.tk === -1) neg.push(`일목 전환선 < 기준선 — 단기(9${u}) 흐름이 중기(26${u})보다 약해요`);
  if (vote.sar === 1) pos.push(sarBars === 1 ? '파라볼릭 SAR 상승 전환 — 이번 봉에 흐름이 위로 바뀌었어요' : `파라볼릭 SAR 상승 — 위쪽 흐름이 ${sarBars}${u}째 이어지고 있어요`);
  if (vote.sar === -1) neg.push(sarBars === 1 ? '파라볼릭 SAR 하락 전환 — 이번 봉에 흐름이 아래로 바뀌었어요' : `파라볼릭 SAR 하락 — 아래쪽 흐름이 ${sarBars}${u}째 이어지고 있어요`);
  if (vote.roc === 1) pos.push(`ROC ${sgn(R!)}% — 12${u} 전보다 가격이 높아요`);
  if (vote.roc === -1) neg.push(`ROC ${sgn(R!)}% — 12${u} 전보다 가격이 낮아요`);
  if (vote.obv === 1) pos.push(`OBV 20${u} 평균 위 — 오른 ${bar}에 거래량이 더 많이 실렸어요`);
  if (vote.obv === -1) neg.push(`OBV 20${u} 평균 아래 — 내린 ${bar}에 거래량이 더 많이 실렸어요`);
  if (vote.rsi === 1) pos.push(`RSI ${num(r!, [30, 70])} — 짧은 기간에 너무 많이 떨어져 반등 여지가 있어요`);
  if (vote.rsi === -1) neg.push(`RSI ${num(r!, [30, 70])} — 짧은 기간에 너무 많이 올라 쉬어 갈 수 있어요`);
  if (vote.stoch === 1) pos.push(`스토캐스틱 ${num(K!, [20, 80])} — %K가 %D를 위로 뚫었어요 (과매도 구간)`);
  if (vote.stoch === -1) neg.push(`스토캐스틱 ${num(K!, [20, 80])} — %K가 %D 아래로 꺾였어요 (과매수 구간)`);
  if (vote.willr === 1) pos.push(`윌리엄스 %R ${num(W!, [-80, -20])} — 최근 14${u} 가격 범위의 바닥권이에요 (과매도)`);
  if (vote.willr === -1) neg.push(`윌리엄스 %R ${num(W!, [-80, -20])} — 최근 14${u} 가격 범위의 꼭대기권이에요 (과매수)`);
  if (vote.cci === 1) pos.push(`CCI ${num(C!, [-100, 100])} — 평균보다 크게 낮은 곳에서 다시 오르기 시작했어요`);
  if (vote.cci === -1) neg.push(`CCI ${num(C!, [-100, 100])} — 평균보다 크게 높은 곳에서 꺾이기 시작했어요`);
  if (vote.mfi === 1) pos.push(`MFI ${num(F!, [20, 80])} — 거래대금이 많이 빠져나간 과매도 구간이에요`);
  if (vote.mfi === -1) neg.push(`MFI ${num(F!, [20, 80])} — 거래대금이 많이 몰린 과매수 구간이에요`);
  if (vote.bb === 1) pos.push(`볼린저밴드 하단 아래 — 20${u} 보통 범위보다 많이 내려와 되돌림이 나올 수 있어요`);
  if (vote.bb === -1) neg.push(`볼린저밴드 상단 위 — 20${u} 보통 범위보다 많이 올라 숨 고르기가 나올 수 있어요`);
  if (vote.disparity === 1) pos.push(`이격도 ${Dp!.toFixed(1)} — 20${u} 평균보다 ${abs1(100 - Dp!)}% 낮아 많이 떨어진 상태예요`);
  if (vote.disparity === -1) neg.push(`이격도 ${Dp!.toFixed(1)} — 20${u} 평균보다 ${abs1(Dp! - 100)}% 높아 과열된 상태예요`);

  // ── 객관적 관점 — 방향과 상관없는 사실과 읽는 법 ──
  const neutral: string[] = [];
  if (A != null) {
    const side = P != null && M != null && P !== M ? (P > M ? '오르는 쪽' : '내리는 쪽') : '';
    const A5 = I.adx[N - 6];
    const move = A5 != null ? (A > A5 + 1 ? '강해지는 중' : A < A5 - 1 ? '약해지는 중' : '') : '';
    const tail = [side, move].filter(Boolean).join(' · ');
    neutral.push(A >= 25 ? `추세 — ADX ${num(A, [25])}, 추세가 뚜렷해요${tail ? ` (${tail})` : ''}`
      : A >= 20 ? `추세 — ADX ${num(A, [20, 25])}, 추세가 생기기 시작했어요${tail ? ` (${tail})` : ''}`
        : `추세 — ADX ${num(A, [20])}, 뚜렷한 추세 없이 오르내리고 있어요`);
  }
  const lean = (g: Tally) => Math.sign(g.buy - g.sell);
  const word = (x: number) => (x > 0 ? '매수' : x < 0 ? '매도' : '중립');
  const tl = lean(groups.trend), ol = lean(groups.osc);
  if (votes.length) {
    neutral.push(tl && ol && tl !== ol ? `의견 — 추세 지표는 ${word(tl)}, 과열·침체 지표는 ${word(ol)} 쪽이라 서로 엇갈려요`
      : tl && tl === ol ? `의견 — 추세 지표와 과열·침체 지표 모두 ${word(tl)} 쪽이에요`
        : !tl && !ol ? '의견 — 추세 지표도 과열·침체 지표도 어느 한쪽으로 기울지 않았어요'
          : `의견 — 추세 지표는 ${tl ? `${word(tl)} 쪽` : '중립'}, 과열·침체 지표는 ${ol ? `${word(ol)} 쪽이에요` : '중립이에요'}`);
  }
  const shortV = [5, 10, 20].map((n) => vote[`ma${n}`]), longV = [60, 120].map((n) => vote[`ma${n}`]);
  if (shortV.every((x) => x === 1) && longV.every((x) => x === -1)) neutral.push('기간 — 단기 평균 위 · 장기 평균 아래라, 반등이 추세 전환으로 이어질지 지켜볼 때예요');
  else if (shortV.every((x) => x === -1) && longV.every((x) => x === 1)) neutral.push('기간 — 장기 평균 위 · 단기 평균 아래라, 상승 흐름 속에서 쉬어 가는 구간일 수 있어요');
  const calm: string[] = [], waitLow: string[] = [], waitHigh: string[] = [];
  if (vote.rsi === 0) calm.push(`RSI ${num(r!, [30, 70])}`);
  if (vote.stoch === 0) (K! < 20 ? waitLow : K! > 80 ? waitHigh : calm).push(`스토캐스틱 ${num(K!, [20, 80])}`);
  if (vote.cci === 0) (C! < -100 ? waitLow : C! > 100 ? waitHigh : calm).push(`CCI ${num(C!, [-100, 100])}`);
  if (vote.mfi === 0) calm.push(`MFI ${num(F!, [20, 80])}`);
  if (calm.length) neutral.push(`과열·침체 — ${calm.join(' · ')}, 보통 구간이에요`);
  if (waitLow.length) neutral.push(`과매도 대기 — ${waitLow.join(' · ')}, 많이 내렸지만 아직 반등 신호는 없어요`);
  if (waitHigh.length) neutral.push(`과매수 대기 — ${waitHigh.join(' · ')}, 많이 올랐지만 아직 꺾이지 않았어요`);
  if (rangePos != null) {
    const p = Math.round(rangePos * 100);
    neutral.push(`위치 — 최근 ${look}${u} 가격 범위의 ${p}% 높이, ${p >= 80 ? '꼭대기 근처예요' : p <= 20 ? '바닥 근처예요' : '중간쯤이에요'}`);
  }
  if (support != null || resistance != null) {
    const gap = (x: number) => Math.abs((x / last - 1) * 100).toFixed(1);
    neutral.push(`지지·저항 — ${support != null ? `가까운 지지선은 ${gap(support)}% 아래` : '아래쪽엔 최근 저점이 없고'}, ${resistance != null ? `저항선은 ${gap(resistance)}% 위예요` : '위쪽엔 최근 고점이 없어요'}`);
  }
  if (atrPct != null) neutral.push(`변동성 — ${per} 평균 ${atrPct.toFixed(atrPct < 1 ? 2 : 1)}% 움직여요${atrLevel ? ` (최근 ${atrHist.length}${u} 중 ${atrLevel})` : ''}`);
  if (squeeze) neutral.push(`밴드 수축 — 볼린저밴드 폭이 최근 ${widths.length}${u} 중 가장 좁아요. 곧 크게 움직일 수 있어요`);
  if (volRatio != null) {
    const vr = volRatio >= VOL_SPIKE ? '급증했어요' : volRatio >= 1.5 ? '많은 편이에요' : volRatio <= 0.5 ? '적은 편이에요' : '평소 수준이에요';
    neutral.push(`거래량 — 20${u} 평균의 ${volRatio.toFixed(1)}배로 ${vr}`);
  }
  const miss: string[] = [];
  if (ma[120] == null) miss.push(`120${u} 평균`);
  if (ichiA == null) miss.push('일목 구름');
  if (A == null) miss.push('ADX');
  if (miss.length) neutral.push(`데이터 — ${N}${u}치뿐이라 ${miss.join('·')} 계산은 빠졌어요`);
  neutral.push(A == null ? '참고 — 지표는 지난 가격으로 계산해서 갑작스러운 소식에는 늦게 반응해요'
    : A >= 25 ? '참고 — 추세가 뚜렷할 땐 과열·침체 지표가 너무 일찍 반대 신호를 내기 쉬워요. 추세 지표가 더 잘 맞는 편이에요'
      : A < 20 ? '참고 — 오르내림을 되풀이할 땐 추세 지표가 헛신호를 자주 내요. 과열·침체 지표가 더 잘 맞는 편이에요'
        : '참고 — 추세가 막 생기는 단계라 추세 지표와 과열·침체 지표를 함께 보는 게 좋아요');

  return {
    price: last, chg, rsi: r, macd: m, macdSignal: s, macdHist: h, volRatio,
    ma, bb: { up, mid, lo }, high: hi, low, lookback: look,
    signals: sig, opinion: op, notes,
    stochK: K, stochD: D, willr: W, cci: C, adx: A, pdi: P, mdi: M, atr, atrPct, obv: O, obvMa: Om, mfi: F, roc: R,
    ichiConv: T, ichiBase: B, ichiA, ichiB, sar, sarDir: sd, disparity: Dp,
    votes, groups, reasons: { pos, neg, neutral },
    support, resistance, rangePos, bbPos, bbWidth, squeeze, atrLevel, sarBars,
  };
}
