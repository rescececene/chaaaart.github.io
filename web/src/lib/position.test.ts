// 내 평단 진단 — 입력 해석 · 지지·저항 · 손절 고려선 계산 · 판단 분기 · 라벨 배치
import { describe, expect, it } from 'vitest';
import { analyze, type Analysis } from './indicators';
import type { Candle } from './market/types';
import {
  aiAgreement, diagnose, farFromPrice, isPosition, nearestAbove, nearestBelow, parseAmount, pivots, placeLabels, profitPeak, roundSig, type Pivots,
} from './position';

/** 종가 목록 → 봉 (고가·저가는 종가 ± spread) */
function mk(closes: number[], spread = 1): Candle[] {
  return closes.map((c, i) => ({ t: 1_700_000_000 + i * 86400, o: i ? closes[i - 1] : c, h: c + spread, l: c - spread, c, v: 1000 + i }));
}
/** 판단에 쓰는 값만 채운 분석 결과 */
function fakeA(o: Partial<Analysis> & { score?: number } = {}): Analysis {
  const { score = 0, ...rest } = o;
  return {
    atr: 2, rsi: 50, bb: { up: 1e9, mid: null, lo: null }, ma: { 5: null, 20: null, 60: null, 120: null },
    opinion: { score, label: score >= 0.5 ? '적극 매수' : score >= 0.15 ? '매수' : score <= -0.5 ? '적극 매도' : score <= -0.15 ? '매도' : '중립', buy: 0, sell: 0, neutral: 0 },
    signals: [], high: 0, lookback: 250,
    reasons: { pos: ['p1 — a', 'p2 — b', 'p3 — c', 'p4 — d'], neg: ['n1 — a', 'n2 — b', 'n3 — c', 'n4 — d'], neutral: [] },
    ...rest,
  } as unknown as Analysis;
}
const NOPIV: Pivots = { highs: [], lows: [] };
const f = (x: number) => x.toFixed(1);
/** 마지막 25봉이 모두 lowAbove 위에서 움직인 봉 (추적 고점 = peakHigh) */
function above(lowAbove: number, peakHigh: number): Candle[] {
  const cs = mk(Array(25).fill(lowAbove + 3), 1);
  cs[cs.length - 5] = { ...cs[cs.length - 5], h: peakHigh };
  return cs;
}

describe('입력 해석', () => {
  it('쉼표·공백·단위·전각 숫자를 받아들여요', () => {
    expect(parseAmount('98,000,000')).toEqual({ value: 98_000_000, error: null });
    expect(parseAmount(' 1.5 ').value).toBe(1.5);
    expect(parseAmount('$180.5').value).toBe(180.5);
    expect(parseAmount('1,234.5원').value).toBe(1234.5);
    expect(parseAmount('67,000.12 USDT').value).toBe(67000.12);
    expect(parseAmount('１２３').value).toBe(123);
    expect(parseAmount('.5').value).toBe(0.5);
    expect(parseAmount('12.').value).toBe(12);
  });
  it('빈칸은 오류가 아니고, 잘못된 값은 안내해요', () => {
    expect(parseAmount('')).toEqual({ value: null, error: null });
    expect(parseAmount('   ')).toEqual({ value: null, error: null });
    expect(parseAmount('abc').error).toBe('숫자만 입력해 주세요');
    expect(parseAmount('1.2.3').error).toBe('숫자만 입력해 주세요');
    expect(parseAmount('1e5').error).toBe('숫자만 입력해 주세요');
    expect(parseAmount('-5').error).toBe('0보다 큰 값을 입력해 주세요');
    expect(parseAmount('0').error).toBe('0보다 큰 값을 입력해 주세요');
    expect(parseAmount('0.000').error).toBe('0보다 큰 값을 입력해 주세요');
  });
  it('통화를 잘못 넣은 듯하면 알아채요', () => {
    expect(farFromPrice(65_000, 95_000_000)).toBe(true); // USDT 값을 원화 종목에
    expect(farFromPrice(95_000_000, 65_000)).toBe(true);
    expect(farFromPrice(90, 100)).toBe(false);
    expect(farFromPrice(90, null)).toBe(false);
  });
  it('계산한 선은 유효숫자 4자리', () => {
    expect(roundSig(112_932_307)).toBe(112_900_000);
    expect(roundSig(52_345)).toBe(52_350);
    expect(roundSig(180.237)).toBe(180.2);
    expect(roundSig(0.0123456)).toBe(0.01235);
    expect(roundSig(98.5)).toBe(98.5);
  });
  it('저장된 값 검사', () => {
    expect(isPosition({ avg: 100, at: 1 })).toBe(true);
    expect(isPosition({ avg: 100, qty: 2, at: 1 })).toBe(true);
    expect(isPosition({ avg: 0, at: 1 })).toBe(false);
    expect(isPosition({ avg: '100' })).toBe(false);
    expect(isPosition({ avg: 100, qty: -1 })).toBe(false);
    expect(isPosition(null)).toBe(false);
  });
});

