import { describe, expect, it } from 'vitest';
import { liveGrade, liveOrder, pumpLiveState, pumpMove, type PumpLogItem } from './pump';
import { surgeOf, type Sample } from './surge';

const NOW = 1_800_000_000_000;
const ser = (pts: [number, number, number | null][]): Sample[] => pts.map(([ago, p, a]) => ({ t: NOW - ago, p, a }));

describe('실시간 급등 감지', () => {
  it('5분 +4% · 거래가 평소의 몇 배면 잡는다', () => {
    // 24시간 거래대금 288억 → 5분 평균 1억. 5분 사이 6억 = 6배
    const s = ser([[300e3, 100, 10e9], [60e3, 102, 10.3e9]]);
    const r = surgeOf('upbit:KRW-A', s, 104, 10.6e9, 28.8e9, NOW)!;
    expect(r.r5).toBeCloseTo(0.04);
    expect(r.burst).toBeCloseTo(6);
    expect(r.hit).toBe(true);
  });
  it('가격만 오르고 거래가 평소 수준이면 안 잡는다', () => {
    const s = ser([[300e3, 100, 10e9], [60e3, 102, 10.05e9]]);
    expect(surgeOf('upbit:KRW-A', s, 104, 10.1e9, 28.8e9, NOW)!.hit).toBe(false);
  });
  it('한두 번 체결로 튄 것(거래대금 300만 원 미만)은 거른다', () => {
    const s = ser([[300e3, 100, 1e6], [60e3, 100, 1.5e6]]);
    expect(surgeOf('upbit:KRW-A', s, 110, 2e6, 1e6, NOW)!.hit).toBe(false);
  });
  it('09:00 누적 거래대금 초기화를 건너면 거래대금은 계산하지 않는다', () => {
    const s = ser([[300e3, 100, 50e9], [60e3, 103, 0.1e9]]);
    const r = surgeOf('upbit:KRW-A', s, 105, 0.2e9, 28.8e9, NOW)!;
    expect(r.val).toBeNull();
    expect(r.hit).toBe(false);
  });
  it('지켜본 지 30초가 안 되면 아무것도 말하지 않는다', () => {
    expect(surgeOf('upbit:KRW-A', ser([[10e3, 100, 1e9]]), 120, 9e9, 1e9, NOW)).toBeNull();
  });
});

describe('후보 실시간 순서', () => {
  it('기준 뒤 +15% 넘게 오른 후보·−10% 넘게 빠진 후보는 뒤로', () => {
    expect(pumpMove(100, 116)).toBeCloseTo(0.16);
    expect(pumpLiveState(0.16)).toBe('ran');
    expect(pumpLiveState(-0.11)).toBe('fell');
    expect(pumpLiveState(0.05)).toBe('ok');
    const items = [{ k: 1, m: 0.2 }, { k: 2, m: 0.01 }, { k: 3, m: -0.12 }, { k: 4, m: null }];
    const o = liveOrder(items, (x) => x.k, (x) => x.m);
    expect(o.map((x) => x.x.k)).toEqual([2, 4, 1, 3]);
  });
});

describe('신호 기록 실시간 채점', () => {
  const base: PumpLogItem = {
    code: 'KRW-A', name: 'A', t: 1_000_000, seen: 1_000_000, price: 100, score: 92,
    mfe: [0.02, 0.06, 0.2], r72: [-0.1, 0, 0.1], pPump: 0.2, pDump: 0.1, status: 'wait',
  };
  it('+15% 에 닿으면 72시간을 기다리지 않고 펌핑', () => {
    const g = liveGrade(base, 116, base.t + 3600 * 5);
    expect(g.kind).toBe('pump');
    expect(g.live).toBe(true);
    expect(g.left).toBe(67 * 3600);
  });
  it('서버가 본 최고(prog)와 지금 가격을 합친다', () => {
    const g = liveGrade({ ...base, prog: { mfe: 0.17, mae: -0.03, upto: base.t + 7200, hit: { kind: 'pump', at: base.t + 7200 } } }, 103, base.t + 3 * 3600);
    expect(g.mfe).toBeCloseTo(0.17);
    expect(g.now).toBeCloseTo(0.03);
    expect(g.kind).toBe('pump');
    expect(g.live).toBe(false);
    expect(g.at).toBe(base.t + 7200);
  });
  it('72시간이 지난 뒤의 가격은 넣지 않는다', () => {
    const g = liveGrade(base, 130, base.t + 73 * 3600);
    expect(g.now).toBeNull();
    expect(g.kind).toBeNull();
  });
  it('−15% 도 닿는 순간 급락', () => {
    expect(liveGrade(base, 84, base.t + 3600).kind).toBe('dump');
  });
});
