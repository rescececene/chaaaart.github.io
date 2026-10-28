// 1시간 뒤 예상 — 브라우저에서 바로 계산 (수집기가 40~70분마다 돌아서, 수집기 결과는 볼 때 이미 지난 시간이기 쉽다)
// 업비트 시간봉 200개(화면을 열 때 한 번, 그 뒤 정시마다 한 번 — 업비트 브라우저 요청 한도 분당 6회의 아주 일부)
// + 하루 1번 학습한 계수(data/btc_h1.json): LightGBM 분류 나무(방향) · Platt 보정 · 잔차 분위(범위) · GJR-GARCH(변동성).
// 특징·변동성 계산은 collector/btc/core.py 의 features() · garch_next() 와 같은 정의 (h1.test.ts 가 파이썬 값과 맞춰 본다).

import type { BtcH1Model, BtcTree, UpbitHourRaw } from '@/lib/market/btc';

export interface Bar { t: number; o: number; h: number; l: number; c: number; v: number }
export type H1Model = BtcH1Model;
type Tree = BtcTree;
export interface H1Forecast {
  /** 기준 시각(마지막으로 끝난 봉의 끝, 초) · 목표 시각 */
  asOf: number;
  target: number;
  price: number;
  med: number;
  lo: number;
  hi: number;
  pUp: number;
  sigma: number;
}

const HOUR = 3600;
const kstHour = (t: number) => (Math.floor(t / HOUR) + 9) % 24;
const kstDow = (t: number) => (Math.floor((t + 9 * HOUR) / 86400) + 3) % 7; // 0 = 월
const isNum = (x: number) => Number.isFinite(x);

/** 업비트 응답(최신이 앞) → 빈 시간을 직전 종가로 채운 연속 시간봉 (끝난 봉만) */
export function toBars(raw: UpbitHourRaw[], nowSec: number): Bar[] {
  const rows = raw
    .map((k) => ({ t: Date.parse(k.candle_date_time_utc + 'Z') / 1000, o: k.opening_price, h: k.high_price, l: k.low_price, c: k.trade_price, v: k.candle_acc_trade_price }))
    .filter((b) => isNum(b.t) && b.t + HOUR <= nowSec - 60)
    .sort((a, b) => a.t - b.t);
  const out: Bar[] = [];
  for (const b of rows) {
    if (out.length) {
      const last = out[out.length - 1];
      if (b.t <= last.t) continue;
      for (let t = last.t + HOUR; t < b.t; t += HOUR) out.push({ t, o: last.c, h: last.c, l: last.c, c: last.c, v: 0 });
    }
    out.push(b);
  }
  return out;
}

// ── 창 계산 (마지막 칸 하나만) — 파이썬 roll_* 와 같은 뜻: NaN 은 건너뛰고 개수가 minp 미만이면 NaN ──
function winVals(x: number[], i: number, w: number) {
  const out: number[] = [];
  for (let j = Math.max(0, i - w + 1); j <= i; j++) if (isNum(x[j])) out.push(x[j]);
  return out;
}
function wMean(x: number[], i: number, w: number, minp = w) {
  const v = winVals(x, i, w);
  return v.length >= minp && v.length > 0 ? v.reduce((a, b) => a + b, 0) / v.length : NaN;
}
function wSum(x: number[], i: number, w: number, minp = w) {
  const v = winVals(x, i, w);
  return v.length >= minp && v.length > 0 ? v.reduce((a, b) => a + b, 0) : NaN;
}
function wStd(x: number[], i: number, w: number, minp: number) {
  const v = winVals(x, i, w);
  if (v.length < minp || v.length < 2) return NaN;
  const m = v.reduce((a, b) => a + b, 0) / v.length;
  const s2 = v.reduce((a, b) => a + (b - m) * (b - m), 0) / (v.length - 1);
  return Math.sqrt(Math.max(0, s2));
}
function wExt(x: number[], i: number, w: number, minp: number, max: boolean) {
  const v = winVals(x, i, w);
  if (v.length < minp || !v.length) return NaN;
  return max ? Math.max(...v) : Math.min(...v);
}

