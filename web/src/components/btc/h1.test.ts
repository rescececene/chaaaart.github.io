// 브라우저 1시간 계산(h1.ts)이 파이썬(collector/btc/core.py)과 같은 값을 내는지
// 시험 파일: py collector/btc_forecast.py --fixture web/src/components/btc/h1.fixture.json (최근 200봉 + 나무 20개 + 기대값)
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { featuresAt, forecastH1, garchNext, type Bar, type H1Model } from './h1';

const path = fileURLToPath(new URL('./h1.fixture.json', import.meta.url));
const fx = existsSync(path)
  ? (JSON.parse(readFileSync(path, 'utf-8')) as { model: H1Model; bars: Bar[]; expected: Record<string, number> & { features: Record<string, number | null> } })
  : null;

const close = (a: number, b: number, rel = 1e-9) => Math.abs(a - b) <= rel * Math.max(1, Math.abs(a), Math.abs(b));

describe.skipIf(!fx)('1시간 예측 — 파이썬과 같은 계산', () => {
  it('특징 23개', () => {
    const F = featuresAt(fx!.bars);
    for (const [k, v] of Object.entries(fx!.expected.features)) {
      if (v == null) expect(Number.isFinite(F[k])).toBe(false);
      else expect(close(F[k], v, 1e-8), `${k}: ${F[k]} vs ${v}`).toBe(true);
    }
  });
  it('GJR-GARCH 다음 봉 σ', () => {
    const b = fx!.bars;
    expect(close(garchNext(b, b.length - 1, fx!.model.garch.p, fx!.model.garch.seasBar), fx!.expected.sigma)).toBe(true);
  });
  it('오를 확률 · 예상 · 범위', () => {
    const f = forecastH1(fx!.model, fx!.bars)!;
    expect(f).not.toBeNull();
    expect(close(f.pUp, fx!.expected.pUp, 1e-7)).toBe(true);
    expect(close(f.med, fx!.expected.med, 1e-6)).toBe(true);
    expect(close(f.lo, fx!.expected.lo, 1e-6)).toBe(true);
    expect(close(f.hi, fx!.expected.hi, 1e-6)).toBe(true);
  });
});
