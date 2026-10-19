// 지표 계산이 Python(collector/indicators.py)과 같은 값을 내는지 — 기준값은 py -3 tools/make_fixture.py --reuse 로 만든다
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyze, opinion, series, type Analysis, type IndicatorSeries } from './indicators';
import type { Candle } from './market/types';

// analyze() 의 새 지표 값 — tools/make_fixture.py 의 EXTRA 와 같은 목록
const EXTRA = [
  'stochK', 'stochD', 'willr', 'cci', 'adx', 'pdi', 'mdi', 'atr', 'atrPct', 'obv', 'obvMa', 'mfi', 'roc',
  'ichiConv', 'ichiBase', 'ichiA', 'ichiB', 'sar', 'sarDir', 'disparity',
] as const satisfies readonly (keyof Analysis)[];

interface Case {
  sym: string;
  candles: Candle[];
  expect: {
    signals: string[];
    opinion: { score: number; label: string; buy: number; sell: number; neutral: number };
    votes: [string, number][];
    rsi: number | null; macd: number | null; volRatio: number | null;
    ma: Record<string, number | null>;
    series: Record<string, (number | null)[]>;
  } & Record<(typeof EXTRA)[number], number | null>;
}
const FIXTURE = resolve(import.meta.dirname, '../../../tools/fixture.json');
const cases: Case[] = existsSync(FIXTURE) ? JSON.parse(readFileSync(FIXTURE, 'utf-8')) : [];
const close = (a: number | null | undefined, b: number | null | undefined) =>
  (a == null && b == null) || (a != null && b != null && Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b)));

describe.skipIf(!cases.length)('지표 — Python 과 일치', () => {
  it('새 지표까지 담긴 기준값이에요 (아니면 py -3 tools/make_fixture.py --reuse)', () => {
    for (const c of cases) expect(c.expect.votes, c.sym).toBeDefined();
    expect(cases.some((c) => c.sym.startsWith('synthetic:'))).toBe(true);
  });
  for (const c of cases) {
    it(c.sym, () => {
      const ind = series(c.candles);
      const a = analyze(c.candles, ind)!;
      expect(a.signals).toEqual(c.expect.signals);
      expect(a.votes.map((x) => [x.key, x.v])).toEqual(c.expect.votes);
      expect(a.opinion).toEqual(c.expect.opinion);
      for (const k of ['rsi', 'macd', 'volRatio'] as const) expect(close(a[k], c.expect[k]), `${k} ${a[k]} vs ${c.expect[k]}`).toBe(true);
      for (const k of EXTRA) {
        expect(c.expect, k).toHaveProperty(k);
        expect(close(a[k], c.expect[k]), `${k} ${a[k]} vs ${c.expect[k]}`).toBe(true);
      }
      for (const n of [5, 20, 60, 120]) expect(close(a.ma[n], c.expect.ma[String(n)]), `ma${n}`).toBe(true);
      expect(Object.keys(c.expect.series).sort()).toEqual(Object.keys(ind).sort());
      for (const [k, arr] of Object.entries(c.expect.series)) {
        const js = ind[k as keyof IndicatorSeries].slice(-60);
        expect(js.length, k).toBe(arr.length);
        arr.forEach((v, i) => expect(close(js[i], v), `${k}[${i}] ${js[i]} vs ${v}`).toBe(true));
      }
    });
  }
});

describe.skipIf(!cases.length)('지표 — 판단 근거', () => {
  for (const c of cases) {
    it(`${c.sym} 근거 문장`, () => {
      const ind = series(c.candles);
      for (const unit of ['일', '봉'] as const) {
        const a = analyze(c.candles, ind, unit)!;
        const all = [...a.reasons.pos, ...a.reasons.neg, ...a.reasons.neutral];
        expect(all.length).toBeGreaterThan(0);
        for (const x of all) {
          expect(x, x).not.toMatch(/NaN|undefined|null|Infinity|\[object/);
          expect(x.trim(), x).toBe(x);
        }
        // 다른 단위 글자가 섞이지 않는다 ('20일' 을 봉 차트에 쓰지 않기)
        if (unit === '봉') expect(all.join('\n')).not.toMatch(/\d일/);
        // 표와 근거의 방향이 맞는다: 매수 표가 하나라도 있으면 긍정적 이유가, 매도 표가 있으면 부정적 이유가 있다
        if (a.opinion.buy) expect(a.reasons.pos.length).toBeGreaterThan(0);
        if (a.opinion.sell) expect(a.reasons.neg.length).toBeGreaterThan(0);
        const t = a.groups.trend, o = a.groups.osc;
        expect(t.buy + o.buy).toBe(a.opinion.buy);
        expect(t.sell + o.sell).toBe(a.opinion.sell);
        expect(t.neutral + o.neutral).toBe(a.opinion.neutral);
        for (const v of a.votes) expect(v.state, v.key).not.toBe('');
      }
    });
  }
});

describe('지표 — 의견', () => {
  const c = Array.from({ length: 130 }, (_, i) => 100 + i);
  it('기존 8표만 줄 때는 예전과 같은 결과예요', () => {
    expect(opinion(c, 50, 1, 0, 300, 100)).toEqual({ score: 0.75, label: '적극 매수', buy: 6, sell: 0, neutral: 2 });
  });
  it('새 표는 더하고 null 은 건너뛰어요', () => {
    expect(opinion(c, 50, 1, 0, 300, 100, [-1, -1, null, 0])).toEqual({ score: 0.364, label: '매수', buy: 6, sell: 2, neutral: 3 });
  });
  it('딱 중간값은 위로 반올림해요 (파이썬과 같게)', () => {
    // 16표 중 매수 6 · 매도 5 → 1/16 = 0.0625 → 0.063
    expect(opinion(c, 50, 1, 0, 300, 100, [-1, -1, -1, -1, -1, 0, 0, 0])).toEqual({ score: 0.063, label: '중립', buy: 6, sell: 5, neutral: 5 });
  });
  it('30봉보다 짧으면 분석하지 않아요', () => {
    const cs: Candle[] = c.slice(0, 29).map((x, i) => ({ t: i * 86400, o: x, h: x + 1, l: x - 1, c: x, v: 10 }));
    expect(analyze(cs)).toBeNull();
  });
});