/** 마지막 칸(봉 i 가 끝난 시각)의 특징 — core.features 와 같은 정의 (짧은 창만) */
export function featuresAt(b: Bar[], i = b.length - 1): Record<string, number> {
  const lc = b.map((x) => (x.c > 0 ? Math.log(x.c) : NaN));
  const r = lc.map((v, k) => (k ? v - lc[k - 1] : NaN));
  const c = b.map((x) => x.c), h = b.map((x) => x.h), l = b.map((x) => x.l), v = b.map((x) => Math.max(0, x.v));
  const s24 = wStd(r, i, 24, 20), s168 = wStd(r, i, 168, 150);
  const F: Record<string, number> = {};
  F.lv24 = s24 > 0 ? Math.log(s24) : NaN;
  F.lv168 = s168 > 0 ? Math.log(s168) : NaN;
  F.vr_24_168 = F.lv24 - F.lv168;
  const hl2 = b.map((x) => (x.l > 0 && x.h > 0 ? Math.log(x.h / x.l) ** 2 : NaN));
  const pk = wMean(hl2, i, 24, 20);
  F.lpk24 = isNum(pk) && pk > 0 ? 0.5 * Math.log(pk / (4 * Math.log(2))) : NaN;
  for (const k of [1, 3, 6, 12, 24, 72, 168]) F['r' + k] = i >= k && s168 > 0 ? (lc[i] - lc[i - k]) / (s168 * Math.sqrt(k)) : NaN;
  for (const k of [24, 168]) {
    const sma = wMean(c, i, k, Math.floor(k * 0.9));
    F['ma' + k] = isNum(sma) && s168 > 0 ? (lc[i] - Math.log(sma)) / (s168 * Math.sqrt(k / 2)) : NaN;
    const hi = wExt(h, i, k, Math.floor(k * 0.9), true), lo = wExt(l, i, k, Math.floor(k * 0.9), false);
    F['pos' + k] = isNum(hi) && hi > lo ? (c[i] - lo) / (hi - lo) : NaN;
  }
  const v24 = wSum(v, i, 24), v168 = wSum(v, i, 168);
  F.vol24_168 = isNum(v24) && isNum(v168) ? Math.log((v24 + 1) / (v168 / 7 + 1)) : NaN;
  const vm24 = wMean(v, i, 24);
  F.vol1_24 = isNum(vm24) ? Math.log((v[i] + 1) / (vm24 + 1)) : NaN;
  const upi = r.map((x) => (isNum(x) && x > 0 ? 1 : 0));
  F.uph24 = wMean(upi, i, 24);
  F.uph168 = wMean(upi, i, 168);
  const up = r.map((x) => (isNum(x) ? Math.max(0, x) : NaN)), dn = r.map((x) => (isNum(x) ? Math.max(0, -x) : NaN));
  const au = wMean(up, i, 14), ad = wMean(dn, i, 14);
  F.rsi14 = isNum(au) && isNum(ad) && au + ad > 0 ? au / (au + ad) : NaN;
  const ct = b[i].t + HOUR, hk = kstHour(ct);
  F.hour_sin = Math.sin((2 * Math.PI * hk) / 24);
  F.hour_cos = Math.cos((2 * Math.PI * hk) / 24);
  F.wkend = kstDow(ct) >= 5 ? 1 : 0;
  return F;
}

function tree(tr: Tree, x: number[]) {
  if (!tr.f.length) return tr.v[0];
  let node = 0;
  while (node >= 0) {
    let val = x[tr.f[node]];
    const mt = tr.m[node];
    if (!isNum(val) && mt !== 2) val = 0;
    const left = (mt === 1 && Math.abs(val) <= 1e-35) || (mt === 2 && !isNum(val)) ? tr.d[node] === 1 : val <= tr.t[node];
    node = left ? tr.l[node] : tr.r[node];
  }
  return tr.v[~node];
}

/** 정렬된 xs 에서 x 의 ys 선형 보간 (끝은 고정) — core.interp */
function interp(xs: number[], ys: number[], x: number) {
  if (x <= xs[0]) return ys[0];
  if (x >= xs[xs.length - 1]) return ys[ys.length - 1];
  let lo = 0, hi = xs.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (xs[mid] <= x) lo = mid; else hi = mid; }
  const t = xs[hi] > xs[lo] ? (x - xs[lo]) / (xs[hi] - xs[lo]) : 0;
  return ys[lo] + t * (ys[hi] - ys[lo]);
}

/** GJR-GARCH 다음 봉 표준편차 (로그 수익) — core.garch_next */
export function garchNext(b: Bar[], i: number, p: number[], seasBar: number[]) {
  const [om, al, ga, be] = p;
  const den = 1 - al - ga / 2 - be;
  let v = den > 1e-6 ? om / den : om * 100;
  let ePrev: number | null = null;
  for (let j = Math.max(1, i - 999); j <= i; j++) {
    if (ePrev !== null) v = om + (al + (ePrev < 0 ? ga : 0)) * ePrev * ePrev + be * v;
    const f = seasBar[kstHour(b[j].t)] || 1;
    ePrev = ((b[j].c > 0 && b[j - 1].c > 0 ? Math.log(b[j].c / b[j - 1].c) : 0) / f) * 100;
  }
  if (ePrev === null) return NaN;
  v = om + (al + (ePrev < 0 ? ga : 0)) * ePrev * ePrev + be * v;
  return (Math.sqrt(Math.max(v, 1e-12)) / 100) * (seasBar[kstHour(b[i].t + HOUR)] || 1);
}

/** 1시간 예측 — 봉이 170개 미만이거나 숫자가 이상하면 null */
export function forecastH1(m: H1Model, b: Bar[]): H1Forecast | null {
  const i = b.length - 1;
  if (i < 170) return null;
  const F = featuresAt(b, i);
  const x = m.cols.map((k) => F[k] ?? NaN);
  const raw = m.trees.reduce((s, tr) => s + tree(tr, x), 0);
  const lo = Math.max(-30, Math.min(30, m.platt.a + m.platt.b * raw));
  const pUp = 1 / (1 + Math.exp(-lo));
  const z = -interp(m.ep, m.eq, 1 - pUp);
  const sig = garchNext(b, i, m.garch.p, m.garch.seasBar);
  if (!isNum(sig) || sig <= 0 || !isNum(z)) return null;
  return {
    asOf: b[i].t + HOUR, target: b[i].t + 2 * HOUR, price: b[i].c, sigma: sig, pUp,
    med: Math.expm1(z * sig), lo: Math.expm1((z + m.scale * m.lo) * sig), hi: Math.expm1((z + m.scale * m.hi) * sig),
  };
}
