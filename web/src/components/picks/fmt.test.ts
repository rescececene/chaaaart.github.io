import { describe, expect, it } from 'vitest';
import { dayText, expDigits, fcWarn, fpct, fpp, minusFix, p0, pickDay, toneOf, whenText } from './fmt';

describe('순위 표기', () => {
  it('퍼센트 — 부호와 U+2212', () => {
    expect(fpct(0.0034)).toBe('+0.3%');
    expect(fpct(-0.029)).toBe('−2.9%');
    expect(fpct(0)).toBe('0.0%');
    expect(fpct(null)).toBe('–');
    expect(fpp(0.0027)).toBe('+0.27%p');
    expect(p0(0.574)).toBe('57%');
    expect(minusFix('1년 흐름 -27% (하위 -3%)')).toBe('1년 흐름 −27% (하위 −3%)');
  });
  it('예상 % 가 0.1% 안쪽이면 둘째 자리까지 — +0.0% 만 줄줄이 보이지 않게', () => {
    expect(expDigits(0.0004)).toBe(2);
    expect(fpct(0.0004, expDigits(0.0004))).toBe('+0.04%');
    expect(expDigits(0.012)).toBe(1);
  });
  it('방향색은 보이는 자릿수 기준 (한국식: 오름 빨강 · 내림 파랑)', () => {
    expect(toneOf(0.004)).toBe('text-up-text');
    expect(toneOf(-0.004)).toBe('text-down-text');
    expect(toneOf(0.0004)).toBe('text-foreground'); // +0.0% 로 보이면 색 없음
    expect(toneOf(0.0004, 2)).toBe('text-up-text');
  });
  it('기준 시각·고른 날 (한국 시간)', () => {
    expect(whenText('2026-10-29T00:00:00+00:00')).toBe('10월 29일 오전 9시');
    expect(pickDay('2026-10-28', 'upbit')).toBe('2026-10-29'); // 코인은 기준일 다음 날 09:00 에 고른다
    expect(pickDay('2026-10-28', 'krx')).toBe('2026-10-28');
    const now = Date.parse('2026-10-29T03:00:00Z');
    expect(dayText('2026-10-29', now)).toBe('오늘');
    expect(dayText('2026-10-28', now)).toBe('어제');
    expect(dayText('2026-10-20', now)).toBe('10월 20일');
  });
  it('예상 % 검증이 약하면 먼저 알린다', () => {
    expect(fcWarn('good')).toBeNull();
    expect(fcWarn('weak', '24시간')).toContain('조금 나은 정도');
    expect(fcWarn('poor', '20거래일')).toContain("'20거래일 뒤 예상 %'");
  });
});
