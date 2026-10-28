import { describe, expect, it } from 'vitest';
import { frac, hourLabel, krw, pct, prob, toneCls } from './fmt';

describe('비트코인 카드 표기', () => {
  it('원화는 억·만 원 (만 원 단위 반올림) — collector/btc/core.py krw() 와 같은 규칙', () => {
    expect(krw(108_347_000)).toBe('1억 835만 원');
    expect(krw(108_347_000, false)).toBe('1억 835만');
    expect(krw(100_004_000)).toBe('1억 원');
    expect(krw(99_995_000)).toBe('1억 원');
    expect(krw(145_000_000)).toBe('1억 4,500만 원');
    expect(krw(98_765_000)).toBe('9,877만 원');
    expect(krw(null)).toBe('–');
  });
  it('변화율·확률', () => {
    expect(pct(0.0123)).toBe('+1.2%');
    expect(pct(-0.004)).toBe('−0.4%');
    expect(pct(0.0004)).toBe('0.0%');
    expect(pct(0.0006, 2)).toBe('+0.06%');
    expect(prob(0.5149)).toBe('51%');
    expect(frac([17, 30])).toBe('17/30');
    expect(frac([0, 0])).toBe('–');
  });
  it('보이는 자릿수가 0 이면 방향색 없음', () => {
    expect(toneCls(0.0004)).toBe('text-foreground');
    expect(toneCls(0.0006)).toBe('text-up-text');
    expect(toneCls(-0.0006)).toBe('text-down-text');
  });
  it('기준 시각은 한국 시간', () => {
    expect(hourLabel('2026-10-29T00:00:00+00:00')).toBe('오전 9시');
    expect(hourLabel('2026-10-28T15:00:00+00:00')).toBe('오전 12시');
    expect(hourLabel('2026-10-29T05:00:00+00:00')).toBe('오후 2시');
  });
});