describe('지지·저항', () => {
  it('앞뒤 3봉보다 낮은(높은) 봉을 저점(고점)으로 찾아요', () => {
    const c = mk([100, 99, 98, 95, 98, 99, 100, 101, 104, 108, 104, 101, 100, 100, 100], 0.5);
    const p = pivots(c);
    expect(p.lows).toContain(94.5);
    expect(p.highs).toContain(108.5);
    expect(nearestBelow(p.lows, 100)).toBe(94.5);
    expect(nearestAbove(p.highs, 100)).toBe(108.5);
    expect(nearestAbove(p.highs, 200)).toBeNull();
  });
  it('analyze() 의 지지·저항과 같은 값을 내요', () => {
    let x = 100, seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) - 0.5;
    const closes = Array.from({ length: 200 }, () => (x = Math.max(5, x * (1 + rnd() * 0.06))));
    const c = closes.map((v, i) => ({ t: i * 86400, o: v, h: v * (1 + Math.abs(rnd()) * 0.03), l: v * (1 - Math.abs(rnd()) * 0.03), c: v, v: 1 }));
    const a = analyze(c, undefined, '일')!;
    const p = pivots(c);
    expect(nearestBelow(p.lows, a.price)).toBe(a.support);
    expect(nearestAbove(p.highs, a.price)).toBe(a.resistance);
  });
  it('추적 고점은 평단 위에서 움직인 최근 구간에서만', () => {
    expect(profitPeak(above(100, 130), 100, 110)).toBe(130);
    // 오늘 저가가 평단 아래(막 산 종목)면 지금 가격
    const fresh = above(100, 130);
    fresh[fresh.length - 1] = { ...fresh[fresh.length - 1], l: 99 };
    expect(profitPeak(fresh, 100, 104)).toBe(104);
    // 20봉보다 오래된 고점은 보지 않아요
    const old = above(100, 104);
    old[0] = { ...old[0], h: 500 };
    expect(profitPeak(old, 100, 103)).toBe(104);
  });
});

describe('손절 고려선', () => {
  it('손실 중 — 지지가 없으면 평단 − 2×ATR', () => {
    const d = diagnose({ candles: mk([100]), a: fakeA({ atr: 1 }), piv: NOPIV, avg: 100.5, price: 100, f });
    expect(d.stop).toBeCloseTo(98.5);
    expect(d.stopKind).toBe('vol');
    expect(d.stopBroken).toBe(false);
    expect(d.stopBasis).toContain('평단 아래');
  });
  it('구조(지지 − 0.5×ATR)가 더 가까우면 그쪽', () => {
    const d = diagnose({ candles: mk([100]), a: fakeA({ atr: 2 }), piv: { highs: [], lows: [99.5, 90] }, avg: 102, price: 100, f });
    expect(d.structStop).toBeCloseTo(98.5);
    expect(d.volStop).toBeCloseTo(98);
    expect(d.stop).toBeCloseTo(98.5);
    expect(d.stopKind).toBe('struct');
    expect(d.stopBasis).toContain('최근 지지 99.5 아래');
    expect(d.support).toBe(99.5);
  });
  it('변동성 쪽이 더 가까우면 그쪽', () => {
    const d = diagnose({ candles: mk([100]), a: fakeA({ atr: 2 }), piv: { highs: [], lows: [90] }, avg: 101, price: 100, f });
    expect(d.stop).toBeCloseTo(97);
    expect(d.stopKind).toBe('vol');
  });
  it('수익 중이면 추적 — 최근 고점 − 2×ATR', () => {
    const d = diagnose({ candles: above(90, 104), a: fakeA({ atr: 2, score: 0.4 }), piv: NOPIV, avg: 90, price: 100, f });
    expect(d.peak).toBe(104);
    expect(d.stop).toBeCloseTo(100);
    expect(d.stopKind).toBe('trail');
    expect(d.stopBroken).toBe(true); // 고점에서 2×ATR 만큼 내려왔다
  });
  it('막 산 종목(평단 = 현재가)은 사기 전 고점으로 손절선이 올라가지 않아요', () => {
    const cs = above(90, 130);
    cs[cs.length - 1] = { ...cs[cs.length - 1], l: 99 };
    const d = diagnose({ candles: cs, a: fakeA({ atr: 2 }), piv: NOPIV, avg: 100, price: 100, f });
    expect(d.profit).toBe(false);
    expect(d.stop).toBeCloseTo(96);
    expect(d.verdict.key).toBe('watch');
  });
  it('손익비 = (목표 − 현재) ÷ (현재 − 손절), 목표가 없으면 최근 고점', () => {
    const d = diagnose({ candles: above(90, 101), a: fakeA({ atr: 2, score: 0.4, high: 130 }), piv: { highs: [110, 120], lows: [] }, avg: 90, price: 100, f });
    expect(d.stop).toBeCloseTo(97);
    expect(d.target).toBe(110);
    expect(d.targetKind).toBe('res');
    expect(d.rr).toBeCloseTo(10 / 3);
    const e = diagnose({ candles: above(90, 101), a: fakeA({ atr: 2, high: 130 }), piv: NOPIV, avg: 90, price: 100, f });
    expect(e.target).toBe(130);
    expect(e.targetKind).toBe('high');
    // 하루 평균 움직임의 1/4 도 안 되는 바로 위 고점은 건너뛰어요 (ATR 2 → 0.5 안)
    const h = diagnose({ candles: above(90, 101), a: fakeA({ atr: 2, high: 130 }), piv: { highs: [100.5, 112], lows: [] }, avg: 90, price: 100, f });
    expect(h.target).toBe(112);
    expect(h.resistance).toBe(100.5);
    const g = diagnose({ candles: above(90, 101), a: fakeA({ atr: 2, high: 100 }), piv: NOPIV, avg: 90, price: 100, f });
    expect(g.target).toBeNull();
    expect(g.rr).toBeNull();
  });
  it('수량이 있으면 금액도', () => {
    const d = diagnose({ candles: mk([100]), a: fakeA({ atr: 1 }), piv: NOPIV, avg: 110, price: 100, qty: 3, f });
    expect(d.pnlPct).toBeCloseTo(-9.0909, 3);
    expect(d.pnlAmt).toBeCloseTo(-30);
    expect(d.stopAmt).toBeCloseTo((108 - 110) * 3);
    expect(diagnose({ candles: mk([100]), a: fakeA(), piv: NOPIV, avg: 110, price: 100, f }).pnlAmt).toBeNull();
  });
});

describe('판단', () => {
  const loss = (o: Partial<Analysis> & { score?: number }, avg: number, piv = NOPIV) => diagnose({ candles: mk([100]), a: fakeA(o), piv, avg, price: 100, f });
  const gain = (o: Partial<Analysis> & { score?: number }, peak = 101) => diagnose({ candles: above(90, peak), a: fakeA({ atr: 2, ...o }), piv: NOPIV, avg: 90, price: 100, f });

  it('손실 — 손절선 이탈이면 손절 고려', () => {
    const d = loss({ atr: 2, rsi: 45 }, 110);
    expect(d.stopBroken).toBe(true);
    expect(d.verdict.key).toBe('stop');
    expect(d.verdict.tone).toBe('exit');
    expect(d.rr).toBeNull();
  });
  it('손실 — 이탈했어도 낙폭 과대(RSI ≤ 30)면 반등 때 줄이기', () => {
    const d = loss({ atr: 2, rsi: 25, ma: { 5: 103, 20: 108, 60: null, 120: null } }, 110);
    expect(d.verdict.key).toBe('oversold');
    expect(d.verdict.title).toContain('반등 때 비중 줄이기 고려');
    expect(d.scenarios.some((s) => s.text.includes('103.0까지 반등하면'))).toBe(true);
  });
  it('손실 — 손절선이 하루 평균 움직임 안이면 손절선 가까움', () => {
    const d = loss({ atr: 2, score: -0.3 }, 103); // 손절선 99 — 현재가에서 1 (ATR 2 안)
    expect(d.near).toBe(true);
    expect(d.downtrend).toBe(true);
    expect(d.verdict.key).toBe('near');
    expect(d.verdict.detail).toContain('하락 추세');
  });
  it('손실 — 여유가 있으면 관망', () => {
    const d = loss({ atr: 1 }, 100.5);
    expect(d.near).toBe(false);
    expect(d.verdict.key).toBe('watch');
    expect(d.verdict.title).toBe('손절선 지키며 관망');
  });
  it('수익 — 과열(RSI ≥ 70 또는 볼린저 상단 위)이면 일부 익절', () => {
    expect(gain({ rsi: 75, score: 0.5 }).verdict.key).toBe('overheat');
    expect(gain({ rsi: 60, bb: { up: 99, mid: null, lo: null } }).verdict.key).toBe('overheat');
  });
  it('수익 — 의견이 매수 쪽이면 보유 유지, 매도 쪽이면 수익 지키기, 중립이면 관망', () => {
    expect(gain({ score: 0.4 }).verdict.key).toBe('hold');
    expect(gain({ score: 0.4 }).verdict.title).toBe('보유 유지 · 추적 손절선 아래로 내려오면 정리');
    expect(gain({ score: -0.3 }).verdict.key).toBe('protect');
    // 수익 지키기 — 지금 손절선(고점 101 − 2×2 = 97)보다 높은 선을 제안: max(고점 − ATR, 평단) = 99, 현재가 − 0.5×ATR = 99 이하
    const p = gain({ score: -0.3 });
    expect(p.stop).toBeCloseTo(97);
    expect(p.raise).toBeCloseTo(99);
    expect(p.verdict.detail).toContain('99.0까지 올려 둘 수 있어요');
    expect(p.scenarios[0].text).toBe('99.0 아래로 마감하면 정리 고려 (올려 둔 손절선)');
    // 고점 − ATR 이 평단보다 낮으면 본전(평단)까지
    const be = diagnose({ candles: above(97, 101), a: fakeA({ atr: 4, score: -0.3 }), piv: NOPIV, avg: 98, price: 100, f });
    expect(be.stop).toBeCloseTo(93);
    expect(be.raise).toBeCloseTo(98);
    expect(be.verdict.detail).toContain('98.0(본전)까지');
    expect(gain({ score: 0.4 }).raise).toBeNull();
    expect(gain({ score: 0 }).verdict.key).toBe('profit_watch');
  });
  it('수익 — 추적 손절선 아래면 수익 지키기', () => {
    const d = gain({ score: 0.4 }, 106);
    expect(d.stopBroken).toBe(true);
    expect(d.verdict.key).toBe('trail_broken');
    expect(d.scenarios.at(-1)?.text).toBe('102.0 위로 다시 올라서 마감하면 계속 보유해 볼 수 있어요');
  });
  it('시나리오는 실제 숫자로 2~3줄', () => {
    const d = diagnose({ candles: above(90, 101), a: fakeA({ atr: 2, score: 0.4 }), piv: { highs: [110], lows: [] }, avg: 90, price: 100, f });
    expect(d.scenarios.length).toBeGreaterThanOrEqual(2);
    expect(d.scenarios.length).toBeLessThanOrEqual(3);
    expect(d.scenarios[0].text).toBe('97.0 아래로 마감하면 정리 고려');
    expect(d.scenarios[1].text).toBe('110.0에 닿으면 일부 익절 고려');
    const l = loss({ atr: 1 }, 100.9, { highs: [100.7], lows: [] });
    expect(l.scenarios[0].text).toContain('98.9 아래로 마감하면 손절 고려');
    expect(l.scenarios[1].text).toBe('100.7 돌파하면 평단 100.9 회복을 노려볼 수 있어요');
    expect(l.scenarios[2].text).toBe('100.7 근처에서 막히면 비중 줄이기 고려');
  });
  it('근거는 긍정·부정 상위 3개씩 + 내 평단 기준', () => {
    const d = loss({ atr: 1, ma: { 5: null, 20: 95, 60: null, 120: null } }, 104, { highs: [101, 103, 120], lows: [] });
    expect(d.reasons.pos).toEqual(['p1 — a', 'p2 — b', 'p3 — c']);
    expect(d.reasons.neg).toHaveLength(3);
    expect(d.reasons.mine[0]).toContain('20일 평균(95.0)보다 9.5% 위');
    expect(d.reasons.mine[1]).toContain('평단 아래 저항 2곳');
    expect(d.reasons.mine[1]).toContain('101.0');
  });
  it('실제 지표로도 끝까지 계산돼요', () => {
    let x = 50, seed = 3;
    const rnd = () => ((seed = (seed * 48271) % 2147483647) / 2147483647) - 0.5;
    const c = Array.from({ length: 150 }, (_, i) => { x *= 1 + rnd() * 0.05; return { t: i * 86400, o: x, h: x * 1.02, l: x * 0.98, c: x, v: 10 }; });
    const a = analyze(c, undefined, '일')!;
    for (const avg of [a.price * 0.8, a.price, a.price * 1.25]) {
      const d = diagnose({ candles: c, a, piv: pivots(c), avg, price: a.price });
      expect(Number.isFinite(d.stop)).toBe(true);
      expect(d.stopBroken).toBe(d.stop >= a.price);
      expect(d.verdict.title.length).toBeGreaterThan(0);
      expect(d.scenarios.length).toBeGreaterThanOrEqual(2);
    }
  });
});

describe('AI 와 비교', () => {
  it('같은 방향이면 "AI도", 다르면 함께 참고', () => {
    expect(aiAgreement(1, 2)).toEqual({ same: true, text: 'AI도 강세로 봐요' });
    expect(aiAgreement(-1, -1)).toEqual({ same: true, text: 'AI도 약세로 봐요' });
    expect(aiAgreement(0, 0).same).toBe(true);
    expect(aiAgreement(1, -2)).toEqual({ same: false, text: 'AI는 약세로 봐요 — 기술적 의견(매수 쪽)과 달라 함께 참고하세요' });
    expect(aiAgreement(-1, 0).text).toContain('중립으로');
  });
});

describe('가격 사다리 라벨', () => {
  const overlaps = (p: { left: number; row: number }[], ws: number[]) => {
    for (let i = 0; i < p.length; i++) for (let j = i + 1; j < p.length; j++) {
      if (p[i].row !== p[j].row) continue;
      if (p[i].left < p[j].left + ws[j] && p[j].left < p[i].left + ws[i]) return true;
    }
    return false;
  };
  it('떨어져 있으면 모두 위 줄, 점 가운데', () => {
    const p = placeLabels([50, 150, 250], [40, 40, 40], 300);
    expect(p.map((x) => x.row)).toEqual([0, 0, 0]);
    expect(p.map((x) => x.left)).toEqual([30, 130, 230]);
  });
  it('겹치면 아래 줄로, 그래도 겹치면 밀어서 — 겹침 없이 폭 안에', () => {
    const ws = [70, 70, 70, 70];
    for (const xs of [[100, 104, 108, 300], [10, 12, 14, 16], [340, 342, 344, 346], [0, 175, 176, 350]]) {
      const p = placeLabels(xs, ws, 350);
      expect(overlaps(p, ws)).toBe(false);
      for (const [i, x] of p.entries()) {
        expect(x.left).toBeGreaterThanOrEqual(0);
        expect(x.left + ws[i]).toBeLessThanOrEqual(350);
      }
    }
  });
  it('끝에 있는 점의 라벨은 폭 안으로', () => {
    const p = placeLabels([0, 350], [60, 60], 350);
    expect(p[0].left).toBe(0);
    expect(p[1].left).toBe(290);
  });
});
